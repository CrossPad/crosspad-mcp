// src/tools/capture.ts — crosspad_capture and crosspad_analyze: hear the device.
//
// Capture records the board through its own UAC2 endpoint, so a model can check
// that what it played actually came out. Two traps are handled for the caller
// rather than documented at them: entering the audio profile parks the RT mixer
// (a capture taken without resuming it is silent), and the path worth recording
// is the DAC→ADC loop, not the built-in mics. Spec §3.2, §5.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResponse, errorResult, type ToolResult, ErrorSchema } from "../tool-result.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { assertAllowedPath } from "../utils/paths.js";

const CAPTURE = "crosspad_capture";
const ANALYZE = "crosspad_analyze";

const PRESETS = ["headphone", "speaker", "mics", "line_in"] as const;
const KINDS = ["multitone", "click", "onset", "velocity", "psd", "silence"] as const;

const CaptureShape = {
  action: z.enum(["start", "health", "stop"]).describe("start → cap_N handle; health while it runs; stop → the WAV and its stats"),
  device: z.string().optional().describe("Device id (dev_xxxx); implicit when one board is attached"),
  handle: z.string().optional().describe("cap_N handle from start; required by health and stop"),
  seconds: z.number().min(0.1).max(3600).optional().describe("start: stop by itself after this long; omit to record until stop"),
  preset: z.enum(PRESETS).default("headphone").describe("Which path to record. headphone/speaker are the DAC→ADC loop (what the device is playing); mics/line_in are external inputs"),
  resume_audio_tasks: z.boolean().default(true).describe("start: resume the RT mixer after the profile switch. Leave true — the audio profile parks it and the take comes out silent"),
  keep_mode: z.boolean().default(false).describe("start: stay in the USB-audio profile after stop (CDC stays gone). Default restores the default profile"),
  volume: z.number().int().min(0).max(100).optional().describe("start: codec volume for the take"),
  sample_rate: z.number().int().optional().describe("start: capture rate (default 48000, the only rate the device offers)"),
  out: z.string().optional().describe("start: where to write the WAV (default under hil_logs/)"),
};

const CaptureInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    device: z.string().optional(),
    seconds: z.number().min(0.1).max(3600).optional(),
    preset: z.enum(PRESETS).default("headphone"),
    resume_audio_tasks: z.boolean().default(true),
    keep_mode: z.boolean().default(false),
    volume: z.number().int().min(0).max(100).optional(),
    sample_rate: z.number().int().optional(),
    out: z.string().optional(),
  }),
  z.object({ action: z.literal("health"), handle: z.string() }),
  z.object({ action: z.literal("stop"), handle: z.string() }),
]);

/** Lift the fields a caller reads directly; the rest rides in `result`. */
function pick(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["wav", "seconds", "peak_dbfs", "rms_dbfs", "overruns", "silent", "running", "preset", "device"]) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  return out;
}

const O_Capture = {
  success: z.boolean(),
  action: z.string().optional(),
  handle: z.string().optional(),
  device: z.string().optional(),
  wav: z.string().optional(),
  seconds: z.number().optional(),
  peak_dbfs: z.number().nullish(),
  rms_dbfs: z.number().nullish(),
  overruns: z.number().int().optional(),
  silent: z.boolean().optional(),
  running: z.boolean().optional(),
  preset: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  ts: z.number().optional(),
  error: ErrorSchema.optional(),
};

/** Add the recorded file as a link rather than inlining audio into the transcript. */
export function withWavLink(result: ToolResult, wav: unknown): ToolResult {
  if (typeof wav !== "string" || !wav) return result;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "resource_link" as const,
        uri: `file://${wav}`,
        name: wav.split("/").pop() ?? "capture.wav",
        mimeType: "audio/wav",
        description: "The recording — pass its path to crosspad_analyze",
      },
    ] as ToolResult["content"],
  };
}

