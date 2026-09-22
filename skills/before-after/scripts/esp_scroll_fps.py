#!/usr/bin/env python3
"""Scroll a list on the board and measure what each refresh cost.

Drives the encoder at a fixed rate and brackets the burst with two LVGL_STATS
reads (they are read-and-cleared, so two reads delimit a window). Reports
frames, the per-refresh cost and the pixels invalidated and flushed.

Read the result with esp_fps_report.py rather than by eye: frames per second
here is bounded by the paced command rate as much as by render speed, and the
honest number is render_us over flush_px — time per pixel actually drawn.
"""
import argparse, json, statistics, sys, time

from crosspad_hil.devices import discover
from crosspad_hil.cdc import CdcLink
from crosspad_hil import verbs


def parse_stats(line: str) -> dict:
    out = {}
    for tok in line.replace("LVGLSTATS:", "").split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            try:
                out[k] = int(v)
            except ValueError:
                out[k] = v
    return out


def one_round(link, steps: int, rate_hz: float, span: int) -> dict:
    # clear the counters
    link.transact("LVGL_STATS", expect="LVGLSTATS:", timeout_s=3.0)
    # Long sweeps up and down the list, not a rattle around one row: that is
    # what a user's scroll invalidates, and it keeps the list moving instead of
    # clamping at an end with nothing to redraw.
    cmds = []
    d = 1
    while len(cmds) < steps:
        cmds += [f"ENC_ROTATE {d}"] * span
        d = -d
    cmds = cmds[:steps]
    t0 = time.monotonic()
    link.burst(cmds, rate_hz)
    # let the last scroll animation land
    time.sleep(0.4)
    elapsed = time.monotonic() - t0
    r = link.transact("LVGL_STATS", expect="LVGLSTATS:", timeout_s=3.0)
    s = parse_stats(r.line)
    refr = s.get("refr", 0)
    s["elapsed_s"] = round(elapsed, 3)
    s["fps"] = round(refr / elapsed, 2) if elapsed else 0.0
    s["render_us_per_refr"] = round(s.get("render_us", 0) / refr, 1) if refr else 0.0
    return s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default="KitSelector")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--steps", type=int, default=300)
    ap.add_argument("--rate", type=float, default=30.0)
    ap.add_argument("--span", type=int, default=70)
    ap.add_argument("--label", default="run")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    devs = [d for d in discover() if d.ports.cdc]
    if not devs:
        print("no board with a CDC port", file=sys.stderr)
        return 2
    link = CdcLink(devs[0].ports.cdc.path)
    link.open()
    try:
        link.wait_ready()
        st = link.transact("UI_STATE", expect="UI:", timeout_s=3.0).line
        if f"app={a.app}" not in st:
            verbs.app_stop(link)
            time.sleep(0.6)
            verbs.app_start(link, a.app)
            time.sleep(1.2)
        link.transact("ENC_GROUP", expect=None, timeout_s=3.0)
        # one warm-up round, not scored
        one_round(link, a.steps, a.rate, a.span)
        rows = [one_round(link, a.steps, a.rate, a.span) for _ in range(a.rounds)]
    finally:
        link.close()

    fps = [r["fps"] for r in rows]
    rpr = [r["render_us_per_refr"] for r in rows]
    res = {
        "label": a.label,
        "app": a.app,
        "rounds": rows,
        "fps_median": statistics.median(fps),
        "refr_avg_us_median": statistics.median(r.get("refr_avg_us", 0) for r in rows),
        "fps_min": min(fps), "fps_max": max(fps),
        "render_us_per_refr_median": statistics.median(rpr),
        "inv_px_median": statistics.median(r.get("inv_px", 0) for r in rows),
        "flush_px_median": statistics.median(r.get("flush_px", 0) for r in rows),
    }
    txt = json.dumps(res, indent=2)
    print(txt)
    if a.out:
        open(a.out, "w").write(txt + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
