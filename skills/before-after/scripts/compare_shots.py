#!/usr/bin/env python3
"""Diff two screenshot sets and write side-by-side composites.

Prints one line per screen: how much of it changed, and the bounding box of the
change. A bounding box tight around one widget is a local change; one that
spans the whole screen usually means the text reflowed — or that one of the two
captures is of the wrong screen, which is worth ruling out before reading
anything into the number.
"""
from __future__ import annotations

import argparse
import pathlib
import sys

from PIL import Image, ImageChops


def compare(fb: pathlib.Path, fa: pathlib.Path, out: pathlib.Path | None):
    ib = Image.open(fb).convert("RGB")
    ia = Image.open(fa).convert("RGB")
    if ib.size != ia.size:
        return None, f"size {ib.size} -> {ia.size}"
    d = ImageChops.difference(ib, ia)
    changed = sum(1 for p in d.getdata() if p != (0, 0, 0))
    pct = 100.0 * changed / (ib.width * ib.height)
    if out is not None:
        c = Image.new("RGB", (ib.width * 2 + 6, ib.height), (255, 0, 255))
        c.paste(ib, (0, 0))
        c.paste(ia, (ib.width + 6, 0))
        c.save(out)
    return pct, d.getbbox()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("before", type=pathlib.Path, help="directory of before/*.png")
    ap.add_argument("after", type=pathlib.Path, help="directory of after/*.png")
    ap.add_argument("--out", type=pathlib.Path, default=None,
                    help="where to write before|after composites (default: <after>/../cmp)")
    ap.add_argument("--threshold", type=float, default=0.0,
                    help="exit 1 if any screen changed more than this percent")
    a = ap.parse_args()

    out = a.out or a.after.parent / "cmp"
    out.mkdir(parents=True, exist_ok=True)

    worst = 0.0
    missing = []
    for fb in sorted(a.before.glob("*.png")):
        fa = a.after / fb.name
        if not fa.exists():
            missing.append(fb.name)
            print(f"{fb.name:24s} MISSING in after")
            continue
        pct, info = compare(fb, fa, out / fb.name)
        if pct is None:
            print(f"{fb.name:24s} {info}")
            continue
        worst = max(worst, pct)
        print(f"{fb.name:24s} {pct:5.1f}%  bbox={info}")

    print(f"\ncomposites in {out}  (left = before, right = after)")
    if missing:
        print(f"missing after captures: {', '.join(missing)}", file=sys.stderr)
        return 2
    return 1 if a.threshold and worst > a.threshold else 0


if __name__ == "__main__":
    sys.exit(main())
