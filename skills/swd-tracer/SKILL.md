---
name: swd-tracer
description: Use when tracing/plotting STM32 firmware variables in real time over SWD (ST-Link) on the CrossPad r20 board (CrossPad_STM32_r20 repo, STM32G0B1xx), or when the SWD tracer / pyOCD environment needs setting up or repairing. Covers the doctor→config→symbols→start→read/ui→stop workflow, signal-spec syntax (arrays/structs/whole-array expansion), configuring all four environments (pyOCD venv, user config paths, ST-Link udev rules, the Debug ELF), and recovering from no-probe / wedged-probe / halted-core / MCU-STOP conditions. The MCP tool is `crosspad_trace`.
---

# CrossPad SWD real-time tracer

Live, **non-halting** plotting of firmware variables read straight from MCU RAM
over an ST-Link, à la ST-Studio / CubeMonitor — but driven by the agent. The MCP
server already lists *which* tools exist; this skill encodes *how* to set the
tracer up and drive it, and how to recover when the probe misbehaves.

**Target:** CrossPad r20 = **STM32G0B1xx (Cortex-M0+)** firmware in the
`CrossPad_STM32_r20` repo. Variables are resolved from the **Debug ELF** DWARF;
pyOCD polls their RAM addresses while the core keeps running. (Cortex-M0+ has no
ITM/SWO/DWT, so SWO/ITM "printf" is impossible — RAM polling is the mechanism.)

All operations go through one MCP tool, `crosspad_trace`, via its `action`:
`doctor · config_set · symbols · start · add · remove · status · read · save ·
device_state · ui · stop`.

## First move: always `doctor`

```
crosspad_trace action=doctor
```

It reports `issues[]` and whether a probe is connected. Resolve blocking issues
(below) before `start`. If you're unsure what's configured, also run the
read-only environment probe:

```
bash scripts/detect-env.sh
```

The helper scripts are bundled next to this SKILL.md in `scripts/`. Resolve them
relative to the skill directory — e.g. `~/.claude/skills/swd-tracer/scripts/…`
(global skill) or `<crosspad-mcp>/skills/swd-tracer/scripts/…` (repo / plugin).

## Configuring the four environments

The tracer needs four things in place. `doctor` / `detect-env.sh` tell you which
are missing; fix only those.

1. **pyOCD venv** — the daemon runs in a Python venv (system Python is usually
   PEP-668 locked). Create it and point config at it:
   ```
   bash scripts/setup-venv.sh
   crosspad_trace action=config_set key=pyocd_python value=$HOME/.local/share/crosspad-mcp/venv/bin/python
   ```
2. **User config paths** — persisted to `~/.config/crosspad-mcp/config.json`.
   Keys: `stm_elf_path` (the Debug ELF), `pyocd_python`, `probe_serial`
   (optional; only if multiple ST-Links), `trace_dir` (where `.cptrace`/CSV go).
   ```
   crosspad_trace action=config_set key=stm_elf_path value=<repo>/build/Debug/CrossPad_STM32_r20.elf
   ```
3. **ST-Link udev rules** (Linux) — needed for libusb access without root:
   ```
   bash scripts/install-udev-rules.sh   # sudo; then replug the ST-Link
   ```
4. **Debug ELF with symbols** — build it in the firmware repo so DWARF exists:
   ```
   cmake --preset Debug && cmake --build build/Debug
   ```

Resolution order for every config value: `config.json` → env var → default. So
`config_set` wins; `CROSSPAD_STM_ELF` / `CROSSPAD_TRACE_PYTHON` /
`CROSSPAD_PROBE_SERIAL` / `CROSSPAD_TRACE_DIR` are fallbacks.

## The trace loop

```
doctor                       → green? continue
symbols [query=…]            → discover variable names (rich metadata: kind/dims/members)
start signals=[…] rate_hz=N  → spawns the daemon + opens the localhost UI
ui                           → get the http://localhost:7373/ dashboard URL
read [max_points] [window_…] → downsampled series + per-signal stats (cheap; LLM-safe)
add / remove signals=[…]     → edit the watched set on a LIVE trace (no restart)
status                       → device_state, sample_count, actual_fs, signals
save                         → export buffer to CSV
stop                         → end the trace (always frees the probe)
```

`rate_hz=0` means "as fast as the probe allows"; the real rate comes back as
`actual_fs` (ST-Link V2 + pyOCD tops out ~480 Hz total across all ranges).
Fewer/contiguous signals = higher Fs.

## Signal-spec syntax

| Form | Resolves to |
|---|---|
| `s_vbat_mv` | a scalar global/static |
| `s_inputs[3]` | array element (bounds-checked against the DWARF length) |
| `mat[1][2]` | multi-dim element |
| `hpcd.Init.speed` | nested struct member |
| `s_adc_raw` / `s_adc_raw[*]` | **whole array** → expands to every element |
| `s_inputs[0:8]` | half-open slice → elements 0..7 |

Expansion is capped at 256 elements. A spec that lands on an aggregate (struct
with no trailing index) is reported as `unresolved`, not fatal. See
[reference/signals.md](reference/signals.md) for the CrossPad-specific cheat sheet
(pads, ADC channels, and the built-in `g_trace_demo.*` self-test signals).

## Quick self-test (no real inputs needed)

If the firmware includes the demo module, `g_trace_demo.demo_sine` draws a clean
sine — the fastest "is the whole pipeline alive?" check:
```
crosspad_trace action=start signals=["g_trace_demo.demo_sine","g_trace_demo.tick"] rate_hz=200
crosspad_trace action=read max_points=50
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `doctor` → `no_probe_detected` | ST-Link not on USB. Plug it in. If it *vanished* mid-session (gone from `lsusb`), a prior wedge knocked it off — **physically replug** it; software can't revive it. |
| `start` returns `device_state: error: no debug probe detected` | Same — replug, re-run `doctor`. |
| `start` → `device_state: connect_timeout` / daemon exits | Probe wedged in libusb. The daemon fails fast (≤8 s) + exits now; replug and retry. |
| Values frozen / every signal a flat line | Core was **halted** on connect. The daemon uses `connect_mode=attach` to avoid this; if you see it, the firmware itself may be in a fault/STOP. Check `device_state`. |
| `device_state: stop_suspected` then `probe_lost` | MCU entered STOP (RAM unreadable) or the probe dropped. Brief STOP recovers automatically; persistent (>10 s) → daemon reports `probe_lost` and exits. |
| Out-of-bounds index silently "works" | It no longer does — `s_adc_raw[31]` on a `[15]` array is rejected. Use `symbols` to see real `dims`/`count`. |
| Deep STOP / low-power analysis | `crosspad_trace action=device_state` dumps PWR/RCC/SCB regs + decodes SLEEPDEEP/LPMS. |
| Permission/USB errors despite `lsusb` showing it | Missing udev rules — run `install-udev-rules.sh`, replug. |
| Daemon won't die / port stuck | `stop` now escalates SIGTERM→SIGKILL and tears down the UI first; if a stale daemon lingers, `pkill -9 -f swd_tracer.py`. |

## Notes

- The web UI is loopback-only (127.0.0.1) and lives only while a trace runs.
- `start` waits for the daemon's first frame and reports the *real* state
  (`running` / `connecting` / `error`), not an optimistic guess.
- One active trace per server — `stop` before starting a different signal set,
  or use `add`/`remove` to edit the live set.
