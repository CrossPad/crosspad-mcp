// src/tools/trace-symbols.test.ts
import { describe, it, expect } from "vitest";
import { parseSymbolsOutput } from "./trace-symbols.js";

describe("parseSymbolsOutput", () => {
  it("parses a valid daemon JSON line", () => {
    const out = JSON.stringify({ symbols: [{ name: "s_vbat_mv", address: 0x20000010, encoding: "uint", size: 2 }] });
    const r = parseSymbolsOutput(out);
    expect(r.success).toBe(true);
    expect(r.symbols[0]).toMatchObject({ name: "s_vbat_mv", encoding: "uint", size: 2 });
  });
  it("ignores stderr noise and finds the JSON line", () => {
    const out = "loading elf...\nsome log\n" + JSON.stringify({ symbols: [] });
    expect(parseSymbolsOutput(out).success).toBe(true);
  });
  it("returns success=false with error on non-JSON output", () => {
    const r = parseSymbolsOutput("Traceback: ImportError no module elftools");
    expect(r.success).toBe(false);
    expect(r.error).toContain("ImportError");
  });

  it("preserves the richer §8 metadata fields through the parse", () => {
    const out = JSON.stringify({ symbols: [
      { name: "s_adc_raw", address: 0x20000000, encoding: "uint", size: 64,
        kind: "array", dims: [32], count: 32, elem_size: 2, elem_encoding: "uint" },
      { name: "s_cfg", address: 0x20000100, encoding: "uint", size: 8,
        kind: "struct", members: ["a", "b"] },
    ] });
    const r = parseSymbolsOutput(out);
    expect(r.success).toBe(true);
    expect(r.symbols[0]).toMatchObject({
      kind: "array", dims: [32], count: 32, elem_size: 2, elem_encoding: "uint",
    });
    expect(r.symbols[1]).toMatchObject({ kind: "struct", members: ["a", "b"] });
  });
});
