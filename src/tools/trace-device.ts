import { runArgvStream } from "../utils/exec.js";
import { daemonPath, resolvedPython } from "./trace-symbols.js";

export interface DeviceStateResult {
  success: boolean;
  regs?: Record<string, number | null>;
  decoded?: Record<string, unknown>;
  accessible?: boolean;
  error?: string;
}

/** Pure: extract the device_state JSON from mixed daemon output (scan lines reverse). */
export function parseDeviceState(out: string): DeviceStateResult {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith("{") && l.includes('"device_state"')) {
      try {
        const o = JSON.parse(l);
        if (o.type === "device_state") {
          return { success: true, regs: o.regs, decoded: o.decoded, accessible: o.accessible, error: o.error };
        }
      } catch { /* keep scanning */ }
    }
  }
  return { success: false, error: out.split("\n").filter(Boolean).slice(-3).join(" | ") || "no output" };
}

export async function getDeviceState(signal?: AbortSignal): Promise<DeviceStateResult> {
  let out = "";
  await runArgvStream(resolvedPython(), [daemonPath(), "device-state"], process.cwd(),
    (s, line) => { if (s === "stdout") out += line + "\n"; }, 30_000, signal);
  return parseDeviceState(out);
}
