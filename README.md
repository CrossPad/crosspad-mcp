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

## Tools (41)

Each tool is focused on a single action. Strict schema validation (ranges on MIDI/pad values, enums on platforms/repos) catches bad inputs before execution.

### Build & flash

| Tool | Purpose |
|------|---------|
| `crosspad_build_pc` | Build PC simulator (`mode`: incremental/clean/reconfigure) |
| `crosspad_run_pc` | Launch simulator, return PID |
| `crosspad_check_pc` | Health check: stale exe, new sources, submodule drift |
| `crosspad_log_pc` | Run exe, capture stdout for N seconds, kill |
| `crosspad_build_idf` | Build ESP-IDF firmware (`mode`: build/fullclean/clean) |
| `crosspad_flash_uart` | UART flash (`idf.py flash`, requires bootloader mode) |
| `crosspad_flash_ota` | OTA flash via USB CDC (no bootloader needed) |
| `crosspad_log_idf` | Capture serial logs from connected device |
| `crosspad_devices` | List USB serial devices, flag CrossPads |

### Tests

| Tool | Purpose |
|------|---------|
| `crosspad_test_run` | Build + run Catch2 suite (`filter`, `list_only`) |
| `crosspad_test_scaffold` | Return Catch2 boilerplate file contents |

### Simulator interaction

| Tool | Purpose |
|------|---------|
| `crosspad_screenshot` | PNG screenshot (file_path by default; `return_inline` for base64) |
| `crosspad_pad_press` / `crosspad_pad_release` | Press/release a pad (0-15) |
| `crosspad_encoder_rotate` / `crosspad_encoder_press` / `crosspad_encoder_release` | Encoder events |
| `crosspad_click` | Click at (x, y) |
| `crosspad_key` | Send SDL keycode |
| `crosspad_midi_note_on` / `crosspad_midi_note_off` | MIDI notes (channel 0-15, note 0-127, velocity 0-127) |
| `crosspad_midi_cc` | MIDI CC (channel, cc_num 0-127, value 0-127) |
| `crosspad_midi_program_change` | Program change |
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
| `crosspad_scaffold_app` | Generate new app boilerplate (PascalCase name) |

### App package manager (crosspad-apps registry)

| Tool | Purpose |
|------|---------|
| `crosspad_apps_list` | Apps from registry + where installed (no Python needed) |
| `crosspad_apps_install` | Install app as submodule (`platform`, `app_name`, `ref`, `force`) |
| `crosspad_apps_remove` | Remove installed app submodule |
| `crosspad_apps_update` | Update one (`app_name`) or all (`update_all`) apps |
| `crosspad_apps_sync` | Rebuild manifest from disk state |

All tools return a uniform envelope: `{ "success": boolean, ...data, "error"?: string }`.

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

Repos are discovered dynamically — only repos that exist on disk appear in tool results. No flat directory structure is assumed when env vars are set.

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
