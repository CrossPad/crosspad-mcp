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
import { runIdfStream, runIdfArgvStream, OnLine } from "../utils/exec.js";
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
  signal?: AbortSignal,
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
      error: "No build directory found. Run crosspad_build platform=idf first.",
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

  // argv mode (shell:false) — port is allow-list-validated upstream but
  // defense-in-depth means we never let it touch a shell.
  const result = await runIdfArgvStream(
    "idf.py", ["-p", targetPort, "flash"],
    CROSSPAD_IDF_ROOT, onLine ?? (() => {}), 300_000, signal,
  );

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

