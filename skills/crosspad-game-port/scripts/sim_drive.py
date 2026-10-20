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
  launch EXE [ARGS...] [--settle S]     start a simulator binary, wait for its port and the boot
                                        splash (S seconds after the port, default 7)
  wait [--settle S]                     the same after a slot switch
  cmd JSON                              any control request, e.g. '{"cmd":"led_state"}'
  leds                                  the 16 pads' LED colours (index 0 = bottom left), as a 4x4 grid
  pkg EXE                               make_fw_package.py onto THIS card (never the user's)
  shot NAME [--full]                    screenshot (LCD, or the whole window) -> shots/NAME.png
                                        (the LCD shot is 320x240; in the simulator the app's area
                                        is 316x236 from (2,2), inside the panel's bezel)
  snap NAME                             shot NAME plus shots/NAME.leds (the pads' colours, same moment)
  pad N [--hold S]                      press and release pad N (0 = bottom left)
  press N | release N                   pad down / up
  enc DELTA                             encoder turns: +N = wheel up = LV_KEY_LEFT = UP a list,
                                        -N = DOWN a list. Check the selection before clicking.
  click [X Y]                           encoder click, or a touch at LCD X,Y
  power                                 power click
  level [--n N] [--interval S]          audio peak of OUT1: N samples, then their max (the meter
                                        holds no peak: sample densely to catch a blip)
  app NAME                              start an app by name
  slots                                 boot slot and both slots (profile/fw/slots.json)
  log [PATTERN] [--all]                 lines of sim.log since the last launch (--all: every run)
  kill                                  stop the simulator this script launched (its PID, and the slot
                                        binaries under SIM_DIR it switched to) -- never anyone else's

As a module (an autoplay or a long test): sys.path.insert(0, <this dir>);
import sim_drive as sd; sd.cmd(cmd="encoder_rotate", delta=1); sd.shot_png("x")
-> path of the LCD PNG (~20 ms), readable with PIL to find what is on screen.
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


def wait_port(timeout=90, settle=7.0):
    """The port opens when the boot is done, but the splash plays on for a few
    seconds over the launcher or the app: `settle` covers it."""
    end = time.time() + timeout
    while time.time() < end:
        if port_up():
            time.sleep(settle)
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


LAUNCH_MARK = "==== sim_drive launch ===="


def leds():
    """The 16 pads' colours as setPadColor() left them (`colors`), index 0 =
    bottom left; the strip's own values are `strip`."""
    r = cmd(cmd="led_state")
    return r.get("colors") if r else None


def leds_grid(colors):
    rows = []
    for row in range(3, -1, -1):
        rows.append(" ".join(f"{c:06X}" if isinstance(c, int) else str(c) for c in colors[row * 4:row * 4 + 4]))
    return "\n".join(rows)


def shot_png(name, full=False):
    """A screenshot; returns its path (None when the simulator did not answer)."""
    path = SIM_DIR / "shots" / f"{name}.png"
    kw = {"cmd": "screenshot", "file": str(path)}
    if not full:
        kw["region"] = "lcd"
    return path if cmd(**kw) else None


def out(r):
    print(json.dumps(r) if r is not None else "no answer")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="c", required=True)
    p = sub.add_parser("setup"); p.add_argument("--card-data"); p.add_argument("--game")
    p = sub.add_parser("launch"); p.add_argument("exe"); p.add_argument("args", nargs="*")
    p.add_argument("--settle", type=float, default=7.0)
    p = sub.add_parser("wait"); p.add_argument("--settle", type=float, default=7.0)
    p = sub.add_parser("cmd"); p.add_argument("json")
    sub.add_parser("leds")
    p = sub.add_parser("pkg"); p.add_argument("exe")
    p = sub.add_parser("shot"); p.add_argument("name"); p.add_argument("--full", action="store_true")
    p = sub.add_parser("snap"); p.add_argument("name")
    p = sub.add_parser("pad"); p.add_argument("n", type=int); p.add_argument("--hold", type=float, default=0.15)
    p = sub.add_parser("press"); p.add_argument("n", type=int)
    p = sub.add_parser("release"); p.add_argument("n", type=int)
    p = sub.add_parser("enc"); p.add_argument("delta", type=int)
    p = sub.add_parser("click"); p.add_argument("xy", nargs="*", type=int)
    sub.add_parser("power")
    p = sub.add_parser("level"); p.add_argument("--n", type=int, default=5)
    p.add_argument("--interval", type=float, default=0.3)
    p = sub.add_parser("app"); p.add_argument("name")
    sub.add_parser("slots")
    p = sub.add_parser("log"); p.add_argument("pattern", nargs="?"); p.add_argument("--all", action="store_true")
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
        log.write(f"{LAUNCH_MARK} {exe}\n".encode())
        log.flush()
        proc = subprocess.Popen(["stdbuf", "-oL", "-eL", str(exe), *a.args], env=env(), stdout=log, stderr=log,
                                cwd=SIM_DIR, start_new_session=True)
        (SIM_DIR / "sim.pid").write_text(str(proc.pid))
        print("up" if wait_port(settle=a.settle) else "port never opened: see sim.log")
    elif a.c == "wait":
        print("up" if wait_port(settle=a.settle) else "port never opened")
    elif a.c == "cmd":
        out(cmd(**json.loads(a.json)))
    elif a.c == "leds":
        c = leds()
        print(leds_grid(c) if c else "no answer")
    elif a.c == "snap":
        out(cmd(cmd="screenshot", file=str(SIM_DIR / "shots" / f"{a.name}.png"), region="lcd"))
        c = leds()
        (SIM_DIR / "shots" / f"{a.name}.leds").write_text((leds_grid(c) if c else "no answer") + "\n")
    elif a.c == "pkg":
        exe = Path(a.exe)
        exe = exe if exe.is_absolute() else PC / exe
        subprocess.run([sys.executable, str(PC / "scripts" / "make_fw_package.py"), str(exe), "--card",
                        str(SIM_DIR / "card")], check=True)
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
        peak = 0.0
        for _ in range(a.n):
            r = cmd(cmd="audio_level")
            if r:
                peak = max(peak, r["left"], r["right"])
            time.sleep(a.interval)
        print(f"max {peak:.4f} over {a.n} samples")
    elif a.c == "app":
        out(cmd(cmd="app_start", name=a.name))
    elif a.c == "slots":
        f = SIM_DIR / "profile" / "fw" / "slots.json"
        print(f.read_text() if f.exists() else "no slots yet")
    elif a.c == "log":
        lines = (SIM_DIR / "sim.log").read_text(errors="replace").splitlines()
        if not a.all:
            marks = [i for i, l in enumerate(lines) if l.startswith(LAUNCH_MARK)]
            lines = lines[marks[-1] + 1:] if marks else lines
        for line in lines:
            if not a.pattern or a.pattern in line:
                print(line)
    elif a.c == "kill":
        # The PID this script launched, and the slot binaries a switch started
        # under this SIM_DIR's profile -- anchored, so never this script and
        # never another session's simulator, even one from the same worktree.
        killed = []
        pidfile = SIM_DIR / "sim.pid"
        if pidfile.exists():
            pid = pidfile.read_text().strip()
            if subprocess.run(["kill", pid], capture_output=True).returncode == 0:
                killed.append(pid)
            pidfile.unlink()
        pids = subprocess.run(["pgrep", "-f", f"^{SIM_DIR}/profile/fw/slot_"], capture_output=True,
                              text=True).stdout.split()
        for pid in pids:
            subprocess.run(["kill", pid])
        killed += pids
        print("killed", killed or "none")


if __name__ == "__main__":
    main()
