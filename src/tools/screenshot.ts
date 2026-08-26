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
 * Where the LCD panel actually sits inside the emulator window, from
 * Stm32EmuWindow.cpp: LCD_X = (490 - 320) / 2, LCD_Y = 58.
 *
 * WORKAROUND: the simulator's own `region: "lcd"` still crops at y = 40, the
 * value the layout had before the status seam moved it down, so its crop loses
 * the bottom 18 rows of the screen and includes 18 rows of bezel at the top.
 * Until the simulator is fixed we ask for the whole window and cut the panel
 * out here — remove this and pass `region` through once it matches.
 */
export const LCD_RECT = { x: 85, y: 58, width: 320, height: 240 } as const;

/** Cut the LCD panel out of a full-window capture. */
function cropToLcd(png: Buffer): Buffer {
  return cropPng(png, LCD_RECT.x, LCD_RECT.y, LCD_RECT.width, LCD_RECT.height);
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

      if (region === "lcd") {
        // The simulator has already written the full window; re-cut it in
        // place so the caller still gets exactly the path it was promised.
        try {
          const cropped = cropToLcd(fs.readFileSync(filePath));
          fs.writeFileSync(filePath, cropped);
          return {
            success: true,
            width: LCD_RECT.width,
            height: LCD_RECT.height,
            format: "png",
            file_path: filePath,
            size: cropped.length,
            region,
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

    if (region === "lcd") {
      try {
        const cropped = cropToLcd(Buffer.from(parsed.data.data, "base64"));
        return {
          success: true,
          width: LCD_RECT.width,
          height: LCD_RECT.height,
          format: "png",
          data_base64: cropped.toString("base64"),
          region,
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
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
    };
  }
}
