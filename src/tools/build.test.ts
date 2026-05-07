import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseErrors,
  countWarnings,
  findCrosspadPids,
  crosspadKill,
  canonicalize,
  stripDeletedSuffix,
} from "./build.js";
import { BIN_EXE } from "../config.js";
import * as remote from "../utils/remote-client.js";

describe("parseErrors (PC build)", () => {
  it("extracts MSVC-style errors", () => {
    const output = `
main.cpp(42): error C2065: 'foo': undeclared identifier
main.cpp(43): warning C4244: conversion from 'double' to 'int'
Build succeeded.
`;
    const errors = parseErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error C2065");
  });

  it("extracts GCC-style errors", () => {
    const output = `
src/main.cpp:42:10: error: use of undeclared identifier 'foo'
src/main.cpp:43:5: warning: unused variable 'bar'
`;
    const errors = parseErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error:");
  });

  it("excludes summary lines like '0 error(s)'", () => {
    const output = `
Build: 0 error(s), 2 warning(s)
`;
    expect(parseErrors(output)).toHaveLength(0);
  });

  it("caps at 20 errors", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      `file.cpp(${i}): error C1234: problem ${i}`
    ).join("\n");
    expect(parseErrors(lines)).toHaveLength(20);
  });

  it("returns empty for clean output", () => {
    expect(parseErrors("Building...\nDone.\n")).toHaveLength(0);
  });
});

describe("countWarnings (PC build)", () => {
  it("counts compiler warnings (GCC/Clang style)", () => {
    const output = `
src/a.cpp:1:5: warning: implicit conversion
src/b.cpp:2:10: warning: unused variable
Build: 2 warning(s)
`;
    // "2 warning(s)" excluded, only real diagnostics counted
    expect(countWarnings(output)).toBe(2);
  });

  it("counts MSVC warnings", () => {
    const output = `main.cpp(42): warning C4244: conversion from 'double' to 'int'`;
    expect(countWarnings(output)).toBe(1);
  });

  it("returns 0 for clean output", () => {
    expect(countWarnings("Building...\nDone.")).toBe(0);
  });

  it("ignores bare 'warning' keyword without compiler-diagnostic context", () => {
    // Old loose matcher counted these — now we require :line:col: or (line):
    expect(countWarnings("WARNING: cmake found something\nNote: warning is expected"))
      .toBe(0);
  });
});

