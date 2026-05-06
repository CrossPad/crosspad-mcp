import fs from "fs";
import path from "path";
import { CROSSPAD_PC_ROOT, BUILD_DIR, BIN_EXE, VCPKG_TOOLCHAIN } from "../config.js";
import { runBuild, runBuildStream, spawnDetached, OnLine } from "../utils/exec.js";
import { isSimulatorRunning } from "../utils/remote-client.js";

export interface BuildResult {
  success: boolean;
  duration_seconds: number;
  errors: string[];
  warnings_count: number;
  output_path: string;
}

/**
 * Match real compiler / linker / build-system errors only. Keyword-only
 * matching ("any line containing 'error'") is too greedy — it picks up
 * comments like `// error handling` from cmake output and inflates the
 * error list.
 *
 * Patterns: GCC/Clang/MSVC compiler diagnostics, linker errors, CMake
 * Errors, Ninja FAILED markers.
 *
 * @internal exported for testing
 */
export function parseErrors(output: string): string[] {
  const errors: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // GCC/Clang: foo.cpp:10:5: error: ...   (also "fatal error:")
    if (/:\d+:\d+:\s*(?:fatal\s+)?error\s*:/i.test(line)) { errors.push(line); continue; }
    // MSVC: foo.cpp(10,5): error C1234: ...
    if (/\(\d+(?:,\d+)?\):\s*(?:fatal\s+)?error\s+[A-Z]\d+\s*:/i.test(line)) { errors.push(line); continue; }
    // Linker
    if (/undefined reference to /.test(line)) { errors.push(line); continue; }
    if (/^.*ld(?:\.exe)?\s*:\s*error\s*:/i.test(line)) { errors.push(line); continue; }
    if (/LNK\d+:\s*error\b/i.test(line)) { errors.push(line); continue; }
    // CMake
    if (/^CMake Error\b/i.test(line)) { errors.push(line); continue; }
    // Ninja
    if (/^FAILED:\s/.test(line)) { errors.push(line); continue; }
  }
  return errors.slice(0, 20);
}

/**
 * Count compiler warnings only — same tightening logic as parseErrors.
 * @internal exported for testing
 */
export function countWarnings(output: string): number {
  let count = 0;
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/:\d+:\d+:\s*warning\s*:/i.test(line)) { count++; continue; }
    if (/\(\d+(?:,\d+)?\):\s*warning\s+[A-Z]\d+\s*:/i.test(line)) { count++; continue; }
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
      const configResult = await runBuildStream(configCmd, CROSSPAD_PC_ROOT, onLine, 600_000);
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
      const configResult = runBuild(configCmd, CROSSPAD_PC_ROOT, 600_000);
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
    const buildResult = await runBuildStream("cmake --build build", CROSSPAD_PC_ROOT, onLine, 600_000);
    buildStdout = buildResult.stdout;
    buildStderr = buildResult.stderr;
    buildSuccess = buildResult.success;
  } else {
    const buildResult = runBuild("cmake --build build", CROSSPAD_PC_ROOT, 600_000);
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
  already_running?: boolean;
  responsive?: boolean;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Launch the simulator binary in the background.
 *
 * Refuses to spawn a second instance if one is already responding on the
 * remote-control port — multiple instances clobber each other's window
 * state and the TCP listener binds to the same port.
 *
 * After spawn we poll the TCP control port for up to ~3s — this distinguishes
 * "process started, ready to accept commands" from "process started but
 * crashed before binding" so callers don't fire screenshot/stats too early.
 */
export async function crosspadRun(force: boolean = false): Promise<RunResult> {
  if (!fs.existsSync(BIN_EXE)) {
    return { pid: null, exe_path: BIN_EXE };
  }

  if (!force && (await isSimulatorRunning())) {
    return {
      pid: null,
      exe_path: BIN_EXE,
      already_running: true,
      error: "Simulator already running on port 19840. Pass force=true to spawn another instance anyway.",
    };
  }

  const pid = spawnDetached(BIN_EXE, [], CROSSPAD_PC_ROOT);
  if (pid === null) return { pid, exe_path: BIN_EXE };

  // Poll for TCP readiness so callers know if the sim actually came up.
  let responsive = false;
  for (let i = 0; i < 6; i++) {
    await delay(500);
    if (await isSimulatorRunning()) { responsive = true; break; }
  }

  return { pid, exe_path: BIN_EXE, responsive };
}

export interface KillResult {
  success: boolean;
  killed_pids: number[];
  was_running: boolean;
  error?: string;
}

/**
 * Kill the running PC simulator. Tries the TCP control port first (clean
 * shutdown via "quit" command), falls back to SIGTERM by exe path match.
 */
export async function crosspadKill(): Promise<KillResult> {
  const wasRunning = await isSimulatorRunning();
  const killedPids: number[] = [];

  if (!wasRunning) {
    return { success: true, killed_pids: [], was_running: false };
  }

  // Find PIDs by exe path. Avoid pgrep -f matching arbitrary substrings.
  // pgrep -x matches the basename only, which is fine for our binary.
  let stdout = "";
  try {
    const r = require("child_process").spawnSync("pgrep", ["-x", "CrossPad"], {
      encoding: "utf-8", timeout: 5000,
    });
    stdout = (r.stdout as string) || "";
  } catch {
    // pgrep not available
  }

  for (const line of stdout.split("\n")) {
    const pid = parseInt(line.trim(), 10);
    if (!Number.isFinite(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
      killedPids.push(pid);
    } catch {
      // Already dead or no perms — ignore
    }
  }

  // Give the sim a moment to exit, then verify
  await delay(800);
  const stillRunning = await isSimulatorRunning();

  return {
    success: !stillRunning,
    killed_pids: killedPids,
    was_running: true,
    error: stillRunning ? "Simulator still responding after SIGTERM. May need manual kill -9." : undefined,
  };
}
