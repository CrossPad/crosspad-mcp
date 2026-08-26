# Bit / mask signal transform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a traced signal extract a single bit (→0/1), a bit-range field, or a masked field from the decoded value via a `#`/`&` suffix, so e.g. individual GPIO-port pins plot as clean 0/1.

**Architecture:** Daemon-side only (`tracer/swd_tracer.py`). A transform suffix is peeled from the spec string before base resolution, parsed+validated against the base's byte size into a small transform dict, attached to the resolved signal dict, carried through `_coalesce` member tuples, and applied to the decoded integer in the poll loop. No TS/`src/` change — signals are opaque strings to the MCP layer and the daemon is read live.

**Tech Stack:** Python 3.12 (pyOCD tracer daemon), pyelftools. Verified with the venv python; repo has no pytest harness so pure-function checks are python-repl assertions (as `_resolve_raw` was verified).

## Global Constraints

- Daemon machine output is stdout NDJSON only; human logs to stderr (`log()`). These tasks add no new output frames.
- Transform sigils: `#` (bit / range) and `&` (mask). They do NOT occur in the existing accessor grammar (`.member`, `[i]`, `[*]`, `[a:b]`) or raw-spec grammar (`@addr[:type][count]`), so they are stripped from the spec string before base resolution.
- Forms (v = decoded value reinterpreted UNSIGNED, masked to `size*8` bits):
  - `#N` → `(v>>N)&1` (single bit, 0/1).
  - `#hi:lo` → `(v>>lo)&((1<<(hi-lo+1))-1)` (inclusive range, hi≥lo).
  - `&0xMASK` → `(v&mask)>>ffs(mask)` (ffs = index of lowest set bit).
