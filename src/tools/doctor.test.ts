import { describe, it, expect } from "vitest";
import { runDoctorChecks, compareVersions, registerDoctorTool, type DoctorProbe } from "./doctor.js";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import { HilError } from "../hil/daemon.js";
import type { ToolContext } from "../tool-context.js";

const NOW = 1_700_000_000_000;

function probe(over: Partial<DoctorProbe> = {}): DoctorProbe {
  return {
    hilPython: () => "/venv/bin/python",
    pythonRunnable: async () => true,
    hilVersion: async () => "1.0.0",
    requiredHilVersion: () => "1.0.0",
    idfRoot: () => "/git/platform-idf",
    idfExportExists: () => true,
    pcRoot: () => "/git/crosspad-pc",
    exists: (p) => ["/git/platform-idf", "/git/crosspad-pc", "/git/platform-idf/build_v2", "/git/platform-idf/build_v2/CrossPad.bin", "/git/crosspad-pc/bin/CrossPad"].includes(p),
    mtimeMs: (p) => (p.endsWith("CrossPad") || p.endsWith("CrossPad.bin") ? NOW - 60_000 : null),
    newestSourceMtimeMs: () => NOW - 120_000,
    simBinary: () => "/git/crosspad-pc/bin/CrossPad",
    clangdPath: () => "/usr/bin/clangd",
    ...over,
  };
}

const byName = (checks: Array<{ name: string; ok: boolean; detail: string; fix: string }>) =>
  Object.fromEntries(checks.map((c) => [c.name, c]));

describe("compareVersions", () => {
  it("orders semver numerically", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.3")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBeLessThan(0);
  });
});

describe("runDoctorChecks", () => {
  it("is all-ok with a healthy probe and merges daemon checks", async () => {
    const checks = await runDoctorChecks(probe(), async () => [{ name: "udev_dialout", ok: true, detail: "in dialout", fix: "" }]);
    const m = byName(checks);
    expect(m.hil_python.ok).toBe(true);
    expect(m.hil_version.ok).toBe(true);
    expect(m.idf_root.ok).toBe(true);
    expect(m.idf_env.ok).toBe(true);
    expect(m.pc_root.ok).toBe(true);
    expect(m.build_dirs.ok).toBe(true);
    expect(m.sim_binary.ok).toBe(true);
    expect(m.udev_dialout.ok).toBe(true);
    expect(checks.every((c) => c.ok)).toBe(true);
  });
  it("fails hil_version when crosspad_hil is older than package.json hilVersion", async () => {
    const checks = await runDoctorChecks(probe({ hilVersion: async () => "0.9.0", requiredHilVersion: () => "1.0.0" }), async () => []);
    const m = byName(checks);
    expect(m.hil_version.ok).toBe(false);
    expect(m.hil_version.fix).toContain("crosspad-hil");
  });
  it("fails hil_python when the interpreter cannot run and skips the version check", async () => {
    const checks = await runDoctorChecks(probe({ pythonRunnable: async () => false }), async () => []);
    const m = byName(checks);
    expect(m.hil_python.ok).toBe(false);
    expect(m.hil_version.ok).toBe(false);
    expect(m.hil_version.detail).toContain("skipped");
  });
  it("reports a stale sim binary", async () => {
    const checks = await runDoctorChecks(probe({ newestSourceMtimeMs: () => NOW }), async () => []);
    expect(byName(checks).sim_binary.ok).toBe(false);
    expect(byName(checks).sim_binary.fix).toContain("crosspad_build");
  });
  it("reports no build dir at all", async () => {
    const checks = await runDoctorChecks(probe({ exists: (p) => ["/git/platform-idf", "/git/crosspad-pc"].includes(p) }), async () => []);
    const m = byName(checks);
    expect(m.build_dirs.ok).toBe(false);
    expect(m.sim_binary.ok).toBe(false);
  });
  it("turns a daemon failure into a single failed 'daemon' check", async () => {
    const checks = await runDoctorChecks(probe(), async () => { throw new HilError("DAEMON_DIED", "exit 1", "reinstall"); });
    const m = byName(checks);
    expect(m.daemon.ok).toBe(false);
    expect(m.daemon.detail).toContain("exit 1");
  });
});

describe("crosspad_doctor tool", () => {
  it("returns ok=false when any check fails", async () => {
    const daemon = fakeDaemon({ "devices.doctor": () => ({ checks: [{ name: "port_locks", ok: false, detail: "/dev/ttyACM0 held by pid 4242 (console)", fix: "kill 4242" }] }) });
    const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
    const fs = fakeServer();
    registerDoctorTool(fs.server, ctx, probe());
    const res = await fs.tools.get("crosspad_doctor")!.cb({}, fakeExtra());
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.ok).toBe(false);
    const names = (res.structuredContent.checks as any[]).map((c) => c.name);
    expect(names).toContain("port_locks");
    expect(names).toContain("hil_python");
  });
});

describe("clangd check", () => {
  it("names the install line when the language server is not there", async () => {
    // Only crosspad_symbol needs it, so its absence must read as an absent
    // binary rather than as a broken tool.
    const checks = await runDoctorChecks(probe({ clangdPath: () => null }), async () => []);
    const c = byName(checks).clangd;
    expect(c.ok).toBe(false);
    expect(c.fix).toContain("CROSSPAD_CLANGD");
  });
});


// ── the daemon as a process ─────────────────────────────────────────────────

import { knowledgeCache } from "../resources/knowledge.js";

