import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TOOLSETS } from "./toolsets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");
const pkg = JSON.parse(read("package.json")) as Record<string, string> & { scripts: Record<string, string> };
const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as Record<string, string>;
const reference = read("docs/USAGE.md");
const changelog = read("CHANGELOG.md");

const ALL_TOOLS = [...new Set(Object.values(TOOLSETS).flat())];

describe("release metadata", () => {
  it("package.json is 10.1.0", () => {
    expect(pkg.version).toBe("10.1.0");
  });

  it("declares the crosspad-hil version it requires", () => {
    expect(pkg.hilVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.hilVersion).toBe("1.0.0");
  });

  it("plugin.json version is synced with package.json", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("ships the eval scripts", () => {
    expect(pkg.scripts["eval:grade"]).toBe("node eval/grade.ts");
    expect(pkg.scripts["typecheck:eval"]).toBe("tsc -p tsconfig.eval.json --noEmit");
  });

  it("CHANGELOG's newest entry is 10.1.0", () => {
    const firstHeading = changelog.split("\n").find((l) => l.startsWith("## ["));
    expect(firstHeading).toBe("## [10.1.0] — 2026-08-30");
    expect(changelog).toContain("crosspad-hil");
  });
});

describe("docs/USAGE.md documents what the server actually does", () => {
  it("has the v9 → v10 migration table", () => {
    expect(reference).toContain("<b>v9 → v10</b>");
    expect(reference).toContain("`crosspad_log` with `target: idf`");
    expect(reference).toContain("`crosspad_architecture`");
    expect(reference).toContain("`crosspad_apps`");
    // The merges have landed, so every row is "shipped" — what still has to be
    // true is that the v9 names they replaced are documented as still callable.
    expect(reference).toContain("the five v9 names stay registered (toolset `apps`)");
  });

  it("documents every toolset name", () => {
    for (const name of Object.keys(TOOLSETS)) {
      expect(reference, `toolset ${name} missing from docs/USAGE.md`).toContain(`\`${name}\``);
    }
  });

  it("documents the startup flags", () => {
    expect(reference).toContain("--read-only");
    expect(reference).toContain("--toolsets");
    expect(reference).toContain("CROSSPAD_TOOLSETS");
  });

  it("names every tool that a toolset contains", () => {
    for (const tool of ALL_TOOLS) {
      expect(reference, `${tool} missing from docs/USAGE.md`).toContain(`\`${tool}\``);
    }
  });

  it("the banner counts match the toolset map", () => {
    const banner = reference.split("\n").find((l) => l.includes("tools in") && l.includes("toolsets"));
    expect(banner, "USAGE.md banner line not found").toBeDefined();
    const toolCount = Number(banner!.match(/\*\*(\d+) tools/)![1]);
    const toolsetCount = Number(banner!.match(/in (\d+) toolsets/)![1]);
    expect(toolCount).toBe(ALL_TOOLS.length);
    expect(toolsetCount).toBe(Object.keys(TOOLSETS).length);
  });
});
