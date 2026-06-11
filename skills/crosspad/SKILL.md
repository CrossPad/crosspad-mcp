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
   you (LLM session) ── │   crosspad-mcp server   │ ── 28 tools + resources
                        └────────────┬────────────┘
                                     │ resolves repos from CROSSPAD_*_ROOT
        ┌──────────────┬─────────────┼─────────────┬───────────────┐
   crosspad-pc    platform-idf    ESP32-S3     crosspad-core    crosspad-gui
   (PC simulator) (ESP-IDF fw)   (Arduino fw)  (shared logic)   (display UI)
        └──────── apps installed as submodules from the crosspad-apps registry ┘

   CrossPad_STM32_r20  — the STM32G0B1 board firmware (separate repo; SWD trace via swd-tracer skill)
```

## Routing table — "I want to … → read this"

| Goal | Open |
|------|------|
| Install / configure the crosspad-mcp server (Node, env vars, `.mcp.json`, Desktop) | `reference/install.md` — or run `scripts/setup.sh` for assisted install |
| Understand the repos and what lives where | `reference/repos.md` |
| I'm a **user** of the MCP/firmware (build sim, flash, manage apps, drive sim) | `reference/role-user.md` |
| I'm a **firmware developer** (where the code is, interfaces, capabilities, tests) | `reference/role-fw-dev.md` |
| I'm a **crosspad-mcp contributor** (server `src/`, add a tool, dev/build/test) | `reference/role-contributor.md` |
| Which tool do I use for a task? | `reference/tools.md` |
| Something is broken / a tool errors | `reference/faq.md` |
| Trace firmware variables in real time over SWD (ST-Link) | use the **`swd-tracer`** skill |

## Conventions

- Prefer `crosspad_*` MCP tools over raw shell (`git`, `cmake`, `idf.py`, `grep`) —
  they resolve repos dynamically and return structured errors. See `reference/tools.md`.
- Only repos that exist on disk appear in tool results; missing repos are silent.
  If a tool says a repo is undetected, see `reference/install.md` env vars.
