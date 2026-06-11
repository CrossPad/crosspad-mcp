import { describe, it, expect, vi } from "vitest";
import { once } from "events";
import { WebSocket } from "ws";

// Stub the symbols bridge so the /symbols route tests never shell out to pyOCD.
// resolvedElf is the §12.3 idle fallback ELF used when no session is bound.
vi.mock("./trace-symbols.js", () => ({
  resolvedElf: vi.fn(() => "/tmp/default.elf"),
  listSymbols: vi.fn(async (query?: string) => ({
    success: true,
    symbols: query === "vec"
      ? [{ name: "vec", address: 0x20000000, encoding: "uint", size: 16, kind: "array", dims: [8], count: 8, elem_size: 2, elem_encoding: "uint" }]
      : [
          { name: "s_vbat_mv", address: 0x20000010, encoding: "uint", size: 2, kind: "scalar" },
          { name: "vec", address: 0x20000000, encoding: "uint", size: 16, kind: "array", dims: [8], count: 8 },
        ],
  })),
}));

import { buildUiUrl, originIsLoopback, Dashboard, getDashboard, openInBrowser } from "./trace-webui.js";
import { listSymbols } from "./trace-symbols.js";

describe("buildUiUrl", () => {
  it("builds a localhost URL for a port", () => {
    expect(buildUiUrl(7373)).toBe("http://localhost:7373/");
  });
});

describe("originIsLoopback", () => {
  it("allows requests with no Origin header (non-browser clients)", () => {
    expect(originIsLoopback({})).toBe(true);
  });
  it("allows loopback origins", () => {
    expect(originIsLoopback({ origin: "http://localhost:7373" })).toBe(true);
    expect(originIsLoopback({ origin: "http://127.0.0.1:5000" })).toBe(true);
  });
  it("rejects cross-site origins", () => {
    expect(originIsLoopback({ origin: "https://evil.example.com" })).toBe(false);
    expect(originIsLoopback({ origin: "http://192.168.1.50" })).toBe(false);
  });
  it("rejects a malformed origin", () => {
    expect(originIsLoopback({ origin: "not a url" })).toBe(false);
  });
});

describe("getDashboard singleton (§12.1)", () => {
  it("returns the same instance every call", () => {
    expect(getDashboard()).toBe(getDashboard());
  });
});

describe("openInBrowser (§12.4)", () => {
  it("skips (returns false) when CROSSPAD_TRACE_NO_BROWSER is set", () => {
    const prev = process.env.CROSSPAD_TRACE_NO_BROWSER;
    process.env.CROSSPAD_TRACE_NO_BROWSER = "1";
    try {
      expect(openInBrowser("http://localhost:7373/")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CROSSPAD_TRACE_NO_BROWSER;
      else process.env.CROSSPAD_TRACE_NO_BROWSER = prev;
    }
  });

  it("skips on linux when neither DISPLAY nor WAYLAND_DISPLAY is set (headless)", () => {
    if (process.platform !== "linux") return;   // headless rule is linux-only
    const noBrowser = process.env.CROSSPAD_TRACE_NO_BROWSER;
    const display = process.env.DISPLAY;
    const wayland = process.env.WAYLAND_DISPLAY;
    delete process.env.CROSSPAD_TRACE_NO_BROWSER;
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      expect(openInBrowser("http://localhost:7373/")).toBe(false);
    } finally {
      if (noBrowser !== undefined) process.env.CROSSPAD_TRACE_NO_BROWSER = noBrowser;
      if (display !== undefined) process.env.DISPLAY = display;
      if (wayland !== undefined) process.env.WAYLAND_DISPLAY = wayland;
    }
  });
});

// A minimal TraceSession stand-in for binding without spawning the daemon.
function fakeSession(names: string[] = ["a", "b"]) {
  let frameCb: ((f: any) => void) | null = null;
  return {
    addSignals: vi.fn(async () => names),
    removeSignals: vi.fn(async () => names),
    onFrame: vi.fn((cb: (f: any) => void) => { frameCb = cb; }),
    offFrame: vi.fn(() => { frameCb = null; }),
    elfPath: () => "/tmp/session.elf",
    buffer: { signalNames: () => names },
    emit: (f: any) => frameCb?.(f),
  } as any;
}

