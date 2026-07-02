# Install & configure crosspad-mcp

## ⚠ If `crosspad_*` tools crash or never appear, skip npx

`npx -y crosspad-mcp-server` works for most setups, but has been observed on
at least one dev machine in this ecosystem to crash Claude Code's MCP client
outright (`MCP error -32000: Connection closed`, within ~1s) — npx's own
startup chatter pollutes the stdio channel the MCP client expects to carry
clean JSON-RPC only. The server itself is fine; only the `npx` launch
wrapper is the problem. If tools error like that, or silently never appear
with no clear cause, go straight to "Stable local install" below rather
than debugging npx — `bash scripts/setup.sh` (this skill) does this
automatically now instead of defaulting to npx.

## Fastest path

```bash
claude mcp add crosspad -- npx -y crosspad-mcp-server
```

Restart Claude Code; the `crosspad_*` tools appear. For an assisted,
interactive setup that also helps set repo paths — and avoids the npx issue
above — run `bash scripts/setup.sh` from this skill.

## Stable local install (recommended; required if npx crashes for you)

```bash
npm i --prefix ~/.local/crosspad-mcp crosspad-mcp-server@latest
claude mcp add crosspad -- node ~/.local/crosspad-mcp/node_modules/crosspad-mcp-server/dist/index.js
```

Or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "crosspad": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/YOU/.local/crosspad-mcp/node_modules/crosspad-mcp-server/dist/index.js"]
    }
  }
}
```

Re-run the `npm i --prefix` command to pick up a new release. This install
is independent of any `crosspad-mcp` git checkout, so it's the right choice
for repos that just *use* the tools. If you're developing `crosspad-mcp`
itself, see the next section instead.

## Developing crosspad-mcp itself

```json
{
  "mcpServers": {
    "crosspad": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/crosspad-mcp/dist/index.js"],
      "env": { "CROSSPAD_GIT_DIR": "/path/to/GIT" }
    }
  }
}
```

**After every `npm run build`, restart the Claude Code session (or reload
the window) before assuming a fix landed.** This is the single most common
false alarm in this project's own history: the MCP server process loads
`dist/` once at startup and keeps it in memory — a rebuilt `dist/` on disk
does not hot-reload into an already-connected session. If a fix "isn't
working," check whether the session predates the last build before looking
anywhere else.

## Plugin install — check for a registration collision first

`crosspad-mcp` ships as a Claude Code plugin (`.claude-plugin/`) bundling
the MCP server and skills together — `/plugin marketplace add
CrossPad/crosspad-mcp` then `/plugin install crosspad@crosspad` is the
"skill comes for free with the MCP" path. **If you already have a
manually-registered `crosspad` server** (via `claude mcp add` or a
`.mcp.json`, per the sections above), installing the plugin registers a
*second* server under the same key — a real collision seen in this
project's history. Pick one mechanism, not both. If you only want a skill
without a second MCP registration, a global-skill symlink
(`~/.claude/skills/<name>` → this repo's `skills/<name>`) works without
touching MCP registration.

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
| `CROSSPAD_STM_ROOT` | `$GIT_DIR/CrossPad_STM32_r20` | STM32 r20 firmware (build/flash/trace/symbol-search) |
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
