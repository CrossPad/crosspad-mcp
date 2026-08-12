/**
 * Runtime audio routing control for CrossPad hardware over USB MIDI SysEx.
 *
 * Speaks CROSSPAD_CMD_AUDIO_ROUTE (0x1D) from crosspad-core's SysEx protocol
 * (handled by platform-idf main/audio_route_control.cpp): per-codec ADC input,
 * USB-mic capture source, DAC output route, volume, mute, and a state query.
 *
 * Transport: ALSA `amidi` against the ESP's native USB MIDI port — the device
 * answers queries ONLY on that port (card "Crosspad" in default mode,
 * "Crosspad Audio" in audio mode), never on the STM bridge
 * ("CrossPad MIDI+Serial"). Linux-only, like the rest of the HIL tooling.
 */

import { execFileSync } from "child_process";

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

function hex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

/** ESP native USB MIDI port ("Crosspad ..." but not the STM bridge). */
export function findEspMidiPort(): string | null {
  let out: string;
  try {
    out = execFileSync("amidi", ["-l"], { encoding: "utf-8", timeout: 10_000 });
  } catch {
    return null;
  }
  for (const line of out.split("\n")) {
    if (/crosspad/i.test(line) && !/MIDI\+Serial/i.test(line)) {
      const m = line.match(/(hw:\d+,\d+,\d+)/);
      if (m) return m[1];
    }
  }
  return null;
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

/** Decode the 9 state bytes of a query reply (exported for tests). */
export function decodeState(bytes: number[]): AudioRouteState {
  return {
    mic_src: bytes[0],
    adc_input: [ADC_NAME[bytes[1]] ?? "diff", ADC_NAME[bytes[2]] ?? "diff"],
    dac_output: [DAC_NAME[bytes[3]] ?? "all", DAC_NAME[bytes[4]] ?? "all"],
    volume: [bytes[5], bytes[6]],
    mute: [bytes[7] !== 0, bytes[8] !== 0],
  };
}

export async function crosspadAudioRouteSet(params: AudioRouteSetParams): Promise<AudioRouteResult> {
  const { frames, error } = buildSetFrames(params);
  if (error) return { success: false, error };
  const port = findEspMidiPort();
  if (!port) return { success: false, error: "No CrossPad USB MIDI port found (amidi -l). Device connected?" };
  const sent: string[] = [];
  for (const frame of frames) {
    const f = hex(frame);
    try {
      execFileSync("amidi", ["-p", port, "-S", f], { timeout: 10_000 });
    } catch (e) {
      return { success: false, sent, port, error: `amidi send failed: ${String(e)}` };
    }
    sent.push(f);
  }
  return { success: true, sent, port };
}

export async function crosspadAudioRouteQuery(): Promise<AudioRouteResult> {
  const port = findEspMidiPort();
  if (!port) return { success: false, error: "No CrossPad USB MIDI port found (amidi -l). Device connected?" };
  let out: string;
  try {
    // Send the query and dump incoming MIDI for 2 s. Stale replies may sit in
    // the device TX FIFO until the first reader — take the LAST frame seen.
    out = execFileSync("amidi", ["-p", port, "-S", "F0 7D 1D 10 F7", "-d", "-t", "2"], {
      encoding: "utf-8",
      timeout: 15_000,
    });
  } catch (e) {
    // amidi exits non-zero on the -t timeout on some versions; keep its output.
    out = (e as { stdout?: string }).stdout ?? "";
  }
  const stream = out.replace(/\s+/g, " ");
  const matches = [...stream.matchAll(/F0 7D 1D 10((?: [0-9A-F]{2}){9}) F7/gi)];
  if (matches.length === 0) {
    return { success: false, port, error: "No query reply within 2 s. Is the firmware built with audio_route_control?" };
  }
  const last = matches[matches.length - 1][1].trim().split(" ").map((h) => parseInt(h, 16));
  return { success: true, port, state: decodeState(last) };
}
