# SWD memory write + function-call (RCE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCU-agnostic SWD memory write (poke) and function-call (RCE) to the CrossPad tracer, exposed as `crosspad_trace` `write`/`call` actions.

**Architecture:** The Python daemon (`tracer/swd_tracer.py`) gains pure spec/guard helpers plus `do_write`/`do_call`, wired both as one-shot argparse subcommands and as stdin commands inside the live poll loop (with correlated `write_result`/`call_result` frames). The TS layer adds pure param/result helpers (`trace-write.ts`), routing in `trace-session.ts` (stdin-cmd + id correlation, one-shot fallback), and two new actions in `index.ts`. Write is non-halting; call halts → restores → resumes.

**Tech Stack:** Python 3.12 + pyOCD 0.44.1 (daemon), TypeScript + vitest (MCP server, Node 22 via nvm), pyelftools (DWARF).

## Global Constraints

- Daemon machine output is **stdout NDJSON only**; human logs go to **stderr** (`log()`).
- pyOCD API (verified 0.44.1): `target.write32/write16/write8(addr,val)`, `target.read32/16/8(addr)`, `target.read_core_register(name)`, `target.write_core_register(name,val)`, `target.halt()`, `target.resume()`, `target.get_state() == Target.State.HALTED`, `target.set_breakpoint(addr, Target.BreakpointType.HW)`, `target.remove_breakpoint(addr)`. Import `from pyocd.core.target import Target`.
- Write allowlist (architectural Cortex-M, MCU-agnostic): ALLOW SRAM `0x20000000–0x3FFFFFFF`, Peripheral `0x40000000–0x5FFFFFFF`, PPB `0xE0000000–0xE00FFFFF`; BLOCK Code region `0x00000000–0x1FFFFFFF` (flash/system/option).
- `call`: ≤4 args (r0–r3, AAPCS), `confirm:true` required, default timeout 2000 ms; mask interrupts (PRIMASK=1) during the thunk; save/restore full context.
- No Node test downgrade: run vitest under `nvm use 22`.
- Build before any MCP-tool live test: `npm run build` (daemon is read live, TS is not).
- Do NOT commit `docs/superpowers/**` (user constraint). Commit only `tracer/` and `src/` changes.
- Python pure-function "tests" are repl assertions (the repo has no pytest harness), exactly as `_resolve_raw` was verified.

---

### Task 1: Write-spec parser (daemon, pure)

Parse `"<read-spec>=<value>"` into a resolved write descriptor, reusing the existing `_resolve_raw` (for `@…`) and `_resolve_spec` (for symbols).

**Files:**
- Modify: `tracer/swd_tracer.py` (add after `_resolve_raw`, ~line 738)

**Interfaces:**
- Consumes: `_resolve_raw(spec)`, `_resolve_spec(spec, table)`, `_RAW_TYPE`.
- Produces: `_parse_write_spec(spec, table) -> dict`. Returns
  `{"ok":True, "name":str, "address":int, "size":int, "encoding":str, "value":int|float}`
  or `{"ok":False, "spec":str, "error":str}`. A single `@addr:type[count]` block on the
  left is rejected for write (`error="block write unsupported; write one element"`); only
  a single concrete element resolves.

- [ ] **Step 1: Write the parser**

```python
def _parse_value(text, encoding, size):
    """Parse the RHS literal per the target encoding. int: hex 0x.. or decimal
    (range-checked to the byte size, two's-complement for signed); float: f32."""
    text = text.strip()
    if encoding == "float":
        return float(text)
    v = int(text, 0)  # 0x.. hex or decimal
    bits = size * 8
    if encoding in ("int", "char"):
        lo, hi = -(1 << (bits - 1)), (1 << (bits - 1)) - 1
        if not (lo <= v <= hi):
            raise ValueError("value out of range for i%d" % bits)
        if v < 0:
            v &= (1 << bits) - 1  # store two's-complement
    else:
        if not (0 <= v < (1 << bits)):
            raise ValueError("value out of range for u%d" % bits)
    return v

def _parse_write_spec(spec, table):
    """'target=value' -> resolved write descriptor (see Interfaces)."""
    if "=" not in spec:
        return {"ok": False, "spec": spec, "error": "missing '=' (use target=value)"}
    left, right = spec.split("=", 1)
    left, right = left.strip(), right.strip()
    # Resolve the LHS address/size/encoding using the read resolvers.
    raw = _resolve_raw(left)
    if raw is not None:
        if raw["n"] != 1:
            return {"ok": False, "spec": spec,
                    "error": "block write unsupported; write one element"}
        d = raw["elems"][0]
    else:
        d = _resolve_spec(left, table)
        if not d:
            return {"ok": False, "spec": spec, "error": "unknown target: %s" % left}
    try:
        val = _parse_value(right, d["encoding"], d["size"])
    except ValueError as e:
        return {"ok": False, "spec": spec, "error": str(e)}
    return {"ok": True, "name": left, "address": d["address"],
            "size": d["size"], "encoding": d["encoding"], "value": val}
```

