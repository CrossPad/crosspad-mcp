import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "exec-"));

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("child_process");
});

describe("spawnDetached", () => {
  it("launches a real process and appends its output to the log", async () => {
    const { spawnDetached } = await import("./exec.js");
    const dir = tmp();
    const log = path.join(dir, "hil_logs", "sim_20260101_000000.log");
    const pid = spawnDetached(process.execPath, ["-e", "process.stdout.write('hello')"], dir, log);
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 200 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 200 && fs.readFileSync(log, "utf-8").length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(fs.readFileSync(log, "utf-8")).toContain("hello");
  });

  it("survives a binary that does not exist", async () => {
    // The failure arrives as an 'error' event. On an EventEmitter with no
    // listener that is not a value, it is a throw out of the event loop — this
    // test fails the whole file if the listener is missing.
    const { spawnDetached } = await import("./exec.js");
    const dir = tmp();
    const log = path.join(dir, "hil_logs", "sim_20260101_000000.log");
    expect(spawnDetached(path.join(dir, "no-such-binary"), [], dir, log)).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(log, "utf-8")).toMatch(/spawn failed/);
  });

  it("closes the log descriptor when spawn throws", async () => {
    // openSync happened before spawn; an exception on the way out of spawn used
    // to leak that descriptor for the lifetime of the server.
    vi.doMock("child_process", async (orig) => {
      const real = await orig<typeof import("child_process")>();
      return { ...real, spawn: () => { throw new Error("EINVAL"); } };
    });
    vi.resetModules();
    const { spawnDetached } = await import("./exec.js");
    const dir = tmp();
    const log = path.join(dir, "hil_logs", "sim_20260101_000000.log");
    const closed: number[] = [];
    const close = vi.spyOn(fs, "closeSync").mockImplementation((fd: number) => { closed.push(fd); });
    try {
      expect(() => spawnDetached("/bin/true", [], dir, log)).toThrow("EINVAL");
      expect(closed).toHaveLength(1);
    } finally {
      close.mockRestore();
      for (const fd of closed) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
  });
});

describe("pruneLaunchLogs", () => {
  it("keeps the newest N of its own kind", async () => {
    const { pruneLaunchLogs } = await import("./exec.js");
    const dir = tmp();
    const names = Array.from({ length: 8 }, (_, i) => `sim_20260101_00000${i}.log`);
    for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
    pruneLaunchLogs(path.join(dir, "sim_20260101_000008.log"), 3);
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(-3));
  });

  it("leaves every other producer's logs in hil_logs alone", async () => {
    // console_*, diagnose_* and capture files share this directory; a
    // directory-wide sweep would delete somebody else's evidence.
    const { pruneLaunchLogs } = await import("./exec.js");
    const dir = tmp();
    for (const n of ["sim_20260101_000001.log", "sim_20260101_000002.log", "console_device_20260101_000001.log", "diagnose_20260101_000001.log"]) {
      fs.writeFileSync(path.join(dir, n), "x");
    }
    pruneLaunchLogs(path.join(dir, "sim_20260101_000003.log"), 1);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "console_device_20260101_000001.log",
      "diagnose_20260101_000001.log",
      "sim_20260101_000002.log",
    ]);
  });
});
