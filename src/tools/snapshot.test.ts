import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";

vi.mock("../utils/remote-client.js", () => ({
  isSimulatorRunning: vi.fn(async () => true),
  sendRemoteCommand: vi.fn(),
}));
import { isSimulatorRunning, sendRemoteCommand } from "../utils/remote-client.js";
import { registerSnapshotTool, simStatsToSnapshot, SnapshotStore, snapshots } from "./snapshot.js";

const snapA = { snapshot_id: "snap_1", device: "dev_3f2a", usb_mode: "default", apps: { running: null, available: ["Sampler"] }, ui: null, kit: { current: 1, name: "A", loading: false, pending: -1 }, leds: null, pads: null, mem: null, ble: null, console: null, ts: 1, changed: [] };
const snapB = { ...snapA, snapshot_id: "snap_2", kit: { current: 2, name: "B", loading: false, pending: -1 }, changed: ["kit"] };

const SIM_STATS = {
  capabilities_raw: 3, capabilities: ["Midi", "AudioOut"],
  pads: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 2, playing: i === 2 || i === 5, note: 36 + i, channel: 9, r: i === 2 ? 255 : 0, g: 0, b: i === 5 ? 128 : 0 })),
  active_pad_logic: "Sampler", registered_pad_logics: ["Sampler", "Sequencer"],
  app_count: 2, apps: ["Sampler", "Sequencer"],
  heap: { sram_free: 100000, sram_total: 400000, psram_free: 7000000, psram_total: 8000000 },
  settings: { lcd_brightness: 80, rgb_brightness: 60, theme_color: 1, audio_engine: true, kit: 4, perf_stats_flags: 0 },
};

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const handles = new HandleRegistry();
  const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles };
  const fs = fakeServer();
  registerSnapshotTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_snapshot")!;
  return { daemon, handles, tool, call: (args: any) => tool.cb(args, fakeExtra()) };
}

beforeEach(() => { vi.mocked(sendRemoteCommand).mockReset(); vi.mocked(isSimulatorRunning).mockResolvedValue(true); });

describe("SnapshotStore", () => {
  it("keeps only the last 20", () => {
    const s = new SnapshotStore();
    for (let i = 0; i < 25; i++) s.put({ ...snapA, snapshot_id: `snap_${i}` } as any);
    expect(s.ids().length).toBe(20);
    expect(s.get("snap_4")).toBeUndefined();
    expect(s.get("snap_24")).toBeDefined();
  });
});

describe("simStatsToSnapshot", () => {
  it("maps sim stats into the Snapshot shape with ui null", () => {
    const s = simStatsToSnapshot(SIM_STATS, "snap_sim_1");
    expect(s.device).toBe("sim");
    expect(s.usb_mode).toBe("unknown");
    expect(s.ui).toBeNull();
    expect(s.ble).toBeNull();
    expect(s.console).toBeNull();
    expect(s.apps).toEqual({ running: "Sampler", available: ["Sampler", "Sequencer"] });
    expect(s.kit).toEqual({ current: 4, name: null, loading: false, pending: -1 });
    expect(s.pads).toEqual({ pressed: [2], playing: [2, 5] });
    expect((s.leds as any).brightness).toBe(60);
    expect((s.leds as any).colors[2]).toBe("FF0000");
    expect((s.leds as any).colors[5]).toBe("000080");
    expect((s.leds as any).colors.length).toBe(16);
    expect(s.mem).toEqual({ sram_free: 100000, sram_total: 400000, psram_free: 7000000, psram_total: 8000000 });
  });
});

describe("crosspad_snapshot device", () => {
  it("calls snapshot.take with include and registers a snap handle", async () => {
    const t = mk({ "snapshot.take": () => snapA });
    const res = await t.call({ target: "device", device: "dev_3f2a", include: ["kit", "apps"] });
    expect(t.daemon.calls[0]).toEqual({ op: "snapshot.take", args: { device: "dev_3f2a", include: ["kit", "apps"] } });
    expect(res.structuredContent).toMatchObject({ success: true, snapshot_id: "snap_1", device: "dev_3f2a" });
    expect(t.handles.get("snap_1")).toMatchObject({ kind: "snapshot", device: "dev_3f2a" });
    expect(snapshots.get("snap_1")).toBeDefined();
  });
  it("passes the stored snapshot as previous for diff_from, full snapshot when unknown", async () => {
    const t = mk({ "snapshot.take": (a) => (a.previous ? snapB : snapA) });
    await t.call({ target: "device", device: "dev_3f2a" });
    const res = await t.call({ target: "device", device: "dev_3f2a", diff_from: "snap_1" });
    expect(t.daemon.calls[1].args.previous).toMatchObject({ snapshot_id: "snap_1" });
    expect(res.structuredContent.changed).toEqual(["kit"]);
    await t.call({ target: "device", device: "dev_3f2a", diff_from: "snap_nope" });
    expect(t.daemon.calls[2].args.previous).toBeUndefined();
  });
});

describe("crosspad_snapshot sim", () => {
  it("uses the remote stats command and mints snap_sim ids", async () => {
    vi.mocked(sendRemoteCommand).mockResolvedValue({ ok: true, ...SIM_STATS });
    const t = mk({});
    const res = await t.call({ target: "sim" });
    expect(vi.mocked(sendRemoteCommand)).toHaveBeenCalledWith({ cmd: "stats" });
    expect(String(res.structuredContent.snapshot_id)).toMatch(/^snap_sim_\d+$/);
    expect(res.structuredContent.device).toBe("sim");
    expect(res.structuredContent.ui).toBeNull();
    expect(t.daemon.calls.length).toBe(0);
  });
  it("computes changed against diff_from for sim", async () => {
    vi.mocked(sendRemoteCommand).mockResolvedValue({ ok: true, ...SIM_STATS });
    const t = mk({});
    const first = await t.call({ target: "sim" });
    vi.mocked(sendRemoteCommand).mockResolvedValue({ ok: true, ...SIM_STATS, settings: { ...SIM_STATS.settings, kit: 9 } });
    const res = await t.call({ target: "sim", diff_from: first.structuredContent.snapshot_id });
    expect(res.structuredContent.changed).toEqual(["kit"]);
  });
  it("errors when the sim is not running", async () => {
    vi.mocked(isSimulatorRunning).mockResolvedValue(false);
    const t = mk({});
    const res = await t.call({ target: "sim" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent.error as any).code).toBe("SIM_NOT_RUNNING");
  });
});
