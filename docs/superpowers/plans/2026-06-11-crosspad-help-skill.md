# CrossPad `crosspad` onboarding skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level `crosspad` skill (thin router + reference docs + diagnose/setup scripts) that a fresh agent uses first to learn the CrossPad ecosystem and get crosspad-mcp installed/configured, and promote it via the plugin manifest and MCP server instructions.

**Architecture:** New `skills/crosspad/` skill packaged as the plugin headline (swd-tracer demoted to secondary). `SKILL.md` is a minimal router; per-topic detail lives in `reference/*.md` loaded on demand; `scripts/doctor.sh` (read-only diagnose) and `scripts/setup.sh` (assisted install). A new vitest spec asserts the manifests, the skill files, and the server-instructions hook all stay consistent.

**Tech Stack:** Markdown skill files, Bash scripts (mirroring `skills/swd-tracer/scripts/` style), TypeScript MCP server (`src/index.ts`), vitest.

---

## File Structure

- `.claude-plugin/plugin.json` — MODIFY: rename plugin `crosspad-swd-tracer` → `crosspad`, broaden description to "MCP server + crosspad (onboarding) + swd-tracer skills".
- `.claude-plugin/marketplace.json` — MODIFY: single plugin entry renamed to `crosspad`, description updated.
- `src/index.ts` — MODIFY: append one onboarding-skill-first line to `SERVER_INSTRUCTIONS`.
- `src/skills.test.ts` — CREATE: vitest spec validating manifests + skill files + server-instructions hook.
- `skills/crosspad/SKILL.md` — CREATE: router (TOC + architecture map + routing table + first move).
- `skills/crosspad/reference/install.md` — CREATE.
- `skills/crosspad/reference/repos.md` — CREATE.
- `skills/crosspad/reference/role-user.md` — CREATE.
- `skills/crosspad/reference/role-fw-dev.md` — CREATE.
- `skills/crosspad/reference/role-contributor.md` — CREATE.
- `skills/crosspad/reference/tools.md` — CREATE.
- `skills/crosspad/reference/faq.md` — CREATE.
- `skills/crosspad/scripts/doctor.sh` — CREATE (read-only).
- `skills/crosspad/scripts/setup.sh` — CREATE (mutating, idempotent).
- `README.md` — MODIFY: add a short "Skills" pointer to the `crosspad` skill as the entry point.

---

## Task 1: Plugin manifests — rename to `crosspad`

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Test: `src/skills.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/skills.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const readJson = (p: string) => JSON.parse(read(p));

describe("plugin manifests", () => {
  it("plugin.json is named crosspad and mentions both skills", () => {
    const pj = readJson(".claude-plugin/plugin.json");
    expect(pj.name).toBe("crosspad");
    expect(pj.description).toMatch(/swd-tracer/);
    expect(pj.description).toMatch(/onboard|help|getting started/i);
  });

  it("marketplace.json exposes one plugin named crosspad", () => {
    const mp = readJson(".claude-plugin/marketplace.json");
    expect(mp.plugins).toHaveLength(1);
    expect(mp.plugins[0].name).toBe("crosspad");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/skills.test.ts`
Expected: FAIL — `plugin.json` name is still `crosspad-swd-tracer`.

- [ ] **Step 3: Edit `.claude-plugin/plugin.json`**

Replace the `name` and `description` fields:

```json
{
  "name": "crosspad",
  "description": "CrossPad development toolkit: the crosspad-mcp server plus two Claude Code skills — `crosspad` (onboarding/help: ecosystem map, install & config, per-role guides, tool cheat-sheet, FAQ — use this first) and `swd-tracer` (real-time SWD variable tracing for CrossPad r20 / STM32G0B1 firmware over ST-Link).",
  "version": "8.1.2",
  "author": {
    "name": "Mateusz Czarnecki"
  },
  "homepage": "https://github.com/CrossPad/crosspad-mcp",
  "repository": {
    "type": "git",
    "url": "https://github.com/CrossPad/crosspad-mcp.git"
  },
  "license": "MIT"
}
```

- [ ] **Step 4: Edit `.claude-plugin/marketplace.json`**

