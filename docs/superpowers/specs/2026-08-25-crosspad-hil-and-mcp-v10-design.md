# crosspad-hil + crosspad-mcp v10 — design

Date: 2026-08-25
Status: draft for review
Scope: two deliverables — a new repo **`CrossPad/crosspad-hil`** (Python library + CLI + daemon, usable with no AI at all) and **crosspad-mcp v10** (the MCP server rebuilt around it).

Inputs: crosspad-mcp v9.3.0 source and `todo.md` (8 hardening rounds done), `docs/llm-tool-design-audit-2026-07.md`, `platform-idf/main/hil_control.cpp` (authoritative CDC verb set), `platform-idf/tools/hil_*.py` (15 scripts, 15 copies of the same helpers), `crosspad-pc/src/remote/RemoteControl.cpp`, MCP spec 2025-11-25 (what `@modelcontextprotocol/sdk` 1.29 implements) and 2026-07-28 (where it is going), and the design traits of Playwright MCP, Chrome DevTools MCP, GitHub MCP, Serena, qarnet/serial-mcp, PlatformIO MCP, embedded-debugger-mcp, ha-mcp.

---

## 1. Goals, non-goals, principles

### Goals

1. **One source of truth for talking to a CrossPad.** Every hardware trap (DTR/RTS reboots the ESP, `OK` is not your ack, CDC vanishes in UAC2 mode, `0x19 01` from a host hangs `uartLoop`, replies only on the ESP MIDI port) is encoded once, in `crosspad-hil`, and inherited by the CLI, the HIL scenarios and the MCP server alike.
2. **Usable without AI.** A developer who never opens an MCP client gets `crosspad-hil devices`, `crosspad-hil console --expect …`, `crosspad-hil run smoke --json` — the whole test suite as a pip-installable CLI with stable exit codes and JSON output.
3. **Three personas, one server.**
   - *Firmware dev — low-level debugging*: console ring buffer with parsers, `diagnose_crash` evidence bundle (reset reason + decoded backtrace + heap + context), typed `MEM`/`MEM_BLOCKS`/`CDC_STATS`/`BLE_STATUS`, SWD trace (exists), clangd-backed symbol tools.
   - *Vibe coder — fast workflow*: prompts (`new-app`, `flash-and-smoke`, `pr-ready`, `audio-capture`), long operations as tasks, `crosspad_doctor` that says what is wrong with the environment in one call.
   - *Claude — a toy*: a snapshot → act → snapshot loop on the real device (UI group with refs, LEDs, kit, memory), a pad-pattern scheduler, audio capture + analysis so it can hear what it played.
4. **Safe by construction.** Tiered tools, server-side enforcement (annotations are hints only), confirmation of destructive actions that works even when the client has no elicitation support, hardware hygiene that cannot be switched off by a parameter, read-only mode that removes tools from the list rather than merely refusing them.
5. **Protocol-idiomatic**: state as resources, actions as tools, heavy artifacts by reference, explicit handles, progress with totals, cancellation everywhere, nothing blocking the event loop.

### Non-goals (this spec)

- Firmware or simulator changes. Where parity needs them they are listed in §11 as follow-ups with their own decision.
- Replacing the STM SWD tracer daemon (`tracer/swd_tracer.py`) — it stays as is; `crosspad-hil` may import it later.
- MCP Apps (`ui://`) — Claude Code does not render them; the trace dashboard stays an HTTP page.
- Windows feature parity for ALSA-only fast paths (raw rawmidi writes). Cross-platform primary backends (pyserial, rtmidi, sounddevice, bleak) are required; ALSA is a Linux enrichment.

### Principles (each one is load-bearing later)

| Principle | Consequence |
|---|---|
| Traps encoded once | `crosspad-hil` owns port opening, mode switching, reply matching. Nothing above it opens a serial port. |
| State = resources, actions = tools | `crosspad://device/{id}/state` is readable without a tool call; `crosspad_cdc` mutates. |
| Reference over value | WAV, logs, traces, screenshots, reports → `resource_link` + inline summary. Inline base64 only on explicit request. |
| Explicit handles | `dev_*`, `con_*`, `cap_*`, `stim_*`, `task_*`, `ble_*` with stated TTL; expiry is a tool error with a recovery hint. No module-level globals holding sessions. |
| Self-healing errors | Every error carries `code`, `message`, `hint` (what to call next). "Two CrossPads found: dev_a1 (rev2, default mode), dev_b7 (rev2, audio mode) — pass `device`." |
| Small deterministic tools, layered | Primitives (`cdc`, `console`, `midi`) → typed verbs → scenarios. No magic buttons that hide state. |
| Progressive disclosure | ~8 tools loaded at start; the rest by toolset. |
| Nothing blocks the loop | All host I/O async; all device I/O in the daemon. |

---

## 2. Architecture