- Validation → reject (report in the live `signals` frame's `unresolved`, never fatal): bit `N`/range `hi` ≥ `size*8`; `hi<lo`; mask `==0` or any mask bit ≥ `size*8`; malformed suffix.
- A transform on an EXPANDING base spec (`[*]`, `[a:b]`, bare/trailing array, whole-array, raw `@a:type[count]` with count>1) is rejected with `"<spec> (transform on expanding spec unsupported)"`. Transform applies only to a single scalar.
- venv python: `/home/matixan/.local/share/crosspad-mcp/venv/bin/python`; Debug ELF: `/home/matixan/GIT/CrossPad_STM32_r20/build/Debug/CrossPad_STM32_r20.elf`. Run repl checks from the `tracer/` directory.
- ST-Link attached for live checks. Free the probe first: `pkill -9 -f swd_tracer.py 2>/dev/null` (ignore exit code). On transient "Connection closed"/connect error, re-run pkill + retry up to 3×.
- Do NOT commit `docs/superpowers/**`. Commit only `tracer/` changes.

---

### Task 1: Transform suffix parser (`_split_transform` + `_parse_transform`)

**Files:**
- Modify: `tracer/swd_tracer.py` (add right after `_resolve_raw`, which ends ~line 738; before `_resolve_specs`)

**Interfaces:**
- Produces:
  - `_split_transform(spec) -> (base:str, suffix:str|None)` — peels a trailing `#…`/`&…` (suffix keeps its leading sigil); `(spec, None)` when there is no sigil.
  - `_parse_transform(suffix:str, size:int) -> dict|None` — validates against `size` (bytes) and returns `{"kind":"bit","n":N}` / `{"kind":"range","hi":H,"lo":L}` / `{"kind":"mask","mask":M,"shift":S}`, or `None` if malformed/out-of-range.

- [ ] **Step 1: Write the functions**

```python
def _split_transform(spec):
    """Peel a trailing bit/mask transform suffix (#... or &...) off a spec.

    Base specs never contain '#' or '&', so the earliest occurrence of either
    starts the suffix. Returns (base, suffix) with the sigil kept on the suffix,
    or (spec, None) when there is no transform.
    """
    idxs = [i for i in (spec.find("#"), spec.find("&")) if i >= 0]
    if not idxs:
        return spec, None
    i = min(idxs)
    return spec[:i], spec[i:]

def _parse_transform(suffix, size):
    """Validate a transform suffix against the base byte size; return a transform
    dict or None. bits = size*8. '#N' bit, '#hi:lo' range (inclusive, hi>=lo),
    '&0xMASK' mask (normalized to the lowest set bit)."""
    bits = size * 8
    if suffix.startswith("#"):
        body = suffix[1:]
        if ":" in body:
            parts = body.split(":")
            if len(parts) != 2:
                return None
            try:
                hi, lo = int(parts[0]), int(parts[1])
            except ValueError:
                return None
            if lo < 0 or hi < lo or hi >= bits:
                return None
            return {"kind": "range", "hi": hi, "lo": lo}
        try:
            n = int(body)
        except ValueError:
            return None
        if n < 0 or n >= bits:
            return None
        return {"kind": "bit", "n": n}
    if suffix.startswith("&"):
        try:
            mask = int(suffix[1:], 0)
        except ValueError:
            return None
        if mask <= 0 or mask >= (1 << bits):
            return None
        shift = (mask & -mask).bit_length() - 1  # ffs: index of lowest set bit
        return {"kind": "mask", "mask": mask, "shift": shift}
    return None
```

- [ ] **Step 2: Verify via repl (acts as the test)**

Run:
```bash
PY=/home/matixan/.local/share/crosspad-mcp/venv/bin/python
cd /home/matixan/GIT/crosspad-mcp/tracer && $PY -c "
import swd_tracer as t
print(t._split_transform('@0x50000410:u16#5'))      # ('@0x50000410:u16','#5')
print(t._split_transform('@0x50000410:u16#3:0'))    # ('@0x50000410:u16','#3:0')
print(t._split_transform('GPIOB_ODR&0x820'))        # ('GPIOB_ODR','&0x820')
print(t._split_transform('s_inputs[3]'))            # ('s_inputs[3]', None)
print('--- parse (size=2 -> 16 bits) ---')
print(t._parse_transform('#5', 2))     # {'kind':'bit','n':5}
print(t._parse_transform('#3:0', 2))   # {'kind':'range','hi':3,'lo':0}
print(t._parse_transform('&0x820', 2)) # {'kind':'mask','mask':2080,'shift':5}
print(t._parse_transform('#16', 2))    # None (>= 16 bits)
print(t._parse_transform('#2:5', 2))   # None (hi<lo)
print(t._parse_transform('&0', 2))     # None (mask 0)
print(t._parse_transform('&0x1ffff',2))# None (bit16 set, > u16)
print(t._parse_transform('#x', 2))     # None (malformed)
print(t._parse_transform('#5&0x3', 2)) # None (both sigils -> body '5&0x3' not int)
"
```
Expected: each line matches the inline comment.

- [ ] **Step 3: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): bit/mask transform suffix parser (#bit, #hi:lo, &mask)"
```

---

### Task 2: Apply the transform (`_apply_transform`)

**Files:**
- Modify: `tracer/swd_tracer.py` (add right after `_decode`, ~line 1051)

**Interfaces:**
- Consumes: the transform dicts from Task 1.
- Produces: `_apply_transform(value:int, size:int, transform:dict) -> int` — reinterprets `value` as unsigned (masked to `size*8` bits) and applies the bit/range/mask op.

- [ ] **Step 1: Write the function**

```python
def _apply_transform(value, size, transform):
    """Apply a bit/range/mask transform to a decoded value. The value is
    reinterpreted UNSIGNED (masked to size*8 bits) so a signed encoding does not
    corrupt bit extraction."""
    u = value & ((1 << (size * 8)) - 1)
    kind = transform["kind"]
    if kind == "bit":
        return (u >> transform["n"]) & 1
    if kind == "range":
        lo, hi = transform["lo"], transform["hi"]
        return (u >> lo) & ((1 << (hi - lo + 1)) - 1)
    # mask
    return (u & transform["mask"]) >> transform["shift"]
```

- [ ] **Step 2: Verify via repl**

Run:
```bash
$PY -c "
import swd_tracer as t
bit=t._parse_transform('#5',2); rng=t._parse_transform('#3:0',2); msk=t._parse_transform('&0x820',2)
print(t._apply_transform(0x0020, 2, bit))   # 1  (bit5 set)
print(t._apply_transform(0x0000, 2, bit))   # 0
print(t._apply_transform(0x00A5, 2, rng))   # 5  (low nibble of 0xA5)
print(t._apply_transform(0x0820, 2, msk))   # 0b101000001>>5 -> (0x820)>>5 = 65
print(t._apply_transform(0x0020, 2, msk))   # 1  (single masked bit normalized)
# signed reinterpretation: i16 value -1 -> 0xFFFF, bit5 -> 1
print(t._apply_transform(-1, 2, bit))       # 1
"
```
Expected: `1, 0, 5, 65, 1, 1`. (0x820 = 0b1000_0010_0000; &0x820 = 0x820; >>5 = 0x41 = 65.)

- [ ] **Step 3: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): _apply_transform (bit/range/mask on decoded value)"
```

---

### Task 3: Thread the transform through `_resolve_specs`

**Files:**
- Modify: `tracer/swd_tracer.py` — replace the body of `_resolve_specs` (lines 977-1008)

**Interfaces:**
- Consumes: `_split_transform`, `_parse_transform`, `_resolve_raw`, `_expand_spec`, `_resolve_spec`, `EXPAND_CAP`.
- Produces: resolved signal dicts that may carry a `"transform"` key; `name` keeps the full original spec (with suffix) so multiple bits of one address are uniquely named. A transform on an expanding spec → unresolved.

- [ ] **Step 1: Replace the loop body**

Replace lines 977-1008 (the `resolved, unresolved = [], []` block through `return resolved, unresolved`) with:

```python
    resolved, unresolved = [], []
    for spec in specs:
        base, suffix = _split_transform(spec)
        # §1.2: raw @address specs bypass DWARF entirely.
        raw = _resolve_raw(base)
        if raw is not None:
            if raw["n"] > EXPAND_CAP:
                unresolved.append("%s (expands to %d > %d)" % (spec, raw["n"], EXPAND_CAP))
            elif not raw["elems"]:
                unresolved.append(spec)
            elif suffix is not None:
                if raw["n"] != 1:
                    unresolved.append("%s (transform on expanding spec unsupported)" % spec)
                else:
                    t = _parse_transform(suffix, raw["elems"][0]["size"])
                    if t is None:
                        unresolved.append(spec)
                    else:
                        e = dict(raw["elems"][0]); e["transform"] = t; e["name"] = spec
                        resolved.append(e)
            else:
                resolved.extend(raw["elems"])
            continue
        elems, n = _expand_spec(base, table)
        if n > EXPAND_CAP:
            unresolved.append("%s (expands to %d > %d)" % (spec, n, EXPAND_CAP))
            continue
        if elems:
            if suffix is not None and n != 1:
                unresolved.append("%s (transform on expanding spec unsupported)" % spec)
                continue
            for e in elems:
                r = _resolve_spec(e, table)
                if not r:
                    continue
                if suffix is not None:
                    t = _parse_transform(suffix, r["size"])
                    if t is None:
                        unresolved.append(spec); continue
                    r = dict(r); r["transform"] = t; r["name"] = spec
                resolved.append(r)
            continue
        # Not expandable — try as a plain concrete scalar spec.
        r = _resolve_spec(base, table)
        if r:
            if suffix is not None:
                t = _parse_transform(suffix, r["size"])
                if t is None:
                    unresolved.append(spec)
                    continue
                r = dict(r); r["transform"] = t; r["name"] = spec
            resolved.append(r)
        else:
            unresolved.append(spec)
    return resolved, unresolved
```

- [ ] **Step 2: Verify via repl** (raw path needs no DWARF table; use `{}`)

```bash
$PY -c "
import swd_tracer as t
res,unres = t._resolve_specs(['@0x50000410:u16#5','@0x50000410:u16#7','@0x50000410:u16#3:0',
                              '@0x50000410:u16&0x820','@0x50000410:u16#99','@0x20000000:u8[4]#0'], {})
for r in res: print(r['name'], hex(r['address']), r['size'], r.get('transform'))
print('UNRESOLVED:', unres)
"
```
Expected: four resolved rows (`#5` bit, `#7` bit, `#3:0` range, `&0x820` mask) all at address 0x50000410 size 2 with their transform dict; UNRESOLVED contains `@0x50000410:u16#99` (bit ≥16) and `@0x20000000:u8[4]#0 (transform on expanding spec unsupported)`. Also confirm a plain spec still works: `t._resolve_specs(['@0x50000410:u16'], {})` → one row, `transform` absent (None via `.get`).

- [ ] **Step 3: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): attach transforms in _resolve_specs; reject on expansion"
```

---

### Task 4: Carry transform through `_coalesce` + apply in the poll loop

**Files:**
- Modify: `tracer/swd_tracer.py` — `_coalesce` (lines 1030-1042) and the poll-loop decode (lines 1250-1251)

**Interfaces:**
- Consumes: `_apply_transform`; signal dicts with optional `"transform"`.
- Produces: `_coalesce` member tuples become 5-element `(name, off, size, enc, transform)`; the poll loop applies the transform after `_decode`. `transform` is `None` for plain signals (pass-through).

- [ ] **Step 1: Extend `_coalesce` member tuples**

In `_coalesce`, change the two member-tuple constructions to carry `s.get("transform")`:
```python
def _coalesce(sigs):
    """sigs: list of {name,address,size,encoding,transform?}.
    Returns [(start,length,[(name,off,size,enc,transform)])]."""
    items = sorted(sigs, key=lambda s: s["address"])
    ranges = []
    for s in items:
        a, ln = s["address"], s["size"]
        if ranges and a <= ranges[-1][0] + ranges[-1][1] + 4:  # merge if within 4 bytes of prev end
            start, length, members = ranges[-1]
            new_end = max(start + length, a + ln)
            ranges[-1] = (start, new_end - start,
                          members + [(s["name"], a - start, ln, s["encoding"], s.get("transform"))])
        else:
            ranges.append((a, ln, [(s["name"], 0, ln, s["encoding"], s.get("transform"))]))
    return ranges
