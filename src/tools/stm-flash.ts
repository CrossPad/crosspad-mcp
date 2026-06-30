/**
 * STM32 firmware flash via STM32_Programmer_CLI (ST's CubeProgrammer CLI).
 *
 * Two methods, mirroring the invocations documented in the firmware repo's
 * CLAUDE.md:
 *   - swd → ST-Link over SWD:  -c port=SWD freq=4000 -w <bin> 0x08000000 -rst --start 0x08000000
 *   - dfu → USB DFU bootloader: -c port=USB1 -w <bin> 0x08000000 -s 0x08000000
 *           (board must be in ST system bootloader — hold pad 1 at boot, or
 *            trigger boot_request_dfu).
 *
 * The flasher binary is resolved from user config → $STM32_PROG → PATH; if none
 * resolves we fail early with actionable guidance rather than spawning garbage.
 */

import fs from "fs";
import { spawnSync } from "child_process";
import { CROSSPAD_STM_ROOT, stmArtifact, StmPreset, STM_FLASH_ADDR, IS_WINDOWS } from "../config.js";
import { runArgvStream, OnLine } from "../utils/exec.js";
import { loadUserConfig } from "../utils/userConfig.js";

export interface StmFlashResult {
  success: boolean;
  method: "swd" | "dfu";
  programmer: string;
  firmware_path: string;
  duration_seconds: number;
  output_tail: string[];
  error?: string;
}

/**
 * Resolve the STM32_Programmer_CLI binary. Order: user config →
 * $STM32_PROG env → PATH lookup. Returns null when nothing usable is found.
 * @internal exported for testing
 */
export function resolveProgrammer(): string | null {
  const cfg = loadUserConfig();
  if (cfg.stm_programmer_cli && fs.existsSync(cfg.stm_programmer_cli)) {
    return cfg.stm_programmer_cli;
  }
  const fromEnv = process.env.STM32_PROG;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const finder = IS_WINDOWS ? "where" : "which";
  try {
    const r = spawnSync(finder, ["STM32_Programmer_CLI"], { encoding: "utf-8", timeout: 5000 });
    if (r.status === 0) {
      const first = (r.stdout || "").split("\n").map((s) => s.trim()).find(Boolean);
      if (first) return first;
    }
  } catch {
    // which/where absent — fall through to null.
  }
  return null;
}

/**
 * Build the STM32_Programmer_CLI argv for a flash method. No shell — bin path
 * may be user-supplied, so it never touches a command line.
 * @internal exported for testing
 */
export function stmFlashArgv(method: "swd" | "dfu", bin: string): string[] {
  if (method === "swd") {
    return ["-c", "port=SWD", "freq=4000", "-w", bin, STM_FLASH_ADDR, "-rst", "--start", STM_FLASH_ADDR];
  }
  return ["-c", "port=USB1", "-w", bin, STM_FLASH_ADDR, "-s", STM_FLASH_ADDR];
}

function presetFor(buildType: string): StmPreset {
  return buildType === "Release" || buildType === "RelWithDebInfo" ? "Release" : "Debug";
}

export async function crosspadStmFlash(
  method: "swd" | "dfu",
  buildType: string = "Debug",
  firmwarePath: string | undefined,
  onLine?: OnLine,
  signal?: AbortSignal,
): Promise<StmFlashResult> {
  const startTime = Date.now();
  const emit: OnLine = onLine ?? (() => {});
  const bin = firmwarePath ?? stmArtifact(presetFor(buildType), "bin");

  const fail = (error: string): StmFlashResult => ({
    success: false, method, programmer: "", firmware_path: bin,
    duration_seconds: (Date.now() - startTime) / 1000, output_tail: [], error,
  });

  if (!fs.existsSync(CROSSPAD_STM_ROOT)) {
    return fail(`STM32 repo not found at ${CROSSPAD_STM_ROOT}`);
  }

  const programmer = resolveProgrammer();
  if (!programmer) {
    return fail(
      "STM32_Programmer_CLI not found. Set it via crosspad_trace action=config_set " +
      "key=stm_programmer_cli value=<path>, the STM32_PROG env var, or put it on PATH.",
    );
  }

  if (!fs.existsSync(bin)) {
    return fail(`Firmware not found at ${bin}. Run crosspad_build platform=stm first.`);
  }

  const argv = stmFlashArgv(method, bin);
  emit("stdout", `[stm-flash] Flashing via ${method.toUpperCase()} with ${programmer}...`);
  emit("stdout", `[stm-flash] Firmware: ${bin}`);

  const result = await runArgvStream(programmer, argv, CROSSPAD_STM_ROOT, emit, 180_000, signal);
  const combined = result.stdout + "\n" + result.stderr;
  const tail = combined.split("\n").filter((l) => l.trim()).slice(-20);
  const duration = (Date.now() - startTime) / 1000;

  emit("stdout", `[stm-flash] Flash ${result.success ? "completed" : "FAILED"} in ${duration.toFixed(1)}s`);

  return {
    success: result.success,
    method,
    programmer,
    firmware_path: bin,
    duration_seconds: duration,
    output_tail: tail,
    error: result.success ? undefined : extractFlashError(combined),
  };
}

/** Pull the most relevant error line out of STM32_Programmer_CLI output. */
function extractFlashError(output: string): string {
  for (const line of output.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // CubeProgrammer prefixes failures with "Error:" and connection issues
    // with "No STM32 target found" / "Error: No debug probe detected".
    if (/^Error\b/i.test(trimmed) || /error:/i.test(trimmed) ||
        /no (stm32 target|debug probe|device)/i.test(trimmed) || /failed/i.test(trimmed)) {
      return trimmed;
    }
  }
  return "Flash failed. Check output for details.";
}