- [ ] **Step 2: Verify via repl (acts as the test)**

Run:
```bash
PY=/home/matixan/.local/share/crosspad-mcp/venv/bin/python
cd /home/matixan/GIT/crosspad-mcp/tracer && $PY -c "
import swd_tracer as t
for s in ['@0x20000000=0x12345678','@0x40021000:u16=0xFFFF','@0x20000000:i8=-5',
          '@0x20000000:f32=1.5','@0x20000000:u8=300','noeq','@0x20000000:u8[4]=1']:
    print(s, '->', t._parse_write_spec(s, {}))
"
```
Expected: first four `ok:True` (the i8 stores `0xFB`=251, f32 value `1.5`); `u8=300` → `ok:False` range error; `noeq` → missing '='; `u8[4]=1` → block write unsupported.

- [ ] **Step 3: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): write-spec parser (target=value) for SWD poke"
```

---

### Task 2: Allowlist guard (daemon, pure)

**Files:**
- Modify: `tracer/swd_tracer.py` (add after Task 1 helpers)

**Interfaces:**
- Produces: `_ARCH_REGIONS` (list of `(lo,hi)` inclusive allowed ranges),
  `_check_allowed(addr, size, ram_regions=None) -> str|None` (None = allowed, else error string).
  `ram_regions`, when provided (CMSIS-pack refinement), replaces the architectural SRAM
  window: an address in `0x20000000–0x3FFFFFFF` must fall inside one of `ram_regions`.

- [ ] **Step 1: Write the guard**

```python
# Cortex-M architectural memory map (ARMv6/7/8-M) — identical across STM32 series.
_SRAM = (0x20000000, 0x3FFFFFFF)
_ARCH_REGIONS = [
    _SRAM,                       # SRAM
    (0x40000000, 0x5FFFFFFF),    # Peripheral + IOPORT
    (0xE0000000, 0xE00FFFFF),    # PPB / SCS (NVIC, SCB, DWT...)
]

def _check_allowed(addr, size, ram_regions=None):
    """Return None if [addr, addr+size) is a permitted write target, else an
    error string. Code region 0x0..0x1FFFFFFF (flash/system/option) is blocked."""
    if size not in (1, 2, 4):
        return "bad access size %r" % size
    if addr % size != 0:
        return "0x%08X not %d-byte aligned" % (addr, size)
    end = addr + size - 1
    for lo, hi in _ARCH_REGIONS:
        if lo <= addr and end <= hi:
            # SRAM refinement: if pack RAM regions are known, require containment.
            if (lo, hi) == _SRAM and ram_regions:
                if not any(rl <= addr and end <= rh for rl, rh in ram_regions):
                    return "0x%08X outside mapped SRAM" % addr
            return None
    return "0x%08X outside write allowlist (Code region / unmapped is blocked)" % addr
```

- [ ] **Step 2: Verify via repl**

Run:
```bash
$PY -c "
import swd_tracer as t
ck=t._check_allowed
print('sram', ck(0x20000000,4))            # None
print('periph', ck(0x40021000,4))          # None
print('ppb', ck(0xE000ED10,4))             # None
print('flash', ck(0x08000000,4))           # blocked
print('sysmem', ck(0x1FFF0000,4))          # blocked
print('misalign', ck(0x20000001,4))        # not aligned
print('refine', ck(0x20030000,4,[(0x20000000,0x20023FFF)]))  # outside mapped SRAM
"
```
Expected: first three `None`; flash/sysmem blocked; misalign error; refine → outside mapped SRAM.

- [ ] **Step 3: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): architectural-map write allowlist (MCU-agnostic)"
```

---

### Task 3: do_write + memmap helper + `write` subcommand (daemon)

**Files:**
- Modify: `tracer/swd_tracer.py` (add `do_write`, `_ram_regions_from`, argparse `write`)

**Interfaces:**
- Consumes: `_parse_write_spec`, `_check_allowed`, `build_symbol_table`, `_try_open_session`.
- Produces: `do_write(target, descriptors, ram_regions) -> list[dict]` (per-write result
  `{name,address,size,ok,old,new,error?}`); `_ram_regions_from(session) -> list|None`;
  argparse subcommand `write --elf --writes "s1;s2" [--probe] [--target] [--connect-timeout]`.
  Writes are `;`-separated on the CLI (commas appear inside specs).

- [ ] **Step 1: Write do_write + helpers**

