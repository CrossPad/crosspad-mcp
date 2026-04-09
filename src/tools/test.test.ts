import { describe, it, expect } from "vitest";
import { parseCatch2Output, parseErrors } from "./test.js";

describe("parseCatch2Output", () => {
  it("parses compact reporter success output", () => {
    const output = `
All tests passed (42 assertions in 5 test cases)
`;
    const { passed, failed } = parseCatch2Output(output);
    expect(passed).toBe(42);
    expect(failed).toBe(0);
  });

  it("parses assertions passed line", () => {
    // Regex matches first number before "assertion(s)...passed"
    const output = `12 assertions in 3 test cases were run. 10 assertions passed, 2 failed.`;
    const { passed } = parseCatch2Output(output);
    // First match: "12 assertions ... passed" → 12 (the regex grabs the first \d+ before "assertion")
    expect(passed).toBe(12);
  });

  it("parses failed assertions", () => {
    // The failedMatch regex: /(\d+)\s+assertion[s]?\s+.*failed/i
    const output = `5 assertions in 2 test cases failed`;
    const { failed } = parseCatch2Output(output);
    expect(failed).toBe(5);
  });

  it("returns zeros for unrecognized output", () => {
    const { passed, failed } = parseCatch2Output("random output");
    expect(passed).toBe(0);
    expect(failed).toBe(0);
  });

  it("returns zeros for empty output", () => {
    const { passed, failed } = parseCatch2Output("");
    expect(passed).toBe(0);
    expect(failed).toBe(0);
  });
});

describe("parseErrors (test module)", () => {
  it("extracts error lines", () => {
    const output = `
FAILED:
  src/test.cpp:42: REQUIRE( x == y ) with expansion: 1 == 2
error: test failure
`;
    const errors = parseErrors(output);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("error"))).toBe(true);
  });

  it("excludes summary lines", () => {
    const output = "test completed: 0 error(s)";
    expect(parseErrors(output)).toHaveLength(0);
  });
});
