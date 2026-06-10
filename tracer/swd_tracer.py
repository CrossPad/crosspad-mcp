#!/usr/bin/env python3
"""CrossPad SWD real-time tracer daemon (pyOCD).

Subcommands:
  symbols  --elf PATH [--query STR]      -> prints JSON {symbols:[...]} and exits
  trace    --elf PATH --signals NAMES [--rate HZ] [--out FILE] [--probe UID]
                                         -> NDJSON frames on stdout until stdin {"cmd":"stop"}
           Optional SWO/ITM:
             --swo PORT:NAME[,...]        -> EXPERIMENTAL: decode ITM stimulus ports onto named
                                            signals.  Requires firmware that emits ITM data on the
                                            SWO pin — the current CrossPad firmware does NOT do this,
                                            so this path is UNTESTED against a real ITM source.
                                            If SWV initialisation fails the daemon continues with
                                            plain RAM polling (fail-soft).
             --cpu-hz HZ                  -> core clock for SWO baud derivation (default 64000000).
             --swo-hz HZ                  -> desired SWO baud (must match firmware TPIU config,
                                            default 2000000).

Output contract: machine JSON/NDJSON on stdout, human logs on stderr ONLY.
"""
import argparse, json, sys

def log(*a):
    print(*a, file=sys.stderr, flush=True)

# DWARF DW_AT_encoding -> our tag.
_ENC = {1: "address", 2: "bool", 4: "float", 5: "int", 7: "uint", 8: "uchar", 6: "char"}

def resolve_symbols(elf_path, query=None):
    from elftools.elf.elffile import ELFFile
    out = []
    with open(elf_path, "rb") as f:
        elf = ELFFile(f)
        if not elf.has_dwarf_info():
            raise RuntimeError("ELF has no DWARF info (build Debug with -g).")
        dwarf = elf.get_dwarf_info()
        for cu in dwarf.iter_CUs():
            for die in cu.iter_DIEs():
                if die.tag != "DW_TAG_variable":
                    continue
                name = die.attributes.get("DW_AT_name")
                loc = die.attributes.get("DW_AT_location")
                if not name or not loc:
                    continue
                # Only fixed-address globals/statics: DW_OP_addr (0x03) + 4-byte little-endian addr.
                expr = loc.value
                if not isinstance(expr, list) or len(expr) != 5 or expr[0] != 0x03:
                    continue
                addr = expr[1] | (expr[2] << 8) | (expr[3] << 16) | (expr[4] << 24)
                nm = name.value.decode("utf-8", "replace")
                if query and query.lower() not in nm.lower():
                    continue
                enc, size = _resolve_type(die, cu)
                out.append({"name": nm, "address": addr, "encoding": enc, "size": size})
    # De-dup by (name,address); stable order by address.
    seen, uniq = set(), []
    for s in sorted(out, key=lambda x: x["address"]):
        k = (s["name"], s["address"])
        if k not in seen:
            seen.add(k); uniq.append(s)
    return uniq

def _resolve_type(die, cu):
    """Walk DW_AT_type to a base type, returning (encoding_tag, byte_size).

    For arrays/pointers we return the underlying base-type encoding and the
    *total* byte_size of the outermost type that carries DW_AT_byte_size.
    """
    enc, size = "uint", 4
    size_set = False
    t = die.attributes.get("DW_AT_type")
    depth = 0
    while t is not None and depth < 16:
        depth += 1
        ref = cu.dwarfinfo.get_DIE_from_refaddr(t.value + cu.cu_offset)
        bs = ref.attributes.get("DW_AT_byte_size")
        if bs and not size_set:
            size = bs.value
            size_set = True
        if ref.tag == "DW_TAG_base_type":
            e = ref.attributes.get("DW_AT_encoding")
            if e:
                enc = _ENC.get(e.value, "uint")
            return enc, size
        if ref.tag == "DW_TAG_pointer_type":
            return "uint", (size if size_set else 4)
        t = ref.attributes.get("DW_AT_type")
    return enc, size

def cmd_symbols(args):
    syms = resolve_symbols(args.elf, args.query)
    print(json.dumps({"symbols": syms}))

