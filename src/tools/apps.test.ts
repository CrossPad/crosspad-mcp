import { describe, it, expect } from "vitest";
import { AppsInput, registerAppsTool, runApps, type AppsArgs, type AppsDeps } from "./apps.js";
import type { AppActionResult, AppGuardVerdict, AppListResult, PlatformInfo } from "./app-manager.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { Policy } from "../policy/policy.js";
import type { ToolContext } from "../tool-context.js";

const IDF: PlatformInfo = { label: "idf", root: "/repo/platform-idf", scriptDir: "tools", platformId: "esp-idf" };

const LIST: AppListResult = {
  success: true,
  apps: [{
    id: "sampler", name: "Sampler", version: "1.0.0", description: "", category: "music",
    platforms: ["esp-idf"], installed_in: [], compatible: true,
  }],
  installed_count: 0,
  total_count: 1,
};

/** The same registry with sampler and fishtank checked out on idf. */
const LIST_INSTALLED: AppListResult = {
  success: true,
  apps: [
    { ...LIST.apps[0], installed_in: [{ platform: "idf", version: "1.0.0", ref: "main" }] },
    {
      id: "fishtank", name: "Fish Tank", version: "0.2.0", description: "", category: "toy",
      platforms: ["esp-idf"], installed_in: [{ platform: "idf", version: "0.2.0", ref: "main" }], compatible: true,
    },
    {
      id: "looper", name: "Looper", version: "0.1.0", description: "", category: "music",
      platforms: ["pc"], installed_in: [{ platform: "pc", version: "0.1.0", ref: "main" }], compatible: true,
    },
  ],
  installed_count: 3,
  total_count: 3,
};

function action(over: Partial<AppActionResult> = {}): AppActionResult {
  return { success: true, action: "install", platform: "idf", output: "done", ...over };
}

/** Records what the dispatch called, so a test can assert the delegation. */
function makeDeps(over: Partial<AppsDeps> = {}): AppsDeps & { calls: string[]; guarded: string[] } {
  const calls: string[] = [];
  const guarded: string[] = [];
  const deps: AppsDeps & { calls: string[]; guarded: string[] } = {
    calls,
    guarded,
    list: (showAll) => { calls.push(`list(${showAll})`); return LIST; },
    install: async (app, platform, ref, force) => {
      calls.push(`install(${app},${platform},${ref},${force})`);
      return action({ action: "install", app_name: app, platform, next: "idf.py fullclean && idf.py build — required after adding or removing an app directory" });
    },
    remove: async (app, platform) => {
      calls.push(`remove(${app},${platform})`);
      return action({ action: "remove", app_name: app, platform, next: "idf.py fullclean && idf.py build — required after adding or removing an app directory" });
    },
    update: async (platform, app, updateAll) => {
      calls.push(`update(${platform},${app},${updateAll})`);
      return action({ action: "update", app_name: app, platform });
    },
    sync: async (platform) => { calls.push(`sync(${platform})`); return action({ action: "sync", platform }); },
    guard: async (_info, app) => { guarded.push(app); return { safe: true, reason: "clean", detail: "" } as AppGuardVerdict; },
    platforms: () => [IDF],
    ...over,
  };
  return deps;
}

