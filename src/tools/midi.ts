/**
 * Send MIDI events to the CrossPad simulator via TCP remote control.
 *
 * Supports: note_on, note_off, cc (control change), program_change.
 * Uses the same remote control protocol as other sim commands.
 */

import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";

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
      error: "Simulator is not running. Use crosspad_build action=pc_run to start it.",
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
      cmd = { cmd: "midi", type: "note_on", channel: params.channel, note, velocity };
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
      cmd = { cmd: "midi", type: "note_off", channel: params.channel, note, velocity };
      details.note = note;
      details.velocity = velocity;
      break;
    }

    case "cc": {
      const ccNum = params.cc_num ?? 0;
      const value = params.value ?? 0;
      if (ccNum < 0 || ccNum > 127) {
        return { success: false, type: params.type, channel: params.channel, details, error: "CC number must be 0-127" };
      }
      if (value < 0 || value > 127) {
        return { success: false, type: params.type, channel: params.channel, details, error: "Value must be 0-127" };
      }
      cmd = { cmd: "midi", type: "cc", channel: params.channel, cc: ccNum, value };
      details.cc = ccNum;
      details.value = value;
      break;
    }

    case "program_change": {
      const program = params.program ?? 0;
      if (program < 0 || program > 127) {
        return { success: false, type: params.type, channel: params.channel, details, error: "Program must be 0-127" };
      }
      cmd = { cmd: "midi", type: "program_change", channel: params.channel, program };
      details.program = program;
      break;
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
