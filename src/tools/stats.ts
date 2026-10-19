/**
 * MCP tool: read runtime statistics from the running CrossPad simulator.
 */

import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";

export interface StatsResult {
  success: boolean;
  stats?: Record<string, unknown>;
  error?: string;
}

/**
 * Query runtime statistics from the simulator:
 * - Platform capabilities (active flags)
 * - Pad state (16 pads: pressed, playing, note, channel, RGB color)
 * - Active pad logic handler + registered handlers
 * - Registered apps
 * - Heap stats (SRAM/PSRAM)
 * - Settings summary (brightness, theme, kit, audio engine)
 */
export async function crosspadStats(port?: number): Promise<StatsResult> {
  const running = await isSimulatorRunning(port);
  if (!running) {
    return { success: false, error: "Simulator is not running. Use crosspad_run to start it." };
  }

  try {
    const resp = await sendRemoteCommand({ cmd: "stats" }, { port });
    if (!resp.ok) {
      return { success: false, error: (resp.error as string) || "stats failed" };
    }
    const { ok, ...stats } = resp;
    return { success: true, stats };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * The top bar's state, read-only: which of the transport/status bars is the
 * page, the row's scroll, the drawer, where the encoder's focus is and the
 * last screen-wide swipe. Answers whether a swipe or drag did what it should
 * without a screenshot.
 */
export async function crosspadTopBar(port?: number): Promise<StatsResult> {
  const running = await isSimulatorRunning(port);
  if (!running) {
    return { success: false, error: "Simulator is not running. Use crosspad_run to start it." };
  }

  try {
    const resp = await sendRemoteCommand({ cmd: "top_bar" }, { port });
    if (!resp.ok) {
      return { success: false, error: (resp.error as string) || "top_bar failed" };
    }
    const { ok, ...stats } = resp;
    return { success: true, stats };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
