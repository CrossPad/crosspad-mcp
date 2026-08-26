import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { appGuard, buildPythonCmd, isCompatible } from "./app-manager.js";

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

describe("appGuard — never run over local work", () => {
  const mkRepo = (): { root: string; app: string } => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-appguard-"));
    const app = path.join(root, "components", "crosspad-sampler");
    fs.mkdirSync(app, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: app });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: app });
    execFileSync("git", ["config", "user.name", "t"], { cwd: app });
    fs.writeFileSync(path.join(app, "a.txt"), "one\n");
    execFileSync("git", ["add", "-A"], { cwd: app });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: app });
    return { root, app };
  };
  const info = (root: string) =>
    ({ label: "ESP-IDF", root, scriptDir: "tools", platformId: "esp-idf" });
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it("says nothing about an app that is not installed yet", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-appguard-"));
    made.push(root);
    // A fresh install has nothing to lose, so there is nothing to guard.
    expect(await appGuard(info(root) as never, "sampler")).toBeNull();
  });

  it("passes a clean checkout", async () => {
    const { root } = mkRepo(); made.push(root);
    const v = await appGuard(info(root) as never, "sampler");
    expect(v?.safe).toBe(true);
  });

  it("refuses when the working tree is dirty", async () => {
    const { root, app } = mkRepo(); made.push(root);
    fs.writeFileSync(path.join(app, "a.txt"), "edited\n");
    const v = await appGuard(info(root) as never, "sampler");
    expect(v?.safe).toBe(false);
    expect(v?.reason).toBe("uncommitted changes");
    expect(v?.detail).toContain("a.txt");
  });

  it("refuses when there are commits the remote has not seen", async () => {
    const { root, app } = mkRepo(); made.push(root);
    // give it an upstream, then commit past it
    const remote = path.join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: app });
    execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: app });
    fs.writeFileSync(path.join(app, "b.txt"), "new\n");
    execFileSync("git", ["add", "-A"], { cwd: app });
    execFileSync("git", ["commit", "-qm", "local work"], { cwd: app });
    const v = await appGuard(info(root) as never, "sampler");
    expect(v?.safe).toBe(false);
    expect(v?.reason).toBe("commits not pushed");
    expect(v?.detail).toContain("local work");
  });

  it("does not call a checkout with no upstream 'ahead'", async () => {
    // git reports "no upstream" on stderr; treating that as unpushed commits
    // would block every locally-created app.
    const { root } = mkRepo(); made.push(root);
    const v = await appGuard(info(root) as never, "sampler");
    expect(v?.safe).toBe(true);
  });
});