# --- trace mode ---------------------------------------------------------------
import io, re, struct, threading, time

# ---------------------------------------------------------------------------
# EXPERIMENTAL: SWO / ITM sink (only used when --swo is passed)
# ---------------------------------------------------------------------------

class _ITMValueSink:
    """Collects the latest ITM stimulus-port word.

    Implements the TraceEventSink interface (receive(event)) without
    subclassing so that the import of pyocd.trace.sink is deferred to the
    --swo code path and never touched on the negative (plain-polling) path.

    Thread-safe-ish: dict writes are GIL-guarded on CPython.
    """
    def __init__(self):
        self.latest = {}  # port:int -> value:int

    def receive(self, event):
        try:
            from pyocd.trace.events import TraceITMEvent
            if isinstance(event, TraceITMEvent):
                self.latest[event.port] = event.data
        except Exception:
            pass  # never crash the probe thread


def _setup_swo(session, cpu_hz, swo_hz):
    """Wire up SWVReader with our custom ITM sink.

    Strategy: call SWVReader.init() with a dummy StringIO console (so the
    standard SWVEventSink is constructed), then immediately replace the
    parser's connected sink with our own _ITMValueSink.  This is the only
    way to inject a custom sink given pyOCD 0.44's SWVReader.init() API
    (signature: init(sys_clock, swo_clock, console:TextIO) -> bool).

    Returns (reader, sink) on success, (None, None) on any failure.
    The function is fail-soft: it logs to stderr and never raises.
    """
    try:
        from pyocd.trace.swv import SWVReader
        sink = _ITMValueSink()
        reader = SWVReader(session, 0)
        dummy_console = io.StringIO()
        ok = reader.init(cpu_hz, swo_hz, dummy_console)
        if not ok:
            # init() already printed a pyOCD warning; add our own context.
            log("[swo] SWVReader.init() returned False (probe/target may lack SWO support); "
                "continuing with plain RAM polling only.")
            return None, None
        # Redirect the parser's downstream sink to ours.
        # reader._parser is a SWOParser; SWOParser.connect(sink) replaces _sink.
        reader._parser.connect(sink)
        log(f"[swo] SWV reader started (cpu_hz={cpu_hz}, swo_hz={swo_hz}); "
            "ITM data will be merged into sample frames when available.")
        return reader, sink
    except Exception as e:
        log(f"[swo] setup failed, continuing with polling only: {e}")
        return None, None

_NP = struct.Struct("<I")  # little-endian u32 for the file header length prefix
_SIG_RE = re.compile(r"^([A-Za-z_]\w*)(?:\[(\d+)\])?$")

def _resolve_signal(spec, syms):
    """spec: 'name' or 'name[index]'. Returns {name,address,size,encoding} or None."""
    m = _SIG_RE.match(spec)
    if not m:
        return None
    base, idx = m.group(1), m.group(2)
    s = syms.get(base)
    if not s:
        return None
    addr = s["address"]
    if idx is not None:
        addr += int(idx) * s["size"]
    return {"name": spec, "address": addr, "size": s["size"], "encoding": s["encoding"]}

def _coalesce(sigs):
    """sigs: list of {name,address,size,encoding}. Returns [(start,length,[(name,off,size,enc)])]."""
    items = sorted(sigs, key=lambda s: s["address"])
    ranges = []
    for s in items:
        a, ln = s["address"], s["size"]
        if ranges and a <= ranges[-1][0] + ranges[-1][1] + 4:  # merge if within 4 bytes of prev end
            start, length, members = ranges[-1]
            new_end = max(start + length, a + ln)
            ranges[-1] = (start, new_end - start, members + [(s["name"], a - start, ln, s["encoding"])])
        else:
            ranges.append((a, ln, [(s["name"], 0, ln, s["encoding"])]))
    return ranges

def _decode(buf, off, size, enc):
    raw = bytes(buf[off:off + size])
    if enc == "float" and size == 4:
        return struct.unpack("<f", raw)[0]
    if enc == "float" and size == 8:
        return struct.unpack("<d", raw)[0]
    signed = enc in ("int", "char")
    return int.from_bytes(raw, "little", signed=signed)

