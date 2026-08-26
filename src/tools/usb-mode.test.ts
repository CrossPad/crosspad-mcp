import { describe, it, expect, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerUsbModeTool, usbModeRow, TOOL_NAME } from "./usb-mode.js";
import { tierOf } from "../policy/tiers.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";
import { jobs } from "../tasks.js";
import { handles } from "../handles.js";

const STRICT: Policy = { mode: "strict", rules: [] };
const ctxFor = (d: ReturnType<typeof fakeDaemon>): ToolContext => ({ daemon: () => d, policy: STRICT, jobs, handles });

const port = (path: string, vid = 0x303a, pid = 0x3456) => ({ path, vid, pid, serial: null, product: null, location: "1-1.2" });

const DEFAULT_MODE = {
  id: "dev_3f2a", serial: "AABB", usb_mode: "default", board_rev: "v2",
  ports: {
    cdc: port("/dev/ttyACM0"),
    console: port("/dev/ttyACM1", 0x0483, 0x5740),
    esp_midi: { name: "Crosspad", rtmidi_out: 1, rtmidi_in: 1, alsa_hw: "hw:4,0,0", rawmidi: null },
    stm_midi: null, uac2: null, bootloader: null,
  },
};
const AUDIO_MODE = {
  ...DEFAULT_MODE,
  usb_mode: "audio",
  ports: { ...DEFAULT_MODE.ports, cdc: null, uac2: { name: "Crosspad Audio", sounddevice_index: 3, alsa_id: "hw:4" } },
};

describe("usbModeRow", () => {
  it("flattens the ports a mode switch changes", () => {
    expect(usbModeRow(DEFAULT_MODE as never)).toEqual({
      device: "dev_3f2a", usb_mode: "default", cdc: "/dev/ttyACM0", console: "/dev/ttyACM1",
      uac2: null, esp_midi: "hw:4,0,0", board_rev: "v2",
    });
    expect(usbModeRow(AUDIO_MODE as never)).toMatchObject({ usb_mode: "audio", cdc: null, uac2: "Crosspad Audio" });
  });
});

describe("crosspad_usb_mode", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); });

  it("action=get reads devices.list and never writes", async () => {
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEFAULT_MODE] }) });
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "get" }, fakeExtra());
    expect(d.calls.map((c) => c.op)).toEqual(["devices.list"]);
    expect(r.structuredContent).toMatchObject({ success: true, action: "get", mode: "default", device: "dev_3f2a" });
    expect((r.structuredContent as { ports: Record<string, unknown> }).ports).toMatchObject({ cdc: "/dev/ttyACM0", uac2: null });
  });

  it("action=get with several devices and no `device` says which ids exist", async () => {
    const other = { ...DEFAULT_MODE, id: "dev_7c01" };
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEFAULT_MODE, other] }) });
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "get" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "AMBIGUOUS_DEVICE" });
    expect((r.structuredContent as { details: { candidates: string[] } }).details.candidates).toEqual(["dev_3f2a", "dev_7c01"]);
  });

  it("action=set forwards mode and wait to usbmode.set and reports the refreshed device", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEFAULT_MODE] }),
      "usbmode.set": () => AUDIO_MODE,
    });
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "set", mode: "audio", device: "dev_3f2a" }, fakeExtra());
    expect(d.calls.map((c) => c.op)).toEqual(["usbmode.set"]);
    expect(d.calls[0].args).toEqual({ device: "dev_3f2a", mode: "audio", wait: true });
    expect(r.structuredContent).toMatchObject({ success: true, action: "set", mode: "audio", device: "dev_3f2a" });
    expect((r.structuredContent as { ports: Record<string, unknown> }).ports).toMatchObject({ cdc: null, uac2: "Crosspad Audio" });
  });

  it("action=set honours wait=false", async () => {
    const d = fakeDaemon({ "usbmode.set": () => ({ ...DEFAULT_MODE, usb_mode: "unknown" }) });
    registerUsbModeTool(fs.server, ctxFor(d));
    await fs.tools.get(TOOL_NAME)!.cb({ action: "set", mode: "default", device: "dev_3f2a", wait: false }, fakeExtra());
    expect(d.calls[0].args).toEqual({ device: "dev_3f2a", mode: "default", wait: false });
  });

  it("action=set without mode is refused before the daemon is touched", async () => {
    const d = fakeDaemon({});
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "set" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "BAD_ARGS" });
    expect(d.calls).toHaveLength(0);
  });

  it("a daemon TIMEOUT keeps its code and hint", async () => {
    const { HilError } = await import("../hil/daemon.js");
    const d = fakeDaemon({ "usbmode.set": () => { throw new HilError("TIMEOUT", "device did not re-enumerate as audio within 20.0 s", "unplug/replug, then crosspad_devices"); } });
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "set", mode: "audio", device: "dev_3f2a" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "TIMEOUT" });
  });
});

describe("crosspad_usb_mode tier", () => {
  it("get is read, set is stimulus", () => {
    expect(tierOf("crosspad_usb_mode", { action: "get" })).toBe("read");
    expect(tierOf("crosspad_usb_mode", { action: "set", mode: "audio" })).toBe("stimulus");
    expect(tierOf("crosspad_usb_mode", {})).toBe("stimulus");
  });
});
