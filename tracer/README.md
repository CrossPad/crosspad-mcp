# CrossPad SWD Tracer Daemon

A single-file Python daemon (`swd_tracer.py`) that communicates with the CrossPad STM32 target over SWD using pyOCD. The Node MCP server drives this daemon as a subprocess.

## Output contract

- **stdout**: machine-readable JSON/NDJSON only — one JSON object per line.
- **stderr**: human-readable logs, progress, and error messages only.

Never mix JSON output with log lines on stdout. The Node bridge scans stdout for JSON lines.

## Dependencies

```
pip install pyocd pyelftools
```

### Recommended: use a dedicated venv

```bash
python3 -m venv ~/.local/share/crosspad-mcp/venv
~/.local/share/crosspad-mcp/venv/bin/pip install pyocd pyelftools
```

Then set the `pyocd_python` key in `~/.config/crosspad-mcp/config.json` to point at the venv interpreter:

```json
{
  "pyocd_python": "/home/<you>/.local/share/crosspad-mcp/venv/bin/python"
}
```

This prevents conflicts with system or project Python environments. The MCP server also honours the `CROSSPAD_TRACE_PYTHON` environment variable as an override.

## Subcommands

### `symbols` — resolve firmware variables from DWARF

Reads an ELF built with debug info (`-g`) and emits a JSON object listing every fixed-address variable (globals and `static` locals) found in the DWARF info.

```bash
python swd_tracer.py symbols --elf <path/to/firmware.elf> [--query <substring>]
```

Options:

| Flag | Description |
|---|---|
| `--elf PATH` | Path to the Debug ELF (required). Must contain DWARF info. |
| `--query STR` | Case-insensitive substring filter on the symbol name (optional). |

Output (stdout):

```json
{"symbols": [
  {"name": "s_vbat_mv",    "address": 536885450, "encoding": "uint", "size": 2},
  {"name": "s_vbus_stm_mv","address": 536885448, "encoding": "uint", "size": 2}
]}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | Symbol name as it appears in DWARF. |
| `address` | number | Absolute RAM address (decimal integer). |
| `encoding` | string | Base-type encoding: `uint`, `int`, `uchar`, `char`, `bool`, `float`, `address`. |
| `size` | number | Byte size of the variable (or total array size for arrays, element size for indexed access). |

Results are de-duplicated and sorted by address.

Example — query `s_vbat_mv`:

```bash
/path/to/venv/bin/python swd_tracer.py symbols \
  --elf ~/GIT/CrossPad_STM32_r20/build/Debug/CrossPad_STM32_r20.elf \
  --query s_vbat_mv
# stdout: {"symbols": [{"name": "s_vbat_mv", "address": 536885450, "encoding": "uint", "size": 2}]}
```

---

### `trace` — live SWD poll loop (non-halting)

Connects to the target via pyOCD, polls the requested signals by reading RAM while the core continues to run, and emits one NDJSON frame per sample on stdout. Optionally writes a `.cptrace` file. Stops when `{"cmd":"stop"}` is received on stdin.

```bash
python swd_tracer.py trace \
  --elf <firmware.elf> \
  --signals <sig1,sig2,...> \
  [--rate <Hz>] \
  [--out <file.cptrace>] \
  [--probe <unique_id>]
