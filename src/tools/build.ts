import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { CROSSPAD_PC_ROOT, BUILD_DIR, BIN_EXE, VCPKG_TOOLCHAIN } from "../config.js";
import { runBuild, runBuildStream, spawnDetached, OnLine } from "../utils/exec.js";
import { isSimulatorRunning, closeSimConnection, simPort } from "../utils/remote-client.js";
import { findPortOwnerPids } from "../utils/port-owner.js";

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

export type BuildType = "Debug" | "Release" | "RelWithDebInfo";

export async function crosspadBuild(
  mode: "incremental" | "clean" | "reconfigure",
  onLine?: OnLine,
  buildType: BuildType = "Debug",
  signal?: AbortSignal,
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
      `-DCMAKE_BUILD_TYPE=${buildType}`,
    ].join(" ");

    onLine?.("stdout", `[crosspad] Configuring: ${mode} (${buildType})...`);

    if (onLine) {
      const configResult = await runBuildStream(configCmd, CROSSPAD_PC_ROOT, onLine, 600_000, signal);
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
    const buildResult = await runBuildStream("cmake --build build", CROSSPAD_PC_ROOT, onLine, 600_000, signal);
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
  /** The control port this instance was asked to bind. */
  port?: number;
  responsive?: boolean;
  /** Where the simulator's stdout and stderr are being appended. */
  log_path?: string;
  /** Last lines of that file, filled in only when the sim failed to come up. */
  log_tail?: string[];
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** How many lines of the sim log a failed launch reports inline. */
export const RUN_LOG_TAIL_LINES = 30;

/** Where this launch's stdout/stderr goes: <crosspad-pc>/hil_logs/sim_<ts>.log */
export function simLogPath(now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  return path.join(CROSSPAD_PC_ROOT, "hil_logs", `sim_${stamp}.log`);
}

/** Last `n` non-empty lines of a log file, or [] if there is nothing to read. */
export function tailFile(file: string, n: number): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

/**
 * Is the process still there? EPERM means it is, owned by someone else.
 * @internal exported for testing
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
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
 *
 * Both streams go to a log file, and a sim that dies before answering brings
 * its last lines back with it: a failed probe on its own reports that nothing
 * answered, never that the vcpkg SDL2 was missing or the kit JSON was unreadable.
 */
export interface RunOptions {
  /** Spawn even if something already answers on the port (only useful with a different `port`). */
  force?: boolean;
  /** Control port for this instance (CROSSPAD_REMOTE_PORT). Default: the server's own env, else 19840. */
  port?: number;
  /** Open no MIDI port (CROSSPAD_NO_MIDI=1) — a scripted run must not play a real CrossPad on USB. */
  noMidi?: boolean;
}

export async function crosspadRun(opts: RunOptions | boolean = {}): Promise<RunResult> {
  const { force = false, port: portOpt, noMidi = false } = typeof opts === "boolean" ? { force: opts } : opts;
  const port = simPort(portOpt);

  if (!fs.existsSync(BIN_EXE)) {
    return { pid: null, exe_path: BIN_EXE };
  }

  if (!force && (await isSimulatorRunning(port))) {
    return {
      pid: null,
      exe_path: BIN_EXE,
      already_running: true,
      error: `Something already answers on control port ${port}. Pick another port (a second instance cannot share it), or stop that one with crosspad_kill.`,
    };
  }

  // A socket left over from a previous instance points at a process that is
  // about to be replaced.
  closeSimConnection();

  // REMOTE_REQUIRED: a simulator that cannot bind its port exits (code 3)
  // instead of running un-drivable, which the probe below then reports with
  // the log tail.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CROSSPAD_REMOTE_PORT: String(port),
    CROSSPAD_REMOTE_REQUIRED: "1",
  };
  if (noMidi) env.CROSSPAD_NO_MIDI = "1";

  const logPath = simLogPath();
  const pid = spawnDetached(BIN_EXE, [], CROSSPAD_PC_ROOT, logPath, env);
  if (pid === null) return { pid, exe_path: BIN_EXE, log_path: logPath };

  // Poll for TCP readiness so callers know if the sim actually came up. A
  // process that has already exited will never answer, so stop asking.
  let responsive = false;
  let alive = true;
  for (let i = 0; i < 6; i++) {
    await delay(500);
    if (await isSimulatorRunning(port)) { responsive = true; break; }
    if (!processAlive(pid)) { alive = false; break; }
  }

  if (responsive) return { pid, exe_path: BIN_EXE, port, responsive, log_path: logPath };

  return {
    pid,
    exe_path: BIN_EXE,
    port,
    responsive,
    log_path: logPath,
    log_tail: tailFile(logPath, RUN_LOG_TAIL_LINES),
    error: alive
      ? undefined
      : `Simulator process ${pid} exited before the control port answered (port ${port} taken by another instance? exit code 3).`,
  };
}

