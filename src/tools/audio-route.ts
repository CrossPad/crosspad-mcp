/**
 * Runtime audio routing control for CrossPad hardware over USB MIDI SysEx.
 *
 * Speaks CROSSPAD_CMD_AUDIO_ROUTE (0x1D) from crosspad-core's SysEx protocol
 * (handled by platform-idf main/audio_route_control.cpp): per-codec ADC input,
 * USB-mic capture source, DAC output route, volume, mute, and a state query.
 *
 * Transport (v10): the crosspad-hil daemon — `midi.sysex` for each set frame,
 * `midi.query_route` for the read-back. The daemon owns port discovery and the
 * reply parse, so this module no longer shells out to `amidi` and no longer
 * decodes raw bytes; that also makes it work on Windows and macOS, where the
 * old ALSA-only path could not run at all. Frame construction stays here
 * because it is the part worth unit-testing without a device.
 */

import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HilError } from "../hil/daemon.js";
import { listHilDevices, pickDevice, type DaemonRequester } from "../hil/select.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { CONFIRMATION_OUTPUT, requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, type ToolResult, ErrorSchema } from "../tool-result.js";

export type { DaemonRequester };

export type AdcInput = "diff" | "line1" | "line2";
export type DacOutput = "line1" | "line2" | "all";

export interface AudioRouteSetParams {
  codec?: 0 | 1;
  adc_input?: AdcInput;
  mic_src?: 0 | 1;
  dac_output?: DacOutput;
  volume?: number;
  mute?: boolean;
}

export interface AudioRouteState {
  mic_src: number;
  adc_input: [AdcInput, AdcInput];
  dac_output: [DacOutput, DacOutput];
  volume: [number, number];
  mute: [boolean, boolean];
}

export interface AudioRouteResult {
  success: boolean;
  sent?: string[];
  state?: AudioRouteState;
  port?: string;
  error?: string;
}

const ADC_CODE: Record<AdcInput, number> = { diff: 0, line1: 1, line2: 2 };
const ADC_NAME: AdcInput[] = ["diff", "line1", "line2"];
const DAC_CODE: Record<DacOutput, number> = { line1: 1, line2: 2, all: 3 };
const DAC_NAME: DacOutput[] = ["all", "line1", "line2", "all"]; // 1-based codes; 0 unused

export const TOOL_NAME = "crosspad_audio_route";

/** One SysEx frame as the daemon's `frame` argument wants it: "F0 7D 1D 01 00 02 F7". */
export function hexFrame(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

/** Build the SysEx frames for a set request (exported for tests). */
export function buildSetFrames(p: AudioRouteSetParams): { frames: number[][]; error?: string } {
  const frames: number[][] = [];
  const needsCodec = p.adc_input !== undefined || p.dac_output !== undefined ||
                     p.volume !== undefined || p.mute !== undefined;
  if (needsCodec && p.codec === undefined) {
    return { frames, error: "Field 'codec' (0|1) is required for adc_input/dac_output/volume/mute." };
  }
  const wrap = (body: number[]) => [0xf0, 0x7d, 0x1d, ...body, 0xf7];
  if (p.adc_input !== undefined) frames.push(wrap([0x01, p.codec!, ADC_CODE[p.adc_input]]));
  if (p.mic_src !== undefined) frames.push(wrap([0x02, p.mic_src]));
  if (p.dac_output !== undefined) frames.push(wrap([0x03, p.codec!, DAC_CODE[p.dac_output]]));
  if (p.volume !== undefined) {
    if (p.volume < 0 || p.volume > 100) return { frames, error: "volume must be 0-100" };
    frames.push(wrap([0x04, p.codec!, p.volume]));
  }
  if (p.mute !== undefined) frames.push(wrap([0x05, p.codec!, p.mute ? 1 : 0]));
  if (frames.length === 0) return { frames, error: "Nothing to set — pass at least one of adc_input/mic_src/dac_output/volume/mute." };
  return { frames };
}

/** midi.py parse_query_reply() dict → the v9 state shape this tool has always returned. */
export function stateFromQuery(q: Record<string, unknown>): AudioRouteState {
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => Number(x)) : []);
  const adc = nums(q.adc);
  const out = nums(q.out);
  const vol = nums(q.vol);
  const mute = Array.isArray(q.mute) ? (q.mute as unknown[]) : [];
  const truthy = (v: unknown): boolean => v === true || Number(v) !== 0;
  return {
    mic_src: Number(q.mic_src ?? 0),
    adc_input: [ADC_NAME[adc[0]] ?? "diff", ADC_NAME[adc[1]] ?? "diff"],
    dac_output: [DAC_NAME[out[0]] ?? "all", DAC_NAME[out[1]] ?? "all"],
    volume: [vol[0] ?? 0, vol[1] ?? 0],
    mute: [truthy(mute[0]), truthy(mute[1])],
  };
}