describe("Dashboard bind/unbind inbound forwarding (§12.1)", () => {
  function inbound(d: Dashboard, raw: string) {
    (d as any).handleInbound(raw);
  }

  it("forwards an add command to the bound session.addSignals", () => {
    const d = new Dashboard();
    const sess = fakeSession();
    d.bind(sess);
    inbound(d, JSON.stringify({ cmd: "add", signals: ["a", "b"] }));
    expect(sess.addSignals).toHaveBeenCalledWith(["a", "b"]);
    expect(sess.removeSignals).not.toHaveBeenCalled();
  });

  it("forwards a remove command to the bound session.removeSignals", () => {
    const d = new Dashboard();
    const sess = fakeSession();
    d.bind(sess);
    inbound(d, JSON.stringify({ cmd: "remove", signals: ["a"] }));
    expect(sess.removeSignals).toHaveBeenCalledWith(["a"]);
  });

  it("ignores inbound add/remove when idle (no bound session)", () => {
    const d = new Dashboard();
    // No bind() — handleInbound must be a no-op (and never throw).
    expect(() => inbound(d, JSON.stringify({ cmd: "add", signals: ["a"] }))).not.toThrow();
  });

  it("ignores malformed / non-matching messages silently", () => {
    const d = new Dashboard();
    const sess = fakeSession();
    d.bind(sess);
    inbound(d, "not json");
    inbound(d, JSON.stringify({ cmd: "bogus", signals: ["a"] }));
    inbound(d, JSON.stringify({ cmd: "add", signals: "nope" }));
    inbound(d, JSON.stringify({ cmd: "add", signals: [] }));
    inbound(d, JSON.stringify({ cmd: "add", signals: [1, 2] }));
    expect(sess.addSignals).not.toHaveBeenCalled();
    expect(sess.removeSignals).not.toHaveBeenCalled();
  });
});

describe("Dashboard /symbols endpoint (§9/§12.3)", () => {
  function fakeRes() {
    const rec: { status?: number; headers?: any; body?: string } = {};
    return {
      writeHead(status: number, headers?: any) { rec.status = status; rec.headers = headers; },
      end(body?: string) { rec.body = body; },
      rec,
    };
  }
  function serve(d: Dashboard, url: string, res: any) {
    return (d as any).serveSymbols(url, res);
  }

  it("uses the bound session's ELF when a trace is active", async () => {
    const d = new Dashboard();
    d.bind(fakeSession());
    const res = fakeRes();
    await serve(d, "/symbols", res);
    expect(res.rec.status).toBe(200);
    expect(res.rec.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(res.rec.body!);
    const vec = body.symbols.find((s: any) => s.name === "vec");
    expect(vec.kind).toBe("array");
    expect(vec.dims).toEqual([8]);
    expect(listSymbols).toHaveBeenCalledWith(undefined, "/tmp/session.elf");
  });

  it("§12.3: falls back to the DEFAULT ELF when idle (no bound session)", async () => {
    const d = new Dashboard();   // never bound → idle
    const res = fakeRes();
    await serve(d, "/symbols?query=vec", res);
    // Resolved against resolvedElf() (the configured default), not a session ELF.
    expect(listSymbols).toHaveBeenCalledWith("vec", "/tmp/default.elf");
    const body = JSON.parse(res.rec.body!);
    expect(body.symbols).toHaveLength(1);
    expect(body.symbols[0].name).toBe("vec");
  });
});

describe("Dashboard persistent server lifecycle (§12.1/§12.2)", () => {
  // Bind to an ephemeral loopback port (preferredPort 0) like the prior webui
  // tests would — no fixed-port collisions, real http+ws round-trip.
  async function startEphemeral(d: Dashboard): Promise<string> {
    return d.ensureStarted(0);
  }

  it("ensureStarted is idempotent — reused across calls, same url", async () => {
    const d = new Dashboard();
    const url1 = await startEphemeral(d);
    const url2 = await d.ensureStarted(0);
    expect(url2).toBe(url1);
    (d as any).server?.close();
  });

  it("hello carries active+signals; bind/unbind broadcast trace_start/trace_end; server stays up", async () => {
    const d = new Dashboard();
    const url = await startEphemeral(d);
    const port = d.port;

    // 1) Connect while idle → hello{active:false, signals:[]}.
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/`);
    const [helloRaw1] = await once(ws1, "message");
    const hello1 = JSON.parse(helloRaw1.toString());
    expect(hello1).toMatchObject({ type: "hello", active: false, signals: [] });

    // 2) bind a session → connected client gets trace_start with the signal set.
    const sess = fakeSession(["x", "y"]);
    const startP = once(ws1, "message");
    d.bind(sess);
    const [startRaw] = await startP;
    expect(JSON.parse(startRaw.toString())).toMatchObject({ type: "trace_start", signals: ["x", "y"] });

    // 3) hasClients reflects the live connection.
    expect(d.hasClients()).toBe(true);

    // 4) a frame from the bound session broadcasts to the client.
    const frameP = once(ws1, "message");
    sess.emit({ type: "sample", t: 1, values: { x: 1, y: 2 } });
    const [frameRaw] = await frameP;
    expect(JSON.parse(frameRaw.toString())).toMatchObject({ type: "sample" });

    // 5) unbind → trace_end, but the WS stays open (server keeps listening).
    const endP = once(ws1, "message");
    d.unbind();
    const [endRaw] = await endP;
    expect(JSON.parse(endRaw.toString())).toMatchObject({ type: "trace_end" });
    expect(ws1.readyState).toBe(WebSocket.OPEN);

    // 6) a NEW client connecting after unbind sees active:false (idle dashboard),
    //    proving the server is still listening on the same port.
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/`);
    const [helloRaw2] = await once(ws2, "message");
    expect(JSON.parse(helloRaw2.toString())).toMatchObject({ type: "hello", active: false });
    expect(url).toBe(buildUiUrl(port));

    ws1.close();
    ws2.close();
    (d as any).server?.close();
  });
});
