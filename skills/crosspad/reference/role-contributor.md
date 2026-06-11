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
