# Changelog

All notable changes to crosspad-mcp-server. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [10.0.1] — 2026-08-28

Docs only. No tool, schema or behaviour change.

### Changed
- **README is an introduction now.** It opens with what you can ask for —
  eight real prompts and what runs underneath — a hero diagram, the one-line
  install, the toolset map and per-role entry points. The full reference
  (every install path, every tool and toolset, resources, configuration,
  transport, the v9 → v10 migration table) moved verbatim to
  `docs/USAGE.md`.
- Removed the last references to the scaffold tool, which no longer exists
  (app generation is `idf.py app-new` in platform-idf).
- Closed the April backlog on GitHub: 13 issues were already implemented,
  three are not planned (#8, #11, #13), one superseded (#12).

## [10.0.0] — 2026-08-28

Breaking. The server stops being a bag of shell wrappers and becomes a thin,
safe front over the [crosspad-hil](https://github.com/CrossPad/crosspad-hil)
daemon (`hilVersion` 1.0.0, spawned as `python -m crosspad_hil.serve`).

### Added
- **Toolsets.** `tools/list` starts with the `core` toolset only (8 tools).
  Everything else is registered disabled and enabled on demand with
  `crosspad_toolsets action=enable toolset=<name>`, `--toolsets a,b` or
  `CROSSPAD_TOOLSETS`. Toolsets: `core`, `device`, `hil`, `sim`, `code`, `git`,
  `apps`, `trace`.
- **Policy tiers and confirmations.** Every tool has a tier
  (`read`/`stimulus`/`mutate-host`/`danger`); annotations are derived from it.
  Danger-tier calls return `resultType="confirmation_required"` with a
  120 s `confirm_token` instead of acting, or ask the client directly when it
  supports elicitation. `--read-only` / `CROSSPAD_MCP_POLICY=readonly` hides
  every non-`read` tool.
- **Device tools over the daemon**: `crosspad_console` (boot log, `expect`,
  parsed snapshot, log file as a `resource_link`), `crosspad_cdc` (typed verbs
  from `verbs.py`), `crosspad_ui` (drive the encoder by snapshot ref),
  `crosspad_snapshot`, `crosspad_doctor`, `crosspad_usb_mode`, `crosspad_task`.
- **Handles and jobs.** `con_N` / `cdc_N` / `snap_N` / `task_N` are explicit;
  long operations (build, flash, scenarios) run as jobs polled through
  `crosspad_task {status|wait|cancel|list}` and keep results for 1 h.
- **Resources**: `crosspad://devices`, `crosspad://device/{id}/state`,
  `crosspad://device/{id}/console/log`, `crosspad://cdc`, `crosspad://sysex`,
  `crosspad://hil/catalog` (the last three cached for 1 h).
- **Eval harness** (`eval/tasks.json`, `eval/grade.ts`) for the meta-bug in
  `todo.md`: 10 recorded-transcript tasks that fail when the model shells out
  instead of calling a `crosspad_*` tool.
- **Safe DFU write order** in `crosspad_flash target=stm method=dfu`: erase
  flash page 0, program the tail, program page 0 last — a flash interrupted
  anywhere before the final 2 KB page re-enters DFU on a plain USB replug via
  the G0 ROM's empty check (verified on hardware). Pairs with STM firmware
  v1.1's post-DFU autorestart and BOOT0-pin backstop.

### Changed
- `crosspad_devices` enumerates through the daemon (`devices.list`): USB mode,
  paired STM32 bridge, MIDI ports and the UAC2 card, not just a serial list.
- `crosspad_flash` always returns a preflight (USB mode, port role, firmware
  mtime vs sources, bin version, board rev) and runs as a job.
- `crosspad_midi` and `crosspad_audio_route` talk to the daemon instead of
  shelling out to `amidi`; `crosspad_midi` gained `target: device|sim`.
- No `execSync`/`spawnSync` on the request path: `crosspad_repo_status` runs its
  per-repo git calls concurrently (limit 4) and every subprocess honours
  cancellation.

### Fixed
- **The HTTP transport was open**: `--http` bound 0.0.0.0 with no token and no
  Host check. Now loopback-only with a bearer token (generated and printed when
  unset) and DNS-rebinding protection.
- `crosspad_trace` `write`/`call` are danger tier with honest annotations —
  they poke SRAM and halt the core, and now confirm like every other danger
  verb.
- The stdio server exits when its only client closes the pipe, instead of
  piling up orphaned servers each holding a live crosspad-hil daemon (and a
  board handle) built from stale code.
- Error results no longer violate the tools' closed output schemas (the
  `details` field every error carried was undeclared, so real clients rejected
  the first error they saw); the test fake now validates input and output the
  way the SDK does, which is what had hidden all of the above.

### Removed
- The v9 inline device enumeration (`listDevices()` on the tool path).
- `logging/message` server logs (deprecated in MCP 2026-07-28); progress goes
  through `notifications/progress`.

### Requires
- `crosspad-hil` ≥ 1.0.0 on the interpreter named by the `hil_python` config
  key / `CROSSPAD_HIL_PYTHON` (falls back to the tracer's python, then
  `python3`). `crosspad_doctor` reports the version mismatch.
