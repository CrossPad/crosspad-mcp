# crosspad-mcp

MCP (Model Context Protocol) server that gives Claude Code full control over the CrossPad development workflow — build, test, run, screenshot, interact with the simulator, search code across all repos, and manage settings. All from natural language.

## What it does

Instead of manually running cmake, launching the simulator, grepping through 5 repos, and checking submodule state — Claude does it through 17 specialized tools:

**Build & Run** — build the simulator (incremental/clean/reconfigure), launch it, check build health, capture startup logs.

**Testing** — run Catch2 tests with filtering, scaffold test infrastructure from scratch.

**Code navigation** — search symbols (classes, functions, macros, enums) across all CrossPad repos at once. Query interfaces and their platform implementations. List registered apps.

**Simulator interaction** — take screenshots (full window or LCD-only), press pads, rotate the encoder, click UI elements, read runtime stats (pad state, capabilities, heap), read/write settings — all while the simulator is running.

**Multi-repo awareness** — git status across all 5 CrossPad repos, detect dev-mode vs submodule-mode, diff crosspad-core/gui against pinned commits.

**Real-time streaming** — build output, test results, and log capture stream line-by-line to Claude instead of blocking until completion.

## Prerequisites

- **Node.js** 18+
- **crosspad-pc** repo cloned and buildable (cmake, vcpkg, SDL2)
- **Windows**: Visual Studio 2022 (MSVC) — auto-detected
- **macOS/Linux**: clang or gcc, cmake, ninja (optional)

## Installation

```bash
git clone https://github.com/CrossPad/crosspad-mcp.git
cd crosspad-mcp
npm install
npm run build
```

### Configure Claude Code