```python
def _ram_regions_from(session):
    """Best-effort (lo,hi) inclusive RAM ranges from the pyOCD memory map; None if
    the (generic) target exposes none."""
    try:
        mm = session.target.get_memory_map()
        rams = [(r.start, r.end) for r in mm if r.type.name.lower() == "ram"]
        return rams or None
    except Exception:
        return None

_WSIZE = {1: "write8", 2: "write16", 4: "write32"}
_RSIZE = {1: "read8", 2: "read16", 4: "read32"}

def do_write(target, descriptors, ram_regions):
    """Apply each resolved write non-halting; read-back old/new for confirmation."""
    out = []
    for d in descriptors:
        if not d.get("ok"):
            out.append({"name": d.get("name", d.get("spec")), "ok": False,
                        "error": d["error"]})
            continue
        addr, size = d["address"], d["size"]
        guard = _check_allowed(addr, size, ram_regions)
        if guard:
            out.append({"name": d["name"], "address": addr, "size": size,
                        "ok": False, "error": "write blocked: " + guard})
            continue
        try:
            old = getattr(target, _RSIZE[size])(addr)
            getattr(target, _WSIZE[size])(addr, d["value"] & ((1 << (size * 8)) - 1))
            new = getattr(target, _RSIZE[size])(addr)
            out.append({"name": d["name"], "address": addr, "size": size,
                        "ok": True, "old": old, "new": new})
        except Exception as e:
            out.append({"name": d["name"], "address": addr, "size": size,
                        "ok": False, "error": str(e)})
    return out

def cmd_write(args):
    specs = [s for s in args.writes.split(";") if s.strip()]
    try:
        table = build_symbol_table(args.elf)
    except Exception as e:
        print(json.dumps({"type": "error", "error": "ELF/DWARF error: %s" % e}), flush=True)
        return
    descriptors = [_parse_write_spec(s, table) for s in specs]
    session, cerr, _ = _try_open_session(args.probe, args.target, args.connect_timeout)
    if session is None:
        print(json.dumps({"type": "write_result", "ok": False, "error": cerr,
                          "results": []}), flush=True)
        return
    try:
        results = do_write(session.target, descriptors, _ram_regions_from(session))
    finally:
        try: session.close()
        except Exception: pass
    print(json.dumps({"type": "write_result",
                      "ok": all(r["ok"] for r in results) if results else False,
                      "results": results}), flush=True)
```

- [ ] **Step 2: Register the subcommand in `main()`**

Add after the `device-state` parser block (~line 1137):
```python
    wp = sub.add_parser("write")
    wp.add_argument("--elf", required=True)
    wp.add_argument("--writes", required=True, help="';'-separated target=value specs")
    wp.add_argument("--probe", default=None)
    wp.add_argument("--target", default="cortex_m")
    wp.add_argument("--connect-timeout", type=float, default=6.0)
    wp.set_defaults(func=cmd_write)
```

- [ ] **Step 3: Live verify (ST-Link attached) — poke GPIOB ODR, read back**

Run (writes a benign value to GPIOB BSRR `0x50000418`, set then reset a spare bit; ODR `0x50000414`):
```bash
$PY swd_tracer.py write --elf /home/matixan/GIT/CrossPad_STM32_r20/build/Debug/CrossPad_STM32_r20.elf --writes '@0x20000000:u32=0xCAFEBABE'
```
Expected: `{"type":"write_result","ok":true,"results":[{...,"ok":true,"old":...,"new":3405691582}]}` (new == 0xCAFEBABE). Pick a scratch SRAM address; confirm `new` equals the written value.

- [ ] **Step 4: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): do_write + one-shot write subcommand (non-halting poke)"
```

---

### Task 4: do_call + `call` subcommand (daemon)

**Files:**
- Modify: `tracer/swd_tracer.py` (add `_resolve_func`, `do_call`, argparse `call`)

**Interfaces:**
- Consumes: `build_symbol_table` (+ ELF symtab for functions), `_try_open_session`, `Target`.
- Produces: `_resolve_func(elf_path, name) -> int|None` (function entry address);
  `do_call(target, entry, args, ret_type, timeout_s) -> dict`
  (`{ok, r0, decoded?, error?}`); argparse `call --elf --func --args "a,b" --confirm
  [--ret-type u32] [--timeout 2.0] [--probe] [--target] [--connect-timeout]`.

- [ ] **Step 1: Function resolver (ELF symbol table — functions, not just data globals)**

```python
def _resolve_func(elf_path, name):
    """Entry address of a function symbol from the ELF .symtab (STT_FUNC)."""
    from elftools.elf.elffile import ELFFile
    with open(elf_path, "rb") as f:
        elf = ELFFile(f)
        symtab = elf.get_section_by_name(".symtab")
        if symtab is None:
            return None
        for sym in symtab.iter_symbols():
            if sym.name == name and sym["st_info"]["type"] == "STT_FUNC":
                return sym["st_value"] & ~1  # clear Thumb bit
    return None
```

- [ ] **Step 2: The call thunk**

```python
_CALL_CTX = ["r0","r1","r2","r3","r4","r5","r6","r7","r8","r9","r10","r11","r12",
             "sp","lr","pc","xpsr","primask"]

