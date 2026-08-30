/**
 * MCP tool: send input events to the running CrossPad simulator.
 * Supports: click, pad_press/release, encoder_rotate/press/release, key.
 */

import { sendRemoteCommand, isSimulatorRunning, RemoteResponse } from "../utils/remote-client.js";

/** Which coordinate space a click was measured in. */
export type ClickSpace = "lcd" | "window";

/** Default hold between button-down and button-up, in ms. The simulator polls
 *  the mouse indev every ~30 ms and only samples the button state, so a down
 *  and an up in the same tick are never seen as a press at all. */
export const CLICK_HOLD_MS_DEFAULT = 120;

export type InputAction =
  | { action: "click"; x: number; y: number; space?: ClickSpace; hold_ms?: number }
  | { action: "pad_press"; pad: number; velocity?: number }
  | { action: "pad_release"; pad: number }
  | { action: "encoder_rotate"; delta: number }
  | { action: "encoder_press" }
  | { action: "encoder_release" }
  | { action: "key"; keycode: number };

export interface InputResult {
  success: boolean;
  action: string;
  response?: Record<string, unknown>;
  error?: string;
}

/**
 * Send a single input event to the simulator.
 */
export async function crosspadInput(input: InputAction): Promise<InputResult> {
  const running = await isSimulatorRunning();
  if (!running) {
    return {
      success: false,
      action: input.action,
      error: "Simulator is not running. Use crosspad_run to start it.",
    };
  }

  try {
    let cmd: Record<string, unknown>;

    switch (input.action) {
      case "click":
        cmd = {
          cmd: "click",
          x: input.x,
          y: input.y,
          space: input.space ?? "lcd",
          hold_ms: input.hold_ms ?? CLICK_HOLD_MS_DEFAULT,
        };
        break;
      case "pad_press":
        cmd = { cmd: "pad_press", pad: input.pad, velocity: input.velocity ?? 127 };
        break;
      case "pad_release":
        cmd = { cmd: "pad_release", pad: input.pad };
        break;
      case "encoder_rotate":
        cmd = { cmd: "encoder_rotate", delta: input.delta };
        break;
      case "encoder_press":
        cmd = { cmd: "encoder_press" };
        break;
      case "encoder_release":
        cmd = { cmd: "encoder_release" };
        break;
      case "key":
        cmd = { cmd: "key", keycode: input.keycode };
        break;
      default:
        return { success: false, action: "unknown", error: "Unknown action" };
    }

    const resp = await sendRemoteCommand(cmd);

    // A simulator that predates coordinate spaces ignores `space` and clicks
    // the window pixel — silently, at the wrong place. It also does not echo
    // `window`, which is how we tell. Refuse rather than guess.
    if (input.action === "click" && resp.ok === true && cmd.space === "lcd" && resp.window === undefined) {
      return {
        success: false,
        action: input.action,
        response: resp as Record<string, unknown>,
        error:
          "This simulator does not understand click coordinate spaces (it clicked in window pixels). " +
          "Rebuild crosspad-pc, or pass space='window' with coordinates from a region='full' screenshot.",
      };
    }

    return {
      success: resp.ok === true,
      action: input.action,
      response: resp as Record<string, unknown>,
      error: resp.ok ? undefined : (resp.error as string),
    };
  } catch (err: any) {
    return {
      success: false,
      action: input.action,
      error: err.message,
    };
  }
}
