import http from "http";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import type { Frame, TraceSession } from "./trace-session.js";
import { listSymbols, resolvedElf } from "./trace-symbols.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function uiHtmlPath(): string { return path.resolve(__dirname, "..", "..", "tracer", "ui", "index.html"); }

export function buildUiUrl(port: number): string { return `http://localhost:${port}/`; }

/** Allow a WS upgrade only from a loopback Origin, or when no Origin is sent
 *  (native/non-browser clients). Defends against cross-site WebSocket hijacking. */
export function originIsLoopback(info: { origin?: string }): boolean {
  if (!info.origin) return true;
  try {
    const h = new URL(info.origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/** §12.4 best-effort browser opener. Spawns the platform opener detached so the
 *  MCP server never owns the browser process, swallows every failure (a missing
 *  opener / headless box must never throw), and SKIPS when:
 *   - CROSSPAD_TRACE_NO_BROWSER is set (explicit opt-out), or
 *   - on linux when neither DISPLAY nor WAYLAND_DISPLAY is set (headless — no GUI
 *     to pop, so xdg-open would just error).
 *  Returns true if an opener was actually spawned, false if skipped. */
export function openInBrowser(url: string): boolean {
  if (process.env.CROSSPAD_TRACE_NO_BROWSER) return false;
  const platform = process.platform;
  if (platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  try {
    let cmd: string;
    let args: string[];
    if (platform === "darwin") { cmd = "open"; args = [url]; }
    else if (platform === "win32") { cmd = "cmd"; args = ["/c", "start", "", url]; }
    else { cmd = "xdg-open"; args = [url]; }
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => { /* opener missing — best-effort, never throw */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * §12.1 Persistent dashboard singleton. ONE http+ws server that OUTLIVES trace
 * sessions for the MCP server's whole lifetime. `currentSession` is mutable:
 * `bind` attaches a new trace (subscribes to its frames + broadcasts a
 * `trace_start`); `unbind` detaches it (broadcasts `trace_end`) WITHOUT tearing
 * the server down, so a browser / VS Code Simple Browser tab stays connected
 * across start→stop→start cycles. The port (7373) is therefore stable.
 */
export class Dashboard {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private url: string | null = null;
  // The frame listener we registered on the current session, so unbind() can
  // detach it (a session forwards to a SINGLE onFrame callback — see §12.1).
  private currentSession: TraceSession | null = null;
  port = 0;

  /** §12.1 start listening once; idempotent — a second call reuses the running
   *  server and resolves with the same url. The server keeps listening across
   *  every trace, so the dashboard tab never goes dead. */
  ensureStarted(preferredPort = 7373): Promise<string> {
    if (this.url) return Promise.resolve(this.url);
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = req.url ?? "/";
        const route = url.split("?")[0];
        if (route === "/") {
          try {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(fs.readFileSync(uiHtmlPath()));
          } catch {
            res.writeHead(500); res.end("UI asset missing");
          }
          return;
        }
        // §9/§12.3: GET /symbols[?query=substr] → {"symbols":[ §8 entries ]} JSON.
        if (route === "/symbols") {
          this.serveSymbols(url, res);
          return;
        }
        res.writeHead(404); res.end();
      });
      // Reject cross-site WebSocket hijacking: only accept upgrades from a
      // loopback Origin (the local UI) or no Origin at all (non-browser clients,
      // e.g. the headless test harness, which never send an Origin header).
      this.wss = new WebSocketServer({ server: this.server, verifyClient: originIsLoopback });
      this.wss.on("connection", (ws) => {
        this.clients.add(ws);
        // §12.2: hello now carries whether a trace is active + its signal set so
        // a tab connecting mid-trace (or between traces) re-syncs immediately.
        ws.send(JSON.stringify({
          type: "hello",
          active: this.currentSession != null,
          signals: this.currentSession?.buffer.signalNames() ?? [],
        }));
        // Inbound browser → server: live add/remove of watched signals.
        ws.on("message", (data) => this.handleInbound(data.toString()));
        ws.on("close", () => this.clients.delete(ws));
      });
      this.server.on("error", reject);
      // Bind to loopback only — the trace UI exposes live firmware variable
      // values and must never be reachable from the LAN.
      this.server.listen(preferredPort, "127.0.0.1", () => {
        this.port = (this.server!.address() as any).port;
        this.url = buildUiUrl(this.port);
        resolve(this.url);
      });
    });
  }

  /** §12.1 attach a new trace: become its frame sink, broadcast trace_start. */
  bind(session: TraceSession): void {
    this.currentSession = session;
    session.onFrame((f: Frame) => this.broadcast(f));
    this.broadcast({ type: "trace_start", signals: session.buffer.signalNames() } as any);
  }

  /** §12.1 detach the current trace: broadcast trace_end, go idle. The server
   *  KEEPS listening (clients stay connected, ready for the next trace). */
  unbind(): void {
    this.currentSession = null;
    this.broadcast({ type: "trace_end" } as any);
  }

  /** §12.4: any WS client connected right now? `start` uses this to auto-open
   *  the browser ONLY when the dashboard isn't already open in some tab. */
  hasClients(): boolean {
    for (const ws of this.clients) { if (ws.readyState === ws.OPEN) return true; }
    return false;
  }

  /** §9/§12.3 GET /symbols handler: resolve symbols against the active session's
   *  ELF, or — when idle — the configured DEFAULT ELF so autocomplete keeps
   *  working between traces. Failures reply 500 rather than crashing the server. */
  private async serveSymbols(url: string, res: http.ServerResponse): Promise<void> {
    try {
      const q = new URL(url, "http://localhost").searchParams.get("query") ?? undefined;
      const elf = this.currentSession?.elfPath() ?? resolvedElf();
      const r = await listSymbols(q, elf);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ symbols: r.symbols }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ symbols: [], error: String(e) }));
    }
  }

  /** Parse a browser → server WS message and forward `add`/`remove` to the bound
   *  session. Ignored when idle (no currentSession) or when malformed (bad JSON,
   *  wrong shape) — silently, per §5. */
  private handleInbound(raw: string): void {
    const session = this.currentSession;
    if (!session) return;   // §12.1: idle dashboard — nothing to forward to.
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const { cmd, signals } = msg;
    if ((cmd !== "add" && cmd !== "remove") || !Array.isArray(signals)) return;
    const specs = signals.filter((s: unknown) => typeof s === "string");
    if (specs.length === 0) return;
    try {
      // Fire-and-forget from the WS path: the reconciled set is rebroadcast to
      // browsers via the forwarded "signals" frame, so we don't await here.
      // Swallow the (always-resolving) promise so it never floats unhandled.
      const p = cmd === "add" ? session.addSignals(specs) : session.removeSignals(specs);
      Promise.resolve(p).catch(() => { /* ignore */ });
    } catch { /* session not running — ignore */ }
  }

  private broadcast(f: Frame): void {
    const msg = JSON.stringify(f);
    for (const ws of this.clients) { if (ws.readyState === ws.OPEN) ws.send(msg); }
  }
}

// §12.1 module-level singleton — outlives every TraceSession.
let dashboard: Dashboard | null = null;
export function getDashboard(): Dashboard {
  if (!dashboard) dashboard = new Dashboard();
  return dashboard;
}