```
                 ┌──────────────────────────── crosspad-mcp v10 (TypeScript) ────────────────────────────┐
Claude ──MCP──▶  │ toolsets · policy engine · handles · tasks · confirmations · resources · prompts        │
                 │ tracer/ (STM SWD daemon, unchanged) · git · apps · build · clangd · sim TCP client      │
                 └───────────────┬───────────────────────────────────────────────────────────────────────┘
                                 │ NDJSON over stdio (same pattern as trace-session.ts)
                                 ▼
                 ┌──────────────────── crosspad-hil (Python ≥3.10, separate repo) ──────────────────────┐
                 │ crosspad_hil/                                                                          │
                 │   devices   discovery + Device model (cdc/console/esp_midi/stm_midi/uac2/ble/mode)     │
                 │   console   STM VCP ring buffer, parsers, expect, explicit reset                        │
                 │   cdc       reader thread, prefix waiters, transact, typed verbs, rate limiter          │
                 │   midi      rtmidi primary, ALSA raw fast path, SysEx catalog, echo RTT                 │
                 │   usbmode   0x1B + wait-for-enumeration + restore context                              │
                 │   capture   UAC2 recording (sounddevice; arecord fallback) + health                     │
                 │   analyze   multitone / click / onset / velocity / psd / silence kernels                │
                 │   stim      pad scheduler (rate, pattern, humanize; cdc | sysex transports)             │
                 │   ble       bleak client (scan/connect/send/listen/latency), host-mode peripheral       │
                 │   ota       ota_flash (full/delta), bootloader request, flash + wait-boot               │
                 │   snapshot  one-call device state with UI refs                                          │
                 │   diagnose  crash bundle (reset reason, backtrace decode, heap, context)                │
                 │   scenarios smoke, app_churn, kit_churn, usb_mode_cycle, audio_loopback, …             │
                 │   cli       `crosspad-hil …` (argparse from Params dataclasses, --json everywhere)      │
                 │   serve     the NDJSON daemon                                                           │
                 └───────────────┬──────────────────────────────────────────────────────────────────────┘
                                 ▼
                  ESP CDC 0x303A:0x3456 · STM VCP 0x0483:0x5740 · USB MIDI (ESP / STM bridge) · UAC2 · BLE MIDI
```

Consumers of `crosspad-hil`: (1) humans via the CLI, (2) `platform-idf/tools/hil_*.py` reduced to shims for one release, then removed, (3) crosspad-mcp via the daemon, (4) CI (scenario runner with `--json` + exit codes).

### 2.1 Where things live

| Thing | Location | Why |
|---|---|---|
| Library, CLI, daemon, scenarios | `CrossPad/crosspad-hil` (new repo, PyPI `crosspad-hil`, MIT) | "Hardcore" users install `pipx install crosspad-hil` and never see MCP. |
| Boot markers, fatal patterns, CDC grammar | `crosspad_hil/knowledge/*.yaml` inside the package, keyed by firmware version range | Firmware-coupled data must version with the firmware, not with the MCP server; a YAML the firmware repo can later generate (closes the `REQUIRED_MARKERS` "no compile-time link" TODO). |
| MCP server | `CrossPad/crosspad-mcp` v10 | Existing 8 hardening rounds, tracer, plugin, npm distribution are kept. |
| STM SWD tracer daemon | `crosspad-mcp/tracer/` (unchanged) | Different device (STM), different venv deps (pyocd); not in scope. |
| Firmware-side scripts (`ota_flash.py`, `requestBootloader.py`) | Move into `crosspad_hil.ota`; `platform-idf/tools/` keeps 3-line shims for one release | `idf.py` hooks and README commands keep working during migration. |
| Python venv | `~/.local/share/crosspad-mcp/venv` (existing) extended with `crosspad-hil[all]`; MCP config key `hil_python` (mirrors `pyocd_python`) | One venv to doctor. |

### 2.2 Daemon protocol (`crosspad-hil serve`)

NDJSON over stdio; one JSON object per line; stderr for logs. Mirrors `trace-session.ts` so the TS side reuses its spawn/restart/pending-id code.

```jsonc
// request
{"id": 17, "op": "cdc.transact", "args": {"device": "dev_3f2a", "cmd": "KIT_STATUS", "expect": "KITSTATUS:", "timeout_ms": 2000}}
// response
{"id": 17, "ok": true, "result": {"line": "KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS", "parsed": {"current": 3, "loading": false, "pending": -1, "name": "DRUMS"}, "rtt_ms": 4.1}}
{"id": 17, "ok": false, "error": {"code": "NO_CDC_IN_AUDIO_MODE", "message": "dev_3f2a is in MIDI+UAC2 profile; CDC endpoint absent", "hint": "usbmode.set mode=default (SysEx 0x1B on the ESP MIDI port) then retry"}}
// unsolicited events (only significant, parsed items — never every console line)
{"ev": "console.fatal",  "handle": "con_1", "seq": 48213, "pattern": "Guru Meditation", "line": "…"}
{"ev": "console.reboot", "handle": "con_1", "seq": 48250, "reason": "TG1WDT_SYS_RST", "count": 2}
{"ev": "console.cdc_drops", "handle": "con_1", "dropped": 12}
{"ev": "console.kit", "handle": "con_1", "kit": 3, "state": "started"}
{"ev": "console.boot_complete", "handle": "con_1", "missing": []}
{"ev": "device.changed", "device": "dev_3f2a", "usb_mode": "audio", "ports": {…}}
{"ev": "task.progress", "task": "task_9", "progress": 12, "total": 40, "message": "round 12/40 kit=5 hits_in_window=7"}
{"ev": "task.done", "task": "task_9", "status": "completed|failed|cancelled", "report": {…}, "artifacts": [{"path": "hil_logs/kit_churn_20260825/report.json", "mime": "application/json"}]}
```

Rules: `id` is unique per request; the daemon never blocks the reader on a slow op (every op runs on a worker; device I/O per device is serialized by a per-device lock); a crash of the daemon is detected by the TS side (exit code + last stderr) and reported as `DAEMON_DIED` with the tail of stderr — handles are then invalid and say so.

### 2.3 Device model and discovery

```python
@dataclass
class Device:
    id: str                 # "dev_" + 4 hex of the USB serial (stable across re-enumeration)
    serial: str | None
    board_rev: str | None   # from APP_VERSIONS / boot banner when known
    usb_mode: Literal["default", "audio", "bootloader", "unknown"]
    ports: Ports            # cdc, console, esp_midi, stm_midi, uac2 — each Optional with path/name/index per backend
    ble: BleInfo | None     # self address from BLE_STATUS when queried
    firmware: Firmware | None  # version + app_versions once read
```

