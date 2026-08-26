# crosspad-mcp-server

[![npm](https://img.shields.io/npm/v/crosspad-mcp-server)](https://www.npmjs.com/package/crosspad-mcp-server)
[![CI](https://github.com/CrossPad/crosspad-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/CrossPad/crosspad-mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/crosspad-mcp-server)](package.json)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

MCP (Model Context Protocol) server that gives an LLM full control over the [CrossPad](https://github.com/CrossPad) development workflow — build, flash and test firmware (ESP32-S3 + STM32), drive the PC simulator, trace live variables over SWD, route audio on the physical device, manage app packages, and search code across every repo of the ecosystem. All from natural language.

**39 tools in 8 toolsets (8 visible at start) · 15 resources · 6 prompts · 2 bundled Claude Code skills · stdio & HTTP transports**

## Install

```bash
claude mcp add crosspad -- npx -y crosspad-mcp-server
```

Or with custom repo paths:

```bash
claude mcp add crosspad \
  --env CROSSPAD_IDF_ROOT=/path/to/platform-idf \
  --env CROSSPAD_PC_ROOT=/path/to/crosspad-pc \
  -- npx -y crosspad-mcp-server
```

That's it. Restart Claude Code and the tools are available.

### Alternative: `.mcp.json` in your project

Add to your repo root — Claude Code picks it up automatically:

```json
{
  "mcpServers": {
    "crosspad": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "crosspad-mcp-server"],
      "env": {
        "CROSSPAD_IDF_ROOT": "/path/to/platform-idf",
        "CROSSPAD_PC_ROOT": "/path/to/crosspad-pc"
      }
    }
  }
}
```

### Alternative: Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "crosspad": {
      "command": "npx",
      "args": ["-y", "crosspad-mcp-server"],
      "env": {
        "CROSSPAD_IDF_ROOT": "/path/to/platform-idf"
      }
    }
  }
}
```

## Skills (start here)

This package ships two Claude Code skills (bundled in the `crosspad` plugin):

- **`crosspad`** — the entry point. An ecosystem map, install/config guide, per-role
  guides (user / firmware dev / server contributor), a tool cheat-sheet, and an FAQ.
  A fresh agent should read this first. Lives at `skills/crosspad/SKILL.md`;
  run `bash skills/crosspad/scripts/doctor.sh` to check your environment.
  Reference guides bundled with it:
  - `reference/philosophy.md` — the CrossPad design principles ("write once, run
    everywhere", thin platform repos) and where code belongs
  - `reference/hil-testing.md` — hardware-in-the-loop testing on the real device:
    the flash→smoke workflow, every `tools/hil_*.py` script, the CDC/SysEx remote
    control surface, and the hardware traps that cost real debugging sessions
  - `reference/repos.md`, `reference/tools.md`, `reference/install.md`,
    `reference/faq.md`, per-role guides
- **`swd-tracer`** — real-time SWD variable tracing for CrossPad r20 (STM32G0B1)
  over ST-Link (see the SWD tracing section below).

Install both as a plugin:

```
/plugin marketplace add CrossPad/crosspad-mcp     # or a local path to this repo
/plugin install crosspad@crosspad
```

## Tools + resources

> v10 put the tools behind **toolsets** and a **policy**: `tools/list` starts with the `core` toolset only, so the startup context stays small, and everything that writes to a device or the host is tiered and confirmable. Migration table at the bottom of this file.

Each tool is focused on a single action. Strict schema validation (ranges on MIDI/pad values, enums on platforms/repos) catches bad inputs before execution.

### Toolsets

| Toolset | Contains | On at start |
|---|---|---|
| `core` | `crosspad_devices`, `crosspad_doctor`, `crosspad_snapshot`, `crosspad_build`, `crosspad_flash`, `crosspad_repo_status`, `crosspad_toolsets`, `crosspad_task` | yes |
| `device` | `crosspad_cdc`, `crosspad_console`, `crosspad_ui`, `crosspad_midi`, `crosspad_usb_mode`, `crosspad_audio_route` | no |
| `hil` | scenario runner (`crosspad_hil_run` and friends — P1) | no |
| `sim` | `crosspad_run`, `crosspad_kill`, `crosspad_check`, `crosspad_screenshot`, `crosspad_input`, `crosspad_stats`, `crosspad_settings_get`, `crosspad_settings_set`, `crosspad_test_run`, `crosspad_log` | no |
| `code` | `crosspad_docs_search`, `crosspad_search_symbols`, `crosspad_list_interfaces`, `crosspad_interface_implementations`, `crosspad_capabilities`, `crosspad_list_apps_source` | no |
| `git` | `crosspad_repo_diff`, `crosspad_submodule_update`, `crosspad_commit` | no |
| `apps` | `crosspad_apps_list`, `crosspad_apps_install`, `crosspad_apps_remove`, `crosspad_apps_update`, `crosspad_apps_sync` | no |
| `trace` | `crosspad_trace` | no |

Enable one at runtime with `crosspad_toolsets action=enable toolset=device` (the tool list changes and the client is notified). At startup: `--toolsets device,code` (or `CROSSPAD_TOOLSETS=device,code`, keyword `all`). `--read-only` (or `CROSSPAD_MCP_POLICY=readonly`) removes every non-`read` tool from the list regardless of toolset flags — read-only always wins.

Danger-tier tools (`crosspad_flash`, bootloader/DFU requests, `crosspad_trace` write/call) return `resultType="confirmation_required"` with a `confirm_token` valid for 120 s; re-issue the identical call carrying the token to proceed. A declined confirmation is `CANCELLED_BY_USER` and must not be retried automatically.

### Build & flash

| Tool | Purpose |
|------|---------|
| `crosspad_build` | Build for `platform: pc\|idf\|stm` (`mode`: incremental/clean, plus reconfigure for PC/STM, fullclean for IDF; `build_type` for PC/STM) |
| `crosspad_run` | Launch built simulator (`platform: pc`), return PID + post-spawn TCP readiness probe |
| `crosspad_kill` | Stop running simulator (`platform: pc`, SIGTERM by exe name match) |
| `crosspad_check` | Health check (`platform: pc`): stale exe, new sources, submodule drift |
| `crosspad_flash` | Flash firmware (`target: esp` with `transport: uart\|ota`, or `target: stm` with `method: swd\|dfu`) |
| `crosspad_log` | Capture simulator logs (`target: pc` spawns the binary). For device logs use `crosspad_console` — it does not reboot the board. |
| `crosspad_devices` | Devices through the crosspad-hil daemon: USB mode, CDC + STM32-bridge ports, MIDI ports, UAC2 card, which one is selected |
| `crosspad_trace` | Real-time SWD variable trace over ST-Link (non-halting RAM polling) |
| `crosspad_audio_route` | Runtime codec routing on the physical device over MIDI SysEx (ADC inputs, DAC outputs, USB-mic source, volume/mute, query) |

### Device (crosspad-hil daemon)

Everything here needs a connected board (`[ESP HW]`) and the `device` toolset.

| Tool | Purpose |
|------|---------|
| `crosspad_doctor` | Host + daemon environment checks (python, crosspad-hil version, IDF export, sim binary, ports) with a `fix` per failed check |
| `crosspad_console` | STM32-bridge console: `open` (never reboots the board — DTR/RTS deasserted), `read`, `expect`, `reset`, `snapshot`, `close`. Log file linked as a resource, never inlined; reads cap at 2 000 lines |
| `crosspad_cdc` | Typed CDC verbs (`app`, `kit`, `pad`, `enc`, `led`, `mem`, `audio`, `ble`, `system`, `raw`) — the `hil_control.cpp` command set with reply parsing |
| `crosspad_ui` | Drive the UI by snapshot ref: rotate to a labelled row, press, back. Returns a fresh snapshot |
| `crosspad_snapshot` | One coherent read of a device (apps, ui, kit, leds, pads, mem, ble, console) or of the simulator; diffable against a previous snapshot |
| `crosspad_usb_mode` | Get/set the USB profile (`default` = MIDI+CDC, `audio` = UAC2) and wait for re-enumeration |
| `crosspad_task` | `status` / `wait` / `cancel` / `list` for long operations (build, flash, scenarios) |

### SWD tracing (crosspad_trace)

Non-halting real-time trace of STM32G0B1 firmware variables via ST-Link — the same technique as ST-Studio/CubeMonitor but driven directly from the LLM session.

**Recommended: the `swd-tracer` skill.** This repo ships a Claude Code skill
(`skills/swd-tracer/`) + plugin manifest so a fresh agent automatically
understands the tracer and can walk you through configuring every environment
(pyOCD venv, config paths, udev rules, the Debug ELF) and the
doctor→symbols→start→read→ui→stop workflow. Install it as a plugin:

```
/plugin marketplace add CrossPad/crosspad-mcp     # or a local path to this repo
/plugin install crosspad@crosspad
```

The plugin bundles BOTH this MCP server and the skill, so a new machine gets the
tracer end-to-end in one install. (Already running the server? The skill alone
also lives at `skills/swd-tracer/SKILL.md`.)

**Prerequisites** (the skill's `scripts/setup-venv.sh` automates this)

Install pyocd and pyelftools into a Python venv (system Python is usually
PEP-668 locked, so a venv is required):

```bash
bash skills/swd-tracer/scripts/setup-venv.sh
# or manually:
python3 -m venv ~/.local/share/crosspad-mcp/venv
~/.local/share/crosspad-mcp/venv/bin/pip install "pyocd>=0.44" pyelftools
```

Point the server at that venv via `config_set` (or set it directly in `~/.config/crosspad-mcp/config.json`):

```
action=config_set  key=pyocd_python  value=~/.local/share/crosspad-mcp/venv/bin/python
action=config_set  key=stm_elf_path  value=/path/to/CrossPad_STM32_r20.elf
```

**Linux udev note**: without a udev rule the ST-Link probe requires root. Run
`bash skills/swd-tracer/scripts/install-udev-rules.sh` (writes
`/etc/udev/rules.d/49-stlink.rules`, then replug the probe), or add the official
rules from pyocd / ST so your user can open the device without `sudo`.

**Actions**

| Action | Description |
|--------|-------------|
| `doctor` | Environment precheck — run this first. Returns `issues[]` with severity and suggested_fix for each problem. |
| `config_set` | Persist a key/value to `~/.config/crosspad-mcp/config.json`. Keys: `stm_elf_path`, `pyocd_python`, `probe_serial`, `trace_dir`. |
| `symbols` | List or search traceable variables resolved from the Debug ELF (`query` for substring filter). Returns rich metadata (`kind`/`dims`/`count`/`members`). |
| `start` | Begin a background trace session (`signals[]`, `rate_hz`). Returns `file_path` of the on-disk `.cptrace` file + the UI url. |
| `stop` | End the active trace; returns final `sample_count` and `file_path`. |
| `add` / `remove` | Edit the watched signal set on a **live** trace (`signals[]`) without restarting; returns the post-reconcile set. |
| `status` | Poll `device_state`, `sample_count`, `actual_fs`, `signals` without blocking. |
| `read` | Downsampled time-series + per-signal stats (min/max/avg/slope). Safe to call frequently — max 200 points per signal by default. |
| `save` | Export the in-memory buffer to CSV (`file_path` returned). |
| `device_state` | Deep STOP/low-power register dump (PWR/RCC/SCB/DBGMCU), decoded SLEEPDEEP/LPMS — does not halt the core. |
| `ui` | Returns the localhost dashboard URL (live table + zoom/pan plots). |

Signal names accept array indexing, struct members, and whole-array/slice
expansion: `s_inputs[0]`, `s_adc_raw[3]`, `hpcd.Init.speed`, `s_adc_raw[*]`,
`s_inputs[0:8]` (out-of-bounds indices are rejected against the DWARF length).

**Example — trace ADC rail and pad inputs**

```
action=doctor
# resolve any blocking issues...
action=symbols  query=s_vbat
action=start    signals=["s_vbat_mv","s_inputs[0]"]  rate_hz=100
action=status
action=read     max_points=500
action=save
action=stop
```

### Tests

| Tool | Purpose |
|------|---------|
| `crosspad_test_run` | Build + run Catch2 suite (`filter`, `list_only`) |

### Simulator interaction

| Tool | Purpose |
|------|---------|
| `crosspad_screenshot` | PNG screenshot (file_path by default; `return_inline` for base64) |
| `crosspad_input` | All input events: pad_press/release, encoder_*, click, key (`action` field) |
| `crosspad_midi` | All MIDI events: note_on/off, cc, program_change (`type` field) |
| `crosspad_stats` | Runtime state: pads, capabilities, heap, apps |
| `crosspad_settings_get` / `crosspad_settings_set` | Read/write settings |

### Git / repos

| Tool | Purpose |
|------|---------|
| `crosspad_repo_status` | Status across all detected repos |
| `crosspad_repo_diff` | Submodule drift in crosspad-pc / platform-idf |
| `crosspad_submodule_update` | Update submodule to `origin/<branch>` and stage |
| `crosspad_commit` | Commit staged changes (refuses on conflicts; never pushes) |

### Code search & scaffolding

| Tool | Purpose |
|------|---------|
| `crosspad_docs_search` | Search the ecosystem's prose (crosspad-docs, BSP guides, skill pages) and return the matching sections, not whole pages |
| `crosspad_search_symbols` | Find class/function/macro/enum/typedef definitions |
| `crosspad_list_interfaces` | List crosspad-core interfaces |
| `crosspad_interface_implementations` | Find implementations of a given interface |
| `crosspad_capabilities` | Capability flags + per-platform sets |
| `crosspad_list_apps_source` | Apps registered via `REGISTER_APP()` macro |

### App package manager (crosspad-apps registry)

| Tool | Purpose |
|------|---------|
| `crosspad_apps_list` | Apps from registry + where installed (no Python needed) |
| `crosspad_apps_install` | Install app as submodule (`platform`, `app_name`, `ref`, `force`) |
| `crosspad_apps_remove` | Remove installed app submodule |
| `crosspad_apps_update` | Update one (`app_name`) or all (`update_all`) apps |
| `crosspad_apps_sync` | Rebuild manifest from disk state |

### Resources

| URI | Purpose |
|-----|---------|
| `crosspad://workspace` | JSON snapshot: detected repos, branches, HEADs, dirty counts, PC simulator running status. Loadable without a tool call — clients (e.g. Claude Code) can pin it as session context. |
| `crosspad://apps/registry/<platform>` | Raw `app-registry.json` per detected platform (pc / idf / esp32-s3). |
| `crosspad://apps/installed/<platform>` | Raw `apps.json` (installed manifest) per detected platform. |
| `crosspad://symbols/{repo}/{symbol}` | Resource template — resolves a single symbol's definitions in `<repo>` (or `all`). MCP-native alternative to `crosspad_search_symbols` for known symbol+repo pairs. |
| `crosspad://devices` | Device inventory from the daemon — the raw `Device` dicts behind `crosspad_devices`. Re-discovered on every read. |
| `crosspad://device/{id}/state` | Fresh snapshot of one device (apps, ui, kit, leds, pads, mem, ble, console). |
| `crosspad://device/{id}/console/log` | The console log file of the most recent `crosspad_console open` for that device (last 1 MiB). |
| `crosspad://cdc` | CDC verb catalog with reply grammar, from `crosspad_hil/knowledge/cdc.yaml`. Cached 1 h. |
| `crosspad://sysex` | 0x7D SysEx catalog: USB-mode and audio-route ids, plus the host denylist. Cached 1 h. |
| `crosspad://hil/catalog` | Scenarios the daemon can run, with parameters, defaults and help. Cached 1 h. |

### Migrations

<details>
<summary><b>v9 → v10</b> — the device side moved into the crosspad-hil daemon; tools live in toolsets</summary>

| Old (v9) | New (v10) | Status |
|---|---|---|
| `crosspad_log` with `target: idf` | `crosspad_console` (`open`/`read`/`expect`/`snapshot`/`close`) | shipped — `crosspad_log` keeps `target: pc` |
| `crosspad_devices` (serial-port list) | `crosspad_devices` (daemon `devices.list`: USB mode, paired STM32 bridge, MIDI, UAC2) | shipped — same name, richer result |
| raw SysEx via `amidi` inside `crosspad_audio_route` | daemon `midi.sysex` / `midi.query_route`, tool schema unchanged | shipped |
| `crosspad_flash` (fire and forget) | `crosspad_flash` with an always-returned preflight, a job handle and `wait_boot` | shipped |
| — | `crosspad_cdc`, `crosspad_ui`, `crosspad_snapshot`, `crosspad_doctor`, `crosspad_usb_mode`, `crosspad_task`, `crosspad_toolsets` | new |
| `crosspad_list_interfaces`, `crosspad_interface_implementations`, `crosspad_capabilities` | `crosspad_architecture` with an `action` field | P1 — v9 names still registered (toolset `code`) |
| `crosspad_apps_list/install/remove/update/sync` | `crosspad_apps` with an `action` field | P1 — v9 names still registered (toolset `apps`) |

Startup surface: `tools/list` returns the `core` toolset only. Enable the rest with `crosspad_toolsets`, `--toolsets a,b` or `CROSSPAD_TOOLSETS`; hide every writing tool with `--read-only`. Requires `crosspad-hil` ≥ 1.0.0 (`package.json` → `hilVersion`); `crosspad_doctor` tells you when it is missing or too old.

</details>

<details>
<summary><b>v7 → v8</b> — platform/transport became an arg, not part of the tool name (30 → 28 tools)</summary>

| Old (v7) | New (v8) |
|---|---|
| `crosspad_build_pc` | `crosspad_build` with `platform: pc` |
| `crosspad_build_idf` | `crosspad_build` with `platform: idf` |
| `crosspad_run_pc` | `crosspad_run` with `platform: pc` |
| `crosspad_kill_pc` | `crosspad_kill` with `platform: pc` |
| `crosspad_check_pc` | `crosspad_check` with `platform: pc` |
| `crosspad_flash_uart` | `crosspad_flash` with `transport: uart` |
| `crosspad_flash_ota` | `crosspad_flash` with `transport: ota` |

Run/kill/check are PC-only today (the `platform` arg is reserved for future symmetry — IDF firmware doesn't run on the host). Build modes are validated per-platform: `reconfigure` is PC/STM-only; `fullclean` is IDF-only.

</details>

<details>
<summary><b>v6 → v7</b> — input/MIDI/log consolidated into single tools with an action/type field (42 → 30 tools)</summary>

Tools removed (logic moved to docs): `crosspad_scaffold_app`, `crosspad_test_scaffold`.
Tools consolidated:

| Old (v6) | New (v7) |
|---|---|
| `crosspad_pad_press`, `crosspad_pad_release`, `crosspad_encoder_rotate`, `crosspad_encoder_press`, `crosspad_encoder_release`, `crosspad_click`, `crosspad_key` | `crosspad_input` with `action` field |
| `crosspad_midi_note_on`, `crosspad_midi_note_off`, `crosspad_midi_cc`, `crosspad_midi_program_change` | `crosspad_midi` with `type` field |
| `crosspad_log_pc`, `crosspad_log_idf` | `crosspad_log` with `target` field |

Net: 42 tools → 30 tools + 1 resource (v7). Subsequent unification in v8 → 28 tools; v9 added `crosspad_trace` and `crosspad_audio_route` → 30.

</details>

All tools return a uniform envelope: `{ "success": boolean, ...data, "error"?: string }`. On failure the result also has the MCP-protocol `isError: true` flag set so clients can route errors distinctly from successful calls.

Each tool carries [MCP annotations](https://modelcontextprotocol.io/specification) (`readOnlyHint`, `destructiveHint`, `openWorldHint`) — clients use these for confirmation prompts. Read-only tools (status, search, list) skip the prompt; destructive tools (commit, flash, build_idf clean, apps_install) trigger one.

## Configuration

Each repo path is individually configurable via env vars. If not set, falls back to `$CROSSPAD_GIT_DIR/<repo-name>` (flat layout).

| Variable | Default | Description |
|----------|---------|-------------|
| `CROSSPAD_GIT_DIR` | `~/GIT` | Base directory (flat layout fallback) |
| `CROSSPAD_PC_ROOT` | `$GIT_DIR/crosspad-pc` | PC simulator repo |
| `CROSSPAD_IDF_ROOT` | `$GIT_DIR/platform-idf` | ESP-IDF platform repo |
| `CROSSPAD_ARDUINO_ROOT` | `$GIT_DIR/ESP32-S3` | Arduino platform repo |
| `CROSSPAD_CORE_ROOT` | `$GIT_DIR/crosspad-core` | crosspad-core (standalone) |
| `CROSSPAD_GUI_ROOT` | `$GIT_DIR/crosspad-gui` | crosspad-gui (standalone) |
| `IDF_PATH` | auto-detected (`~/esp/esp-idf`) | ESP-IDF SDK path |
| `VCPKG_ROOT` | `~/vcpkg` (Linux) / `C:/vcpkg` (Win) | vcpkg installation |
| `VCVARSALL` | VS2022 default | MSVC vcvarsall.bat (Windows only) |
| `CROSSPAD_REMOTE_PORT` | `19840` | TCP port for simulator remote control |
| `CROSSPAD_REMOTE_HOST` | `127.0.0.1` | TCP host for simulator remote control |

Repos are discovered dynamically — only repos that exist on disk appear in tool results. No flat directory structure is assumed when env vars are set.

## Transport

**stdio (default)** — `npx crosspad-mcp-server`. Standard MCP transport for Claude Code / Claude Desktop / IDE plugins.

**HTTP (`--http <port>`)** — `npx crosspad-mcp-server --http 3000`. Exposes a Streamable HTTP endpoint at `http://localhost:<port>/mcp` for remote dev boxes or browser-based MCP clients. Stateful sessions (`Mcp-Session-Id` header echoed after `initialize`). One transport, multi-session multiplexed internally.

```bash
# Minimal HTTP smoke test:
npx crosspad-mcp-server --http 3000
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}'
```

## How it works

**Static tools** (build, repos, code, apps) work without the simulator — they operate on the filesystem, git, and Python package manager.

**Interactive tools** (sim) communicate with the running PC simulator via TCP on `localhost:19840` using newline-delimited JSON.

**Streaming** — long-running tools (build, test, log) emit output line-by-line via MCP logging, so Claude sees progress in real-time.

**App manager** — reads registry JSON directly for listing (aggregated across all repos). Mutations delegate to `app_manager.py` (at `tools/` for IDF, `scripts/` for PC/Arduino) from [crosspad-apps](https://github.com/CrossPad/crosspad-apps).

## Development

```bash
git clone https://github.com/CrossPad/crosspad-mcp.git
cd crosspad-mcp
npm install
npm run dev      # watch mode
npm run build    # one-shot build
npm test         # run unit tests
npm run test:watch  # tests in watch mode
```

```
src/
  index.ts              — 30 focused tool registrations (one tool per action) + resources
  config.ts             — per-repo env vars, dynamic discovery, IDF/MSVC/STM paths
  utils/                — platform-aware exec (MSVC/IDF/shell), git helpers,
                          TCP client for the simulator (localhost:19840)
  tools/
    build.ts / idf-build.ts / stm-build.ts   — per-platform builds behind crosspad_build
    idf-flash.ts / stm-flash.ts              — ESP (uart/ota) and STM (swd/dfu) flashing
    build-check.ts / diff-core.ts / repos.ts — health checks, submodule drift, git status
    trace-*.ts            — SWD tracer: session, symbols (DWARF), buffer, export,
                            device-state, write, doctor, web UI
    audio-route.ts        — runtime codec routing over MIDI SysEx
    input.ts / midi.ts / screenshot.ts / settings.ts / stats.ts — simulator interaction
    app-manager.ts        — multi-platform app registry + Python subprocess
    architecture.ts / symbols.ts             — interfaces, REGISTER_APP scan, symbol search
    test.ts               — Catch2 test runner
    *.test.ts             — unit tests alongside each module
skills/                 — bundled Claude Code skills (crosspad, swd-tracer)
tracer/                 — SWD tracer runtime (pyOCD host script + protocol docs)
vscode-extension/       — companion VS Code extension
```

## License

MIT — Part of the [CrossPad](https://github.com/CrossPad) project.