export function registerCaptureTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    CAPTURE,
    {
      title: "Record the device through its own USB audio",
      description:
        "[ESP HW] Record what the CrossPad is playing, through its own UAC2 endpoint — one cable, no external interface. start returns a cap_N handle and records in the background so you can drive the pads meanwhile; stop returns the WAV as a link with peak/rms dBFS, overruns and whether the take was silent. The audio profile parks the RT mixer and removes the CDC endpoint: this tool resumes the mixer and restores the default profile for you. `silent: true` means the take has no signal — resume the mixer or check the preset, do not report it as a failed performance.",
      inputSchema: CaptureShape,
      outputSchema: O_Capture,
      annotations: annotationsFor(tierOf(CAPTURE, { action: "start" })),
    },
    async (rawArgs: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<ToolResult> => {
      const parsed = CaptureInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            hint: "health and stop take the cap_N handle that start returned",
          },
        });
      }
      const args = parsed.data;
      const signal = extra.signal;
      const daemon = ctx.daemon();

      try {
        if (args.action === "start") {
          // Spec §4.3: the WAV is written wherever this says, so it has to land
          // somewhere this server is allowed to write.
          assertAllowedPath("out", args.out);
          const opArgs: Record<string, unknown> = {
            preset: args.preset,
            resume_audio_tasks: args.resume_audio_tasks,
            keep_mode: args.keep_mode,
          };
          for (const k of ["device", "seconds", "volume", "sample_rate", "out"] as const) {
            const v = (args as Record<string, unknown>)[k];
            if (v !== undefined) opArgs[k] = v;
          }
          // Entering the audio profile re-enumerates the board, so this is slow.
          const r = await daemon.request<Record<string, unknown>>("capture.start", opArgs, {
            signal,
            timeoutMs: 90_000,
          });
          // String(undefined) is the string "undefined", which registers fine
          // and hands the model a handle that can never stop the recording.
          if (typeof r.handle !== "string" || r.handle.length === 0) {
            return jsonResponse({
              success: false,
              action: "start",
              result: r,
              error: {
                code: "BAD_DAEMON_REPLY",
                message: "capture.start returned no handle — the recording may be running with nothing to stop it.",
                hint: "Check the daemon version, then crosspad_usb_mode to put the board back in the default profile.",
              },
              ts: Date.now(),
            });
          }
          const handle = r.handle;
          ctx.handles.register(handle, { kind: "capture", device: args.device });
          return jsonResponse({ success: true, action: "start", handle, ...pick(r), result: r, ts: Date.now() });
        }

        if (args.action === "health") {
          const r = await daemon.request<Record<string, unknown>>("capture.health", { handle: args.handle }, { signal });
          return jsonResponse({ success: true, action: "health", handle: args.handle, ...pick(r), result: r, ts: Date.now() });
        }

        const r = await daemon.request<Record<string, unknown>>("capture.stop", { handle: args.handle }, {
          signal,
          timeoutMs: 90_000,
        });
        ctx.handles.drop(args.handle);
        return withWavLink(
          jsonResponse({ success: true, action: "stop", handle: args.handle, ...pick(r), result: r, ts: Date.now() }),
          r.wav,
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

const O_Analyze = {
  success: z.boolean(),
  kind: z.string().optional(),
  wav: z.string().optional(),
  verdict: z.record(z.string(), z.unknown()).optional(),
  ts: z.number().optional(),
  error: ErrorSchema.optional(),
};

export function registerAnalyzeTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    ANALYZE,
    {
      title: "Analyse a recording",
      description:
        "Offline analysis of a WAV — touches no hardware. onset: did the hits land, and when (pass the times you played as `expected`)? click: are there glitches in the render? silence: is this path dead? multitone: does the loopback reproduce the tones? velocity: does loudness track velocity monotonically? psd: spectral content and sidebands. Pair it with crosspad_capture to check that what you played actually came out.",
      inputSchema: {
        kind: z.enum(KINDS).describe("What question to ask of the recording"),
        wav: z.string().describe("Path to the WAV, as returned by crosspad_capture stop"),
        expected: z.unknown().optional().describe("onset/velocity: what you played — the schedule (ms) or the velocity list"),
        options: z.record(z.string(), z.unknown()).optional().describe("Kind-specific thresholds, e.g. {tolerance_ms: 40}"),
      },
      outputSchema: O_Analyze,
      annotations: annotationsFor(tierOf(ANALYZE, {})),
    },
    async (
      args: { kind: string; wav: string; expected?: unknown; options?: Record<string, unknown> },
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ): Promise<ToolResult> => {
      try {
        // Spec §4.3: `wav` names a file this host reads and reports on.
        assertAllowedPath("wav", args.wav);
        const r = await ctx.daemon().request<Record<string, unknown>>(
          "analyze.wav",
          {
            kind: args.kind,
            wav: args.wav,
            ...(args.expected !== undefined ? { expected: args.expected } : {}),
            ...(args.options ? { options: args.options } : {}),
          },
          { signal: extra.signal, timeoutMs: 120_000 },
        );
        return jsonResponse({ success: true, kind: args.kind, wav: args.wav, verdict: r, ts: Date.now() });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
