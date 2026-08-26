/**
 * Send MIDI events to the CrossPad simulator via TCP remote control.
 *
 * Supports: note_on, note_off, cc (control change), program_change.
 * Uses the same remote control protocol as other sim commands.
 */

import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { decide } from "../policy/policy.js";
import { CONFIRMATION_OUTPUT, requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError, type ToolResult } from "../tool-result.js";
import { HilError } from "../hil/daemon.js";

export type MidiEventType = "note_on" | "note_off" | "cc" | "program_change";

export interface MidiSendParams {
  type: MidiEventType;
  channel: number;
  note?: number;
  velocity?: number;
  cc_num?: number;
  value?: number;
  program?: number;
}

export interface MidiSendResult {
  success: boolean;
  type: MidiEventType;
  channel: number;
  details: Record<string, number>;
  error?: string;
}

/**
 * Send a MIDI event to the running simulator.
 */
export async function crosspadMidiSend(params: MidiSendParams): Promise<MidiSendResult> {
  const running = await isSimulatorRunning();
  if (!running) {
    return {
      success: false,
      type: params.type,
      channel: params.channel,
      details: {},
      error: "Simulator is not running. Use crosspad_run to start it.",
    };
  }

  // Validate channel
  if (params.channel < 0 || params.channel > 15) {
    return {
      success: false,
      type: params.type,
      channel: params.channel,
      details: {},
      error: "MIDI channel must be 0-15",
    };
  }

  let cmd: Record<string, unknown>;
  const details: Record<string, number> = { channel: params.channel };

  switch (params.type) {
    case "note_on": {
      const note = params.note ?? 60;
      const velocity = params.velocity ?? 127;
      if (note < 0 || note > 127) {
        return { success: false, type: params.type, channel: params.channel, details, error: "Note must be 0-127" };
      }
      if (velocity < 0 || velocity > 127) {
        return { success: false, type: params.type, channel: params.channel, details, error: "Velocity must be 0-127" };
      }
      cmd = { cmd: "midi_note_on", channel: params.channel, note, velocity };
      details.note = note;
      details.velocity = velocity;
      break;
    }

    case "note_off": {
      const note = params.note ?? 60;
      const velocity = params.velocity ?? 0;
      if (note < 0 || note > 127) {
        return { success: false, type: params.type, channel: params.channel, details, error: "Note must be 0-127" };
      }
      cmd = { cmd: "midi_note_off", channel: params.channel, note, velocity };
      details.note = note;
      details.velocity = velocity;
      break;
    }

    case "cc": {
      // Sim's RemoteControl protocol exposes midi_note_on / midi_note_off only.
      // cc and program_change have no handler in crosspad-pc yet — fail fast
      // with a clear message instead of letting the sim return "unknown command".
      const ccNum = params.cc_num ?? 0;
      const value = params.value ?? 0;
      details.cc = ccNum;
      details.value = value;
      return {
        success: false,
        type: params.type,
        channel: params.channel,
        details,
        error: "type='cc' is not yet supported by the PC simulator (RemoteControl has no midi_cc handler). Only note_on/note_off work today.",
      };
    }

    case "program_change": {
      const program = params.program ?? 0;
      details.program = program;
      return {
        success: false,
        type: params.type,
        channel: params.channel,
        details,
        error: "type='program_change' is not yet supported by the PC simulator (RemoteControl has no midi_program_change handler). Only note_on/note_off work today.",
      };
    }

    default:
      return {
        success: false,
        type: params.type,
        channel: params.channel,
        details: {},
        error: `Unknown MIDI event type: ${params.type}`,
      };
  }

  try {
    const resp = await sendRemoteCommand(cmd);
    return {
      success: resp.ok === true,
      type: params.type,
      channel: params.channel,
      details,
      error: resp.ok ? undefined : (resp.error as string) ?? "Simulator rejected MIDI command",
    };
  } catch (err: any) {
    return {
      success: false,
      type: params.type,
      channel: params.channel,
      details,
      error: err.message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// v10 — the same tool over two transports.
//   target="device" → the crosspad-hil daemon's MIDI ops against real hardware
//   target="sim"    → the PC simulator's TCP RemoteControl (unchanged v9 path)
// `target` is required: a MIDI note is a side effect and guessing which machine
// receives it is exactly the mistake this tool must not make.
// ═══════════════════════════════════════════════════════════════════════

export const TOOL_NAME = "crosspad_midi";

/** midi.py MidiRole — which USB MIDI endpoint the frame leaves by. */
export type MidiRole = "esp" | "stm";

const RoleArg = z.enum(["esp", "stm"]).optional()
  .describe("Which MIDI endpoint: 'esp' (default) = the ESP's native USB MIDI, the only port that answers queries; 'stm' = the STM32 bridge port ('CrossPad MIDI+Serial').");
const DeviceArg = z.string().min(1).optional()
  .describe("Device id (dev_xxxx) or one of its port paths; omit when exactly one CrossPad is connected.");

/** F0 … F7, whitespace-separated hex bytes. Validated before the daemon is called. */
const SysexFrame = z.string()
  .regex(/^\s*[Ff]0(\s+[0-9A-Fa-f]{2})*\s+[Ff]7\s*$/, "frame must be whitespace-separated hex bytes starting F0 and ending F7, e.g. 'F0 7D 1D 10 F7'")
  .describe("Raw SysEx frame as hex bytes, e.g. 'F0 7D 1D 10 F7'. Manufacturer 0x7D is CrossPad's; the daemon refuses the host-denylisted frames.");

// Advertised shape (the SDK cannot publish a JSON schema for a top-level union);
// MidiInput below is what actually validates.
export const MidiInputShape = {
  target: z.enum(["device", "sim"])
    .describe("'device' = a connected CrossPad through the crosspad-hil daemon; 'sim' = the running PC simulator. Required — no default."),
  device: DeviceArg,
  action: z.enum(["note", "sysex", "echo_rtt", "query_route"]).optional()
    .describe("target='device': note = one note on/off; sysex = one raw frame; echo_rtt = round-trip timing over SysEx echo; query_route = read the audio routing state."),
  role: RoleArg,
  on: z.boolean().optional().describe("device/note: true = note on, false = note off."),
  note: z.number().int().min(0).max(127).optional().describe("MIDI note number 0-127."),
  vel: z.number().int().min(0).max(127).optional().describe("device/note: velocity 0-127 (default 100, applied by the daemon)."),
  channel: z.number().int().min(0).max(15).optional().describe("MIDI channel 0-15 (default 0)."),
  frame: SysexFrame.optional(),
  n: z.number().int().min(1).max(500).optional().describe("device/echo_rtt: how many echo frames to send (default 20)."),
  type: z.enum(["note_on", "note_off", "cc", "program_change"]).optional()
    .describe("target='sim': event type. note_on/note_off need `note`; cc and program_change are not implemented by the sim and fail fast."),
  velocity: z.number().int().min(0).max(127).optional().describe("sim: velocity (default 127 for note_on, 0 for note_off)."),
  cc_num: z.number().int().min(0).max(127).optional().describe("sim/cc: controller number."),
  value: z.number().int().min(0).max(127).optional().describe("sim/cc: controller value."),
  program: z.number().int().min(0).max(127).optional().describe("sim/program_change: program number."),
};

export const MidiInput = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("device"),
    device: DeviceArg,
    action: z.enum(["note", "sysex", "echo_rtt", "query_route"]),
    role: RoleArg,
    on: z.boolean().optional(),
    note: z.number().int().min(0).max(127).optional(),
    vel: z.number().int().min(0).max(127).optional(),
    channel: z.number().int().min(0).max(15).optional(),
    frame: SysexFrame.optional(),
    n: z.number().int().min(1).max(500).optional(),
  }),
  z.object({
    target: z.literal("sim"),
    type: z.enum(["note_on", "note_off", "cc", "program_change"]),
    channel: z.number().int().min(0).max(15).default(0),
    note: z.number().int().min(0).max(127).optional(),
    velocity: z.number().int().min(0).max(127).optional(),
    cc_num: z.number().int().min(0).max(127).optional(),
    value: z.number().int().min(0).max(127).optional(),
    program: z.number().int().min(0).max(127).optional(),
  }),
]);
export type MidiArgs = z.infer<typeof MidiInput>;

