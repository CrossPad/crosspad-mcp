/**
 * STM32 firmware build (CrossPad r20 single-board target).
 *
 * Drives the CMake + Ninja + arm-none-eabi toolchain via CMakePresets.json:
 *   configure → `cmake --preset <Debug|Release>`  (binaryDir = build/<preset>)
 *   build     → `cmake --build build/<preset>`
 *
 * The arm-none-eabi-gcc toolchain is wired through the preset's `toolchainFile`
 * (cmake/gcc-arm-none-eabi.cmake), so no special environment is needed here —
 * unlike PC (MSVC) or IDF (export.sh). GCC diagnostics are the standard
 * `file:line:col: error:` form, so parseErrors/countWarnings from the PC build
 * apply unchanged.
 */

import fs from "fs";
import path from "path";
import { CROSSPAD_STM_ROOT, stmBuildDir, stmArtifact, StmPreset } from "../config.js";
import { runArgvStream, OnLine } from "../utils/exec.js";
import { parseErrors, countWarnings, BuildResult } from "./build.js";

/**
 * Map the unified build_type axis onto the two STM presets. The repo only
 * defines Debug and Release presets; RelWithDebInfo collapses to Release.
 * @internal exported for testing
 */
export function stmPresetFor(buildType: string): StmPreset {
  return buildType === "Release" || buildType === "RelWithDebInfo" ? "Release" : "Debug";
}

export async function crosspadStmBuild(
  mode: "incremental" | "clean" | "reconfigure",
  onLine?: OnLine,
  buildType: string = "Debug",
  signal?: AbortSignal,
): Promise<BuildResult> {
  const startTime = Date.now();
  const preset = stmPresetFor(buildType);
  const buildDir = stmBuildDir(preset);
  const elf = stmArtifact(preset, "elf");
  const emit: OnLine = onLine ?? (() => {});

  if (!fs.existsSync(CROSSPAD_STM_ROOT)) {
    return {
      success: false,
      duration_seconds: 0,
      errors: [`STM32 repo not found at ${CROSSPAD_STM_ROOT}`],
      warnings_count: 0,
      output_path: elf,
    };
  }

  // Clean: wipe the preset's build dir so the next configure is from scratch.
  if (mode === "clean" && fs.existsSync(buildDir)) {
    emit("stdout", `[stm-build] Cleaning ${buildDir}...`);
    fs.rmSync(buildDir, { recursive: true, force: true });
  }

  // Configure when explicitly asked, or implicitly when the cache is absent
  // (first build, or just-cleaned) — incremental should still bootstrap.
  const cacheExists = fs.existsSync(path.join(buildDir, "CMakeCache.txt"));
  const needConfigure = mode === "clean" || mode === "reconfigure" || !cacheExists;

  if (needConfigure) {
    emit("stdout", `[stm-build] Configuring preset ${preset}...`);
    const cfg = await runArgvStream(
      "cmake", ["--preset", preset], CROSSPAD_STM_ROOT, emit, 600_000, signal,
    );
    if (!cfg.success) {
      const combined = cfg.stdout + "\n" + cfg.stderr;
      return {
        success: false,
        duration_seconds: (Date.now() - startTime) / 1000,
        errors: parseErrors(combined),
        warnings_count: countWarnings(combined),
        output_path: elf,
      };
    }
  }

  emit("stdout", `[stm-build] Building ${preset}...`);
  const build = await runArgvStream(
    "cmake", ["--build", buildDir], CROSSPAD_STM_ROOT, emit, 600_000, signal,
  );

  const combined = build.stdout + "\n" + build.stderr;
  const result: BuildResult = {
    success: build.success,
    duration_seconds: (Date.now() - startTime) / 1000,
    errors: parseErrors(combined),
    warnings_count: countWarnings(combined),
    output_path: elf,
  };

  emit("stdout", `[stm-build] Build ${result.success ? "succeeded" : "FAILED"} in ${result.duration_seconds.toFixed(1)}s`);
  return result;
}
