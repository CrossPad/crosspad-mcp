/**
 * MCP tool: read/write CrossPad settings via the running simulator.
 */

import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";

export interface SettingsGetResult {
  success: boolean;
  settings?: Record<string, unknown>;
  error?: string;
}

export interface SettingsSetResult {
  success: boolean;
  key?: string;
  value?: number;
  error?: string;
}

/**
 * Read settings from the running simulator.
 * @param category  "all", "display", "keypad", "vibration", "wireless", "audio", "system"
 */
export async function crosspadSettingsGet(
  category: string = "all"
): Promise<SettingsGetResult> {
  const running = await isSimulatorRunning();
  if (!running) {
    return { success: false, error: "Simulator is not running. Use crosspad_run to start it." };
  }

  try {
    const resp = await sendRemoteCommand({ cmd: "settings_get", category });
    if (!resp.ok) {
      return { success: false, error: (resp.error as string) || "settings_get failed" };
    }
    // Remove 'ok' field, pass the rest as settings
    const { ok, ...settings } = resp;
    return { success: true, settings };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Write a single setting on the running simulator.
 * @param key    Dotted key name (e.g. "lcd_brightness", "keypad.eco_mode", "vibration.enable")
 * @param value  Numeric value (booleans: 0=false, 1=true)
 */
export async function crosspadSettingsSet(
  key: string,
  value: number
): Promise<SettingsSetResult> {
  const running = await isSimulatorRunning();
  if (!running) {
    return { success: false, error: "Simulator is not running. Use crosspad_run to start it." };
  }

  try {
    const resp = await sendRemoteCommand({ cmd: "settings_set", key, value });
    if (!resp.ok) {
      return { success: false, error: (resp.error as string) || "settings_set failed" };
    }
    return { success: true, key: resp.key as string, value: resp.value as number };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