def do_call(target, entry, args, ret_type, timeout_s):
    """AAPCS function-call thunk. Halts the core, runs func(args), restores full
    context, resumes. Returns {ok,r0,decoded?} or {ok:False,error}."""
    if len(args) > 4:
        return {"ok": False, "error": "max 4 args (r0-r3); got %d" % len(args)}
    saved = {}
    trap = None
    try:
        target.halt()
        for r in _CALL_CTX:
            saved[r] = target.read_core_register(r)
        # Return trap: reset-handler address from the vector table (guaranteed
        # valid, aligned code). The HW breakpoint halts on the post-return fetch.
        trap = target.read32(0x08000004) & ~1
        target.set_breakpoint(trap, Target.BreakpointType.HW)
        for i, a in enumerate(args):
            target.write_core_register("r%d" % i, a & 0xFFFFFFFF)
        target.write_core_register("primask", 1)          # mask ISRs during thunk
        target.write_core_register("lr", trap | 1)        # Thumb return
        target.write_core_register("pc", entry)
        xpsr = saved["xpsr"] | (1 << 24)                  # ensure Thumb (T) bit
        target.write_core_register("xpsr", xpsr)
        target.resume()
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if target.get_state() == Target.State.HALTED:
                break
            time.sleep(0.002)
        else:
            target.halt()
            return {"ok": False, "error":
                    "call timed out after %gms (function did not return)" % (timeout_s * 1000)}
        r0 = target.read_core_register("r0")
        res = {"ok": True, "r0": r0}
        if ret_type and ret_type != "u32":
            res["decoded"] = _decode(r0.to_bytes(4, "little"), 0, *_RAW_TYPE[ret_type])
        return res
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        try:
            if trap is not None:
                target.remove_breakpoint(trap)
            for r, v in saved.items():
                target.write_core_register(r, v)          # full context restore
            target.resume()                               # firmware continues pre-call
        except Exception:
            pass

def cmd_call(args):
    if not args.confirm:
        print(json.dumps({"type": "call_result", "ok": False,
                          "error": "call requires --confirm"}), flush=True)
        return
    entry = _resolve_func(args.elf, args.func)
    if entry is None:
        print(json.dumps({"type": "call_result", "ok": False,
                          "error": "unknown function: %s" % args.func}), flush=True)
        return
    argv = [int(a, 0) for a in args.args.split(",") if a.strip()] if args.args else []
    session, cerr, _ = _try_open_session(args.probe, args.target, args.connect_timeout)
    if session is None:
        print(json.dumps({"type": "call_result", "ok": False, "error": cerr}), flush=True)
        return
    try:
        res = do_call(session.target, entry, argv, args.ret_type, args.timeout)
    finally:
        try: session.close()
        except Exception: pass
    res["type"] = "call_result"
    print(json.dumps(res), flush=True)
```

- [ ] **Step 3: Register the subcommand in `main()`** (after the `write` parser)

```python
    cp = sub.add_parser("call")
    cp.add_argument("--elf", required=True)
    cp.add_argument("--func", required=True)
    cp.add_argument("--args", default=None, help="comma-separated ints (hex 0x.. or dec)")
    cp.add_argument("--confirm", action="store_true")
    cp.add_argument("--ret-type", dest="ret_type", default="u32",
                    choices=list(_RAW_TYPE.keys()))
    cp.add_argument("--timeout", type=float, default=2.0)
    cp.add_argument("--probe", default=None)
    cp.add_argument("--target", default="cortex_m")
    cp.add_argument("--connect-timeout", type=float, default=6.0)
    cp.set_defaults(func=cmd_call)
```

- [ ] **Step 4: Live verify (ST-Link attached)** — call a real firmware function with an observable effect, confirm firmware keeps running.

Pick a side-effecting helper from the firmware (e.g. an LED/pad setter found via `crosspad_search_symbols`). Example skeleton:
```bash
ELF=/home/matixan/GIT/CrossPad_STM32_r20/build/Debug/CrossPad_STM32_r20.elf
$PY swd_tracer.py call --elf $ELF --func <led_set_fn> --args '3,0xFF0000' --confirm
```
Expected: `{"type":"call_result","ok":true,"r0":...}`; the LED reacts; a follow-up `device-state` or raw read shows the core RUNNING (context restored). Also verify `--confirm` omitted → `ok:false, "call requires --confirm"`, and an unknown `--func` → unknown function.

- [ ] **Step 5: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): do_call function-call thunk + one-shot call subcommand (RCE)"
```

---

### Task 5: Live-trace stdin commands + result frames (daemon)

Wire `write`/`call` into the running poll loop so a poke/call lands while a trace is live, with correlated result frames.

**Files:**
- Modify: `tracer/swd_tracer.py` — `cmd_trace` stdin reader + poll loop (~lines 908–1016)

**Interfaces:**
- Consumes: `do_write`, `do_call`, `_parse_write_spec`, `_ram_regions_from`, the trace `table`.
- Produces: stdin cmds `{"cmd":"write","id":N,"writes":[...]}` and
  `{"cmd":"call","id":N,"func":...,"args":[...],"confirm":bool,"ret_type":...,"timeout":...}`;
  stdout frames `{"type":"write_result","id":N,...}` / `{"type":"call_result","id":N,...}`.
  Commands are queued and drained in the poll loop (single-threaded probe access).

- [ ] **Step 1: Add a pending-command queue + capture ram_regions after connect**

