#!/usr/bin/env python3
"""CrossPad SWD real-time tracer daemon (pyOCD).

Subcommands:
  symbols  --elf PATH [--query STR]      -> prints JSON {symbols:[...]} and exits
  trace    --elf PATH --signals NAMES [--rate HZ] [--out FILE] [--probe UID]
                                         -> NDJSON frames on stdout until stdin {"cmd":"stop"}

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
import re, struct, threading, time

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

    log(f"connecting probe (serial={args.probe or 'auto'})...")
    with ConnectHelper.session_with_chosen_probe(
            unique_id=args.probe or None,
            options={"target_override": "stm32g0b1xx"}) as session:
        target = session.target
        log("connected; polling (non-halting)")
        t0 = time.monotonic()
        n = 0
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
            print(json.dumps({"type": "sample", "t": round(t, 6), "values": values}), flush=True)
            if fh:
                fh.write(json.dumps({"t": round(t, 6), "v": values}).encode() + b"\n")
            n += 1
            if target_dt:
                slp = target_dt - (time.monotonic() - cyc)
                if slp > 0:
                    time.sleep(slp)
        if fh:
            fh.close()
    log(f"stopped after {n} samples")
    print(json.dumps({"type": "status", "device_state": "stopped", "samples": n}), flush=True)

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
    tp.set_defaults(func=cmd_trace)

    args = ap.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
