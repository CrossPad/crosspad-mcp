import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pumpDaemonTask, POLL_RETRIES, type DaemonLike, type ProgressFn } from "./tasks.js";
import { HilError } from "./hil/daemon.js";

function scriptedDaemon(statuses: unknown[]): DaemonLike & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let i = 0;
  return {
    calls,
    async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
      calls.push([op, args]);
      if (op === "task.cancel") return { ok: true } as unknown as T;
      return statuses[Math.min(i++, statuses.length - 1)] as T;
    },
  };
}

describe("pumpDaemonTask", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("forwards progress and resolves the daemon result", async () => {
    const d = scriptedDaemon([
      { task: "task_9", status: "working", progress: 4096, total: 1_200_000, message: "0%" },
      { task: "task_9", status: "working", progress: 600_000, total: 1_200_000, message: "50%" },
      { task: "task_9", status: "completed", result: { bytes: 1_200_000, seconds: 9.4, kbps: 128, version: "v20-3f2a", mode: "full" } },
    ]);
    const seen: Array<[number, number | undefined, string]> = [];
    const progress: ProgressFn = (p, t, m) => seen.push([p, t, m]);
    const promise = pumpDaemonTask(d, "task_9", new AbortController().signal, progress, 10);
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toMatchObject({ bytes: 1_200_000, version: "v20-3f2a" });
    expect(seen[0]).toEqual([4096, 1_200_000, "0%"]);
    expect(seen[1]).toEqual([600_000, 1_200_000, "50%"]);
  });

  it("rejects with the daemon's error code when the task fails", async () => {
    const d = scriptedDaemon([{ task: "task_9", status: "failed", error: { code: "FLASH_FAILED", message: "OTA_ERROR at 40%", hint: "retry over UART" } }]);
    const p = pumpDaemonTask(d, "task_9", new AbortController().signal, () => {}, 10);
    // Attach the rejection handler before the timers run: a rejection nobody is
    // waiting for yet surfaces as an unhandled rejection, not a test failure.
    const rejected = expect(p).rejects.toMatchObject({ code: "FLASH_FAILED", hint: "retry over UART" });
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
  });

  it("forwards task.cancel exactly once on abort", async () => {
    const d = scriptedDaemon([
      { task: "task_9", status: "working", progress: 1, total: 2, message: "" },
      { task: "task_9", status: "cancelled" },
    ]);
    const ac = new AbortController();
    const p = pumpDaemonTask(d, "task_9", ac.signal, () => {}, 10);
    const rejected = expect(p).rejects.toBeInstanceOf(HilError);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    ac.abort();
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    expect(d.calls.filter(([op]) => op === "task.cancel")).toHaveLength(1);
  });
});

// ── Transient failures, and the give-up path ────────────────────────────────

/** A daemon whose `task.status` throws `fail` for the first `n` calls. */
function flakyDaemon(
  failFor: number,
  fail: unknown,
  then: unknown[],
): DaemonLike & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let seen = 0;
  let i = 0;
  return {
    calls,
    async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
      calls.push([op, args]);
      if (op === "task.cancel") return { ok: true } as unknown as T;
      if (seen++ < failFor) throw fail;
      return then[Math.min(i++, then.length - 1)] as T;
    },
  };
}

describe("pumpDaemonTask resilience", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("rides out a transient poll failure instead of orphaning the daemon task", async () => {
    // A 30 s TIMEOUT on task.status under load is routine. Treating it as the
    // task's own failure ends the local job, and JobRegistry.cancel() then
    // answers false for ever — an 8-hour run with no handle that can stop it.
    const d = flakyDaemon(POLL_RETRIES, new HilError("TIMEOUT", "task.status timed out after 30000 ms"), [
      { task: "task_9", status: "completed", result: { rounds: 40 } },
    ]);
    const p = pumpDaemonTask(d, "task_9", new AbortController().signal, () => {}, 10);
    await vi.advanceTimersByTimeAsync(10 * (POLL_RETRIES + 2));
    await expect(p).resolves.toMatchObject({ rounds: 40 });
    expect(d.calls.filter(([op]) => op === "task.cancel")).toHaveLength(0);
  });

  it("gives up after a run of them — and cancels the daemon side on the way out", async () => {
    const d = flakyDaemon(99, new HilError("TIMEOUT", "task.status timed out after 30000 ms"), []);
    const p = pumpDaemonTask(d, "task_9", new AbortController().signal, () => {}, 10);
    const rejected = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10 * (POLL_RETRIES + 2));
    await rejected;
    expect(d.calls.filter(([op]) => op === "task.cancel")).toHaveLength(1);
  });

  it("does not retry a failure that is about the task rather than the transport", async () => {
    const d = flakyDaemon(99, new HilError("UNKNOWN_TASK", "no such task task_9"), []);
    const p = pumpDaemonTask(d, "task_9", new AbortController().signal, () => {}, 10);
    const rejected = expect(p).rejects.toMatchObject({ code: "UNKNOWN_TASK" });
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
    expect(d.calls.filter(([op]) => op === "task.status")).toHaveLength(1);
  });

  it("stops watching a task that never terminates, and cancels it", async () => {
    // Without a deadline this polls at 500 ms until the process exits.
    const d = scriptedDaemon([{ task: "task_9", status: "working", progress: 1, total: 2, message: "" }]);
    const p = pumpDaemonTask(d, "task_9", new AbortController().signal, () => {}, 10, { deadlineMs: 100 });
    const rejected = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(200);
    await rejected;
    expect(d.calls.filter(([op]) => op === "task.cancel")).toHaveLength(1);
  });
});