In `cmd_trace`, near `state = {...}` (~line 851) add:
```python
    pending_cmds = []          # list of dict msgs from stdin (write/call), drained in loop
    cmd_lock = threading.Lock()
```
After `session` opens and before the loop (~line 950, after `target = session.target`) add:
```python
    ram_regions = _ram_regions_from(session)
```

- [ ] **Step 2: Extend the stdin reader** (inside `stdin_reader`, add branches)

```python
            elif cmd == "write" and isinstance(msg.get("writes"), list):
                with cmd_lock:
                    pending_cmds.append(msg)
            elif cmd == "call":
                with cmd_lock:
                    pending_cmds.append(msg)
```

- [ ] **Step 3: Drain the queue each poll cycle** (in the loop, right after the `state["dirty"]` block, before the range reads)

```python
            drained = []
            with cmd_lock:
                if pending_cmds:
                    drained = pending_cmds[:]; pending_cmds.clear()
            for msg in drained:
                rid = msg.get("id")
                if msg.get("cmd") == "write":
                    descs = [_parse_write_spec(s, table)
                             for s in msg["writes"] if isinstance(s, str)]
                    results = do_write(target, descs, ram_regions)
                    print(json.dumps({"type": "write_result", "id": rid,
                        "ok": all(r["ok"] for r in results) if results else False,
                        "results": results}), flush=True)
                else:  # call
                    if not msg.get("confirm"):
                        print(json.dumps({"type": "call_result", "id": rid,
                            "ok": False, "error": "call requires confirm:true"}), flush=True)
                        continue
                    entry = _resolve_func(args.elf, msg.get("func", ""))
                    if entry is None:
                        print(json.dumps({"type": "call_result", "id": rid, "ok": False,
                            "error": "unknown function: %s" % msg.get("func")}), flush=True)
                        continue
                    res = do_call(target, entry,
                                  [int(a) for a in msg.get("args", [])],
                                  msg.get("ret_type", "u32"), float(msg.get("timeout", 2.0)))
                    res.update({"type": "call_result", "id": rid})
                    print(json.dumps(res), flush=True)
```

- [ ] **Step 4: Live verify** — start a trace, then poke via stdin, confirm a `write_result` frame with matching `id` and the plotted signal reflects the change.

```bash
ELF=/home/matixan/GIT/CrossPad_STM32_r20/build/Debug/CrossPad_STM32_r20.elf
printf '%s\n%s\n%s\n' \
  '' \
  '{"cmd":"write","id":1,"writes":["@0x20000000:u32=0x11112222"]}' \
  '{"cmd":"stop"}' | $PY swd_tracer.py trace --elf $ELF --signals '@0x20000000:u32' --rate 20 2>/dev/null | grep -E 'write_result|sample' | head
```
Expected: a `{"type":"write_result","id":1,"ok":true,...}` line and subsequent `sample` frames showing `@0x20000000:u32` == 286335522 (0x11112222).

- [ ] **Step 5: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): live-trace write/call stdin cmds + correlated result frames"
```

---

### Task 6: TS pure helpers — `trace-write.ts`

**Files:**
- Create: `src/tools/trace-write.ts`
- Test: `src/tools/trace-write.test.ts`

**Interfaces:**
- Produces:
  - `buildWriteArgv(elf: string, writes: string[]): string[]` → daemon `write` subcommand argv (joins specs with `;`).
  - `buildCallArgv(elf: string, func: string, args: number[], confirm: boolean, retType: string, timeout: number): string[]`.
  - `writeStdinCmd(id: number, writes: string[]): string` / `callStdinCmd(id, func, args, confirm, retType, timeout): string` → one NDJSON line (no trailing newline).
  - `parseResultFrame(line: string, id: number): {match: boolean; frame?: any}` — true when a `write_result`/`call_result` with matching `id`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildWriteArgv, buildCallArgv, writeStdinCmd, callStdinCmd, parseResultFrame } from "./trace-write.js";

describe("trace-write helpers", () => {
  it("builds write subcommand argv joining specs with ';'", () => {
    expect(buildWriteArgv("/a.elf", ["@0x20000000=1", "s_x=2"]))
      .toEqual(["write", "--elf", "/a.elf", "--writes", "@0x20000000=1;s_x=2"]);
  });
  it("builds call argv with confirm flag and ret-type", () => {
    expect(buildCallArgv("/a.elf", "foo", [3, 0xff], true, "i32", 2))
      .toEqual(["call", "--elf", "/a.elf", "--func", "foo", "--args", "3,255",
                "--confirm", "--ret-type", "i32", "--timeout", "2"]);
  });
  it("omits --confirm when not confirmed", () => {
    expect(buildCallArgv("/a.elf", "foo", [], false, "u32", 2))
      .not.toContain("--confirm");
  });
  it("emits a single-line write stdin cmd", () => {
    const s = writeStdinCmd(7, ["@0x20000000=1"]);
    expect(s).not.toContain("\n");
    expect(JSON.parse(s)).toEqual({ cmd: "write", id: 7, writes: ["@0x20000000=1"] });
  });
  it("matches a result frame by id", () => {
    const line = JSON.stringify({ type: "write_result", id: 7, ok: true, results: [] });
    expect(parseResultFrame(line, 7)).toEqual({ match: true, frame: JSON.parse(line) });
    expect(parseResultFrame(line, 9).match).toBe(false);
    expect(parseResultFrame("{not json", 7).match).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing)

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null
npx vitest run src/tools/trace-write.test.ts
```
Expected: FAIL (cannot find `./trace-write.js`).

