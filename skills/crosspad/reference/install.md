# Install & configure crosspad-mcp

The human walkthrough lives on the site: registering the server is
https://crosspad.app/docs/how-to/hil-testing/#from-claude-code-optional, and
the MCP fixes are https://crosspad.app/docs/troubleshooting/#mcp. Setting up
the rest of a CrossPad workstation (ESP-IDF, crosspad-hil, first build and
flash) is https://crosspad.app/docs/start-here/. This page keeps the minimal
commands and the traps an agent needs.

## Launch with `node`, never `npx`

`npx -y crosspad-mcp-server` crashes Claude Code's MCP client
(`MCP error -32000: Connection closed`, within ~1 s) on real dev machines in
this ecosystem: npx's own startup chatter pollutes the stdio channel, which
must carry clean JSON-RPC only. The server itself is fine; only the `npx`
launch wrapper is the problem, so retrying npx won't help. Every recipe below
launches `node …/dist/index.js` directly, and `bash scripts/setup.sh` (this
skill) does the same.

## Install (stable local copy)

```bash
npm i --prefix ~/.local/crosspad-mcp crosspad-mcp-server@latest
claude mcp add -s user crosspad -- node ~/.local/crosspad-mcp/node_modules/crosspad-mcp-server/dist/index.js
```

Restart Claude Code; the `crosspad_*` tools appear. On Windows (PowerShell) use
`$HOME\.local\crosspad-mcp` for both paths — PowerShell expands `$HOME`, but
`node` does not expand `~`.

- `-s user` registers the server for every folder. Without it, `claude mcp add`
  uses the `local` scope (this folder only). `scripts/setup.sh` registers in
  that default scope.
- Every `claude mcp add` replaces the whole `crosspad` entry, including its
  `--env` settings. Run `claude mcp get crosspad` first and repeat the `--env`
  you still need.
- Re-run the `npm i --prefix` command to pick up a new release, then restart.
  This install is independent of any `crosspad-mcp` git checkout, so it's the
  right choice for repos that just *use* the tools. If you're developing
  `crosspad-mcp` itself, see "Developing crosspad-mcp itself" below.

## Tracked `.mcp.json` (the form the CrossPad repos track)

```json
{
  "mcpServers": {
    "crosspad": {
      "type": "stdio",
      "command": "node",
      "args": ["${HOME}/.local/crosspad-mcp/node_modules/crosspad-mcp-server/dist/index.js"]
    }
  }
}
```

A tracked `.mcp.json` must never carry one person's absolute path — it is
shared with everyone who clones the repo. Claude Code expands `${VAR}` and
`${VAR:-default}` in `command`, `args` and `env`, but **not nested**
(`${A:-${B}/x}` comes out mangled), so keep it flat and put per-machine
choices in local scope (next section), which takes precedence over the file.
Add an `"env": { "CROSSPAD_IDF_ROOT": "…" }` block only in a file that is not
tracked.

## Developing crosspad-mcp itself

Register the checkout in **local scope** — it wins over the project's
`.mcp.json`, and nothing user-specific lands in git:

```bash
cd /path/to/some-crosspad-repo
claude mcp add -s local crosspad --env CROSSPAD_GIT_DIR=/path/to/GIT -- node /path/to/crosspad-mcp/dist/index.js
```

Equivalent JSON, if you prefer editing `~/.claude.json` by hand:

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

## Skills, and the plugin's second server

**Recommended:** register the server yourself with the direct `node` path
(§ Install), and add the skills without a second server — symlink them from a
clone of this repo:

```bash
git clone https://github.com/CrossPad/crosspad-mcp.git ~/crosspad-mcp   # any folder
mkdir -p ~/.claude/skills
for s in crosspad swd-tracer before-after; do ln -sfn ~/crosspad-mcp/skills/$s ~/.claude/skills/$s; done
```

The server also serves the skill pages as `skill://` resources, so a client
with no skills installed still gets them.

**The plugin** (`/plugin marketplace add CrossPad/crosspad-mcp`, then
`/plugin install crosspad@crosspad`) installs the same three skills **and adds
its own `crosspad` MCP server** from the repo's `.mcp.json`
(`node ${CLAUDE_PLUGIN_ROOT}/dist/index.js`):

- From the GitHub marketplace that server cannot start: `dist/` is not in git
  (`.gitignore`) and nothing builds it on install. You get the skills and a
  failed server entry.
- From a local path to a built checkout it does start — next to a manual
  registration that is two crosspad servers (every tool twice, two
  crosspad-hil daemons on one board), a real collision seen in this project's
  history.

So with the plugin, disable its server: `/mcp` → the plugin's `crosspad`
server → Disable, and keep your `node` registration. Or skip the plugin and
use the symlinks above.

## With custom repo paths

```bash
claude mcp add -s user crosspad \
  --env CROSSPAD_IDF_ROOT=/path/to/platform-idf \
  --env CROSSPAD_PC_ROOT=/path/to/crosspad-pc \
  --env CROSSPAD_HIL_PYTHON=/path/to/.venv/bin/python \
  -- node ~/.local/crosspad-mcp/node_modules/crosspad-mcp-server/dist/index.js
```

