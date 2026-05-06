import { describe, it, expect } from "vitest";
import { parseErrors, countWarnings } from "./build.js";

describe("parseErrors (PC build)", () => {
  it("extracts MSVC-style errors", () => {
    const output = `
main.cpp(42): error C2065: 'foo': undeclared identifier
main.cpp(43): warning C4244: conversion from 'double' to 'int'
Build succeeded.
`;
    const errors = parseErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error C2065");
  });

  it("extracts GCC-style errors", () => {
    const output = `
src/main.cpp:42:10: error: use of undeclared identifier 'foo'
src/main.cpp:43:5: warning: unused variable 'bar'
`;
    const errors = parseErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error:");
  });

  it("excludes summary lines like '0 error(s)'", () => {
    const output = `
Build: 0 error(s), 2 warning(s)
`;
    expect(parseErrors(output)).toHaveLength(0);
  });

  it("caps at 20 errors", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      `file.cpp(${i}): error C1234: problem ${i}`
    ).join("\n");
    expect(parseErrors(lines)).toHaveLength(20);
  });

  it("returns empty for clean output", () => {
    expect(parseErrors("Building...\nDone.\n")).toHaveLength(0);
  });
});

describe("countWarnings (PC build)", () => {
  it("counts compiler warnings (GCC/Clang style)", () => {
    const output = `
src/a.cpp:1:5: warning: implicit conversion
src/b.cpp:2:10: warning: unused variable
Build: 2 warning(s)
`;
    // "2 warning(s)" excluded, only real diagnostics counted
    expect(countWarnings(output)).toBe(2);
  });

  it("counts MSVC warnings", () => {
    const output = `main.cpp(42): warning C4244: conversion from 'double' to 'int'`;
    expect(countWarnings(output)).toBe(1);
  });

  it("returns 0 for clean output", () => {
    expect(countWarnings("Building...\nDone.")).toBe(0);
  });

  it("ignores bare 'warning' keyword without compiler-diagnostic context", () => {
    // Old loose matcher counted these — now we require :line:col: or (line):
    expect(countWarnings("WARNING: cmake found something\nNote: warning is expected"))
      .toBe(0);
  });
});

describe("parseErrors regression — false positives", () => {
  it("ignores 'error' as a substring in unrelated cmake/ninja output", () => {
    const output = `
-- Configuring done
-- Found error handling library at /usr/lib
[42/100] Building CXX object src/error_handler.cpp.o
Generated error_codes.h
`;
    expect(parseErrors(output)).toHaveLength(0);
  });

  it("captures linker undefined reference", () => {
    const output = `/usr/bin/ld: undefined reference to 'foo()'`;
    expect(parseErrors(output)).toHaveLength(1);
  });

  it("captures CMake Error", () => {
    const output = `CMake Error at CMakeLists.txt:42 (find_package): could not find Foo`;
    expect(parseErrors(output)).toHaveLength(1);
  });

  it("captures Ninja FAILED marker", () => {
    const output = `[42/100] Building foo.o\nFAILED: foo.o\nclang: ...`;
    expect(parseErrors(output)).toHaveLength(1);
  });
});
