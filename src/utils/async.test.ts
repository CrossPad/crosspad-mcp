import { describe, it, expect } from "vitest";
import { mapLimit, mapRecordLimit, AbortedError, DEFAULT_CONCURRENCY } from "./async.js";

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("preserves input order regardless of completion order", async () => {
    const out = await mapLimit([30, 1, 20, 2], 4, async (ms) => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 1, 20, 2]);
  });

  it("never runs more than `limit` at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit([...Array(12).keys()], 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(2);
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("is concurrent — 8 × 10 ms with limit 4 takes well under the serial time", async () => {
    const start = Date.now();
    await mapLimit([...Array(8).keys()], 4, async () => { await tick(10); });
    expect(Date.now() - start).toBeLessThan(70);
  });

  it("propagates the first rejection and starts no further items", async () => {
    let started = 0;
    await expect(
      mapLimit([...Array(20).keys()], 2, async (i) => {
        started++;
        await tick(1);
        if (i === 1) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
    expect(started).toBeLessThan(20);
  });

  it("returns [] for an empty input without calling fn", async () => {
    let calls = 0;
    expect(await mapLimit([], 4, async () => { calls++; return 1; })).toEqual([]);
    expect(calls).toBe(0);
  });

  it("throws AbortedError when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(mapLimit([1, 2], 2, async (x) => x, ac.signal)).rejects.toBeInstanceOf(AbortedError);
  });

  it("stops scheduling once the signal aborts mid-run", async () => {
    const ac = new AbortController();
    let started = 0;
    await expect(
      mapLimit([...Array(20).keys()], 1, async () => {
        started++;
        if (started === 3) ac.abort();
        await tick(1);
      }, ac.signal),
    ).rejects.toBeInstanceOf(AbortedError);
    expect(started).toBe(3);
  });

  it("defaults to a sane concurrency constant", () => {
    expect(DEFAULT_CONCURRENCY).toBe(4);
  });
});

describe("mapRecordLimit", () => {
  it("keys the results back by the original key", async () => {
    const out = await mapRecordLimit({ a: 1, b: 2 }, 2, async (k, v) => `${k}${v}`);
    expect(out).toEqual({ a: "a1", b: "b2" });
  });
});