```

- [ ] **Step 2: Apply in the poll loop**

Replace the decode unpack (lines 1250-1251):
```python
                for (name, off, size, enc, transform) in members:
                    v = _decode(data, off, size, enc)
                    if transform is not None:
                        v = _apply_transform(v, size, transform)
                    values[name] = v
```

- [ ] **Step 3: Live verify** (ST-Link attached) — two GPIOB pins as separate 0/1 signals + a range field.

```bash
ELF=/home/matixan/GIT/CrossPad_STM32_r20/build/Debug/CrossPad_STM32_r20.elf
cd /home/matixan/GIT/crosspad-mcp/tracer
{ sleep 3; echo '{"cmd":"stop"}'; } | $PY swd_tracer.py trace --elf $ELF \
  --signals '@0x50000410:u16#5,@0x50000410:u16#7,@0x50000410:u16#3:0' --rate 20 2>/dev/null \
  | grep -E 'signals|sample' | head -4
```
Expected: the `signals` frame lists three signals all at address 0x50000410 (so they coalesce into ONE read — confirm by inspecting the single range in `status` if needed); `sample` frames show `@0x50000410:u16#5` and `@0x50000410:u16#7` as 0 or 1 (not a big port number), and `@0x50000410:u16#3:0` as a 0..15 value. (Plain `@0x50000410:u16` for comparison still returns the full 16-bit word.)

