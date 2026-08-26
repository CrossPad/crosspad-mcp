// src/tools/console.ts — crosspad_console: the STM VCP console through the daemon.
// open/read/expect/reset/snapshot/close map 1:1 onto console.* ops; the log file is
// never inlined — results carry a resource_link to crosspad://device/{id}/console/log.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { ReadResultSchema, ExpectResultSchema, DeviceSchema } from "../hil/schemas.js";
import { HilError } from "../hil/daemon.js";
import { consoleLogs } from "../hil/console-logs.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError, type ToolResult } from "../tool-result.js";

export const TOOL_NAME = "crosspad_console";
/** Spec §4.3: console reads capped at 2 000 lines per call. */
export const MAX_INLINE_LINES = 2000;
const DEFAULT_LIMIT = 200;
const DEFAULT_EXPECT_TIMEOUT_MS = 30_000;

export function consoleLogUri(device: string): string {
  return `crosspad://device/${device}/console/log`;
}

const Handle = z.string().regex(/^con_\d+$/, "handle must look like con_<n> (from action=open)");
const DeviceArg = z.string().min(1).describe("Device id (dev_xxxx) or a port path; omit when exactly one CrossPad is connected");

// Advertised shape. The MCP SDK only publishes a JSON schema for a top-level
// *object* schema (normalizeObjectSchema returns undefined for a union), so the
// flat shape is what clients see; ConsoleInput below does the real validation.
export const ConsoleInputShape = {
  action: z.enum(["open", "read", "expect", "reset", "snapshot", "close"]).describe("open → con_N handle; read/expect/reset/snapshot/close act on that handle"),
  device: DeviceArg.optional(),
  reset: z.boolean().optional().describe("open: pulse reset (DTR/RTS, works through the STM bridge) right after opening so the log starts at boot"),
  log_to: z.string().optional().describe("open: explicit log file path; default hil_logs/console_<device>_<ts>.log"),
  handle: Handle.optional().describe("Console handle from action=open (con_<n>)"),
  since_seq: z.number().int().min(0).optional().describe("read: return lines with seq >= this (from a previous next_seq)"),
  wait_ms: z.number().int().min(0).max(60_000).optional().describe("read: block up to this long for new lines"),
  match: z.string().optional().describe("read: regex; only matching lines are returned"),
  limit: z.number().int().min(1).optional().describe(`read: max lines inline (default ${DEFAULT_LIMIT}, hard cap ${MAX_INLINE_LINES}); the full log is the resource_link`),
  patterns: z.array(z.string().min(1)).optional().describe("expect: regexes; the first to appear wins"),
  reject: z.array(z.string().min(1)).optional().describe("expect: regexes that end the wait as a failure (e.g. 'Guru Meditation')"),
  timeout_ms: z.number().int().min(1).max(600_000).optional().describe(`expect: default ${DEFAULT_EXPECT_TIMEOUT_MS}`),
};

export const ConsoleInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    device: DeviceArg.optional(),
    reset: z.boolean().optional(),
    log_to: z.string().optional(),
  }),
  z.object({
    action: z.literal("read"),
    handle: Handle,
    since_seq: z.number().int().min(0).optional(),
    wait_ms: z.number().int().min(0).max(60_000).optional(),
    match: z.string().optional(),
    limit: z.number().int().min(1).optional(),
  }),
  z.object({
    action: z.literal("expect"),
    handle: Handle,
    patterns: z.array(z.string().min(1)).min(1),
    reject: z.array(z.string().min(1)).optional(),
    timeout_ms: z.number().int().min(1).max(600_000).optional(),
  }),
  z.object({ action: z.literal("reset"), handle: Handle }),
  z.object({ action: z.literal("snapshot"), handle: Handle }),
  z.object({ action: z.literal("close"), handle: Handle }),
]);
export type ConsoleArgs = z.infer<typeof ConsoleInput>;

