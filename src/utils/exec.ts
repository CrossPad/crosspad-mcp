import { execSync, spawn, SpawnOptions } from "child_process";
import { VCVARSALL } from "../config.js";

let cachedMsvcEnv: Record<string, string> | null = null;

/**
 * Capture MSVC environment by running vcvarsall.bat and parsing `set` output.
 * Cached for the lifetime of the server process.
 */
export function getMsvcEnv(): Record<string, string> {
  if (cachedMsvcEnv) return cachedMsvcEnv;

  const cmd = `"${VCVARSALL}" x64 >nul 2>&1 && set`;
  const output = execSync(cmd, {
    shell: "cmd.exe",
    encoding: "utf-8",
    timeout: 30_000,
  });

  const env: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      env[line.slice(0, eq)] = line.slice(eq + 1).trimEnd();
    }
  }

  cachedMsvcEnv = env;
  return env;
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Run a command with the MSVC environment, capturing output.
 */
export function runWithMsvc(
  cmd: string,
  cwd: string,
  timeoutMs = 300_000
): ExecResult {
  const env = getMsvcEnv();
  const start = Date.now();

  try {
    const stdout = execSync(cmd, {
      cwd,
      env,
      shell: "cmd.exe",
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      success: true,
      stdout: normalizeLineEndings(stdout),
      stderr: "",
      exitCode: 0,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      stdout: normalizeLineEndings(err.stdout?.toString() ?? ""),
      stderr: normalizeLineEndings(err.stderr?.toString() ?? ""),
      exitCode: err.status ?? 1,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Run a command in the default shell, capturing output.
 */
export function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs = 60_000
): ExecResult {
  const start = Date.now();
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      success: true,
      stdout: normalizeLineEndings(stdout),
      stderr: "",
      exitCode: 0,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      stdout: normalizeLineEndings(err.stdout?.toString() ?? ""),
      stderr: normalizeLineEndings(err.stderr?.toString() ?? ""),
      exitCode: err.status ?? 1,
      durationMs: Date.now() - start,
    };
  }
}

/** Strip \r from Windows line endings */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Spawn a detached process (for crosspad_run).
 */
export function spawnDetached(
  exe: string,
  args: string[],
  cwd: string
): number | null {
  const opts: SpawnOptions = {
    cwd,
    detached: true,
    stdio: "ignore",
  };
  const child = spawn(exe, args, opts);
  child.unref();
  return child.pid ?? null;
}
