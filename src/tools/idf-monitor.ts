/**
 * Serial log capture from a connected CrossPad device.
 *
 * Uses Python/pyserial for direct serial reading — no TTY required.
 * This avoids idf.py monitor's TTY dependency while still using
 * the IDF Python venv (which has pyserial installed).
 *
 * Multi-device aware: requires port when multiple devices connected.
 */

import fs from "fs";
import { CROSSPAD_IDF_ROOT, IS_WINDOWS } from "../config.js";
import { getIdfEnv, OnLine } from "../utils/exec.js";
import { findCrosspadPort } from "../utils/device.js";
import { spawn, spawnSync } from "child_process";

/**
 * Best-effort check: is some other process already holding this serial port?
 * Linux/macOS only (relies on lsof). Returns the holding PID(s) or null.
 * Returning null on Windows / when lsof is missing is the safe default —
 * we treat "unknown" as "ok to proceed" so this never blocks legitimate use.
 */
function findHoldersOfPort(port: string): number[] | null {
  if (IS_WINDOWS) return null;
  try {
    const r = spawnSync("lsof", ["-t", port], { encoding: "utf-8", timeout: 3000 });
    if (r.status !== 0) return [];
    const pids = r.stdout
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n !== process.pid);
    return pids;
  } catch {
    return null;
  }
}

export interface MonitorResult {
  success: boolean;
  port: string;
  duration_seconds: number;
  lines: string[];
  line_count: number;
  truncated: boolean;
  error?: string;
}

/**
 * Build a Python script that reads from serial port for a given duration.
 * Uses pyserial (available in IDF venv). No TTY dependency.
 */
function buildSerialReaderScript(port: string, timeoutSeconds: number): string {
  // Escape for embedding in shell command
  const escapedPort = port.replace(/'/g, "\\'");
  return [
    "import serial, sys, time",
    `ser = serial.Serial('${escapedPort}', 115200, timeout=1)`,
    `end = time.time() + ${timeoutSeconds}`,
    "try:",
    "    while time.time() < end:",
    "        line = ser.readline()",
    "        if line:",
    "            text = line.decode('utf-8', errors='replace').rstrip()",
    "            if text:",
    "                print(text, flush=True)",
    "except KeyboardInterrupt:",
    "    pass",
    "finally:",
    "    ser.close()",
  ].join("\n");
}

/**
 * Capture serial logs from a connected CrossPad device.
 *
 * @param port - Serial port (auto-detect if undefined)
 * @param timeoutSeconds - How long to capture (default 10)
 * @param maxLines - Maximum lines to return (default 500)
 * @param filter - Optional string filter — only return lines containing this
 * @param onLine - Streaming callback for real-time output
 */
export async function crosspadIdfMonitor(
  port: string | undefined,
  timeoutSeconds: number = 10,
  maxLines: number = 500,
  filter: string | undefined,
  onLine?: OnLine,
  signal?: AbortSignal,
): Promise<MonitorResult> {
  const startTime = Date.now();

  // Resolve port
  const resolved = findCrosspadPort(port);
  if (resolved.error) {
    return {
      success: false,
      port: "",
      duration_seconds: 0,
      lines: [],
      line_count: 0,
      truncated: false,
      error: resolved.error,
    };
  }

  const targetPort = resolved.port;

  // Refuse to grab the port if another process is already reading it (e.g.
  // an idf.py monitor in a terminal). Two readers race on bytes and produce
  // garbled output. lsof-based check, Linux/macOS only — best effort.
  const holders = findHoldersOfPort(targetPort);
  if (holders && holders.length > 0) {
    return {
      success: false,
      port: targetPort,
      duration_seconds: 0,
      lines: [],
      line_count: 0,
      truncated: false,
      error: `Serial port ${targetPort} is in use by PID(s) ${holders.join(", ")}. Close that monitor (or kill the process) and retry.`,
    };
  }

  onLine?.("stdout", `[idf-monitor] Capturing from ${targetPort} for ${timeoutSeconds}s...`);

  // Get IDF environment (for Python with pyserial)
  let env: Record<string, string>;
  try {
    env = getIdfEnv();
  } catch (err: any) {
    return {
      success: false,
      port: targetPort,
      duration_seconds: 0,
      lines: [],
      line_count: 0,
      truncated: false,
      error: `Failed to initialize IDF environment: ${err.message}`,
    };
  }

  const script = buildSerialReaderScript(targetPort, timeoutSeconds);

  return new Promise((resolve) => {
    const lines: string[] = [];
    let totalLines = 0;
    let truncated = false;
    let stdoutBuf = "";

    // Run Python script with IDF env (has pyserial on PATH)
    const child = spawn("python3", ["-c", script], {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // Safety kill: slightly after the Python timeout
    const timer = setTimeout(() => {
      onLine?.("stdout", `[idf-monitor] Timeout reached (${timeoutSeconds}s), stopping...`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2000);
    }, (timeoutSeconds + 3) * 1000);

    // External cancellation (MCP client cancelled the request).
    const onAbort = () => {
      onLine?.("stdout", `[idf-monitor] Cancelled, stopping...`);
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    function processLine(line: string) {
      // Strip ANSI escape codes
      const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "");
      if (!clean.trim()) return;

      totalLines++;

      // Apply filter if specified
      if (filter && !clean.toLowerCase().includes(filter.toLowerCase())) {
        return;
      }

      if (lines.length < maxLines) {
        lines.push(clean);
        onLine?.("stdout", clean);
      } else {
        truncated = true;
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const parts = stdoutBuf.split("\n");
      for (let i = 0; i < parts.length - 1; i++) {
        processLine(parts[i]);
      }
      stdoutBuf = parts[parts.length - 1];
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const sline of text.split("\n")) {
        if (sline.trim()) {
          onLine?.("stderr", sline.replace(/\r/g, ""));
        }
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (stdoutBuf.trim()) {
        processLine(stdoutBuf);
      }

      const duration = (Date.now() - startTime) / 1000;
      onLine?.("stdout", `[idf-monitor] Captured ${lines.length} lines in ${duration.toFixed(1)}s`);

      resolve({
        success: code === 0 || lines.length > 0,
        port: targetPort,
        duration_seconds: duration,
        lines,
        line_count: totalLines,
        truncated,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      const duration = (Date.now() - startTime) / 1000;

      resolve({
        success: false,
        port: targetPort,
        duration_seconds: duration,
        lines,
        line_count: totalLines,
        truncated,
        error: err.message,
      });
    });
  });
}