One discovery pass merges: pyserial VID/PID (`0x303A:{0x3456,0x4001}` CDC, `0x0483:0x5740` STM VCP with product containing "crosspad", bootloader `0x303A:{0x1001,0x0009}`), rtmidi port names (`Crosspad MIDI*` = ESP, `CrossPad MIDI+Serial` = STM bridge), sounddevice (`Crosspad Audio`), ALSA (`amidi -l`, `/proc/asound/cards`) on Linux for raw nodes. USB mode is inferred (CDC present → default; UAC2 card present, no CDC → audio; bootloader PID → bootloader).

**Selection rule**: if exactly one CrossPad → implicit. Otherwise every op requires `device`; the error lists candidates with mode and ports. An explicit path (`/dev/ttyACM1`) is accepted but still validated against the inventory and its role reported (this fixes the v9 "explicit port bypasses is_crosspad" hole).

### 2.4 Hardware hygiene (not parameters — invariants)

| Invariant | Where enforced |
|---|---|
| STM VCP is opened with DTR/RTS **deasserted**; a reset is only `console.reset(method="dtr_rts")`, which pulses and **guarantees release** even on exception | `console.open` |
| ESP CDC is opened with DTR/RTS deasserted (Windows wedge) | `cdc.open` |
| `F0 7D 19 01 F7` is never sent from a host (hangs `uartLoop`) | `midi.sysex` denylist, unit-tested |
| USB mode switch `0x1B` goes to the **ESP** MIDI port, never the STM bridge (silently dropped there) | `usbmode.set` |
| Replies (`0x1D 09` echo, `0x1D 10` query) are read from the ESP port | `midi.query`, `midi.echo_rtt` |
| `OK` is never treated as the ack of a specific command; typed verbs confirm via a state verb (`kit.load` waits `KIT_STATUS`; `app.start` polls `APP_LIST`; `pad.press` is fire-and-forget with `PAD_STATS` readback) | `cdc` typed verbs |
| Pad stimulus rate is throttled against the 64-deep `app_queue`; `CDC_STATS` drops are read after every burst and reported, never hidden | `stim`, `cdc.burst` |
| Unknown commands echo back — the reader recognises its own line and reports `UNKNOWN_VERB` | `cdc` reader |
| Every port is guarded by a cross-process lock file (`$XDG_RUNTIME_DIR/crosspad-hil/<port>.lock`, holder PID + purpose); `lsof` remains a best-effort second check | `devices` |
| Audio-mode entry restores default mode on exit unless `keep=True` (context manager) — a reset also reverts audio routing, so `audio_route` re-applies the last preset after a detected reboot when asked (`sticky=True`) | `usbmode`, `audio_route` |

### 2.5 Scenarios (the former `hil_*.py`)

Each scenario is a module with a `Params` dataclass, a `run(ctx: Context, p: Params, progress: Progress) -> Report` and an `ARTIFACTS` list. The CLI derives argparse from `Params` (field names → `--flags`, defaults, help from metadata); the daemon exposes the same via `scenario.run`; MCP exposes it via `crosspad_hil_run`. `Report` is a typed dict (`pass: bool`, `summary: str`, scenario-specific fields, `artifacts: [{path, mime, role}]`), written to `hil_logs/<name>_<ts>/report.json`. Exit codes stay `0 PASS / 1 FAIL / 2 environment`.