Add to your Claude Code MCP settings (`.claude/settings.local.json` in the crosspad-pc project, or global `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "crosspad": {
      "command": "node",
      "args": ["C:/Users/YourName/GIT/crosspad-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Restart Claude Code after adding the config.

### Configure for VS Code (Copilot / Cline / etc.)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "crosspad": {
      "command": "node",
      "args": ["C:/Users/YourName/GIT/crosspad-mcp/dist/index.js"]
    }
  }
}
```

## Configuration

All paths are configurable via environment variables. Defaults work out of the box on the main dev machine (Windows). On Mac/Linux, set these in your MCP server config `env` block:

| Variable | Default (Windows) | Default (Mac/Linux) | Description |
|---|---|---|---|
| `CROSSPAD_GIT_DIR` | `C:/Users/Mateusz/GIT` | `~/GIT` | Base directory containing all CrossPad repos |
| `CROSSPAD_PC_ROOT` | `$GIT_DIR/crosspad-pc` | `$GIT_DIR/crosspad-pc` | Path to crosspad-pc repo |
| `VCPKG_ROOT` | `C:/vcpkg` | `~/vcpkg` | vcpkg installation directory |
| `CMAKE_GENERATOR` | `Ninja` | system default | CMake generator (`Ninja`, `Unix Makefiles`, etc.) |
| `VCVARSALL` | VS2022 Community path | *(not used)* | MSVC vcvarsall.bat path (Windows only) |

Example for macOS:

```json
{
  "mcpServers": {
    "crosspad": {
      "command": "node",
      "args": ["/Users/you/GIT/crosspad-mcp/dist/index.js"],
      "env": {
        "CROSSPAD_GIT_DIR": "/Users/you/GIT",
        "VCPKG_ROOT": "/opt/vcpkg"
      }
    }
  }
}
```

## Tools reference

### Build & Run

| Tool | Description |
|---|---|
| `crosspad_build` | Build the simulator. Modes: `incremental` (default), `clean` (wipe + rebuild), `reconfigure` (cmake configure + build — use after adding new source files) |
| `crosspad_run` | Launch `bin/main.exe`. Returns PID immediately |
| `crosspad_build_check` | Health check: stale exe? new source files needing reconfigure? submodule drift? dirty working trees? |
| `crosspad_log` | Launch the exe, capture stdout/stderr for N seconds, then kill it. Great for checking init, crashes, runtime errors |

### Testing

| Tool | Description |
|---|---|
| `crosspad_test` | Build and run the Catch2 test suite. Supports name filtering (`[core]`, `PadManager`) and `list_only` mode |
| `crosspad_test_scaffold` | Generate test infrastructure (CMakeLists.txt + sample test). Returns file contents — does NOT write to disk |

### Multi-repo

| Tool | Description |
|---|---|
| `crosspad_repos_status` | Git status across all 5 CrossPad repos. Detects dev-mode (junction/symlink) vs submodule-mode |
| `crosspad_diff_core` | What changed in crosspad-core/gui vs the pinned submodule commit. Commits ahead/behind, changed files, uncommitted changes |

### Code & Architecture

| Tool | Description |
|---|---|
| `crosspad_search_symbols` | Find classes, functions, macros, enums across all repos. Filters by kind and repo. Uses `git grep` |
| `crosspad_scaffold_app` | Generate boilerplate for a new CrossPad app (cpp, hpp, CMakeLists.txt, optional pad logic handler) |
| `crosspad_interfaces` | Query crosspad-core interfaces: `list` all, `implementations <Name>`, or `capabilities` flags |
| `crosspad_apps` | List registered apps per platform (`pc`, `esp32`, `2player`, `all`) |

### Simulator interaction

These tools require the simulator to be running (`crosspad_run` first).

| Tool | Description |
|---|---|
| `crosspad_screenshot` | Capture PNG screenshot. `region`: `full` (490x680 window) or `lcd` (320x240 screen only). Save to file or return base64 |
| `crosspad_input` | Send events: `click` {x,y}, `pad_press` {pad,velocity}, `pad_release`, `encoder_rotate` {delta}, `encoder_press`/`release`, `key` {keycode} |
| `crosspad_stats` | Runtime diagnostics: pad state (16 pads), capabilities, registered apps, heap usage, settings snapshot |
| `crosspad_settings` | Read settings by category or write individual keys. Auto-saves to `~/.crosspad/preferences.json` |

## Architecture

```
src/
  index.ts              — MCP server, tool registrations, streaming logger
  config.ts             — platform-aware paths (env vars, OS detection)
  utils/
    exec.ts             — runBuild/runBuildStream (MSVC on Windows, default shell on Unix)
    git.ts              — getRepoStatus(), getSubmodulePin(), getHead()
    remote-client.ts    — TCP client for simulator remote control (localhost:19840)
  tools/
    build.ts            — crosspad_build, crosspad_run
    build-check.ts      — crosspad_build_check
    log.ts              — crosspad_log
    test.ts             — crosspad_test, crosspad_test_scaffold
    repos.ts            — crosspad_repos_status
    diff-core.ts        — crosspad_diff_core
    symbols.ts          — crosspad_search_symbols
    scaffold.ts         — crosspad_scaffold_app
    architecture.ts     — crosspad_interfaces, crosspad_apps
    screenshot.ts       — crosspad_screenshot
    input.ts            — crosspad_input
    stats.ts            — crosspad_stats
    settings.ts         — crosspad_settings
```

**Static tools** (build, repos, symbols, scaffold) work without the simulator running — they operate on the filesystem and git.

**Interactive tools** (screenshot, input, stats, settings) communicate with the simulator via TCP on `localhost:19840`. The simulator includes a built-in remote control server that accepts newline-delimited JSON commands.

**Streaming** — long-running tools (build, test, log) emit output line-by-line via MCP logging notifications instead of blocking. Claude sees the output in real-time.

## Development

```bash
npm run dev    # watch mode — recompiles on save
npm run build  # one-shot build
```

After rebuilding, restart Claude Code to pick up the new server binary.

## License

Part of the [CrossPad](https://github.com/CrossPad) project. Open source.