- [ ] **Step 3: Implement `trace-write.ts`**

```typescript
/** Pure builders for the daemon write/call subcommands and live-trace stdin cmds. */

export function buildWriteArgv(elf: string, writes: string[]): string[] {
  return ["write", "--elf", elf, "--writes", writes.join(";")];
}

export function buildCallArgv(
  elf: string, func: string, args: number[], confirm: boolean,
  retType: string, timeout: number,
): string[] {
  const argv = ["call", "--elf", elf, "--func", func,
                "--args", args.map((n) => String(n)).join(",")];
  if (confirm) argv.push("--confirm");
  argv.push("--ret-type", retType, "--timeout", String(timeout));
  return argv;
}

export function writeStdinCmd(id: number, writes: string[]): string {
  return JSON.stringify({ cmd: "write", id, writes });
}

export function callStdinCmd(
  id: number, func: string, args: number[], confirm: boolean,
  retType: string, timeout: number,
): string {
  return JSON.stringify({ cmd: "call", id, func, args, confirm, ret_type: retType, timeout });
}

export function parseResultFrame(line: string, id: number): { match: boolean; frame?: any } {
  const t = line.trim();
  if (!t.startsWith("{")) return { match: false };
  try {
    const o = JSON.parse(t);
    if ((o.type === "write_result" || o.type === "call_result") && o.id === id) {
      return { match: true, frame: o };
    }
  } catch { /* not a json frame */ }
  return { match: false };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run src/tools/trace-write.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/trace-write.ts src/tools/trace-write.test.ts
git commit -m "feat(trace): pure TS helpers for write/call argv + stdin cmds"
```

---

### Task 7: Routing in `trace-session.ts` — stdin-cmd correlation + one-shot fallback

**Files:**
- Modify: `src/tools/trace-session.ts`
- Test: `src/tools/trace-session.test.ts` (add cases)

**Interfaces:**
- Consumes: `buildWriteArgv`, `buildCallArgv`, `writeStdinCmd`, `callStdinCmd`, `parseResultFrame`, `resolvedElf()`, `resolvedPython()`, `daemonPath()`, the existing daemon-process handle + stdout line stream used by the live trace.
- Produces (on the session manager):
  - `traceWrite(writes: string[]): Promise<{ok:boolean; results?:any[]; error?:string}>`
  - `traceCall(func, args, confirm, retType, timeout): Promise<{ok:boolean; r0?:number; decoded?:any; error?:string}>`
  Both route through the live daemon (stdin cmd + id correlation, 8 s timeout) when a
  trace is active, else spawn the one-shot subcommand. `nextCmdId()` is a monotonic counter.

- [ ] **Step 1: Read the current session manager**

Read `src/tools/trace-session.ts` in full to find: the daemon child-process handle, how stdout lines are dispatched to the buffer, and how `start`/`stop` manage lifecycle. Identify the single place stdout NDJSON lines are parsed (the live read loop) — the correlation hook attaches there.

- [ ] **Step 2: Add a pending-id registry + line hook**

Add to the session-manager module state:
```typescript
const pendingCmds = new Map<number, (frame: any) => void>();
let cmdIdSeq = 1;
function nextCmdId(): number { return cmdIdSeq++; }
```
In the existing stdout line handler (where each NDJSON line from the live daemon is already processed), add — before/after the sample handling — a correlation check:
```typescript
for (const [id, resolve] of pendingCmds) {
  const m = parseResultFrame(line, id);
  if (m.match) { pendingCmds.delete(id); resolve(m.frame); break; }
}
```

- [ ] **Step 3: Implement `traceWrite` (live route + one-shot fallback)**

```typescript
export async function traceWrite(writes: string[]): Promise<{ok:boolean; results?:any[]; error?:string}> {
  const daemon = getLiveDaemon();          // existing accessor; null when no trace active
  if (daemon) {
    const id = nextCmdId();
    const frame = await sendAndAwait(daemon, writeStdinCmd(id, writes), id, 8000);
    if (!frame) return { ok: false, error: "write timed out (no result frame)" };
    return { ok: frame.ok, results: frame.results };
  }
  // one-shot fallback
  let out = "";
  await runArgvStream(resolvedPython(), [daemonPath(), ...buildWriteArgv(resolvedElf(), writes)],
    process.cwd(), (s, l) => { if (s === "stdout") out += l + "\n"; }, 30_000);
  return parseOneShot(out, "write_result");
}
```
With helpers (same module):
```typescript
function sendAndAwait(daemon: any, line: string, id: number, timeoutMs: number): Promise<any|null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingCmds.delete(id); resolve(null); }, timeoutMs);
    pendingCmds.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    daemon.stdin.write(line + "\n");
  });
}
function parseOneShot(out: string, type: string): any {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{") && lines[i].includes(`"${type}"`)) {
      try { return JSON.parse(lines[i]); } catch { /* keep scanning */ }
    }
  }
  return { ok: false, error: out.split("\n").filter(Boolean).slice(-3).join(" | ") || "no output" };
}
```

