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
- **crosspad-core/crosspad-gui are vendored in three separate, unlinked
  checkouts** (one per platform repo). A change in one does not propagate —
  `reference/repos.md` has the full warning and how to check which checkout
  a given build target actually compiles. Check this *before* concluding a
  change "isn't taking effect."
- **You're often working across a hardware boundary, not just a software
  one.** CrossPad_STM32_r20 (STM32) and platform-idf/ESP32-S3 (ESP32) are
  two separate MCUs — a symptom that looks like it's on "your" side may
  actually be owned by the other. If you're not sure which repo owns a
  symptom, check both repos' `CLAUDE.md` before fixing anything; guessing
  wrong and fixing the wrong repo is a real, previously-observed failure
  mode here, not a hypothetical one.
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
