/**
 * MCP tool: capture a screenshot from the running CrossPad simulator.
 * The simulator encodes PNG natively via stb_image_write.
 *
 * When saving to file, the simulator writes the PNG directly to disk
 * (no base64 round-trip over TCP). Otherwise returns inline base64.
 */

import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";
import { cropPng } from "../utils/png.js";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { CROSSPAD_PC_ROOT } from "../config.js";

/** What to capture: the whole emulator window, or only the 320x240 panel. */
export type ScreenshotRegion = "full" | "lcd";

/**
 * Where the LCD panel sits inside the emulator window, from
 * Stm32EmuWindow.hpp: LCD_X = (490 - 320) / 2, LCD_Y = 58, at zoom 1.
 *
 * A current simulator reports its own geometry in every screenshot reply
 * (`lcd_origin`, `lcd_size`, `scale`) and that is what the crop uses; this
 * constant is the fallback for a simulator that predates the field, whose own
 * `region: "lcd"` also cropped 18 rows too high — which is why the panel is
 * always cut out of a full-window capture here rather than requested.
 */
export const LCD_RECT = { x: 85, y: 58, width: 320, height: 240 } as const;

/** The panel's place in a full-window capture, in capture pixels. */
export interface LcdGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

const LcdGeometrySchema = z.object({
  lcd_origin: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  lcd_size: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  scale: z.number().positive(),
});

/** Geometry the simulator reported, or the zoom-1 layout if it reported none. */
export function lcdGeometryOf(resp: Record<string, unknown>): LcdGeometry {
  const g = LcdGeometrySchema.safeParse(resp);
  if (!g.success) return { ...LCD_RECT, scale: 1 };
  return {
    x: g.data.lcd_origin[0],
    y: g.data.lcd_origin[1],
    width: g.data.lcd_size[0],
    height: g.data.lcd_size[1],
    scale: g.data.scale,
  };
}

/** Cut the LCD panel out of a full-window capture. */
function cropToLcd(png: Buffer, g: LcdGeometry): Buffer {
  return cropPng(png, g.x, g.y, g.width, g.height);
}

// Validate the simulator's screenshot response — sim is in-process C++ but
// could ship malformed data after a crash. Better an error than NaN width.
const ScreenshotFileResponseSchema = z.object({
  ok: z.literal(true),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  size: z.number().int().nonnegative().optional(),
});
const ScreenshotInlineResponseSchema = z.object({
  ok: z.literal(true),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.string().min(1),
});

export interface ScreenshotResult {
  success: boolean;
  width?: number;
  height?: number;
  format?: string;
  file_path?: string;
  data_base64?: string;
  size?: number;
  region?: ScreenshotRegion;
  /** Where the panel's top-left pixel is in the returned image ([0, 0] for region "lcd"). */
  lcd_origin?: [number, number];
  /** Capture pixels per LCD pixel (the SDL window zoom). */
  scale?: number;
  error?: string;
}

/**
 * Take a screenshot of the simulator window.
 * @param save_to_file If true, simulator writes PNG directly to disk (fast path).
 * @param filename     Custom filename (default: screenshot_<timestamp>.png)
 * @param region       "full" = whole window; "lcd" = the 320x240 panel only.
 */
export async function crosspadScreenshot(
  saveToFile: boolean = true,
  filename?: string,
  region: ScreenshotRegion = "full"
): Promise<ScreenshotResult> {
  const running = await isSimulatorRunning();
  if (!running) {
    return {
      success: false,
      error: "Simulator is not running. Use crosspad_run to start it.",
    };
  }

  try {
    if (saveToFile) {
      // Fast path: simulator writes PNG directly to disk
      // Sanitize filename to prevent path traversal: strip any directory
      // components, keep only the basename. Reject empty/invalid names.
      let fname = filename || `screenshot_${Date.now()}.png`;
      fname = path.basename(fname);
      if (!fname || fname === "." || fname === "..") {
        fname = `screenshot_${Date.now()}.png`;
      }
      const screenshotsDir = path.join(CROSSPAD_PC_ROOT, "screenshots");
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }
      const filePath = path.join(screenshotsDir, fname).replace(/\\/g, "/");

      const resp = await sendRemoteCommand({ cmd: "screenshot", file: filePath });

      if (!resp.ok) {
        return {
          success: false,
          error: (resp.error as string) || "Screenshot failed",
        };
      }

      const parsed = ScreenshotFileResponseSchema.safeParse(resp);
      if (!parsed.success) {
        return {
          success: false,
          error: `Simulator returned malformed screenshot response: ${parsed.error.message}`,
        };
      }

      const geometry = lcdGeometryOf(resp as Record<string, unknown>);

      if (region === "lcd") {
        // The simulator has already written the full window; re-cut it in
        // place so the caller still gets exactly the path it was promised.
        try {
          const cropped = cropToLcd(fs.readFileSync(filePath), geometry);
          fs.writeFileSync(filePath, cropped);
          return {
            success: true,
            width: geometry.width,
            height: geometry.height,
            format: "png",
            file_path: filePath,
            size: cropped.length,
            region,
            lcd_origin: [0, 0],
            scale: geometry.scale,
          };
        } catch (e: any) {
          return { success: false, error: `Could not crop the LCD out of ${filePath}: ${e.message}` };
        }
      }

      return {
        success: true,
        width: parsed.data.width,
        height: parsed.data.height,
        format: "png",
        file_path: filePath,
        size: parsed.data.size,
        region,
        lcd_origin: [geometry.x, geometry.y],
        scale: geometry.scale,
      };
    }

    // Inline path: returns base64-encoded PNG
    const resp = await sendRemoteCommand({ cmd: "screenshot" });

    if (!resp.ok) {
      return {
        success: false,
        error: (resp.error as string) || "Screenshot failed",
      };
    }

    const parsed = ScreenshotInlineResponseSchema.safeParse(resp);
    if (!parsed.success) {
      return {
        success: false,
        error: `Simulator returned malformed screenshot response: ${parsed.error.message}`,
      };
    }

    const geometry = lcdGeometryOf(resp as Record<string, unknown>);

    if (region === "lcd") {
      try {
        const cropped = cropToLcd(Buffer.from(parsed.data.data, "base64"), geometry);
        return {
          success: true,
          width: geometry.width,
          height: geometry.height,
          format: "png",
          data_base64: cropped.toString("base64"),
          region,
          lcd_origin: [0, 0],
          scale: geometry.scale,
        };
      } catch (e: any) {
        return { success: false, error: `Could not crop the LCD out of the capture: ${e.message}` };
      }
    }

    return {
      success: true,
      width: parsed.data.width,
      height: parsed.data.height,
      format: "png",
      data_base64: parsed.data.data,
      region,
      lcd_origin: [geometry.x, geometry.y],
      scale: geometry.scale,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
    };
  }
}
