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
});
