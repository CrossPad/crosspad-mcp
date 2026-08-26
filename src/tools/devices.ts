// src/tools/devices.ts — crosspad_devices: inventory from the crosspad-hil daemon.
// Output is a superset of v9 (port / vid / pid / is_crosspad / kind) on top of the
// contract's Device dict, so existing prompts that read `devices[].port` keep working.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceSchema, type Device } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { jsonResponse, toolError, type ToolResult, ErrorSchema } from "../tool-result.js";

export const TOOL_NAME = "crosspad_devices";

export interface DeviceRow extends Device {
  /** v9 compatibility: rev <2.0 boards are "esp-native"; a paired STM VCP means "stm-bridge". */
  kind: "esp-native" | "stm-bridge";
  /** v9 compatibility: the port a flasher would talk to (CDC → bootloader → console). */
  port: string | null;
  vid: number | null;
  pid: number | null;
  is_crosspad: true;
}

const DeviceRowSchema = DeviceSchema.extend({
  kind: z.enum(["esp-native", "stm-bridge"]),
  port: z.string().nullable(),
  vid: z.number().int().nullable(),
  pid: z.number().int().nullable(),
  is_crosspad: z.literal(true),
});

export const O_DevicesV10 = {
  success: z.boolean(),
  devices: z.array(DeviceRowSchema).optional(),
  crosspad_count: z.number().int().optional(),
  selected: z.string().optional(),
  ts: z.number().optional(),
  error: ErrorSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

export function toV10DeviceRow(d: Device): DeviceRow {
  const p = d.ports;
  const primary = p.cdc ?? p.bootloader ?? p.console ?? null;
  return {
    ...d,
    kind: p.console ? "stm-bridge" : "esp-native",
    port: primary ? primary.path : null,
    vid: primary ? primary.vid : null,
    pid: primary ? primary.pid : null,
    is_crosspad: true,
  };
}

/** Mirrors devices.select(): implicit selection only when exactly one device has an ESP side. */
export function selectedId(rows: DeviceRow[]): string | undefined {
  const esp = rows.filter((r) => r.ports.cdc !== null || r.ports.bootloader !== null);
  return esp.length === 1 ? esp[0].id : undefined;
}

export function registerDevicesTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] List connected CrossPads as seen by the crosspad-hil daemon: id (dev_xxxx, stable per USB serial), usb_mode (default|audio|bootloader|unknown), and every port role (cdc, console=STM VCP, esp_midi, stm_midi, uac2, bootloader). `kind` keeps the v9 meaning: 'esp-native' (rev <2.0) or 'stm-bridge' (rev 2.0, STM32 composite CDC+MIDI). `selected` is set when exactly one device would be chosen implicitly by every other tool.",
      inputSchema: {},
      outputSchema: O_DevicesV10,
      annotations: annotationsFor(tierOf(TOOL_NAME, {})),
    },
    async (_args, extra): Promise<ToolResult> => {
      if (decide(ctx.policy, TOOL_NAME, {}) === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      try {
        const raw = await ctx.daemon().request<{ devices: unknown[] }>("devices.list", {}, { signal: extra.signal });
        const devices = raw.devices.map((d) => toV10DeviceRow(DeviceSchema.parse(d)));
        const selected = selectedId(devices);
        return jsonResponse({
          success: true,
          devices,
          crosspad_count: devices.length,
          ...(selected ? { selected } : {}),
          ts: Date.now(),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
