import fs from "fs";
import path from "path";
import { CROSSPAD_PC_ROOT, BUILD_DIR, BIN_EXE, VCPKG_TOOLCHAIN } from "../config.js";
import { runWithMsvc, runWithMsvcStream, spawnDetached, OnLine } from "../utils/exec.js";

export interface BuildResult {
  success: boolean;
  duration_seconds: number;
  errors: string[];
  warnings_count: number;
  output_path: string;
}

function parseErrors(output: string): string[] {
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    if (/\berror\b/i.test(line) && !line.includes("error(s)")) {
      errors.push(line.trim());
    }
  }
  return errors.slice(0, 20); // Cap at 20 errors
}

function countWarnings(output: string): number {
  let count = 0;
  for (const line of output.split("\n")) {
    if (/\bwarning\b/i.test(line) && !line.includes("warning(s)")) {
      count++;
    }
  }
  return count;
}

export async function crosspadBuild(
  mode: "incremental" | "clean" | "reconfigure",
  onLine?: OnLine
): Promise<BuildResult> {
  const startTime = Date.now();

  // Clean: remove build dir
  if (mode === "clean" && fs.existsSync(BUILD_DIR)) {
    onLine?.("stdout", "[crosspad] Cleaning build directory...");
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  }

  // Configure if clean or reconfigure
  if (mode === "clean" || mode === "reconfigure") {
    const configCmd = [
      "cmake -B build -G Ninja",
      `-DCMAKE_TOOLCHAIN_FILE=${VCPKG_TOOLCHAIN}`,
      "-DCMAKE_BUILD_TYPE=Debug",
    ].join(" ");

    onLine?.("stdout", `[crosspad] Configuring: ${mode}...`);

    if (onLine) {
      const configResult = await runWithMsvcStream(configCmd, CROSSPAD_PC_ROOT, onLine, 600_000);
      if (!configResult.success) {
        const combined = configResult.stdout + "\n" + configResult.stderr;
        return {
          success: false,
          duration_seconds: (Date.now() - startTime) / 1000,
          errors: parseErrors(combined),
          warnings_count: countWarnings(combined),
          output_path: BIN_EXE,
        };
      }
    } else {
      const configResult = runWithMsvc(configCmd, CROSSPAD_PC_ROOT, 600_000);
      if (!configResult.success) {
        const combined = configResult.stdout + "\n" + configResult.stderr;
        return {
          success: false,
          duration_seconds: (Date.now() - startTime) / 1000,
          errors: parseErrors(combined),
          warnings_count: countWarnings(combined),
          output_path: BIN_EXE,
        };
      }
    }
  }

  // Build
  onLine?.("stdout", "[crosspad] Building...");

  let buildStdout: string;
  let buildStderr: string;
  let buildSuccess: boolean;

  if (onLine) {
    const buildResult = await runWithMsvcStream("cmake --build build", CROSSPAD_PC_ROOT, onLine, 600_000);
    buildStdout = buildResult.stdout;
    buildStderr = buildResult.stderr;
    buildSuccess = buildResult.success;
  } else {
    const buildResult = runWithMsvc("cmake --build build", CROSSPAD_PC_ROOT, 600_000);
    buildStdout = buildResult.stdout;
    buildStderr = buildResult.stderr;
    buildSuccess = buildResult.success;
  }

  const combined = buildStdout + "\n" + buildStderr;
  const result: BuildResult = {
    success: buildSuccess,
    duration_seconds: (Date.now() - startTime) / 1000,
    errors: parseErrors(combined),
    warnings_count: countWarnings(combined),
    output_path: BIN_EXE,
  };

  onLine?.("stdout", `[crosspad] Build ${result.success ? "succeeded" : "FAILED"} in ${result.duration_seconds.toFixed(1)}s`);

  return result;
}

export interface RunResult {
  pid: number | null;
  exe_path: string;
}

export function crosspadRun(): RunResult {
  if (!fs.existsSync(BIN_EXE)) {
    return { pid: null, exe_path: BIN_EXE };
  }

  const pid = spawnDetached(BIN_EXE, [], CROSSPAD_PC_ROOT);
  return { pid, exe_path: BIN_EXE };
}
