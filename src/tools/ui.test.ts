import { describe, it, expect } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerUiTool, refToDelta } from "./ui.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";

const group = [
  { ref: "e0", index: 0, ptr: "0x3fc0", label: "Back" },
  { ref: "e1", index: 1, ptr: "0x3fc4", label: "Kit: DRUMS" },
  { ref: "e2", index: 2, ptr: "0x3fc8", label: "Load" },
];
const snap = { snapshot_id: "snap_7", device: "dev_3f2a", usb_mode: "default", apps: { running: "Sampler", available: ["Sampler"] }, ui: { focus: { ref: "e2", index: 2, label: "Load" }, group, drawer: false, theme: 1, app: "Sampler" }, kit: null, leds: null, pads: null, mem: null, ble: null, console: null, ts: 1, changed: [] };

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
  const fs = fakeServer();
  registerUiTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_ui")!;
  return { daemon, tool, call: (args: any) => tool.cb(args, fakeExtra()) };
}

describe("refToDelta", () => {
  it("is index(ref) − focus", () => {
    expect(refToDelta(group, 0, "e2")).toBe(2);
    expect(refToDelta(group, 2, "e0")).toBe(-2);
    expect(refToDelta(group, 1, "e1")).toBe(0);
  });
  it("rejects an unknown ref with BAD_ARGS", () => {
    expect(() => refToDelta(group, 0, "e9")).toThrowError(/e9/);
    try { refToDelta(group, 0, "e9"); } catch (e: any) { expect(e.code).toBe("BAD_ARGS"); }
  });
});

describe("crosspad_ui", () => {
  it("focus reads enc_group + enc_focus, rotates by the delta, then snapshots", async () => {
    const t = mk({
      "cdc.verb": (a) => {
        if (a.verb === "enc_group") return { group };
        if (a.verb === "enc_focus") return { index: 0, label: "Back", ptr: "0x3fc0" };
        if (a.verb === "enc_rotate") return { ok: true };
        throw new Error("unexpected " + a.verb);
      },
      "snapshot.take": () => snap,
    });
    const res = await t.call({ action: "focus", ref: "e2", device: "dev_3f2a" });
    const verbs = t.daemon.calls.map((c) => (c.op === "cdc.verb" ? c.args.verb : c.op));
    expect(verbs).toEqual(["enc_group", "enc_focus", "enc_rotate", "snapshot.take"]);
    expect(t.daemon.calls[2].args).toEqual({ device: "dev_3f2a", verb: "enc_rotate", args: { delta: 2 } });
    expect(res.structuredContent).toMatchObject({ success: true, action: "focus", delta: 2, snapshot: { snapshot_id: "snap_7" } });
  });
  it("focus with delta 0 does not rotate", async () => {
    const t = mk({
      "cdc.verb": (a) => (a.verb === "enc_group" ? { group } : a.verb === "enc_focus" ? { index: 2, label: "Load", ptr: "x" } : { ok: true }),
      "snapshot.take": () => snap,
    });
    await t.call({ action: "focus", ref: "e2" });
    expect(t.daemon.calls.some((c) => c.args.verb === "enc_rotate")).toBe(false);
  });
  it("press → enc_press ms=80 by default; rotate → enc_rotate; back → app_self_close; start_app → app_start; stop_app → app_stop", async () => {
    const t = mk({ "cdc.verb": () => ({ ok: true }), "snapshot.take": () => snap });
    await t.call({ action: "press" });
    await t.call({ action: "press", ms: 300 });
    await t.call({ action: "rotate", delta: -1 });
    await t.call({ action: "back" });
    await t.call({ action: "start_app", name: "Sampler" });
    await t.call({ action: "stop_app" });
    const verbCalls = t.daemon.calls.filter((c) => c.op === "cdc.verb").map((c) => [c.args.verb, c.args.args]);
    expect(verbCalls).toEqual([
      ["enc_press", { ms: 80 }],
      ["enc_press", { ms: 300 }],
      ["enc_rotate", { delta: -1 }],
      ["app_self_close", {}],
      ["app_start", { name: "Sampler", wait_s: 3 }],
      ["app_stop", {}],
    ]);
  });
  it("return_snapshot=false skips snapshot.take", async () => {
    const t = mk({ "cdc.verb": () => ({ ok: true }) });
    const res = await t.call({ action: "press", return_snapshot: false });
    expect(t.daemon.calls.some((c) => c.op === "snapshot.take")).toBe(false);
    expect(res.structuredContent.snapshot).toBeUndefined();
  });
  it("rejects rotate delta 0 at the schema", async () => {
    const t = mk({});
    const res = await t.call({ action: "rotate", delta: 0 });
    expect(res.isError).toBe(true);
    expect(t.daemon.calls.length).toBe(0);
  });
});
