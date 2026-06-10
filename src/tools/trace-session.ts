import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { TraceBuffer } from "./trace-buffer.js";
import { daemonPath, resolvedPython, resolvedElf } from "./trace-symbols.js";
import { resolveConfigValue } from "../utils/userConfig.js";
import { TRACE_DIR_DEFAULT } from "../config.js";
import { TraceWebUi } from "./trace-webui.js";

export type Frame =
  | { type: "sample"; t: number; values: Record<string, number> }
  | { type: "status"; device_state: string; t?: number; samples?: number }
  | { type: "error"; error: string };

/** Pure: parse one NDJSON line from the daemon into a Frame, or null. */
export function parseFrame(line: string): Frame | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  try {
    const o = JSON.parse(s);
    if (o.type === "sample" && o.values) return o as Frame;
    if (o.type === "status" && o.device_state) return o as Frame;
    if (o.type === "error" && o.error) return o as Frame;
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
  webui: TraceWebUi | null = null;
  uiUrl: string | null = null;
  private stdoutBuf = "";
  private onFrameExtra: ((f: Frame) => void) | null = null;

  constructor(private opts: SessionOpts) {
    this.buffer = new TraceBuffer(opts.signals, opts.capacity ?? 200_000);
  }

  onFrame(cb: (f: Frame) => void): void { this.onFrameExtra = cb; }

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
    this.deviceState = "running";
    this.proc.stdout?.on("data", (c: Buffer) => this.ingest(c.toString()));
    this.proc.on("exit", () => { this.deviceState = "exited"; this.proc = null; });
  }

  private ingest(text: string): void {
    this.stdoutBuf += text;
    const parts = this.stdoutBuf.split("\n");
    this.stdoutBuf = parts.pop() ?? "";
    for (const line of parts) {
      const f = parseFrame(line);
      if (!f) continue;
      if (f.type === "sample") { this.buffer.push({ t: f.t, values: f.values }); this.deviceState = "running"; }
      else if (f.type === "status") this.deviceState = f.device_state;
      this.onFrameExtra?.(f);
    }
  }

  async startUi(): Promise<string> {
    if (this.uiUrl) return this.uiUrl;
    this.webui = new TraceWebUi();
    this.uiUrl = await this.webui.start(this);
    return this.uiUrl;
  }

  stop(): void {
    if (!this.proc) return;
    try { this.proc.stdin?.write(JSON.stringify({ cmd: "stop" }) + "\n"); } catch { /* */ }
    const p = this.proc;
    setTimeout(() => { try { p.kill("SIGTERM"); } catch { /* */ } }, 1500);
    this.webui?.stop();
  }

  isRunning(): boolean { return this.proc !== null; }
}

// Module-level singleton — one active trace session per server.
let active: TraceSession | null = null;
export function getActiveSession(): TraceSession | null { return active; }
export function setActiveSession(s: TraceSession | null): void { active = s; }