export interface KillResult {
  success: boolean;
  killed_pids: number[];
  was_running: boolean;
  error?: string;
}

/**
 * Canonicalize a filesystem path. realpath resolves every symlink in the
 * chain — needed because /proc/<pid>/exe always returns the kernel's view
 * (post-symlink) while BIN_EXE comes from string concatenation under
 * CROSSPAD_PC_ROOT, which is commonly itself a symlink (e.g. ~/GIT/crosspad-pc
 * → /mnt/big-disk/crosspad-pc). Without canonicalization the string compare
 * silently misses every running sim.
 *
 * Falls back to path.resolve when realpath fails (binary not built yet, or
 * a non-existent /proc path during a TOCTOU race) so callers always get a
 * comparable absolute path.
 *
 * @internal exported for testing
 */
export function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Strip the kernel's " (deleted)" suffix that appears in /proc/<pid>/exe
 * when the executable was unlinked or replaced after the process started
 * (typical during dev: rebuild while sim is still running). Without this
 * strip the path compare misses any running-but-rebuilt sim — the most
 * common reason a developer would hit "agent can't kill the simulator."
 *
 * @internal exported for testing
 */
export function stripDeletedSuffix(p: string): string {
  return p.replace(/ \(deleted\)$/, "");
}

/**
 * Find PIDs running the CrossPad simulator binary.
 *
 * On Linux scans /proc/<pid>/exe and matches the resolved+canonicalized
 * symlink against BIN_EXE. This is the only reliable identification:
 * pgrep -x compares /proc/<pid>/comm, which Qt/pthread routinely overwrite
 * via pthread_setname_np / prctl(PR_SET_NAME), so a sim launched as
 * "CrossPad" shows up under whatever Qt named the main thread last.
 * /proc/<pid>/exe is the kernel's record of the executed binary and cannot
 * be spoofed by userspace renames.
 *
 * On macOS/Windows there's no /proc, so fall back to pgrep by basename.
 * macOS suffers the same Qt comm-rename in theory but our binary name is
 * 8 chars (fits in comm's 15-char limit) and PC builds are predominantly
 * exercised on Linux, so this is documented as best-effort.
 *
 * @internal exported for testing
 */
