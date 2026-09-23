import { mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import { isEntryPoint } from "./entry.js";

describe("isEntryPoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "entry-"));
  const file = join(dir, "index.js");
  writeFileSync(file, "");
  const url = pathToFileURL(file).href;

  it("is the entry point when node was started with the file itself", () => {
    expect(isEntryPoint(file, url)).toBe(true);
  });

  it("is the entry point through a node_modules/.bin symlink (npx, npm i -g)", () => {
    const link = join(dir, "crosspad-mcp-server");
    symlinkSync(file, link);
    expect(isEntryPoint(link, url)).toBe(true);
  });

  it("is not the entry point when imported by another program, or with no argv", () => {
    const other = join(dir, "other.js");
    writeFileSync(other, "");
    expect(isEntryPoint(other, url)).toBe(false);
    expect(isEntryPoint(undefined, url)).toBe(false);
    expect(isEntryPoint(join(dir, "missing.js"), url)).toBe(false);
  });
});
