import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TOOLSETS } from "./toolsets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");
const pkg = JSON.parse(read("package.json")) as Record<string, string> & { scripts: Record<string, string> };
const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as Record<string, string>;
const readme = read("README.md");
const changelog = read("CHANGELOG.md");

const ALL_TOOLS = [...new Set(Object.values(TOOLSETS).flat())];

describe("release metadata", () => {
  it("package.json is the 10.0.0 breaking release", () => {
    expect(pkg.version).toBe("10.0.0");
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

  it("CHANGELOG's newest entry is 10.0.0", () => {
    const firstHeading = changelog.split("\n").find((l) => l.startsWith("## ["));
    expect(firstHeading).toBe("## [10.0.0] — 2026-08-26");
    expect(changelog).toContain("crosspad-hil");
  });
});

describe("README documents what the server actually does", () => {
  it("has the v9 → v10 migration table", () => {
    expect(readme).toContain("<b>v9 → v10</b>");
    expect(readme).toContain("`crosspad_log` with `target: idf`");
    expect(readme).toContain("`crosspad_architecture`");
    expect(readme).toContain("`crosspad_apps`");
    expect(readme).toContain("P1 — v9 names still registered");
  });

  it("documents every toolset name", () => {
    for (const name of Object.keys(TOOLSETS)) {
      expect(readme, `toolset ${name} missing from README`).toContain(`\`${name}\``);
    }
  });

  it("documents the startup flags", () => {
    expect(readme).toContain("--read-only");
    expect(readme).toContain("--toolsets");
    expect(readme).toContain("CROSSPAD_TOOLSETS");
  });

  it("names every tool that a toolset contains", () => {
    for (const tool of ALL_TOOLS) {
      expect(readme, `${tool} missing from README`).toContain(`\`${tool}\``);
    }
  });

  it("the banner counts match the toolset map", () => {
    const banner = readme.split("\n").find((l) => l.includes("tools in") && l.includes("toolsets"));
    expect(banner, "README banner line not found").toBeDefined();
    const toolCount = Number(banner!.match(/\*\*(\d+) tools/)![1]);
    const toolsetCount = Number(banner!.match(/in (\d+) toolsets/)![1]);
    expect(toolCount).toBe(ALL_TOOLS.length);
    expect(toolsetCount).toBe(Object.keys(TOOLSETS).length);
  });
});