export const O_Midi = {
  ...CONFIRMATION_OUTPUT,
  success: z.boolean(),
  target: z.enum(["device", "sim"]).optional(),
  action: z.string().optional(),
  device: z.string().optional(),
  role: z.string().optional(),
  result: z.unknown().optional(),
  type: z.enum(["note_on", "note_off", "cc", "program_change"]).optional(),
  channel: z.number().int().optional(),
  details: z.record(z.string(), z.number()).optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
  ]).optional(),
};

/** Pure: device-branch args → the daemon op and its args (`device` added by the caller). */
export function toMidiOp(args: MidiArgs): { op: string; args: Record<string, unknown> } {
  if (args.target !== "device") {
    throw new HilError("BAD_ARGS", "toMidiOp is only defined for target='device'");
  }
  const out: Record<string, unknown> = {};
  switch (args.action) {
    case "note":
      if (args.role !== undefined) out.role = args.role;
      out.on = args.on ?? true;
      if (args.note === undefined) throw new HilError("BAD_ARGS", "action='note' requires 'note' (0-127)");
      out.note = args.note;
      if (args.vel !== undefined) out.vel = args.vel;
      if (args.channel !== undefined) out.channel = args.channel;
      return { op: "midi.note", args: out };
    case "sysex":
      if (args.frame === undefined) throw new HilError("BAD_ARGS", "action='sysex' requires 'frame' (e.g. 'F0 7D 1D 10 F7')");
      if (args.role !== undefined) out.role = args.role;
      out.frame = args.frame;
      return { op: "midi.sysex", args: out };
    case "echo_rtt":
      if (args.n !== undefined) out.n = args.n;
      return { op: "midi.echo_rtt", args: out };
    case "query_route":
      return { op: "midi.query_route", args: out };
  }
}

