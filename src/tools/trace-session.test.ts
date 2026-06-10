import { describe, it, expect } from "vitest";
import { parseFrame } from "./trace-session.js";

describe("parseFrame", () => {
  it("parses a sample frame", () => {
    const f = parseFrame('{"type":"sample","t":1.5,"values":{"a":7}}');
    expect(f).toEqual({ type: "sample", t: 1.5, values: { a: 7 } });
  });
  it("parses a status frame", () => {
    const f = parseFrame('{"type":"status","device_state":"stop_suspected","t":2}');
    expect(f).toMatchObject({ type: "status", device_state: "stop_suspected" });
  });
  it("returns null for non-JSON / log lines", () => {
    expect(parseFrame("connecting probe...")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });
  it("returns null for JSON without a known type", () => {
    expect(parseFrame('{"foo":1}')).toBeNull();
  });
});
