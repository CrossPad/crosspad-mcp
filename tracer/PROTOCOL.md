# CrossPad SWD tracer — wire protocol v2

Single source of truth shared by the Python daemon (`tracer/swd_tracer.py`), the
Node session/webui layer (`src/tools/trace-*.ts`), and the browser UI
(`tracer/ui/index.html`). v2 adds **runtime-editable watching** (add/remove
signals on a live trace) and richer **signal-spec resolution**.

**v2.1 additions** (this revision): whole-array / vector / matrix **expansion**
(§1.1), richer **symbol metadata** for UI autocomplete (§8), a `/symbols` HTTP
endpoint (§9), and a hard rule that `add`/`remove` return the **post-reconcile**
signal set (§4, §6) and that **Fs is reported ONCE globally** (§10).

All daemon I/O is NDJSON — one JSON object per line. stdout = machine frames,
stderr = human logs only.

## 1. Signal spec grammar (resolved from the Debug ELF DWARF)

A *signal spec* names a memory location to poll. Supported syntax:

| Form | Meaning |
|---|---|
| `name` | global / static variable (base type, struct, or array) |
| `name[i]` | array element (existing) |
| `name[i][j]` | multi-dimensional array element |
| `name.member` | struct / union member |
| `name.a.b` | nested member chain |
| `name[i].member` / `name.member[j]` | any mix of `[index]` and `.member` |

Resolution walks DWARF: base symbol → `DW_AT_type`; `[i]` consumes an
`DW_TAG_array_type` dimension (stride = element byte size, multi-dim handled via
successive `DW_TAG_subrange_type`); `.member` consumes a `DW_TAG_structure_type`/
`DW_TAG_union_type` member (offset = `DW_AT_data_member_location`). The final
node must resolve to a scalar (`DW_TAG_base_type`, pointer, or enum) — a spec
that lands on an aggregate is **unresolved** UNLESS it expands (see §1.1).
Result: `{name: <original spec>, address, size, encoding}`.

## 1.1 Whole-array / vector / matrix expansion

A spec that lands on (or leaves trailing) an array dimension **expands** into one
concrete scalar spec per element instead of being unresolved:

| Form | Expands to |
|---|---|
| `vec` (bare array name, element scalar) | `vec[0]`, `vec[1]`, … `vec[N-1]` |
| `vec[*]` | same as bare — all elements of that dimension |
| `vec[a:b]` | half-open slice `vec[a]` … `vec[b-1]` |
| `mat` (2-D array of scalar) | every cell `mat[0][0]` … `mat[R-1][C-1]` (row-major) |
| `mat[*][k]` / `mat[i][*]` | the selected row/column |
| `arr.field` where `arr` is array-of-struct | `arr[0].field` … (array dim before a member also expands) |

Expanded element names use the concrete `name[i]` / `name[i][j]` form so the
buffer/UI see distinct scalars. **Cap:** an expansion exceeding **256** elements
is skipped and reported in the `signals` frame's `unresolved` as
`"<spec> (expands to <N> > 256)"`. A spec landing on a struct/union (no trailing
array) is still unresolved. Expansion is computed daemon-side (DWARF knows the
bounds) for both the initial `--signals` set and live `add` commands.

`encoding ∈ {int, uint, float, bool, char, uchar, address}`.

## 1.2 Raw absolute-address specs

A spec beginning with `@` reads MCU memory **straight by address**, bypassing
DWARF entirely — for peripheral registers (e.g. `GPIOA->IDR`, `RCC->CR`) or any
RAM the ELF has no symbol for. Because there is no type to infer width/encoding
from, the type tag is explicit (default `u32`):

| Form | Reads |
|---|---|
| `@0x40021000` | one u32 at `0x40021000` |
| `@0x50000010:u16` | one u16; type ∈ `u8 u16 u32 i8 i16 i32 f32` |
| `@0x20000000:u8[16]` | 16 consecutive elements (expands like an array; same **256** cap) |

A single-element raw spec keeps your exact text as its signal name; an expanded
block re-renders each element as `@0x<addr>:<type>` so names stay unique. A
malformed raw spec (bad address/type/count) is reported in `unresolved`.