function describeError(e: unknown): string {
  if (e instanceof HilError) return e.hint ? `${e.code}: ${e.message} — ${e.hint}` : `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** The MIDI endpoint the frames leave by, for the `port` field of the result. */
async function resolvePort(
  daemon: DaemonRequester,
  device: string | undefined,
  signal?: AbortSignal,
): Promise<{ id: string; port: string | undefined }> {
  const devices = await listHilDevices(daemon, signal);
  const d = pickDevice(devices, device);
  return { id: d.id, port: d.ports.esp_midi?.alsa_hw ?? d.ports.esp_midi?.name ?? undefined };
}

export async function crosspadAudioRouteSet(
  daemon: DaemonRequester,
  device: string | undefined,
  params: AudioRouteSetParams,
  signal?: AbortSignal,
): Promise<AudioRouteResult> {
  const { frames, error } = buildSetFrames(params);
  if (error) return { success: false, error };
  let target: { id: string; port: string | undefined };
  try {
    target = await resolvePort(daemon, device, signal);
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
  const sent: string[] = [];
  for (const frame of frames) {
    const f = hexFrame(frame);
    try {
      await daemon.request("midi.sysex", { device: target.id, frame: f }, signal ? { signal } : undefined);
    } catch (e) {
      return { success: false, sent, port: target.port, error: `SysEx send failed: ${describeError(e)}` };
    }
    sent.push(f);
  }
  return { success: true, sent, port: target.port };
}

export async function crosspadAudioRouteQuery(
  daemon: DaemonRequester,
  device: string | undefined,
  signal?: AbortSignal,
): Promise<AudioRouteResult> {
  let target: { id: string; port: string | undefined };
  try {
    target = await resolvePort(daemon, device, signal);
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
  try {
    const q = await daemon.request<Record<string, unknown>>("midi.query_route", { device: target.id }, signal ? { signal } : undefined);
    return { success: true, port: target.port, state: stateFromQuery(q) };
  } catch (e) {
    return { success: false, port: target.port, error: describeError(e) };
  }
}

export const AudioRouteInput = z.object({
  action: z.enum(["set", "query"]).describe("'set' applies routing changes; 'query' reads the current state."),
  device: z.string().min(1).optional()
    .describe("Device id (dev_xxxx) or one of its port paths; omit when exactly one CrossPad is connected."),
  codec: z.union([z.literal(0), z.literal(1)]).optional()
    .describe("Target codec for adc_input/dac_output/volume/mute (0 = stock mic path, 1 = PCB-loopback codec)."),
  adc_input: z.enum(["diff", "line1", "line2"]).optional()
    .describe("ADC input mux of `codec`: differential, LINE1 (PCB loop on both codecs) or LINE2 (built-in mics on codec 0, jack on codec 1)."),
  mic_src: z.union([z.literal(0), z.literal(1)]).optional()
    .describe("Which codec feeds the USB mic path."),
  dac_output: z.enum(["line1", "line2", "all"]).optional()
    .describe("DAC output route of `codec`."),
  volume: z.number().int().min(0).max(100).optional().describe("Codec output volume 0-100."),
  mute: z.boolean().optional().describe("Codec output mute."),
});
export type AudioRouteArgs = z.infer<typeof AudioRouteInput>;

export const O_AudioRoute = {
  ...CONFIRMATION_OUTPUT,
  success: z.boolean(),
  sent: z.array(z.string()).optional(),
  state: z.object({
    mic_src: z.number().int(),
    adc_input: z.array(z.enum(["diff", "line1", "line2"])).length(2),
    dac_output: z.array(z.enum(["line1", "line2", "all"])).length(2),
    volume: z.array(z.number().int()).length(2),
    mute: z.array(z.boolean()).length(2),
  }).optional(),
  port: z.string().optional(),
  error: z.union([
    z.string(),
    ErrorSchema,
  ]).optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
};

export function registerAudioRouteTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] Runtime audio routing on a connected CrossPad, over USB MIDI SysEx " +
        "(CROSSPAD_CMD_AUDIO_ROUTE 0x1D) through the crosspad-hil daemon. Works in both USB profiles.\n" +
        "  • action='query' → read back the full routing state (mic_src, ADC inputs, DAC outputs, volumes, mutes).\n" +
        "  • action='set'   → apply any subset of: adc_input ('diff'|'line1'|'line2'), mic_src (0|1), " +
        "dac_output ('line1'|'line2'|'all'), volume (0-100), mute. Per-codec fields need `codec` (0|1).\n" +
        "Notes: codec0 LINE2 is the built-in mics; every other input is the DAC→ADC loop, and codec1 LINE1 is the " +
        "near-unity path with the better SNR (compresses above ~0.2 FS input). Routing reverts to firmware defaults " +
        "on device reset — only the named preset is persisted, by the firmware, not by this tool.",
      inputSchema: AudioRouteInput.shape,
      outputSchema: O_AudioRoute,
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "set" })),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const args = AudioRouteInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} ${args.action} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const summary = args.action === "query"
          ? `read the audio routing of ${args.device ?? "the only CrossPad"}`
          : `change the audio routing of ${args.device ?? "the only CrossPad"}`;
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summary);
        if (c.status === "token") return c.result as ToolResult;
        if (c.status === "declined") {
          return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: `${TOOL_NAME} was declined by the user.` } });
        }
      }
      const daemon = ctx.daemon();
      if (args.action === "query") {
        return jsonResponse({ ...(await crosspadAudioRouteQuery(daemon, args.device, extra.signal)) });
      }
      return jsonResponse({
        ...(await crosspadAudioRouteSet(daemon, args.device, {
          codec: args.codec,
          adc_input: args.adc_input,
          mic_src: args.mic_src,
          dac_output: args.dac_output,
          volume: args.volume,
          mute: args.mute,
        }, extra.signal)),
      });
    },
  );
}
