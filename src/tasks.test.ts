import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JobRegistry, jobs, POLL_INTERVAL_MS, type DaemonLike } from "./tasks.js";
import { HilError } from "./hil/daemon.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("JobRegistry lifecycle", () => {
  it("mints task_N ids and moves working → completed with the result", async () => {
    const r = new JobRegistry();
    const d = deferred<{ passed: boolean }>();
    const id = r.create("hil_run", async (_signal, progress) => { progress(1, 4, "round 1/4"); return d.promise; });
    expect(id).toBe("task_1");
    expect(r.create("build", async () => "x")).toBe("task_2");
    await Promise.resolve();
    expect(r.status(id)).toMatchObject({ task: "task_1", kind: "hil_run", status: "working", progress: 1, total: 4, message: "round 1/4" });
    d.resolve({ passed: true });
    const s = await r.wait(id, 1000);
    expect(s.status).toBe("completed");
    expect(s.result).toEqual({ passed: true });
    expect(typeof s.finishedAt).toBe("number");
  });

  it("a throwing run → failed with error {code,message}; HilError keeps its code", async () => {
    const r = new JobRegistry();
    const a = r.create("flash", async () => { throw new HilError("FLASH_FAILED", "OTA_ERROR at 40%", "retry"); });
    const b = r.create("flash", async () => { throw new Error("plain"); });
    expect(await r.wait(a, 1000)).toMatchObject({ status: "failed", error: { code: "FLASH_FAILED", message: "OTA_ERROR at 40%" } });
    expect(await r.wait(b, 1000)).toMatchObject({ status: "failed", error: { code: "INTERNAL", message: "plain" } });
  });

  it("wait() times out and returns the current (still working) status", async () => {
    const r = new JobRegistry();
    const d = deferred<void>();
    const id = r.create("capture", async () => d.promise);
    const s = await r.wait(id, 20);
    expect(s.status).toBe("working");
    d.resolve();
    expect((await r.wait(id, 1000)).status).toBe("completed");
  });

  it("cancel() aborts the signal; a run that honours it ends cancelled", async () => {
    const r = new JobRegistry();
    let aborted = false;
    const id = r.create("stimulus", (signal) => new Promise((_res, rej) => {
      signal.addEventListener("abort", () => { aborted = true; rej(new HilError("CANCELLED", "stopped")); });
    }));
    expect(r.cancel(id)).toBe(true);
    const s = await r.wait(id, 1000);
    expect(aborted).toBe(true);
    expect(s.status).toBe("cancelled");
    expect(r.cancel(id)).toBe(false);
  });

  it("a run that resolves after cancel is still reported cancelled", async () => {
    const r = new JobRegistry();
    const d = deferred<string>();
    const id = r.create("build", async () => d.promise);
    r.cancel(id);
    d.resolve("done anyway");
    const s = await r.wait(id, 1000);
    expect(s.status).toBe("cancelled");
    expect(s.result).toBeUndefined();
  });

  it("cancel/status of an unknown id", () => {
    const r = new JobRegistry();
    expect(r.cancel("task_99")).toBe(false);
    expect(() => r.status("task_99")).toThrow(HilError);
    try { r.status("task_99"); } catch (e) { expect((e as HilError).code).toBe("HANDLE_EXPIRED"); }
  });

  it("list() returns every job newest last", async () => {
    const r = new JobRegistry();
    r.create("a", async () => 1);
    r.create("b", async () => 2);
    expect(r.list().map((j) => j.task)).toEqual(["task_1", "task_2"]);
  });

  it("exports a shared instance", () => {
    expect(jobs).toBeInstanceOf(JobRegistry);
  });
});