**Caution:** reads go over the AHB while the core runs. Reading a register with
read-side-effects (a peripheral data register that clears a flag on read, FIFO
pops, etc.) will perturb firmware — point raw specs at status/config registers,
not at volatile data registers, unless you intend the side effect.

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
| `&0xMASK` | AND mask, normalized to LSB | `(v&mask)>>ctz(mask)` |

(ctz = count trailing zeros, i.e. the 0-based index of the lowest set bit)

Examples: `@0x50000410:u16#5` (pin 5 → 0/1), `@0x50000410:u16#3:0` (low 4 pins as
0..15), `GPIOB_ODR&0x820`, `s_flags#2`. Several bits of one address become
separate, uniquely-named signals that still coalesce into a single memory read.

The transform applies only to a spec that resolves to a SINGLE scalar. A suffix on
an expanding spec (`[*]`, `[a:b]`, a whole array, or a raw block `@a:type[count]`)
is reported in `unresolved` as `"… (transform on expanding spec unsupported)"`. An
out-of-range bit/mask (≥ the access width), `hi<lo`, mask `0`, or a malformed
suffix is also reported unresolved.

## 2. Daemon stdin commands (Node → daemon, NDJSON)

```jsonc
{"cmd":"stop"}                              // graceful shutdown (existing)
{"cmd":"add","signals":["s_vbat_mv","s_inputs[3]"]}   // add to live poll set
{"cmd":"remove","signals":["s_inputs[3]"]}            // drop from live poll set
```

- `{"cmd":"write","id":N,"writes":["@0x..=v", ...]}` → emits
  `{"type":"write_result","id":N,"ok":bool,"results":[{name,address,size,ok,old,new,error?}]}`.
- `{"cmd":"call","id":N,"func":"name","args":[...],"confirm":true,"ret_type":"u32","timeout":2.0}`
  → emits `{"type":"call_result","id":N,"ok":bool,"r0":int,"decoded"?:num,"error"?:str}`.

