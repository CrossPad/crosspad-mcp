// src/tools/trace-launcher.ts — `crosspad-trace`: the SWD tracer and its
// dashboard from a terminal, built from trace-doctor, trace-session and
// trace-webui.
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { WebSocket } from "ws";
import { setTimeout as delay } from "timers/promises";
import type { Frame, SessionOpts } from "./trace-session.js";
import { buildUiUrl } from "./trace-webui.js";
import { HilError } from "../hil/daemon.js";
import { BENCH_BUSY } from "./bench.js";
import type { DoctorIssue, DoctorResult } from "./trace-doctor.js";
import { userConfigPath } from "../utils/userConfig.js";

export const EXIT_OK = 0;
export const EXIT_TRACE_FAILED = 1;
export const EXIT_ENVIRONMENT = 2;

export const DEFAULT_DASHBOARD_PORT = 7373;
/** Battery millivolts and the sixteen pad pressures (reg_map.h REG_IN_PAD_SUM_BASE):
 *  in every r20 Debug ELF, and pressing a pad shows the whole chain is live. */
export const DEFAULT_SIGNALS: readonly string[] = ["s_vbat_mv", "s_inputs[3:19]"];
/** As fast as the probe allows — the MCP tool's `start` default. */
export const TRACE_RATE_HZ = 0;
/** The dashboard greets every WebSocket client on connect; loopback needs far less. */
export const PROBE_TIMEOUT_MS = 1000;
const MAX_TCP_PORT = 65535;

/** Doctor issues the user fixes in their setup (venv, ELF path), not at the probe. */
const ENVIRONMENT_ISSUES = new Set(["pyocd_missing", "elf_missing"]);

/** skills/ ships in the npm package next to dist/, so this holds from src/ and dist/. */
export const SETUP_VENV_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "swd-tracer", "scripts", "setup-venv.sh",
);

export interface TraceCliOptions { signals: string[]; port: number; open: boolean; }

export type ParsedArgs =
  | { kind: "run"; opts: TraceCliOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const USAGE = [
  "Usage: crosspad-trace [--signals <spec,...>] [--port <n>] [--no-open]",
  "",
  "Traces STM32 firmware variables over the ST-Link and opens the live dashboard.",
  "If a tracer dashboard already answers on the port, opens that one and starts",
  "nothing (--signals is then ignored). Ctrl+C stops the trace.",
  "",
  `  --signals  comma-separated signal specs (default: ${DEFAULT_SIGNALS.join(",")})`,
  `  --port     dashboard port (default: ${DEFAULT_DASHBOARD_PORT})`,
  "  --no-open  print the dashboard URL, do not open a browser",
  "",
  `Exit: ${EXIT_OK} ok or stopped, ${EXIT_TRACE_FAILED} no ST-Link or the trace failed,`,
  `      ${EXIT_ENVIRONMENT} setup (pyOCD venv, ELF, port taken, bad flag, bench busy).`,
].join("\n");

export function parseTraceCliArgs(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        signals: { type: "string" },
        port: { type: "string" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  const { values } = parsed;
  if (values.help) return { kind: "help" };

  const signals = values.signals === undefined
    ? [...DEFAULT_SIGNALS]
    : values.signals.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (signals.length === 0) return { kind: "error", message: "--signals needs at least one signal spec" };

  const port = values.port === undefined ? DEFAULT_DASHBOARD_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > MAX_TCP_PORT) {
    return { kind: "error", message: `--port must be an integer 1..${MAX_TCP_PORT}, got "${values.port}"` };
  }
  return { kind: "run", opts: { signals, port, open: !values["no-open"] } };
}

export interface DashboardHello { active: boolean; signals: string[]; }

export function parseHello(raw: string): DashboardHello | null {
  try {
    const m = JSON.parse(raw);
    if (!m || m.type !== "hello") return null;
    const signals = Array.isArray(m.signals)
      ? m.signals.filter((s: unknown): s is string => typeof s === "string")
      : [];
    return { active: m.active === true, signals };
  } catch {
    return null;
  }
}

/** Is the tracer dashboard serving `port` on loopback? It greets every WebSocket
 *  client with {type:"hello"}, which nothing else on the port sends. */
export function probeDashboard(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<DashboardHello | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const finish = (hello: DashboardHello | null): void => {
      clearTimeout(timer);
      ws.removeAllListeners();
      // terminate() on a socket still connecting emits 'error'; with no
      // listener the EventEmitter would throw it.
      ws.on("error", () => {});
      ws.terminate();
      resolve(hello);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    ws.on("message", (data) => finish(parseHello(data.toString())));
    ws.on("error", () => finish(null));
    ws.on("close", () => finish(null));
  });
}

