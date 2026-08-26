import { describe, it, expect } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerConsoleTool, MAX_INLINE_LINES, consoleLogUri } from "./console.js";
import { consoleLogs } from "../hil/console-logs.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";
import { HilError } from "../hil/daemon.js";

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const handles = new HandleRegistry();
  const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles };
  const fs = fakeServer();
  registerConsoleTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_console")!;
  return { daemon, handles, tool, call: (args: any) => tool.cb(args, fakeExtra()) };
}

const OPEN = () => ({ handle: "con_1", port: "/dev/ttyACM1", log_path: "/tmp/hil_logs/console_dev_3f2a_20260826.log" });

describe("crosspad_console open", () => {
  it("registers the handle, indexes the log and returns a resource_link", async () => {
    const t = mk({ "console.open": OPEN });
    const res = await t.call({ action: "open", device: "dev_3f2a", reset: true });
    expect(t.daemon.calls[0]).toEqual({ op: "console.open", args: { device: "dev_3f2a", reset: true } });
    expect(res.structuredContent).toMatchObject({ success: true, handle: "con_1", port: "/dev/ttyACM1", device: "dev_3f2a" });
    expect(t.handles.get("con_1")).toMatchObject({ kind: "console", device: "dev_3f2a" });
    expect(consoleLogs.byHandle("con_1")?.logPath).toBe("/tmp/hil_logs/console_dev_3f2a_20260826.log");
    const link = res.content.find((c: any) => c.type === "resource_link");
    expect(link).toMatchObject({ type: "resource_link", uri: consoleLogUri("dev_3f2a"), mimeType: "text/plain" });
    expect(res.content[0].text).not.toContain("log_path_contents");
  });
  it("resolves a port path to the device id through devices.list", async () => {
    const t = mk({
      "console.open": OPEN,
      "devices.list": () => ({ devices: [{ id: "dev_3f2a", serial: "X", usb_mode: "default", board_rev: null, ports: { cdc: null, console: { path: "/dev/ttyACM1", vid: 0x483, pid: 0x5740, serial: null, product: null, location: null }, esp_midi: null, stm_midi: null, uac2: null, bootloader: null } }] }),
    });
    const res = await t.call({ action: "open", device: "/dev/ttyACM1" });
    expect(res.structuredContent.device).toBe("dev_3f2a");
  });
});

describe("crosspad_console read", () => {
  it("passes since_seq/wait_ms/match, clamps limit, touches the handle", async () => {
    const t = mk({
      "console.open": OPEN,
      "console.read": () => ({ lines: [[10, "I (1) boot"], [11, "I (2) ok"]], next_seq: 12, lines_lost: 0 }),
    });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "read", handle: "con_1", since_seq: 10, wait_ms: 100, match: "boot", limit: 99999 });
    expect(t.daemon.calls[1]).toEqual({ op: "console.read", args: { handle: "con_1", since_seq: 10, wait_ms: 100, match: "boot", limit: MAX_INLINE_LINES } });
    expect(res.structuredContent).toMatchObject({ success: true, next_seq: 12, lines_lost: 0 });
    expect((res.structuredContent.lines as any[]).length).toBe(2);
    expect(res.content.some((c: any) => c.type === "resource_link")).toBe(true);
  });
  it("never inlines more than `limit` lines even if the daemon over-delivers", async () => {
    const many = Array.from({ length: 50 }, (_, i) => [i, `line ${i}`]);
    const t = mk({ "console.open": OPEN, "console.read": () => ({ lines: many, next_seq: 50, lines_lost: 0 }) });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "read", handle: "con_1", limit: 10 });
    expect((res.structuredContent.lines as any[]).length).toBe(10);
    expect(res.structuredContent.truncated).toBe(true);
  });
  it("reports an unknown handle as HANDLE_EXPIRED without calling the daemon", async () => {
    const t = mk({});
    const res = await t.call({ action: "read", handle: "con_9" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "HANDLE_EXPIRED" });
    expect(t.daemon.calls.length).toBe(0);
  });
});

describe("crosspad_console expect / reset / snapshot / close", () => {
  it("expect converts timeout_ms to timeout_s and returns hit/rejected/context", async () => {
    const t = mk({
      "console.open": OPEN,
      "console.expect": () => ({ hit: "STM32 ident:", rejected: null, seq: 300, context: ["a", "b"], elapsed_s: 1.5 }),
    });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "expect", handle: "con_1", patterns: ["STM32 ident:"], reject: ["Guru Meditation"], timeout_ms: 5000 });
    expect(t.daemon.calls[1]).toEqual({ op: "console.expect", args: { handle: "con_1", patterns: ["STM32 ident:"], reject: ["Guru Meditation"], timeout_s: 5 } });
    expect(res.structuredContent).toMatchObject({ success: true, hit: "STM32 ident:", rejected: null, seq: 300, elapsed_s: 1.5 });
  });
  it("reset is stimulus tier and forwards the handle", async () => {
    const t = mk({ "console.open": OPEN, "console.reset": () => ({ ok: true }) });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "reset", handle: "con_1" });
    expect(t.daemon.calls[1]).toEqual({ op: "console.reset", args: { handle: "con_1" } });
    expect(res.structuredContent.success).toBe(true);
  });
  it("snapshot returns the parser snapshot", async () => {
    const t = mk({ "console.open": OPEN, "console.snapshot": () => ({ fatals: [], reboots: 1, reset_reasons: ["POWERON"], errors: [], markers_seen: {}, boot_complete: true, missing_markers: [], bootloops: 0, heap: {}, kit_requests: [], cdc_drops: 0, seq: 400, lines_lost: 0, log_path: "/tmp/x.log", port: "/dev/ttyACM1" }) });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "snapshot", handle: "con_1" });
    expect(res.structuredContent).toMatchObject({ success: true, reboots: 1, boot_complete: true });
  });
  it("close drops the handle but keeps the log index (file kept)", async () => {
    const t = mk({ "console.open": OPEN, "console.close": () => ({ ok: true }) });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "close", handle: "con_1" });
    expect(res.structuredContent).toMatchObject({ success: true, log_path: "/tmp/hil_logs/console_dev_3f2a_20260826.log" });
    expect(t.handles.get("con_1")).toBeUndefined();
    expect(consoleLogs.byDevice("dev_3f2a")?.logPath).toBe("/tmp/hil_logs/console_dev_3f2a_20260826.log");
  });
  it("a daemon HANDLE_EXPIRED drops the TS handle too", async () => {
    const t = mk({ "console.open": OPEN, "console.read": () => { throw new HilError("HANDLE_EXPIRED", "con_1 expired", "open again"); } });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "read", handle: "con_1" });
    expect(res.structuredContent.error).toMatchObject({ code: "HANDLE_EXPIRED", hint: "open again" });
    expect(t.handles.get("con_1")).toBeUndefined();
  });
});
