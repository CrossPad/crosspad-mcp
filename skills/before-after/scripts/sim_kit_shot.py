#!/usr/bin/env python3
"""Load the kit whose name carries diacritics and shoot the kit selector.

kit_load rather than encoder steps: the selector's cover shows the current
kit's name and author in the 14 px and 10 px fonts, which is exactly the text
the change is about, and loading is deterministic where scrolling is not.
"""
import argparse, base64, io, json, socket, sys, time
from PIL import Image

HOST, PORT = "127.0.0.1", 19840
POWER, KITSEL = (447, 239), (134, 115)


class Sim:
    def __init__(self):
        self.f = socket.create_connection((HOST, PORT), timeout=20).makefile("rwb")

    def cmd(self, **kw):
        self.f.write((json.dumps(kw) + "\n").encode()); self.f.flush()
        return json.loads(self.f.readline())

    def settled(self, tries=10):
        prev = None
        for _ in range(tries):
            r = self.cmd(cmd="screenshot", region="lcd")
            raw = base64.b64decode(r.get("data") or r.get("png") or r.get("image"))
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            if prev == im.tobytes() and im.getextrema() != ((0, 0), (0, 0), (0, 0)):
                return raw
            prev = im.tobytes(); time.sleep(0.7)
        return raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--needle", default="ŚWIĘTE",
                    help="substring of the kit name to load")
    a = ap.parse_args()
    sim = Sim()

    kits = sim.cmd(cmd="kit_list").get("kits", [])
    hit = next((k for k in kits if a.needle in k["name"]), None)
    if hit is None:
        print("kit not found", file=sys.stderr); return 2
    print(f"loading kit {hit['id']} {hit['name']!r}")
    sim.cmd(cmd="kit_load", kit=hit["id"])
    for _ in range(40):
        if not sim.cmd(cmd="kit_status").get("loading"):
            break
        time.sleep(0.5)

    for _ in range(6):
        if sim.cmd(cmd="app_list").get("running") == "-":
            break
        sim.cmd(cmd="click", x=POWER[0], y=POWER[1], space="window", hold_ms=150)
        time.sleep(0.6)
    time.sleep(0.8)
    sim.cmd(cmd="click", x=KITSEL[0], y=KITSEL[1], space="window", hold_ms=150)
    time.sleep(2.5)
    open(a.out, "wb").write(sim.settled())
    print("->", a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