`add`/`remove` mutate the poll set on the running daemon. The poll loop
re-coalesces ranges on the next iteration. Unknown / unresolvable specs in an
`add` are skipped (reported via a `signals` frame's `unresolved`), never fatal.
`remove` of an unknown name is a no-op.

## 3. Daemon stdout frames (daemon → Node, NDJSON)

```jsonc
// emitted once right after connect, AND after every successful add/remove:
{"type":"signals","signals":[{"name","address","size","encoding"}],"unresolved":["..."]}

{"type":"sample","t":<seconds float>,"values":{"<name>":<number>, ...}}
{"type":"status","device_state":"stop_suspected|stopped|...","t"?,"samples"?}
{"type":"error","error":"<message>"}
```

`values` only contains the currently-watched signals; after an add the next
sample includes the new names, after a remove they disappear.

## 4. Node TraceSession API (TS)

- `addSignals(string[]): Promise<string[]>` — writes `{"cmd":"add",...}` to
  daemon stdin and resolves with the **post-reconcile** signal-name set once the
  next `{"type":"signals"}` frame arrives (timeout ~2 s → resolves with the
  current `buffer.signalNames()`). This kills the old race where the immediate
  return showed the pre-reconcile set.
- `removeSignals(string[]): Promise<string[]>` — same, for remove.
- On a `{"type":"signals"}` frame: reconcile `buffer` signal set
  (`buffer.addSignal`/`removeSignal`) and forward the frame to `onFrame`
  subscribers (so the WS rebroadcasts the new set to browsers), then resolve any
  pending add/remove promise.
- `TraceBuffer` gains `addSignal(name)` / `removeSignal(name)` updating
  `signalNames()`. Stored samples already key values by name, so history of a
  removed signal stays until it ages out of the ring.

## 5. Node TraceWebUi — bidirectional WS

- Inbound browser → server messages (JSON): `{"cmd":"add"|"remove","signals":[...]}`.
  Validate shape + cmd; forward to `session.addSignals/removeSignals`. Keep the
  loopback-Origin check. Ignore malformed messages silently.
- Outbound server → browser: forwards every daemon frame (`sample`, `status`,
  `error`, **`signals`**) plus the initial `{"type":"hello","signals":[...]}`.

## 6. MCP tool (`crosspad_trace`) actions

- `add` / `remove`: require an active session; `await` the session promise and
  return the **post-reconcile** `signals` (so the MCP response matches reality,
  including any array expansion and dropped `unresolved` specs).
- `symbols`: return the richer metadata of §8.
- All other actions unchanged.

## 7. Browser UI (talks §3/§5 over WS)

Receives `hello` → `signals` (live set updates) → `sample`/`status`. Sends
`add`/`remove`. Fetches `/symbols` (§9) for autocomplete. UI feature scope is
owned by the UI implementer; the hard contracts are the WS message shapes, the
`/symbols` shape (§8), and §10 (Fs shown once).

## 8. Symbol metadata (richer `symbols` output — for autocomplete)

The daemon `symbols` subcommand and the `/symbols` endpoint return, per symbol,
in ADDITION to the existing `{name, address, encoding, size}`:

```jsonc
{
  "name": "s_adc_raw", "address": ..., "encoding": "uint", "size": 64,
  "kind": "array",            // "scalar" | "array" | "struct" | "union" | "other"
  "dims": [32],               // array only: per-dimension element counts
  "count": 32,                // array only: total elements (product of dims)
  "elem_size": 2,             // array only: one element's byte size
  "elem_encoding": "uint",    // array only: element scalar encoding
  "members": ["a","b"]        // struct/union only: member names (one level)
}
```

`kind`/`dims`/`count`/`elem_*`/`members` are best-effort and may be omitted for
`other`. Back-compat: old consumers that read only `{name,address,encoding,size}`
keep working. The UI uses this to suggest base names, `name[i]`/`name[*]` for
arrays, and `name.member` for structs.

## 9. `/symbols` HTTP endpoint (browser → Node)

`GET /symbols[?query=substr]` on the same loopback origin as the UI returns
`{"symbols":[ ... §8 entries ... ]}` (Content-Type `application/json`). The
webui obtains it via the existing Node `listSymbols()` bridge against the active
session's ELF. Loopback-bound like the rest of the UI server.

## 10. Fs is reported ONCE, globally

Sample rate (Fs / actual_fs) is a property of the **whole trace**, not per
signal — every signal is sampled in the same poll loop. So Fs must be shown in
exactly ONE place (a single global readout / one `actual_fs` field), never
duplicated into each per-signal stats row. Per-signal stats keep value-domain
metrics only (min/max/mean/p2p/RMS/n/slope); the shared Fs lives outside them.

## 11. Robustness contract (v2.2 — fail fast, never wedge)

The probe (ST-Link V2) can vanish from USB or wedge libusb after an unclean
session. The tracer MUST fail fast and surface it, never hang or require
`pkill -9`. Hard rules:

### 11.1 Daemon connect
- `session_with_chosen_probe` is called with `blocking=False, return_first=True`
  so a **missing probe returns immediately** → emit
  `{"type":"error","error":"no debug probe detected (replug ST-Link)"}` and exit
  code 3.
- Creating + opening the session runs inside a **watchdog thread** bounded by
  `--connect-timeout` (default 8 s). If it does not complete in time the worker
  is wedged in uninterruptible C (libusb) — flush an
  `{"type":"error","error":"connect timeout after Ns (probe wedged? replug)"}`
  frame and `os._exit(2)`. The main process dies; the OS reclaims the wedged
  thread. This is the ONLY correct recovery for a libusb wedge.
- Any other connect exception → `{"type":"error","error":...}` + exit 1.
- Applies to BOTH `trace` and `device-state` (device-state uses a shorter 6 s).

### 11.2 Daemon run-loop disconnect
- A read fault emits `{"type":"status","device_state":"stop_suspected"}` as
  before, BUT the daemon now tracks fault duration. If faults persist longer
  than `--lost-timeout` (default 10 s) it emits
  `{"type":"error","error":"probe/target lost (persistent read fault Ns)"}` and
  exits — instead of looping `stop_suspected` forever. A successful read resets
  the fault timer (a genuine MCU STOP that resumes keeps tracing).

### 11.3 ELF / DWARF guard
- `build_symbol_table` / symbol resolution is wrapped: a bad/missing ELF emits
  `{"type":"error","error":...}` (not a raw traceback) and the daemon exits.

### 11.4 device_state vocabulary
`connecting` (before first frame) · `running` · `stop_suspected` · `probe_lost`
· `connect_timeout` · `stopped` · `error: <msg>` · `exited`.

### 11.5 Node teardown — guaranteed kill
`TraceSession.stop()`: write `{"cmd":"stop"}`, then `SIGTERM` after ~1.5 s, then
**`SIGKILL` after a further ~3 s if the process is still alive** (a wedged daemon
ignores SIGTERM). Always tear down the web UI first (existing behavior).

### 11.6 Node diagnostics + start truthfulness
- The daemon's **stderr is captured** (ring of the last ~30 lines), exposed as
  `session.stderrTail()` and folded into the device_state/error surfaced by the
  MCP `status`/`start`.
- MCP `start` **waits up to ~3 s for the first frame** (`signals`|`sample`|
  `error`) and returns a device_state reflecting reality
  (`running` vs `connect_timeout` vs `error: …`) instead of an optimistic
  `running` that masks a dead connect.
- If the daemon exits non-zero with no error frame, `device_state` becomes
  `error: <stderr tail>`.

### 11.7 Doctor probe presence
`doctor` runs a real probe-presence check (`pyocd list` via the daemon python,
or `st-info --probe`) and reports a **blocking** issue
`no_probe_detected` when none is connected (distinct from the udev warning).
`start` refuses (clear error) when doctor reports `no_probe_detected`.

## 12. Persistent dashboard + reconnect + auto-open (v2.3)

The dashboard must feel permanent: open it once (ideally as a VS Code **Simple
Browser** tab) and it survives every trace start/stop without going dead.

### 12.1 Persistent UI server (decoupled from the session)
- The web UI HTTP+WS server is a **module-level singleton that OUTLIVES trace
  sessions** — `stop` ends the daemon but the server keeps listening. A
  browser/VS Code tab stays connected across start→stop→start cycles.
- The singleton holds a mutable `currentSession`. `start` binds the new session
  (subscribes to its frames); `stop` unbinds (server goes idle but stays up).
- `TraceSession.stop()` no longer tears the UI down; the singleton owns the
  server lifecycle. The port (7373) is therefore stable across traces.

### 12.2 WS messages — new server→client
- `hello` gains fields: `{"type":"hello","active":bool,"signals":[...]}`.
- `{"type":"trace_start","signals":[...]}` — a new trace began; UI resets and
  starts plotting the new set.
- `{"type":"trace_end"}` — the trace stopped; UI keeps the last data but shows an
  idle/"waiting for next trace" state. The WS stays connected (server is up).
- `sample`/`status`/`error`/`signals` continue, scoped to the bound session.

### 12.3 `/symbols` when idle
With no active session, `/symbols` falls back to the **configured default ELF**
so autocomplete keeps working between traces.

### 12.4 Auto-open on `start` (unless already open)
On `start`, after ensuring the singleton server is up, open the dashboard in the
user's browser **only if no WS client is currently connected** (i.e. it isn't
already open — covers both an external browser and a VS Code Simple Browser tab).
Platform opener (`xdg-open`/`open`/`start`), detached, best-effort, never throws.
Skip when headless (no `DISPLAY`/`WAYLAND_DISPLAY` on Linux) or when
`CROSSPAD_TRACE_NO_BROWSER` is set. Because the server persists, a VS Code tab
opened once stays connected, so auto-open never re-pops it.

### 12.5 UI reconnect
The UI has a visible **Reconnect** button AND an automatic reconnect loop (with
backoff) that survives server restarts and `trace_end`. Idle shows "waiting for
trace…"; `trace_end` shows a "trace ended" banner; reconnect re-establishes the
WS and re-syncs the signal set from the fresh `hello`.
