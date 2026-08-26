import { describe, it, expect } from "vitest";
import { parseCatch2Output, parseCtestOutput, ctestCommand, parseErrors } from "./test.js";

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

// ─────────────────────────────────────────────────────────────────────
// CTest label path. The [gui] cases live in a second executable that
// only CTest launches, so before `labels` existed they were unreachable
// from this tool no matter what filter you passed.
// ─────────────────────────────────────────────────────────────────────

describe("ctestCommand", () => {
  it("runs the gui label and excludes the flaky entries by default", () => {
    const cmd = ctestCommand(["gui"], "", false);
    expect(cmd).toContain("-L gui");
    expect(cmd).toContain("-LE flaky");
  });

  it("includes the flaky entries when they are asked for by name", () => {
    const cmd = ctestCommand(["gui", "flaky"], "", false);
    expect(cmd).toContain("-L gui");
    expect(cmd).not.toContain("-LE flaky");
  });

  it("selects the flaky label on its own", () => {
    expect(ctestCommand(["flaky"], "", false)).toContain("-L flaky");
  });

  it("passes a filter as a name regex, since ctest cannot see Catch2 tags", () => {
    expect(ctestCommand(["gui"], "gui_integration", false)).toContain('-R "gui_integration"');
  });

  it("lists without running for list_only", () => {
    expect(ctestCommand(["gui"], "", true)).toContain("-N");
  });

  it("always shows the output of a failed entry", () => {
    // A CTest failure that only says "1 test failed" is useless from here.
    expect(ctestCommand(["gui"], "", false)).toContain("--output-on-failure");
  });
});

describe("parseCtestOutput", () => {
  it("reads the summary line", () => {
    const out = `
100% tests passed, 0 tests failed out of 2

Total Test time (real) =  12.34 sec
`;
    expect(parseCtestOutput(out)).toEqual({ passed: 2, failed: 0 });
  });

  it("counts a partial failure", () => {
    expect(parseCtestOutput("50% tests passed, 1 tests failed out of 2")).toEqual({ passed: 1, failed: 1 });
  });

  it("falls back to per-entry lines when there is no summary", () => {
    const out = `
    Start 1: gui_integration
1/2 Test #1: gui_integration ..................   Passed    9.11 sec
    Start 2: gui_audio_citest
2/2 Test #2: gui_audio_citest .................***Failed   12.00 sec
`;
    expect(parseCtestOutput(out)).toEqual({ passed: 1, failed: 1 });
  });

  it("counts a timeout as a failure", () => {
    expect(parseCtestOutput("1/1 Test #1: gui_integration ...***Timeout  60.01 sec")).toEqual({ passed: 0, failed: 1 });
  });

  it("returns zeros for output it does not recognise", () => {
    expect(parseCtestOutput("nothing useful here")).toEqual({ passed: 0, failed: 0 });
  });
});