Scenario → CLI mapping in Appendix B. Every scenario must state its **stimulus-in-window** check where applicable (kit_churn's rule: a green run with no hits inside the swap window is a false negative).

### 2.6 CLI

```
crosspad-hil devices [--json] [--watch]
crosspad-hil doctor                      # venv deps, udev/permissions, ALSA/rtmidi visibility, locks, IDF toolchain for addr2line
crosspad-hil console [--device D] [--reset] [--expect P …] [--reject P …] [--timeout S] [--log FILE] [--json]
crosspad-hil cdc <VERB …> [--expect PREFIX] [--timeout MS]        # raw
crosspad-hil app list|start NAME|stop|versions
crosspad-hil kit list|load ID [--wait]|status
crosspad-hil pad press I [VEL]|release I|pressure I V|stats [--reset]|notes
crosspad-hil ui snapshot|focus REF|press|rotate N
crosspad-hil led state
crosspad-hil mem [--blocks]
crosspad-hil ble status|start [server|host]|stop|scan [MS]|devices|connect ADDR|disconnect|send NOTE [VEL]
crosspad-hil midi sysex "F0 7D …" [--port esp|stm] | note on|off N [VEL] | echo [--n 100]
crosspad-hil usb-mode get|set default|audio [--no-wait]
crosspad-hil audio route …|level|tasks on|off
crosspad-hil capture --seconds S [--preset headphone] [--out FILE]
crosspad-hil analyze multitone|click|onset|velocity|psd FILE [--expected …]
crosspad-hil stim --pads 0,1,2 --rate 8 --seconds 20 | --pattern FILE
crosspad-hil snapshot [--json]
crosspad-hil diagnose [--elf build/CrossPad.elf] [--log FILE]
crosspad-hil flash FIRMWARE [--ota|--uart] [--delta --base-fw F] [--wait-boot]
crosspad-hil bootloader [--esp|--stm]                # ROM bootloader / STM DFU request (confirmation in MCP)
crosspad-hil run <scenario> [scenario flags] [--json]
crosspad-hil record [--out transcript.ndjson]      # capture a device transcript for tests
crosspad-hil serve                                  # the daemon
```

`--json` on every command prints the same object the daemon would return. Human output is a one-screen summary, never a dump.

---

## 3. crosspad-mcp v10

### 3.1 Toolsets and startup surface

At start only `core` is registered (~8 tools, target < 2.5k tokens vs 12.6k measured in v9). Additional toolsets come from `--toolsets a,b` / `CROSSPAD_TOOLSETS`, or at runtime through three meta-tools (GitHub MCP's dynamic toolsets): `crosspad_toolsets` (`action: list|enable|disable|describe`). `--read-only` strips every non-`read`-tier tool regardless of toolset (read-only wins, as in GitHub MCP). `tools/list` order is deterministic (prompt-cache friendly).

| Toolset | Tools | Notes |
|---|---|---|
| `core` (default) | `crosspad_devices`, `crosspad_doctor`, `crosspad_snapshot`, `crosspad_build`, `crosspad_flash`, `crosspad_repo_status`, `crosspad_toolsets`, `crosspad_task` | `crosspad_task` = `status|wait|cancel|list` fallback for clients without the tasks capability |
| `device` | `crosspad_cdc`, `crosspad_console`, `crosspad_ui`, `crosspad_midi`, `crosspad_usb_mode`, `crosspad_audio_route`, `crosspad_diagnose_crash` | all device I/O through the daemon |
| `hil` | `crosspad_hil_run`, `crosspad_capture`, `crosspad_analyze`, `crosspad_stimulus`, `crosspad_ble` | long ops are tasks |
| `sim` | `crosspad_run`, `crosspad_kill`, `crosspad_check`, `crosspad_screenshot`, `crosspad_input`, `crosspad_stats`, `crosspad_settings_get`, `crosspad_settings_set`, `crosspad_test_run` | unchanged behaviour, fixed defects (§3.8) |
| `code` | `crosspad_search_symbols`, `crosspad_symbol` (`definition|references|implementations|diagnostics`), `crosspad_architecture` (merged 3→1), `crosspad_docs_search` | clangd-backed when `compile_commands.json` exists, git-grep fallback |
| `git` | `crosspad_repo_diff`, `crosspad_submodule_update`, `crosspad_commit` | submodule enum from `.gitmodules`, dirty/ahead guard |
| `apps` | `crosspad_apps` (`list|install|remove|update|sync|status|config|profile`) | delegates to `idf.py app-*` so track policy and backups apply; runs the mandatory `fullclean` marker |
| `trace` | `crosspad_trace` | unchanged |

### 3.2 Key tool contracts

Schemas are `z.discriminatedUnion` on the action/verb (the audit's P1 item); output schemas are strict for typed telemetry; every result carries `device`, `ts`, and when relevant `snapshot`.

**`crosspad_devices`** → `{devices: [Device…], selected?: id}`. Read tier. Also served as `crosspad://devices` (ttl 0).

**`crosspad_doctor`** → per-check `{name, ok, detail, fix}`: venv + `crosspad-hil` version, python deps, udev/dialout, port locks (holder PID), ALSA/rtmidi/sounddevice visibility, IDF env + `xtensa-esp32s3-elf-addr2line`, `CROSSPAD_*_ROOT` roots, build dir per rev, sim binary staleness, daemon health. Read tier.

**`crosspad_snapshot`** `{target: device|sim, device?, include?: [ui, leds, kit, mem, ble, console, apps], diff_from?: snapshot_id}` → ~300 tokens:

```jsonc
{"snapshot_id": "snap_41", "device": "dev_3f2a", "usb_mode": "default",
 "apps": {"running": "Sampler", "available": ["Sampler","Sequencer","Settings",…]},
 "ui": {"focus": {"ref": "e3", "label": "Kit: DRUMS"}, "group": [{"ref": "e0", "label": "Back"}, …], "drawer": false, "theme": 1},
 "kit": {"current": 3, "name": "DRUMS", "loading": false, "pending": -1},
 "leds": {"brightness": 80, "anim": false, "colors": ["FF0000", …16]},
 "pads": {"press": 120, "release": 120, "played": 118, "freeslots": 12},
 "mem": {"int_free": 18712, "int_largest": 4096, "psram_free": 4210000},
 "ble": {"state": "connected", "peer": "AA:BB:…"},
 "console": {"handle": "con_1", "fatals": 0, "reboots": 0, "cdc_drops": 0, "since_seq": 48213},
 "changed": ["ui.focus", "kit"]}      // present when diff_from given
```
Refs `e<i>` are the `ENC_GROUP` indices; they are invalidated by any UI-changing action and the next snapshot re-mints them (Playwright's snapshot/ref contract). Sim target produces the same shape from `stats` (+ `enc_group` once the sim has it — §11).

**`crosspad_ui`** `{action: focus(ref)|press|rotate(delta)|back|start_app(name)|stop_app}` — every action returns a fresh snapshot (`return_snapshot: true` default). Stimulus tier.

**`crosspad_cdc`** `{verb: <discriminated: app|kit|pad|enc|led|mem|audio|ble|system|raw>, …}`. Typed verbs return parsed objects; `raw` takes `cmd`, `expect`, `timeout_ms` and returns `line` + best-effort `parsed`. System verbs `bootloader_request` and `stm_dfu` are **danger** tier and live here only behind confirmation; `usb_audio` is exposed through `crosspad_usb_mode` (stimulus tier) rather than as a raw verb, so the mode switch always goes through the ESP MIDI port with wait-for-enumeration and restore.

**`crosspad_console`** `{action: open(device, reset?, log_to?)|read(handle, since_seq?, wait_ms?, match?, limit?)|expect(handle, patterns[], reject[], timeout_ms)|reset(handle)|snapshot(handle)|close(handle)}`. Ring buffer default 50 000 lines, `lines_lost` counter; `read` returns `{lines, next_seq, lines_lost}`; `expect` returns which pattern hit first, or which reject pattern, with the surrounding 20 lines. Persisted to `hil_logs/console_<device>_<ts>.log`, exposed as `crosspad://device/{id}/console/log` (`resource_link` in results, never the whole file inline). Handles expire after 30 min idle; expiry error says so.

**`crosspad_flash`** `{target: esp|stm, transport|method, firmware?, device?, wait_boot?: true, delta?: {base_fw}}` — **danger** tier. Preflight (read-only, always runs, returned in the result even on refusal): device mode (audio → offers `usb_mode` step), port role (refuses the STM console as the flash port), firmware age vs newest source mtime, board rev in `sdkconfig.v*` vs `APP_VERSIONS`/banner, bin version at offset 48, bootloader detection. With `wait_boot` the tool opens a console before flashing and returns `boot: {complete, missing_markers, fatal, seconds}` — flash + smoke in one call (arduino-mcp's `upload_and_wait_ready`). Runs as a task (progress = `recv/total` chunks).

**`crosspad_hil_run`** `{scenario, params}` → task handle; report + artifacts as `resource_link`s; progress from the scenario. Danger only when `params.flash` is set (the scenario would write firmware); otherwise stimulus.

**`crosspad_capture`** `{action: start(device, seconds?, preset?, resume_audio_tasks?: true)|stop|health}` → `cap_*` handle; result `{wav: resource_link, seconds, peak_dbfs, rms_dbfs, overruns, silent: bool}`. Encodes the two non-obvious requirements: `0x1D 06 01` after entering audio mode, and `headphone` preset (codec1 LINE1) for the DAC→ADC loop.

**`crosspad_analyze`** `{kind: multitone|click|onset|velocity|psd|silence, wav, expected?}` → typed verdicts (e.g. onset: `{expected: 24, matched: 24, missed: [], extra: [], latency_ms: {p50, p90, max}}`).

**`crosspad_stimulus`** `{action: start(device, pads[], rate_hz?|pattern[], seconds?, velocity?, gate_ms?, humanize_ms?, transport: cdc|sysex_stm|sysex_esp)|status|stop}` → `stim_*` handle; `status` reports `sent`, `pad_stats` delta, `cdc_drops`.

**`crosspad_diagnose_crash`** `{device?|console_handle?|log_file?, elf?: auto}` → `{reset_reason, panic: {core, cause, pc, excvaddr}, backtrace: [{addr, func, file, line}], heap_after: {…}, context: resource_link (300 lines), likely_cause: string}`. Backtrace decode via `xtensa-esp32s3-elf-addr2line` from the IDF env on the ELF matching the build dir of the flashed rev.

**`crosspad_midi`** `{target: device|sim, action: note_on|note_off|cc|program_change|sysex|echo_rtt|query_route, port?: esp|stm}` — `cc`/`program_change` finally real on device (they were advertised-but-dead in v9 for the sim; on sim they stay refused with a clear error until the sim grows them).

### 3.3 Resources

| URI | Content | ttl |
|---|---|---|
| `crosspad://workspace` | as today + daemon status + policy mode + enabled toolsets | 0 |
| `crosspad://devices` | Device inventory | 0 |
| `crosspad://device/{id}/state` | last snapshot (auto-refreshed on read) | 0 |
| `crosspad://device/{id}/console/log` | current console log file | 0 |
| `crosspad://cdc` | verb catalog with reply grammar, generated from `hil_control.cpp` by a script in crosspad-hil (`knowledge/cdc.yaml`) | long |
| `crosspad://sysex` | 0x7D catalog incl. profile matrix and the host denylist | long |
| `crosspad://hil/catalog` | scenarios with params, runtime, ports needed, exit codes | long |
| `crosspad://events`, `crosspad://settings/schema`, `crosspad://features`, `crosspad://apps/registered/{platform}`, `crosspad://idf/status`, `crosspad://interfaces` | static introspection from crosspad-core/gui/platform-idf (parsers in TS; `apps/registered` scanner matches `REGISTER_APP_PL` and `components/crosspad-*/`) | long (mtime-invalidated) |
| `crosspad://apps/registry/{p}`, `crosspad://apps/installed/{p}`, `crosspad://symbols/{repo}/{symbol}`, `crosspad://trace` | as today | as today |
| `skill://crosspad/{doc}` | `skills/crosspad/reference/*.md` served as resources (ha-mcp idiom) | long |

Completions (`completable`) for `app`, `kit`, `scenario`, `symbol`, `signal`, `device`.

### 3.4 Prompts

`new-app` (app-new → fullclean → build → flash+smoke), `flash-and-smoke`, `pr-ready` (test_run → repo_status → repo_diff → commit), `audio-capture` (usb_mode audio → route preset → tasks resume → capture → analyze → restore), `kit-churn-live`, `jam` (snapshot → start Sampler → load kit → stimulus pattern → capture → onset analysis → report "what I played and whether it came out"). Each prompt is a short, numbered plan that names tools and the state check after each step.

### 3.5 Tasks and progress

Long operations (`build`, `flash`, `hil_run`, `capture`, `stimulus`, `submodule_update`) are **tasks**. With clients that declare the tasks capability the server uses the SDK's `experimental/tasks` (`createTask`, `tasks/get`, `pollIntervalMs`, `ttlMs`). Otherwise the same job registry is reachable through `crosspad_task {action: status|wait(timeout_ms)|cancel|list}` — identical handle, identical states (`working|completed|failed|cancelled`). Progress notifications are monotonic with `total` where known (ninja `[n/N]`, OTA chunks, scenario rounds). Cancellation propagates `extra.signal` → daemon `task.cancel` → scenario cooperative stop → SIGTERM/SIGKILL for subprocesses (existing 2 s ladder). Task results are kept 1 h after completion.

### 3.6 Transport and process model

stdio default. `--http <port>` binds `127.0.0.1` only, requires a bearer token (`CROSSPAD_MCP_TOKEN`, generated and printed when absent), stays on the SDK's stateful Streamable HTTP until the SDK ships 2026-07-28 stateless mode; the handle design already makes the server session-free, so that migration is a transport swap. Logging: stderr for the server, per-request `notifications/progress` for streams; `logging/message` retired (deprecated in 2026-07-28).

Async rule: no `execSync`/`spawnSync` on the request path. `repo_status` batches its ~18 git calls concurrently with a per-repo cap; device enumeration and MIDI live in the daemon; `getIdfEnv` warms in the background at startup.

### 3.7 Handles and state

| Handle | Minted by | TTL | On expiry |
|---|---|---|---|
| `dev_*` | discovery (stable per USB serial) | none | re-discover |
| `con_*` | `console.open` | 30 min idle | error `HANDLE_EXPIRED` + "console.open again; log file kept at …" |
| `cap_*`, `stim_*` | `capture.start`, `stimulus.start` | until stop, 15 min max | auto-stopped, result retained 1 h |
| `task_*` | any task tool | 1 h after terminal | error with last known status |
| `snap_*` | `snapshot` | last 20 kept | `diff_from` unknown → full snapshot |

The TS side keeps a `HandleRegistry` (single module, no globals in tools); the daemon is the owner of device-side handles and reports them in `crosspad://workspace`.

### 3.8 Sim toolset — defects fixed, no protocol change

`crosspad_run` captures sim stdout/stderr to a file and returns a `resource_link` + last 30 lines on crash; retry never re-sends side-effecting commands (`pad_press ×3` on timeout in v9); one socket per session with request pipelining disabled (the sim's shared `s_responseReady` flag); `settings_get` categories derived from `CrosspadSettings` schema resource instead of a hardcoded enum; `settings_set` accepts `number|boolean` per the schema; `screenshot region=lcd` corrects the 18 px stale crop client-side until the sim is fixed; `test_run` gains `labels` (`gui`, `flaky`) so `gui_tests` are reachable.

---

## 4. Safety model

### 4.1 Tiers (server-enforced; annotations mirror them)

| Tier | Annotations | Examples | Policy `strict` (default) | `lab` | `readonly` |
|---|---|---|---|---|---|
| `read` | readOnly | devices, doctor, snapshot, console read/expect, mem, kit status, search, resources | allow | allow | allow (only tier listed) |
| `stimulus` | non-readOnly, non-destructive, idempotent per verb | pad/enc/ui actions, kit load, app start/stop, midi notes, capture, stimulus, sim input, `usb_mode set` (restored on exit; refused while another handle owns the device's CDC unless `force`), console `reset` (the board is back in ~25 s), `hil_run` of any scenario that does not flash | allow, rate-limited | allow | hidden |
| `mutate-host` | destructive=false/true per tool, idempotent where true | commit, apps install/remove/update, settings_set, submodule_update, build clean/fullclean | allow; guards (dirty/ahead/conflicts) | allow | hidden |
| `danger` | destructive=true | irreversible or brick-risk only: flash (uart/ota/swd/dfu), OTA delta, `BOOTLOADER_REQUEST`, `STM_DFU`, trace `write`/`call`, `hil_run` with `flash` set | **confirmation required** | per-tool rules may pre-approve with argument conditions | hidden |

Policy file `~/.config/crosspad-mcp/policy.json` (mode + per-tool rules such as `{"tool":"crosspad_flash","when":{"transport":"ota"},"confirm":false}`), env `CROSSPAD_MCP_POLICY=strict|lab|readonly` and `--read-only` override upward only (a flag can make things stricter, never looser than the file).

### 4.2 Confirmation that does not depend on the client

1. If the client declares `elicitation`, the server calls `elicitInput` with a flat form: what, on which device, why it is risky, and the preflight facts ("firmware is 14 min old and the tree is dirty"). Decline → tool returns `CANCELLED_BY_USER` (not an error the model should retry).
2. Otherwise the tool returns `{"resultType": "confirmation_required", "confirmation": {"token": "cfm_…", "expires_in_s": 120, "summary": "…"}}` and **performs nothing**. The model must re-issue the identical call with `confirm_token`. The token is an HMAC over `(tool, canonical args, device, issued_at)`; any argument change invalidates it. The summary is written so the human reading the transcript sees exactly what was about to happen.
3. When the SDK ships MRTR (`resultType: "input_required"`), (2) becomes the native form with no behavioural change.

Both paths are unit-tested; the token path is the one CI exercises.

### 4.3 Hardware and host hygiene

- Port lock files with holder PID and purpose; `doctor` shows them; a stale lock (dead PID) is reclaimed with a log line.
- Paths (`firmware`, `wav`, `elf`, `log_file`, `out`) are canonicalized and must resolve under an allowlist: the configured repo roots, `hil_logs/`, `recordings/`, `$TMPDIR/crosspad-*`, plus `CROSSPAD_MCP_ALLOWED_PATHS`. Symlinks resolved before the check (embedded-debugger-mcp's rule).
- All subprocesses argv-only (kept from round 4); the `python3 -c "<script>"` app-manager path is replaced by `idf.py app-*` invocations.
- Secrets redaction on every text leaving the server (tokens, `ghp_`, `Bearer`, WiFi PSKs in settings dumps).
- `--http`: loopback + bearer token; no CORS; DNS-rebinding protection via Host check.
- Never `git push`, never `--force`, never `reset --hard`; `submodule_update` refuses on dirty/ahead trees exactly like `idf.py app-update` does, and snapshots first when forced by policy.
- Rate limits: pad stimulus ≤ the rate the CDC queue sustains (measured by `hil_speedtest`; default 8 Hz per pad, burst 16), with `CDC_STATS` drops surfaced in the result. Console reads capped at 2 000 lines per call.
- Daemon runs with the user's privileges; no `sudo` paths; udev guidance in `doctor`.

### 4.4 Meta-bug ("Claude shells out instead of using the tools")

Measured, not assumed: `eval/` in crosspad-mcp with 15–20 tasks ("flash and confirm boot", "why did it reboot", "record 5 s from the sampler") and a `tool_calls` grader that fails when a task is solved via raw `Bash` where a `crosspad_*` tool exists. The server `instructions` string, tool descriptions and the `core` set are tuned against that score; the eval runs in CI without hardware using recorded transcripts.

---

## 5. The toy: see → act → hear

1. `crosspad_snapshot` (device) — Claude sees the launcher, the encoder group with refs, the LEDs, the kit, memory.
2. `crosspad_ui start_app Sampler` → snapshot; `crosspad_cdc kit.load 3` (waits until landed) → snapshot.
3. `crosspad_stimulus start pattern=[{t_ms, pad, vel, gate_ms}…] humanize_ms=8` — Claude composes.
4. `crosspad_capture start seconds=6 preset=headphone` in parallel (audio mode entered and left by the tool) → WAV link + peak/rms.
5. `crosspad_analyze onset wav expected=<pattern times>` → matched/missed/latency.
6. Report: "24/24 hits landed, p90 latency 18 ms, LED colours matched the kit palette, 0 CDC drops, 0 fatals".

The `jam` prompt scripts exactly this. On the sim the same loop runs with `target: sim` minus capture (PipeWire `crosspad_out` is a follow-up).

---

## 6. Migration of `platform-idf/tools`

| Today | After P0 |
|---|---|
| `tools/hil_smoke.py` … 15 scripts with private helpers | `crosspad-hil run smoke …`; each old file becomes a shim `from crosspad_hil.scenarios.smoke import main; raise SystemExit(main())` for one release with a deprecation line on stderr |
| `tools/ota_flash.py`, `tools/requestBootloader.py` | `crosspad-hil flash --ota`, `crosspad-hil bootloader`; shims kept because `idf.py` and README reference them |
| `glitch_capture.py`, `glitch_analyze.py` | `crosspad_hil.analyze` kernels + `crosspad-hil analyze …`; scripts become shims |
| `README.md` HIL table | regenerated from `crosspad://hil/catalog` |
| `tools/requirements*.txt` | `crosspad-hil>=1.0` |

`crosspad-mcp` v10 requires `crosspad-hil` ≥ the version pinned in its `package.json` (`hilVersion`); `doctor` reports mismatch and the exact `pip install` line. `CROSSPAD_IDF_ROOT` remains needed only for build/flash-from-source and ELF lookup.

---

## 7. Testing

| Layer | What | Runs where |
|---|---|---|
| `crosspad-hil` unit | pytest with `FakeSerial`, `FakeMidi`, `FakeAudio` fixtures; every hygiene invariant is a test ("opening the STM VCP never asserts DTR", "0x19 01 is refused", "0x1B goes to the ESP port"); parsers against `knowledge/*.yaml` samples | CI, Linux + Windows, no hardware |
| Transcript replay | `crosspad-hil record` captures real device transcripts (`fixtures/transcripts/*.ndjson`); scenarios and typed verbs are replayed against them | CI |
| Daemon contract | TS vitest replays the same transcripts through the spawn/NDJSON layer; schema of every `op` result validated with zod = daemon's pydantic models exported to JSON Schema (single source: Python, generated into TS) | CI |
| MCP protocol | vitest: `tools/list` count and order, annotations per tier, read-only strips, confirmation token round-trip, task fallback, handle expiry | CI |
| Eval | meta-bug grader (§4.4) | CI |
| HIL | `crosspad-hil run mcp_smoke` — an MCP client drives `flash --wait-boot → snapshot → stimulus → capture → analyze` on a board; plus the existing scenario set | on demand / release gate |

No claim of "done" for a phase without the HIL row green on hardware.

---

## 8. Phasing

**P0 — foundation (release `crosspad-hil 1.0`, `crosspad-mcp 10.0`)**
crosspad-hil: `devices`, `console`, `cdc` (+typed verbs), `midi`, `usbmode`, `ota`, `snapshot`, `knowledge/`, CLI for those, `serve`, scenarios `smoke`, `app_churn`, `kit_churn`, `led_state`, `usb_mode_cycle`; shims in platform-idf; pytest + transcripts.
crosspad-mcp: daemon proxy, `HandleRegistry`, toolsets + meta-tools, policy engine + confirmation (both paths), tiers/annotations, async everywhere, `core` + `device` toolsets, resources `devices/device state/console log/cdc/sysex/hil catalog`, `doctor`, `flash` with preflight + `wait_boot`, task registry + `crosspad_task`.
Exit: `flash --wait-boot` then `snapshot` then `ui start_app` on a rev2 board through Claude Code; `crosspad-hil run smoke --json` passes with no MCP involved; tool list at start < 2.5k tokens; eval baseline recorded.

**P1 — HIL and debugging (`hil 1.1`, `mcp 10.1`)**
`capture`, `analyze`, `stim`, `ble`, `diagnose`, remaining scenarios (`audio_loopback`, `speaker_acoustic`, `velocity`, `speedtest`, `sampler_record`, `midi_stress`, `midi_bench`, `rt_glitch`, `stability`, `ble_midi`); MCP `hil`, `diagnose_crash`, prompts, static introspection resources, `apps` via `idf.py`.
Exit: `jam` prompt end-to-end on hardware; `diagnose_crash` decodes a provoked panic to source lines; every old `hil_*.py` shim runs the new scenario with identical exit codes.

**P2 — sim parity and play (`mcp 10.2`, needs sim follow-ups from §11)**
`snapshot`/`ui`/`cdc` with `target: sim`, sim defects (§3.8), `gui_tests` labels, `jam` on sim.

**P3 — code intelligence and protocol (`mcp 10.3`)**
clangd-backed `crosspad_symbol`, `docs_search`, `architecture` merge, eval expansion, stateless HTTP when the SDK ships it, MRTR swap-in.

---

## 9. Decisions made under assumption (override any of them)

- Spec and `crosspad-hil` docs in English — the repo is public and aimed at people outside this chat.
- Repo `CrossPad/crosspad-hil`, PyPI `crosspad-hil`, Python ≥ 3.10, MIT (the org's default).
- Knowledge YAML lives in `crosspad-hil`, versioned by firmware range; a generator in platform-idf that emits it from `hil_control.cpp` and the log strings is a P1 nice-to-have, not a blocker.
- `hil_logs/` and `recordings/` stay relative to the working directory, as today.
- crosspad-mcp v10 is a breaking release: `crosspad_log target=idf` is replaced by `crosspad_console`; `crosspad_list_interfaces`/`interface_implementations`/`capabilities` merge into `crosspad_architecture`; `crosspad_apps_*` merge into `crosspad_apps`. A migration table goes in the README as with v7→v8.
- The daemon serves multiple boards, but P0 tests one board; multi-board is a design property, not a P0 exit criterion.

---

## 10. Open questions

1. Should `crosspad-hil` also absorb `tracer/swd_tracer.py` in a later phase (one venv, one daemon, `crosspad-hil trace …`)? Leaning yes, after P1, as its own spec.
2. Does Claude Code currently honour server-initiated elicitation? To be verified in P0; the token path is the guaranteed one either way.
3. Windows: `sounddevice`/`rtmidi`/`bleak` cover capture, MIDI and BLE; raw ALSA pad storms are Linux-only. Is a Windows fast path (WinMM raw) needed for `speedtest`, or is the rtmidi rate sufficient? Measure in P1.

---

## 11. Follow-ups outside this spec (each its own decision)

**Simulator (`crosspad-pc`)**: `enc_group`/`ui_state`, `app_list/start/stop`, `kit_list/load/status`, `led_state` (physical colours), `pad_pressure`, `midi_cc/program_change` through the real inbound path, length-prefixed JSON framing and a real parser, `--remote-port`, headless mode, fix the `lcd` crop.
**Firmware (`platform-idf`)**: `LCD_DUMP` over CDC (RLE framebuffer, ~50 KB) so the device gets a screenshot; **touch injection `TOUCH_DOWN x y` / `TOUCH_MOVE x y` / `TOUCH_UP`** (held state, not an atomic tap — a slider with `LV_OBJ_FLAG_ADV_HITTEST` only moves on a drag past `scroll_limit`, and PRESSED-vs-CLICKED regressions in the quick-settings drawer are only testable with a held point; inject through the BSP touch `read_cb` via `lv_async_call_locked`, like `async_enc_rotate`) — today every touch-field change needs a human finger on the board; SysEx verb for audio presets; `hil_control.h` doc block regenerated from code; a generator for `knowledge/cdc.yaml` and boot markers.
**Docs (`crosspad-docs`)**: HIL page regenerated from the catalog; MCP page from `tools/list`.

---

## Appendix A — CDC verb families (authoritative source: `platform-idf/main/hil_control.cpp`)

Families and reply prefixes the typed verbs parse: `APPS:`, `APPVER:`, `KITS:`, `KITSTATUS:`, `PADINFO:`, `PADNOTES:`, `PADSTATS:`, `ENCFOCUS:`, `ENCGROUP:` (multi-line, `[i] <ptr> <label>`), `ENC:`, `UI:`, `LEDS:`, `MEM:`, `MEMBLK:`/`MEMBIG:`, `CDCSTATS:`, `AUDIOLVL:`, `SMPLPEAK:`, `BLE:`, `BLEDEV:`, `OTA_READY|OTA_WAIT|OK n/m|OTA_OK|OTA_ERROR…`, and bare `OK`/`ERR …`. Prefix-order traps (`MEM_BLOCKS` before `MEM`, `PAD_STATS_RESET` before `PAD_STATS`, `BLE_SCAN %d` before `BLE_SCAN`, `ENC_PRESS %d` before `ENC_PRESS`) are the device's problem; the client matches replies by their prefix and never by "the next line". Unmatched input is echoed back. Everything here exists only in the default USB profile.

SysEx (both profiles): `0x1B` USB mode (`0x02` audio, anything else default — the lib sends `0x01`), `0x1D 01–05` routing, `0x1D 06` audio tasks, `0x1D 07/08` pad press/release, `0x1D 09` echo (28-bit seq), `0x1D 10` query → 14-byte reply on the ESP port, `0x19 00` ESP bootloader. Host denylist: `0x19 01`.

## Appendix B — scenario ↔ CLI mapping

| Old script | `crosspad-hil run …` | Notes |
|---|---|---|
| `hil_smoke.py` | `smoke [--flash FW] [--timeout 25]` | console reset + 7 required markers + fatal/E-line/bootloop checks |
| `hil_app_churn.py` | `app_churn --rounds N …` | heap slope per app; console opened deasserted (the old script reset the ESP on start) |
| `hil_kit_churn.py` | `kit_churn [--rapid 0.4] …` | hits-in-window assertion |
| `hil_usb_mode_cycle.py` | `usb_mode_cycle --rounds N` | stimulus; takes the device's CDC lock for the whole run |
| `hil_audio_loopback.py` | `audio_loopback --duration-hours H` | task; multitone kernel |
| `hil_speaker_acoustic.py` | `speaker_acoustic …` | optional pyOCD register peek stays optional |
| `hil_velocity.py` | `velocity …` | velocity kernel |
| `hil_speedtest.py` | `speedtest …` | uses `stim` fast transport |
| `hil_sampler_record.py` | `sampler_record …` | `capture` + `stim`, one cable |
| `hil_midi_stress.py`, `hil_midi_bench.py` | `midi_stress`, `midi_bench` | `midi.echo_rtt` |
| `hil_rt_glitch.py` | `rt_glitch …` | click kernel |
| `hil_stability.py` | `stability --duration-hours H [--stim-midi]` | task; console events drive the report |
| `hil_led_state.py` | `led_state [--watch]` | thin over `snapshot` |
| `hil_ble_midi.py` | `ble_midi [--host-mode]` | `ble` module |
| `glitch_capture.py` / `glitch_analyze.py` | `capture` + `analyze psd|click` | kernels only |
| `ota_flash.py` / `requestBootloader.py` | `flash --ota [--delta]` / `bootloader` | shims kept for `idf.py` |
