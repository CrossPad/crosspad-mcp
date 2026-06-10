# CrossPad SWD Tracer Daemon

A single-file Python daemon (`swd_tracer.py`) that communicates with the CrossPad STM32 target over SWD using pyOCD. The Node MCP server drives this daemon as a subprocess.

## Output contract

- **stdout**: machine-readable JSON only — one JSON object per invocation.
- **stderr**: human-readable logs, progress, and error messages only.

Never mix JSON output with log lines on stdout. The Node bridge scans stdout for the JSON line and ignores everything else.

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
| `size` | number | Byte size of the variable (or total array size). |

Results are de-duplicated and sorted by address.

Example — query `s_vbat_mv`:

```bash
/path/to/venv/bin/python swd_tracer.py symbols \
  --elf ~/GIT/CrossPad_STM32_r20/build/Debug/CrossPad_STM32_r20.elf \
  --query s_vbat_mv
# stdout: {"symbols": [{"name": "s_vbat_mv", "address": 536885450, "encoding": "uint", "size": 2}]}
```

## Future subcommands

More subcommands are planned for later milestones:

- **`trace`** — start a live SWD memory poll loop, streaming JSON events to stdout.
- **`device-state`** — one-shot snapshot of key device registers and variable values.