```

#### Options

| Flag | Default | Description |
|---|---|---|
| `--elf PATH` | (required) | Debug ELF for DWARF symbol resolution. |
| `--signals LIST` | (required) | Comma-separated signal names (see below). |
| `--rate HZ` | `0` (max) | Target poll rate in Hz. `0` means poll as fast as possible. |
| `--out PATH` | `None` | If given, also append samples to a `.cptrace` binary file. |
| `--probe UID` | `None` | ST-Link unique ID string; omit to auto-select the first probe. |

#### Signal name syntax — `name[index]`

Signal names may include an array index: `s_inputs[0]`, `s_adc_raw[3]`.

Resolution rules:
1. Parse `base` and optional `[index]` from the spec.
2. Look up `base` in the DWARF symbol table (exact match).
3. `address = base.address + index * base.size` (element size from DWARF).
4. A plain `name` (no brackets) resolves directly.
5. Unknown `base` → an `error` frame is emitted and the command exits.

Example: if `s_inputs` is at address `0x20001000` with element size 1, then `s_inputs[3]` resolves to address `0x20001003`.

#### NDJSON output frames (stdout)

One JSON object per line. Three frame types:

**`sample`** — one reading of all polled signals:

```json
{"type": "sample", "t": 0.012345, "values": {"s_vbat_mv": 3742, "s_inputs[0]": 255}}
```

| Field | Description |
|---|---|
| `type` | `"sample"` |
| `t` | Seconds since trace start (float, 6 decimal places). |
| `values` | Object mapping each signal spec to its decoded integer or float value. |

**`status`** — device or session state change:

```json
{"type": "status", "device_state": "stop_suspected", "t": 1.234}
{"type": "status", "device_state": "stopped", "samples": 1234}
```

| `device_state` | Meaning |
|---|---|
| `stop_suspected` | A memory read faulted — the STM32 is probably in STOP mode. Polling pauses 200 ms and resumes. No halt is issued. |
| `stopped` | Normal exit after receiving `{"cmd":"stop"}`. `samples` field holds total sample count. |

**`error`** — fatal signal resolution failure:

```json
{"type": "error", "error": "unknown symbols: bad_name,also_bad"}
```

Emitted and the process exits if any requested signal cannot be found in the DWARF symbol table.

#### Stopping the daemon

Write `{"cmd":"stop"}` followed by a newline to the daemon's stdin:

```bash
echo '{"cmd":"stop"}' | <daemon process stdin>
```

The daemon drains the current poll iteration, closes the `.cptrace` file if open, disconnects from the probe, and emits a final `status/stopped` frame before exiting.

#### `.cptrace` file format

Binary-framed header followed by line-delimited JSON body rows.

```
Offset  Size  Content
0       4     Magic: ASCII "CPTR"
4       4     Header length N (little-endian uint32)
8       N     JSON signal list: {"signals":[{"name":…,"encoding":…,"size":…},…]}
8+N     …     Body rows, one per sample, each: JSON{"t":…,"v":{…}}\n
```

The binary header allows fast seeking to the body start and easy validation. Body rows are line-JSON for simplicity and recoverability (a partial write is still parseable up to the last complete line).

#### Example

```bash
/path/to/venv/bin/python swd_tracer.py trace \
  --elf ~/GIT/CrossPad_STM32_r20/build/Debug/CrossPad_STM32_r20.elf \
  --signals s_vbat_mv,s_inputs[0],s_inputs[1] \
  --rate 100 \
  --out /tmp/session.cptrace \
  2>/tmp/trace.log &
DAEMON_PID=$!

# ... let it run for a few seconds ...