export function isBlocking(issue: DoctorIssue): boolean {
  return issue.severity === "blocking" || issue.severity === "error";
}

export function doctorExitCode(r: DoctorResult): number {
  if (r.ok) return EXIT_OK;
  return r.issues.some((i) => isBlocking(i) && ENVIRONMENT_ISSUES.has(i.id)) ? EXIT_ENVIRONMENT : EXIT_TRACE_FAILED;
}

export function formatDoctorVerdict(r: DoctorResult): string[] {
  const lines = [r.ok ? "Tracer doctor: ready." : "Tracer doctor: not ready."];
  for (const issue of r.issues) {
    if (issue.severity === "info") continue;
    lines.push(`  [${issue.severity}] ${issue.id}: ${issue.detail}`);
    lines.push(`    fix: ${issue.suggested_fix}`);
    if (issue.id === "pyocd_missing") {
      lines.push(`    venv: bash ${SETUP_VENV_SCRIPT}, then set "pyocd_python" in ${userConfigPath()} (or CROSSPAD_TRACE_PYTHON)`);
    }
    if (issue.id === "elf_missing") {
      lines.push(`    config: "stm_elf_path" in ${userConfigPath()} (or CROSSPAD_STM_ELF)`);
    }
  }
  return lines;
}

/** Same first-frame wait as the MCP `start`; past it the daemon is reported as still connecting. */
export const FIRST_FRAME_WAIT_MS = 3000;
/** Ctrl+C in a terminal reaches the daemon too (same process group), and its exit
 *  can be handled before this process's own SIGINT. */
export const EXIT_RACE_GRACE_MS = 100;
const STDERR_TAIL_LINES = 5;
const NO_BROWSER_NOTE = "No browser opened (headless, or CROSSPAD_TRACE_NO_BROWSER is set): open the URL yourself.";
const READY_LINE = "Ctrl+C stops the trace.";

/** crosspad-hil's own CLI reads the holder from the same variable. */
export const BENCH_HOLDER_ENV = "CROSSPAD_BENCH_HOLDER";
export const DEFAULT_BENCH_HOLDER = "crosspad-trace";
/** What the lease holder sees in the refusal and the board's history. */
export const BENCH_OP = "crosspad-trace start";
const SECONDS_PER_MINUTE = 60;

export function benchHolder(env: NodeJS.ProcessEnv): string {
  const fromEnv = env[BENCH_HOLDER_ENV]?.trim();
  return fromEnv ? fromEnv : DEFAULT_BENCH_HOLDER;
}

/** A bench refusal in plain text: crosspad-hil puts the lease in `details`. */
export function formatBenchRefusal(e: HilError): string[] {
  const hint = e.hint ? [`  hint: ${e.hint}`] : [];
  if (e.code !== BENCH_BUSY) return [`Bench check failed: ${e.code}: ${e.message}`, ...hint];
  const { holder, purpose, expires_in_s: expiresInS, queue } = e.details;
  const lines = [`Bench busy: ${e.message}`];
  if (typeof holder === "string") lines.push(`  holder: ${holder}`);
  if (typeof purpose === "string" && purpose) lines.push(`  purpose: ${purpose}`);
  if (typeof expiresInS === "number") {
    lines.push(`  expires in: ${Math.max(0, Math.round(expiresInS / SECONDS_PER_MINUTE))} min`);
  }
  const waiting = Array.isArray(queue) ? queue.filter((q): q is string => typeof q === "string") : [];
  lines.push(`  queue: ${waiting.length > 0 ? waiting.join(", ") : "empty"}`);
  return [...lines, ...hint];
}

