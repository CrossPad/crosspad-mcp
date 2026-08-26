import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pumpDaemonTask, type DaemonLike, type ProgressFn } from "./tasks.js";
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