echo '{"cmd":"stop"}' >&${DAEMON_PID}_stdin
```

stdout while running:

```
{"type": "sample", "t": 0.000012, "values": {"s_vbat_mv": 3742, "s_inputs[0]": 255, "s_inputs[1]": 0}}
{"type": "sample", "t": 0.010034, "values": {"s_vbat_mv": 3741, "s_inputs[0]": 255, "s_inputs[1]": 0}}
...
{"type": "status", "device_state": "stopped", "samples": 200}
```

---

### `device-state` — deep low-power / STOP register dump (non-halting)

Reads a fixed set of STM32G0 / Cortex-M debug-bus registers and decodes key low-power bits to characterise whether the core is in run/sleep or STOP without auto-waking it (no halt, no DBGMCU debug-in-stop bits required).

```bash
python swd_tracer.py device-state [--probe UID] [--target cortex_m]
```

Options:

| Flag | Default | Description |
|---|---|---|
| `--probe UID` | `None` | ST-Link unique ID string; omit to auto-select the first probe. |
| `--target` | `cortex_m` | pyOCD target override. `cortex_m` (generic) is sufficient — no CMSIS pack needed for plain register reads. |

Registers read (`accessible` is `false` if any read faults — which itself indicates the core is in deep STOP):

| Register | Address | Description |
|---|---|---|
| `PWR_CR1` | `0x40007000` | Power control 1 — `LPMS[2:0]` low-power mode select |
| `PWR_SR1` | `0x40007010` | Power status 1 |
| `RCC_CR` | `0x40021000` | RCC clock control — HSI/PLL on bits |
| `RCC_CFGR` | `0x40021008` | RCC clock configuration |
| `SCB_SCR` | `0xE000ED10` | System Control Register — `SLEEPDEEP` bit (bit 2) |
| `DBGMCU_CR` | `0x40015804` | Debug MCU configuration |

Decoded fields:

| Field | Type | Description |
|---|---|---|
| `SLEEPDEEP` | bool | `true` if `SCB_SCR[2]` is set — the next WFI/WFE will enter a deep sleep / STOP mode. |
| `LPMS` | int (0-7) | Low-power mode select from `PWR_CR1[2:0]`. |
| `interpretation` | string | `"run/sleep"` when `SLEEPDEEP=false`; `"STOP/low-power likely"` when `true`. |

Output example (device running normally):

```json
{"type": "device_state", "regs": {"PWR_CR1": 776, "PWR_SR1": 0, "RCC_CR": 62915840, "RCC_CFGR": 18, "SCB_SCR": 0, "DBGMCU_CR": 0}, "decoded": {"SLEEPDEEP": false, "LPMS": 0, "interpretation": "run/sleep"}, "accessible": true}
```

The MCP tool exposes this as `crosspad_trace` with `action="device_state"` — it calls this subcommand and returns the `regs` and `decoded` objects in the response.

---

### EXPERIMENTAL: SWO / ITM channel decode

> **Status: EXPERIMENTAL — opt-in only, UNTESTED against a real ITM source.**
> The current CrossPad firmware does NOT emit ITM data on the SWO pin.
> This feature exists for future use when firmware-side ITM instrumentation is added.

#### What it does

When `--swo` is passed, the daemon additionally starts a pyOCD `SWVReader` background thread that reads raw SWO bytes from the probe, passes them through the `SWOParser`, and captures the decoded ITM stimulus-port values in a per-port accumulator.  On each poll cycle the latest captured value for each mapped port is merged into the `values` object of the outgoing sample frame alongside the normal RAM-polled signals.

#### Syntax

```
--swo PORT:NAME[,PORT:NAME,...]
```

Each token maps an ITM stimulus port number to a signal name that will appear in the `values` field of each `sample` frame.

Examples:
```bash
# Map ITM port 0 → "dbg_phase", port 1 → "isr_us"
python swd_tracer.py trace \
  --elf firmware.elf \
  --signals s_vbat_mv \
  --swo 0:dbg_phase,1:isr_us \
  --rate 100
```

The MCP tool exposes this as:
```json
{ "action": "start", "signals": ["s_vbat_mv"], "swo": ["0:dbg_phase", "1:isr_us"] }
```

#### Additional flags (SWO path only)

| Flag | Default | Description |
|---|---|---|
| `--cpu-hz` | `64000000` | Core clock frequency in Hz for SWO baud derivation. **Must match the actual firmware clock.** CrossPad r20 runs at 64 MHz; confirm in the `.ioc` / CubeMX clock config. |
| `--swo-hz` | `2000000` | Desired SWO output baud in Hz. **Must match `TPIU_ACPR` configured in the firmware.** |

These are kept at daemon-level defaults and are not currently plumbed through the MCP `swo[]` input (they can be added when there is a real firmware source to test against).

#### Fail-soft behaviour

If SWV initialisation fails (e.g. the probe does not support SWO, the target lacks ITM/TPIU, or the SWO clock cannot be set), the daemon logs a message to stderr and continues with plain RAM polling — it never crashes.  ITM ports that receive no data simply produce no entry in `values` for that cycle.

#### pyOCD 0.44 API note

`SWVReader.init(sys_clock, swo_clock, console:TextIO) -> bool` — the console parameter is accepted for text output but the ITM sink is injected by re-connecting the internal `SWOParser` to our `_ITMValueSink` after `init()` returns.

---

#### pyOCD target name note

The daemon defaults to `--target cortex_m`, the generic Cortex-M target built into
pyOCD. It needs **no CMSIS pack** and is sufficient for everything this tool does
(non-halting RAM polling + the absolute-address register reads in `device-state`).
This default is verified working on an ST-Link V2 + STM32G0Bx.

A part-specific target is **optional** — only needed if you want pyOCD's
part-aware features (flash programming, named peripherals, ITM/TPIU descriptors
for SWO). To use one, install the Keil DFP pack and pass the part name:

```bash
pyocd pack install Keil.STM32G0xx_DFP
pyocd pack find g0b1            # list available part names
# then, e.g.:
swd_tracer.py trace ... --target stm32g0b1retx
```

The RETx variant matches CrossPad r20; substitute the CB/CC/CE part if your flash
size differs.
