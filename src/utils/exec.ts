import { execSync, spawn, SpawnOptions } from "child_process";
import { VCVARSALL, IS_WINDOWS, IDF_PATH } from "../config.js";

/** Callback invoked for each line of stdout/stderr during streaming exec. */
export type OnLine = (stream: "stdout" | "stderr", line: string) => void;

// ═══════════════════════════════════════════════════════════════════════
// MSVC ENVIRONMENT (Windows-only)
// ═══════════════════════════════════════════════════════════════════════

let cachedMsvcEnv: Record<string, string> | null = null;

/**
 * Capture MSVC environment by running vcvarsall.bat and parsing `set` output.
 * Cached for the lifetime of the server process. Windows-only.
 */
export function getMsvcEnv(): Record<string, string> {
  if (!IS_WINDOWS) {
    return { ...process.env } as Record<string, string>;
  }
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

// ═══════════════════════════════════════════════════════════════════════
// COMMON TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run a command with the MSVC environment, capturing output. Windows-only.
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

// ═══════════════════════════════════════════════════════════════════════
// STREAMING VARIANTS (spawn-based, line-by-line callbacks)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Helper: spawn a process and stream stdout/stderr line-by-line via onLine.
 * Returns the same ExecResult as the sync variants.
 */
function spawnStreaming(
  cmd: string,
  cwd: string,
  env: Record<string, string> | undefined,
  shell: string | boolean,
  onLine: OnLine,
  timeoutMs: number
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, [], {
      cwd,
      env,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuf = "";
    let stderrBuf = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    function flushLines(buf: string, stream: "stdout" | "stderr"): string {
      const parts = buf.split("\n");
      for (let i = 0; i < parts.length - 1; i++) {
        const line = parts[i].replace(/\r$/, "");
        onLine(stream, line);
      }
      return parts[parts.length - 1];
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      stdoutBuf += text;
      stdoutBuf = flushLines(stdoutBuf, "stdout");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      stderrBuf += text;
      stderrBuf = flushLines(stderrBuf, "stderr");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutBuf.length > 0) onLine("stdout", stdoutBuf.replace(/\r$/, ""));
      if (stderrBuf.length > 0) onLine("stderr", stderrBuf.replace(/\r$/, ""));

      resolve({
        success: killed ? false : code === 0,
        stdout: normalizeLineEndings(stdout),
        stderr: normalizeLineEndings(stderr),
        exitCode: killed ? -1 : (code ?? 1),
        durationMs: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        stdout: normalizeLineEndings(stdout),
        stderr: normalizeLineEndings(stderr + "\n" + err.message),
        exitCode: 1,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Run a command with the MSVC environment, streaming output line-by-line.
 */
export function runWithMsvcStream(
  cmd: string,
  cwd: string,
  onLine: OnLine,
  timeoutMs = 300_000
): Promise<ExecResult> {
  const env = getMsvcEnv();
  return spawnStreaming(cmd, cwd, env, "cmd.exe", onLine, timeoutMs);
}

/**
 * Run a command in the default shell, streaming output line-by-line.
 */
export function runCommandStream(
  cmd: string,
  cwd: string,
  onLine: OnLine,
  timeoutMs = 60_000
): Promise<ExecResult> {
  return spawnStreaming(cmd, cwd, undefined, true, onLine, timeoutMs);
}

// ═══════════════════════════════════════════════════════════════════════
// ESP-IDF ENVIRONMENT
// ═══════════════════════════════════════════════════════════════════════

let cachedIdfEnv: Record<string, string> | null = null;

/**
 * Capture ESP-IDF environment. Cached for the lifetime of the server process.
 * - Windows: runs export.bat and parses `set` output
 * - Linux/Mac: sources export.sh and captures env via null-delimited output
 */
export function getIdfEnv(): Record<string, string> {
  if (cachedIdfEnv) return cachedIdfEnv;

  if (IS_WINDOWS) {
    const exportBat = `${IDF_PATH}\\export.bat`;
    const cmd = `set MSYSTEM=&& set PYTHONIOENCODING=utf-8&& call "${exportBat}" >nul 2>&1 && set`;
    const output = execSync(cmd, {
      shell: "cmd.exe",
      encoding: "utf-8",
      timeout: 60_000,
    });

    const env: Record<string, string> = {};
    for (const line of output.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.slice(0, eq)] = line.slice(eq + 1).trimEnd();
      }
    }
    cachedIdfEnv = env;
    return env;
  }

  // Linux/Mac: source export.sh and capture environment
  const exportSh = `${IDF_PATH}/export.sh`;
  const cmd = `bash -c '. "${exportSh}" >/dev/null 2>&1 && env -0'`;
  const output = execSync(cmd, {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, IDF_PATH },
  });

  const env: Record<string, string> = {};
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq > 0) {
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }

  cachedIdfEnv = env;
  return env;
}

const IDF_SHELL = IS_WINDOWS ? "cmd.exe" : "/bin/bash";

/**
 * Run a command with the ESP-IDF environment, capturing output.
 */
export function runWithIdf(
  cmd: string,
  cwd: string,
  timeoutMs = 600_000
): ExecResult {
  const env = getIdfEnv();
  const start = Date.now();

  try {
    const stdout = execSync(cmd, {
      cwd,
      env,
      shell: IDF_SHELL,
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
 * Run a command with the ESP-IDF environment, streaming output line-by-line.
 */
export function runWithIdfStream(
  cmd: string,
  cwd: string,
  onLine: OnLine,
  timeoutMs = 600_000
): Promise<ExecResult> {
  const env = getIdfEnv();
  return spawnStreaming(cmd, cwd, env, IDF_SHELL, onLine, timeoutMs);
}

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM-AGNOSTIC BUILD WRAPPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run a build command with the appropriate environment for the current platform.
 * Windows: MSVC env + cmd.exe shell. Unix: default shell.
 */
export function runBuild(
  cmd: string,
  cwd: string,
  timeoutMs = 300_000
): ExecResult {
  if (IS_WINDOWS) {
    return runWithMsvc(cmd, cwd, timeoutMs);
  }
  return runCommand(cmd, cwd, timeoutMs);
}

/**
 * Run a build command with streaming output, platform-aware.
 * Windows: MSVC env + cmd.exe shell. Unix: default shell.
 */
export function runBuildStream(
  cmd: string,
  cwd: string,
  onLine: OnLine,
  timeoutMs = 300_000
): Promise<ExecResult> {
  if (IS_WINDOWS) {
    return runWithMsvcStream(cmd, cwd, onLine, timeoutMs);
  }
  return runCommandStream(cmd, cwd, onLine, timeoutMs);
}

/**
 * Run a command with the ESP-IDF environment, platform-aware.
 */
export function runIdf(
  cmd: string,
  cwd: string,
  timeoutMs = 600_000
): ExecResult {
  return runWithIdf(cmd, cwd, timeoutMs);
}

/**
 * Run a command with the ESP-IDF environment, streaming, platform-aware.
 */
export function runIdfStream(
  cmd: string,
  cwd: string,
  onLine: OnLine,
  timeoutMs = 600_000
): Promise<ExecResult> {
  return runWithIdfStream(cmd, cwd, onLine, timeoutMs);
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
