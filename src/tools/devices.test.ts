import { describe, it, expect } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerDevicesTool, toV10DeviceRow, selectedId } from "./devices.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";
import { HilError } from "../hil/daemon.js";

const cdc = { path: "/dev/ttyACM0", vid: 0x303a, pid: 0x3456, serial: "AABBCCDD", product: "Crosspad", location: "1-2.1" };
const con = { path: "/dev/ttyACM1", vid: 0x0483, pid: 0x5740, serial: "STM001", product: "CrossPad MIDI+Serial", location: "1-2.2" };
const devA = {
  id: "dev_3f2a", serial: "AABBCCDD", usb_mode: "default", board_rev: null,
  ports: { cdc, console: con, esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
};
const devB = {
  id: "dev_9c11", serial: "EEFF0011", usb_mode: "default", board_rev: null,
  ports: { cdc: { ...cdc, path: "/dev/ttyACM2", serial: "EEFF0011" }, console: null, esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
};

function ctxWith(daemon: any): ToolContext {
  return { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
}

describe("toV10DeviceRow", () => {
  it("tags a paired STM VCP as stm-bridge and keeps the CDC path as port", () => {
    const row = toV10DeviceRow(devA as any);
    expect(row.kind).toBe("stm-bridge");
    expect(row.port).toBe("/dev/ttyACM0");
    expect(row.vid).toBe(0x303a);
    expect(row.pid).toBe(0x3456);
    expect(row.is_crosspad).toBe(true);
    expect(row.id).toBe("dev_3f2a");
  });
  it("tags an ESP-only device as esp-native", () => {
    expect(toV10DeviceRow(devB as any).kind).toBe("esp-native");
  });
  it("falls back to the bootloader then console port", () => {
    const boot = { ...devB, ports: { ...devB.ports, cdc: null, bootloader: { ...cdc, path: "/dev/ttyACM5", pid: 0x1001 } } };
    expect(toV10DeviceRow(boot as any).port).toBe("/dev/ttyACM5");
    const stmOnly = { ...devA, ports: { ...devA.ports, cdc: null } };
    expect(toV10DeviceRow(stmOnly as any).port).toBe("/dev/ttyACM1");
  });
});

describe("selectedId", () => {
  it("is the single device with an ESP side", () => {
    expect(selectedId([toV10DeviceRow(devA as any)])).toBe("dev_3f2a");
  });
  it("is undefined with two candidates or none", () => {
    expect(selectedId([toV10DeviceRow(devA as any), toV10DeviceRow(devB as any)])).toBeUndefined();
    const stmOnly = { ...devA, ports: { ...devA.ports, cdc: null } };
    expect(selectedId([toV10DeviceRow(stmOnly as any)])).toBeUndefined();
  });
});

describe("crosspad_devices tool", () => {
  it("registers with read annotations and returns rows from devices.list", async () => {
    const daemon = fakeDaemon({ "devices.list": () => ({ devices: [devA, devB] }) });
    const fs = fakeServer();
    registerDevicesTool(fs.server, ctxWith(daemon));
    const tool = fs.tools.get("crosspad_devices")!;
    expect(tool.config.annotations.readOnlyHint).toBe(true);
    const res = await tool.cb({}, fakeExtra());
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.crosspad_count).toBe(2);
    expect(res.structuredContent.selected).toBeUndefined();
    expect(daemon.calls[0]).toEqual({ op: "devices.list", args: {} });
  });
  it("sets selected when exactly one device", async () => {
    const daemon = fakeDaemon({ "devices.list": () => ({ devices: [devA] }) });
    const fs = fakeServer();
    registerDevicesTool(fs.server, ctxWith(daemon));
    const res = await fs.tools.get("crosspad_devices")!.cb({}, fakeExtra());
    expect(res.structuredContent.selected).toBe("dev_3f2a");
  });
  it("maps a daemon error into the error envelope", async () => {
    const daemon = fakeDaemon({ "devices.list": () => { throw new HilError("ENV", "pyserial missing", "pip install pyserial"); } });
    const fs = fakeServer();
    registerDevicesTool(fs.server, ctxWith(daemon));
    const res = await fs.tools.get("crosspad_devices")!.cb({}, fakeExtra());
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "ENV", hint: "pip install pyserial" });
  });
});
