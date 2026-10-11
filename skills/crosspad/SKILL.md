---
name: crosspad
description: Use FIRST when starting any work in a CrossPad repo, when installing or configuring the crosspad-mcp server, or when unsure how the CrossPad ecosystem (repos, MCP tools, build/flash/sim/trace, app registry) fits together. The entry point to the whole CrossPad MCP toolkit — routes to install, per-role guides (user / firmware dev / server contributor), a tool cheat-sheet, an FAQ, and the swd-tracer skill. Run `bash scripts/doctor.sh` to check the environment.
---

# CrossPad — start here

CrossPad is a 16-pad embedded MIDI controller. Its software spans several repos,
and the **crosspad-mcp** server gives an LLM purpose-built tools to build, flash,
test, drive the simulator, search code, and manage app packages across them.

This skill is the **map**. It loads light — read a `reference/*.md` file only when
its topic comes up. For real-time SWD variable tracing on STM32 MCU, use the separate
**`swd-tracer`** skill.

## First move

```bash
bash scripts/doctor.sh        # read-only: what repos/env/server are present, and what's missing
```

(Resolve `scripts/` relative to this SKILL.md — e.g. `~/.claude/skills/crosspad/scripts/`
for a global install, or `<crosspad-mcp>/skills/crosspad/scripts/` in the repo/plugin.)

## Architecture map

```
                        ┌─────────────────────────┐
   you (LLM session) ── │   crosspad-mcp server   │ ── tools in toolsets + resources
                        └────────────┬────────────┘
                                     │ resolves repos from CROSSPAD_*_ROOT
        ┌──────────────┬─────────────┼─────────────┬───────────────┐
   crosspad-pc    platform-idf    ESP32-S3     crosspad-core    crosspad-gui
   (PC simulator) (ESP-IDF fw)   (Arduino fw)  (shared logic)   (display UI)
        └──────── apps installed as submodules from the crosspad-apps registry ┘

   CrossPad_STM32_r2  — the STM32G0B1 board firmware (separate repo; SWD trace via swd-tracer skill)
```

Only the `core` toolset is on at start. `crosspad_toolsets action=list` shows every
toolset and its tools, live; `action=enable toolset=<name>` turns one on.
`CrossPad_STM32_r2` is the GitHub repo name; the server's default folder for it is
still `$CROSSPAD_GIT_DIR/CrossPad_STM32_r20` (see `reference/install.md`).

## Routing table — "I want to … → read this"

| Goal | Open |
|------|------|
| **First-time setup** of a CrossPad workstation (ESP-IDF, crosspad-hil, first build, first flash, smoke test) | Start here: https://crosspad.app/docs/start-here/ — the site owns the human setup path; don't re-derive it |
| Install / configure the crosspad-mcp server (direct `node` launch, env vars, `.mcp.json`, plugin, Desktop) | `reference/install.md` — or run `scripts/setup.sh` for assisted install |
| Understand the repos and what lives where | `reference/repos.md` |
| Why the ecosystem is shaped this way — design principles, where code belongs | `reference/philosophy.md` |
| I'm a **user** of the MCP/firmware (build sim, flash, manage apps, drive sim) | `reference/role-user.md` |
| I'm a **firmware developer** (where the code is, interfaces, capabilities, tests) | `reference/role-fw-dev.md` |
| I'm a **crosspad-mcp contributor** (server `src/`, add a tool, dev/build/test) | `reference/role-contributor.md` |
| Which tool do I use for a task? | `reference/tools.md`; the full per-toolset list with hardware tags is https://crosspad.app/docs/reference/mcp-tools/ |
| Test on the **real device** (HIL: smoke after flash, soaks, audio/MIDI measurements, remote pad/app control) | `reference/hil-testing.md` (agent traps); the human walkthrough is https://crosspad.app/docs/how-to/hil-testing/ |
| How a firmware subsystem really works (power button, BLE MIDI memory, kit swap while playing, STM32 in-field update, CDC file transfer, HIL traps) | `platform-idf/docs/subsystems/*.md` — source of truth, published as https://crosspad.app/docs/subsystems/<name>/; `platform-idf/CLAUDE.md` keeps only the summary |
| Something is broken / a tool errors | `reference/faq.md`; user-facing fixes: https://crosspad.app/docs/troubleshooting/#mcp |
| I just learned something non-obvious — where do I record it? | `reference/memory.md` |
| Trace firmware variables in real time over SWD (ST-Link) | use the **`swd-tracer`** skill |
| Did a change move the UI or cost frames? (screenshots per app + an LVGL_STATS benchmark, before vs after) | use the **`before-after`** skill |

## Conventions

- Prefer `crosspad_*` MCP tools over raw shell (`git`, `cmake`, `idf.py`, `grep`) —
  they resolve repos dynamically and return structured errors. See `reference/tools.md`.
- Only repos that exist on disk appear in tool results; missing repos are silent.
  If a tool says a repo is undetected, see `reference/install.md` env vars.
