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
  it("counts warning lines", () => {
    const output = `
src/a.cpp:1: warning: implicit conversion
src/b.cpp:2: warning: unused variable
Build: 2 warning(s)
`;
    // "2 warning(s)" is excluded, so only 2 actual warnings
    expect(countWarnings(output)).toBe(2);
  });

  it("returns 0 for clean output", () => {
    expect(countWarnings("Building...\nDone.")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(countWarnings("WARNING: something\nWarning: other")).toBe(2);
  });
});
