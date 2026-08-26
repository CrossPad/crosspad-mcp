import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { HilDaemon, HilError, type ChildLike, type HilEvent } from "./daemon.js";

/** Fake child process: EventEmitter + PassThrough stdio, records stdin lines,
 *  lets the test answer requests by id. */
class FakeChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed: string[] = [];
  lines: string[] = [];
  private buf = "";
  constructor() {
    super();
    this.stdin.on("data", (c: Buffer) => {
      this.buf += c.toString();
      const parts = this.buf.split("\n");
      this.buf = parts.pop() ?? "";
      for (const l of parts) if (l.length > 0) this.lines.push(l);
    });
  }
  kill(sig?: string): boolean { this.killed.push(sig ?? "SIGTERM"); return true; }
  /** The parsed requests written so far. */
  requests(): Array<{ id: number; op: string; args: Record<string, unknown> }> {
    return this.lines.map((l) => JSON.parse(l));
  }
  /** Wait until at least n requests were written. */
  async waitRequests(n: number): Promise<Array<{ id: number; op: string; args: Record<string, unknown> }>> {
    for (let i = 0; i < 200 && this.lines.length < n; i++) await new Promise((r) => setTimeout(r, 1));
    return this.requests();
  }
  reply(id: number, result: unknown): void {
    this.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
  }
  fail(id: number, error: { code: string; message: string; hint?: string; details?: Record<string, unknown> }): void {
    this.stdout.write(JSON.stringify({ id, ok: false, error }) + "\n");
  }
  event(ev: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(ev) + "\n");
  }
  log(line: string): void { this.stderr.write(line + "\n"); }
  exit(code: number): void { this.emit("exit", code, null); }
}

function makeDaemon(onEvent?: (ev: HilEvent) => void): { d: HilDaemon; children: FakeChild[]; spawnCalls: string[][] } {
  const children: FakeChild[] = [];
  const spawnCalls: string[][] = [];
  const d = new HilDaemon({
    python: "/venv/bin/python",
    onEvent,
    spawnFn: (cmd, args) => { spawnCalls.push([cmd, ...args]); const c = new FakeChild(); children.push(c); return c; },
  });
  return { d, children, spawnCalls };
}

/** start() sends serve.ping and waits for its reply — answer it. */
async function started(h: ReturnType<typeof makeDaemon>): Promise<FakeChild> {
  const p = h.d.start();
  const child = h.children[0];
  const [ping] = await child.waitRequests(1);
  expect(ping.op).toBe("serve.ping");
  child.reply(ping.id, { version: "1.0.0", uptime_s: 0 });
  await p;
  return child;
}

describe("HilDaemon spawn + ping", () => {
  it("spawns `<python> -m crosspad_hil.serve` and is alive after ping", async () => {
    const h = makeDaemon();
    await started(h);
    expect(h.spawnCalls[0]).toEqual(["/venv/bin/python", "-m", "crosspad_hil.serve"]);
    expect(h.d.alive).toBe(true);
  });

  it("start() rejects with DAEMON_DIED (stderr tail) when the process exits before ping", async () => {
    const h = makeDaemon();
    const p = h.d.start();
    const child = h.children[0];
    await child.waitRequests(1);
    child.log("ModuleNotFoundError: No module named 'crosspad_hil'");
    child.exit(1);
    await expect(p).rejects.toMatchObject({ code: "DAEMON_DIED", hint: "ModuleNotFoundError: No module named 'crosspad_hil'" });
    expect(h.d.alive).toBe(false);
  });
});