/** The part of TraceSession this command drives. */
export interface TraceRun {
  start(): void;
  waitForFirstFrame(timeoutMs?: number): Promise<Frame | null>;
  stop(): void;
  onStopped(cb: () => void): void;
  isRunning(): boolean;
  stderrTail(n?: number): string;
  readonly deviceState: string;
  readonly filePath: string | null;
}

/** The part of Dashboard this command drives. */
export interface DashboardLike<S> {
  ensureStarted(port: number): Promise<string>;
  bind(session: S): void;
  unbind(): void;
}

export interface StopSignal {
  readonly requested: boolean;
  readonly promise: Promise<void>;
}

export interface TraceCliDeps<S extends TraceRun> {
  probeDashboard(port: number): Promise<DashboardHello | null>;
  /** Resolves when `holder` may trace the board; throws HilError when not. */
  benchCheck(holder: string): Promise<void>;
  runDoctor(): Promise<DoctorResult>;
  dashboard: DashboardLike<S>;
  createSession(opts: SessionOpts): S;
  openBrowser(url: string): boolean;
  stop: StopSignal;
  out(line: string): void;
  err(line: string): void;
}

export async function runTraceCli<S extends TraceRun>(argv: string[], deps: TraceCliDeps<S>): Promise<number> {
  const parsed = parseTraceCliArgs(argv);
  if (parsed.kind === "help") {
    deps.out(USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === "error") {
    deps.err(parsed.message);
    deps.err(USAGE);
    return EXIT_ENVIRONMENT;
  }
  const { opts } = parsed;

  // An idle dashboard (a Claude session that traced once and stopped keeps
  // its own up) has no probe: trace beside it on a port of our own.
  let port = opts.port;
  const running = await deps.probeDashboard(port);
  if (running?.active) return attach(opts, running, deps);
  if (running) port = idleDashboardPort(opts.port, deps);

  // Listening before the bench check and the doctor makes the port the lock a
  // second instance sees during the seconds they take.
  let url: string;
  try {
    url = await deps.dashboard.ensureStarted(port);
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    if (error.code === "EADDRINUSE") {
      const winner = await deps.probeDashboard(port);
      if (winner?.active) return attach(opts, winner, deps);
      if (winner) {
        port = idleDashboardPort(opts.port, deps);
        url = await deps.dashboard.ensureStarted(port);
      } else {
        deps.err(`Port ${port} is taken by a program that is not the tracer dashboard. Stop it or pass --port.`);
        return EXIT_ENVIRONMENT;
      }
    } else {
      deps.err(`Cannot serve the dashboard on port ${port}: ${error.message}`);
      return EXIT_ENVIRONMENT;
    }
  }

  // The ST-Link is outside the crosspad-hil daemon, so the lease is asked here,
  // as crosspad_trace start does: another session may be mid-test or mid-DFU.
  try {
    await deps.benchCheck(benchHolder(process.env));
  } catch (e) {
    if (!(e instanceof HilError)) throw e;
    for (const line of formatBenchRefusal(e)) deps.err(line);
    return EXIT_ENVIRONMENT;
  }

  const doctor = await deps.runDoctor();
  const verdict = formatDoctorVerdict(doctor);
  if (!doctor.ok) {
    // A terminal's Ctrl+C reaches the doctor's own children too: a check it
    // killed is the user stopping, not a missing venv.
    if (await stoppedMeanwhile(deps)) return EXIT_OK;
    for (const line of verdict) deps.err(line);
    return doctorExitCode(doctor);
  }
  for (const line of verdict) deps.out(line);
  if (deps.stop.requested) return EXIT_OK;

  let session: S;
  try {
    session = deps.createSession({ signals: opts.signals, rateHz: TRACE_RATE_HZ });
    session.start();
  } catch (e) {
    deps.err(`Cannot start the trace daemon: ${(e as Error).message}`);
    return EXIT_ENVIRONMENT;
  }
  deps.dashboard.bind(session);
  const stopped = new Promise<void>((resolve) => session.onStopped(resolve));

  const first = await Promise.race([
    session.waitForFirstFrame(FIRST_FRAME_WAIT_MS),
    deps.stop.promise.then((): typeof STOPPED => STOPPED),
  ]);
  if (first === STOPPED || ((first === null || first.type === "error") && await stoppedMeanwhile(deps))) {
    return stopTrace(session, stopped, deps);
  }
  if (first?.type === "error") {
    deps.err(`Trace connect failed: ${first.error}`);
    return failTrace(session, stopped, deps);
  }
  if (!first && !session.isRunning()) {
    deps.err(`Trace daemon exited before producing data (${session.deviceState}).`);
    return failTrace(session, stopped, deps);
  }

  deps.out(first
    ? `Tracing ${opts.signals.join(", ")}.`
    : "Trace daemon still connecting; the dashboard shows it when data arrives.");
  deps.out(`Dashboard: ${url}`);
  if (opts.open && !deps.openBrowser(url)) deps.out(NO_BROWSER_NOTE);
  deps.out(READY_LINE);

  const ended = await Promise.race([
    deps.stop.promise.then(() => "stop" as const),
    stopped.then(() => "exited" as const),
  ]);
  if (ended === "exited") await delay(EXIT_RACE_GRACE_MS);

  if (deps.stop.requested) return stopTrace(session, stopped, deps);
  deps.dashboard.unbind();
  deps.err(`Trace ended on its own: ${session.deviceState}`);
  printTail(session, deps);
  return EXIT_TRACE_FAILED;
}

function attach<S extends TraceRun>(opts: TraceCliOptions, hello: DashboardHello, deps: TraceCliDeps<S>): number {
  const url = buildUiUrl(opts.port);
  deps.out(`Tracer dashboard already running at ${url}; no second pyOCD started.`);
  deps.out(hello.active
    ? `It is tracing ${hello.signals.join(", ")}.`
    : "It has no trace running: start one from the process that owns it, or stop that process and run crosspad-trace again.");
  if (opts.open && !deps.openBrowser(url)) deps.out(NO_BROWSER_NOTE);
  return EXIT_OK;
}

const STOPPED: unique symbol = Symbol("stopped");

/** A failure that came with a stop request is the stop; the grace lets a signal
 *  that killed a child arrive before the child's death is judged. */
async function stoppedMeanwhile<S extends TraceRun>(deps: TraceCliDeps<S>): Promise<boolean> {
  if (!deps.stop.requested) await delay(EXIT_RACE_GRACE_MS);
  return deps.stop.requested;
}

function idleDashboardPort<S extends TraceRun>(asked: number, deps: TraceCliDeps<S>): number {
  deps.out(`The dashboard on port ${asked} is idle; tracing on a port of this run's own.`);
  return 0;
}

async function stopTrace<S extends TraceRun>(session: S, stopped: Promise<void>, deps: TraceCliDeps<S>): Promise<number> {
  deps.out("Stopping the trace...");
  session.stop();
  await stopped;
  deps.dashboard.unbind();
  deps.out(`Trace stopped. Samples: ${session.filePath ?? "none written"}`);
  return EXIT_OK;
}

async function failTrace<S extends TraceRun>(session: S, stopped: Promise<void>, deps: TraceCliDeps<S>): Promise<number> {
  printTail(session, deps);
  session.stop();
  await stopped;
  deps.dashboard.unbind();
  return EXIT_TRACE_FAILED;
}

function printTail<S extends TraceRun>(session: S, deps: TraceCliDeps<S>): void {
  const tail = session.stderrTail(STDERR_TAIL_LINES);
  if (!tail) return;
  for (const line of tail.split("\n")) deps.err(`  ${line}`);
}
