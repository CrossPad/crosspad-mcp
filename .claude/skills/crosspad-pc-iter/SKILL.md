---
name: crosspad-pc-iter
description: Use when iterating on the CrossPad PC simulator (crosspad-pc repo) — editing C++ source, then needing to rebuild and verify behavior. Covers the edit→check→build→run→inspect→kill loop, deciding between incremental/clean/reconfigure build modes, and diagnosing already_running, responsive=false, stale-exe, and submodule-drift conditions.
---

# CrossPad PC iteration loop

The MCP server already tells the agent *which* tools exist (see server instructions). This skill encodes *how* to chain them into a tight edit→verify loop without thrashing — and how to recover when one of the four common failure modes hits.

## The loop

```
edit source
  → crosspad_check          (decide build mode + spot drift)
  → crosspad_kill           (free port 19840 before respawn)
  → crosspad_build           (mode chosen from check)
  → crosspad_run             (inspect responsive flag)
  → crosspad_screenshot / _input / _stats / _log   (verify)
  → repeat or crosspad_kill
```

Run `crosspad_kill` *before* `crosspad_build` when a sim is alive. The build itself succeeds either way, but the running binary's text segment is still mapped — `kill` after the rebuild works (the tool strips the kernel's `" (deleted)"` suffix from `/proc/<pid>/exe`), but `run` will refuse to spawn a duplicate while the old one holds port 19840. Killing first keeps the loop linear.

## Build mode decision

Read `crosspad_check` output and pick:

| Check signal | Mode | Why |
|---|---|---|
| `needs_reconfigure: true` (new source files, missing CMakeLists, no `build/`) | `reconfigure` | CMake `GLOB_RECURSE` won't pick up new `.cpp` files until cmake reruns |
| `needs_rebuild: true` only (sources newer than exe, submodule HEAD drift, dirty submodule) | `incremental` | Default; ninja figures out the deltas |
| Toolchain change, vcpkg update, weird link errors after a working build | `clean` | Nukes `build/` — last resort, costs minutes |
| `reasons: ["Build appears up to date"]` | skip build | Just `crosspad_run` |

`build_type: Debug` is the default and what you want for the loop. Switch to `Release` only when profiling.

## Diagnosing the four common failures

**`crosspad_run` returns `already_running: true`** — another sim is bound to TCP 19840. Run `crosspad_kill` first; do *not* pass `force: true` blindly (two sims clobber each other's window state and you'll get garbage from `screenshot`/`stats`).

**`crosspad_run` returns `responsive: false` but `pid` is set** — the binary spawned but never opened the TCP listener within ~3s. Almost always a startup crash. Pull `crosspad_log target: pc` immediately; the binary may already be dead by the time you ask. Don't proceed to `screenshot`/`input` — they will hang or return the previous run's state.

**`crosspad_kill` returns `success: false`** — `error` field tells you *which* signal failed (`EPERM`, `ESRCH`, `EUNKNOWN`) and which PID. EPERM means a different user owns the process (rare in dev, common if you ran the sim under sudo earlier). ESRCH is folded into success — it means the PID was already gone, which is fine.

**`crosspad_check` says `needs_rebuild` because of submodule drift** — `crosspad-core` or `crosspad-gui` HEAD differs from the pin. If you're intentionally testing a submodule branch, `incremental` rebuild is correct (the link will pull the new objects). If the drift was unintentional, `crosspad_repo_status` shows what's dirty across all repos before you decide whether to commit, stash, or `crosspad_submodule_update` back to the pin.

## Inspecting the running sim

Always screenshot *before and after* an `input` event. The screenshot is the assertion — without a baseline you can't tell if the input took. `crosspad_stats` is the cheap secondary check: pad pressed-state, encoder positions, heap usage, app stack. A growing `heap.allocated_bytes` across iterations of the same input flow is the canonical "this leak is real, not measurement noise" signal.

`crosspad_log target: pc` spawns the binary fresh and captures stdout/stderr — it does *not* tail an already-running sim. Use it for repro from a clean state, not for live monitoring of the loop.

## Quick reference

| Goal | Call |
|---|---|
| "Should I rebuild?" | `crosspad_check` |
| "Pick build mode" | Read `needs_reconfigure` / `needs_rebuild` / `reasons` from check |
| "Free the port" | `crosspad_kill` (idempotent — fine to call when nothing is running) |
| "Build PC" | `crosspad_build platform: pc, mode: <chosen>` |
| "Launch + verify alive" | `crosspad_run` → check `responsive: true` |
| "Did the input land?" | `crosspad_screenshot` (before) → `crosspad_input` → `crosspad_screenshot` (after) → diff |
| "Is the loop leaking?" | `crosspad_stats` across iterations, watch `heap.allocated_bytes` |
| "Sim crashed at startup" | `crosspad_log target: pc` |

## Gotchas

- **Rebuild during a live run is fine.** The `(deleted)` suffix in `/proc/<pid>/exe` is handled. Kill afterwards still works.
- **`force: true` on `run` is almost never the right answer.** It spawns a second sim sharing the same window state and TCP listener — both fight for the port. Always `kill` first.
- **`reconfigure` mode does not delete `build/`.** It just reruns cmake. Use `clean` only when the cache is genuinely poisoned.
- **TCP port 19840 is the readiness signal.** If it's not bound, `screenshot`/`input`/`stats`/`settings_*` will all fail. Treat `responsive: true` from `run` as the gate to all sim-interaction tools.
- **`crosspad_log target: pc` ≠ tailing.** It spawns its own instance.

## When NOT to use this skill

- ESP-IDF firmware loop (use `crosspad_build platform: idf` + `crosspad_flash` + `crosspad_log target: idf` — different tooling, different gotchas, different skill if needed).
- Catch2 unit tests (use `crosspad_test_run` directly; no sim needed).
- Symbol search / repo state inspection (one-shot tools, no loop).
