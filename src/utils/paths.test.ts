import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { HilError } from "../hil/daemon.js";
import { REPOS } from "../config.js";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerAnalyzeTool, registerCaptureTool } from "../tools/capture.js";
import { registerDiagnoseCrashTool } from "../tools/stimulus.js";
import { JobRegistry } from "../tasks.js";
import { HandleRegistry } from "../handles.js";
import {
  ALLOWED_PATHS_ENV,
  PATH_NOT_ALLOWED,
  assertAllowedPath,
  describeAllowedRoots,
  isAllowedPath,
  realpathLoose,
} from "./paths.js";

const TMP = fs.realpathSync(os.tmpdir());
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ TMPDIR: TMP, ...extra });

// A scratch tree that looks like the ones the capture/diagnose tools work in.
let scratch: string;
let outsider: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(TMP, "crosspad-pathtest-"));
  outsider = fs.mkdtempSync(path.join(TMP, "notcrosspad-"));
  fs.writeFileSync(path.join(outsider, "secret.txt"), "s");
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(outsider, { recursive: true, force: true });
});

describe("allowed roots", () => {
  it("accepts a path inside a configured repo root", () => {
    const repo = REPOS["platform-idf"];
    expect(isAllowedPath(path.join(repo, "hil_logs", "console.log"), env())).toBe(true);
  });

  it("accepts $TMPDIR/crosspad-* and refuses the rest of $TMPDIR", () => {
    expect(isAllowedPath(path.join(scratch, "take.wav"), env())).toBe(true);
    expect(isAllowedPath(path.join(outsider, "secret.txt"), env())).toBe(false);
    // $TMPDIR itself is not a root — only the crosspad-* scratch dirs under it.
    expect(isAllowedPath(path.join(TMP, "take.wav"), env())).toBe(false);
  });

  it("honours CROSSPAD_MCP_ALLOWED_PATHS", () => {
    const e = env({ [ALLOWED_PATHS_ENV]: outsider });
    expect(isAllowedPath(path.join(outsider, "secret.txt"), e)).toBe(true);
    expect(describeAllowedRoots(e)).toContain(fs.realpathSync(outsider));
  });

  it("names $TMPDIR/crosspad-* among the roots it reports", () => {
    expect(describeAllowedRoots(env())).toContain(path.join(TMP, "crosspad-*"));
  });
});

describe("assertAllowedPath", () => {
  it("refuses /etc/passwd with a typed error naming the roots and the env var", () => {
    let caught: unknown;
    try {
      assertAllowedPath("log_file", "/etc/passwd", env());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HilError);
    const e = caught as HilError;
    expect(e.code).toBe(PATH_NOT_ALLOWED);
    expect(e.message).toContain("/etc/passwd");
    expect(e.message).toContain("log_file");
    expect(e.hint).toContain(ALLOWED_PATHS_ENV);
    expect(e.details.allowed_roots).toEqual(describeAllowedRoots(env()));
  });

  it("passes an absent argument through untouched", () => {
    expect(assertAllowedPath("out", undefined, env())).toBeUndefined();
    expect(assertAllowedPath("out", "", env())).toBeUndefined();
  });

  it("returns the resolved path for an allowed one", () => {
    const p = path.join(scratch, "sub", "take.wav");
    expect(assertAllowedPath("out", p, env())).toBe(p);
  });

  it("resolves .. before deciding, so a traversal out of a root is refused", () => {
    expect(() => assertAllowedPath("firmware", path.join(scratch, "..", "..", "etc", "passwd"), env()))
      .toThrow(/outside every allowed root/);
  });

  it("follows a symlink out of an allowed root and refuses the target", () => {
    const link = path.join(scratch, "escape");
    fs.symlinkSync(outsider, link);
    expect(() => assertAllowedPath("elf", path.join(link, "secret.txt"), env()))
      .toThrow(/outside every allowed root/);
  });

  it("refuses a DANGLING symlink whose target is outside — the write would follow it", () => {
    const link = path.join(scratch, "dangling.wav");
    fs.symlinkSync(path.join(outsider, "not-created-yet.wav"), link);
    expect(realpathLoose(link)).toBe(path.join(fs.realpathSync(outsider), "not-created-yet.wav"));
    expect(() => assertAllowedPath("out", link, env())).toThrow(/outside every allowed root/);
  });

  it("allows a file that does not exist yet inside an allowed root", () => {
    expect(isAllowedPath(path.join(scratch, "nested", "deeper", "new.wav"), env())).toBe(true);
  });
});

// The check is only worth anything where the paths enter. These pin the wiring
// in the two tools whose path parameters reach the host filesystem.
describe("wired into the path-taking tools", () => {
  const ctx = (daemon: ReturnType<typeof fakeDaemon>) =>
    ({ daemon: () => daemon, policy: { mode: "strict", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() });

  it("crosspad_capture refuses an `out` outside the roots and records nothing", async () => {
    const srv = fakeServer();
    const d = fakeDaemon({ "capture.start": () => ({ handle: "cap_1" }) });
    registerCaptureTool(srv.server, ctx(d) as never);
    const r = await srv.tools.get("crosspad_capture")!.cb(
      { action: "start", seconds: 1, out: "/etc/crosspad.wav" },
      fakeExtra(),
    );
    expect((r.structuredContent as Record<string, unknown>).error).toMatchObject({ code: PATH_NOT_ALLOWED });
    expect(d.calls).toHaveLength(0);
  });

  it("crosspad_analyze refuses a `wav` outside the roots", async () => {
    const srv = fakeServer();
    const d = fakeDaemon({ "analyze.wav": () => ({ verdict: "ok" }) });
    registerAnalyzeTool(srv.server, ctx(d) as never);
    const r = await srv.tools.get("crosspad_analyze")!.cb({ kind: "silence", wav: "/etc/hosts" }, fakeExtra());
    expect((r.structuredContent as Record<string, unknown>).error).toMatchObject({ code: PATH_NOT_ALLOWED });
    expect(d.calls).toHaveLength(0);
  });

  it("crosspad_diagnose_crash refuses /etc/passwd instead of linking it back", async () => {
    const srv = fakeServer();
    const d = fakeDaemon({ "diagnose.crash": () => ({ found: false }) });
    registerDiagnoseCrashTool(srv.server, ctx(d) as never);
    const r = await srv.tools.get("crosspad_diagnose_crash")!.cb({ log_file: "/etc/passwd" }, fakeExtra());
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc.error).toMatchObject({ code: PATH_NOT_ALLOWED });
    expect(JSON.stringify(r.content)).not.toContain("file:///etc/passwd");
    expect(d.calls).toHaveLength(0);
  });

  it("crosspad_diagnose_crash refuses an `elf` outside the roots", async () => {
    const srv = fakeServer();
    const d = fakeDaemon({ "diagnose.crash": () => ({ found: false }) });
    registerDiagnoseCrashTool(srv.server, ctx(d) as never);
    const r = await srv.tools.get("crosspad_diagnose_crash")!.cb(
      { log_file: path.join(REPOS["platform-idf"], "hil_logs", "a.log"), elf: "/bin/sh" },
      fakeExtra(),
    );
    expect((r.structuredContent as Record<string, unknown>).error).toMatchObject({ code: PATH_NOT_ALLOWED });
    expect(d.calls).toHaveLength(0);
  });
});
