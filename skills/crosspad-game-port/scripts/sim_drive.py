#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Drive an isolated crosspad-pc simulator for a game port: its own profile,
virtual card and control port, so it never touches the user's simulator.

Environment:
  SIM_DIR   scratch directory (profile/, card/, shots/, sim.log go there)
  SIM_PORT  control port (default 19851; the user's simulator has 19840)
  SIM_PC    crosspad-pc checkout (for relative binary paths and packages)

Commands:
  setup [--card-data DIR --game NAME]   profile + card; DIR's files -> card/crosspad/NAME/
  launch EXE [ARGS...]                  start a simulator binary, wait for its port
  wait                                  wait for the port (after a slot switch)
  shot NAME [--full]                    screenshot (LCD, or the whole window) -> shots/NAME.png
  pad N [--hold S]                      press and release pad N (0 = bottom left)
  press N | release N                   pad down / up
  enc DELTA                             encoder turns (+1 = wheel up = LV_KEY_LEFT)
  click [X Y]                           encoder click, or a touch at LCD X,Y
  power                                 power click
  level [--n N]                         audio peak of OUT1, N samples
  app NAME                              start an app by name
  slots                                 boot slot and both slots (profile/fw/slots.json)
  log [PATTERN]                         lines of sim.log (all, or containing PATTERN)
  kill                                  stop the simulators started from SIM_DIR/SIM_PC binaries
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

SIM_DIR = Path(os.environ.get("SIM_DIR", "/tmp/crosspad-game-sim")).resolve()
PORT = int(os.environ.get("SIM_PORT", "19851"))
PC = Path(os.environ.get("SIM_PC", ".")).resolve()


def env():
    return dict(os.environ, CROSSPAD_PROFILE_DIR=str(SIM_DIR / "profile"), CROSSPAD_REMOTE_PORT=str(PORT),
                CROSSPAD_NO_MIDI="1")


def port_up():
    try:
        socket.create_connection(("127.0.0.1", PORT), timeout=0.5).close()
        return True
    except OSError:
        return False


def wait_port(timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        if port_up():
            time.sleep(1.5)   # the launcher (or the app) is built right after the port opens
            return True
        time.sleep(0.3)
    return False


def cmd(**kw):
    """One request; None when the simulator went away (a switch ends it)."""
    try:
        s = socket.create_connection(("127.0.0.1", PORT), timeout=10)
        f = s.makefile("rwb")
        f.write(json.dumps(kw).encode() + b"\n")
        f.flush()
        line = f.readline()
        s.close()
        return json.loads(line) if line else None
    except (OSError, ValueError):
        return None


def out(r):
    print(json.dumps(r) if r is not None else "no answer")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="c", required=True)
    p = sub.add_parser("setup"); p.add_argument("--card-data"); p.add_argument("--game")
    p = sub.add_parser("launch"); p.add_argument("exe"); p.add_argument("args", nargs="*")
    sub.add_parser("wait")
    p = sub.add_parser("shot"); p.add_argument("name"); p.add_argument("--full", action="store_true")
    p = sub.add_parser("pad"); p.add_argument("n", type=int); p.add_argument("--hold", type=float, default=0.15)
    p = sub.add_parser("press"); p.add_argument("n", type=int)
    p = sub.add_parser("release"); p.add_argument("n", type=int)
    p = sub.add_parser("enc"); p.add_argument("delta", type=int)
    p = sub.add_parser("click"); p.add_argument("xy", nargs="*", type=int)
    sub.add_parser("power")
    p = sub.add_parser("level"); p.add_argument("--n", type=int, default=5)
    p = sub.add_parser("app"); p.add_argument("name")
    sub.add_parser("slots")
    p = sub.add_parser("log"); p.add_argument("pattern", nargs="?")
    sub.add_parser("kill")
    a = ap.parse_args()

    if a.c == "setup":
        (SIM_DIR / "profile").mkdir(parents=True, exist_ok=True)
        (SIM_DIR / "card").mkdir(parents=True, exist_ok=True)
        (SIM_DIR / "shots").mkdir(parents=True, exist_ok=True)
        prefs = SIM_DIR / "profile" / "device_preferences.json"
        prefs.write_text(json.dumps({"sdcard_path": str(SIM_DIR / "card")}) + "\n")
        if a.card_data:
            dst = SIM_DIR / "card" / "crosspad" / (a.game or Path(a.card_data).name)
            dst.mkdir(parents=True, exist_ok=True)
            for f in Path(a.card_data).iterdir():
                if f.is_file():
                    shutil.copy2(f, dst / f.name)
        print(f"profile {SIM_DIR / 'profile'}, card {SIM_DIR / 'card'}, port {PORT}")
    elif a.c == "launch":
        if port_up():
            sys.exit(f"port {PORT} is taken: another simulator is running there")
        exe = Path(a.exe)
        exe = exe if exe.is_absolute() else PC / exe
        log = open(SIM_DIR / "sim.log", "ab")
        subprocess.Popen(["stdbuf", "-oL", "-eL", str(exe), *a.args], env=env(), stdout=log, stderr=log,
                         cwd=SIM_DIR, start_new_session=True)
        print("up" if wait_port() else "port never opened: see sim.log")
    elif a.c == "wait":
        print("up" if wait_port() else "port never opened")
    elif a.c == "shot":
        kw = {"cmd": "screenshot", "file": str(SIM_DIR / "shots" / f"{a.name}.png")}
        if not a.full:
            kw["region"] = "lcd"
        out(cmd(**kw))
    elif a.c == "pad":
        cmd(cmd="pad_press", pad=a.n)
        time.sleep(a.hold)
        out(cmd(cmd="pad_release", pad=a.n))
    elif a.c == "press":
        out(cmd(cmd="pad_press", pad=a.n))
    elif a.c == "release":
        out(cmd(cmd="pad_release", pad=a.n))
    elif a.c == "enc":
        step = 1 if a.delta > 0 else -1
        for _ in range(abs(a.delta)):
            cmd(cmd="encoder_rotate", delta=step)
            time.sleep(0.25)
        print("ok")
    elif a.c == "click":
        if a.xy:
            out(cmd(cmd="click", x=a.xy[0], y=a.xy[1], space="lcd"))
        else:
            cmd(cmd="encoder_press")
            time.sleep(0.15)
            out(cmd(cmd="encoder_release"))
    elif a.c == "power":
        out(cmd(cmd="power_click"))
    elif a.c == "level":
        for _ in range(a.n):
            r = cmd(cmd="audio_level")
            print(f"{r['left']:.4f} {r['right']:.4f}" if r else "no answer")
            time.sleep(0.3)
    elif a.c == "app":
        out(cmd(cmd="app_start", name=a.name))
    elif a.c == "slots":
        f = SIM_DIR / "profile" / "fw" / "slots.json"
        print(f.read_text() if f.exists() else "no slots yet")
    elif a.c == "log":
        for line in (SIM_DIR / "sim.log").read_text(errors="replace").splitlines():
            if not a.pattern or a.pattern in line:
                print(line)
    elif a.c == "kill":
        # Anchored on the binaries' paths: never this script, never another
        # session's simulator started from elsewhere.
        pats = [f"^{PC}/bin/CrossPad", f"^{SIM_DIR}/profile/fw/slot_"]
        killed = []
        for pat in pats:
            pids = subprocess.run(["pgrep", "-f", pat], capture_output=True, text=True).stdout.split()
            for pid in pids:
                subprocess.run(["kill", pid])
            killed += pids
        print("killed", killed or "none")


if __name__ == "__main__":
    main()
