// src/hil/daemon.ts — proxy to `python -m crosspad_hil.serve` (NDJSON over
// stdio). Ports the spawn / newline-framing / stderr-ring / pending-id /
// stop-escalation pattern of src/tools/trace-session.ts (TraceSession).
import { spawn } from "child_process";
import type { EventEmitter } from "events";
import { resolveConfigValue } from "../utils/userConfig.js";
import { resolvedPython } from "../tools/trace-symbols.js";

// ── Errors ───────────────────────────────────────────────────────────────────

/** Mirrors crosspad_hil.errors.HilError.to_dict(): {code, message, hint, details}. */
export class HilError extends Error {
  code: string;
  hint?: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, hint?: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "HilError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
  toJSON(): { code: string; message: string; hint?: string; details: Record<string, unknown> } {
    const o: { code: string; message: string; hint?: string; details: Record<string, unknown> } = {
      code: this.code, message: this.message, details: this.details,
    };
    if (this.hint !== undefined) o.hint = this.hint;
    return o;
  }
}

/** Error codes minted on this side (the daemon's own codes pass through). */
export const DAEMON_DIED = "DAEMON_DIED";
export const DAEMON_PROTOCOL = "DAEMON_PROTOCOL";
export const TIMEOUT = "TIMEOUT";
export const CANCELLED = "CANCELLED";

// ── Events ───────────────────────────────────────────────────────────────────

export type HilEvent = { ev: string } & Record<string, unknown>;

// ── serve.stats ──────────────────────────────────────────────────────────────

/** What the daemon process is holding, counted from inside it (crosspad_hil.serve). */
export interface DaemonStats {
  version: string;
  pid: number;
  uptime_s: number;
  ops_total: number;
  handles: Record<string, number>;
  handles_total: number;
  threads: number;
  open_fds: number;
  alsa_seq_clients: number;
}

// ── Child process abstraction (so tests inject a fake) ───────────────────────

export interface ChildLike extends EventEmitter {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}
export type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildLike;

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildLike;

// ── Daemon ───────────────────────────────────────────────────────────────────

export interface HilDaemonOpts {
  python: string;
  cwd?: string;
  onEvent?: (ev: HilEvent) => void;
  /** Test seam: replaces child_process.spawn. */
  spawnFn?: SpawnFn;
  /** Test seam: the idle clock. */
  now?: () => number;
  /** Idle-sweep period, and the minimum idle before the daemon is probed. 0 disables the timer. */
  recycleCheckMs?: number;
  /** Idle after which a daemon holding nothing is stopped. */
  recycleIdleMs?: number;
  /** ALSA sequencer clients tolerated on an idle daemon before it is stopped. */
  alsaSeqBudget?: number;
}

export interface RequestOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Bookkeeping this side issued itself: does not count as activity. */
  internal?: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: HilError) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
// from trace-session.ts §11.6: STDERR_RING (30 there; 50 here per contract)
const STDERR_RING = 50;
// from trace-session.ts §11.5 stop(): {cmd:stop} → SIGTERM 1500 ms → SIGKILL 4500 ms
const TERM_AFTER_MS = 1500;
const KILL_AFTER_MS = 4500;
const STATS_TIMEOUT_MS = 5_000;

// An hours-long daemon amplifies whatever it fails to give back, so an idle one
// is stopped and request() starts a fresh one on demand. A restart is also the
// only way a newly installed scenario becomes visible.
const RECYCLE_CHECK_MS = 60_000;
const RECYCLE_IDLE_MS = 15 * 60_000;
/** ALSA's sequencer client table is ~64 for the whole machine, not per process. */
export const ALSA_SEQ_BUDGET = 24;

/** What recycleTick() decided. Only the two `stopped-*` outcomes ended a daemon. */
export type RecycleOutcome =
  | "stopped-idle" | "stopped-alsa" | "busy" | "in-use" | "fresh" | "no-daemon" | "unknown";

export class HilDaemon {
  private proc: ChildLike | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuf = "";
  private stderrBuf = "";
  private stderrLines: string[] = [];
  private starting: Promise<void> | null = null;
  private stopWaiters: Array<() => void> = [];
  private termTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private recycleTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;
  private readonly spawnFn: SpawnFn;
  /** The last automatic stop, for the doctor to report. */
  lastRecycle: { at: number; reason: "idle" | "alsa_seq"; stats: DaemonStats } | null = null;

  constructor(private readonly opts: HilDaemonOpts) {
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
  }

