import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/remote-client.js", () => ({
  isSimulatorRunning: vi.fn(async () => true),
  sendRemoteCommand: vi.fn(),
}));

import { sendRemoteCommand } from "../utils/remote-client.js";
import { crosspadSettingsGet, crosspadSettingsSet, settingsCategories } from "./settings.js";

const send = vi.mocked(sendRemoteCommand);

beforeEach(() => {
  send.mockReset();
});

describe("settingsCategories", () => {
  it("always offers 'all' first", () => {
    expect(settingsCategories()[0]).toBe("all");
  });

  it("covers the groups the simulator answers", () => {
    // These are the buckets settings_get actually fills; whatever else the
    // header grows, losing one of these means the tool went backwards.
    const cats = settingsCategories();
    for (const c of ["display", "keypad", "vibration", "wireless", "audio", "system"]) {
      expect(cats, `missing '${c}'`).toContain(c);
    }
  });

  it("has no duplicates and is stable across calls", () => {
    const a = settingsCategories();
    expect(new Set(a).size).toBe(a.length);
    expect(settingsCategories()).toEqual(a);
  });
});

describe("crosspadSettingsGet", () => {
  it("rejects a category the schema does not know, naming the ones it does", async () => {
    const r = await crosspadSettingsGet("holograms");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Unknown settings category 'holograms'/);
    expect(r.error).toMatch(/keypad/);
    expect(send).not.toHaveBeenCalled();
  });

  it("passes a known category through and returns the fields", async () => {
    send.mockResolvedValue({ ok: true, keypad: { eco_mode: false } });
    const r = await crosspadSettingsGet("keypad");
    expect(send.mock.calls[0][0]).toEqual({ cmd: "settings_get", category: "keypad" });
    expect(r).toMatchObject({ success: true, category: "keypad", settings: { keypad: { eco_mode: false } } });
  });

  it("says so when the simulator answers a declared group with nothing", async () => {
    // A bare {"ok":true} reads as "this group is empty"; it means the sim has
    // no handler for the category, which is worth saying out loud.
    send.mockResolvedValue({ ok: true });
    const r = await crosspadSettingsGet("keypad");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no fields for category 'keypad'/);
  });
});

describe("crosspadSettingsSet", () => {
  it("sends a number unchanged", async () => {
    send.mockResolvedValue({ ok: true, key: "lcd_brightness", value: 80 });
    const r = await crosspadSettingsSet("lcd_brightness", 80);
    expect(send.mock.calls[0][0]).toEqual({ cmd: "settings_set", key: "lcd_brightness", value: 80 });
    expect(r).toEqual({ success: true, key: "lcd_brightness", value: 80 });
  });

  it("encodes true as 1 on the wire but answers in booleans", async () => {
    send.mockResolvedValue({ ok: true, key: "keypad.eco_mode", value: 1 });
    const r = await crosspadSettingsSet("keypad.eco_mode", true);
    expect(send.mock.calls[0][0]).toMatchObject({ value: 1 });
    expect(r).toEqual({ success: true, key: "keypad.eco_mode", value: true });
  });

  it("encodes false as 0", async () => {
    send.mockResolvedValue({ ok: true, key: "vibration.enable", value: 0 });
    const r = await crosspadSettingsSet("vibration.enable", false);
    expect(send.mock.calls[0][0]).toMatchObject({ value: 0 });
    expect(r).toEqual({ success: true, key: "vibration.enable", value: false });
  });

  it("surfaces the simulator's own rejection", async () => {
    send.mockResolvedValue({ ok: false, error: "unknown key: nope" });
    const r = await crosspadSettingsSet("nope", 1);
    expect(r).toEqual({ success: false, error: "unknown key: nope" });
  });
});
