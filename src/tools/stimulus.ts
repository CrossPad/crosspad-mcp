// src/tools/stimulus.ts — crosspad_stimulus, crosspad_ble, crosspad_diagnose_crash.
//
// stimulus plays the pads (a rate, or a pattern with real timings), ble drives
// the host radio, and diagnose_crash turns a panic on the console into decoded
// source lines. Spec §3.2, §6.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResponse, errorResult, type ToolResult } from "../tool-result.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { assertAllowedPath } from "../utils/paths.js";

const STIM = "crosspad_stimulus";
const BLE = "crosspad_ble";
const DIAG = "crosspad_diagnose_crash";

const Hit = z.object({
  t_ms: z.number().min(0).describe("When to strike, in ms from the start of the pattern"),
  pad: z.number().int().min(0).max(15),
  vel: z.number().int().min(1).max(127).optional(),
  gate_ms: z.number().min(1).optional().describe("How long to hold this hit"),
});

const StimShape = {
  action: z.enum(["start", "status", "stop"]).describe("start → stim_N handle; status while it plays; stop ends it early"),
  device: z.string().optional(),
  handle: z.string().optional().describe("stim_N handle; required by status and stop"),
  pads: z.array(z.number().int().min(0).max(15)).optional().describe("start: which pads to play when using a rate"),
  rate_hz: z.number().min(0.1).max(200).optional().describe("start: hits per second across the pad set. The CDC path is clamped to what the 64-deep command queue sustains, and the clamp is reported"),
  pattern: z.array(Hit).optional().describe("start: an explicit schedule — use this to play something, rather than a metronome"),
  seconds: z.number().min(0.1).max(3600).optional().describe("start: how long to play (rate mode)"),
  velocity: z.union([z.number().int().min(1).max(127), z.array(z.number().int().min(1).max(127))]).optional(),
  gate_ms: z.number().min(1).optional(),
  humanize_ms: z.number().min(0).max(200).optional().describe("start: jitter each hit by up to this much, so it does not sound like a machine"),
  chord: z.boolean().optional().describe("start: strike the whole pad set together instead of in turn"),
  transport: z.enum(["cdc", "sysex_stm", "sysex_esp"]).optional().describe("start: how hits reach the board. cdc is the control path; the sysex ones survive the USB-audio profile"),
  seed: z.number().int().optional().describe("start: makes humanize reproducible"),
  cdc_handle: z.string().optional().describe("start: play through an already-open CDC session, so you can still read state while it runs"),
};

const StimInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    device: z.string().optional(),
    pads: z.array(z.number().int().min(0).max(15)).optional(),
    rate_hz: z.number().min(0.1).max(200).optional(),
    pattern: z.array(Hit).optional(),
    seconds: z.number().min(0.1).max(3600).optional(),
    velocity: z.union([z.number().int().min(1).max(127), z.array(z.number().int().min(1).max(127))]).optional(),
    gate_ms: z.number().min(1).optional(),
    humanize_ms: z.number().min(0).max(200).optional(),
    chord: z.boolean().optional(),
    transport: z.enum(["cdc", "sysex_stm", "sysex_esp"]).optional(),
    seed: z.number().int().optional(),
    cdc_handle: z.string().optional(),
  }),
  z.object({ action: z.literal("status"), handle: z.string() }),
  z.object({ action: z.literal("stop"), handle: z.string() }),
]);

const Loose = z.record(z.string(), z.unknown());
const O_Common = {
  success: z.boolean(),
  action: z.string().optional(),
  handle: z.string().optional(),
  device: z.string().optional(),
  ts: z.number().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
};