describe("AppsInput", () => {
  it("accepts one action per branch and defaults the platform to idf", () => {
    const parsed = AppsInput.safeParse({ action: "install", app_name: "sampler" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.platform).toBe("idf");
  });

  it("rejects install without an app name", () => {
    expect(AppsInput.safeParse({ action: "install" }).success).toBe(false);
  });

  it("rejects an app name that would not survive being a shell argument", () => {
    expect(AppsInput.safeParse({ action: "remove", app_name: "sampler; rm -rf /" }).success).toBe(false);
  });

  it("rejects a ref with a path-traversal sequence", () => {
    expect(AppsInput.safeParse({ action: "install", app_name: "sampler", ref: "../evil" }).success).toBe(false);
  });

  it("rejects an action the tool does not have", () => {
    expect(AppsInput.safeParse({ action: "publish", app_name: "sampler" }).success).toBe(false);
  });
});

describe("runApps dispatch", () => {
  it("list reads the registry without touching the mutating paths", async () => {
    const deps = makeDeps();
    const r = await runApps({ action: "list", show_all: true }, deps);
    expect(deps.calls).toEqual(["list(true)"]);
    expect(r.success).toBe(true);
    expect(r.result).toEqual({ apps: LIST.apps, installed_count: 0, total_count: 1 });
  });

  it("list reports a registry that could not be loaded as a typed error", async () => {
    const deps = makeDeps({
      list: () => ({ success: false, apps: [], installed_count: 0, total_count: 0, error: "no gh" }),
    });
    const r = await runApps({ action: "list" }, deps);
    expect(r.success).toBe(false);
    expect((r.error as { code: string }).code).toBe("NO_REGISTRY");
  });

  it("install passes the ref and force through and keeps the fullclean reminder", async () => {
    const deps = makeDeps();
    const r = await runApps({ action: "install", platform: "idf", app_name: "sampler", ref: "v1.0", force: true }, deps);
    expect(deps.calls).toEqual(["install(sampler,idf,v1.0,true)"]);
    expect(r.success).toBe(true);
    expect(r.next).toContain("idf.py fullclean && idf.py build");
  });

  it("install defaults the ref to main", async () => {
    const deps = makeDeps();
    await runApps({ action: "install", platform: "pc", app_name: "sampler" }, deps);
    expect(deps.calls).toEqual(["install(sampler,pc,main,false)"]);
  });

  it("remove and sync reach their own app-manager entry points", async () => {
    const deps = makeDeps();
    await runApps({ action: "remove", platform: "idf", app_name: "sampler" }, deps);
    await runApps({ action: "sync", platform: "arduino" }, deps);
    expect(deps.calls).toEqual(["remove(sampler,idf)", "sync(arduino)"]);
  });

  it("update accepts one app or all of them, but not both and not neither", async () => {
    const deps = makeDeps();
    await runApps({ action: "update", platform: "idf", app_name: "sampler" }, deps);
    await runApps({ action: "update", platform: "idf", update_all: true }, deps);
    // update_all reads the registry first — it has to know what it would rewrite.
    expect(deps.calls).toEqual(["update(idf,sampler,false)", "list(true)", "update(idf,undefined,true)"]);

    const neither = await runApps({ action: "update", platform: "idf" }, deps);
    expect(neither.success).toBe(false);
    expect((neither.error as { code: string }).code).toBe("INVALID_ARGS");

    const both = await runApps({ action: "update", platform: "idf", app_name: "sampler", update_all: true }, deps);
    expect(both.success).toBe(false);
    expect((both.error as { code: string }).code).toBe("INVALID_ARGS");
    // Neither ambiguous call reached the app manager.
    expect(deps.calls).toEqual(["update(idf,sampler,false)", "list(true)", "update(idf,undefined,true)"]);
  });

  it("a failing app-manager run surfaces its stderr as an error", async () => {
    const deps = makeDeps({
      sync: async () => action({ success: false, action: "sync", output: "", error: "app_manager.py not found" }),
    });
    const r = await runApps({ action: "sync", platform: "idf" }, deps);
    expect(r.success).toBe(false);
    expect((r.error as { message: string }).message).toContain("app_manager.py not found");
  });
});

describe("runApps local-work guard", () => {
  const dirty: AppGuardVerdict = { safe: false, reason: "uncommitted changes", detail: " M src/sampler.cpp" };

  it("refuses an install over a dirty checkout and never calls the app manager", async () => {
    const deps = makeDeps({ guard: async () => dirty });
    const r = await runApps({ action: "install", platform: "idf", app_name: "sampler" }, deps);
    expect(r.success).toBe(false);
    expect((r.error as { code: string }).code).toBe("LOCAL_WORK");
    expect((r.error as { hint: string }).hint).toContain("--force");
    expect(r.result).toEqual({ detail: dirty.detail, reason: dirty.reason });
    expect(deps.calls).toEqual([]);
  });

  it("refuses remove and update the same way", async () => {
    const deps = makeDeps({ guard: async () => ({ safe: false, reason: "commits not pushed", detail: "abc123 wip" }) });
    for (const args of [
      { action: "remove", platform: "idf", app_name: "sampler" },
      { action: "update", platform: "idf", app_name: "sampler" },
    ] as AppsArgs[]) {
      const r = await runApps(args, deps);
      expect(r.success, args.action).toBe(false);
      expect((r.error as { code: string }).code).toBe("LOCAL_WORK");
    }
    expect(deps.calls).toEqual([]);
  });

  it("does not guard list or sync — neither rewrites a checkout", async () => {
    const deps = makeDeps({ guard: async () => dirty });
    await runApps({ action: "list" }, deps);
    await runApps({ action: "sync", platform: "idf" }, deps);
    expect(deps.calls).toEqual(["list(false)", "sync(idf)"]);
  });

  it("guards every app installed on the platform before update_all rewrites them all", async () => {
    const deps = makeDeps({ list: () => LIST_INSTALLED });
    const r = await runApps({ action: "update", platform: "idf", update_all: true }, deps);
    expect(r.success).toBe(true);
    // looper is installed on pc, not idf — update_all here would not touch it.
    expect(deps.guarded).toEqual(["sampler", "fishtank"]);
    expect(deps.calls).toEqual(["update(idf,undefined,true)"]);
  });

  it("refuses update_all when any installed app has local work, before touching a single one", async () => {
    const deps = makeDeps({
      list: () => LIST_INSTALLED,
      guard: async (_info, app) => (app === "fishtank" ? dirty : { safe: true, reason: "clean", detail: "" }),
    });
    const r = await runApps({ action: "update", platform: "idf", update_all: true }, deps);
    expect(r.success).toBe(false);
    expect((r.error as { code: string }).code).toBe("LOCAL_WORK");
    expect(r.app_name).toBe("fishtank");
    // The app manager was never reached.
    expect(deps.calls).toEqual([]);
  });

  it("refuses update_all rather than guessing when the registry cannot be read", async () => {
    const deps = makeDeps({
      list: () => ({ success: false, apps: [], installed_count: 0, total_count: 0, error: "no gh" }),
    });
    const r = await runApps({ action: "update", platform: "idf", update_all: true }, deps);
    expect(r.success).toBe(false);
    expect((r.error as { code: string }).code).toBe("GUARD_UNAVAILABLE");
    expect((r.error as { hint: string }).hint).toContain("app_name");
    expect(deps.calls).toEqual([]);
  });

  it("lets a fresh install through — a directory that is not a checkout yet has nothing to lose", async () => {
    const deps = makeDeps({ guard: async () => null });
    const r = await runApps({ action: "install", platform: "idf", app_name: "sampler" }, deps);
    expect(r.success).toBe(true);
    expect(deps.calls).toEqual(["install(sampler,idf,main,false)"]);
  });

  it("skips the guard for a platform this machine does not have checked out", async () => {
    const deps = makeDeps({ platforms: () => [], guard: async () => dirty });
    const r = await runApps({ action: "install", platform: "pc", app_name: "sampler" }, deps);
    // The app-manager call is what reports the unknown platform, with the list
    // of the ones that do exist — the guard has no root to look in.
    expect(r.success).toBe(true);
    expect(deps.calls).toEqual(["install(sampler,pc,main,false)"]);
  });
});

describe("runApps unknown action", () => {
  it("returns UNKNOWN_ACTION rather than throwing when validation is bypassed", async () => {
    const deps = makeDeps();
    const r = await runApps({ action: "publish", platform: "idf" } as unknown as AppsArgs, deps);
    expect(r.success).toBe(false);
    expect((r.error as { code: string }).code).toBe("UNKNOWN_ACTION");
    expect((r.error as { message: string }).message).toContain("publish");
    expect(deps.calls).toEqual([]);
  });
});

// The tool callback, not just runApps: policy and annotations live there.
function mkTool(policy: Policy) {
  const fs = fakeServer();
  const ctx: ToolContext = {
    daemon: (() => { throw new Error("crosspad_apps must not reach the daemon"); }) as never,
    policy,
    jobs: new JobRegistry(),
    handles: new HandleRegistry(),
  };
  registerAppsTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_apps")!;
  return { tool, call: (a: unknown) => tool.cb(a, fakeExtra()) };
}

describe("crosspad_apps policy", () => {
  const confirmInstall: Policy = {
    mode: "strict",
    rules: [{ tool: "crosspad_apps", when: { action: "install" }, confirm: true }],
  };

  it("stops at a confirm rule instead of installing the submodule anyway", async () => {
    const t = mkTool(confirmInstall);
    const res = await t.call({ action: "install", platform: "idf", app_name: "sampler" });
    expect(res.structuredContent.resultType).toBe("confirmation_required");
    expect(res.structuredContent.success).toBe(false);
    expect(String((res.structuredContent.confirmation as { summary: string }).summary)).toContain("sampler");
  });

  it("hides the tool under a readonly policy", async () => {
    const t = mkTool({ mode: "readonly", rules: [] });
    const res = await t.call({ action: "install", platform: "idf", app_name: "sampler" });
    expect((res.structuredContent.error as { code: string }).code).toBe("HIDDEN");
  });

  it("leaves an unruled action alone", async () => {
    const t = mkTool(confirmInstall);
    const res = await t.call({ action: "list" });
    expect(res.structuredContent.resultType).toBeUndefined();
  });
});

describe("crosspad_apps annotations", () => {
  it("advertises the mutating worst case and names the read-only action in the description", () => {
    const t = mkTool({ mode: "lab", rules: [] });
    expect(t.tool.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(String(t.tool.config.description)).toContain("action=list just reads");
  });

  it("promises the local-work guard for update_all too", () => {
    const t = mkTool({ mode: "lab", rules: [] });
    expect(String(t.tool.config.description)).toContain("update_all included");
  });
});
