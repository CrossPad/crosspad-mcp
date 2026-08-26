import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer } from "../testing/fake-server.js";
import { registerDeviceResources, MAX_LOG_BYTES } from "./device.js";
import { consoleLogs } from "../hil/console-logs.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";

const dev = { id: "dev_3f2a", serial: "X", usb_mode: "default", board_rev: null, ports: { cdc: null, console: null, esp_midi: null, stm_midi: null, uac2: null, bootloader: null } };
const snap = { snapshot_id: "snap_1", device: "dev_3f2a", usb_mode: "default", apps: null, ui: null, kit: null, leds: null, pads: null, mem: null, ble: null, console: null, ts: 1, changed: [] };

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
  const fs = fakeServer();
  registerDeviceResources(fs.server, ctx);
  return { daemon, res: fs.resources };
}

describe("device resources", () => {
  it("registers the three URIs", () => {
    const { res } = mk({});
    expect(res.has("crosspad-devices")).toBe(true);
    expect(res.has("crosspad-device-state")).toBe(true);
    expect(res.has("crosspad-device-console-log")).toBe(true);
    expect(res.get("crosspad-devices")!.uriOrTemplate).toBe("crosspad://devices");
  });
  it("crosspad://devices reads devices.list", async () => {
    const { res, daemon } = mk({ "devices.list": () => ({ devices: [dev] }) });
    const out = await res.get("crosspad-devices")!.cb(new URL("crosspad://devices"));
    expect(daemon.calls[0].op).toBe("devices.list");
    expect(JSON.parse(out.contents[0].text).devices[0].id).toBe("dev_3f2a");
  });
  it("crosspad://device/{id}/state takes a fresh snapshot", async () => {
    const { res, daemon } = mk({ "snapshot.take": () => snap });
    const out = await res.get("crosspad-device-state")!.cb(new URL("crosspad://device/dev_3f2a/state"), { id: "dev_3f2a" });
    expect(daemon.calls[0]).toEqual({ op: "snapshot.take", args: { device: "dev_3f2a" } });
    expect(JSON.parse(out.contents[0].text).snapshot_id).toBe("snap_1");
  });
  it("crosspad://device/{id}/console/log serves the indexed file tail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-log-"));
    const p = path.join(dir, "console.log");
    fs.writeFileSync(p, "boot\nline2\n");
    consoleLogs.set({ handle: "con_1", device: "dev_3f2a", logPath: p, port: "/dev/ttyACM1" });
    const { res } = mk({});
    const out = await res.get("crosspad-device-console-log")!.cb(new URL("crosspad://device/dev_3f2a/console/log"), { id: "dev_3f2a" });
    expect(out.contents[0].mimeType).toBe("text/plain");
    expect(out.contents[0].text).toBe("boot\nline2\n");
  });
  it("truncates to the last MAX_LOG_BYTES", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-log-"));
    const p = path.join(dir, "big.log");
    fs.writeFileSync(p, "x".repeat(MAX_LOG_BYTES + 10) + "END");
    consoleLogs.set({ handle: "con_2", device: "dev_big", logPath: p, port: "/dev/ttyACM1" });
    const { res } = mk({});
    const out = await res.get("crosspad-device-console-log")!.cb(new URL("crosspad://device/dev_big/console/log"), { id: "dev_big" });
    expect(out.contents[0].text.startsWith("…[truncated 13 bytes]\n")).toBe(true);
    expect(out.contents[0].text.endsWith("END")).toBe(true);
  });
  it("explains when no console was opened for that device", async () => {
    const { res } = mk({});
    const out = await res.get("crosspad-device-console-log")!.cb(new URL("crosspad://device/dev_none/console/log"), { id: "dev_none" });
    expect(out.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(out.contents[0].text).error.code).toBe("NO_CONSOLE");
  });
});
