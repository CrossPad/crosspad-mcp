import { describe, it, expect, vi } from "vitest";
import { parseErrors, parseWarnings, getTail, crosspadIdfBuild } from "./idf-build.js";
import { idfArgs, resolveBoard } from "../utils/board.js";
import { runIdf, runIdfStream } from "../utils/exec.js";

vi.mock("../utils/board.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/board.js")>();
  return { ...actual, resolveBoard: vi.fn(actual.resolveBoard) };
});

vi.mock("../utils/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/exec.js")>();
  return { ...actual, runIdf: vi.fn(actual.runIdf), runIdfStream: vi.fn(actual.runIdfStream) };
});

describe("idfArgs", () => {
  it("names the build dir and sdkconfig of the revision", () => {
    expect(idfArgs({ rev: "v2", build_dir: "build_v2", sdkconfig: "sdkconfig.v2" } as any))
      .toEqual(["-B", "build_v2", "-DSDKCONFIG=sdkconfig.v2"]);
  });
});

describe("crosspadIdfBuild — board resolution failures", () => {
  it("turns a rejected resolveBoard into a structured build failure, never running idf.py", async () => {
    vi.mocked(resolveBoard).mockRejectedValueOnce(new Error("crosspad_board.py gave no decision: spawn python3 ENOENT"));
    const result = await crosspadIdfBuild("build");
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Board resolver failed");
    expect(result.errors[0]).toContain("crosspad_board.py gave no decision");
    expect(result.warnings).toEqual([]);
    expect(result.tail).toEqual([]);
    expect(runIdf).not.toHaveBeenCalled();
    expect(runIdfStream).not.toHaveBeenCalled();
  });

  it("refuses with no idf.py call when the resolver reports no known revision", async () => {
    vi.mocked(resolveBoard).mockResolvedValueOnce({
      rev: null, source: "none", device: null, pcb: null, fw_rev: null,
      build_dir: null, sdkconfig: null, mismatch: false,
    });
    const result = await crosspadIdfBuild("build");
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("No board revision");
    expect(runIdf).not.toHaveBeenCalled();
    expect(runIdfStream).not.toHaveBeenCalled();
  });
});

describe("parseErrors (IDF build)", () => {
  it("extracts GCC compile errors", () => {
    const output = `
/home/user/project/main/app.cpp:42:10: error: 'foo' was not declared in this scope
/home/user/project/main/app.cpp:43:5: warning: unused variable 'bar'
`;
    const errors = parseErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(":42:10: error:");
  });

  it("extracts fatal errors", () => {
    const output = `/home/user/main.cpp:1:10: fatal error: missing_header.h: No such file`;
    const errors = parseErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("fatal error");
  });

  it("extracts linker errors", () => {
    const output = `
/usr/bin/ld: error: cannot find -lfoo
undefined reference to \`bar::baz()\`
`;
    const errors = parseErrors(output);
    expect(errors).toHaveLength(2);
  });

  it("extracts CMake errors", () => {
    const output = `CMake Error at CMakeLists.txt:42 (add_executable):\n  Target "foo" already exists.`;
    expect(parseErrors(output)).toHaveLength(1);
  });

  it("extracts FAILED: lines (not progress lines)", () => {
    const output = `
[123/456] Building CXX object main.cpp.o
FAILED: main/CMakeFiles/main.dir/app.cpp.o
`;
    const errors = parseErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("FAILED:");
  });

  it("ignores progress lines starting with [", () => {
    const output = `[1/100] FAILED: not really`;
    // starts with "[" so should be skipped
    expect(parseErrors(output)).toHaveLength(0);
  });

  it("caps at 30 errors", () => {
    const lines = Array.from({ length: 40 }, (_, i) =>
      `/file.cpp:${i}:1: error: problem ${i}`
    ).join("\n");
    expect(parseErrors(lines)).toHaveLength(30);
  });

  it("returns empty for clean output", () => {
    expect(parseErrors("[100/100] Done.\n")).toHaveLength(0);
  });
});

describe("parseWarnings (IDF build)", () => {
  it("extracts GCC warnings", () => {
    const output = `
/home/user/main.cpp:42:10: warning: unused variable 'x' [-Wunused-variable]
/home/user/main.cpp:43:10: warning: implicit conversion [-Wconversion]
`;
    expect(parseWarnings(output)).toHaveLength(2);
  });

  it("ignores non-warning lines", () => {
    const output = `
Building...
[42/100] Compiling main.cpp
/file.cpp:1:1: error: something
Done.
`;
    expect(parseWarnings(output)).toHaveLength(0);
  });

  it("caps at 20 warnings", () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      `/f.cpp:${i}:1: warning: w${i}`
    ).join("\n");
    expect(parseWarnings(lines)).toHaveLength(20);
  });
});

describe("getTail", () => {
  it("returns last n non-empty lines", () => {
    const output = "a\nb\n\nc\nd\n\n";
    expect(getTail(output, 2)).toEqual(["c", "d"]);
  });

  it("returns all lines if fewer than n", () => {
    expect(getTail("a\nb", 10)).toEqual(["a", "b"]);
  });

  it("handles empty input", () => {
    expect(getTail("", 5)).toEqual([]);
  });

  it("handles single line", () => {
    expect(getTail("hello", 3)).toEqual(["hello"]);
  });

  it("filters blank lines before slicing", () => {
    const output = "\n\n\nonly line\n\n\n";
    expect(getTail(output, 5)).toEqual(["only line"]);
  });
});