  get alive(): boolean { return this.proc !== null; }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }
  private get checkMs(): number { return this.opts.recycleCheckMs ?? RECYCLE_CHECK_MS; }
  private get idleMs(): number { return this.opts.recycleIdleMs ?? RECYCLE_IDLE_MS; }
  private get seqBudget(): number { return this.opts.alsaSeqBudget ?? ALSA_SEQ_BUDGET; }

  /** Last `n` daemon stderr lines, newest last (from TraceSession.stderrTail). */
  stderrTail(n: number = STDERR_RING): string {
    return this.stderrLines.slice(-n).join("\n");
  }

  /** Spawn `<python> -m crosspad_hil.serve` and wait for `serve.ping`.
   *  Idempotent: a second call while starting/alive shares the same promise. */
  start(): Promise<void> {
    if (this.proc) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.stderrLines = [];
    const child = this.spawnFn(this.opts.python, ["-m", "crosspad_hil.serve"], { cwd: this.opts.cwd });
    this.proc = child;
    child.stdout?.on("data", (c: Buffer | string) => this.ingest(c.toString()));
    child.stderr?.on("data", (c: Buffer | string) => this.ingestStderr(c.toString()));
    child.on("exit", (code: number | null) => this.onExit(code, null));
    // A bad interpreter path emits 'error' — must never bubble up as an
    // uncaught exception that crashes the MCP server (TraceSession.start).
    child.on("error", (e: Error) => this.onExit(null, e));
    await this.request<{ version: string }>("serve.ping", {}, { timeoutMs: PING_TIMEOUT_MS });
    this.lastActivityAt = this.now();
    this.startRecycleTimer();
  }

  /** serve.stats. Internal, so asking does not itself keep the daemon alive. */
  stats(opts: RequestOpts = {}): Promise<DaemonStats> {
    return this.request<DaemonStats>("serve.stats", {},
      { timeoutMs: STATS_TIMEOUT_MS, ...opts, internal: true });
  }

  /** Stop and start again. Daemon-side handles do not survive: an open console
   *  or cdc session is gone and has to be reopened. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Give an idle daemon's OS resources back. Never touches one that is working
   *  or holding a handle; request() starts a fresh daemon on demand. */
  async recycleTick(): Promise<RecycleOutcome> {
    if (!this.proc) return "no-daemon";
    if (this.pending.size > 0) return "busy";
    const idle = this.now() - this.lastActivityAt;
    if (idle < this.checkMs) return "fresh";
    let stats: DaemonStats;
    try {
      stats = await this.stats();
    } catch {
      // An older daemon has no serve.stats, and without its handle count a stop
      // could take a console session with it. Leave it; the doctor says why.
      return "unknown";
    }
    if (stats.handles_total > 0) return "in-use";
    const reason = idle >= this.idleMs ? "idle"
      : stats.alsa_seq_clients >= this.seqBudget ? "alsa_seq"
      : null;
    if (reason === null) return "fresh";
    this.lastRecycle = { at: this.now(), reason, stats };
    await this.stop();
    return reason === "idle" ? "stopped-idle" : "stopped-alsa";
  }

  private startRecycleTimer(): void {
    if (this.recycleTimer !== null || this.checkMs <= 0) return;
    const t = setInterval(() => { void this.recycleTick(); }, this.checkMs);
    (t as unknown as { unref?: () => void }).unref?.();
    this.recycleTimer = t;
  }

  private stopRecycleTimer(): void {
    if (this.recycleTimer !== null) { clearInterval(this.recycleTimer); this.recycleTimer = null; }
  }

  /** Send one op and await its correlated reply. Restarts a dead daemon first. */
  async request<T = unknown>(op: string, args: Record<string, unknown>, opts: RequestOpts = {}): Promise<T> {
    if (!this.proc) {
      if (op === "serve.ping" && this.starting) {
        // called from doStart() — fall through to the write below
      } else {
        await this.start();
      }
    }
    const proc = this.proc;
    if (!proc || !proc.stdin) {
      throw new HilError(DAEMON_DIED, "crosspad-hil daemon is not running", this.lastStderr(), { stderr_tail: this.stderrTail() });
    }
    if (opts.signal?.aborted) throw new HilError(CANCELLED, `${op} cancelled before send`);
    if (!opts.internal) this.lastActivityAt = this.now();
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: (v) => resolve(v as T),
        reject,
        timer: setTimeout(() => {
          // settle(), not delete(): the abort listener is registered below and
          // only settle() takes it off again. A long-lived signal — one task
          // driving many ops — otherwise collects a dead closure per timeout.
          this.settle(id);
          reject(new HilError(TIMEOUT, `${op} timed out after ${timeoutMs} ms`, "the daemon is alive but the op did not answer; check `doctor` and port locks", { op, timeout_ms: timeoutMs }));
        }, timeoutMs),
        signal: opts.signal,
      };
      if (opts.signal) {
        entry.onAbort = () => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          clearTimeout(p.timer);
          reject(new HilError(CANCELLED, `${op} cancelled`, undefined, { op }));
        };
        opts.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      try {
        proc.stdin!.write(JSON.stringify({ id, op, args }) + "\n");
      } catch (e) {
        this.settle(id);
        reject(new HilError(DAEMON_DIED, `write to daemon failed: ${(e as Error).message}`, this.lastStderr(), { stderr_tail: this.stderrTail() }));
      }
    });
  }

  /** Graceful stop: serve.shutdown → SIGTERM (1500 ms) → SIGKILL (4500 ms).
   *  Resolves once the process has exited. Idempotent. */
  stop(): Promise<void> {
    const p = this.proc;
    if (!p) { this.clearKillTimers(); return Promise.resolve(); }
    const done = new Promise<void>((resolve) => { this.stopWaiters.push(resolve); });
    if (this.termTimer || this.killTimer) return done; // a stop() is already in flight
    try {
      const id = this.nextId++;
      p.stdin?.write(JSON.stringify({ id, op: "serve.shutdown", args: {} }) + "\n");
    } catch { /* stdin may already be closed */ }
    this.termTimer = setTimeout(() => {
      this.termTimer = null;
      try { p.kill("SIGTERM"); } catch { /* */ }
    }, TERM_AFTER_MS);
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.proc === p) { try { p.kill("SIGKILL"); } catch { /* */ } }
    }, KILL_AFTER_MS);
    return done;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
    return p;
  }

  private lastStderr(): string | undefined {
    const last = this.stderrLines[this.stderrLines.length - 1];
    return last && last.length > 0 ? last : undefined;
  }

  /** Newline framing with a carried partial tail (TraceSession.ingest). */
  private ingest(text: string): void {
    this.stdoutBuf += text;
    const parts = this.stdoutBuf.split("\n");
    this.stdoutBuf = parts.pop() ?? "";
    for (const raw of parts) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line.startsWith("{")) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { continue; }
      if (typeof obj.ev === "string") {
        try { this.opts.onEvent?.(obj as HilEvent); } catch { /* listener bug must not break the reader */ }
        continue;
      }
      if (typeof obj.id !== "number") continue;
      const p = this.settle(obj.id);
      if (!p) continue;
      if (obj.ok === true) { p.resolve(obj.result); continue; }
      const e = obj.error as { code?: string; message?: string; hint?: string; details?: Record<string, unknown> } | undefined;
      if (obj.ok === false && e && typeof e.code === "string") {
        p.reject(new HilError(e.code, e.message ?? e.code, e.hint ?? undefined, e.details ?? {}));
      } else {
        p.reject(new HilError(DAEMON_PROTOCOL, `malformed daemon reply: ${line.slice(0, 200)}`));
      }
    }
  }

  /** Bounded stderr ring (TraceSession.ingestStderr). */
  private ingestStderr(text: string): void {
    this.stderrBuf += text;
    const parts = this.stderrBuf.split("\n");
    this.stderrBuf = parts.pop() ?? "";
    for (const line of parts) {
      const s = line.replace(/\r$/, "");
      if (s.length === 0) continue;
      this.stderrLines.push(s);
    }
    if (this.stderrLines.length > STDERR_RING) {
      this.stderrLines.splice(0, this.stderrLines.length - STDERR_RING);
    }
  }

  private onExit(code: number | null, spawnError: Error | null): void {
    if (this.proc === null) return;
    this.proc = null;
    this.clearKillTimers();
    this.stopRecycleTimer();
    const why = spawnError
      ? `daemon spawn failed: ${spawnError.message}`
      : `crosspad-hil daemon exited with code ${code ?? "null"}`;
    const err = new HilError(DAEMON_DIED, why, this.lastStderr(), { exit_code: code, stderr_tail: this.stderrTail() });
    const waiting = [...this.pending.keys()];
    for (const id of waiting) {
      const p = this.settle(id);
      p?.reject(err);
    }
    const waiters = this.stopWaiters;
    this.stopWaiters = [];
    for (const w of waiters) w();
  }

  private clearKillTimers(): void {
    if (this.termTimer) { clearTimeout(this.termTimer); this.termTimer = null; }
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

/** config `hil_python` → $CROSSPAD_HIL_PYTHON → tracer python → "python3". */
export function resolvedHilPython(): string {
  return resolveConfigValue("hil_python", "CROSSPAD_HIL_PYTHON", process.env.CROSSPAD_HIL_PYTHON, resolvedPython());
}

let singleton: HilDaemon | null = null;
const eventListeners: Array<(ev: HilEvent) => void> = [];

/** Subscribe to daemon events (console.fatal, task.progress, …). Returns an
 *  unsubscribe function. Listeners survive daemon restarts. */
export function onHilEvent(cb: (ev: HilEvent) => void): () => void {
  eventListeners.push(cb);
  return () => {
    const i = eventListeners.indexOf(cb);
    if (i >= 0) eventListeners.splice(i, 1);
  };
}

/** Lazy per-process daemon. Not started until the first request(); a dead
 *  daemon is restarted transparently by the next request(). */
export function getHilDaemon(): HilDaemon {
  if (!singleton) {
    singleton = new HilDaemon({
      python: resolvedHilPython(),
      onEvent: (ev) => { for (const l of eventListeners) { try { l(ev); } catch { /* */ } } },
    });
  }
  return singleton;
}

/** @internal test-only */
export function _resetHilDaemonForTest(): void {
  singleton = null;
  eventListeners.splice(0, eventListeners.length);
}
