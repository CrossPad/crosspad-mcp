#!/bin/bash
# Start exactly one simulator and prove it is the one on the control port.
# pkill by name does not work here: the process's comm is "Scheduler", so a
# name match leaves the old instance running and the new one silently loses
# the port to it — every screenshot then comes from the wrong binary.
set -u
kill_all() {
  for p in $(pgrep -f CrossPad 2>/dev/null); do
    exe=$(readlink /proc/$p/exe 2>/dev/null) || continue
    case "$exe" in *CrossPad*) kill -TERM "$p" 2>/dev/null;; esac
  done
  sleep 2
  for p in $(pgrep -f CrossPad 2>/dev/null); do
    exe=$(readlink /proc/$p/exe 2>/dev/null) || continue
    case "$exe" in *CrossPad*) kill -KILL "$p" 2>/dev/null;; esac
  done
  sleep 1
}
start() {
  local bin="$1" log="$2"
  kill_all
  ( cd /home/matixan/GIT/crosspad-pc && setsid nohup "$bin" > "$log" 2>&1 & )
  for i in $(seq 1 20); do
    sleep 1
    pid=$(ss -tnlpH 'sport = :19840' 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "${pid:-}" ] || continue
    exe=$(readlink /proc/$pid/exe 2>/dev/null)
    echo "listening pid=$pid exe=$exe"
    [ "$exe" = "$bin" ] && return 0
    echo "WRONG BINARY on the port" >&2; return 1
  done
  echo "no simulator came up" >&2; return 1
}
case "${1:-}" in
  kill) kill_all; echo "all stopped";;
  start) start "$2" "$3";;
  *) echo "usage: sim_ctl.sh kill | start <binary> <logfile>" >&2; exit 2;;
esac
