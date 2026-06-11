import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { TraceBuffer } from "./trace-buffer.js";
import { daemonPath, resolvedPython, resolvedElf } from "./trace-symbols.js";
import { resolveConfigValue } from "../utils/userConfig.js";
import { TRACE_DIR_DEFAULT } from "../config.js";

export interface SignalSpec { name: string; address: number; size: number; encoding: string; }
export type Frame =
  | { type: "sample"; t: number; values: Record<string, number> }
  | { type: "status"; device_state: string; t?: number; samples?: number }
  | { type: "error"; error: string }
  | { type: "signals"; signals: SignalSpec[]; unresolved: string[] };

/** Pure: parse one NDJSON line from the daemon into a Frame, or null. */
export function parseFrame(line: string): Frame | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  try {
    const o = JSON.parse(s);
    if (o.type === "sample" && o.values) return o as Frame;
    if (o.type === "status" && o.device_state) return o as Frame;
    if (o.type === "error" && o.error) return o as Frame;
    if (o.type === "signals" && Array.isArray(o.signals)) {
      if (!Array.isArray(o.unresolved)) o.unresolved = [];
      return o as Frame;
    }
    return null;
  } catch { return null; }
}

export interface SessionOpts { signals: string[]; rateHz: number; elf?: string; outFile?: string; capacity?: number; swo?: string[]; }

export class TraceSession {
  private proc: ChildProcess | null = null;
  buffer: TraceBuffer;
  deviceState = "starting";
  startedAt = 0;
  filePath: string | null = null;
  private stdoutBuf = "";
  private onFrameExtra: ((f: Frame) => void) | null = null;
  // Pending add/remove resolvers, fired (FIFO) on the next "signals" frame so
  // the MCP/UI sees the POST-reconcile set (PROTOCOL §4). Each carries a timeout
  // handle so a missing frame can't hang the caller forever.
  private pendingReconcile: Array<{ resolve: (names: string[]) => void; timer: ReturnType<typeof setTimeout> }> = [];

  // ── §11.5 guaranteed teardown ──────────────────────────────────────────
  // stop() escalates {cmd:stop} → SIGTERM → SIGKILL. These hold the pending
  // escalation timers so a clean exit can cancel them (no stray kill) and so a
  // second stop() is idempotent.
  private termTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  // ── §11.6 daemon stderr ring + start truthfulness ──────────────────────
  // Ring of the last STDERR_RING lines of daemon stderr (human logs + any
  // libusb noise) so a non-zero exit can surface *why* via stderrTail().
  private static readonly STDERR_RING = 30;
  private stderrLines: string[] = [];
  private stderrBuf = "";
  // Did we ever ingest an `error` frame? a non-zero exit with no error frame
  // means the daemon died unexpectedly → synthesize device_state from stderr.
  private sawErrorFrame = false;
  // Resolvers for waitForFirstFrame(), fired on the first ingested frame.
  private firstFrameSeen = false;
  private firstFrameWaiters: Array<{ resolve: (f: Frame | null) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private opts: SessionOpts) {
    this.buffer = new TraceBuffer(opts.signals, opts.capacity ?? 200_000);
  }

  onFrame(cb: (f: Frame) => void): void { this.onFrameExtra = cb; }
  /** Detach the frame sink so late `sample`/`status` frames during a shutdown
   *  race aren't rebroadcast after `trace_end`, and the consumer (Dashboard)
   *  doesn't hold this session longer than necessary. */
  offFrame(): void { this.onFrameExtra = null; }

  // Fired once when the daemon process is truly gone (clean exit, kill, or
  // spawn error). Lets callers defer teardown (dashboard unbind, clearing the
  // active session) until the probe is actually free — see §11.5.
  private stoppedCbs: (() => void)[] = [];
  /** Register a callback for when the daemon process has fully exited. If the
   *  process is already gone, fires synchronously. */
  onStopped(cb: () => void): void {
    if (this.proc === null) { cb(); return; }
    this.stoppedCbs.push(cb);
  }
  private fireStopped(): void {
    const cbs = this.stoppedCbs;
    this.stoppedCbs = [];
    for (const cb of cbs) { try { cb(); } catch { /* */ } }
  }

  /** The ELF this session traces against (explicit opt or the configured default).
   *  Used by the web UI's /symbols endpoint so autocomplete matches the trace. */
  elfPath(): string { return this.opts.elf ?? resolvedElf(); }

