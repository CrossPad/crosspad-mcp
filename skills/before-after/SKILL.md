---
name: before-after
description: Prove a CrossPad change did or did not regress the UI and its rendering speed, by capturing the same screens and the same benchmark on the build before the change and the build after it. Use this whenever a change could move pixels or cost frames — fonts, themes, styles, LVGL widgets, launcher or app layout, draw code, kit selector, status bar — and whenever anyone asks "did this break the layout", "is it slower", "screenshot every app", "show me before and after", "check FPS before and after", or "did I introduce a regression". Also use it when a change is expected to be invisible and you want evidence that it is. Covers both halves: per-app screenshots from the crosspad-pc simulator (layout) and an LVGL_STATS scroll benchmark on the board (speed), because the simulator is far too fast to show a rendering cost and the board cannot hand back its framebuffer.
---

# Before/after on CrossPad

Two questions, two instruments, and they do not substitute for each other:

| question | instrument | why not the other one |
|---|---|---|
| did anything move on screen? | crosspad-pc simulator, one screenshot per app | the board has no framebuffer readback |
| did drawing get more expensive? | `LVGL_STATS` on the board while scrolling | the host is orders of magnitude faster than an ESP32-S3; a real cost vanishes into it |

Scripts live in `scripts/` next to this file. Resolve them relative to SKILL.md
(`<crosspad-mcp>/skills/before-after/scripts/` in the repo, or
`~/.claude/skills/before-after/scripts/` when installed).

## The rule that makes the rest work

**Build the "before" artifact first, keep it, and prove which one you are
talking to.** Almost every wasted hour in this workflow comes from comparing a
build against itself. Copy the pre-change binary somewhere before you touch
anything (`cp bin/CrossPad /tmp/CrossPad_before`), or reconstruct it by
reverting your edit, building, copying, and restoring. If the change is already
committed, `git stash` or a worktree gives you the same thing.

A size check is a cheap sanity gate: two builds that differ in behaviour almost
always differ in bytes. Two identical sizes means you probably built the same
thing twice.

## Part 1 — layout, in the simulator

```bash
scripts/sim_ctl.sh start /tmp/CrossPad_before  /tmp/ab/sim_before.log
python3 scripts/sim_tour.py --out /tmp/ab/before

scripts/sim_ctl.sh start ~/GIT/crosspad-pc/bin/CrossPad /tmp/ab/sim_after.log
python3 scripts/sim_tour.py --out /tmp/ab/after

python3 scripts/compare_shots.py /tmp/ab/before /tmp/ab/after
```

`sim_ctl.sh` prints the pid and exe of whatever is actually listening on the
control port and fails if it is not the binary you asked for. Take that line
seriously — it is the check that catches the failure mode above.

`sim_tour.py` opens each launcher app, waits for `app_list` to report it
running, saves a settled 320×240 frame, and comes back through the virtual
power button. `--only Sampler Serial` re-captures just the screens that failed;
a flaky click on the bottom row is common enough that the tour retries three
times before giving up.

Then read the numbers with your eyes on the composites, not only on the
percentages. A 1 px line-height change lights up most of a text-heavy screen
(10 % or more) and is completely benign; a 1 % change concentrated in one
bounding box can be a clipped glyph. `compare_shots.py` writes
`before | after` pairs so you can see which it is.

Screens whose content is live — a console, a test report, a level meter — will
differ every run. Note them once and stop re-litigating them.

To prove a *text* change rather than a layout one, `sim_kit_shot.py --needle
ŚWIĘTE` loads a kit whose name carries the characters in question and shoots
the selector, where the name is drawn in two different fonts at once.

## Part 2 — rendering cost, on the board

```bash
cd ~/GIT/platform-idf
python3 tools/bench.py flash && python3 tools/bench.py ready
python3 scripts/esp_scroll_fps.py --rounds 8 --label after1 --out /tmp/ab/after1.json
```

Flash the other build, run it again, then **flash back and run both again**.
One A/B is not enough: the run-to-run spread on this bench is around 5 %, so a
single pair can show either sign. A/B/A/B costs two extra OTA flashes (~30 s
each) and turns a guess into a measurement.

```bash
python3 scripts/esp_fps_report.py --before /tmp/ab/before*.json --after /tmp/ab/after*.json
```

The verdict to trust is **time per drawn pixel**. Frames per second is bounded
by how fast the host can push `ENC_ROTATE` over CDC, and the pixels redrawn
differ between runs; dividing render time by flushed pixels removes both. When
the after spread sits inside the before spread, there is no regression this
benchmark can see — say exactly that, rather than claiming an improvement from
a median that moved 3 %.

Run the harness through `crosspad-hil`'s interpreter (it owns the CDC link):
`~/GIT/crosspad-hil/.venv/bin/python scripts/esp_scroll_fps.py …`.

## Traps

| symptom | cause | fix |
|---|---|---|
| before and after are pixel-identical when they should differ | both tours talked to one simulator | `sim_ctl.sh` — it verifies the exe on the port |
| `pkill -x CrossPad` kills nothing | the process's `comm` is `Scheduler`, not `CrossPad` | kill by `/proc/<pid>/exe`, which `sim_ctl.sh` does |
| a raw socket to port 19840 times out | the simulator serves one client, and the MCP daemon holds it | stop the MCP-spawned instance, start your own, or drive it with `crosspad_input`/`crosspad_screenshot` |
| a screenshot shows the *previous* app | the simulator answers with whatever it last rendered | require a frame that repeats and differs from the screen you came from (`sim_tour.py` does) |
| a screenshot is entirely black | caught mid-transition | same retry loop |
| the bottom launcher row never opens | the click landed while the launcher was still settling | retry the click; the tour already does |
| icon clicks miss after the change | hard-coded rows drifted | `sim_tour.py` reads the icon rows off the launcher each run |
| FPS "improved" by 10 % | that is the noise floor | A/B/A/B, and judge on ns per drawn pixel |

## Reporting

Give the reader the composites and one table. State the layout verdict per
screen (unchanged / shifted by N px / clipped) and the speed verdict as a
range, not a point: "after 2544–2818 ns per drawn pixel, before 2636–3211 — the
after spread is inside the before spread" is a claim someone can check. Name
the screens you excluded as live content, and say how many rounds and how many
flashes the numbers came from.

More detail: `reference/pc-screenshots.md` for the simulator's control
protocol and what each script does, `reference/esp-perf.md` for what
`LVGL_STATS` reports and how to build a benchmark for something other than
list scrolling.
