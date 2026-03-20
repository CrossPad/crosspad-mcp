/**
 * MCP tool: capture a screenshot from the running CrossPad simulator.
 * Returns base64-encoded BMP image data.
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
  error?: string;
}

/**
 * Take a screenshot of the simulator window.
 * @param save_to_file If true, save the BMP to disk and return the path instead of base64.
 * @param filename     Custom filename (default: screenshot_<timestamp>.bmp)
 */
export async function crosspadScreenshot(
  saveToFile: boolean = true,
  filename?: string
): Promise<ScreenshotResult> {
  // Check if simulator is running
  const running = await isSimulatorRunning();
  if (!running) {
    return {
      success: false,
      error: "Simulator is not running. Use crosspad_run to start it.",
    };
  }

  try {
    const resp = await sendRemoteCommand({ cmd: "screenshot" });

    if (!resp.ok) {
      return {
        success: false,
        error: (resp.error as string) || "Screenshot failed",
      };
    }

    const width = resp.width as number;
    const height = resp.height as number;
    const b64data = resp.data as string;

    if (saveToFile) {
      // Save BMP to disk
      const fname = filename || `screenshot_${Date.now()}.bmp`;
      const screenshotsDir = path.join(CROSSPAD_PC_ROOT, "screenshots");
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }
      const filePath = path.join(screenshotsDir, fname);
      const buffer = Buffer.from(b64data, "base64");
      fs.writeFileSync(filePath, buffer);

      return {
        success: true,
        width,
        height,
        format: "bmp",
        file_path: filePath.replace(/\\/g, "/"),
      };
    }

    return {
      success: true,
      width,
      height,
      format: "bmp",
      data_base64: b64data,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message,
    };
  }
}