const DSTATS = {
  version: "1.1.0", pid: 1973262, uptime_s: 7200, ops_total: 431,
  handles: {}, handles_total: 0, threads: 6, open_fds: 31, alsa_seq_clients: 4,
};

function ctxWith(daemon: ReturnType<typeof fakeDaemon>): ToolContext {
  return { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
}

describe("hil_daemon check", () => {
  it("reports uptime, ops, handles and the resources held", async () => {
    const checks = await runDoctorChecks(probe(), async () => [], async () => ({ ...DSTATS, handles: { con: 1 }, handles_total: 1 }));
    const c = byName(checks).hil_daemon;
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("pid 1973262");
    expect(c.detail).toContain("431 ops");
    expect(c.detail).toContain("conx1");
    expect(c.detail).toContain("4 ALSA seq clients");
  });

  it("fails and names the repair once the ALSA clients are over budget", async () => {
    const checks = await runDoctorChecks(probe(), async () => [], async () => ({ ...DSTATS, alsa_seq_clients: 40 }));
    const c = byName(checks).hil_daemon;
    expect(c.ok).toBe(false);
    expect(c.fix).toContain("restart_daemon");
  });

  it("does not fail a daemon that predates serve.stats, but says to upgrade", async () => {
    const checks = await runDoctorChecks(probe(), async () => [], async () => { throw new HilError("BAD_ARGS", "unknown op 'serve.stats'"); });
    const c = byName(checks).hil_daemon;
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("predates serve.stats");
    expect(c.fix).toContain("Upgrade crosspad-hil");
  });

  it("fails on any other serve.stats error", async () => {
    const checks = await runDoctorChecks(probe(), async () => [], async () => { throw new HilError("DAEMON_DIED", "exit 1"); });
    const c = byName(checks).hil_daemon;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("exit 1");
  });

  it("is absent when no stats source is given", async () => {
    const checks = await runDoctorChecks(probe(), async () => []);
    expect(byName(checks).hil_daemon).toBeUndefined();
  });
});

describe("crosspad_doctor action=restart_daemon", () => {
  it("restarts and reports the daemon it came back as", async () => {
    const daemon = fakeDaemon({ "serve.stats": () => DSTATS });
    const fs = fakeServer();
    registerDoctorTool(fs.server, ctxWith(daemon), probe());
    const res = await fs.tools.get("crosspad_doctor")!.cb({ action: "restart_daemon" }, fakeExtra());
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.action).toBe("restart_daemon");
    expect(res.structuredContent.dropped_handles).toBe(0);
    expect((res.structuredContent.daemon as { pid: number }).pid).toBe(1973262);
  });

  it("asks first when the restart would drop open handles", async () => {
    const daemon = fakeDaemon({ "serve.stats": () => ({ ...DSTATS, handles: { con: 1, task: 1 }, handles_total: 2 }) });
    const fs = fakeServer();
    registerDoctorTool(fs.server, ctxWith(daemon), probe());
    const res = await fs.tools.get("crosspad_doctor")!.cb({ action: "restart_daemon" }, fakeExtra());
    expect(res.structuredContent.resultType).toBe("confirmation_required");
    const token = (res.structuredContent.confirmation as { token: string }).token;
    const go = await fs.tools.get("crosspad_doctor")!.cb({ action: "restart_daemon", confirm_token: token }, fakeExtra());
    expect(go.structuredContent.success).toBe(true);
    expect(go.structuredContent.dropped_handles).toBe(2);
  });

  it("still restarts when the daemon cannot answer serve.stats", async () => {
    const daemon = fakeDaemon({});
    const fs = fakeServer();
    registerDoctorTool(fs.server, ctxWith(daemon), probe());
    const res = await fs.tools.get("crosspad_doctor")!.cb({ action: "restart_daemon" }, fakeExtra());
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.dropped_handles).toBe(0);
  });

  it("default action still runs the checks and now includes hil_daemon", async () => {
    const daemon = fakeDaemon({ "devices.doctor": () => ({ checks: [] }), "serve.stats": () => DSTATS });
    const fs = fakeServer();
    registerDoctorTool(fs.server, ctxWith(daemon), probe());
    const res = await fs.tools.get("crosspad_doctor")!.cb({}, fakeExtra());
    const names = (res.structuredContent.checks as Array<{ name: string }>).map((c) => c.name);
    expect(names).toContain("hil_daemon");
    expect(res.structuredContent.action).toBe("check");
  });
});

describe("crosspad_doctor restart vs the cached scenario catalog", () => {
  it("clears the knowledge cache, so a new scenario is visible after a restart", async () => {
    knowledgeCache.set("crosspad://hil/catalog", { scenarios: [] });
    const daemon = fakeDaemon({ "serve.stats": () => DSTATS });
    const fs = fakeServer();
    registerDoctorTool(fs.server, ctxWith(daemon), probe());
    await fs.tools.get("crosspad_doctor")!.cb({ action: "restart_daemon" }, fakeExtra());
    expect(knowledgeCache.get("crosspad://hil/catalog")).toBeUndefined();
  });

  it("leaves the cache alone on an ordinary check", async () => {
    knowledgeCache.set("crosspad://hil/catalog", { scenarios: [] });
    const daemon = fakeDaemon({ "devices.doctor": () => ({ checks: [] }), "serve.stats": () => DSTATS });
    const fs = fakeServer();
    registerDoctorTool(fs.server, ctxWith(daemon), probe());
    await fs.tools.get("crosspad_doctor")!.cb({}, fakeExtra());
    expect(knowledgeCache.get("crosspad://hil/catalog")).toBeDefined();
    knowledgeCache.clear();
  });
});
