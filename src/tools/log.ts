import { execSync } from "child_process";
import fs from "fs";
import { BIN_EXE, CROSSPAD_PC_ROOT } from "../config.js";

export interface LogResult {
  success: boolean;
  exe_path: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_seconds: number;
  truncated: boolean;
}

/**
 * Launch main.exe, capture stdout/stderr for up to `timeout_seconds`,
 * then kill the process and return the output.
 * Useful for checking init sequence, error messages, crash logs.
 */
export function crosspadLog(timeoutSeconds: number = 5, maxLines: number = 200): LogResult {
  if (!fs.existsSync(BIN_EXE)) {
    return {
      success: false,
      exe_path: BIN_EXE,
      stdout: "",
      stderr: "bin/main.exe not found — build first",
      exit_code: null,
      duration_seconds: 0,
      truncated: false,
    };
  }

  const start = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let truncated = false;

  try {
    // Run with timeout — process will be killed after timeout
    const output = execSync(`"${BIN_EXE}"`, {
      cwd: CROSSPAD_PC_ROOT,
      encoding: "utf-8",
      timeout: timeoutSeconds * 1000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    stdout = output;
    exitCode = 0;
  } catch (err: any) {
    // Timeout or crash — both give us output
    stdout = err.stdout?.toString() ?? "";
    stderr = err.stderr?.toString() ?? "";
    exitCode = err.status ?? null;

    // If it was a timeout (SIGTERM), that's expected
    if (err.killed || err.signal === "SIGTERM") {
      exitCode = null; // Expected termination
    }
  }

  const duration = (Date.now() - start) / 1000;

  // Truncate to maxLines
  const stdoutLines = stdout.split("\n");
  if (stdoutLines.length > maxLines) {
    stdout = stdoutLines.slice(0, maxLines).join("\n");
    truncated = true;
  }

  const stderrLines = stderr.split("\n");
  if (stderrLines.length > maxLines) {
    stderr = stderrLines.slice(0, maxLines).join("\n");
    truncated = true;
  }

  return {
    success: exitCode === 0 || exitCode === null, // null = timeout (expected)
    exe_path: BIN_EXE,
    stdout,
    stderr,
    exit_code: exitCode,
    duration_seconds: Math.round(duration * 10) / 10,
    truncated,
  };
}
