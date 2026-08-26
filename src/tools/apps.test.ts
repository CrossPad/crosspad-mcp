import { describe, it, expect } from "vitest";
import { AppsInput, runApps, type AppsArgs, type AppsDeps } from "./apps.js";
import type { AppActionResult, AppGuardVerdict, AppListResult, PlatformInfo } from "./app-manager.js";

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

function action(over: Partial<AppActionResult> = {}): AppActionResult {
  return { success: true, action: "install", platform: "idf", output: "done", ...over };
}

/** Records what the dispatch called, so a test can assert the delegation. */
function makeDeps(over: Partial<AppsDeps> = {}): AppsDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps: AppsDeps & { calls: string[] } = {
    calls,
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
    guard: async () => ({ safe: true, reason: "clean", detail: "" } as AppGuardVerdict),
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
    expect(deps.calls).toEqual(["update(idf,sampler,false)", "update(idf,undefined,true)"]);

    const neither = await runApps({ action: "update", platform: "idf" }, deps);
    expect(neither.success).toBe(false);
    expect((neither.error as { code: string }).code).toBe("INVALID_ARGS");

    const both = await runApps({ action: "update", platform: "idf", app_name: "sampler", update_all: true }, deps);
    expect(both.success).toBe(false);
    expect((both.error as { code: string }).code).toBe("INVALID_ARGS");
    // Neither ambiguous call reached the app manager.
    expect(deps.calls).toEqual(["update(idf,sampler,false)", "update(idf,undefined,true)"]);
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

  it("does not guard list, sync, or an update of every app", async () => {
    const deps = makeDeps({ guard: async () => dirty });
    await runApps({ action: "list" }, deps);
    await runApps({ action: "sync", platform: "idf" }, deps);
    const all = await runApps({ action: "update", platform: "idf", update_all: true }, deps);
    expect(all.success).toBe(true);
    expect(deps.calls).toEqual(["list(false)", "sync(idf)", "update(idf,undefined,true)"]);
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