  start(): void {
    const traceDir = resolveConfigValue("trace_dir", "CROSSPAD_TRACE_DIR", process.env.CROSSPAD_TRACE_DIR, TRACE_DIR_DEFAULT);
    fs.mkdirSync(traceDir, { recursive: true });
    this.filePath = this.opts.outFile ?? path.join(traceDir, `trace-${process.pid}.cptrace`);
    const argv = [daemonPath(), "trace", "--elf", this.opts.elf ?? resolvedElf(),
      "--signals", this.opts.signals.join(","), "--rate", String(this.opts.rateHz), "--out", this.filePath];
    const probe = resolveConfigValue("probe_serial", "CROSSPAD_PROBE_SERIAL", process.env.CROSSPAD_PROBE_SERIAL, "");
    if (probe) argv.push("--probe", probe);
    // EXPERIMENTAL: SWO/ITM channel decode (opt-in; fail-soft in daemon).
    if (this.opts.swo && this.opts.swo.length > 0) {
      argv.push("--swo", this.opts.swo.join(","));
    }
    this.proc = spawn(resolvedPython(), argv, { stdio: ["pipe", "pipe", "pipe"] });
    this.startedAt = performance.now();
    // §11.4: honest pre-first-frame state. start() upgrades this to "running"
    // only once a real signals/sample frame lands (see waitForFirstFrame).
    this.deviceState = "connecting";
    this.proc.stdout?.on("data", (c: Buffer) => this.ingest(c.toString()));
    // §11.6: capture daemon stderr into a bounded ring so a non-zero exit can
    // explain itself (the daemon's human logs + any libusb noise go here).
    this.proc.stderr?.on("data", (c: Buffer) => this.ingestStderr(c.toString()));
    this.proc.on("exit", (code) => this.onExit(code));
    // A bad interpreter path (race after doctor) emits 'error' — handle it so it
    // never bubbles up as an uncaught exception that crashes the MCP server.
    this.proc.on("error", (e) => {
      this.deviceState = "spawn_failed: " + e.message;
      this.proc = null;
      this.clearKillTimers();
      this.resolveFirstFrame(null);
      this.fireStopped();
    });
  }

  /** §11.6: fold daemon stderr into a bounded ring (last STDERR_RING lines). */
  private ingestStderr(text: string): void {
    this.stderrBuf += text;
    const parts = this.stderrBuf.split("\n");
    this.stderrBuf = parts.pop() ?? "";
    for (const line of parts) {
      const s = line.replace(/\r$/, "");
      if (s.length === 0) continue;
      this.stderrLines.push(s);
    }
    if (this.stderrLines.length > TraceSession.STDERR_RING) {
      this.stderrLines.splice(0, this.stderrLines.length - TraceSession.STDERR_RING);
    }
  }

  /** §11.6: the last `n` captured daemon stderr lines, newest last. */
  stderrTail(n = TraceSession.STDERR_RING): string {
    return this.stderrLines.slice(-n).join("\n");
  }

  /** Daemon exited. §11.6: if it died non-zero WITHOUT emitting an error frame,
   *  synthesize an `error: <stderr tail>` device_state so status/start never
   *  reports a stale "running" for a process that's actually dead. */
  private onExit(code: number | null): void {
    if (code && code !== 0 && !this.sawErrorFrame) {
      const last = this.stderrLines[this.stderrLines.length - 1];
      this.deviceState = "error: " + (last && last.length > 0 ? last : `daemon exited code ${code}`);
    } else if (this.deviceState === "connecting" || this.deviceState === "running") {
      // Clean (or already-error) exit with no lingering fault → mark exited.
      this.deviceState = "exited";
    }
    this.proc = null;
    this.clearKillTimers();
    // Unblock any start() still waiting — the process is gone.
    this.resolveFirstFrame(null);
    this.fireStopped();
  }

  private ingest(text: string): void {
    this.stdoutBuf += text;
    const parts = this.stdoutBuf.split("\n");
    this.stdoutBuf = parts.pop() ?? "";
    for (const line of parts) {
      const f = parseFrame(line);
      if (!f) continue;
      // §11.6: the first machine frame (signals|sample|error) unblocks start().
      this.resolveFirstFrame(f);
      if (f.type === "sample") { this.buffer.push({ t: f.t, values: f.values }); this.deviceState = "running"; }
      else if (f.type === "status") this.deviceState = f.device_state;
      else if (f.type === "error") { this.deviceState = "error: " + f.error; this.sawErrorFrame = true; }
      else if (f.type === "signals") {
        this.reconcileSignals(f.signals.map((s) => s.name));
        // Resolve the oldest pending add/remove with the now-reconciled set.
        const pend = this.pendingReconcile.shift();
        if (pend) { clearTimeout(pend.timer); pend.resolve(this.buffer.signalNames()); }
      }
      this.onFrameExtra?.(f);
    }
  }

  /** Reconcile the buffer's watched-signal set to match the daemon's authoritative
   *  list (from a "signals" frame): add any new names, drop any no longer present. */
  private reconcileSignals(names: string[]): void {
    const want = new Set(names);
    for (const have of this.buffer.signalNames()) {
      if (!want.has(have)) this.buffer.removeSignal(have);
    }
    for (const n of names) this.buffer.addSignal(n);
  }

  /** Add signals to the live poll set (NDJSON `add` to daemon stdin).
   *  Resolves with the POST-reconcile signal-name set once the daemon's next
   *  "signals" frame is ingested (PROTOCOL §4); ~2 s timeout → resolves with the
   *  current `buffer.signalNames()` so a missing frame never hangs the caller. */
  addSignals(specs: string[]): Promise<string[]> {
    if (!this.proc?.stdin) throw new Error("No running trace to add signals to.");
    this.proc.stdin.write(JSON.stringify({ cmd: "add", signals: specs }) + "\n");
    return this.awaitReconcile();
  }

