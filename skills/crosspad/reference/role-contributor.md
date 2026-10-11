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

Node ≥ 18 runs the server; CI builds and tests on Node 20 and 22 — use Node 22
if tooling complains about missing `node:` exports. To run your checkout from
Claude Code, register `node <checkout>/dist/index.js` in local scope
(`reference/install.md` → "Developing crosspad-mcp itself") and restart after
every build.

## Layout

```
src/
  index.ts            — v9-style tools still registered inline, SERVER_INSTRUCTIONS,
                        stdio / HTTP transports, the start-up line
  registry.ts         — registers everything: V10_MODULES (tools/*.ts), the built-in
                        core tools, legacy index.ts tools, resources, prompts
  toolsets.ts         — TOOLSETS: which tool lives in which toolset (only `core` at start)
  policy/             — tiers.ts (read / stimulus / mutate-host / danger per tool),
                        policy.ts (strict / lab / readonly), confirm.ts (confirmation tokens)
  hil/                — client for the crosspad-hil daemon (`python -m crosspad_hil.serve`)
  resources/          — crosspad:// resources (workspace, device, knowledge, introspect, skills)
  prompts.ts          — MCP prompts
  config.ts           — per-repo env vars, dynamic repo discovery, IDF/MSVC/STM paths
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
    stm-build.ts / idf-flash.ts / stm-flash.ts / flash.ts — STM build, ESP and STM flashing
    devices.ts / cdc.ts / console.ts / ui.ts / … — device tools over the daemon
    hil-run.ts / capture.ts / stimulus.ts         — HIL scenarios and measurements
    input.ts          — simulator input events
    log.ts            — log capture
    repos.ts          — multi-repo git status
    screenshot.ts     — simulator screenshots
    settings.ts       — simulator settings R/W
    stats.ts          — simulator runtime stats
    symbols.ts        — cross-repo symbol search
    test.ts           — Catch2 test runner
    *.test.ts         — unit tests per module (vitest, fs mocking)
```

## Adding a tool

1. Implement it in a focused `src/tools/<name>.ts` exporting
   `register<Name>Tool(server, ctx)` (+ `<name>.test.ts`), with a zod schema
   (validate ranges/enums).
2. Wire it up: an entry in `V10_MODULES` (`src/registry.ts`) **and** its name in
   `TOOLSETS` (`src/toolsets.ts`) — a tool that is in no toolset is removed at
   start. Give it a tier in `TOOL_TIERS` (`src/policy/tiers.ts`); an unlisted
   tool is treated as `danger` (confirmation required).
3. Return the uniform envelope `{ success: boolean, ...data, error?: string }`; set
   `isError: true` on failure so clients route errors distinctly.
4. Name it in `docs/USAGE.md` (toolset table + banner count) — `src/release.test.ts`
   fails otherwise. If it changes how a user should work, update
   `SERVER_INSTRUCTIONS` and the relevant `skills/crosspad/reference/*.md`.
5. The site's tool list (https://crosspad.app/docs/reference/mcp-tools/) is
   written by hand in CrossPad/crosspad-docs: open an issue there for every
   tool added, removed or renamed.
6. `npm run build` then `npm test`.

## Conventions

- One tool = one action with a strict schema. Stream long-running output via MCP
  logging (build/test/log) so the client sees progress; long jobs return a task
  (`crosspad_task`).
- Keep files focused; mirror the existing module-per-concern split.
- A change that breaks a docs page (command, output, path) opens an issue in CrossPad/crosspad-docs.
