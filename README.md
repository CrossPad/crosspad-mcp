# crosspad-mcp-server

MCP (Model Context Protocol) server that gives Claude Code full control over the CrossPad development workflow — build, test, manage app packages, interact with the simulator, search code across repos. All from natural language.

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

## Tools (28) + resources

> v8 unifies platform-axis tools: build/run/kill/check/flash now take `platform` (or `transport`) as an arg instead of being split per-platform. Migration table at the bottom of this file.

Each tool is focused on a single action. Strict schema validation (ranges on MIDI/pad values, enums on platforms/repos) catches bad inputs before execution.

### Build & flash

| Tool | Purpose |
|------|---------|
| `crosspad_build` | Build for `platform: pc\|idf` (`mode`: incremental/clean/reconfigure for PC, incremental/clean/fullclean for IDF; `build_type` for PC) |
| `crosspad_run` | Launch built simulator (`platform: pc`), return PID + post-spawn TCP readiness probe |
| `crosspad_kill` | Stop running simulator (`platform: pc`, SIGTERM by exe name match) |
| `crosspad_check` | Health check (`platform: pc`): stale exe, new sources, submodule drift |
| `crosspad_flash` | Flash firmware to device (`transport: uart\|ota`, `port?`, `firmware_path?` ota-only) |
| `crosspad_log` | Capture logs (`target`: pc=spawn binary / idf=read serial) |
| `crosspad_devices` | List USB serial devices, flag CrossPads |
| `crosspad_trace` | Real-time SWD variable trace over ST-Link (non-halting RAM polling) |

### SWD tracing (crosspad_trace)

Non-halting real-time trace of STM32G0B1 firmware variables via ST-Link — the same technique as ST-Studio/CubeMonitor but driven directly from the LLM session.

**Prerequisites**

Install pyocd and pyelftools into a Python venv:

```bash
python3 -m venv ~/.venv/pyocd
~/.venv/pyocd/bin/pip install pyocd pyelftools
```

Point the server at that venv via `config_set` (or set it directly in `~/.config/crosspad-mcp/config.json`):

```
action=config_set  key=pyocd_python  value=~/.venv/pyocd/bin/python
action=config_set  key=stm_elf_path  value=/path/to/CrossPad_STM32_r20.elf
```

**Linux udev note**: without a udev rule the ST-Link probe requires root. Add the official rules from pyocd or from ST (`/etc/udev/rules.d/50-cmsis-dap.rules` or equivalent) so your user can open the device without `sudo`.

**Actions**

| Action | Description |
|--------|-------------|
| `doctor` | Environment precheck — run this first. Returns `issues[]` with severity and suggested_fix for each problem. |
| `config_set` | Persist a key/value to `~/.config/crosspad-mcp/config.json`. Keys: `stm_root`, `stm_elf_path`, `pyocd_python`, `probe_serial`, `trace_dir`. |
| `symbols` | List or search traceable variables resolved from the Debug ELF (`query` for substring filter). |
| `start` | Begin a background trace session (`signals[]`, `rate_hz`). Returns `file_path` of the on-disk `.cptrace` file. |
| `stop` | End the active trace; returns final `sample_count` and `file_path`. |
| `status` | Poll `device_state`, `sample_count`, `actual_fs`, `signals` without blocking. |
| `read` | Downsampled time-series + per-signal stats (min/max/avg/slope). Safe to call frequently — max 200 points per signal by default. |
| `save` | Export the in-memory buffer to CSV (`file_path` returned). |
| `device_state` | Deep STOP/low-power register dump (Milestone 7, not yet implemented). |
| `ui` | Returns the localhost dashboard URL (Milestone 5, not yet implemented). |

Signal names accept array indexing: `s_inputs[0]`, `s_adc_raw[3]`.

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

### Migration: v7 → v8

Platform/transport now flows as an arg, not as part of the tool name. Net: 30 → 28 tools.

| Old (v7) | New (v8) |
|---|---|
| `crosspad_build_pc` | `crosspad_build` with `platform: pc` |
| `crosspad_build_idf` | `crosspad_build` with `platform: idf` |
| `crosspad_run_pc` | `crosspad_run` with `platform: pc` |
| `crosspad_kill_pc` | `crosspad_kill` with `platform: pc` |
| `crosspad_check_pc` | `crosspad_check` with `platform: pc` |
| `crosspad_flash_uart` | `crosspad_flash` with `transport: uart` |
| `crosspad_flash_ota` | `crosspad_flash` with `transport: ota` |

Run/kill/check are PC-only today (the `platform` arg is reserved for future symmetry — IDF firmware doesn't run on the host). Build modes are validated per-platform: `reconfigure` is PC-only; `fullclean` is IDF-only.

### Migration: v6 → v7

Tools removed (logic moved to docs): `crosspad_scaffold_app`, `crosspad_test_scaffold`.
Tools consolidated:

| Old (v6) | New (v7) |
|---|---|
| `crosspad_pad_press`, `crosspad_pad_release`, `crosspad_encoder_rotate`, `crosspad_encoder_press`, `crosspad_encoder_release`, `crosspad_click`, `crosspad_key` | `crosspad_input` with `action` field |
| `crosspad_midi_note_on`, `crosspad_midi_note_off`, `crosspad_midi_cc`, `crosspad_midi_program_change` | `crosspad_midi` with `type` field |
| `crosspad_log_pc`, `crosspad_log_idf` | `crosspad_log` with `target` field |

Net: 42 tools → 30 tools + 1 resource (v7). Subsequent unification in v8 → 28 tools (see above).

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
  index.ts              — 41 focused tool registrations (one tool per action)
  config.ts             — per-repo env vars, dynamic discovery, IDF/MSVC paths
  config.test.ts        — config unit tests (fs mocking)
  utils/
    exec.ts             — platform-aware command execution (MSVC/IDF/shell)
    git.ts              — repo status, submodule pins
    remote-client.ts    — TCP client for simulator (localhost:19840)
  tools/
    app-manager.ts      — crosspad_apps: multi-platform registry + Python subprocess
    architecture.ts     — interfaces, REGISTER_APP scan
    build.ts            — PC build + run
    build-check.ts      — build health check
    diff-core.ts        — submodule drift analysis
    idf-build.ts        — ESP-IDF build
    input.ts            — simulator input events
    log.ts              — exe log capture
    repos.ts            — multi-repo git status
    scaffold.ts         — app boilerplate generation
    screenshot.ts       — simulator screenshots
    settings.ts         — simulator settings R/W
    stats.ts            — simulator runtime stats
    symbols.ts          — cross-repo symbol search
    test.ts             — Catch2 test runner
    *.test.ts           — unit tests for each module
```

## License

MIT — Part of the [CrossPad](https://github.com/CrossPad) project.
