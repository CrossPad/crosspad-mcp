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

## Tools (6)

### `crosspad_build` — Build, run, or check the PC simulator or ESP-IDF firmware

| Action | What it does |
|--------|-------------|
| `pc` | Build PC simulator (incremental/clean/reconfigure) |
| `pc_run` | Launch simulator, return PID |
| `pc_check` | Health check: stale exe, new sources, submodule drift |
| `pc_log` | Run exe, capture stdout for N seconds, kill |
| `idf` | Build ESP-IDF firmware (build/fullclean/clean) |

### `crosspad_test` — Catch2 tests for crosspad-pc

| Action | What it does |
|--------|-------------|
| `run` | Build + run tests, with optional name filter |
| `scaffold` | Generate test CMakeLists.txt + sample test file |

### `crosspad_sim` — Interact with the running simulator

| Action | What it does |
|--------|-------------|
| `screenshot` | Capture PNG (full window or LCD only) |
| `input` | Press pads, rotate encoder, click, send keys |
| `stats` | Pad state, capabilities, heap, registered apps |
| `settings_get` | Read settings by category |
| `settings_set` | Write individual setting key |

### `crosspad_repo` — Git status and submodule diffs

| Action | What it does |
|--------|-------------|
| `status` | Git status across all detected CrossPad repos |
| `diff` | Submodule drift: commits ahead/behind, changed files |

### `crosspad_code` — Search and analyze code across repos

| Action | What it does |
|--------|-------------|
| `search` | Find classes, functions, macros, enums via git grep |
| `interfaces` | List crosspad-core interfaces and their implementations |
| `apps` | List REGISTER_APP registrations per platform |
| `scaffold` | Generate new app boilerplate (cpp, hpp, CMakeLists.txt) |

### `crosspad_apps` — App package manager (multi-platform)

| Action | What it does |
|--------|-------------|
| `list` | Available apps from registry + where installed (idf/pc/arduino) |
| `install` | Install app as git submodule (requires `platform` param) |
| `remove` | Remove app submodule (requires `platform` param) |
| `update` | Update one or all installed apps (requires `platform` param) |
| `sync` | Sync manifest with existing submodules (requires `platform` param) |

`list` aggregates `apps.json` from all detected repos. Mutations (`install`, `remove`, `update`, `sync`) target a specific platform via the `platform` parameter (`idf`, `pc`, or `arduino`).

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
  index.ts              — 6 tool registrations with action dispatch
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