export const O_Console = {
  success: z.boolean(),
  action: z.string().optional(),
  device: z.string().optional(),
  handle: z.string().optional(),
  port: z.string().optional(),
  log_path: z.string().optional(),
  log_uri: z.string().optional(),
  lines: ReadResultSchema.shape.lines.optional(),
  next_seq: z.number().int().optional(),
  lines_lost: z.number().int().optional(),
  truncated: z.boolean().optional(),
  hit: ExpectResultSchema.shape.hit.optional(),
  rejected: ExpectResultSchema.shape.rejected.optional(),
  seq: z.number().int().nullable().optional(),
  context: z.array(z.string()).optional(),
  elapsed_s: z.number().optional(),
  ts: z.number().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/** Append the console-log resource_link to a tool result. */
function withLogLink(res: ToolResult, device: string): ToolResult {
  res.content.push({
    type: "resource_link",
    uri: consoleLogUri(device),
    name: "console.log",
    mimeType: "text/plain",
    description: `Console log of ${device} (full file; results inline at most ${MAX_INLINE_LINES} lines)`,
  } as unknown as { type: "text"; text: string });
  return res;
}

function handleExpired(handle: string): ToolResult {
  return jsonResponse({
    success: false,
    error: { code: "HANDLE_EXPIRED", message: `${handle} is not an open console handle`, hint: "crosspad_console action=open again; the log file, if any, is kept" },
  });
}

async function resolveDeviceId(ctx: ToolContext, arg: string | undefined, port: string, signal: AbortSignal): Promise<string> {
  if (arg && arg.startsWith("dev_")) return arg;
  try {
    const r = await ctx.daemon().request<{ devices: unknown[] }>("devices.list", {}, { signal });
    for (const raw of r.devices) {
      const d = DeviceSchema.parse(raw);
      const paths = [d.ports.cdc, d.ports.console, d.ports.bootloader].filter((p) => p !== null).map((p) => p!.path);
      if (paths.includes(port)) return d.id;
    }
  } catch { /* fall through */ }
  return arg ?? port;
}

export function registerConsoleTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] STM32-bridge console (boot log, panics, PerfMon) through the crosspad-hil daemon. open → con_N handle (DTR/RTS deasserted so opening never reboots the board; reset=true pulses reset explicitly); read {since_seq, wait_ms, match, limit} → {lines: [[seq, line]], next_seq, lines_lost}; expect {patterns, reject, timeout_ms} → which pattern hit first (or which reject), with 20 lines of context; reset; snapshot (parsed fatals/reboots/markers/heap/cdc_drops); close. Handles expire after 30 min idle. The log file is persisted to hil_logs/ and linked as crosspad://device/{id}/console/log — never inlined.",
      inputSchema: ConsoleInputShape,
      outputSchema: O_Console,
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "reset" })),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const parsed = ConsoleInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            hint: "read/expect/reset/snapshot/close need handle=con_<n> from action=open",
          },
        });
      }
      const args = parsed.data;
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} action=${args.action} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(
          server,
          extra as RequestHandlerExtra<ServerRequest, ServerNotification>,
          TOOL_NAME,
          argsRec,
          `crosspad_console ${args.action} on ${"handle" in args ? args.handle : args.device ?? "auto"}`,
        );
        if (c.status === "token") return c.result as ToolResult;
        if (c.status === "declined") return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: "declined" } });
      }
      const daemon = ctx.daemon();
      const signal = extra.signal;

      try {
        if (args.action === "open") {
          const opArgs: Record<string, unknown> = {};
          if (args.device !== undefined) opArgs.device = args.device;
          if (args.reset !== undefined) opArgs.reset = args.reset;
          if (args.log_to !== undefined) opArgs.log_to = args.log_to;
          const r = await daemon.request<{ handle: string; port: string; log_path: string }>("console.open", opArgs, { signal, timeoutMs: 20_000 });
          const device = await resolveDeviceId(ctx, args.device, r.port, signal);
          ctx.handles.register(r.handle, { kind: "console", device });
          consoleLogs.set({ handle: r.handle, device, logPath: r.log_path, port: r.port });
          return withLogLink(
            jsonResponse({ success: true, action: "open", device, handle: r.handle, port: r.port, log_path: r.log_path, log_uri: consoleLogUri(device), ts: Date.now() }),
            device,
          );
        }

        // every other action needs a live handle
        const meta = ctx.handles.get(args.handle);
        if (!meta || meta.kind !== "console") return handleExpired(args.handle);
        ctx.handles.touch(args.handle);
        const device = meta.device ?? consoleLogs.byHandle(args.handle)?.device ?? "unknown";

        if (args.action === "read") {
          const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_INLINE_LINES);
          const opArgs: Record<string, unknown> = { handle: args.handle };
          if (args.since_seq !== undefined) opArgs.since_seq = args.since_seq;
          if (args.wait_ms !== undefined) opArgs.wait_ms = args.wait_ms;
          if (args.match !== undefined) opArgs.match = args.match;
          opArgs.limit = limit;
          const r = ReadResultSchema.parse(await daemon.request("console.read", opArgs, { signal, timeoutMs: (args.wait_ms ?? 0) + 10_000 }));
          const truncated = r.lines.length > limit;
          const lines = truncated ? r.lines.slice(0, limit) : r.lines;
          return withLogLink(
            jsonResponse({ success: true, action: "read", device, handle: args.handle, lines, next_seq: r.next_seq, lines_lost: r.lines_lost, truncated, log_uri: consoleLogUri(device), ts: Date.now() }),
            device,
          );
        }

        if (args.action === "expect") {
          const timeoutMs = args.timeout_ms ?? DEFAULT_EXPECT_TIMEOUT_MS;
          const opArgs: Record<string, unknown> = { handle: args.handle, patterns: args.patterns };
          if (args.reject !== undefined) opArgs.reject = args.reject;
          opArgs.timeout_s = timeoutMs / 1000;
          const r = ExpectResultSchema.parse(await daemon.request("console.expect", opArgs, { signal, timeoutMs: timeoutMs + 10_000 }));
          return withLogLink(
            jsonResponse({ success: true, action: "expect", device, handle: args.handle, hit: r.hit, rejected: r.rejected, seq: r.seq, context: r.context, elapsed_s: r.elapsed_s, log_uri: consoleLogUri(device), ts: Date.now() }),
            device,
          );
        }

        if (args.action === "reset") {
          await daemon.request("console.reset", { handle: args.handle }, { signal, timeoutMs: 10_000 });
          return withLogLink(jsonResponse({ success: true, action: "reset", device, handle: args.handle, log_uri: consoleLogUri(device), ts: Date.now() }), device);
        }

        if (args.action === "snapshot") {
          const r = await daemon.request<Record<string, unknown>>("console.snapshot", { handle: args.handle }, { signal, timeoutMs: 10_000 });
          return withLogLink(jsonResponse({ success: true, action: "snapshot", device, handle: args.handle, ...r, log_uri: consoleLogUri(device), ts: Date.now() }), device);
        }

        // close
        await daemon.request("console.close", { handle: args.handle }, { signal, timeoutMs: 10_000 });
        const entry = consoleLogs.byHandle(args.handle);
        ctx.handles.drop(args.handle);
        consoleLogs.dropHandle(args.handle);
        return withLogLink(
          jsonResponse({ success: true, action: "close", device, handle: args.handle, log_path: entry?.logPath, log_uri: consoleLogUri(device), ts: Date.now() }),
          device,
        );
      } catch (e) {
        if (e instanceof HilError && e.code === "HANDLE_EXPIRED" && "handle" in args) {
          ctx.handles.drop(args.handle);
          consoleLogs.dropHandle(args.handle);
        }
        return toolError(e);
      }
    },
  );
}