describe("JobRegistry retention (1 h)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("forgets a finished job 1 h after finishedAt, keeps working ones", async () => {
    const r = new JobRegistry();
    const done = r.create("build", async () => 1);
    const d = deferred<void>();
    const live = r.create("capture", async () => d.promise);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status(done).status).toBe("completed");
    await vi.advanceTimersByTimeAsync(3_600_000 - 2);
    expect(() => r.status(done)).not.toThrow();
    await vi.advanceTimersByTimeAsync(5);
    expect(() => r.status(done)).toThrow(HilError);
    expect(r.status(live).status).toBe("working");
    expect(r.list().map((j) => j.task)).toEqual([live]);
    d.resolve();
  });
});

describe("JobRegistry.mirror — daemon-side tasks", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function fakeDaemon(statuses: Array<Record<string, unknown>>): DaemonLike & { calls: Array<[string, Record<string, unknown>]> } {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let i = 0;
    return {
      calls,
      async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
        calls.push([op, args]);
        if (op === "task.status") { const s = statuses[Math.min(i, statuses.length - 1)]; i++; return s as T; }
        if (op === "task.cancel") return { ok: true } as T;
        throw new Error("unexpected op " + op);
      },
    };
  }

  it("polls task.status every 500 ms, forwards progress, completes with the daemon result", async () => {
    const daemon = fakeDaemon([
      { task: "task_9", status: "working", progress: 1, total: 3, message: "round 1/3" },
      { task: "task_9", status: "working", progress: 2, total: 3, message: "round 2/3" },
      { task: "task_9", status: "completed", progress: 3, total: 3, message: "done", result: { passed: true, summary: "ok" } },
    ]);
    const r = new JobRegistry();
    const id = r.mirror(daemon, "task_9", "hil_run");
    expect(id).toBe("task_1");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status(id)).toMatchObject({ status: "working", progress: 1, total: 3, message: "round 1/3", daemonTask: "task_9" });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.status(id)).toMatchObject({ status: "working", progress: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.status(id)).toMatchObject({ status: "completed", result: { passed: true, summary: "ok" } });
    expect(daemon.calls.filter(([op]) => op === "task.status")).toHaveLength(3);
    expect(daemon.calls[0]).toEqual(["task.status", { task: "task_9" }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(daemon.calls.filter(([op]) => op === "task.status")).toHaveLength(3);
  });

  it("maps a daemon failure to failed with its error", async () => {
    const daemon = fakeDaemon([{ task: "task_9", status: "failed", error: { code: "NO_DEVICE", message: "no CrossPad found" } }]);
    const r = new JobRegistry();
    const id = r.mirror(daemon, "task_9", "hil_run");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status(id)).toMatchObject({ status: "failed", error: { code: "NO_DEVICE", message: "no CrossPad found" } });
  });

  it("cancel() forwards task.cancel to the daemon and ends cancelled", async () => {
    const daemon = fakeDaemon([
      { task: "task_9", status: "working", progress: 0, total: 3 },
      { task: "task_9", status: "cancelled" },
    ]);
    const r = new JobRegistry();
    const id = r.mirror(daemon, "task_9", "hil_run");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.cancel(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(daemon.calls.some(([op, a]) => op === "task.cancel" && a.task === "task_9")).toBe(true);
    expect(r.status(id).status).toBe("cancelled");
  });

  it("a daemon that stays dead fails the mirrored job with DAEMON_DIED, once the retries are spent", async () => {
    const calls: string[] = [];
    const daemon: DaemonLike = {
      async request<T>(op: string): Promise<T> {
        calls.push(op);
        throw new HilError("DAEMON_DIED", "daemon exited with code 1", "Traceback");
      },
    };
    const r = new JobRegistry();
    const id = r.mirror(daemon, "task_9", "hil_run");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status(id).status, "one dead poll is not proof the task is gone").toBe("working");
    await vi.advanceTimersByTimeAsync(4 * POLL_INTERVAL_MS);
    expect(r.status(id)).toMatchObject({ status: "failed", error: { code: "DAEMON_DIED" } });
    // Giving up locally has to cancel the daemon side, or the scenario keeps
    // running with nothing left that can stop it.
    expect(calls).toContain("task.cancel");
  });
});
