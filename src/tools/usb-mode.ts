// src/tools/usb-mode.ts — crosspad_usb_mode: read or switch the USB profile.
// "default" is MIDI+CDC (the control port every hil_* script needs); "audio" is
// MIDI+UAC2, which has NO CDC at all — every crosspad_cdc call fails with
// NO_CDC_IN_AUDIO_MODE until the device is switched back. The switch is a
// SysEx (0x1B) plus a re-enumeration wait, both owned by usbmode.py; this tool
// only names the device and reports which ports came back.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceSchema, type Device } from "../hil/schemas.js";
import { HilError } from "../hil/daemon.js";
import { listHilDevices, pickDevice } from "../hil/select.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { CONFIRMATION_OUTPUT, requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError, type ToolResult } from "../tool-result.js";

export const TOOL_NAME = "crosspad_usb_mode";

export const UsbModeInput = z.object({
  action: z.enum(["get", "set"]).describe("'get' reads the current profile from devices.list; 'set' switches it."),
  device: z.string().min(1).optional().describe("Device id (dev_xxxx) or one of its port paths; omit when exactly one CrossPad is connected."),
  mode: z.enum(["default", "audio"]).optional()
    .describe("Required for action='set'. 'default' = MIDI + CDC (control port available); 'audio' = MIDI + UAC2 (NO CDC — crosspad_cdc stops working until you switch back)."),
  wait: z.boolean().optional()
    .describe("action='set': wait for the device to re-enumerate in the new profile before returning (default true). false returns immediately and the reported ports are the pre-switch ones."),
});
export type UsbModeArgs = z.infer<typeof UsbModeInput>;

export const O_UsbMode = {
  ...CONFIRMATION_OUTPUT,
  success: z.boolean(),
  action: z.enum(["get", "set"]).optional(),
  device: z.string().optional(),
  mode: z.string().optional(),
  requested_mode: z.string().optional(),
  ports: z.object({
    device: z.string(),
    usb_mode: z.string(),
    cdc: z.string().nullable(),
    console: z.string().nullable(),
    uac2: z.string().nullable(),
    esp_midi: z.string().nullable(),
    board_rev: z.string().nullable(),
  }).optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/** The ports a profile switch actually changes, flattened for the model. */
export function usbModeRow(d: Device): {
  device: string; usb_mode: string; cdc: string | null; console: string | null;
  uac2: string | null; esp_midi: string | null; board_rev: string | null;
} {
  return {
    device: d.id,
    usb_mode: d.usb_mode,
    cdc: d.ports.cdc?.path ?? null,
    console: d.ports.console?.path ?? null,
    uac2: d.ports.uac2?.name ?? null,
    esp_midi: d.ports.esp_midi?.alsa_hw ?? d.ports.esp_midi?.name ?? null,
    board_rev: d.board_rev ?? null,
  };
}

/** toolError, plus the HilError's details at the top level — "which ids exist"
 *  is the answer to AMBIGUOUS_DEVICE, and it should not be buried. */
function failure(e: unknown): ToolResult {
  const res = toolError(e);
  if (e instanceof HilError && Object.keys(e.details).length > 0) {
    res.structuredContent.details = e.details;
    res.content = [{ type: "text", text: JSON.stringify(res.structuredContent, null, 2) }];
  }
  return res;
}

export function registerUsbModeTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] Read or switch the CrossPad's USB profile through the crosspad-hil daemon.\n" +
        "  • action='get' → the current profile and the ports that exist in it (cdc, console, uac2, esp_midi). Pure read.\n" +
        "  • action='set' with mode='default' → MIDI + CDC: the control port every crosspad_cdc / crosspad_console call needs.\n" +
        "  • action='set' with mode='audio'   → MIDI + UAC2 capture: there is NO CDC in this profile, so crosspad_cdc fails with " +
        "NO_CDC_IN_AUDIO_MODE until you switch back. The STM32 bridge console survives both profiles — read logs there.\n" +
        "wait=true (default) blocks until the device re-enumerates in the new profile and reports the refreshed ports.",
      inputSchema: UsbModeInput.shape,
      outputSchema: O_UsbMode,
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "set" })),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const args = UsbModeInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} ${args.action} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const summary = args.action === "get"
          ? `read the USB profile of ${args.device ?? "the only CrossPad"}`
          : `switch ${args.device ?? "the only CrossPad"} to USB profile "${args.mode}"`;
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summary);
        if (c.status === "token") return c.result as ToolResult;
        if (c.status === "declined") {
          return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: `${TOOL_NAME} was declined by the user.` } });
        }
      }
      try {
        if (args.action === "get") {
          const devices = await listHilDevices(ctx.daemon(), extra.signal);
          const d = pickDevice(devices, args.device);
          return jsonResponse({ success: true, action: "get", device: d.id, mode: d.usb_mode, ports: usbModeRow(d), ts: Date.now() });
        }
        if (args.mode === undefined) {
          throw new HilError("BAD_ARGS", "action='set' requires 'mode' ('default' or 'audio')", "action='get' reads the current profile without changing it");
        }
        const opArgs: Record<string, unknown> = { mode: args.mode, wait: args.wait ?? true };
        if (args.device !== undefined) opArgs.device = args.device;
        const refreshed = DeviceSchema.parse(
          await ctx.daemon().request<unknown>("usbmode.set", opArgs, { signal: extra.signal, timeoutMs: 45_000 }),
        );
        return jsonResponse({
          success: true,
          action: "set",
          device: refreshed.id,
          requested_mode: args.mode,
          mode: refreshed.usb_mode,
          ports: usbModeRow(refreshed),
          ts: Date.now(),
        });
      } catch (e) {
        return failure(e);
      }
    },
  );
}