describe("parseErrors regression — false positives", () => {
  it("ignores 'error' as a substring in unrelated cmake/ninja output", () => {
    const output = `
-- Configuring done
-- Found error handling library at /usr/lib
[42/100] Building CXX object src/error_handler.cpp.o
Generated error_codes.h
`;
    expect(parseErrors(output)).toHaveLength(0);
  });

  it("captures linker undefined reference", () => {
    const output = `/usr/bin/ld: undefined reference to 'foo()'`;
    expect(parseErrors(output)).toHaveLength(1);
  });

  it("captures CMake Error", () => {
    const output = `CMake Error at CMakeLists.txt:42 (find_package): could not find Foo`;
    expect(parseErrors(output)).toHaveLength(1);
  });

  it("captures Ninja FAILED marker", () => {
    const output = `[42/100] Building foo.o\nFAILED: foo.o\nclang: ...`;
    expect(parseErrors(output)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Process-detection helpers — every Linux kill regression seen in the
// field traces back to one of these, so each gets its own test.
// ─────────────────────────────────────────────────────────────────────

describe("stripDeletedSuffix", () => {
  it("strips the kernel's ' (deleted)' marker after a rebuild", () => {
    expect(stripDeletedSuffix("/foo/CrossPad (deleted)")).toBe("/foo/CrossPad");
  });
  it("leaves clean paths untouched", () => {
    expect(stripDeletedSuffix("/foo/CrossPad")).toBe("/foo/CrossPad");
  });
  it("only strips a trailing marker (not embedded)", () => {
    expect(stripDeletedSuffix("/foo (deleted)/bar")).toBe("/foo (deleted)/bar");
  });
  it("strips only one occurrence (kernel never doubles it)", () => {
    expect(stripDeletedSuffix("/x (deleted) (deleted)")).toBe("/x (deleted)");
  });
});

describe("canonicalize", () => {
  it("returns realpath when target exists", () => {
    // /proc/self exists on Linux; realpath dereferences to /proc/<own-pid>.
    if (process.platform !== "linux") return;
    const r = canonicalize("/proc/self");
    expect(r).toMatch(/^\/proc\/\d+$/);
  });
  it("falls back to path.resolve when target doesn't exist", () => {
    const fake = "/definitely/not/a/real/path/CrossPad";
    expect(canonicalize(fake)).toBe(path.resolve(fake));
  });
});

// crosspadKill / findCrosspadPids — Linux /proc-based detection regression.
// Old code used `pgrep -x CrossPad`, which compares /proc/<pid>/comm. Qt and
// pthread routinely overwrite comm via prctl(PR_SET_NAME), so a sim launched
// as the CrossPad binary often shows up under a thread name like "QSGRender"
// and pgrep returns nothing — the agent reported "couldn't kill simulator".
// These tests pin the new /proc/<pid>/exe scan that's immune to comm renames.
const isLinux = process.platform === "linux";
const linuxDescribe = isLinux ? describe : describe.skip;

linuxDescribe("findCrosspadPids (Linux /proc scan)", () => {
  let readdirSpy: ReturnType<typeof vi.spyOn>;
  let readlinkSpy: ReturnType<typeof vi.spyOn>;
  let realpathSpy: ReturnType<typeof vi.spyOn>;
  const target = path.resolve(BIN_EXE);

  beforeEach(() => {
    readdirSpy = vi.spyOn(fs, "readdirSync") as any;
    readlinkSpy = vi.spyOn(fs, "readlinkSync") as any;
    // Force canonicalize() to fall through to path.resolve so tests use the
    // raw mocked paths instead of resolving against the real filesystem.
    realpathSpy = vi.spyOn(fs, "realpathSync") as any;
    realpathSpy.mockImplementation((p: any) => {
      throw Object.assign(new Error("test-stub: realpath disabled"), { code: "ENOENT" });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockProc(map: Record<string, string | { code: string }>) {
    readdirSpy.mockImplementation((p: any) => {
      if (p === "/proc") return Object.keys(map);
      throw new Error(`unexpected readdir: ${p}`);
    });
    readlinkSpy.mockImplementation((p: any) => {
      const m = String(p).match(/^\/proc\/([^/]+)\/exe$/);
      if (!m) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const v = map[m[1]];
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (typeof v === "object") throw Object.assign(new Error(v.code), { code: v.code });
      return v;
    });
  }

  it("matches PIDs whose /proc/<pid>/exe resolves to BIN_EXE", () => {
    mockProc({ "1": "/usr/lib/systemd/systemd", "42": target, "100": target, cpuinfo: "x", self: "x" });
    expect(findCrosspadPids().sort((a, b) => a - b)).toEqual([42, 100]);
  });

  it("ignores non-numeric /proc entries (cpuinfo, self, version, 1abc)", () => {
    readdirSpy.mockReturnValue(["cpuinfo", "self", "version", "1abc"]);
    readlinkSpy.mockImplementation(() => {
      throw new Error("readlink should not be called for non-numeric entries");
    });
    expect(findCrosspadPids()).toEqual([]);
  });

  it("survives readlink ENOENT mid-scan (process exited between readdir and readlink)", () => {
    mockProc({ "10": { code: "ENOENT" }, "20": "/bin/bash", "30": target });
    expect(findCrosspadPids()).toEqual([30]);
  });

  it("survives readlink EACCES (containerized /proc with restricted perms)", () => {
    mockProc({ "10": { code: "EACCES" }, "30": target });
    expect(findCrosspadPids()).toEqual([30]);
  });

  it("returns [] when /proc unreadable (no Linux /proc mounted)", () => {
    readdirSpy.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(findCrosspadPids()).toEqual([]);
  });

  it("strips ' (deleted)' suffix — REGRESSION: kill silently failed after every dev rebuild", () => {
    mockProc({ "55": `${target} (deleted)` });
    expect(findCrosspadPids()).toEqual([55]);
  });

  it("does NOT match a different binary at a different path (regression: pgrep false positive)", () => {
    mockProc({ "55": "/usr/local/bin/CrossPadFake" });
    expect(findCrosspadPids()).toEqual([]);
  });

  it("does NOT match the running Node process even if /proc/self/exe were spoofed to BIN_EXE", () => {
    // Defensive: BIN_EXE could in theory be misconfigured to /usr/bin/node
    // during a botched test run. Our own PID must never appear.
    mockProc({ [String(process.pid)]: target, "99": target });
    expect(findCrosspadPids()).toEqual([99]);
  });

  it("canonicalizes BIN_EXE through symlinks before comparing", () => {
    // Simulate: BIN_EXE = /home/u/GIT/crosspad-pc/bin/CrossPad (with /home/u/GIT
    // a symlink to /mnt/big/git). /proc returns /mnt/big/git/.../CrossPad.
    // Without realpath canonicalization, the string compare fails.
    realpathSpy.mockImplementation((p: any) => {
      const s = String(p);
      // Both BIN_EXE and the /proc readlink result canonicalize to the same
      // /mnt path.
      if (s === target) return "/mnt/big/git/crosspad-pc/bin/CrossPad";
      if (s === "/mnt/big/git/crosspad-pc/bin/CrossPad") return s;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockProc({ "77": "/mnt/big/git/crosspad-pc/bin/CrossPad" });
    expect(findCrosspadPids()).toEqual([77]);
  });
});

linuxDescribe("crosspadKill (orchestration)", () => {
  type KillCall = { pid: number; signal: NodeJS.Signals | number | undefined };

  let killCalls: KillCall[];
  let killSpy: ReturnType<typeof vi.spyOn>;
  let readdirSpy: ReturnType<typeof vi.spyOn>;
  let readlinkSpy: ReturnType<typeof vi.spyOn>;
  let realpathSpy: ReturnType<typeof vi.spyOn>;
  let tcpAlive: boolean;
  const target = path.resolve(BIN_EXE);

  beforeEach(() => {
    killCalls = [];
    tcpAlive = false;

    killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      return true;
    }) as any);

    vi.spyOn(remote, "isSimulatorRunning").mockImplementation(async () => tcpAlive);

    readdirSpy = vi.spyOn(fs, "readdirSync") as any;
    readlinkSpy = vi.spyOn(fs, "readlinkSync") as any;
    realpathSpy = vi.spyOn(fs, "realpathSync") as any;
    realpathSpy.mockImplementation((p: any) => {
      throw Object.assign(new Error("test-stub"), { code: "ENOENT" });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drive findCrosspadPids() across the kill flow. Each entry in `phases`
   * is the set of "still-alive" PIDs returned by one /proc scan, in order.
   * The first scan corresponds to crosspadKill's `initialPids` capture; the
   * subsequent scans correspond to polling iterations and the final check.
   * Once the list is exhausted the last phase is repeated indefinitely.
   */
  function scriptProcScans(phases: number[][]) {
    let call = 0;
    readdirSpy.mockImplementation((p: any) => {
      if (p !== "/proc") throw new Error(`unexpected readdir: ${p}`);
      const idx = Math.min(call, phases.length - 1);
      call++;
      return phases[idx].map(String);
    });
    let readlinkCall = 0;
    readlinkSpy.mockImplementation((p: any) => {
      const m = String(p).match(/^\/proc\/(\d+)\/exe$/);
      if (!m) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      readlinkCall++;
      // We always claim the listed PIDs run BIN_EXE — readdir already filtered.
      return target;
    });
  }

  it("returns was_running=false when no pids and TCP dead", async () => {
    scriptProcScans([[]]);
    const r = await crosspadKill();
    expect(r).toEqual({ success: true, killed_pids: [], was_running: false });
    expect(killCalls).toEqual([]);
  });

  it("SIGTERMs found pids; succeeds when SIGTERM clears them on first poll", async () => {
    // initial scan: [111, 222]; first poll: []
    scriptProcScans([[111, 222], []]);
    const r = await crosspadKill();
    expect(r.success).toBe(true);
    expect(r.was_running).toBe(true);
    expect(r.killed_pids.sort((a, b) => a - b)).toEqual([111, 222]);
    expect(killCalls.map((k) => k.signal).sort()).toEqual(["SIGTERM", "SIGTERM"]);
    expect(killCalls.some((k) => k.signal === "SIGKILL")).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM doesn't clear within 3s", async () => {
    // Stay alive across all polls until SIGKILL handler kicks in.
    let sigkilled = false;
    killSpy.mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      if (signal === "SIGKILL") sigkilled = true;
      return true;
    }) as any);

    let scan = 0;
    readdirSpy.mockImplementation((p: any) => {
      if (p !== "/proc") throw new Error(`bad readdir: ${p}`);
      scan++;
      // After SIGKILL is delivered the next scan reports clean.
      return sigkilled ? [] : ["777"];
    });
    readlinkSpy.mockImplementation(() => target);

    const r = await crosspadKill();
    expect(r.success).toBe(true);
    expect(r.killed_pids).toEqual([777]);
    const signals = killCalls.map((k) => k.signal);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    // Polling deadline was 3s; SIGTERM came before, SIGKILL after.
    expect(scan).toBeGreaterThan(1);
  }, 10000);

  it("reports failure with diagnostics when even SIGKILL leaves the sim alive", async () => {
    // Process never dies — both SIGTERM and SIGKILL no-op against our mock.
    scriptProcScans([[999]]); // every scan returns [999]
    const r = await crosspadKill();
    expect(r.success).toBe(false);
    expect(r.was_running).toBe(true);
    expect(r.error).toMatch(/SIGTERM\+SIGKILL/);
    expect(r.error).toMatch(/pids=999/);
  }, 10000);

  it("surfaces EPERM in the error message — REGRESSION: previous code swallowed it silently", async () => {
    // Process owned by another user → EPERM on signal. crosspadKill should
    // *not* report success and should *include the errno* so the agent gets
    // a useful failure message instead of just 'still running'.
    scriptProcScans([[5000]]); // sim stays "alive" forever
    killSpy.mockImplementation(((_pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid: _pid, signal });
      const e: NodeJS.ErrnoException = new Error("operation not permitted") as any;
      e.code = "EPERM";
      throw e;
    }) as any);

    const r = await crosspadKill();
    expect(r.success).toBe(false);
    expect(r.killed_pids).toEqual([]); // none successfully signaled
    expect(r.error).toMatch(/EPERM/);
    expect(r.error).toMatch(/pid=5000/);
  }, 10000);

  it("treats ESRCH (PID already exited) as success — no spurious failure on race", async () => {
    // /proc lists pid 42 at scan 0, then pid 42 is reaped before SIGTERM lands.
    // process.kill throws ESRCH; we should not flag this as a failure.
    let sawSigterm = false;
    killSpy.mockImplementation(((_pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid: _pid, signal });
      if (signal === "SIGTERM") {
        sawSigterm = true;
        const e: NodeJS.ErrnoException = new Error("no such process") as any;
        e.code = "ESRCH";
        throw e;
      }
      return true;
    }) as any);
    // initial: [42]; first poll: []
    scriptProcScans([[42], []]);

    const r = await crosspadKill();
    expect(sawSigterm).toBe(true);
    expect(r.success).toBe(true);
    expect(r.was_running).toBe(true);
    // ESRCH is not a failure — killed_pids should reflect "considered killed".
    expect(r.killed_pids).toEqual([42]);
    expect(r.error).toBeUndefined();
  });

  it("uses /proc as the primary signal even when TCP probe lies", async () => {
    // /proc says clean from the start, but TCP port still answers (zombie
    // listener / TIME_WAIT race). crosspadKill must still detect the sim is
    // up via the TCP probe and report stillRunning=true at the end.
    tcpAlive = true;
    scriptProcScans([[]]); // /proc always empty
    const r = await crosspadKill();
    // wasRunning=true because of TCP; no PIDs to signal; final TCP still alive.
    expect(r.was_running).toBe(true);
    expect(r.success).toBe(false);
    expect(r.killed_pids).toEqual([]);
    expect(r.error).toMatch(/tcp_alive=true/);
  });
});
