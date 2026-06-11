# Install & configure crosspad-mcp

## Fastest path

```bash
claude mcp add crosspad -- npx -y crosspad-mcp-server
```

Restart Claude Code; the `crosspad_*` tools appear. For an assisted, interactive
setup that also helps set repo paths, run `bash scripts/setup.sh` from this skill.

## With custom repo paths

```bash
claude mcp add crosspad \
  --env CROSSPAD_IDF_ROOT=/path/to/platform-idf \
  --env CROSSPAD_PC_ROOT=/path/to/crosspad-pc \
  -- npx -y crosspad-mcp-server
```

## Per-project `.mcp.json` (Claude Code picks it up automatically)

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

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) with the same
`mcpServers.crosspad` block (drop the `"type"` field).

## Environment variables

Each repo path is individually configurable; unset paths fall back to
`$CROSSPAD_GIT_DIR/<repo-name>` (flat layout). Only repos that exist on disk
appear in tool results.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CROSSPAD_GIT_DIR` | `~/GIT` | Base dir for the flat-layout fallback |
| `CROSSPAD_PC_ROOT` | `$GIT_DIR/crosspad-pc` | PC simulator repo |
| `CROSSPAD_IDF_ROOT` | `$GIT_DIR/platform-idf` | ESP-IDF platform repo |
| `CROSSPAD_ARDUINO_ROOT` | `$GIT_DIR/ESP32-S3` | Arduino platform repo |
| `CROSSPAD_CORE_ROOT` | `$GIT_DIR/crosspad-core` | crosspad-core (standalone) |
| `CROSSPAD_GUI_ROOT` | `$GIT_DIR/crosspad-gui` | crosspad-gui (standalone) |
| `IDF_PATH` | auto (`~/esp/esp-idf`) | ESP-IDF SDK path |
| `VCPKG_ROOT` | `~/vcpkg` / `C:/vcpkg` | vcpkg install (PC build deps) |
| `VCVARSALL` | VS2022 default | MSVC vcvarsall.bat (Windows only) |
| `CROSSPAD_REMOTE_PORT` | `19840` | Simulator remote-control TCP port |
| `CROSSPAD_REMOTE_HOST` | `127.0.0.1` | Simulator remote-control TCP host |

## Node version

The server requires Node ≥ 18 (`package.json` `engines`). If `npm test`/tooling
fails with errors like `styleText is not exported from node:util`, the system
Node is too old — use Node 22 (e.g. via nvm: `nvm use 22`).

## Transports

- **stdio** (default) — `npx crosspad-mcp-server`. For Claude Code / Desktop / IDE.
- **HTTP** — `npx crosspad-mcp-server --http 3000` exposes `http://localhost:3000/mcp`
  for remote dev boxes / browser MCP clients (stateful `Mcp-Session-Id` sessions).

## Verify

```bash
bash scripts/doctor.sh         # which repos/env resolve, is the server built, app-registry present
```

Or check the `crosspad://workspace` MCP resource — it lists detected repos,
branches, dirty counts, and simulator status without a tool call.
