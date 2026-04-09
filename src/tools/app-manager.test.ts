import { describe, it, expect } from "vitest";
import { isCompatible, buildPythonCmd } from "./app-manager.js";

describe("isCompatible", () => {
  const makeApp = (platforms: string[]) => ({
    name: "Test",
    version: "1.0.0",
    description: "test",
    repo: "test/repo",
    component_path: "components/test",
    icon: "test.png",
    category: "music",
    platforms,
    requires: {},
  });

  it("returns true when platform matches", () => {
    expect(isCompatible(makeApp(["esp-idf", "arduino"]), "esp-idf")).toBe(true);
    expect(isCompatible(makeApp(["pc", "arduino"]), "pc")).toBe(true);
  });

  it("returns false when platform does not match", () => {
    expect(isCompatible(makeApp(["pc"]), "esp-idf")).toBe(false);
    expect(isCompatible(makeApp(["esp-idf"]), "arduino")).toBe(false);
  });

  it("returns false for empty platforms", () => {
    expect(isCompatible(makeApp([]), "esp-idf")).toBe(false);
  });
});

describe("buildPythonCmd", () => {
  it("generates valid Python one-liner with given root and scriptDir", () => {
    const cmd = buildPythonCmd("/home/user/GIT/platform-idf", "tools", "list_apps");
    expect(cmd).toContain("python3 -c");
    expect(cmd).toContain("from app_manager import AppManager");
    expect(cmd).toContain("mgr.list_apps()");
    expect(cmd).toContain("/home/user/GIT/platform-idf/tools");
  });

  it("uses scripts dir for PC/Arduino", () => {
    const cmd = buildPythonCmd("/home/user/GIT/crosspad-pc", "scripts", "install", "'sampler', ref='main'");
    expect(cmd).toContain("/home/user/GIT/crosspad-pc/scripts");
    expect(cmd).toContain("mgr.install('sampler', ref='main')");
  });

  it("normalizes backslashes to forward slashes", () => {
    const cmd = buildPythonCmd("C:\\Users\\dev\\GIT\\platform-idf", "tools", "sync");
    expect(cmd).toContain("C:/Users/dev/GIT/platform-idf/tools");
    expect(cmd).not.toMatch(/[A-Z]:\\/);
  });

  it("includes method arguments", () => {
    const cmd = buildPythonCmd("/root", "tools", "update", "update_all=True");
    expect(cmd).toContain("mgr.update(update_all=True)");
  });
});