- [ ] **Step 4: Commit**

```bash
git add tracer/swd_tracer.py
git commit -m "feat(trace): apply bit/mask transform in the poll loop (coalesce 5-tuple)"
```

---

### Task 5: Docs — PROTOCOL §1.4 + SKILL.md

**Files:**
- Modify: `tracer/PROTOCOL.md`, `skills/swd-tracer/SKILL.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: PROTOCOL.md — add §1.4 after the existing §1.3**

Read PROTOCOL.md to find the end of §1.3 (the write/call section) and insert before `## 2`:
```markdown
## 1.4 Bit / mask transforms

A spec may end with ONE transform suffix that extracts part of the decoded value
— so e.g. a GPIO port read plots individual pins as 0/1 instead of the full word.
The sigils `#` and `&` do not occur in the §1.1/§1.2 grammar and are stripped
before the base spec is resolved. The transform applies to both symbol and raw
`@address` specs.

| Suffix | Meaning | Result (v = value, unsigned, masked to width) |
|---|---|---|
| `#N` | bit N | `(v>>N)&1` → 0/1 |
| `#hi:lo` | bit range, inclusive, hi≥lo | `(v>>lo)&((1<<(hi-lo+1))-1)` |
| `&0xMASK` | AND mask, normalized to LSB | `(v&mask)>>ffs(mask)` |

