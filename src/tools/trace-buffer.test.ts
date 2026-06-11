import { describe, it, expect } from "vitest";
import { TraceBuffer } from "./trace-buffer.js";

describe("TraceBuffer", () => {
  it("stores samples and reports count", () => {
    const b = new TraceBuffer(["a", "b"], 100);
    b.push({ t: 0, values: { a: 1, b: 2 } });
    b.push({ t: 1, values: { a: 3, b: 4 } });
    expect(b.count()).toBe(2);
  });

  it("evicts oldest beyond capacity (ring)", () => {
    const b = new TraceBuffer(["a"], 3);
    for (let i = 0; i < 5; i++) b.push({ t: i, values: { a: i } });
    expect(b.count()).toBe(3);
    expect(b.stats("a")?.first_t).toBe(2);
    expect(b.stats("a")?.last_t).toBe(4);
  });

  it("computes per-signal stats (min/max/avg/last/slope)", () => {
    const b = new TraceBuffer(["a"], 100);
    b.push({ t: 0, values: { a: 10 } });
    b.push({ t: 1, values: { a: 20 } });
    b.push({ t: 2, values: { a: 30 } });
    const s = b.stats("a")!;
    expect(s.min).toBe(10);
    expect(s.max).toBe(30);
    expect(s.avg).toBe(20);
    expect(s.last).toBe(30);
    expect(s.slope).toBeCloseTo(10); // per unit t
  });

  it("downsamples to at most max_points by stride", () => {
    const b = new TraceBuffer(["a"], 1000);
    for (let i = 0; i < 100; i++) b.push({ t: i, values: { a: i } });
    const d = b.downsample("a", 10);
    expect(d.length).toBeLessThanOrEqual(10);
    expect(d[0]).toEqual({ t: 0, v: 0 });
    expect(d[d.length - 1].t).toBe(99); // last point always retained
  });

  it("windows by time range before downsampling", () => {
    const b = new TraceBuffer(["a"], 1000);
    for (let i = 0; i < 100; i++) b.push({ t: i, values: { a: i } });
    const d = b.downsample("a", 1000, { fromT: 50, toT: 60 });
    expect(d.every((p) => p.t >= 50 && p.t <= 60)).toBe(true);
  });

  it("addSignal/removeSignal mutate the watched set (idempotent)", () => {
    const b = new TraceBuffer(["a"], 100);
    b.addSignal("b");
    expect(b.signalNames()).toEqual(["a", "b"]);
    b.addSignal("b"); // no-op if already present
    expect(b.signalNames()).toEqual(["a", "b"]);
    b.removeSignal("a");
    expect(b.signalNames()).toEqual(["b"]);
    b.removeSignal("a"); // no-op if absent
    expect(b.signalNames()).toEqual(["b"]);
  });

  it("keeps stored samples when a signal is removed", () => {
    const b = new TraceBuffer(["a"], 100);
    b.push({ t: 0, values: { a: 10 } });
    b.push({ t: 1, values: { a: 20 } });
    b.removeSignal("a");
    expect(b.count()).toBe(2); // history survives
    expect(b.stats("a")?.last).toBe(20); // still queryable
  });
});
