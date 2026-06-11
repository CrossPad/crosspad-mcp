import { describe, it, expect } from "vitest";
import { TraceBuffer } from "./trace-buffer.js";
import { bufferToCsv } from "./trace-export.js";

describe("bufferToCsv", () => {
  it("emits a header row of t + signal names", () => {
    const b = new TraceBuffer(["a", "b"], 10);
    b.push({ t: 0, values: { a: 1, b: 2 } });
    const csv = bufferToCsv(b, ["a", "b"]);
    expect(csv.split("\n")[0]).toBe("t,a,b");
  });
  it("emits one row per sample with empty cells for missing signals", () => {
    const b = new TraceBuffer(["a", "b"], 10);
    b.push({ t: 0, values: { a: 1 } });
    b.push({ t: 1, values: { a: 2, b: 9 } });
    const rows = bufferToCsv(b, ["a", "b"]).split("\n");
    expect(rows[1]).toBe("0,1,");
    expect(rows[2]).toBe("1,2,9");
  });
});