The server does not read `crosspad.local.json`. A project made by the
one-line installer (in `~/CrossPad`, ESP-IDF possibly in a side-by-side
folder) is found only with `CROSSPAD_IDF_ROOT` and `IDF_PATH` set, and the
HIL tools need `CROSSPAD_HIL_PYTHON` pointing at the interpreter that has
crosspad-hil (the project's `.venv`). Full recipe:
https://crosspad.app/docs/troubleshooting/#crosspad-tools-cannot-find-the-project-or-esp-idf

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) with the same
`mcpServers.crosspad` block (`"command": "node"`, `"args"` = the absolute path
to `dist/index.js`; drop the `"type"` field). Whether Desktop expands
`${HOME}` is unverified — write the path out.

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
| `CROSSPAD_STM_ROOT` | `$GIT_DIR/CrossPad_STM32_r20` | STM32 r20 firmware (build/flash/trace/symbol-search). The GitHub repo is `CrossPad_STM32_r2`, so a plain `git clone` lands in `$GIT_DIR/CrossPad_STM32_r2` — set this variable, or clone into the r20 folder name |
| `CROSSPAD_HIL_ROOT` | `$GIT_DIR/crosspad-hil` | crosspad-hil checkout (repo status, symbol search) |
| `CROSSPAD_HIL_PYTHON` | the tracer's Python (`pyocd_python` / `CROSSPAD_TRACE_PYTHON`), else `python3` | Interpreter that runs the crosspad-hil daemon — must have crosspad-hil installed. A `hil_python` key in `~/.config/crosspad-mcp/config.json` wins over this variable |
| `CROSSPAD_TOOLSETS` | — (`core` only) | Extra toolsets at start, e.g. `device,hil` or `all`; same as `--toolsets` |
| `CROSSPAD_MCP_POLICY` | mode from `~/.config/crosspad-mcp/policy.json` (path: `CROSSPAD_MCP_POLICY_FILE`) | `lab` / `strict` / `readonly`; can only make the file's mode stricter. `--read-only` = `readonly` |
| `CROSSPAD_MCP_TOKEN` | generated per run, printed on stderr | Bearer token for the HTTP transport |
| `CROSSPAD_MCP_CONFIRM` | — | `token` forces the confirm-token round trip even when the client advertises elicitation forms |
| `CROSSPAD_CLANGD` | first `clangd*` on `PATH` | clangd binary for `crosspad_symbol` |
| `IDF_PATH` | auto: `~/esp/esp-idf`, then `~/esp/v5.5.4/esp-idf`, `~/esp/v5.5/esp-idf` | ESP-IDF SDK path |
| `VCPKG_ROOT` | `~/vcpkg` / `C:/vcpkg` | vcpkg install (PC build deps) |
| `VCVARSALL` | VS2022 Community default | MSVC vcvarsall.bat (Windows only) |
| `CROSSPAD_REMOTE_PORT` | `19840` | Simulator remote-control TCP port |
| `CROSSPAD_REMOTE_HOST` | `127.0.0.1` | Simulator remote-control TCP host |

The SWD tracer has its own (`CROSSPAD_TRACE_PYTHON`, `CROSSPAD_TRACE_DIR`,
`CROSSPAD_STM_ELF`, `CROSSPAD_PROBE_SERIAL`) — see the `swd-tracer` skill.

## Node version

The server requires Node ≥ 18 (`package.json` `engines`). If `npm test`/tooling
fails with errors like `styleText is not exported from node:util`, the system
Node is too old — use Node 22 (e.g. via nvm: `nvm use 22`).

## Transports

- **stdio** (default) — `node …/dist/index.js`. For Claude Code / Desktop / IDE.
- **HTTP** — `node …/dist/index.js --http 3000` serves
  `http://127.0.0.1:3000/mcp` (stateful `Mcp-Session-Id` sessions) for MCP
  clients on the same machine, or a remote box through an SSH tunnel. It binds
  loopback only, accepts only `Host: 127.0.0.1|localhost|[::1]:<port>`
  (DNS-rebinding protection) and sends no CORS headers, so a web page on
  another origin cannot use it. Every request needs
  `Authorization: Bearer $CROSSPAD_MCP_TOKEN`; without the variable the server
  generates a token and prints it on stderr. `--http` with no number defaults
  to 3000 only as the **last** argument — `--http --read-only` exits with
  "Invalid --http port", so write the port.

Startup flags: `--toolsets a,b` (or `all`), `--read-only`. Both are listed with
the toolsets on https://crosspad.app/docs/reference/mcp-tools/.

## Verify

```bash
bash scripts/doctor.sh         # node, repos, cmake/idf.py, registration, stale dist/, .mcp.json npx scan
```

`doctor.sh` does not check Python or crosspad-hil — the `crosspad_doctor` tool
does (crosspad-hil, ESP-IDF, repos, build dirs, ports, permissions), each
finding with a fix. Or read the `crosspad://workspace` MCP resource — it lists
detected repos, branches, dirty counts, and simulator status without a tool
call. The server's start-up line on stderr is
`crosspad-mcp v<version>: policy=<mode> toolsets=<list>`.
