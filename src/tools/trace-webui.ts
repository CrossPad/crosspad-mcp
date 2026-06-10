import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import type { Frame, TraceSession } from "./trace-session.js";

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

export class TraceWebUi {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  port = 0;

  start(session: TraceSession, preferredPort = 7373): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if ((req.url ?? "/").split("?")[0] === "/") {
          try {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(fs.readFileSync(uiHtmlPath()));
          } catch {
            res.writeHead(500); res.end("UI asset missing");
          }
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
        ws.send(JSON.stringify({ type: "hello", signals: session.buffer.signalNames() }));
        ws.on("close", () => this.clients.delete(ws));
      });
      session.onFrame((f: Frame) => this.broadcast(f));
      this.server.on("error", reject);
      // Bind to loopback only — the trace UI exposes live firmware variable
      // values and must never be reachable from the LAN.
      this.server.listen(preferredPort, "127.0.0.1", () => {
        this.port = (this.server!.address() as any).port;
        resolve(buildUiUrl(this.port));
      });
    });
  }

  private broadcast(f: Frame): void {
    const msg = JSON.stringify(f);
    for (const ws of this.clients) { if (ws.readyState === ws.OPEN) ws.send(msg); }
  }

  stop(): void {
    for (const ws of this.clients) { try { ws.close(); } catch { /* */ } }
    this.wss?.close(); this.server?.close();
  }
}
