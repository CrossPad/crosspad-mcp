import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const calls: Array<{ cmd: string; cwd: string; timeoutMs: number; signal?: AbortSignal }> = [];
let reply: (cmd: string) => { success: boolean; stdout: string } = () => ({ success: true, stdout: "" });
/** Optional per-test hook to make a command take measurable time. */
let delay: (() => Promise<void>) | null = null;

vi.mock("./exec.js", () => ({
  runCommandStream: vi.fn(async (cmd: string, cwd: string, _onLine: unknown, timeoutMs: number, signal?: AbortSignal) => {
    calls.push({ cmd, cwd, timeoutMs, signal });
    if (delay) await delay();
    const r = reply(cmd);
    return { success: r.success, stdout: r.stdout, stderr: "", exitCode: r.success ? 0 : 1, durationMs: 0 };
  }),
}));

/** A real directory that does (or does not) contain a .gitmodules file. */
function tmpRepo(withGitmodules: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-git-"));
  if (withGitmodules) fs.writeFileSync(path.join(dir, ".gitmodules"), "[submodule]\n");
  tmpDirs.push(dir);
  return dir;
}
const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const { git, getRepoStatus, getRepoStatuses, getHead, getSubmodulePin, listSubmodules, findSubmodulePath, _resetSubmoduleCache } =
  await import("./git.js");

beforeEach(() => {
  calls.length = 0;
  _resetSubmoduleCache();
  reply = () => ({ success: true, stdout: "" });
  delay = null;
});

describe("git()", () => {
  it("spawns (never execSync) and forwards the abort signal and timeout", async () => {
    const ac = new AbortController();
    await git("git status", "/repo", { signal: ac.signal, timeoutMs: 1234 });
    expect(calls[0]).toMatchObject({ cmd: "git status", cwd: "/repo", timeoutMs: 1234 });
    expect(calls[0].signal).toBe(ac.signal);
  });

  it("defaults the timeout when none is given", async () => {
    await git("git status", "/repo");
    expect(calls[0].timeoutMs).toBe(60_000);
  });
});

describe("getRepoStatus", () => {
  it("parses branch, head and dirty files", async () => {
    reply = (cmd) => {
      if (cmd.includes("branch --show-current")) return { success: true, stdout: "crosspad_v20\n" };
      if (cmd.includes("log --oneline")) return { success: true, stdout: "2d7c54b chore: pin\n" };
      return { success: true, stdout: " M a.cpp\n?? b.cpp\n" };
    };
    const s = await getRepoStatus("platform-idf", "/repo");
    expect(s).toEqual({
      name: "platform-idf",
      path: "/repo",
      branch: "crosspad_v20",
      head: "2d7c54b chore: pin",
      // NB: stdout is trimmed as a whole, so the first line loses its leading
      // status space — unchanged v9 behaviour, asserted so it stays deliberate.
      dirtyFiles: ["M a.cpp", "?? b.cpp"],
    });
  });

  it("issues its three reads concurrently", async () => {
    // The three commands must all be in flight before any of them resolves.
    let inFlight = 0;
    let peak = 0;
    delay = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };
    await getRepoStatus("r", "/repo");
    expect(peak).toBe(3);
  });
});

describe("getRepoStatuses", () => {
  it("walks every repo and keeps input order", async () => {
    reply = (cmd) => (cmd.includes("branch") ? { success: true, stdout: "main\n" } : { success: true, stdout: "" });
    const out = await getRepoStatuses({ a: "/a", b: "/b", c: "/c" });
    expect(out.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(out.map((r) => r.path)).toEqual(["/a", "/b", "/c"]);
  });
});

describe("listSubmodules", () => {
  it("parses .gitmodules through git config and caches the result", async () => {
    reply = () => ({ success: true, stdout: "submodule.crosspad-core.path components/crosspad-core\nsubmodule.crosspad-gui.path components/crosspad-gui\n" });
    const repo = tmpRepo(true);
    const first = await listSubmodules(repo);
    expect(first).toEqual({ "crosspad-core": "components/crosspad-core", "crosspad-gui": "components/crosspad-gui" });
    const second = await listSubmodules(repo);
    expect(second).toEqual(first);
    expect(calls.length).toBe(1); // second read served from cache
  });

  it("concurrent callers share one git config run", async () => {
    reply = () => ({ success: true, stdout: "submodule.x.path lib/x\n" });
    const repo = tmpRepo(true);
    const [a, b, c] = await Promise.all([listSubmodules(repo), listSubmodules(repo), listSubmodules(repo)]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(calls.length).toBe(1);
  });

  it("returns {} without running git when .gitmodules is absent", async () => {
    expect(await listSubmodules(tmpRepo(false))).toEqual({});
    expect(calls.length).toBe(0);
  });
});

describe("findSubmodulePath / getSubmodulePin / getHead", () => {
  it("resolves a submodule name to its .gitmodules path", async () => {
    reply = () => ({ success: true, stdout: "submodule.crosspad-core.path components/crosspad-core\n" });
    expect(await findSubmodulePath(tmpRepo(true), "crosspad-core")).toBe("components/crosspad-core");
  });

  it("reads the pinned sha through the resolved path", async () => {
    reply = (cmd) =>
      cmd.includes("git config")
        ? { success: true, stdout: "submodule.crosspad-core.path components/crosspad-core\n" }
        : { success: true, stdout: " abc1234def components/crosspad-core (heads/main)\n" };
    expect(await getSubmodulePin(tmpRepo(true), "crosspad-core")).toBe("abc1234def");
    expect(calls.some((c) => c.cmd.includes('git submodule status "components/crosspad-core"'))).toBe(true);
  });

  it("getHead returns null when git fails", async () => {
    reply = () => ({ success: false, stdout: "" });
    expect(await getHead("/not-a-repo")).toBeNull();
  });
});

describe("no synchronous subprocess on the request path", () => {
  // spec §3.7 / v10 global constraint: these modules are reached from a tool
  // handler, so a blocking execSync in any of them stalls the whole server and
  // cannot honour extra.signal.
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const CONVERTED = [
    "utils/git.ts",
    "utils/async.ts",
    "tools/repos.ts",
    "tools/symbols.ts",
    "tools/architecture.ts",
    "tools/trace-doctor.ts",
    "tools/build-check.ts",
    "tools/diff-core.ts",
    "tools/repo-actions.ts",
  ];

  for (const rel of CONVERTED) {
    it(`${rel} uses no execSync/spawnSync and no sync runCommand`, () => {
      // Strip comments first — these modules *document* why they no longer
      // call execSync, and the doc must not trip its own guard.
      const src = fs
        .readFileSync(path.join(ROOT, rel), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(src, `${rel} still calls a synchronous subprocess`).not.toMatch(/\b(execSync|spawnSync)\b/);
      expect(src, `${rel} still calls the blocking runCommand()`).not.toMatch(/\brunCommand\s*\(/);
    });
  }
});