- [ ] **Step 4: Implement `traceCall` (mirror, with confirm/timeout)**

```typescript
export async function traceCall(
  func: string, args: number[], confirm: boolean, retType: string, timeout: number,
): Promise<{ok:boolean; r0?:number; decoded?:any; error?:string}> {
  const daemon = getLiveDaemon();
  if (daemon) {
    const id = nextCmdId();
    const frame = await sendAndAwait(daemon, callStdinCmd(id, func, args, confirm, retType, timeout),
      id, Math.max(8000, timeout * 1000 + 4000));
    if (!frame) return { ok: false, error: "call timed out (no result frame)" };
    return frame;
  }
  let out = "";
  await runArgvStream(resolvedPython(),
    [daemonPath(), ...buildCallArgv(resolvedElf(), func, args, confirm, retType, timeout)],
    process.cwd(), (s, l) => { if (s === "stdout") out += l + "\n"; },
    Math.round(timeout * 1000) + 30_000);
  return parseOneShot(out, "call_result");
}
```

- [ ] **Step 5: Add a `parseOneShot` unit test**

```typescript
import { parseOneShot } from "./trace-session.js"; // export it for the test
it("parseOneShot picks the last matching frame", () => {
  const out = 'noise\n{"type":"write_result","ok":true,"results":[]}\n';
  expect(parseOneShot(out, "write_result")).toEqual({ type: "write_result", ok: true, results: [] });
  expect(parseOneShot("garbage", "write_result").ok).toBe(false);
});
```
(Export `parseOneShot` from `trace-session.ts`.)

- [ ] **Step 6: Run tests — expect PASS**

```bash
npx vitest run src/tools/trace-session.test.ts
```
Expected: PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add src/tools/trace-session.ts src/tools/trace-session.test.ts
git commit -m "feat(trace): route write/call via live daemon (id correlation) or one-shot"
```

---

### Task 8: MCP actions `write`/`call` in `index.ts`

**Files:**
- Modify: `src/index.ts` (the `crosspad_trace` tool — action enum, params, dispatch ~lines 690–760)

**Interfaces:**
- Consumes: `traceWrite`, `traceCall` from `trace-session.js`.
- Produces: `crosspad_trace` actions `write` and `call`; new optional params `writes:string[]`,
  `func:string`, `args:number[]`, `confirm:boolean`, `ret_type:enum`, `timeout:number`.

- [ ] **Step 1: Extend the action enum + add params**

In the `action` enum add `"write"`, `"call"`. Add to `inputSchema`:
```typescript
      writes: z.array(z.string()).optional().describe("write: list of 'target=value' specs. target = @0xADDR[:type] (u8|u16|u32|i8|i16|i32|f32, default u32) or a DWARF symbol; value = hex 0x.. or decimal (float for f32). e.g. ['@0x50000414:u16=0xFFFF','s_vbat_mv=4200']. Allowlist: SRAM/peripheral/PPB only — Code/flash region is blocked."),
      func: z.string().optional().describe("call: firmware function symbol to invoke (AAPCS)."),
      args: z.array(z.number().int()).max(4).optional().describe("call: up to 4 integer args → r0-r3."),
      confirm: z.boolean().optional().describe("call: must be true — acknowledges the core is halted for the call."),
      ret_type: z.enum(["u32","i32","u16","i16","u8","i8","f32"]).optional().describe("call: decode r0 as this type (default u32; raw r0 always returned)."),
      timeout: z.number().min(0.1).max(30).optional().describe("call: max seconds to wait for the function to return (default 2)."),
```

- [ ] **Step 2: Add the dispatch cases** (in the action switch)

```typescript
      case "write": {
        if (!writes || writes.length === 0) return err("write requires `writes` (['target=value', ...]).");
        const r = await traceWrite(writes);
        return ok({ action, ok: r.ok, results: r.results, error: r.error });
      }
      case "call": {
        if (!func) return err("call requires `func` (function symbol).");
        if (!confirm) return err("call requires confirm:true (the core is halted for the call).");
        if (args && args.length > 4) return err("call accepts at most 4 args (r0-r3).");
        const r = await traceCall(func, args ?? [], true, ret_type ?? "u32", timeout ?? 2);
        return ok({ action, ...r });
      }
```
(Destructure `writes, func, args, confirm, ret_type, timeout` from the handler input alongside the existing params.)

- [ ] **Step 3: Update the `action` param description** (the long "Required params per action" string) — append:
```
write: writes[]; call: func,args?,confirm,ret_type?,timeout?.
```

- [ ] **Step 4: Build + full test suite**

```bash
npm run build
npx vitest run
```
Expected: build clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(trace): crosspad_trace write/call actions (poke + RCE) with guards"
```

---

