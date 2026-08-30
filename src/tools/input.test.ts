import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/remote-client.js", () => ({
  isSimulatorRunning: vi.fn(async () => true),
  sendRemoteCommand: vi.fn(),
}));

import { sendRemoteCommand } from "../utils/remote-client.js";
import { crosspadInput, CLICK_HOLD_MS_DEFAULT } from "./input.js";

const send = vi.mocked(sendRemoteCommand);

// What a current simulator answers: the click echoed in both spaces plus the
// object the press lands on.
const clickReply = {
  ok: true, x: 49, y: 205, space: "lcd",
  window: { x: 134, y: 263 }, lcd: { x: 49, y: 205 }, in_lcd: true, hold_ms: 120,
  hit: { class: "lv_button", x: 17, y: 173, w: 64, h: 64 },
};

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue(clickReply);
});

describe("crosspadInput click", () => {
  it("sends LCD space and the default hold unless told otherwise", async () => {
    const r = await crosspadInput({ action: "click", x: 49, y: 205 });
    expect(r.success).toBe(true);
    expect(send).toHaveBeenCalledWith({ cmd: "click", x: 49, y: 205, space: "lcd", hold_ms: CLICK_HOLD_MS_DEFAULT });
    expect(CLICK_HOLD_MS_DEFAULT).toBe(120);
  });

  it("passes an explicit space and hold through", async () => {
    await crosspadInput({ action: "click", x: 134, y: 263, space: "window", hold_ms: 0 });
    expect(send).toHaveBeenCalledWith({ cmd: "click", x: 134, y: 263, space: "window", hold_ms: 0 });
  });

  it("hands the hit report back to the caller", async () => {
    const r = await crosspadInput({ action: "click", x: 49, y: 205 });
    expect(r.response?.hit).toEqual(clickReply.hit);
    expect(r.response?.window).toEqual({ x: 134, y: 263 });
    expect(r.response?.in_lcd).toBe(true);
  });

  it("refuses an LCD click a pre-#26 simulator would have placed in window pixels", async () => {
    // The old handler echoes x/y with ok:true and knows nothing of `space`.
    send.mockResolvedValue({ ok: true, x: 49, y: 205 });
    const r = await crosspadInput({ action: "click", x: 49, y: 205 });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Rebuild crosspad-pc");
  });

  it("still accepts a window-space click from that old simulator", async () => {
    send.mockResolvedValue({ ok: true, x: 134, y: 263 });
    const r = await crosspadInput({ action: "click", x: 134, y: 263, space: "window" });
    expect(r.success).toBe(true);
  });

  it("surfaces the simulator's own rejection", async () => {
    send.mockResolvedValue({ ok: false, error: "space must be lcd or window" });
    const r = await crosspadInput({ action: "click", x: 1, y: 1 });
    expect(r.success).toBe(false);
    expect(r.error).toBe("space must be lcd or window");
  });
});

describe("crosspadInput other actions", () => {
  it("does not attach click fields to the encoder", async () => {
    send.mockResolvedValue({ ok: true });
    await crosspadInput({ action: "encoder_press" });
    expect(send).toHaveBeenCalledWith({ cmd: "encoder_press" });
  });
});
