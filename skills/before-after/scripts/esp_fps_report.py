#!/usr/bin/env python3
"""Turn a set of esp_scroll_fps.py runs into one verdict.

Frames per second alone does not answer "did this get slower": the scroll is
driven over CDC, so the frame count follows the command rate as much as the
render cost, and the amount redrawn differs from run to run. What does compare
is time per drawn pixel (render_us / flush_px) — it divides out the workload,
so a font, a style or a widget change that makes drawing itself more expensive
shows up there even when the frame counts look alike.

Pass every run of each side; the spread across runs is the noise floor, and a
difference smaller than that is not a finding.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import statistics
import sys


def per_pixel_ns(run: dict) -> list[float]:
    return [1000.0 * r["render_us"] / r["flush_px"]
            for r in run["rounds"] if r.get("flush_px")]


def load(paths: list[pathlib.Path]) -> tuple[list[float], list[float]]:
    ns, fps = [], []
    for p in paths:
        d = json.loads(p.read_text())
        ns += per_pixel_ns(d)
        fps += [r["fps"] for r in d["rounds"]]
    return ns, fps


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", nargs="+", type=pathlib.Path, required=True)
    ap.add_argument("--after", nargs="+", type=pathlib.Path, required=True)
    a = ap.parse_args()

    bn, bf = load(a.before)
    an, af = load(a.after)
    if not bn or not an:
        print("no rounds with flush_px in one of the sides", file=sys.stderr)
        return 2

    print(f"{'':8s} {'rounds':>7} {'fps med':>8} {'ns/px med':>10} {'ns/px min':>10} {'ns/px max':>10}")
    for tag, ns, fps in (("before", bn, bf), ("after", an, af)):
        print(f"{tag:8s} {len(ns):7d} {statistics.median(fps):8.2f} "
              f"{statistics.median(ns):10.1f} {min(ns):10.1f} {max(ns):10.1f}")

    bmed, amed = statistics.median(bn), statistics.median(an)
    delta = 100.0 * (amed - bmed) / bmed
    print(f"\nmedian time per drawn pixel: {delta:+.1f}%")

    # The question is whether it got worse, so the test is one-sided: a worst
    # case that stays under the old worst case, and a median that did not rise,
    # is as much as this bench can establish. Anything else needs more runs
    # before it is called either way.
    if amed <= bmed and max(an) <= max(bn):
        print("every after round stayed under the slowest before round and the "
              "median did not rise — no regression this benchmark can see")
    elif abs(delta) < 5:
        print("inside the run-to-run spread this bench shows (~5%): inconclusive, "
              "take more runs before calling it either way")
    else:
        print("slower than the spread explains — run another A/B cycle to confirm "
              "before reporting it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
