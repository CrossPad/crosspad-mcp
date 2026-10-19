import { describe, it, expect, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { HilError } from "../hil/daemon.js";
import { JobRegistry } from "../tasks.js";
import { HandleRegistry } from "../handles.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";
import {
  registerBenchClaimTool, registerBenchReleaseTool, registerBenchStatusTool, benchGate,
  CLAIM_TOOL, RELEASE_TOOL, STATUS_TOOL, type HolderSlot,
} from "./bench.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LAB: Policy = { mode: "lab", rules: [] };
const LEASE = { holder: "pidf", purpose: "firmware_app", since: 1, ttl_s: 1800, renewed: 1, expires: 1801,
  since_at: "2026-10-05 23:45", expires_at: "2026-10-06 00:15", expires_in_s: 1800 };

function ctxFor(daemon: ReturnType<typeof fakeDaemon>, policy: Policy = LAB): ToolContext {
  return { daemon: () => daemon, policy, jobs: new JobRegistry(), handles: new HandleRegistry() };
}

const busy = () => new HilError("BENCH_BUSY",
  "dev_1ede is claimed by pidf (firmware_app) since 23:45; the lease runs to 00:15 (in 25 min) unless renewed; you (twin) may not run crosspad_flash esp uart",
  "claim it to join the queue", { holder: "pidf", device: "dev_1ede", queue: [] });

describe("crosspad_bench_claim", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); });

  it("granted: forwards ttl in seconds and remembers the holder for later calls", async () => {
    const d = fakeDaemon({ "bench.claim": () => ({ granted: true, holder: "pidf", device: "dev_1ede", lease: LEASE, queue: [], firmware: null, history: [], message: "pidf holds dev_1ede" }) });
    registerBenchClaimTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(CLAIM_TOOL)!.cb({ holder: "pidf", purpose: "firmware_app", ttl_min: 45 }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc).toMatchObject({ success: true, granted: true, holder: "pidf" });
    expect(sc.hint).toMatch(/crosspad_bench_release/);
    expect(d.calls[0]).toEqual({ op: "bench.claim", args: { holder: "pidf", purpose: "firmware_app", ttl_s: 2700 } });
    expect((d as HolderSlot).benchHolder).toBe("pidf");
  });

  it("queued: reports the holder and position, and tells the caller not to touch the board", async () => {
    const d = fakeDaemon({ "bench.claim": () => ({ granted: false, holder: "twin", device: "dev_1ede", lease: LEASE, position: 2, queue: [{ holder: "stm", position: 1 }, { holder: "twin", position: 2 }], firmware: null, history: [], message: "dev_1ede is claimed by pidf … you are #2 in the queue" }) });
    registerBenchClaimTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(CLAIM_TOOL)!.cb({ holder: "twin", purpose: "smoke", force: false }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc).toMatchObject({ success: true, granted: false, position: 2 });
    expect(sc.hint).toMatch(/do not touch the board/);
    expect(d.calls[0].args.bench_force).toBeUndefined();
  });

  it("force is passed as bench_force", async () => {
    const d = fakeDaemon({ "bench.claim": () => ({ granted: true, holder: "twin", device: "dev_1ede", lease: LEASE, queue: [], firmware: null, history: [], message: "" }) });
    registerBenchClaimTool(fs.server, ctxFor(d));
    await fs.tools.get(CLAIM_TOOL)!.cb({ holder: "twin", purpose: "x", force: true, device: "dev_1ede" }, fakeExtra());
    expect(d.calls[0].args).toMatchObject({ bench_force: true, device: "dev_1ede" });
  });

  it("is hidden under --read-only, while status stays", async () => {
    const d = fakeDaemon({});
    registerBenchClaimTool(fs.server, ctxFor(d, { mode: "readonly", rules: [] }));
    const r = await fs.tools.get(CLAIM_TOOL)!.cb({ holder: "a", purpose: "b" }, fakeExtra());
    expect((r.structuredContent as any).error.code).toBe("HIDDEN");
    expect(d.calls).toEqual([]);
  });
});

describe("crosspad_bench_release", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); });

  it("defaults the holder to the name this session claimed with", async () => {
    const d = fakeDaemon({ "bench.release": () => ({ released: true, left_queue: false, device: "dev_1ede", lease: null, queue: [], firmware: { desc: "pidf abc" }, history: [] }) });
    (d as HolderSlot).benchHolder = "pidf";
    registerBenchReleaseTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(RELEASE_TOOL)!.cb({ firmware_left: "pidf abc" }, fakeExtra());
    expect((r.structuredContent as any)).toMatchObject({ success: true, released: true, holder: "pidf" });
    expect(d.calls[0]).toEqual({ op: "bench.release", args: { holder: "pidf", firmware_left: "pidf abc" } });
  });

  it("without a claim or a holder it is a BAD_ARGS, not a daemon call", async () => {
    const d = fakeDaemon({});
    registerBenchReleaseTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(RELEASE_TOOL)!.cb({ firmware_left: "x" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error.code).toBe("BAD_ARGS");
    expect(d.calls).toEqual([]);
  });

  it("surfaces BENCH_BUSY when releasing someone else's lease", async () => {
    const d = fakeDaemon({ "bench.release": () => { throw busy(); } });
    registerBenchReleaseTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(RELEASE_TOOL)!.cb({ firmware_left: "x", holder: "twin" }, fakeExtra());
    const sc = r.structuredContent as any;
    expect(sc.error.code).toBe("BENCH_BUSY");
    expect(sc.error.details.holder).toBe("pidf");
  });
});

describe("crosspad_bench_status", () => {
  it("returns the daemon's view plus this session's holder", async () => {
    const fs = fakeServer();
    const d = fakeDaemon({ "bench.status": () => ({ now: 5, now_at: "x", path: "/s/bench.json", devices: [{ device: "dev_1ede", lease: LEASE, queue: [], history: [], firmware: null }] }) });
    (d as HolderSlot).benchHolder = "twin";
    registerBenchStatusTool(fs.server, ctxFor(d, { mode: "readonly", rules: [] }));
    const r = await fs.tools.get(STATUS_TOOL)!.cb({ history: 3 }, fakeExtra());
    const sc = r.structuredContent as any;
    expect(sc).toMatchObject({ success: true, session_holder: "twin" });
    expect(sc.devices[0].lease.holder).toBe("pidf");
    expect(d.calls[0]).toEqual({ op: "bench.status", args: { history: 3 } });
  });
});

describe("benchGate", () => {
  it("passes when the daemon allows, and names the op and device", async () => {
    const d = fakeDaemon({ "bench.check": () => ({ allowed: true }) });
    await benchGate(d, "crosspad_flash esp uart", "dev_1ede");
    expect(d.calls[0]).toEqual({ op: "bench.check", args: { op: "crosspad_flash esp uart", device: "dev_1ede" } });
  });

  it("throws the daemon's BENCH_BUSY", async () => {
    const d = fakeDaemon({ "bench.check": () => { throw busy(); } });
    await expect(benchGate(d, "crosspad_trace start")).rejects.toMatchObject({ code: "BENCH_BUSY" });
  });

  it("lets the call through when the daemon has no bench, or no daemon can start", async () => {
    await benchGate(fakeDaemon({}), "x"); // UNKNOWN_OP
    await benchGate(fakeDaemon({ "bench.check": () => { throw new HilError("BAD_ARGS", "unknown op 'bench.check'"); } }), "x");
    await benchGate(fakeDaemon({ "bench.check": () => { throw new HilError("DAEMON_DIED", "spawn failed"); } }), "x");
  });
});
