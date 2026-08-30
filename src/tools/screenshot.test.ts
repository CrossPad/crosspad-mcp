import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

vi.mock("../utils/remote-client.js", () => ({
  isSimulatorRunning: vi.fn(async () => true),
  sendRemoteCommand: vi.fn(),
}));

import { sendRemoteCommand } from "../utils/remote-client.js";
import { crosspadScreenshot, LCD_RECT } from "./screenshot.js";
import { encodePng, decodePng, RgbImage } from "../utils/png.js";

// The emulator window, with a pixel planted at the LCD's top-left corner so a
// crop that starts at the wrong row is visible rather than merely differently
// sized. The simulator's own region="lcd" cuts at y=40 — 18 rows too high.
const WIN_W = 490;
const WIN_H = 714;
const MARK = [254, 1, 128];

function window_(): Buffer {
  const data = Buffer.alloc(WIN_W * WIN_H * 3);
  for (let y = 0; y < WIN_H; y++) {
    for (let x = 0; x < WIN_W; x++) {
      const i = (y * WIN_W + x) * 3;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x * y) % 256;
    }
  }
  const m = (LCD_RECT.y * WIN_W + LCD_RECT.x) * 3;
  data[m] = MARK[0];
  data[m + 1] = MARK[1];
  data[m + 2] = MARK[2];
  return encodePng({ width: WIN_W, height: WIN_H, data });
}

function pixel(img: RgbImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

const send = vi.mocked(sendRemoteCommand);

beforeEach(() => {
  send.mockReset();
  // Stand in for the simulator: writes the full window wherever it is told to.
  send.mockImplementation(async (cmd: Record<string, unknown>) => {
    const png = window_();
    if (typeof cmd.file === "string") {
      fs.writeFileSync(cmd.file, png);
      return { ok: true, width: WIN_W, height: WIN_H, size: png.length, file: cmd.file };
    }
    return { ok: true, width: WIN_W, height: WIN_H, data: png.toString("base64") };
  });
});


describe("crosspadScreenshot region", () => {
  it("returns the whole window by default", async () => {
    const r = await crosspadScreenshot(false);
    expect(r.success).toBe(true);
    expect([r.width, r.height]).toEqual([WIN_W, WIN_H]);
    expect(r.region).toBe("full");
  });

  it("never asks the simulator for its own lcd crop — that one is 18 px stale", async () => {
    await crosspadScreenshot(false, undefined, "lcd");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).not.toHaveProperty("region");
  });

  it("crops the inline capture to the panel, at the row the panel is actually on", async () => {
    const r = await crosspadScreenshot(false, undefined, "lcd");
    expect(r.success).toBe(true);
    expect([r.width, r.height]).toEqual([LCD_RECT.width, LCD_RECT.height]);
    const img = decodePng(Buffer.from(r.data_base64!, "base64"));
    expect(pixel(img, 0, 0)).toEqual(MARK);
  });

  it("tells the caller where the panel is in a full capture, and that an lcd capture starts at its origin", async () => {
    const full = await crosspadScreenshot(false);
    expect(full.lcd_origin).toEqual([LCD_RECT.x, LCD_RECT.y]);
    expect(full.scale).toBe(1);
    const lcd = await crosspadScreenshot(false, undefined, "lcd");
    expect(lcd.lcd_origin).toEqual([0, 0]);
    expect(lcd.scale).toBe(1);
  });

  it("crops where the simulator says the panel is, not where the layout constant says", async () => {
    // A HiDPI simulator: zoom 2, panel at (170, 116), 640x480 pixels. The mark
    // is planted there instead.
    const W = 980, H = 1428;
    const data = Buffer.alloc(W * H * 3);
    const m = (116 * W + 170) * 3;
    data[m] = MARK[0]; data[m + 1] = MARK[1]; data[m + 2] = MARK[2];
    const png = encodePng({ width: W, height: H, data });
    send.mockImplementation(async () => ({
      ok: true, width: W, height: H, data: png.toString("base64"),
      lcd_origin: [170, 116], lcd_size: [640, 480], scale: 2,
    }));
    const r = await crosspadScreenshot(false, undefined, "lcd");
    expect(r.success).toBe(true);
    expect([r.width, r.height]).toEqual([640, 480]);
    expect(r.scale).toBe(2);
    expect(pixel(decodePng(Buffer.from(r.data_base64!, "base64")), 0, 0)).toEqual(MARK);
    const full = await crosspadScreenshot(false);
    expect(full.lcd_origin).toEqual([170, 116]);
  });

  it("keeps the last row of the panel — the rows the stale crop dropped", async () => {
    const r = await crosspadScreenshot(false, undefined, "lcd");
    const img = decodePng(Buffer.from(r.data_base64!, "base64"));
    const src = decodePng(window_());
    expect(pixel(img, 0, LCD_RECT.height - 1)).toEqual(
      pixel(src, LCD_RECT.x, LCD_RECT.y + LCD_RECT.height - 1),
    );
  });

  it("re-cuts the saved file in place, so file_path still names the crop", async () => {
    // The saved path is under <crosspad-pc>/screenshots, which the tool
    // creates itself; the fake simulator just writes the window there.
    const r = await crosspadScreenshot(true, "crosspad-mcp-test-shot.png", "lcd");
    expect(r.success).toBe(true);
    expect([r.width, r.height]).toEqual([LCD_RECT.width, LCD_RECT.height]);
    const onDisk = decodePng(fs.readFileSync(r.file_path!));
    expect([onDisk.width, onDisk.height]).toEqual([LCD_RECT.width, LCD_RECT.height]);
    expect(pixel(onDisk, 0, 0)).toEqual(MARK);
    fs.rmSync(r.file_path!, { force: true });
  });

  it("reports a window too small to hold the panel instead of returning a broken image", async () => {
    send.mockImplementation(async () => {
      const png = encodePng({ width: 100, height: 100, data: Buffer.alloc(100 * 100 * 3) });
      return { ok: true, width: 100, height: 100, data: png.toString("base64") };
    });
    const r = await crosspadScreenshot(false, undefined, "lcd");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/does not fit/);
  });
});
