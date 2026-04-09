/**
 * ESP-IDF flash operations: UART flash and OTA-over-CDC.
 *
 * Multi-device aware: when multiple CrossPads are connected,
 * the user must specify a port. Auto-detects when only one is present.
 *
 * - idf_flash: runs `idf.py -p <PORT> flash` (full UART flash, requires bootloader mode)
 * - idf_ota: runs `python tools/ota_flash.py` (OTA over CDC, no bootloader needed)
 */

import fs from "fs";
import path from "path";
import { CROSSPAD_IDF_ROOT } from "../config.js";
import { runIdfStream, OnLine } from "../utils/exec.js";
import { findCrosspadPort } from "../utils/device.js";

export interface FlashResult {
  success: boolean;
  method: "uart" | "ota";
  port: string;
  duration_seconds: number;
  output_tail: string[];
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// UART FLASH — idf.py -p PORT flash
// ═══════════════════════════════════════════════════════════════════════

export async function crosspadIdfFlash(
  port: string | undefined,
  onLine?: OnLine,
): Promise<FlashResult> {
  const startTime = Date.now();

  // Validate IDF project
  if (!fs.existsSync(CROSSPAD_IDF_ROOT)) {
    return {
      success: false,
      method: "uart",
      port: "",
      duration_seconds: 0,
      output_tail: [],
      error: `IDF project not found at ${CROSSPAD_IDF_ROOT}`,
    };
  }

  // Check firmware exists (build first if not)
  const buildDir = path.join(CROSSPAD_IDF_ROOT, "build");
  if (!fs.existsSync(buildDir)) {
    return {
      success: false,
      method: "uart",
      port: "",
      duration_seconds: 0,
      output_tail: [],
      error: "No build directory found. Run crosspad_build action=idf first.",
    };
  }

  // Resolve port
  const resolved = findCrosspadPort(port);
  if (resolved.error) {
    return {
      success: false,
      method: "uart",
      port: "",
      duration_seconds: 0,
      output_tail: [],
      error: resolved.error,
    };
  }

  const targetPort = resolved.port;
  onLine?.("stdout", `[idf-flash] Flashing via UART to ${targetPort}...`);

  const cmd = `idf.py -p ${targetPort} flash`;
  const result = await runIdfStream(cmd, CROSSPAD_IDF_ROOT, onLine ?? (() => {}), 300_000);

  const combined = result.stdout + "\n" + result.stderr;
  const tail = combined
    .split("\n")
    .filter((l) => l.trim())
    .slice(-20);

  const duration = (Date.now() - startTime) / 1000;

  onLine?.("stdout", `[idf-flash] Flash ${result.success ? "completed" : "FAILED"} in ${duration.toFixed(1)}s`);

  return {
    success: result.success,
    method: "uart",
    port: targetPort,
    duration_seconds: duration,
    output_tail: tail,
    error: result.success ? undefined : extractFlashError(combined),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// OTA FLASH — python tools/ota_flash.py
// ═══════════════════════════════════════════════════════════════════════

export async function crosspadIdfOta(
  port: string | undefined,
  firmwarePath: string | undefined,
  onLine?: OnLine,
): Promise<FlashResult> {
  const startTime = Date.now();

  // Validate IDF project
  if (!fs.existsSync(CROSSPAD_IDF_ROOT)) {
    return {
      success: false,
      method: "ota",
      port: "",
      duration_seconds: 0,
      output_tail: [],
      error: `IDF project not found at ${CROSSPAD_IDF_ROOT}`,
    };
  }

  // Check OTA script exists
  const otaScript = path.join(CROSSPAD_IDF_ROOT, "tools", "ota_flash.py");
  if (!fs.existsSync(otaScript)) {
    return {
      success: false,
      method: "ota",
      port: "",
      duration_seconds: 0,
      output_tail: [],
      error: `OTA script not found at ${otaScript}`,
    };
  }

  // Resolve firmware path
  const fwPath = firmwarePath ?? path.join(CROSSPAD_IDF_ROOT, "build", "CrossPad.bin");
  if (!fs.existsSync(fwPath)) {
    return {
      success: false,
      method: "ota",
      port: "",
      duration_seconds: 0,
      output_tail: [],
      error: `Firmware not found at ${fwPath}. Run crosspad_build action=idf first.`,
    };
  }

  // Build command — ota_flash.py handles auto-detection itself,
  // but we add --port if specified for multi-device scenarios.
  // Uses IDF environment so the IDF Python venv (with pyserial) is on PATH.
  const portArg = port ? `--port ${port}` : "";
  const cmd = `python3 "${otaScript}" "${fwPath}" ${portArg}`.trim();

  const resolvedPort = port ?? "(auto-detect)";
  onLine?.("stdout", `[idf-ota] OTA flash to ${resolvedPort}...`);
  onLine?.("stdout", `[idf-ota] Firmware: ${fwPath} (${formatFileSize(fwPath)})`);

  const result = await runIdfStream(cmd, CROSSPAD_IDF_ROOT, onLine ?? (() => {}), 120_000);

  const combined = result.stdout + "\n" + result.stderr;
  const tail = combined
    .split("\n")
    .filter((l) => l.trim())
    .slice(-20);

  // Try to extract actual port from output
  const detectedPort = extractDetectedPort(combined) ?? resolvedPort;

  const duration = (Date.now() - startTime) / 1000;

  onLine?.("stdout", `[idf-ota] OTA ${result.success ? "completed" : "FAILED"} in ${duration.toFixed(1)}s`);

  return {
    success: result.success,
    method: "ota",
    port: detectedPort,
    duration_seconds: duration,
    output_tail: tail,
    error: result.success ? undefined : extractFlashError(combined),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function extractFlashError(output: string): string {
  // Look for common flash errors
  for (const line of output.split("\n").reverse()) {
    const trimmed = line.trim();
    if (/error:/i.test(trimmed) || /failed/i.test(trimmed) || /not found/i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith("OTA_ERROR")) {
      return trimmed;
    }
  }
  return "Flash failed. Check output for details.";
}

function extractDetectedPort(output: string): string | null {
  // ota_flash.py outputs: "Auto-detected CrossPad on /dev/ttyACM0"
  const match = output.match(/Auto-detected CrossPad on (\S+)/);
  if (match) return match[1];

  // Also: "CrossPad CDC available on /dev/ttyACM0"
  const match2 = output.match(/CDC available on (\S+)/);
  if (match2) return match2[1];

  // idf.py flash outputs: "Serial port /dev/ttyACM0"
  const match3 = output.match(/Serial port (\S+)/);
  return match3 ? match3[1] : null;
}

function formatFileSize(filePath: string): string {
  try {
    const size = fs.statSync(filePath).size;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(2)} MB`;
  } catch {
    return "? bytes";
  }
}