def cmd_trace(args):
    from pyocd.core.helpers import ConnectHelper
    names = [n for n in args.signals.split(",") if n]
    syms = {s["name"]: s for s in resolve_symbols(args.elf)}
    resolved, missing = [], []
    for spec in names:
        r = _resolve_signal(spec, syms)
        (resolved if r else missing).append(r if r else spec)
    if missing:
        print(json.dumps({"type": "error", "error": "unknown symbols: " + ",".join(missing)}), flush=True)
        return
    ranges = _coalesce(resolved)

    # --- EXPERIMENTAL: parse --swo mapping (negative path: swo_map is empty) ---
    swo_map = {}  # port:int -> signal_name:str
    if args.swo:
        for spec in args.swo.split(","):
            spec = spec.strip()
            if not spec:
                continue
            try:
                port_str, sig_name = spec.split(":", 1)
                swo_map[int(port_str)] = sig_name
            except (ValueError, TypeError):
                log(f"[swo] ignoring malformed port:name spec: {spec!r}")
        if swo_map:
            log(f"[swo] EXPERIMENTAL: ITM port mapping: {swo_map}  "
                "(requires firmware that emits ITM on SWO — NOT present in current CrossPad firmware)")

    fh = open(args.out, "wb") if args.out else None
    if fh:
        hdr = json.dumps({"signals": [{"name": s["name"], "encoding": s["encoding"], "size": s["size"]} for s in resolved]}).encode()
        fh.write(b"CPTR"); fh.write(_NP.pack(len(hdr))); fh.write(hdr)

    target_dt = 1.0 / args.rate if args.rate > 0 else 0.0
    stop = {"v": False}

    def stdin_reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("cmd") == "stop":
                stop["v"] = True
                return
    threading.Thread(target=stdin_reader, daemon=True).start()

    log(f"connecting probe (serial={args.probe or 'auto'}, target={args.target})...")
    n = 0
    # Outer guard: probe-connect failure (e.g. probe busy — doctor can't detect
    # this, st-info only proves presence) must surface as a clean error frame,
    # not an uncaught traceback. The trace file always closes (outer finally).
    try:
        with ConnectHelper.session_with_chosen_probe(
                unique_id=args.probe or None,
                options={"target_override": args.target}) as session:
            target = session.target
            log("connected; polling (non-halting)")

            # --- EXPERIMENTAL: set up SWV reader (only when --swo was given) ---
            swo_reader, swo_sink = None, None
            if swo_map:
                swo_reader, swo_sink = _setup_swo(session, args.cpu_hz, args.swo_hz)
                # If _setup_swo failed, swo_reader/swo_sink are both None and the loop
                # below will behave identically to the no-swo path.

            t0 = time.monotonic()
            try:
                while not stop["v"]:
                    cyc = time.monotonic()
                    values, in_stop = {}, False
                    for (start, length, members) in ranges:
                        try:
                            data = target.read_memory_block8(start, length)
                        except Exception:
                            in_stop = True
                            break
                        for (name, off, size, enc) in members:
                            values[name] = _decode(data, off, size, enc)
                    t = time.monotonic() - t0
                    if in_stop:
                        print(json.dumps({"type": "status", "device_state": "stop_suspected", "t": round(t, 6)}), flush=True)
                        time.sleep(0.2)
                        continue

                    # --- EXPERIMENTAL: merge ITM values (no-op when swo_sink is None) ---
                    if swo_sink is not None:
                        for port, sig_name in swo_map.items():
                            v = swo_sink.latest.get(port)
                            if v is not None:
                                values[sig_name] = v

                    print(json.dumps({"type": "sample", "t": round(t, 6), "values": values}), flush=True)
                    if fh:
                        fh.write(json.dumps({"t": round(t, 6), "v": values}).encode() + b"\n")
                    n += 1
                    if target_dt:
                        slp = target_dt - (time.monotonic() - cyc)
                        if slp > 0:
                            time.sleep(slp)
            finally:
                # Stop SWV reader if it was started (fail-soft: ignore errors).
                if swo_reader is not None:
                    try:
                        swo_reader.stop()
                        log("[swo] SWV reader stopped.")
                    except Exception as e:
                        log(f"[swo] error stopping SWV reader (ignored): {e}")
        log(f"stopped after {n} samples")
        print(json.dumps({"type": "status", "device_state": "stopped", "samples": n}), flush=True)
    except Exception as e:
        log(f"trace connect/run failed: {e}")
        print(json.dumps({"type": "error", "error": str(e)}), flush=True)
    finally:
        if fh:
            fh.close()

