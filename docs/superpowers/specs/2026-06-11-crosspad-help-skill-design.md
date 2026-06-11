# CrossPad `help` skill — design

**Date:** 2026-06-11
**Repo:** crosspad-mcp
**Status:** approved (brainstorming) → ready for implementation plan

## Problem

crosspad-mcp exposes 28 MCP tools across a 6-repo ecosystem (crosspad-pc,
platform-idf, ESP32-S3, crosspad-core, crosspad-gui, crosspad-apps). A fresh
agent — especially a smaller/less-capable LLM — has no fast, low-context way to
learn how the pieces fit, how to install/configure the server for a given repo,
or what to do per role. The README is comprehensive but ~330 lines: loading it
wholesale bloats context. There is no "start here" entry point.

The existing `swd-tracer` skill is a **narrow submodule** of the whole MCP. We
need a **primary, top-level `help` skill** that a new client uses *first* so its
local model can quickly absorb the architecture, then route to detail on demand.

## Goals

1. **Advertised entry point** — triggers first, on any "starting work in a
   CrossPad repo / installing / how does this fit together" intent.
2. **Low context cost** — thin router loads minimally; details live in
   reference files loaded only when the topic actually comes up.
3. **Install + config coverage** — get a brand-new client (and contributor)
   from zero to a working crosspad-mcp setup in the target repo.
4. **Three roles** — (1) user of MCP/firmware, (2) firmware developer,
   (3) contributor to the crosspad-mcp server itself.
5. **Diagnose + assisted setup** — read-only doctor + a mutating setup helper.

## Non-goals

- Replacing the README (README stays the canonical long-form doc; the skill
  links to it, does not duplicate it verbatim).
- Replacing the `swd-tracer` skill (help routes to it; tracing detail stays there).
- Teaching firmware internals of CrossPad_STM32_r20 (that's the STM repo's docs).

## Packaging & advertising

- New skill at `skills/crosspad/` (frontmatter `name: crosspad`) becomes the
  **headline** skill of the plugin.
  `swd-tracer` becomes a secondary module the help skill points to.
- **Plugin rename:** `.claude-plugin/plugin.json` `name` → `crosspad` (from
  `crosspad-swd-tracer`); `description` leads with the help/onboarding role and
  notes it bundles both the MCP server and two skills (help + swd-tracer).
- `.claude-plugin/marketplace.json`: single plugin entry (renamed to `crosspad`),
  description updated to reflect "MCP server + help + swd-tracer". One
  `/plugin install` delivers both skills.
- `package.json` `files[]` already includes `skills/` → ships with npm unchanged.
- **Trigger description** (frontmatter `description`): aggressively first-contact
  oriented, e.g. *"Use FIRST when starting any work in a CrossPad repo, when
  installing/configuring the crosspad-mcp server, or when unsure how the
  ecosystem (repos, MCP tools, build/flash/sim/trace, app registry) fits
  together. Routes to install, per-role guides, a tool cheat-sheet, FAQ, and the
  swd-tracer skill."*
- **MCP server-instructions hook:** add one line to the server's `instructions`
  string (the block clients surface at session start) — *"New to a CrossPad repo
  or setting up? Use the `crosspad` skill first."* — so the trigger is reliable even
  without plugin metadata loaded.

## File layout (router + reference + scripts)

```
skills/crosspad/
  SKILL.md                 # thin router: TOC + architecture map + "I want X → reference/Y.md" table
  reference/
    install.md             # server install (npx / claude mcp add / .mcp.json / Desktop), Node, env vars
    repos.md               # ecosystem repo map (pc/idf/esp32-s3/core/gui/apps) + what lives where
    role-user.md           # role 1: MCP/firmware user — build sim, flash, apps, sim interaction
    role-fw-dev.md         # role 2: firmware developer — code locations, interfaces, capabilities, test flow
    role-contributor.md    # role 3: crosspad-mcp contributor — src/ layout, adding a tool, npm dev/build/test
    tools.md               # cheat-sheet of the 28 tools grouped BY TASK (not alphabetically)
    faq.md                 # Q&A: common errors/pitfalls (repo not detected, sim won't start, IDF_PATH, vcpkg, Node 18 vs 22, …)
  scripts/
    doctor.sh              # read-only: detect repos, env vars, Node, dist/ built, server reachable, app-registry
    setup.sh               # mutating: install server (npm / claude mcp add), prompt/set env vars
```

## SKILL.md (router) content

Kept minimal — only what's needed to route:

1. One paragraph: what the CrossPad ecosystem is.
2. ASCII architecture map: repos + MCP server + the three roles.
3. **Routing table** — "I want to … → read this":
   - install / configure the server → `reference/install.md`
   - understand the repos → `reference/repos.md`
   - I'm a user / fw dev / server contributor → `reference/role-*.md`
   - which tool for a task → `reference/tools.md`
   - something is broken → `reference/faq.md`
   - trace firmware variables over SWD → use the `swd-tracer` skill
4. **First move:** `bash scripts/doctor.sh` to check the environment.

Detail is NOT inline — the agent opens a reference file only when that topic is hit.

## reference/* conventions

- Each file is self-contained and covers ≤ one topic.
- `faq.md` uses one-line Question → Answer entries where possible so a small LLM
  absorbs them fast.
- Files link back to the README/section and to relevant tools rather than
  re-deriving content.

## scripts

- `doctor.sh` — modeled on `swd-tracer/scripts/detect-env.sh`: reports
  environment state (which CROSSPAD_*_ROOT repos resolve, Node version, whether
  `dist/` is built, whether the server responds, whether app-registry JSON
  exists), prints suggested fixes, **changes nothing**. Resolves the skill dir
  relative to itself (global vs repo/plugin install), like swd-tracer scripts.
- `setup.sh` — mutating assisted setup: runs `claude mcp add` / npm install as
  needed, interactively prompts for and helps set env vars
  (`CROSSPAD_*_ROOT`, `IDF_PATH`, `VCPKG_ROOT`). Idempotent; safe to re-run.

## Acceptance

- `/plugin install crosspad@crosspad` delivers both `crosspad` and `swd-tracer` skills.
- A fresh agent invoking `crosspad` gets the router only (~small context), then
  reads exactly the reference file its task needs.
- `bash skills/crosspad/scripts/doctor.sh` runs read-only and reports env state.
- `bash skills/crosspad/scripts/setup.sh` can take a zero-config machine to a working
  server registration.
- Server `instructions` mention the `crosspad` skill as the first move.

## Open questions

None blocking. Naming settled: skill `crosspad` (frontmatter `name: crosspad`,
directory `skills/crosspad/`), plugin `crosspad`.
