/**
 * MCP tool: capture a screenshot from the running CrossPad simulator.
 * The simulator encodes PNG natively via stb_image_write.
 *
 * When saving to file, the simulator writes the PNG directly to disk
 * (no base64 round-trip over TCP). Otherwise returns inline base64.
 */

import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";
import fs from "fs";
import path from "path";
import { CROSSPAD_PC_ROOT } from "../config.js";

export interface ScreenshotResult {
  success: boolean;
  width?: number;
  height?: number;
  format?: string;
  file_path?: string;
  data_base64?: string;
  size?: number;
  error?: string;
}

/**
 * Take a screenshot of the simulator window.
 * @param save_to_file If true, simulator writes PNG directly to disk (fast path).
 * @param filename     Custom filename (default: screenshot_<timestamp>.png)
 */
export async function crosspadScreenshot(
  saveToFile: boolean = true,
  filename?: string
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
      const fname = filename || `screenshot_${Date.now()}.png`;
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

      return {
        success: true,
        width: resp.width as number,
        height: resp.height as number,
        format: "png",
        file_path: filePath,
        size: resp.size as number,
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

    return {
      success: true,
      width: resp.width as number,
      height: resp.height as number,
      format: "png",
      data_base64: resp.data as string,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
    };
  }
}