Examples: `@0x50000410:u16#5` (pin 5 → 0/1), `@0x50000410:u16#3:0` (low 4 pins as
0..15), `GPIOB_ODR&0x820`, `s_flags#2`. Several bits of one address become
separate, uniquely-named signals that still coalesce into a single memory read.

The transform applies only to a spec that resolves to a SINGLE scalar. A suffix on
an expanding spec (`[*]`, `[a:b]`, a whole array, or a raw block `@a:type[count]`)
is reported in `unresolved` as `"… (transform on expanding spec unsupported)"`. An
out-of-range bit/mask (≥ the access width), `hi<lo`, mask `0`, or a malformed
suffix is also reported unresolved.
```

- [ ] **Step 2: SKILL.md — add rows to the signal-spec table**

Read SKILL.md to find the signal-spec table (the rows ending with `s_inputs[0:8]`) and add after it:
```markdown
| `@0x50000410:u16#5` | **bit 5** of the value → 0/1 (e.g. one GPIO pin) |
| `@0x50000410:u16#3:0` | **bit range** [3:0] → field value 0..15 |
| `GPIOB_ODR&0x820` | **masked** field, normalized to the lowest set bit |

A `#bit` / `#hi:lo` / `&mask` suffix extracts part of the value (works on symbols
and raw `@addr`). Trace several `#bit` specs on the same port to plot each pin
separately as 0/1; they coalesce into one read.
```

- [ ] **Step 3: Commit**

```bash
git add tracer/PROTOCOL.md skills/swd-tracer/SKILL.md
git commit -m "docs(trace): document #bit / #hi:lo / &mask signal transforms"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** §2 syntax → Tasks 1,3; §3 architecture (parse/resolve/coalesce/apply) → Tasks 1-4; §4 validation/expansion-reject → Tasks 1,3; §5 files → all tasks; §6 testing → repl (Tasks 1-3), live (Task 4); §7 YAGNI (no scale/offset, no transform×expansion) → enforced in Task 3.
- **Placeholders:** none. The only `<...>` are the env paths, given explicitly in Global Constraints.
- **Type consistency:** the transform dict shape (`kind`/`n`/`hi`/`lo`/`mask`/`shift`) is produced in Task 1 and consumed unchanged in Tasks 2-4. `_coalesce` 5-tuple `(name,off,size,enc,transform)` is produced in Task 4 Step 1 and unpacked in Task 4 Step 2 — both changed together. `name` keeps the full suffix (Task 3) so `values[name]` keys stay unique in the poll loop (Task 4).