  /** Remove signals from the live poll set (NDJSON `remove` to daemon stdin).
   *  Same post-reconcile / timeout contract as addSignals. */
  removeSignals(specs: string[]): Promise<string[]> {
    if (!this.proc?.stdin) throw new Error("No running trace to remove signals from.");
    this.proc.stdin.write(JSON.stringify({ cmd: "remove", signals: specs }) + "\n");
    return this.awaitReconcile();
  }

  /** Queue a resolver fired by the next "signals" frame; falls back to the
   *  current signal set after ~2 s so callers can't hang on a silent daemon. */
  private awaitReconcile(timeoutMs = 2000): Promise<string[]> {
    return new Promise<string[]>((resolve) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          const i = this.pendingReconcile.indexOf(entry);
          if (i >= 0) this.pendingReconcile.splice(i, 1);
          resolve(this.buffer.signalNames());
        }, timeoutMs),
      };
      this.pendingReconcile.push(entry);
    });
  }

  /** §11.6: resolve on the FIRST ingested frame (signals|sample|error), or
   *  `null` on timeout / if the daemon exits first. Lets MCP `start` report a
   *  truthful device_state instead of an optimistic "running". Idempotent:
   *  if a frame was already seen before the call, resolves immediately. */
  waitForFirstFrame(timeoutMs = 3000): Promise<Frame | null> {
    // Already exited with nothing, or a frame already arrived → settle now.
    if (this.firstFrameSeen || this.proc === null) {
      return Promise.resolve(this.lastFirstFrame);
    }
    return new Promise<Frame | null>((resolve) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          const i = this.firstFrameWaiters.indexOf(entry);
          if (i >= 0) this.firstFrameWaiters.splice(i, 1);
          resolve(null);
        }, timeoutMs),
      };
      this.firstFrameWaiters.push(entry);
    });
  }

  // Remember the first frame so a waitForFirstFrame() called *after* it arrived
  // still gets it (start() awaits right after spawn, but be robust to ordering).
  private lastFirstFrame: Frame | null = null;

  /** Fire all pending first-frame waiters once. `f` is the triggering frame
   *  (or null when the daemon exited / spawn-errored before any frame). */
  private resolveFirstFrame(f: Frame | null): void {
    if (f && !this.firstFrameSeen) { this.firstFrameSeen = true; this.lastFirstFrame = f; }
    if (this.firstFrameWaiters.length === 0) return;
    const waiters = this.firstFrameWaiters;
    this.firstFrameWaiters = [];
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(f ?? this.lastFirstFrame); }
  }

  /** Cancel any pending SIGTERM/SIGKILL escalation timers (clean exit). */
  private clearKillTimers(): void {
    if (this.termTimer) { clearTimeout(this.termTimer); this.termTimer = null; }
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
  }

  /** §11.5 guaranteed teardown — escalate {cmd:stop} → SIGTERM → SIGKILL.
   *  Idempotent and safe to call when `proc` is already null (the daemon may
   *  have self-exited on a connect failure / crash / target reset). A wedged
   *  daemon blocked in uninterruptible libusb ignores SIGTERM, so the SIGKILL
   *  fallback is the ONLY thing that guarantees no `pkill -9` is ever needed.
   *  The escalation timers are cleared on real exit (see onExit) so a clean
   *  shutdown never fires a stray kill at a recycled PID.
   *
   *  §12.1: stop() ONLY ends the daemon now. The web UI is owned by the
   *  persistent Dashboard singleton (see trace-webui.ts), which OUTLIVES the
   *  session — the MCP `stop` handler calls dashboard.unbind() so the server
   *  keeps listening and the dashboard tab survives across traces. */
  stop(): void {
    const p = this.proc;
    if (!p) { this.clearKillTimers(); return; }   // already gone → nothing to kill
    if (this.termTimer || this.killTimer) return; // a stop() is already in flight (idempotent)
    try { p.stdin?.write(JSON.stringify({ cmd: "stop" }) + "\n"); } catch { /* */ }
    // 1) polite SIGTERM after ~1.5 s if {cmd:stop} didn't already end it.
    this.termTimer = setTimeout(() => {
      this.termTimer = null;
      try { p.kill("SIGTERM"); } catch { /* */ }
    }, 1500);
    // 2) hard SIGKILL ~3 s later if the process is STILL alive (wedged libusb).
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.proc) { try { p.kill("SIGKILL"); } catch { /* */ } }
    }, 4500);
  }

  isRunning(): boolean { return this.proc !== null; }
}

// Module-level singleton — one active trace session per server.
let active: TraceSession | null = null;
export function getActiveSession(): TraceSession | null { return active; }
export function setActiveSession(s: TraceSession | null): void { active = s; }
