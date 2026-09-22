#!/usr/bin/env python3
"""Open every launcher app in the PC simulator and save its 320x240 screen.

Clicks the icon grid by window coordinates and comes back through the virtual
power button. Both transitions are waited on with app_list ("-" means the
launcher), because a screenshot taken mid-transition is a black frame, not a
layout to compare. Icon cells are ~64 px, far wider than the pixel or two a
font's line height can move them, so the same coordinates hold before and
after the change under test.
"""
import argparse, base64, io, json, os, socket, sys, time

from PIL import Image

HOST, PORT = "127.0.0.1", 19840
POWER = (447, 239)          # virtual power button, window space
LCD_ORIGIN = (85, 58)       # where the 320x240 panel sits in the window
COLUMNS = (134, 208, 282, 356)      # window x of the four icon columns
# Row order is the launcher's, which is app_list order.
NAMES = ["KitSelector", "Settings", "AppStore", "CITest",
         "Fishtank", "Instructions", "Mixer", "MLPiano",
         "Sampler", "Serial", "Update"]


class Sim:
    def __init__(self, timeout=20):
        self.f = socket.create_connection((HOST, PORT), timeout=timeout).makefile("rwb")

    def cmd(self, **kw):
        self.f.write((json.dumps(kw) + "\n").encode())
        self.f.flush()
        line = self.f.readline()
        if not line:
            raise RuntimeError("simulator closed the control connection")
        return json.loads(line)

    def running(self):
        return self.cmd(cmd="app_list").get("running", "?")

    def wait_running(self, want, timeout=8.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if self.running() == want:
                return True
            time.sleep(0.25)
        return False

    def click(self, x, y, hold=150):
        return self.cmd(cmd="click", x=x, y=y, space="window", hold_ms=hold)

    def to_launcher(self):
        for _ in range(6):
            if self.running() == "-":
                time.sleep(0.5)
                return True
            self.click(*POWER)
            time.sleep(0.6)
        return False

    def grab(self):
        r = self.cmd(cmd="screenshot", region="lcd")
        data = r.get("data") or r.get("png") or r.get("image")
        if not data:
            raise RuntimeError(f"no image in reply: {sorted(r)[:8]}")
        return base64.b64decode(data)

    def shot(self, path, avoid=None, tries=8):
        """Save a frame that is settled, not black, and not the last screen.

        The simulator answers a screenshot with whatever it last rendered, so
        right after a transition it can hand back the previous app; and a frame
        caught mid-transition is all black. Both look like a layout change in a
        before/after diff, so neither is accepted: the frame has to repeat
        identically and differ from the screen we came from.
        """
        black = ((0, 0), (0, 0), (0, 0))
        prev = None
        for _ in range(tries):
            raw = self.grab()
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            same_as_prev = prev is not None and im.tobytes() == prev
            stale = avoid is not None and im.tobytes() == avoid
            if same_as_prev and not stale and im.getextrema() != black:
                open(path, "wb").write(raw)
                return im
            prev = im.tobytes()
            time.sleep(0.7)
        open(path, "wb").write(raw)
        return im


def icon_rows(im):
    """Window-space y of each icon row, read off the launcher itself.

    The whole point of the change under test is that line height moves things,
    so hard-coded rows would drift out of their tiles; the rows are the bands
    of non-background pixels below the status bar.
    """
    px = im.load()
    wide = [sum(1 for x in range(im.width) if sum(px[x, y]) > 90) > im.width * 0.4
            for y in range(im.height)]
    bands, start = [], None
    for y, on in enumerate(wide + [False]):
        if on and start is None:
            start = y
        elif not on and start is not None:
            if y - start > 24:                  # skip the status bar
                bands.append((start + y) // 2)
            start = None
    return [b + LCD_ORIGIN[1] for b in bands]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", nargs="*", default=None,
                    help="capture just these apps (the launcher shot is skipped)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    sim = Sim()
    sim.cmd(cmd="ping")
    assert sim.to_launcher(), "could not get back to the launcher"
    time.sleep(1.0)
    im = sim.shot(os.path.join(a.out, "00_launcher.png"))
    launcher_bytes = im.tobytes()
    rows = icon_rows(im)
    print("launcher, icon rows at window y:", rows)
    if len(rows) < 3:
        print("could not find the icon grid", file=sys.stderr)
        return 2
    grid = [(NAMES[i], COLUMNS[i % 4], rows[i // 4]) for i in range(len(NAMES))]
    if a.only:
        grid = [g for g in grid if g[0] in a.only]

    bad = []
    for name, x, y in grid:
        # A click on the bottom row sometimes lands while the launcher is still
        # settling and opens nothing; try again rather than score it a failure.
        for attempt in range(3):
            sim.click(x, y)
            if sim.wait_running(name, timeout=5.0):
                break
            sim.to_launcher()
            time.sleep(0.8)
        else:
            print(f"{name:14s} DID NOT OPEN (running={sim.running()})")
            bad.append(name)
            sim.to_launcher()
            continue
        time.sleep(1.2)
        sim.shot(os.path.join(a.out, f"{name}.png"), avoid=launcher_bytes)
        print(f"{name:14s} ok")
        if not sim.to_launcher():
            print(f"{name:14s} STUCK after screenshot")
            bad.append(name)
    print("done ->", a.out, "| problems:", bad or "none")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
