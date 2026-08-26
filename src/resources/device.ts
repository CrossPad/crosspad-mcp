// src/resources/device.ts — crosspad://devices, crosspad://device/{id}/state,
// crosspad://device/{id}/console/log. Same registerResource/ResourceTemplate
// idiom as crosspad://symbols in src/index.ts.
import fs from "fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { consoleLogs } from "../hil/console-logs.js";

/** The console-log resource serves at most the last MiB of the file. */
export const MAX_LOG_BYTES = 1_048_576;

function firstVar(v: unknown): string {
  return decodeURIComponent(String(Array.isArray(v) ? v[0] : v ?? "")).trim();
}

function jsonContents(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
}

function errorPayload(e: unknown): { error: { code: string; message: string; hint?: string } } {
  const code = (e as { code?: string }).code ?? "INTERNAL";
  const hint = (e as { hint?: string }).hint;
  return { error: { code, message: e instanceof Error ? e.message : String(e), ...(hint ? { hint } : {}) } };
}

export function readLogTail(logPath: string): string {
  const size = fs.statSync(logPath).size;
  if (size <= MAX_LOG_BYTES) return fs.readFileSync(logPath, "utf-8");
  const fd = fs.openSync(logPath, "r");
  try {
    const buf = Buffer.alloc(MAX_LOG_BYTES);
    fs.readSync(fd, buf, 0, MAX_LOG_BYTES, size - MAX_LOG_BYTES);
    return `…[truncated ${size - MAX_LOG_BYTES} bytes]\n` + buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

export function registerDeviceResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "crosspad-devices",
    "crosspad://devices",
    {
      description: "Device inventory from the crosspad-hil daemon (same payload as crosspad_devices, raw Device dicts). ttl 0 — re-discovered on every read.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const r = await ctx.daemon().request<{ devices: unknown[] }>("devices.list", {});
        return jsonContents(uri.href, r);
      } catch (e) {
        return jsonContents(uri.href, errorPayload(e));
      }
    },
  );

  server.registerResource(
    "crosspad-device-state",
    new ResourceTemplate("crosspad://device/{id}/state", { list: undefined }),
    {
      description: "Fresh snapshot of one device (apps, ui, kit, leds, pads, mem, ble, console). URI: crosspad://device/<dev_xxxx>/state. Auto-refreshed on every read.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = firstVar(variables.id);
      if (!id) return jsonContents(uri.href, { error: { code: "BAD_ARGS", message: "URI must be crosspad://device/<id>/state" } });
      try {
        const snap = await ctx.daemon().request<Record<string, unknown>>("snapshot.take", { device: id });
        return jsonContents(uri.href, snap);
      } catch (e) {
        return jsonContents(uri.href, errorPayload(e));
      }
    },
  );

  server.registerResource(
    "crosspad-device-console-log",
    new ResourceTemplate("crosspad://device/{id}/console/log", { list: undefined }),
    {
      description: "The console log file of the most recent crosspad_console open for this device (kept after close). Last 1 MiB at most.",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const id = firstVar(variables.id);
      const entry = id ? consoleLogs.byDevice(id) : undefined;
      if (!entry) {
        return jsonContents(uri.href, {
          error: { code: "NO_CONSOLE", message: `no console has been opened for ${id || "<empty id>"} in this session`, hint: "crosspad_console action=open device=<id>" },
        });
      }
      try {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: readLogTail(entry.logPath) }] };
      } catch (e) {
        return jsonContents(uri.href, { ...errorPayload(e), log_path: entry.logPath });
      }
    },
  );
}