export function registerStimulusTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    STIM,
    {
      title: "Play the pads",
      description:
        "[ESP HW] Drive the pads: a rate across a pad set, or a pattern with real timings ({t_ms, pad, vel, gate_ms}) — use the pattern to play something. Runs in the background behind a stim_N handle so you can record or read state meanwhile. status reports what was sent, the PAD_STATS delta the device actually registered and any CDC drops: the transport loss and the engine loss are separated, and neither is hidden. The CDC path is clamped to the rate the 64-deep command queue sustains and says so in `plan.throttled`.",
      inputSchema: StimShape,
      outputSchema: { ...O_Common, plan: Loose.optional(), status: Loose.optional(), result: Loose.optional() },
      annotations: annotationsFor(tierOf(STIM, {})),
    },
    async (rawArgs: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<ToolResult> => {
      const parsed = StimInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            hint: "start takes pads+rate_hz or a pattern; status and stop take the stim_N handle",
          },
        });
      }
      const args = parsed.data;
      const daemon = ctx.daemon();
      try {
        if (args.action === "start") {
          if (!args.pattern && (!args.pads || args.pads.length === 0)) {
            return jsonResponse({
              success: false,
              error: {
                code: "INVALID_ARGS",
                message: "nothing to play",
                hint: "give `pads` with `rate_hz`, or a `pattern` of {t_ms, pad}",
              },
            });
          }
          const opArgs: Record<string, unknown> = {};
          for (const k of ["device", "pads", "rate_hz", "pattern", "seconds", "velocity", "gate_ms", "humanize_ms", "chord", "transport", "seed", "cdc_handle"] as const) {
            const v = (args as Record<string, unknown>)[k];
            if (v !== undefined) opArgs[k] = v;
          }
          const r = await daemon.request<Record<string, unknown>>("stim.start", opArgs, {
            signal: extra.signal,
            timeoutMs: 60_000,
          });
          // String(undefined) is the string "undefined", which registers fine
          // and hands the model a handle that can never stop the pads.
          if (typeof r.handle !== "string" || r.handle.length === 0) {
            return jsonResponse({
              success: false,
              action: "start",
              plan: r,
              error: {
                code: "BAD_DAEMON_REPLY",
                message: "stim.start returned no handle — the pads may be firing with nothing to stop them.",
                hint: "Check the daemon version; crosspad_cdc can quiet the board in the meantime.",
              },
              ts: Date.now(),
            });
          }
          const handle = r.handle;
          ctx.handles.register(handle, { kind: "stimulus", device: args.device });
          return jsonResponse({
            success: true,
            action: "start",
            ...(typeof r.handle === "string" ? { handle: r.handle } : {}),
            plan: r,
            ts: Date.now(),
          });
        }
        const op = args.action === "status" ? "stim.status" : "stim.stop";
        const r = await daemon.request<Record<string, unknown>>(op, { handle: args.handle }, {
          signal: extra.signal,
          timeoutMs: 60_000,
        });
        if (args.action === "stop") ctx.handles.drop(args.handle);
        return jsonResponse({
          success: true,
          action: args.action,
          handle: args.handle,
          ...(args.action === "status" ? { status: r } : { result: r }),
          ts: Date.now(),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

const BleShape = {
  action: z.enum(["scan", "connect", "status", "send", "listen", "latency", "disconnect"]).describe("Drive the HOST radio: scan for the board, connect, send notes to it, listen for what it sends, measure round-trip"),
  device: z.string().optional(),
  address: z.string().optional().describe("connect: the peripheral's address. Omit to use the one the board reports as its own (BLE_STATUS self=)"),
  timeout_s: z.number().min(0.5).max(120).optional(),
  note: z.number().int().min(0).max(127).optional().describe("send: the note to play"),
  velocity: z.number().int().min(1).max(127).optional(),
  count: z.number().int().min(1).max(500).optional().describe("latency: how many probes"),
};

export function registerBleTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    BLE,
    {
      title: "Drive BLE MIDI from this host",
      description:
        "[ESP HW] Use this machine's Bluetooth radio to talk to the CrossPad's BLE MIDI: scan, connect, send notes into it, listen to what it sends out, and measure the round-trip. It matches the board by the address the board itself reports and refuses to guess between look-alikes. Needs the `ble` extra installed and a firmware with BLE compiled in — both are reported as environment errors rather than a silent pass.",
      inputSchema: BleShape,
      outputSchema: { ...O_Common, result: Loose.optional(), peripherals: z.array(Loose).optional(), count: z.number().int().optional() },
      annotations: annotationsFor(tierOf(BLE, {})),
    },
    async (
      args: { action: string; device?: string; address?: string; timeout_s?: number; note?: number; velocity?: number; count?: number },
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ): Promise<ToolResult> => {
      try {
        const opArgs: Record<string, unknown> = {};
        for (const k of ["device", "address", "timeout_s", "note", "velocity", "count"] as const) {
          if (args[k] !== undefined) opArgs[k] = args[k];
        }
        const r = await ctx.daemon().request<Record<string, unknown>>(`ble.${args.action}`, opArgs, {
          signal: extra.signal,
          timeoutMs: 120_000,
        });
        return jsonResponse({
          success: true,
          action: args.action,
          ...(typeof r.count === "number" ? { count: r.count } : {}),
          ...(Array.isArray(r.peripherals) ? { peripherals: r.peripherals as Record<string, unknown>[] } : {}),
          result: r,
          ts: Date.now(),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

export function registerDiagnoseCrashTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    DIAG,
    {
      title: "Explain a crash",
      description:
        "[ESP HW] One call, the whole evidence set for a panic: reset reason, the panic registers, the backtrace decoded to source lines against the ELF of the build that is actually flashed, the heap after the restart, and the surrounding console lines as a link. Point it at a log file, at an open console handle, or at a device (it listens briefly). Read the frames from the bottom up — the deepest CrossPad frame, not the LVGL ones above it, is where to look. It tells PANIC/WDT/BROWNOUT faults apart from ordinary restarts.",
      inputSchema: {
        device: z.string().optional().describe("Listen on this board's console for a moment"),
        console_handle: z.string().optional().describe("Use an already-open console (con_N) — it has the history"),
        log_file: z.string().optional().describe("A captured console log to decode"),
        elf: z.string().optional().describe("Override the ELF; by default the one matching the firmware's own SHA is used"),
        seconds: z.number().min(0.5).max(60).optional().describe("device mode: how long to listen"),
        decode: z.boolean().default(true).describe("Set false to skip addr2line and just report the raw frames"),
        context_lines: z.number().int().min(20).max(2000).optional(),
      },
      outputSchema: {
        success: z.boolean(),
        // Hoisted because a caller acts on them directly; the rest of the
        // daemon's evidence set rides along in `report`, which stays open —
        // it grows a field whenever the firmware grows a way to die.
        found: z.boolean().optional(),
        backtrace: z.array(Loose).optional(),
        likely_cause: z.unknown().optional(),
        report: Loose.optional(),
        ts: z.number().optional(),
        error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
      },
      annotations: annotationsFor(tierOf(DIAG, {})),
    },
    async (
      args: { device?: string; console_handle?: string; log_file?: string; elf?: string; seconds?: number; decode?: boolean; context_lines?: number },
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ): Promise<ToolResult> => {
      try {
        // Spec §4.3: both are read off this host, and `log_file` is echoed back
        // as a resource_link — an unconfined one turns this into a file reader.
        assertAllowedPath("log_file", args.log_file);
        assertAllowedPath("elf", args.elf);
        const opArgs: Record<string, unknown> = {};
        for (const k of ["device", "console_handle", "log_file", "elf", "seconds", "decode", "context_lines"] as const) {
          if (args[k] !== undefined) opArgs[k] = args[k];
        }
        const r = await ctx.daemon().request<Record<string, unknown>>("diagnose.crash", opArgs, {
          signal: extra.signal,
          timeoutMs: 120_000,
        });
        const result = jsonResponse({
          success: true,
          ...(typeof r.found === "boolean" ? { found: r.found } : {}),
          ...(Array.isArray(r.backtrace) ? { backtrace: r.backtrace as Record<string, unknown>[] } : {}),
          ...(r.likely_cause !== undefined ? { likely_cause: r.likely_cause } : {}),
          report: r,
          ts: Date.now(),
        });
        // The context dump is hundreds of lines; link it rather than inline it.
        if (typeof r.context === "string" && r.context) {
          return {
            ...result,
            content: [
              ...result.content,
              {
                type: "resource_link" as const,
                uri: `file://${r.context}`,
                name: "console context",
                mimeType: "text/plain",
                description: "The console lines around the fault",
              },
            ] as ToolResult["content"],
          };
        }
        return result;
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