### Task 9: Docs — PROTOCOL.md §1.3 + §2, SKILL.md

**Files:**
- Modify: `tracer/PROTOCOL.md`, `skills/swd-tracer/SKILL.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: PROTOCOL.md — add §1.3 (write specs) after §1.2**

```markdown
## 1.3 Write specs and function calls

`write` takes `target=value` specs: the LHS is any read spec (§1.1 symbol or §1.2
raw `@address[:type]`), the RHS a hex (`0x..`) or decimal literal (float for `f32`).
Writes are **non-halting** (AHB poke). Allowlist (Cortex-M architectural map, all
STM32 series): SRAM `0x20000000–0x3FFFFFFF`, Peripheral `0x40000000–0x5FFFFFFF`,
PPB `0xE0000000–0xE00FFFFF`. The Code region `0x00000000–0x1FFFFFFF` (flash, system
memory, option bytes) is **blocked**. A CMSIS-pack target narrows the SRAM window
to the real RAM regions.

`call` invokes a firmware function by symbol: up to 4 integer args (r0-r3, AAPCS),
returns r0. It **halts the core**, runs the function with interrupts masked
(PRIMASK=1) and a return breakpoint, then restores full context and resumes.
Requires `confirm:true`. A function that does not return within `timeout` (default
2 s) leaves the firmware running in its pre-call state and reports a timeout.
```

- [ ] **Step 2: PROTOCOL.md — extend §2 (stdin cmds) and the frame list**

```markdown
- `{"cmd":"write","id":N,"writes":["@0x..=v", ...]}` → emits
  `{"type":"write_result","id":N,"ok":bool,"results":[{name,address,size,ok,old,new,error?}]}`.
- `{"cmd":"call","id":N,"func":"name","args":[...],"confirm":true,"ret_type":"u32","timeout":2.0}`
  → emits `{"type":"call_result","id":N,"ok":bool,"r0":int,"decoded"?:num,"error"?:str}`.
```

- [ ] **Step 3: SKILL.md — add a write/call section after the signal-spec table**

```markdown
### Writing & calling (poke + RCE)

`crosspad_trace action=write writes=["@0x50000414:u16=0xFFFF","s_vbat_mv=4200"]`
— non-halting pokes by address or symbol. Allowed regions: SRAM, peripheral, PPB;
the flash/Code region is blocked. Works live (during a trace) or standalone.

`crosspad_trace action=call func="led_set" args=[3,16711680] confirm=true` — call a
firmware function (≤4 int args → r0-r3), returns r0 (`ret_type` decodes it). **Halts
the core briefly**, masks interrupts, restores context and resumes. `confirm:true`
is mandatory. Use for driving the firmware from the agent; avoid functions that
block or never return (they hit the `timeout` and the call is rolled back).
```

- [ ] **Step 4: Commit**

```bash
git add tracer/PROTOCOL.md skills/swd-tracer/SKILL.md
git commit -m "docs(trace): document write/call specs, stdin cmds, and skill usage"
```

---

### Task 10: Live end-to-end via the MCP tool (after server reload)

**Files:** none (verification only). Requires the MCP server to reload the rebuilt `dist/` (restart) — note this in the handoff; until then verify via the daemon directly (Tasks 3–5).

- [ ] **Step 1: Guard rejection (no hardware mutation)**

`crosspad_trace action=write writes=["@0x08000000=0x1"]` → expect `ok:false`, result error `write blocked: ... Code region ...`.
`crosspad_trace action=call func="..." confirm` omitted → expect error `call requires confirm:true`.

- [ ] **Step 2: Poke + read-back**

`crosspad_trace action=write writes=["@0x20000000:u32=0xA5A5A5A5"]` → `ok:true`, `new==2779096485`. Cross-check with `crosspad_trace action=start signals=["@0x20000000:u32"]` then `read`.

- [ ] **Step 3: Call with observable effect**

`crosspad_trace action=call func="<led/pad setter>" args=[...] confirm=true` → firmware reacts; a follow-up `status`/`read` shows the trace still sampling (core resumed).

- [ ] **Step 4: Note** — no commit (verification task). Record results in the session memory if behavior differs from the plan.

---

## Self-Review notes (addressed)

- **Spec coverage:** §2 actions → Tasks 6–8; §3 routing → Tasks 5,7; §4 guard → Task 2 (+ refinement Task 3 `_ram_regions_from`); §5 call mechanics → Task 4; §6 files → all tasks; §7 testing → repl steps (Tasks 1–4), vitest (Tasks 6–8), live (Tasks 3–5,10).
- **Placeholders:** the only intentional `<...>` is the firmware function name in live call tests (resolved at execution via `crosspad_search_symbols`), not a code placeholder.
- **Type consistency:** result frame shapes (`write_result`/`call_result` with `id`, `ok`, `results`/`r0`) match across daemon (Tasks 3–5), TS parse (Task 6 `parseResultFrame`, Task 7 `parseOneShot`), and actions (Task 8). `_RAW_TYPE` / `ret_type` enum shared. Core-register list `_CALL_CTX` defined once in Task 4.
