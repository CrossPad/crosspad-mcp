# FAQ — common errors & pitfalls

**Q: A tool says a repo isn't detected / isn't found.**
A: Only repos present on disk appear. Set the matching `CROSSPAD_*_ROOT` env var (see
`reference/install.md`) or place the repo under `CROSSPAD_GIT_DIR` (default `~/GIT`).
Check `crosspad://workspace` to see what resolved.

**Q: The `crosspad_*` tools don't appear at all.**
A: The server isn't registered. Run `claude mcp add crosspad -- npx -y crosspad-mcp-server`
(or add `.mcp.json`), then restart Claude Code. `bash scripts/doctor.sh` confirms reachability.

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

**Q: `idf.py` / a build fails with a git "bare repository" error.**
A: A safe-directory/bare-repo guard. Override via `GIT_CONFIG` env or neutralize the guard;
re-run the build.

**Q: `crosspad_commit` refuses.**
A: It refuses on merge conflicts and never pushes. Resolve conflicts, re-stage, retry.

**Q: I want to trace firmware variables live.**
A: That's the separate `swd-tracer` skill (`crosspad_trace`) for CrossPad_STM32_r20 over
ST-Link. Run its `doctor` action first.

**Q: How do I see everything at a glance?**
A: `bash scripts/doctor.sh` (env), `crosspad_repo_status` (git), and the
`crosspad://workspace` resource (repos + sim).