describe("HilDaemon request/response correlation", () => {
  it("resolves each request by id, out of order", async () => {
    const h = makeDaemon();
    const child = await started(h);
    const a = h.d.request<{ n: number }>("devices.list", {});
    const b = h.d.request<{ n: number }>("cdc.transact", { device: "dev_1", cmd: "MEM" });
    const reqs = await child.waitRequests(3);
    expect(reqs[1].op).toBe("devices.list");
    expect(reqs[2].op).toBe("cdc.transact");
    expect(reqs[2].args).toEqual({ device: "dev_1", cmd: "MEM" });
    expect(reqs[1].id).not.toBe(reqs[2].id);
    child.reply(reqs[2].id, { n: 2 });
    child.reply(reqs[1].id, { n: 1 });
    expect(await b).toEqual({ n: 2 });
    expect(await a).toEqual({ n: 1 });
  });

  it("handles a response split across two stdout chunks", async () => {
    const h = makeDaemon();
    const child = await started(h);
    const p = h.d.request("serve.ping", {});
    const [, req] = await child.waitRequests(2);
    const full = JSON.stringify({ id: req.id, ok: true, result: { version: "x" } }) + "\n";
    child.stdout.write(full.slice(0, 10));
    child.stdout.write(full.slice(10));
    expect(await p).toEqual({ version: "x" });
  });

  it("maps ok:false to HilError with code/hint/details", async () => {
    const h = makeDaemon();
    const child = await started(h);
    const p = h.d.request("cdc.transact", { device: "dev_1", cmd: "MEM" });
    const [, req] = await child.waitRequests(2);
    child.fail(req.id, { code: "NO_CDC_IN_AUDIO_MODE", message: "CDC endpoint absent", hint: "usbmode.set mode=default", details: { device: "dev_1" } });
    const e = await p.catch((x) => x);
    expect(e).toBeInstanceOf(HilError);
    expect(e.code).toBe("NO_CDC_IN_AUDIO_MODE");
    expect(e.message).toBe("CDC endpoint absent");
    expect(e.hint).toBe("usbmode.set mode=default");
    expect(e.details).toEqual({ device: "dev_1" });
  });

  it("ignores non-JSON stdout lines", async () => {
    const h = makeDaemon();
    const child = await started(h);
    const p = h.d.request("serve.ping", {});
    const [, req] = await child.waitRequests(2);
    child.stdout.write("not json at all\n");
    child.reply(req.id, { version: "1" });
    expect(await p).toEqual({ version: "1" });
  });

  it("times out with TIMEOUT and drops the pending entry", async () => {
    const h = makeDaemon();
    await started(h);
    const p = h.d.request("console.expect", { handle: "con_1", patterns: ["x"] }, { timeoutMs: 20 });
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("takes its abort listener back off the signal when it times out", async () => {
    // One task's signal drives many ops. A timeout that only deletes the
    // pending entry leaves its listener on that signal for the task's lifetime.
    const h = makeDaemon();
    await started(h);
    const ac = new AbortController();
    const off = vi.spyOn(ac.signal, "removeEventListener");
    const p = h.d.request("console.expect", { handle: "con_1", patterns: ["x"] }, { timeoutMs: 20, signal: ac.signal });
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(off).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects with CANCELLED when the AbortSignal fires", async () => {
    const h = makeDaemon();
    await started(h);
    const ac = new AbortController();
    const p = h.d.request("task.wait", { task: "task_1", timeout_s: 60 }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
  });
});

describe("HilDaemon death", () => {
  it("rejects every pending request with DAEMON_DIED carrying the last 50 stderr lines", async () => {
    const h = makeDaemon();
    const child = await started(h);
    const p1 = h.d.request("devices.list", {});
    const p2 = h.d.request("devices.doctor", {});
    await child.waitRequests(3);
    for (let i = 0; i < 60; i++) child.log(`log line ${i}`);
    child.log("Traceback: boom");
    child.exit(1);
    const e1 = await p1.catch((x) => x);
    const e2 = await p2.catch((x) => x);
    expect(e1.code).toBe("DAEMON_DIED");
    expect(e2.code).toBe("DAEMON_DIED");
    expect(e1.hint).toBe("Traceback: boom");
    const tail = (e1.details.stderr_tail as string).split("\n");
    expect(tail).toHaveLength(50);
    // 60 "log line N" + 1 traceback = 61 lines; the ring keeps the last 50,
    // so the oldest survivor is index 11.
    expect(tail[0]).toBe("log line 11");
    expect(tail[49]).toBe("Traceback: boom");
    expect(h.d.alive).toBe(false);
  });

  it("restarts on the next request after death", async () => {
    const h = makeDaemon();
    const child = await started(h);
    child.exit(0);
    expect(h.d.alive).toBe(false);
    const p = h.d.request("devices.list", {});
    for (let i = 0; i < 200 && h.children.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
    const second = h.children[1];
    const [ping] = await second.waitRequests(1);
    expect(ping.op).toBe("serve.ping");
    second.reply(ping.id, { version: "1.0.0", uptime_s: 0 });
    const [, req] = await second.waitRequests(2);
    expect(req.op).toBe("devices.list");
    second.reply(req.id, { devices: [] });
    expect(await p).toEqual({ devices: [] });
    expect(h.d.alive).toBe(true);
  });

  it("reports a spawn error as DAEMON_DIED", async () => {
    const h = makeDaemon();
    const p = h.d.start();
    const child = h.children[0];
    await child.waitRequests(1);
    child.emit("error", new Error("ENOENT: /venv/bin/python"));
    await expect(p).rejects.toMatchObject({ code: "DAEMON_DIED", message: expect.stringContaining("ENOENT") });
  });
});

describe("HilDaemon events", () => {
  it("dispatches {ev:...} lines to onEvent and never to a pending request", async () => {
    const seen: HilEvent[] = [];
    const h = makeDaemon((ev) => seen.push(ev));
    const child = await started(h);
    const p = h.d.request("serve.ping", {});
    const [, req] = await child.waitRequests(2);
    child.event({ ev: "console.fatal", handle: "con_1", seq: 12, pattern: "Guru Meditation", line: "Guru Meditation Error" });
    child.event({ ev: "task.progress", task: "task_9", progress: 1, total: 4, message: "round 1/4" });
    child.reply(req.id, { version: "1" });
    expect(await p).toEqual({ version: "1" });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ ev: "console.fatal", handle: "con_1", seq: 12 });
    expect(seen[1]).toMatchObject({ ev: "task.progress", task: "task_9" });
  });

  it("a throwing onEvent does not break request handling", async () => {
    const h = makeDaemon(() => { throw new Error("listener bug"); });
    const child = await started(h);
    const p = h.d.request("serve.ping", {});
    const [, req] = await child.waitRequests(2);
    child.event({ ev: "console.reboot", handle: "con_1", count: 1 });
    child.reply(req.id, { version: "1" });
    expect(await p).toEqual({ version: "1" });
  });
});

describe("HilDaemon stop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends serve.shutdown, then SIGTERM at 1500 ms, SIGKILL at 4500 ms, resolves on exit", async () => {
    const h = makeDaemon();
    const p0 = h.d.start();
    const child = h.children[0];
    await vi.advanceTimersByTimeAsync(5);
    const [ping] = child.requests();
    child.reply(ping.id, { version: "1", uptime_s: 0 });
    await p0;
    const stopping = h.d.stop();
    await vi.advanceTimersByTimeAsync(5);
    expect(child.requests().some((r) => r.op === "serve.shutdown")).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(child.killed).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(4500);
    expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
    child.exit(137);
    await stopping;
    expect(h.d.alive).toBe(false);
  });

  it("stop() on a daemon that never started resolves immediately", async () => {
    const h = makeDaemon();
    await h.d.stop();
    expect(h.d.alive).toBe(false);
  });
});
