# FAQ — common errors & pitfalls

The user-facing fixes (with exact commands per OS) are on the site:
https://crosspad.app/docs/troubleshooting/#mcp for the server, and the rest of
that page for install, build, flash and HIL. This page keeps what an agent
needs to diagnose.

**Q: `crosspad_commit repo=gui` (or `repo=core`) says it's "vendored as N separate
checkouts" instead of just committing.**
A: This is intentional, not a bug — `crosspad-core`/`crosspad-gui` are vendored
as independent, unlinked submodule checkouts inside `platform-idf`,
`crosspad-pc`, and `ESP32-S3` (see `reference/repos.md`'s dual-checkout
warning). If exactly one copy exists on disk, `crosspad_commit`/
`crosspad_submodule_update` resolve to it automatically. If more than one
exists — the common case — guessing which copy you meant risks committing
to the wrong checkout, so the tool refuses and lists every copy's path
instead. Set `CROSSPAD_CORE_ROOT`/`CROSSPAD_GUI_ROOT` to the exact checkout
you're working in and retry. A parent repo's own commit does **not**
substitute for this — it only stages the submodule's pointer, not file
changes inside it.

**Q: A tool says a repo isn't detected / isn't found.**
A: Only repos present on disk appear. Set the matching `CROSSPAD_*_ROOT` env var (see
`reference/install.md`) or place the repo under `CROSSPAD_GIT_DIR` (default `~/GIT`).
Check `crosspad://workspace` to see what resolved. The server does not read
`crosspad.local.json`, so a project made by the one-line installer (`~/CrossPad`)
needs `CROSSPAD_IDF_ROOT` and `IDF_PATH`
(https://crosspad.app/docs/troubleshooting/#crosspad-tools-cannot-find-the-project-or-esp-idf).
The STM32 repo is cloned as `CrossPad_STM32_r2` but looked up as
`$CROSSPAD_GIT_DIR/CrossPad_STM32_r20` — set `CROSSPAD_STM_ROOT`.

**Q: The `crosspad_*` tools don't appear at all, or the connection errors out
immediately (`MCP error -32000: Connection closed`).**
A: Three different causes, check all. (1) Not registered — install the stable
local copy and register it with `node` (`reference/install.md` → "Install"),
then restart. (2) **Launched through `npx`** — npx's own startup output pollutes
the stdio JSON-RPC channel; this is a launch-wrapper problem, not a server bug,
so retrying npx won't help. Re-register with `node …/dist/index.js`. (3) **Only
the plugin is installed** — it brings the skills but its server cannot start
(no `dist/` in git). `bash scripts/doctor.sh` says whether *a* `crosspad` entry
is registered (it greps `claude mcp list`) and flags tracked `.mcp.json` files
that still use `npx`; `claude mcp get crosspad` shows the actual launch command.
User-facing fix: https://crosspad.app/docs/troubleshooting/#claude-shows-no-crosspad-tools

**Q: I fixed a bug / added a tool in `crosspad-mcp` and it's still broken /
missing when I use it.**
A: By far the most common false alarm in this project's history. The MCP
server loads `dist/` once at connect time and keeps it in memory — a
rebuilt `dist/` on disk does not hot-reload into an already-running session.
`npm run build`, then **restart the Claude Code session** (reload window),
before concluding the fix didn't work. Also check which `.mcp.json` config
the current session is actually using (`reference/install.md`) — a session on
the stable `~/.local/crosspad-mcp` install won't see local-repo changes at all
until they are published.

**Q: A change to `crosspad-core` or `crosspad-gui` "isn't taking effect"
after I build/flash.**
A: Almost certainly the wrong checkout. `crosspad-core`/`crosspad-gui` are
vendored as *separate, unlinked* submodule checkouts in `platform-idf/`,
`ESP32-S3/`, and `crosspad-pc/` — editing one does not change the others.
See `reference/repos.md` for which checkout each build target actually
compiles; confirm your edit is in the right one before looking further.

**Q: The HIL / device tools say crosspad-hil is missing.**
A: The daemon runs under `python3` unless `CROSSPAD_HIL_PYTHON` (or `hil_python`
in `~/.config/crosspad-mcp/config.json`) names an interpreter that has
crosspad-hil — usually the project's `.venv/bin/python`. Re-register with
`--env CROSSPAD_HIL_PYTHON=…` and restart; the doctor's `config_set
key=hil_python` hint is rejected by `config_set`. Exact commands:
https://crosspad.app/docs/troubleshooting/#hil-tools-say-crosspad-hil-is-missing

**Q: `crosspad_run` succeeds but interaction tools fail.**
A: Interactive tools talk to the running sim over TCP `localhost:19840`. Confirm the sim
is up (`crosspad_run` returns a PID + readiness probe) and that `CROSSPAD_REMOTE_PORT`/`HOST`
match. `crosspad_check platform=pc` flags a stale exe.

**Q: PC build fails on missing dependencies.**
A: The PC simulator uses vcpkg. Set `VCPKG_ROOT` (default `~/vcpkg`, `C:/vcpkg` on Windows);
on Windows also `VCVARSALL` for the MSVC environment.

**Q: IDF build can't find ESP-IDF.**
A: Set `IDF_PATH` (auto-detect tries `~/esp/esp-idf`). The build sources the IDF export env.

**Q: `npm test` / tooling fails with "styleText is not exported from node:util" (or similar).**
A: System Node is too old. Use Node 22 (e.g. `nvm use 22`). Server runtime needs Node ≥ 18.

**Q: `idf.py` / a build fails with a git "bare repository" error
(`git config --get remote.origin.url failed with exit code 1`).**
A: Claude Code itself injects `GIT_CONFIG_KEY_0=safe.bareRepository
VALUE_0=explicit` into every subprocess it spawns — command-line git config
outranks global config, so `git config --global safe.bareRepository all`
cannot override it, and the ESP-IDF component manager's bare-repo dependency
cache (esp-now) trips on it. `crosspad_build platform=idf` already
neutralizes this (`src/utils/exec.ts` `neutralizeGitBareGuard`, flips it to
`all` in the build's own env) — if you're hitting this via `crosspad_build`
anyway, you're on a stale server build; see the "still broken after I fixed
it" entry above. Running `idf.py` directly (not through the MCP tool) still
needs the manual override: prefix with `GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=safe.bareRepository GIT_CONFIG_VALUE_0=all` (site:
https://crosspad.app/docs/troubleshooting/#build-in-claude-code-fails-with-a-bare-repository-error).

**Q: `crosspad_commit` refuses.**
A: It refuses on merge conflicts and never pushes. Resolve conflicts, re-stage, retry.

**Q: I want to trace firmware variables live.**
A: That's the separate `swd-tracer` skill (`crosspad_trace`) for CrossPad_STM32_r2 over
ST-Link. Run its `doctor` action first.

**Q: `crosspad_trace action=start` (or `action=ui`) drops the MCP connection.**
A: Known open issue as of this writing — MCP-layer, not the tracer daemon
itself (the daemon/web UI work fine when driven directly). If you hit this,
work around it by using the standalone dashboard path instead of the MCP
tool for that step: instantiate `Dashboard` from `dist/tools/trace-webui.js`
directly, or drive `tracer/swd_tracer.py` as a subprocess and open
`http://localhost:7373` yourself. Worth a fresh look if you're touching
`crosspad_trace`'s MCP-side plumbing.

**Q: `crosspad_build platform=stm` fails on a clean/reconfigure, but works
incrementally.**
A: `arm-none-eabi-gcc` isn't on the default `PATH` — it lives in the VSCode
snap STM32Cube bundle
(`~/snap/code/current/.local/share/stm32cube/bundles/gnu-tools-for-stm32/<ver>/bin`).
A configured `build/Debug` has the resolved compiler path cached in
`CMakeCache.txt`, so incremental builds work; a clean/reconfigure re-resolves
the compiler from `PATH` and fails. Export that bundle's `bin/` onto `PATH`
before a clean build, or just avoid `mode=clean`/wiping `build/Debug` — see
`docs/gotchas.md` in the `CrossPad_STM32_r2` repo for the exact export line, and
https://crosspad.app/docs/troubleshooting/#stm32-build-cannot-find-arm-none-eabi-gcc-or-stops-at-flash_guard
for the user-facing fix (and the `flash_guard` size stop an old compiler causes).

**Q: How do I see everything at a glance?**
A: `bash scripts/doctor.sh` (env), `crosspad_repo_status` (git), and the
`crosspad://workspace` resource (repos + sim).