```json
{
  "name": "crosspad",
  "owner": {
    "name": "CrossPad"
  },
  "plugins": [
    {
      "name": "crosspad",
      "source": "./",
      "description": "crosspad-mcp server + the `crosspad` onboarding skill (ecosystem map, install/config, per-role guides) and the `swd-tracer` skill (STM32G0B1 real-time SWD tracing over ST-Link)."
    }
  ]
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/skills.test.ts`
Expected: PASS (the two manifest tests).

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json src/skills.test.ts
git commit -m "feat(plugin): rename plugin to crosspad, headline the onboarding skill"
```

---

## Task 2: Server instructions — onboarding-skill-first hook

**Files:**
- Modify: `src/index.ts:53-71` (the `SERVER_INSTRUCTIONS` template literal)
- Test: `src/skills.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `src/skills.test.ts`:

```ts
describe("server instructions", () => {
  it("points new sessions at the crosspad skill first", () => {
    const src = read("src/index.ts");
    // The SERVER_INSTRUCTIONS template must mention the onboarding skill.
    expect(src).toMatch(/SERVER_INSTRUCTIONS\s*=/);
    const block = src.split("SERVER_INSTRUCTIONS")[1] ?? "";
    expect(block).toMatch(/`crosspad` skill/);
    expect(block).toMatch(/first/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/skills.test.ts -t "crosspad skill first"`
Expected: FAIL — no such line in `SERVER_INSTRUCTIONS`.

- [ ] **Step 3: Edit `src/index.ts`**

In the `SERVER_INSTRUCTIONS` template literal, insert a new line immediately after the `WHEN TO USE THESE TOOLS …` intro line (after line 56) so it is prominent:

```
NEW TO A CROSSPAD REPO OR SETTING UP? Use the \`crosspad\` skill first — it maps the ecosystem (repos, MCP tools, roles), walks install/config, and routes to per-role guides + an FAQ. Run \`bash scripts/doctor.sh\` from that skill to check your environment.
```

The literal already escapes backticks with `\``; keep that style. Place the line as its own paragraph between the intro sentence and the `WHEN TO USE THESE TOOLS` block (or directly under the intro `(repos: …)` sentence).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/skills.test.ts -t "crosspad skill first"`
Expected: PASS.

- [ ] **Step 5: Build to confirm no TS break**

Run: `npm run build`
Expected: `tsc` exits 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/skills.test.ts
git commit -m "feat(mcp): point new sessions at the crosspad onboarding skill first"
```

---

## Task 3: SKILL.md router

