import fs from "fs";
import { BIN_EXE, CROSSPAD_PC_ROOT } from "../config.js";
import { runCommandStream, OnLine } from "../utils/exec.js";

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
 * Streams lines in real-time via onLine callback.
 */
export async function crosspadLog(
  timeoutSeconds: number = 5,
  maxLines: number = 200,
  onLine?: OnLine
): Promise<LogResult> {
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

  onLine?.("stdout", `[crosspad] Launching ${BIN_EXE} (capturing for ${timeoutSeconds}s)...`);

  const result = await runCommandStream(
    `"${BIN_EXE}"`,
    CROSSPAD_PC_ROOT,
    onLine ?? (() => {}),
    timeoutSeconds * 1000
  );

  // Truncate to maxLines
  let stdout = result.stdout;
  let stderr = result.stderr;
  let truncated = false;

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

  // exitCode -1 = killed by timeout (expected)
  const exitCode = result.exitCode === -1 ? null : result.exitCode;

  return {
    success: exitCode === 0 || exitCode === null,
    exe_path: BIN_EXE,
    stdout,
    stderr,
    exit_code: exitCode,
    duration_seconds: Math.round(result.durationMs / 100) / 10,
    truncated,
  };
}
