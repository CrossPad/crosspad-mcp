import { describe, it, expect } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerCdcTool, toVerbCall, isDangerVerb } from "./cdc.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>, policy: Policy = { mode: "lab", rules: [] }) {
  const daemon = fakeDaemon(handlers);
  const ctx: ToolContext = { daemon: () => daemon, policy, jobs: new JobRegistry(), handles: new HandleRegistry() };
  const fs = fakeServer();
  registerCdcTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_cdc")!;
  return { daemon, tool, call: (args: any) => tool.cb(args, fakeExtra()) };
}

describe("toVerbCall", () => {
  it("maps typed families to verbs.py names and args", () => {
    expect(toVerbCall({ verb: "app", action: "start", name: "Sampler", wait_s: 2 } as any)).toEqual({ verb: "app_start", args: { name: "Sampler", wait_s: 2 } });
    expect(toVerbCall({ verb: "app", action: "list" } as any)).toEqual({ verb: "app_list", args: {} });
    expect(toVerbCall({ verb: "kit", action: "load", kit_id: 3 } as any)).toEqual({ verb: "kit_load", args: { kit_id: 3 } });
    expect(toVerbCall({ verb: "pad", action: "press", idx: 5, vel: 100 } as any)).toEqual({ verb: "pad_press", args: { idx: 5, vel: 100 } });
    expect(toVerbCall({ verb: "pad", action: "stats", reset: true } as any)).toEqual({ verb: "pad_stats", args: { reset: true } });
    expect(toVerbCall({ verb: "enc", action: "rotate", delta: -2 } as any)).toEqual({ verb: "enc_rotate", args: { delta: -2 } });
    expect(toVerbCall({ verb: "enc", action: "ui_state" } as any)).toEqual({ verb: "ui_state", args: {} });
    expect(toVerbCall({ verb: "led", action: "state" } as any)).toEqual({ verb: "led_state", args: {} });
    expect(toVerbCall({ verb: "mem", action: "info" } as any)).toEqual({ verb: "mem", args: {} });
    expect(toVerbCall({ verb: "mem", action: "blocks" } as any)).toEqual({ verb: "mem_blocks", args: {} });
    expect(toVerbCall({ verb: "audio", action: "tasks", on: false } as any)).toEqual({ verb: "audio_tasks", args: { on: false } });
    expect(toVerbCall({ verb: "audio", action: "smpl_peak" } as any)).toEqual({ verb: "smpl_peak", args: {} });
    expect(toVerbCall({ verb: "ble", action: "send", note: 60, vel: 90 } as any)).toEqual({ verb: "ble_send", args: { note: 60, vel: 90 } });
    expect(toVerbCall({ verb: "ble", action: "start", mode: 1 } as any)).toEqual({ verb: "ble_start", args: { mode: 1 } });
    expect(toVerbCall({ verb: "system", action: "cdc_stats" } as any)).toEqual({ verb: "cdc_stats", args: {} });
    expect(toVerbCall({ verb: "system", action: "stm_dfu" } as any)).toEqual({ verb: "stm_dfu", args: {} });
  });
  it("maps raw to cdc.transact args with timeout_ms → timeout_s", () => {
    expect(toVerbCall({ verb: "raw", cmd: "KIT_STATUS", expect: "KITSTATUS:", timeout_ms: 2500 } as any)).toEqual({ raw: { cmd: "KIT_STATUS", expect: "KITSTATUS:", timeout_s: 2.5 } });
    expect(toVerbCall({ verb: "raw", cmd: "MEM" } as any)).toEqual({ raw: { cmd: "MEM" } });
  });
});

describe("isDangerVerb", () => {
  it("is true only for system bootloader_request / stm_dfu", () => {
    expect(isDangerVerb({ verb: "system", action: "bootloader_request" })).toBe(true);
    expect(isDangerVerb({ verb: "system", action: "stm_dfu" })).toBe(true);
    expect(isDangerVerb({ verb: "system", action: "cdc_stats" })).toBe(false);
    expect(isDangerVerb({ verb: "pad", action: "press" })).toBe(false);
  });
});

describe("crosspad_cdc tool", () => {
  it("calls cdc.verb with device passthrough and returns the parsed result", async () => {
    const t = mk({ "cdc.verb": () => ({ current: 3, loading: false, pending: -1, name: "DRUMS" }) });
    const res = await t.call({ verb: "kit", action: "status", device: "dev_3f2a" });
    expect(t.daemon.calls[0]).toEqual({ op: "cdc.verb", args: { device: "dev_3f2a", verb: "kit_status", args: {} } });
    expect(res.structuredContent).toMatchObject({ success: true, verb: "kit_status", result: { current: 3, name: "DRUMS" }, device: "dev_3f2a" });
  });
  it("raw goes through cdc.transact and returns line + parsed", async () => {
    const t = mk({ "cdc.transact": () => ({ line: "MEM: free=18712 largest=4096", parsed: { kind: "mem", free: 18712, largest: 4096 }, rtt_ms: 3.2, extra_lines: [] }) });
    const res = await t.call({ verb: "raw", cmd: "MEM" });
    expect(t.daemon.calls[0]).toEqual({ op: "cdc.transact", args: { cmd: "MEM" } });
    expect(res.structuredContent).toMatchObject({ success: true, line: "MEM: free=18712 largest=4096", rtt_ms: 3.2 });
  });
  it("refuses a raw cmd with a newline or control bytes", async () => {
    const t = mk({});
    const res = await t.call({ verb: "raw", cmd: "MEM\nOTA_BEGIN 1 x" });
    expect(res.isError).toBe(true);
    expect(t.daemon.calls.length).toBe(0);
  });
  it("system bootloader_request under strict policy returns a confirmation token and performs nothing", async () => {
    const t = mk({ "cdc.verb": () => ({ sent: true }) }, { mode: "strict", rules: [] });
    const res = await t.call({ verb: "system", action: "bootloader_request", device: "dev_3f2a" });
    expect(res.structuredContent.resultType).toBe("confirmation_required");
    expect(String((res.structuredContent.confirmation as any).token)).toMatch(/^cfm_/);
    expect(t.daemon.calls.length).toBe(0);
  });
  it("system bootloader_request with a valid confirm_token runs", async () => {
    const t = mk({ "cdc.verb": () => ({ sent: true }) }, { mode: "strict", rules: [] });
    const first = await t.call({ verb: "system", action: "bootloader_request", device: "dev_3f2a" });
    const token = (first.structuredContent.confirmation as any).token as string;
    const res = await t.call({ verb: "system", action: "bootloader_request", device: "dev_3f2a", confirm_token: token });
    expect(t.daemon.calls[0]).toEqual({ op: "cdc.verb", args: { device: "dev_3f2a", verb: "bootloader_request", args: {} } });
    expect(res.structuredContent).toMatchObject({ success: true, result: { sent: true } });
  });
  it("a lab rule with confirm:false pre-approves stm_dfu", async () => {
    const t = mk({ "cdc.verb": () => ({ sent: true }) }, { mode: "lab", rules: [{ tool: "crosspad_cdc", when: { verb: "system", action: "stm_dfu" }, confirm: false }] });
    const res = await t.call({ verb: "system", action: "stm_dfu" });
    expect(res.structuredContent.success).toBe(true);
    expect(t.daemon.calls.length).toBe(1);
  });
});