function summarizeMidi(args: MidiArgs): string {
  if (args.target === "sim") return `crosspad_midi sim ${args.type}`;
  return `crosspad_midi ${args.action} on ${args.device ?? "the only CrossPad"} (${args.role ?? "esp"} port)`;
}

/** The sim's RemoteControl has no midi_cc / midi_program_change handler; say so
 *  here rather than after a connection attempt, so the refusal is the same
 *  whether or not a simulator happens to be running. */
const SIM_UNSUPPORTED: Record<string, string> = {
  cc: "type='cc' is not yet supported by the PC simulator (RemoteControl has no midi_cc handler). Only note_on/note_off work today.",
  program_change: "type='program_change' is not yet supported by the PC simulator (RemoteControl has no midi_program_change handler). Only note_on/note_off work today.",
};

async function runSim(args: Extract<MidiArgs, { target: "sim" }>): Promise<ToolResult> {
  const need = (field: string, val: unknown): string | null =>
    val === undefined ? `Field '${field}' is required for type='${args.type}'.` : null;
  let missing: string | null = null;
  switch (args.type) {
    case "note_on":
    case "note_off":
      missing = need("note", args.note); break;
    case "cc":
      missing = need("cc_num", args.cc_num) ?? need("value", args.value); break;
    case "program_change":
      missing = need("program", args.program); break;
  }
  if (missing) return jsonResponse({ success: false, target: "sim", type: args.type, error: missing });

  const unsupported = SIM_UNSUPPORTED[args.type];
  if (unsupported) {
    return jsonResponse({ success: false, target: "sim", type: args.type, channel: args.channel, error: unsupported });
  }

  const sent = await crosspadMidiSend({
    type: args.type,
    channel: args.channel,
    note: args.note,
    velocity: args.velocity ?? (args.type === "note_off" ? 0 : 127),
    cc_num: args.cc_num,
    value: args.value,
    program: args.program,
  });
  return jsonResponse({ target: "sim", ...sent });
}

export function registerMidiTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[PC sim | ESP HW] Send MIDI. target='device' talks to a connected CrossPad through the crosspad-hil daemon:\n" +
        "  • action='note'        → note on/off (on, note, vel?, channel?, role?)\n" +
        "  • action='sysex'       → one raw frame (frame='F0 7D … F7', role?). Manufacturer 0x7D is CrossPad's.\n" +
        "  • action='echo_rtt'    → n? echo frames, returns {sent, received, lost, rtt_ms:{p50,p90,max}}\n" +
        "  • action='query_route' → the audio routing state (same data crosspad_audio_route action='query' returns)\n" +
        "  role='esp' (default) is the ESP's native USB MIDI — the ONLY port that answers queries; role='stm' is the STM32 bridge port.\n" +
        "target='sim' drives the running PC simulator over TCP RemoteControl: type='note_on'|'note_off' need `note` " +
        "(velocity defaults 127/0); type='cc' and 'program_change' are NOT implemented by the sim and fail fast. " +
        "USB profile switches go through crosspad_usb_mode, not a hand-built 0x1B frame.",
      inputSchema: MidiInputShape,
      outputSchema: O_Midi,
      annotations: annotationsFor(tierOf(TOOL_NAME, { target: "device", action: "note" })),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const parsed = MidiInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            hint: "target='device' takes action + its fields; target='sim' takes type + its fields.",
          },
        });
      }
      const args = parsed.data;
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summarizeMidi(args));
        if (c.status === "token") return c.result as ToolResult;
        if (c.status === "declined") {
          return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: `${TOOL_NAME} was declined by the user.` } });
        }
      }
      if (args.target === "sim") return runSim(args);
      try {
        const call = toMidiOp(args);
        const opArgs: Record<string, unknown> = { ...call.args };
        if (args.device !== undefined) opArgs.device = args.device;
        const result = await ctx.daemon().request<unknown>(call.op, opArgs, { signal: extra.signal, timeoutMs: 30_000 });
        return jsonResponse({
          success: true,
          target: "device",
          action: args.action,
          device: args.device,
          role: args.role ?? "esp",
          result,
          ts: Date.now(),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
