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


// ── restart + idle recycle ───────────────────────────────────────────────────

const STATS = {
  version: "1.1.0", pid: 1234, uptime_s: 60, ops_total: 10,
  handles: {}, handles_total: 0, threads: 6, open_fds: 20, alsa_seq_clients: 2,
};

function recyclableRig(over: Partial<ConstructorParameters<typeof HilDaemon>[0]> = {}) {
  const children: FakeChild[] = [];
  const clock = { t: 0 };
  const answered = new Set<number>();
  const d = new HilDaemon({
    python: "/venv/bin/python",
    spawnFn: () => { const c = new FakeChild(); children.push(c); return c; },
    now: () => clock.t,
    recycleCheckMs: 0,
    ...over,
  });
  async function child(n: number): Promise<FakeChild> {
    for (let i = 0; i < 500 && children.length <= n; i++) await new Promise((r) => setTimeout(r, 1));
    if (children.length <= n) throw new Error(`child ${n} never spawned`);
    return children[n];
  }
  async function pick(n: number, op: string): Promise<{ c: FakeChild; id: number }> {
    const c = await child(n);
    for (let i = 0; i < 500; i++) {
      const r = c.requests().find((x) => x.op === op && !answered.has(x.id));
      if (r) { answered.add(r.id); return { c, id: r.id }; }
      await new Promise((res) => setTimeout(res, 1));
    }
    throw new Error(`child ${n} never asked ${op}`);
  }
  async function answer(n: number, op: string, result: unknown): Promise<void> {
    const { c, id } = await pick(n, op);
    c.reply(id, result);
  }
  async function refuse(n: number, op: string, code: string): Promise<void> {
    const { c, id } = await pick(n, op);
    c.fail(id, { code, message: `unknown op ${op}` });
  }
  async function waitOp(n: number, op: string): Promise<void> {
    const c = await child(n);
    for (let i = 0; i < 500; i++) {
      if (c.requests().some((x) => x.op === op)) return;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error(`child ${n} never asked ${op}`);
  }
  async function up(n = 0): Promise<void> {
    const p = d.start();
    await answer(n, "serve.ping", { version: "1.1.0", uptime_s: 0 });
    await p;
  }
  /** Let stop() complete: answer nothing, just let the child exit. */
  async function letStopFinish(n = 0): Promise<void> {
    await waitOp(n, "serve.shutdown");
    (await child(n)).exit(0);
  }
  return { d, children, clock, child, answer, refuse, waitOp, up, letStopFinish };
}

describe("HilDaemon restart", () => {
  it("ends the running process and pings a fresh one", async () => {
    const h = recyclableRig();
    await h.up();
    const r = h.d.restart();
    await h.letStopFinish(0);
    await h.answer(1, "serve.ping", { version: "1.1.0", uptime_s: 0 });
    await r;
    expect(h.children).toHaveLength(2);
    expect(h.d.alive).toBe(true);
  });

  it("starts a daemon when none is running", async () => {
    const h = recyclableRig();
    const r = h.d.restart();
    await h.answer(0, "serve.ping", { version: "1.1.0", uptime_s: 0 });
    await r;
    expect(h.d.alive).toBe(true);
  });
});

describe("HilDaemon idle recycle", () => {
  it("stops an idle daemon that is holding nothing", async () => {
    const h = recyclableRig({ recycleIdleMs: 1000 });
    await h.up();
    h.clock.t = 1000;
    const t = h.d.recycleTick();
    await h.answer(0, "serve.stats", STATS);
    await h.letStopFinish(0);
    expect(await t).toBe("stopped-idle");
    expect(h.d.alive).toBe(false);
    expect(h.d.lastRecycle?.reason).toBe("idle");
  });

  it("leaves a daemon that still holds a handle", async () => {
    const h = recyclableRig({ recycleIdleMs: 1000 });
    await h.up();
    h.clock.t = 100_000;
    const t = h.d.recycleTick();
    await h.answer(0, "serve.stats", { ...STATS, handles: { con: 1 }, handles_total: 1 });
    expect(await t).toBe("in-use");
    expect(h.d.alive).toBe(true);
  });

  it("leaves a daemon with a request in flight", async () => {
    const h = recyclableRig({ recycleIdleMs: 1000 });
    await h.up();
    h.clock.t = 100_000;
    const inflight = h.d.request("devices.list", {});
    expect(await h.d.recycleTick()).toBe("busy");
    await h.answer(0, "devices.list", { devices: [] });
    await inflight;
  });

  it("stops early when the ALSA sequencer clients are over budget", async () => {
    const h = recyclableRig({ recycleIdleMs: 10_000_000, alsaSeqBudget: 4 });
    await h.up();
    h.clock.t = 61_000;
    const t = h.d.recycleTick();
    await h.answer(0, "serve.stats", { ...STATS, alsa_seq_clients: 9 });
    await h.letStopFinish(0);
    expect(await t).toBe("stopped-alsa");
    expect(h.d.lastRecycle?.reason).toBe("alsa_seq");
  });

  it("leaves a daemon whose serve.stats is not answerable", async () => {
    const h = recyclableRig({ recycleIdleMs: 1000 });
    await h.up();
    h.clock.t = 100_000;
    const t = h.d.recycleTick();
    await h.refuse(0, "serve.stats", "BAD_ARGS");
    expect(await t).toBe("unknown");
    expect(h.d.alive).toBe(true);
  });

  it("does not probe a daemon that was used within the sweep period", async () => {
    const h = recyclableRig({ recycleCheckMs: 60_000 });
    await h.up();
    h.clock.t = 100;
    expect(await h.d.recycleTick()).toBe("fresh");
    expect((await h.child(0)).requests().some((r) => r.op === "serve.stats")).toBe(false);
  });

  it("says nothing to do when no daemon is running", async () => {
    const h = recyclableRig();
    expect(await h.d.recycleTick()).toBe("no-daemon");
  });

  it("an ordinary request resets the idle clock, stats() does not", async () => {
    const h = recyclableRig({ recycleIdleMs: 1000 });
    await h.up();
    h.clock.t = 900;
    const p = h.d.request("devices.list", {});
    await h.answer(0, "devices.list", { devices: [] });
    await p;
    h.clock.t = 1000;
    const fresh = h.d.recycleTick();
    await h.answer(0, "serve.stats", STATS);
    expect(await fresh).toBe("fresh");

    const s = h.d.stats();
    await h.answer(0, "serve.stats", STATS);
    await s;
    h.clock.t = 1900;
    const t = h.d.recycleTick();
    await h.answer(0, "serve.stats", STATS);
    await h.letStopFinish(0);
    expect(await t).toBe("stopped-idle");
  });

  it("the next request starts a fresh daemon after a recycle", async () => {
    const h = recyclableRig({ recycleIdleMs: 1000 });
    await h.up();
    h.clock.t = 1000;
    const t = h.d.recycleTick();
    await h.answer(0, "serve.stats", STATS);
    await h.letStopFinish(0);
    await t;

    const p = h.d.request("devices.list", {});
    await h.answer(1, "serve.ping", { version: "1.1.0", uptime_s: 0 });
    await h.answer(1, "devices.list", { devices: [] });
    await p;
    expect(h.d.alive).toBe(true);
    expect(h.children).toHaveLength(2);
  });
});
