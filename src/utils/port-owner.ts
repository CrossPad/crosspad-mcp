/**
 * Who is listening on a TCP port.
 *
 * The simulator's control port is the only identity that tells two simulators
 * apart: a test instance and the one somebody is playing run the same binary.
 * Killing "every CrossPad" or "whatever is called CrossPad" takes both.
 */

import fs from "fs";
import { spawnSync } from "child_process";

/** Socket inodes in LISTEN state on `port`, from /proc/net/tcp and tcp6. */
function listeningInodes(port: number): Set<string> {
  const inodes = new Set<string>();
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = fs.readFileSync(table, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const local = f[1];
      if (f[3] !== "0A") continue; // LISTEN
      if (local.slice(local.lastIndexOf(":") + 1) !== hexPort) continue;
      inodes.add(f[9]);
    }
  }
  return inodes;
}

/**
 * PIDs that hold a listening socket on `port`. Linux walks /proc/<pid>/fd (only
 * processes of the same user are readable, which is the point); elsewhere lsof.
 */
export function findPortOwnerPids(port: number): number[] {
  if (process.platform !== "linux") {
    try {
      const r = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8", timeout: 5000 });
      return ((r.stdout as string) || "")
        .split("\n")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
    } catch {
      return [];
    }
  }

  const inodes = listeningInodes(port);
  if (inodes.size === 0) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid) continue;
    let fds: string[];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/.exec(target);
        if (m && inodes.has(m[1])) {
          pids.push(pid);
          break;
        }
      } catch {
        // fd closed mid-scan
      }
    }
  }
  return pids;
}
