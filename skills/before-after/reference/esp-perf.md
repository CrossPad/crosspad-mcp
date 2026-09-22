# The board side

## What `LVGL_STATS` reports

`main/lvgl_stats.cpp` hangs counters off the display's event callbacks. The CDC
verb answers one line and **clears every counter**, so two reads delimit a
window and the second read is that window's result.

```
LVGLSTATS: refr=66 refr_max_us=142212 refr_avg_us=44686 render_us=2881070
           render_max_us=141774 flush_wait_us=407160 flush_wait_max_us=3861
           flushes=246 flush_px=1083884 inv_px=12966893 inv_areas=3461
```

| field | meaning |
|---|---|
| `refr` | refreshes completed (`LV_EVENT_REFR_START` … `REFR_READY`) |
| `refr_avg_us` / `refr_max_us` | how long one refresh took |
| `render_us` | total time inside render, the part drawing actually costs |
| `flush_wait_us` | waiting on the panel, not on drawing |
| `flush_px` | pixels handed to the panel — the work that was really done |
| `inv_px` / `inv_areas` | pixels and areas invalidated; a screen-wide invalidation per scroll step shows up here, not in render time |

## Why time per drawn pixel

Frames per second on this bench is misleading twice over. The scroll is driven
by `ENC_ROTATE` over CDC, so the frame count follows the command rate; and the
number of pixels redrawn varies run to run with scroll position and animation.
`render_us / flush_px` divides out both, which is what makes two runs
comparable.

Measured spread on the bench board, kit selector, eight rounds: about 2 500 to
3 200 ns per drawn pixel, i.e. roughly ±10 % around the median. Anything inside
that is not a finding. Report a range, not a point.

## The A/B/A/B cycle

```bash
cd ~/GIT/platform-idf
HIL=~/GIT/crosspad-hil/.venv/bin/python

# build and flash the pre-change firmware, then:
python3 tools/bench.py flash && python3 tools/bench.py ready
$HIL scripts/esp_scroll_fps.py --rounds 8 --label before1 --out /tmp/ab/before1.json

# build and flash the post-change firmware, then the same run as after1,
# then flash back for before2, and forward again for after2.

$HIL scripts/esp_fps_report.py --before /tmp/ab/before*.json --after /tmp/ab/after*.json
```

`bench.py ready` between flashes is not optional: a flash leaves the board with
no kit loaded, and the kit selector with nothing in it is a different screen
from the kit selector with 80 kits in it.

`bench.py flash` proves the image landed by comparing `APP_SHA` against the
local ELF. Read that line — an OTA is a trial boot, and an image that is not
confirmed rolls back.

## Benchmarking something other than list scrolling

`esp_scroll_fps.py` is a shape, not a fixed test. To measure a different
screen, keep the frame:

1. `APP_START <name>`, then `ENC_GROUP` before driving anything.
2. `LVGL_STATS` once to clear.
3. A burst of input at a fixed rate — `CdcLink.burst(cmds, rate_hz)` paces it
   and counts `app_queue` drops.
4. Settle, then `LVGL_STATS` again: that is your window.
5. Several rounds, and a warm-up round that is not scored.

What must stay constant between the two firmwares is the *work*: same app, same
kit, same number of input events at the same rate. `inv_px` and `flush_px` in
the result tell you whether it did — if those differ by more than a few percent
between the sides, the comparison is measuring a different workload, not a
different cost.

Nothing that blocks belongs on the CDC drain loop; if replies come late,
`CDC_STATS maxcmd_us/maxgap_us` says which wait caused it, and when both are
small yet nothing answers, something at a higher priority on core 0 is starving
the loop — check `LVGL_STATS render_us` first.

## Memory, when the change adds data

A font, an image or a table also costs flash and possibly RAM. `MEM` and
`MEM --blocks` over crosspad-hil, and the `binary size` line from the build,
are the counterpart to the timing numbers:

```
CrossPad.bin binary size 0x248b50 bytes. Smallest app partition is 0x380000 bytes.
```

Report the delta in kB and what fraction of the partition is left.