# --- device-state mode -------------------------------------------------------

_REGS = {
    "PWR_CR1":   0x40007000,
    "PWR_SR1":   0x40007010,
    "RCC_CR":    0x40021000,
    "RCC_CFGR":  0x40021008,
    "SCB_SCR":   0xE000ED10,
    "DBGMCU_CR": 0x40015804,
}

def cmd_device_state(args):
    from pyocd.core.helpers import ConnectHelper
    out = {"type": "device_state", "regs": {}, "decoded": {}, "accessible": True}
    try:
        with ConnectHelper.session_with_chosen_probe(unique_id=args.probe or None,
              options={"target_override": args.target}) as session:
            t = session.target
            for name, addr in _REGS.items():
                try:
                    out["regs"][name] = t.read32(addr)
                except Exception:
                    out["regs"][name] = None
                    out["accessible"] = False
            scr = out["regs"].get("SCB_SCR") or 0
            out["decoded"]["SLEEPDEEP"] = bool(scr & (1 << 2))
            cr1 = out["regs"].get("PWR_CR1") or 0
            out["decoded"]["LPMS"] = cr1 & 0x7  # low-power mode select (STM32G0 PWR_CR1[2:0])
            out["decoded"]["interpretation"] = (
              "STOP/low-power likely" if out["decoded"]["SLEEPDEEP"] else "run/sleep")
    except Exception as e:
        out["accessible"] = False
        out["error"] = str(e)
    print(json.dumps(out), flush=True)

def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("symbols")
    sp.add_argument("--elf", required=True)
    sp.add_argument("--query", default=None)
    sp.set_defaults(func=cmd_symbols)

    tp = sub.add_parser("trace")
    tp.add_argument("--elf", required=True)
    tp.add_argument("--signals", required=True)
    tp.add_argument("--rate", type=float, default=0.0)  # 0 = as fast as possible
    tp.add_argument("--out", default=None)
    tp.add_argument("--probe", default=None)
    tp.add_argument("--target", default="cortex_m",
                    help="pyOCD target_override. Default 'cortex_m' (generic; no CMSIS pack needed, "
                         "sufficient for RAM polling). For part-specific features install the pack "
                         "(pyocd pack install stm32g0b1) and pass e.g. --target stm32g0b1retx.")
    tp.add_argument("--swo", default=None,
                    help="EXPERIMENTAL: comma list of port:name mappings for ITM stimulus ports, "
                         "e.g. '0:phase,1:isr_us'.  Requires firmware that emits ITM data on the "
                         "SWO pin (NOT present in current CrossPad firmware — UNTESTED against real "
                         "ITM).  Omit for plain RAM polling.  If SWV init fails the daemon continues "
                         "polling (fail-soft).")
    tp.add_argument("--cpu-hz", type=int, default=64_000_000,
                    help="Core clock frequency in Hz for SWO baud derivation (SWO path only). "
                         "Default 64000000 (STM32G0 max).  Must match the actual firmware clock — "
                         "CrossPad r20 runs at 64 MHz but confirm in the .ioc/.clock config.")
    tp.add_argument("--swo-hz", type=int, default=2_000_000,
                    help="Desired SWO output baud in Hz (SWO path only). Default 2000000. "
                         "Must match the TPIU_ACPR configuration in the firmware.")
    tp.set_defaults(func=cmd_trace)

    dp = sub.add_parser("device-state")
    dp.add_argument("--probe", default=None)
    dp.add_argument("--target", default="cortex_m")
    dp.set_defaults(func=cmd_device_state)

    args = ap.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