export function findCrosspadPids(): number[] {
  if (process.platform === "linux") {
    const target = canonicalize(BIN_EXE);
    let entries: string[];
    try {
      entries = fs.readdirSync("/proc");
    } catch {
      return [];
    }
    const pids: number[] = [];
    const self = process.pid;
    for (const entry of entries) {
      // /proc has many non-pid entries (cpuinfo, self, etc.) — skip anything
      // that doesn't round-trip as an integer. Also skip our own PID; node
      // can't be CrossPad but defensive in case BIN_EXE is misconfigured to
      // /usr/bin/node during testing.
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      if (pid === self) continue;
      try {
        const raw = fs.readlinkSync(`/proc/${pid}/exe`);
        const exe = canonicalize(stripDeletedSuffix(raw));
        if (exe === target) pids.push(pid);
      } catch {
        // Process exited mid-scan, or no permission. Either is fine.
      }
    }
    return pids;
  }

  // macOS / Windows / other: pgrep by basename. Strip .exe so the same
  // binary works under wine/CI and on real Windows (where pgrep is absent
  // — spawnSync.error is caught and we return []).
  try {
    const base = path.basename(BIN_EXE).replace(/\.exe$/i, "");
    const r = spawnSync("pgrep", ["-x", base], { encoding: "utf-8", timeout: 5000 });
    return ((r.stdout as string) || "")
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

/**
 * Try to deliver a signal; returns the errno code on failure, undefined on
 * success. ESRCH is folded into success ("already dead" is the desired state).
 *
 * @internal
 */
function trySignal(pid: number, signal: NodeJS.Signals): string | undefined {
  try {
    process.kill(pid, signal);
    return undefined;
  } catch (e: any) {
    const code = e?.code as string | undefined;
    if (code === "ESRCH") return undefined; // already exited — fine
    return code ?? "EUNKNOWN";
  }
}

export interface KillOptions {
  /** Control port of the instance to stop. Default: the server's own env, else 19840. */
  port?: number;
  /** Stop this exact PID (an instance that never got its port, say). */
  pid?: number;
  /** Stop every process running the built binary, ignoring ports. */
  all?: boolean;
}

/** /proc/<pid>/exe, canonical and without the " (deleted)" suffix; null when gone. */
function exeOf(pid: number): string | null {
  try {
    return canonicalize(stripDeletedSuffix(fs.readlinkSync(`/proc/${pid}/exe`)));
  } catch {
    return null;
  }
}

/**
 * Is `pid` a CrossPad simulator? Same binary file name as the built one: a
 * test instance from a worktree runs its own copy, so the full path cannot be
 * compared, but a port held by some other program must never be signalled.
 */
function isSimProcess(pid: number): boolean {
  if (process.platform !== "linux") return true; // no /proc to ask; the port/PID came from lsof or the caller
  const exe = exeOf(pid);
  return exe !== null && path.basename(exe).replace(/\.exe$/i, "") === path.basename(BIN_EXE).replace(/\.exe$/i, "");
}

/** Still the process we meant (a recycled PID has another exe, a zombie none). */
function stillThere(pid: number): boolean {
  return process.platform === "linux" ? isSimProcess(pid) : processAlive(pid);
}

/**
 * Stop one PC simulator: the owner of the control port (default 19840, or
 * `port`), or the exact `pid`. Never "every CrossPad": a test instance and the
 * one somebody is playing are the same binary, told apart only by their port.
 * `all` is the explicit opt-in to the old sweep over every process whose
 * /proc/<pid>/exe is the built binary.
 *
 * SIGTERM, poll up to 3s for a graceful exit, SIGKILL stragglers. A process
 * that holds the port but is not a simulator is reported and left alone.
 * Per-PID kill errors (EPERM, EUNKNOWN) are aggregated and surfaced in
 * `error` so the caller sees *why* a kill didn't take.
 */
export async function crosspadKill(opts: KillOptions = {}): Promise<KillResult> {
  const port = simPort(opts.port);
  // Whatever we were talking to is the thing being killed; keeping the socket
  // would hand the next caller a half-open connection instead of a reconnect.
  closeSimConnection();

  let candidates: number[];
  if (opts.pid !== undefined) candidates = [opts.pid];
  else if (opts.all) candidates = findCrosspadPids();
  else candidates = findPortOwnerPids(port);

  const foreign = candidates.filter((pid) => !isSimProcess(pid));
  const initialPids = candidates.filter((pid) => !foreign.includes(pid));
  if (foreign.length > 0 && initialPids.length === 0) {
    return {
      success: false,
      killed_pids: [],
      was_running: true,
      error: `pid ${foreign.join(", ")} is not a CrossPad simulator (${exeOf(foreign[0]) ?? "unknown exe"}); not touching it.`,
    };
  }

  const tcpAliveInitial = opts.all || opts.pid !== undefined ? false : await isSimulatorRunning(port);
  const wasRunning = initialPids.length > 0 || tcpAliveInitial;

  if (!wasRunning) {
    return { success: true, killed_pids: [], was_running: false };
  }

  const killedPids: number[] = [];
  const failures: string[] = [];

  for (const pid of initialPids) {
    const errCode = trySignal(pid, "SIGTERM");
    if (errCode === undefined) {
      killedPids.push(pid);
    } else {
      failures.push(`SIGTERM pid=${pid} ${errCode}`);
    }
  }

  // Poll up to 3s for SIGTERM to take effect.
  const deadline = Date.now() + 3000;
  let stillAlive: number[] = initialPids;
  while (Date.now() < deadline) {
    await delay(150);
    stillAlive = initialPids.filter(stillThere);
    if (stillAlive.length === 0) {
      // Confirm the TCP port is gone too. We only pay the TCP probe in this
      // branch to avoid stretching the polling deadline: isSimulatorRunning
      // can take seconds when the sim is hung.
      if (opts.all || opts.pid !== undefined || !(await isSimulatorRunning(port))) break;
    }
  }

  // Force-kill anything that survived SIGTERM. stillThere re-checks the exe,
  // which guards against PID recycling in the gap between SIGTERM and SIGKILL.
  if (stillAlive.length > 0) {
    for (const pid of stillAlive) {
      const errCode = trySignal(pid, "SIGKILL");
      if (errCode === undefined) {
        if (!killedPids.includes(pid)) killedPids.push(pid);
      } else {
        failures.push(`SIGKILL pid=${pid} ${errCode}`);
      }
    }
    await delay(300);
  }

  const finalAlive = initialPids.filter(stillThere);
  const tcpAliveFinal = opts.all || opts.pid !== undefined ? false : await isSimulatorRunning(port);
  const stillRunning = finalAlive.length > 0 || tcpAliveFinal;

  let errorMsg: string | undefined;
  if (stillRunning) {
    const parts = [
      `Simulator still alive after SIGTERM+SIGKILL`,
      `pids=${finalAlive.join(",") || "none"}`,
      `tcp_alive=${tcpAliveFinal}`,
    ];
    if (failures.length > 0) parts.push(`failures=[${failures.join("; ")}]`);
    errorMsg = parts.join(", ") + ".";
  } else if (failures.length > 0) {
    // Sim is dead but some kill attempts errored (e.g. PID gone before our
    // SIGKILL). Worth surfacing but not a hard failure.
    errorMsg = `Sim stopped, but some signals errored: ${failures.join("; ")}.`;
  }

  return {
    success: !stillRunning,
    killed_pids: killedPids,
    was_running: true,
    error: errorMsg,
  };
}
