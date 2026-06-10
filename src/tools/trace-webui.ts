import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import type { Frame, TraceSession } from "./trace-session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function uiHtmlPath(): string { return path.resolve(__dirname, "..", "..", "tracer", "ui", "index.html"); }

export function buildUiUrl(port: number): string { return `http://localhost:${port}/`; }

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
      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.send(JSON.stringify({ type: "hello", signals: session.buffer.signalNames() }));
        ws.on("close", () => this.clients.delete(ws));
      });
      session.onFrame((f: Frame) => this.broadcast(f));
      this.server.on("error", reject);
      this.server.listen(preferredPort, () => {
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