**Files:**
- Create: `skills/crosspad/SKILL.md`
- Test: `src/skills.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `src/skills.test.ts`:

```ts
describe("crosspad skill", () => {
  const dir = "skills/crosspad";

  it("SKILL.md has name: crosspad frontmatter and a routing table", () => {
    const md = read(`${dir}/SKILL.md`);
    expect(md).toMatch(/^---[\s\S]*?\nname:\s*crosspad\s*\n[\s\S]*?---/);
    expect(md).toMatch(/reference\/install\.md/);
    expect(md).toMatch(/reference\/faq\.md/);
    expect(md).toMatch(/swd-tracer/);
    expect(md).toMatch(/scripts\/doctor\.sh/);
  });

  it("ships all reference files", () => {
    for (const f of [
      "install.md", "repos.md", "role-user.md", "role-fw-dev.md",
      "role-contributor.md", "tools.md", "faq.md",
    ]) {
      expect(existsSync(resolve(root, dir, "reference", f))).toBe(true);
    }
  });

  it("ships executable doctor.sh and setup.sh", () => {
    for (const f of ["doctor.sh", "setup.sh"]) {
      const p = resolve(root, dir, "scripts", f);
      expect(existsSync(p)).toBe(true);
      // owner-executable bit set
      expect(statSync(p).mode & 0o100).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/skills.test.ts -t "crosspad skill"`
Expected: FAIL — `skills/crosspad/SKILL.md` does not exist.

- [ ] **Step 3: Create `skills/crosspad/SKILL.md`**

```markdown
---
name: crosspad
description: Use FIRST when starting any work in a CrossPad repo, when installing or configuring the crosspad-mcp server, or when unsure how the CrossPad ecosystem (repos, MCP tools, build/flash/sim/trace, app registry) fits together. The entry point to the whole CrossPad MCP toolkit — routes to install, per-role guides (user / firmware dev / server contributor), a tool cheat-sheet, an FAQ, and the swd-tracer skill. Run `bash scripts/doctor.sh` to check the environment.
---

# CrossPad — start here

CrossPad is a 16-pad embedded MIDI controller. Its software spans several repos,
and the **crosspad-mcp** server gives an LLM purpose-built tools to build, flash,
test, drive the simulator, search code, and manage app packages across them.

This skill is the **map**. It loads light — read a `reference/*.md` file only when
its topic comes up. For real-time SWD variable tracing, use the separate
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
```

- [ ] **Step 4: Run test to verify the SKILL.md assertion passes**

Run: `npx vitest run src/skills.test.ts -t "routing table"`
Expected: the `SKILL.md` frontmatter/routing assertion PASSES (the reference-files and scripts assertions still FAIL — created in later tasks).

- [ ] **Step 5: Commit**

```bash
git add skills/crosspad/SKILL.md src/skills.test.ts
git commit -m "feat(skill): add crosspad router SKILL.md"
```

---

## Task 4: reference/install.md and reference/repos.md

**Files:**
- Create: `skills/crosspad/reference/install.md`
- Create: `skills/crosspad/reference/repos.md`

- [ ] **Step 1: Create `skills/crosspad/reference/install.md`**

```markdown
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
```

- [ ] **Step 2: Create `skills/crosspad/reference/repos.md`**

```markdown
# CrossPad repos — what lives where

The crosspad-mcp server discovers these dynamically from `CROSSPAD_*_ROOT`
(see `reference/install.md`). Only repos present on disk show up in tool results.

| Repo | Env var | What it is |
|------|---------|-----------|
| **crosspad-pc** | `CROSSPAD_PC_ROOT` | Desktop **simulator** — runs the firmware logic on the host (CMake/Ninja + vcpkg). Build with `crosspad_build platform=pc`, launch with `crosspad_run`. |
| **platform-idf** | `CROSSPAD_IDF_ROOT` | **ESP-IDF** firmware for the ESP32-S3 sidekick. Build with `crosspad_build platform=idf`, flash with `crosspad_flash transport=uart\|ota`. |
| **ESP32-S3** | `CROSSPAD_ARDUINO_ROOT` | Arduino-framework variant of the ESP32-S3 firmware. |
| **crosspad-core** | `CROSSPAD_CORE_ROOT` | Shared, platform-independent logic + **interfaces** (the contract PC/IDF/Arduino implement). Browse with `crosspad_list_interfaces` / `crosspad_interface_implementations`. |
| **crosspad-gui** | `CROSSPAD_GUI_ROOT` | Display/UI layer. |
| **crosspad-apps** | (registry) | App package **registry**. Apps install into a platform repo as git submodules via `crosspad_apps_*` tools. |
| **CrossPad_STM32_r20** | (STM repo) | STM32G0B1 single-board firmware. Real-time variable tracing over SWD lives in the **`swd-tracer`** skill, not here. |

## How they relate

- **crosspad-core** defines interfaces; **crosspad-pc**, **platform-idf**, and
  **ESP32-S3** are concrete platforms implementing them. Same app logic, three targets.
- **Apps** are reusable behaviors (instruments, sequencers, utilities) pulled from
  the **crosspad-apps** registry into a platform repo as submodules.
- The **PC simulator** is the fast iteration loop — build/run/screenshot/input on
  the host before flashing real hardware.

## Inspecting state

- `crosspad_repo_status` — git status across every detected repo at once.
- `crosspad_repo_diff` — submodule drift in crosspad-pc / platform-idf.
- `crosspad://workspace` resource — JSON snapshot of repos, branches, dirty counts, sim status.
```

- [ ] **Step 3: Commit**

```bash
git add skills/crosspad/reference/install.md skills/crosspad/reference/repos.md
git commit -m "docs(skill): add install + repos reference"
```

---

## Task 5: Per-role reference guides

**Files:**
- Create: `skills/crosspad/reference/role-user.md`
- Create: `skills/crosspad/reference/role-fw-dev.md`
- Create: `skills/crosspad/reference/role-contributor.md`

- [ ] **Step 1: Create `skills/crosspad/reference/role-user.md`**

```markdown
# Role: MCP / firmware user

You build and drive CrossPad firmware (mostly the PC simulator) and manage apps.
You are not editing the crosspad-mcp server itself.

## Typical loop (PC simulator)

```
crosspad_check  platform=pc      # stale exe? new sources? submodule drift?
crosspad_build  platform=pc      # mode: incremental | clean | reconfigure; build_type for Debug/Release
crosspad_run    platform=pc      # launch sim, returns PID + TCP readiness probe
... interact (below) ...
crosspad_kill   platform=pc      # stop it when done
```

## Driving the running simulator

| Want | Tool |
|------|------|
| See the screen | `crosspad_screenshot` (file path; `return_inline` for base64) |
| Press pads / encoder / keys | `crosspad_input` (`action`: pad_press/release, encoder_*, click, key) |
| Send MIDI | `crosspad_midi` (`type`: note_on/off, cc, program_change) |
| Inspect runtime state | `crosspad_stats` (pads, capabilities, heap, apps) |
| Read/write settings | `crosspad_settings_get` / `crosspad_settings_set` |

## Flashing hardware

```
crosspad_build platform=idf            # build ESP-IDF firmware
crosspad_flash transport=uart          # or transport=ota with firmware_path
crosspad_log   target=idf              # read serial logs
crosspad_devices                       # list USB serial devices, flag CrossPads
```

## Managing apps (crosspad-apps registry)

| Want | Tool |
|------|------|
| List apps + where installed | `crosspad_apps_list` |
| Install an app (as submodule) | `crosspad_apps_install` (`platform`, `app_name`, `ref`, `force`) |
| Remove an app | `crosspad_apps_remove` |
| Update one / all apps | `crosspad_apps_update` (`app_name` or `update_all`) |
| Rebuild manifest from disk | `crosspad_apps_sync` |

Use these instead of manual `git submodule` operations.

## If something breaks

See `reference/faq.md` (repo not detected, sim won't start, build deps, …).
```

- [ ] **Step 2: Create `skills/crosspad/reference/role-fw-dev.md`**

```markdown
# Role: firmware developer

You edit CrossPad firmware/core logic. Use the MCP tools to navigate and verify
across repos instead of raw shell.

## Find code (prefer over `grep -r`)

| Want | Tool |
|------|------|
| A class/function/macro/enum/typedef definition | `crosspad_search_symbols` |
| List crosspad-core interfaces | `crosspad_list_interfaces` |
| Find implementations of an interface | `crosspad_interface_implementations` |
| Capability flags + per-platform sets | `crosspad_capabilities` |
| Apps registered via `REGISTER_APP()` | `crosspad_list_apps_source` |
| One symbol in one repo (MCP resource) | `crosspad://symbols/{repo}/{symbol}` |

## Architecture to keep in mind

- **crosspad-core** owns the interfaces; platforms (crosspad-pc, platform-idf,
  ESP32-S3) implement them. Add behavior at the right layer — shared logic in core,
  platform specifics in the platform repo. See `reference/repos.md`.
- The **PC simulator** is the fastest verify loop: build/run/screenshot/input on the
  host (`reference/role-user.md`) before touching hardware.

## Build & test

```
crosspad_build    platform=pc          # or platform=idf
crosspad_test_run                      # build + run Catch2 suite (filter, list_only)
crosspad_check    platform=pc          # health: stale exe, new sources, submodule drift
```

`crosspad_build` parses compiler output into a structured `errors[]` — read those
rather than scrolling raw logs.

## Committing across repos

`crosspad_commit` commits staged changes with correct multi-repo paths and refuses
on merge conflicts (never pushes). Use it instead of raw `git commit`.

## Real-time variable tracing

For live RAM-variable plots on the STM32 board (CrossPad_STM32_r20), use the
**`swd-tracer`** skill (`crosspad_trace` tool) — not covered here.
```

- [ ] **Step 3: Create `skills/crosspad/reference/role-contributor.md`**

```markdown
# Role: crosspad-mcp server contributor

You are developing the crosspad-mcp server itself (this repo).

## Setup

```bash
git clone https://github.com/CrossPad/crosspad-mcp.git
cd crosspad-mcp
npm install
npm run dev          # tsc --watch
npm run build        # one-shot tsc → dist/
npm test             # vitest run
npm run test:watch   # vitest watch
```

Node ≥ 18; use Node 22 if tooling complains about missing `node:` exports.

## Layout

```
src/
  index.ts            — tool registrations (one tool per action) + SERVER_INSTRUCTIONS
  config.ts           — per-repo env vars, dynamic repo discovery, IDF/MSVC paths
  utils/
    exec.ts           — platform-aware command execution (MSVC/IDF/shell)
    git.ts            — repo status, submodule pins
    remote-client.ts  — TCP client for the simulator (localhost:19840)
  tools/
    app-manager.ts    — crosspad_apps: registry + Python subprocess
    architecture.ts   — interfaces, REGISTER_APP scan
    build.ts          — PC build + run
    build-check.ts    — build health check
    diff-core.ts      — submodule drift analysis
    idf-build.ts      — ESP-IDF build
    input.ts          — simulator input events
    log.ts            — log capture
    repos.ts          — multi-repo git status
    scaffold.ts       — app boilerplate generation
    screenshot.ts     — simulator screenshots
    settings.ts       — simulator settings R/W
    stats.ts          — simulator runtime stats
    symbols.ts        — cross-repo symbol search
    test.ts           — Catch2 test runner
    *.test.ts         — unit tests per module (vitest, fs mocking)
```

## Adding a tool

1. Implement the logic in a focused `src/tools/<name>.ts` (+ `<name>.test.ts`).
2. Register it in `src/index.ts` with a zod schema (validate ranges/enums) and the
   right MCP annotations: `readOnlyHint` for status/search/list, `destructiveHint`
   for mutating ops (clients use these to decide on confirmation prompts).
3. Return the uniform envelope `{ success: boolean, ...data, error?: string }`; set
   `isError: true` on failure so clients route errors distinctly.
4. If the tool changes how a user should work, update `SERVER_INSTRUCTIONS` and the
   relevant `skills/crosspad/reference/*.md`.
5. `npm run build` then `npm test`.

## Conventions

- One tool = one action with a strict schema. Stream long-running output via MCP
  logging (build/test/log) so the client sees progress.
- Keep files focused; mirror the existing module-per-concern split.
```

- [ ] **Step 4: Commit**

```bash
git add skills/crosspad/reference/role-user.md skills/crosspad/reference/role-fw-dev.md skills/crosspad/reference/role-contributor.md
git commit -m "docs(skill): add per-role reference guides"
```

---

## Task 6: reference/tools.md and reference/faq.md

**Files:**
- Create: `skills/crosspad/reference/tools.md`
- Create: `skills/crosspad/reference/faq.md`

- [ ] **Step 1: Create `skills/crosspad/reference/tools.md`**

```markdown
# Tool cheat-sheet — grouped by task

28 tools. All return `{ success, ...data, error? }`; failures also set `isError: true`.
Read-only tools (status/search/list) skip client confirmation prompts; destructive
ones (commit, flash, clean build, apps_install) trigger one.

## Build & flash
| Tool | Use |
|------|-----|
| `crosspad_build` | Build `platform: pc\|idf` (`mode`, `build_type` for PC) |
| `crosspad_run` | Launch built simulator (`platform: pc`) → PID + TCP readiness |
| `crosspad_kill` | Stop running simulator (`platform: pc`) |
| `crosspad_check` | Health check (`platform: pc`): stale exe, new sources, drift |
| `crosspad_flash` | Flash firmware (`transport: uart\|ota`, `port?`, `firmware_path?`) |
| `crosspad_log` | Capture logs (`target: pc\|idf`) |
| `crosspad_devices` | List USB serial devices, flag CrossPads |
| `crosspad_trace` | Real-time SWD variable trace (STM32) — see the `swd-tracer` skill |

## Tests
| `crosspad_test_run` | Build + run Catch2 suite (`filter`, `list_only`) |

## Simulator interaction
| Tool | Use |
|------|-----|
| `crosspad_screenshot` | PNG screenshot (`return_inline` for base64) |
| `crosspad_input` | Input events (`action`: pad_press/release, encoder_*, click, key) |
| `crosspad_midi` | MIDI events (`type`: note_on/off, cc, program_change) |
| `crosspad_stats` | Runtime state: pads, capabilities, heap, apps |
| `crosspad_settings_get` / `crosspad_settings_set` | Read/write settings |

## Git / repos
| Tool | Use |
|------|-----|
| `crosspad_repo_status` | git status across all detected repos |
| `crosspad_repo_diff` | Submodule drift (crosspad-pc / platform-idf) |
| `crosspad_submodule_update` | Update submodule to `origin/<branch>` + stage |
| `crosspad_commit` | Commit staged changes (refuses on conflicts; never pushes) |

## Code search & scaffolding
| Tool | Use |
|------|-----|
| `crosspad_search_symbols` | Find class/function/macro/enum/typedef defs |
| `crosspad_list_interfaces` | List crosspad-core interfaces |
| `crosspad_interface_implementations` | Find implementations of an interface |
| `crosspad_capabilities` | Capability flags + per-platform sets |
| `crosspad_list_apps_source` | Apps registered via `REGISTER_APP()` |

## App package manager
| Tool | Use |
|------|-----|
| `crosspad_apps_list` | Apps from registry + where installed |
| `crosspad_apps_install` | Install app as submodule (`platform`, `app_name`, `ref`, `force`) |
| `crosspad_apps_remove` | Remove installed app submodule |
| `crosspad_apps_update` | Update one (`app_name`) or all (`update_all`) |
| `crosspad_apps_sync` | Rebuild manifest from disk |

## Resources (loadable without a tool call)
| URI | Use |
|-----|-----|
| `crosspad://workspace` | Detected repos, branches, HEADs, dirty counts, sim status |
| `crosspad://apps/registry/<platform>` | Raw `app-registry.json` per platform |
| `crosspad://apps/installed/<platform>` | Raw installed `apps.json` per platform |
| `crosspad://symbols/{repo}/{symbol}` | Resolve one symbol in `<repo>` (or `all`) |

> v8 note: platform/transport is an arg, not part of the tool name
> (e.g. `crosspad_build platform=pc`, not `crosspad_build_pc`).
```

- [ ] **Step 2: Create `skills/crosspad/reference/faq.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
git add skills/crosspad/reference/tools.md skills/crosspad/reference/faq.md
git commit -m "docs(skill): add tool cheat-sheet + FAQ"
```

---

## Task 7: scripts/doctor.sh (read-only diagnose)

**Files:**
- Create: `skills/crosspad/scripts/doctor.sh`

- [ ] **Step 1: Create `skills/crosspad/scripts/doctor.sh`**

```bash
#!/usr/bin/env bash
# CrossPad environment doctor — read-only. Reports which repos/env/server/registry
# are present and what to do about gaps. Writes nothing.
set -uo pipefail

GIT_DIR="${CROSSPAD_GIT_DIR:-$HOME/GIT}"

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
miss() { printf '  \033[31mMISS\033[0m %s\n' "$1"; }
info() { printf '  \033[33m..\033[0m   %s\n' "$1"; }

echo "== CrossPad environment =="

# 1. Node
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version)"
  NODE_MAJ="${NODE_V#v}"; NODE_MAJ="${NODE_MAJ%%.*}"
  if [ "${NODE_MAJ:-0}" -ge 18 ]; then ok "Node $NODE_V (>= 18)"
  else miss "Node $NODE_V is < 18 — use Node 18+ (e.g. nvm use 22)"; fi
else
  miss "node not found — install Node >= 18"
fi

# 2. Repos (only those present matter)
repo_check() { # $1 = env var name, $2 = default subdir, $3 = label
  local val="${!1:-$GIT_DIR/$2}"
  if [ -d "$val/.git" ] || [ -d "$val" ] && [ -n "$(ls -A "$val" 2>/dev/null)" ]; then
    ok "$3: $val"
  else
    info "$3 not at $val — set \$$1 if it lives elsewhere"
  fi
}
repo_check CROSSPAD_PC_ROOT      crosspad-pc   "crosspad-pc (PC sim)"
repo_check CROSSPAD_IDF_ROOT     platform-idf  "platform-idf (ESP-IDF)"
repo_check CROSSPAD_ARDUINO_ROOT ESP32-S3      "ESP32-S3 (Arduino)"
repo_check CROSSPAD_CORE_ROOT    crosspad-core "crosspad-core"
repo_check CROSSPAD_GUI_ROOT     crosspad-gui  "crosspad-gui"

# 3. Toolchains (best-effort, informational)
command -v cmake  >/dev/null 2>&1 && ok "cmake present" || info "cmake not found (needed for PC build)"
command -v idf.py >/dev/null 2>&1 && ok "idf.py present" || info "idf.py not on PATH (source ESP-IDF export.sh for firmware build)"
[ -n "${IDF_PATH:-}" ] && ok "IDF_PATH=$IDF_PATH" || info "IDF_PATH unset (auto-detect tries ~/esp/esp-idf)"
[ -n "${VCPKG_ROOT:-}" ] && ok "VCPKG_ROOT=$VCPKG_ROOT" || info "VCPKG_ROOT unset (PC build deps; default ~/vcpkg)"

# 4. crosspad-mcp server: is it registered with Claude?
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -qi crosspad; then
    ok "crosspad MCP server registered with Claude"
  else
    miss "crosspad MCP server not registered — run scripts/setup.sh or: claude mcp add crosspad -- npx -y crosspad-mcp-server"
  fi
else
  info "claude CLI not found — can't check MCP registration"
fi

# 5. Local server build (only relevant when run from inside the repo)
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." 2>/dev/null && pwd)"
if [ -f "$REPO_ROOT/package.json" ] && grep -q '"crosspad-mcp-server"' "$REPO_ROOT/package.json" 2>/dev/null; then
  if [ -f "$REPO_ROOT/dist/index.js" ]; then ok "server built: $REPO_ROOT/dist/index.js"
  else miss "server not built — run 'npm run build' in $REPO_ROOT"; fi
fi

echo "== done =="
echo "Next: read reference/install.md (setup) or reference/role-*.md (your role). For trace: swd-tracer skill."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x skills/crosspad/scripts/doctor.sh`

- [ ] **Step 3: Syntax-check and smoke-run**

Run: `bash -n skills/crosspad/scripts/doctor.sh && bash skills/crosspad/scripts/doctor.sh`
Expected: parses cleanly; prints an `== CrossPad environment ==` report with OK/MISS/.. lines and exits 0 (it must not error even when repos/claude are absent).

- [ ] **Step 4: Commit**

```bash
git add skills/crosspad/scripts/doctor.sh
git commit -m "feat(skill): add read-only environment doctor.sh"
```

---

## Task 8: scripts/setup.sh (assisted install)

**Files:**
- Create: `skills/crosspad/scripts/setup.sh`

- [ ] **Step 1: Create `skills/crosspad/scripts/setup.sh`**

```bash
#!/usr/bin/env bash
# CrossPad assisted setup — registers the crosspad-mcp server with Claude and
# helps set repo env vars. Idempotent: safe to re-run. Prompts before changes;
# pass --yes to accept defaults non-interactively.
set -uo pipefail

YES=0
[ "${1:-}" = "--yes" ] && YES=1

ask() { # $1 = prompt, $2 = default; echoes the answer
  local ans
  if [ "$YES" = "1" ]; then echo "$2"; return; fi
  read -r -p "$1 [$2]: " ans
  echo "${ans:-$2}"
}

echo "== CrossPad setup =="

# 1. Node check (hard requirement)
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node is required (>= 18). Install it (e.g. via nvm) and re-run." >&2
  exit 1
fi

# 2. claude CLI check
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found. Install Claude Code, then re-run — or add the server"
  echo "manually via a .mcp.json (see reference/install.md)."
  exit 1
fi

# 3. Already registered?
if claude mcp list 2>/dev/null | grep -qi crosspad; then
  echo "crosspad MCP server already registered. Nothing to do."
  echo "(Re-add with different env? Remove first: claude mcp remove crosspad)"
  exit 0
fi

# 4. Collect repo paths (only pass env for ones the user confirms exist)
GIT_DIR="${CROSSPAD_GIT_DIR:-$HOME/GIT}"
PC_ROOT="$(ask 'crosspad-pc repo path'  "$GIT_DIR/crosspad-pc")"
IDF_ROOT="$(ask 'platform-idf repo path' "$GIT_DIR/platform-idf")"

ENV_ARGS=()
[ -d "$PC_ROOT" ]  && ENV_ARGS+=(--env "CROSSPAD_PC_ROOT=$PC_ROOT")
[ -d "$IDF_ROOT" ] && ENV_ARGS+=(--env "CROSSPAD_IDF_ROOT=$IDF_ROOT")

# 5. Register
echo "Registering crosspad MCP server..."
claude mcp add crosspad "${ENV_ARGS[@]}" -- npx -y crosspad-mcp-server

echo "== done =="
echo "Restart Claude Code, then run scripts/doctor.sh to verify."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x skills/crosspad/scripts/setup.sh`

- [ ] **Step 3: Syntax-check (do NOT run live — it mutates Claude config)**

Run: `bash -n skills/crosspad/scripts/setup.sh`
Expected: parses with no error. (Do not execute it in the plan — it registers an MCP server.)

- [ ] **Step 4: Commit**

```bash
git add skills/crosspad/scripts/setup.sh
git commit -m "feat(skill): add assisted setup.sh"
```

---

## Task 9: README pointer + full verification

**Files:**
- Modify: `README.md`
- Test: `src/skills.test.ts` (full run)

- [ ] **Step 1: Add a Skills section to `README.md`**

Insert immediately after the `## Install` section (before `## Tools (28) + resources`):

```markdown
## Skills (start here)

This package ships two Claude Code skills (bundled in the `crosspad` plugin):

- **`crosspad`** — the entry point. An ecosystem map, install/config guide, per-role
  guides (user / firmware dev / server contributor), a tool cheat-sheet, and an FAQ.
  A fresh agent should read this first. Lives at `skills/crosspad/SKILL.md`;
  run `bash skills/crosspad/scripts/doctor.sh` to check your environment.
- **`swd-tracer`** — real-time SWD variable tracing for CrossPad r20 (STM32G0B1)
  over ST-Link (see the SWD tracing section below).

Install both as a plugin:

```
/plugin marketplace add CrossPad/crosspad-mcp     # or a local path to this repo
/plugin install crosspad@crosspad
```
```

- [ ] **Step 2: Run the full skills test suite**

Run: `npx vitest run src/skills.test.ts`
Expected: ALL assertions PASS (manifests, server instructions, SKILL.md, reference files present, scripts present + executable).

- [ ] **Step 3: Run the whole test suite + build**

Run: `npm test && npm run build`
Expected: all tests pass; `tsc` exits 0.

- [ ] **Step 4: Final manual sanity**

Run: `bash skills/crosspad/scripts/doctor.sh`
Expected: clean OK/MISS report, exit 0.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the crosspad onboarding skill in README"
```

---

## Self-review checklist (done while writing)

- **Spec coverage:** packaging/rename (Task 1), server hook (Task 2), router SKILL.md
  (Task 3), install+repos (Task 4), 3 role guides (Task 5), tools+FAQ (Task 6),
  read-only doctor (Task 7), assisted setup (Task 8), README + verification (Task 9).
  All spec sections map to a task.
- **Placeholders:** none — every file's full content is inline.
- **Naming consistency:** skill dir `skills/crosspad/`, frontmatter `name: crosspad`,
  plugin `crosspad`, scripts `doctor.sh`/`setup.sh`, reference filenames match the
  test in Task 3 and the routing table in SKILL.md.
```

