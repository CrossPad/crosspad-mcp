# The simulator side

## The control port

`crosspad-pc` listens on `127.0.0.1:19840` and speaks newline-delimited JSON:
one request object per line, one reply object back. `src/remote/RemoteControl.hpp`
is the list of record. The verbs this workflow uses:

| verb | fields | returns |
|---|---|---|
| `ping` | — | `{ok}` |
| `screenshot` | `region` (`full`/`lcd`), `file` | `{ok, data}` — base64 PNG, plus `lcd_origin`, `lcd_size`, `scale` |
| `click` | `x`, `y`, `space` (`lcd`/`window`), `hold_ms` | `{ok, hit}` — the LVGL object the press goes to, or null |
| `encoder_rotate` | `delta` | `{ok}` |
| `encoder_press` / `encoder_release` | — | `{ok}` |
| `key` | `keycode` (SDL) | `{ok}` — pushes KEYDOWN and KEYUP in one tick |
| `app_list` | — | `{apps, running}`; `running` is `"-"` at the launcher |
| `kit_list` | — | `{kits: [{id, name, parsed}]}` |
| `kit_load` | `kit` | `{ok}` |
| `kit_status` | — | `{loading, …}` |

**One client at a time.** The accept loop serves a single connection, so while
the crosspad-mcp daemon holds it your own socket connects and then times out on
the first read. Either stop the MCP-spawned simulator and start your own, or
stay entirely on `crosspad_input` / `crosspad_screenshot` / `crosspad_snapshot`.
Mixing the two is what produces a tour that silently drove a stale instance.

**`hold_ms` matters.** The pointer is polled about every 30 ms, so a click with
`hold_ms: 0` is often not seen at all. 120–150 ms is reliable.

**The power button** is at window (447, 239) — the small round one, below the
encoder knob at (447, 178). SDL keycode 32 (space) is the same gesture from the
keyboard, but the remote `key` verb pushes press and release in one tick, which
the power gesture's timing does not always resolve; clicking the button is more
dependable. Keycode 27 (Escape) closes the window — never send it.

## The scripts

### `sim_ctl.sh start <binary> <logfile>`

Kills every process whose `/proc/<pid>/exe` looks like a CrossPad simulator,
starts the one you named, then reports which pid and exe hold port 19840 and
fails if it is not yours.

Name matching does not work here: the main thread renames itself `Scheduler`,
so `pkill -x CrossPad` matches nothing, the old instance survives, the new one
loses the port to it, and every later screenshot comes from the wrong binary
with no error anywhere. `sim_ctl.sh kill` stops everything.

### `sim_tour.py --out <dir> [--only APP …]`

Opens each launcher app in turn and saves `<dir>/<App>.png` plus
`<dir>/00_launcher.png`, all 320×240 LCD crops.

- Icon rows are read off the launcher screenshot each run (bands of
  non-background pixels below the status bar), because the whole point of the
  comparison is that layout may have moved.
- Columns are fixed at window x 134/208/282/356; a 64 px tile absorbs any
  plausible shift.
- After each click it polls `app_list` until `running` is the app, retrying the
  click up to three times.
- Each frame must repeat identically across two grabs, be non-black, and differ
  from the launcher, which is what keeps stale and mid-transition frames out.
- `Power OFF` is deliberately not in the list.

### `sim_kit_shot.py --out <file> [--needle SUBSTRING]`

Loads the first kit whose name contains the substring, opens the kit selector
and shoots it. The selector draws the kit name in the 14 px font and the author
in the 10 px font, which makes it the densest single proof that a set of
characters renders — `sim_tour.py` only shows whatever kit happened to be
loaded.

### `compare_shots.py <before-dir> <after-dir> [--out DIR] [--threshold PCT]`

Per-screen changed-pixel percentage and bounding box, plus a `before | after`
composite per screen (magenta divider). `--threshold` makes it exit non-zero
when any screen moved more than that, for a gate.

## Reading the diff

- **Whole-screen bbox, 5–15 %** on a text-heavy screen: lines shifted. Normal
  for a line-height change. Confirm on the composite that nothing is clipped at
  the top or bottom of a fixed-height row.
- **Whole-screen bbox, 30 %+**: usually not a layout change at all — check you
  are not comparing two different screens.
- **Small bbox, low percentage**: a single widget. Look at it.
- **0.0 %**: identical. Rows sized in px and labels centred vertically often
  absorb a font metric change completely.

Screens with live content — a console tail, a test report with measured values,
a level meter — differ every run regardless. List them once as excluded rather
than chasing them.
