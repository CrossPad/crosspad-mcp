# crosspad-mcp v10 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn crosspad-mcp into a thin, safe front over the `crosspad-hil` daemon: toolsets with a small startup surface, server-enforced tiers with confirmations that work without client elicitation, explicit handles, a job registry for long operations, and the `core` + `device` toolsets (`devices`, `doctor`, `snapshot`, `ui`, `cdc`, `console`, `midi`, `usb_mode`, `audio_route`, `flash` with preflight and `wait_boot`).

**Architecture:** `src/hil/daemon.ts` spawns `python -m crosspad_hil.serve` and speaks NDJSON (the `trace-session.ts` pattern). Tools are registered through `src/registry.ts` into a `ToolsetManager` (all registered disabled, then the initial set enabled) and wrapped by a policy pipeline: `tierOf()` → `decide()` → `requireConfirmation()` → run → `jsonResponse`. Long work goes through `JobRegistry` and `crosspad_task`. Device state is also exposed as resources. Existing sim/git/apps/code/trace tools keep their behaviour and gain tiers.

**Tech Stack:** TypeScript (ESM, strict), `@modelcontextprotocol/sdk` 1.29+, zod, vitest; Node ≥ 18; Python daemon from plan B.

**Spec:** `docs/superpowers/specs/2026-08-25-crosspad-hil-and-mcp-v10-design.md` (§3.1–3.8, §4.1–4.4, §8 P0). **Prerequisite:** plans A and B (`crosspad-hil` 1.0 with `serve`). **Contract:** the TS contract section below plus the daemon op table in plan B's contract.

## Global Constraints

- Breaking release `10.0.0`; `package.json` gains `"hilVersion": "1.0.0"`; `.claude-plugin/plugin.json` version synced; README migration table v9→v10.
- Startup `tools/list` = `core` only (8 tools); every other tool registered disabled; `--read-only` / `CROSSPAD_MCP_POLICY=readonly` hides every non-`read` tool regardless of toolset flags (read-only wins).
- Every tool has a tier in `TOOL_TIERS`; annotations are derived from the tier, never hand-written; danger-tier tools call `requireConfirmation()` before any side effect and return the token result when not approved.
- No `execSync`/`spawnSync` on any request path after Task 11; every subprocess honours `extra.signal`.
- Heavy outputs (console logs, WAVs, screenshots to file) are `resource_link`s + inline summaries; console reads cap at 2 000 lines.
- Existing helpers (`jsonResponse`, `err`, `makeProgressLogger`, argv-only `runArgvStream`) are reused, not duplicated; tool names listed in §3.1 are final.
- vitest for every task; no test touches hardware or a real daemon (fake child process / mocked `HilDaemon`).

---
# Plan C chunk C1 — crosspad-mcp v10 P0: daemon proxy, schemas, handles, jobs, `crosspad_task`

Repo: `/home/matixan/GIT/crosspad-mcp` (TypeScript ESM, `@modelcontextprotocol/sdk` 1.29.0, `zod` ^4.3.6, vitest 4).
Test runner: `cd /home/matixan/GIT/crosspad-mcp && npm test -- <file>` (vitest picks `src/**/*.test.ts`). Type-check: `npx tsc --noEmit`.
Node: system Node 18 is too old for vitest 4 — run `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22` in every shell first.

Conventions copied from the existing code base (read `src/index.ts` lines 120–150 and `src/tools/trace-session.ts` before starting):
- Every module is ESM; relative imports end in `.js` even for `.ts` sources.
- Tool results go through `jsonResponse(data)` — `{content:[{type:"text", text: JSON.stringify(data,null,2)}], structuredContent: data, isError?: true when data.success === false}`. This chunk re-creates that helper in `src/tool-result.ts` so tool modules outside `index.ts` can use it (index.ts keeps its own private copy; chunk C3 may switch index.ts to import this one).
- Daemon process handling ports the `TraceSession` pattern (`spawn` with `stdio: ["pipe","pipe","pipe"]`, newline framing with a carried partial tail, stderr ring, `{cmd:stop}` → SIGTERM after 1500 ms → SIGKILL after 4500 ms).

---

### Task 1: HilDaemon proxy, zod schemas, `hil_python` config key

**Files:**
- Create: `/home/matixan/GIT/crosspad-mcp/src/hil/daemon.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/src/hil/schemas.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/src/tool-result.ts`
- Modify: `/home/matixan/GIT/crosspad-mcp/src/utils/userConfig.ts:6-19` (add `hil_python` to `UserConfig`)
- Test: `/home/matixan/GIT/crosspad-mcp/src/hil/daemon.test.ts`
- Test: `/home/matixan/GIT/crosspad-mcp/src/hil/schemas.test.ts`

**Interfaces:**
- Consumes: Python daemon protocol from the contract (`serve.py`): request `{"id": int, "op": str, "args": dict}`; response `{"id", "ok": true, "result"}` / `{"id", "ok": false, "error": {"code","message","hint","details"}}`; events `{"ev": str, ...}`; spawned as `<python> -m crosspad_hil.serve`. `resolveConfigValue()` / `UserConfig` from `src/utils/userConfig.ts`; `resolvedPython()` from `src/tools/trace-symbols.ts` (the tracer venv python, default `"python3"`).
- Produces:
  - `export class HilError extends Error { code: string; hint?: string; details: Record<string, unknown>; constructor(code: string, message: string, hint?: string, details?: Record<string, unknown>); toJSON(): {code, message, hint?, details} }`
  - `export type HilEvent = { ev: string } & Record<string, unknown>`
  - `export interface ChildLike` (the subset of `ChildProcess` the daemon uses) and `export type SpawnFn = (cmd: string, args: string[], opts: {cwd?: string}) => ChildLike` — **contract extension**: the constructor accepts an optional `spawnFn` so tests inject a fake child; default is `child_process.spawn`.
  - `export class HilDaemon { constructor(opts: {python: string; cwd?: string; onEvent?: (ev: HilEvent) => void; spawnFn?: SpawnFn}); start(): Promise<void>; request<T = unknown>(op: string, args: Record<string, unknown>, opts?: {signal?: AbortSignal; timeoutMs?: number}): Promise<T>; stop(): Promise<void>; readonly alive: boolean; stderrTail(n?: number): string }`
  - `export function getHilDaemon(): HilDaemon` (lazy singleton) and `export function resolvedHilPython(): string` (config `hil_python` → env `CROSSPAD_HIL_PYTHON` → `resolvedPython()`), plus `export function _resetHilDaemonForTest(): void`.
  - Error codes minted on the TS side (not in the Python contract): `DAEMON_DIED` (process exited with requests pending, or spawn failed; `hint` = last stderr line, `details.stderr_tail` = last 50 stderr lines joined), `TIMEOUT` (request exceeded `timeoutMs`, default 30 000 ms), `CANCELLED` (AbortSignal fired), `DAEMON_PROTOCOL` (response neither ok:true nor carried an error object).
  - `src/hil/schemas.ts`: `DeviceSchema, SnapshotSchema, ReplySchema, ReadResultSchema, ExpectResultSchema, BootResultSchema, TaskStatusSchema, DoctorCheckSchema, ScenarioInfoSchema` and `export type Device = z.infer<typeof DeviceSchema>` etc. Plus helper schemas `SerialPortInfoSchema, MidiPortInfoSchema, AudioCardInfoSchema, PortsSchema, ScenarioParamSchema, TaskErrorSchema`. All objects are `z.looseObject` (the daemon may add keys; the TS side never rejects them).
  - `src/tool-result.ts`: `export type ToolResult = {content: Array<{type:"text"; text:string}>; structuredContent: Record<string, unknown>; isError?: boolean}`; `export function jsonResponse(data: object): ToolResult`; `export function ok(data?: Record<string, unknown>): ToolResult`; `export function err(message: string, extra?: Record<string, unknown>): ToolResult`; `export function errorResult(e: unknown): ToolResult` → `{success:false, error:{code,message,hint?}}` (HilError keeps its code; any other Error → code `"INTERNAL"`).

- [ ] **Step 1: Write the failing daemon test**

`/home/matixan/GIT/crosspad-mcp/src/hil/daemon.test.ts`:

```ts
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
    expect(tail[0]).toBe("log line 12");
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
```

- [ ] **Step 2: Run the daemon test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/hil/daemon.test.ts`
Expected: FAIL with `Error: Failed to load url ./daemon.js` (module does not exist).

- [ ] **Step 3: Add the `hil_python` config key and the shared tool-result helper**

Edit `/home/matixan/GIT/crosspad-mcp/src/utils/userConfig.ts` — inside `export interface UserConfig { ... }`, after the `pyocd_python?: string;` line (line 8) add:

```ts
  /** Python interpreter that has `crosspad-hil[all]` installed (used to spawn
   *  `python -m crosspad_hil.serve`). Resolution at spawn time: this value →
   *  $CROSSPAD_HIL_PYTHON → the tracer python (`pyocd_python` /
   *  $CROSSPAD_TRACE_PYTHON) → "python3". Mirrors `pyocd_python`. */
  hil_python?: string;
```

Create `/home/matixan/GIT/crosspad-mcp/src/tool-result.ts`:

```ts
// src/tool-result.ts — the `{ success, ...data, error? }` envelope used by
// every crosspad_* tool (same shape as the private helpers in src/index.ts).
import { HilError } from "./hil/daemon.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/** Emit structuredContent in addition to text content. Clients with an
 *  outputSchema validate structuredContent; the LLM sees the same JSON in
 *  `content`. `success === false` sets `isError` per the MCP spec. */
export function jsonResponse(data: object): ToolResult {
  const rec = data as Record<string, unknown>;
  const result: ToolResult = {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: rec,
  };
  if (rec.success === false) result.isError = true;
  return result;
}

export function ok(data: Record<string, unknown> = {}): ToolResult {
  return jsonResponse({ success: true, ...data });
}

export function err(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return jsonResponse({ success: false, error: message, ...extra });
}

/** Uniform error envelope for thrown errors:
 *  `{ success: false, error: { code, message, hint? } }`. A HilError keeps its
 *  daemon-supplied code and hint; anything else becomes code "INTERNAL". */
export function errorResult(e: unknown): ToolResult {
  if (e instanceof HilError) {
    const error: Record<string, unknown> = { code: e.code, message: e.message };
    if (e.hint !== undefined) error.hint = e.hint;
    if (Object.keys(e.details).length > 0) error.details = e.details;
    return jsonResponse({ success: false, error });
  }
  const message = e instanceof Error ? e.message : String(e);
  return jsonResponse({ success: false, error: { code: "INTERNAL", message } });
}
```

- [ ] **Step 4: Write `src/hil/daemon.ts`**

Create `/home/matixan/GIT/crosspad-mcp/src/hil/daemon.ts`:

```ts
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
}

export interface RequestOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
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
  private readonly spawnFn: SpawnFn;

  constructor(private readonly opts: HilDaemonOpts) {
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
  }

  get alive(): boolean { return this.proc !== null; }

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
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: (v) => resolve(v as T),
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
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
```

- [ ] **Step 5: Run the daemon test**

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/hil/daemon.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6: Write the failing schemas test**

`/home/matixan/GIT/crosspad-mcp/src/hil/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  DeviceSchema, SnapshotSchema, ReplySchema, ReadResultSchema, ExpectResultSchema,
  BootResultSchema, TaskStatusSchema, DoctorCheckSchema, ScenarioInfoSchema,
} from "./schemas.js";

describe("hil schemas mirror the crosspad_hil contract dicts", () => {
  it("DeviceSchema accepts Device.to_dict() with null ports and extra keys", () => {
    const d = DeviceSchema.parse({
      id: "dev_3f2a", serial: "A1B2C3", usb_mode: "default", board_rev: null,
      ports: {
        cdc: { path: "/dev/ttyACM0", vid: 0x303a, pid: 0x3456, serial: "A1B2C3", product: "Crosspad", location: "1-3.2" },
        console: { path: "/dev/ttyACM1", vid: 0x0483, pid: 0x5740, serial: null, product: "CrossPad MIDI+Serial", location: "1-3.1" },
        esp_midi: { name: "Crosspad MIDI", rtmidi_out: 2, rtmidi_in: 2, alsa_hw: "hw:4,0,0", rawmidi: null },
        stm_midi: null, uac2: null, bootloader: null,
      },
      firmware: { version: "1.2.3" },
    });
    expect(d.id).toBe("dev_3f2a");
    expect(d.ports.cdc?.path).toBe("/dev/ttyACM0");
    expect(d.ports.uac2).toBeNull();
    expect((d as Record<string, unknown>).firmware).toEqual({ version: "1.2.3" });
  });

  it("DeviceSchema rejects an unknown usb_mode", () => {
    expect(() => DeviceSchema.parse({ id: "dev_1", serial: null, usb_mode: "dfu", ports: {}, board_rev: null })).toThrow();
  });

  it("SnapshotSchema accepts a snapshot with null sections", () => {
    const s = SnapshotSchema.parse({
      snapshot_id: "snap_41", device: "dev_3f2a", usb_mode: "default",
      apps: { running: "Sampler", available: ["Sampler"] }, ui: null, kit: { current: 3, name: "DRUMS", loading: false, pending: -1 },
      leds: null, pads: null, mem: null, ble: null, console: null, ts: 1756100000.5, changed: ["kit"],
    });
    expect(s.changed).toEqual(["kit"]);
    expect(s.ui).toBeNull();
  });

  it("ReplySchema accepts a CDC reply with and without parsed", () => {
    expect(ReplySchema.parse({ line: "OK", parsed: { kind: "ok" }, rtt_ms: 1.2, extra_lines: [] }).parsed).toEqual({ kind: "ok" });
    expect(ReplySchema.parse({ line: "WEIRD", parsed: null, rtt_ms: 1.2, extra_lines: ["x"] }).extra_lines).toEqual(["x"]);
  });

  it("ReadResultSchema accepts [seq, line] tuples", () => {
    const r = ReadResultSchema.parse({ lines: [[1, "I (10) boot"], [2, "I (11) main"]], next_seq: 3, lines_lost: 0 });
    expect(r.lines[1]).toEqual([2, "I (11) main"]);
  });

  it("ExpectResultSchema accepts a miss (all null)", () => {
    const r = ExpectResultSchema.parse({ hit: null, rejected: null, seq: null, context: [], elapsed_s: 30.0 });
    expect(r.hit).toBeNull();
  });

  it("BootResultSchema accepts the smoke result", () => {
    const b = BootResultSchema.parse({ complete: true, missing: [], fatal: [], errors: [{ seq: 5, line: "E (1) x" }], bootloops: 0, seconds: 12.3 });
    expect(b.complete).toBe(true);
  });

  it("TaskStatusSchema accepts working/completed/failed/cancelled", () => {
    expect(TaskStatusSchema.parse({ task: "task_1", status: "working", progress: 2, total: 10, message: "round 2/10" }).status).toBe("working");
    expect(TaskStatusSchema.parse({ task: "task_1", status: "completed", result: { passed: true } }).result).toEqual({ passed: true });
    expect(TaskStatusSchema.parse({ task: "task_1", status: "failed", error: { code: "TIMEOUT", message: "x" } }).error?.code).toBe("TIMEOUT");
    expect(() => TaskStatusSchema.parse({ task: "task_1", status: "running" })).toThrow();
  });

  it("DoctorCheckSchema and ScenarioInfoSchema", () => {
    expect(DoctorCheckSchema.parse({ name: "venv", ok: false, detail: "no crosspad_hil", fix: "pip install crosspad-hil[all]" }).ok).toBe(false);
    const s = ScenarioInfoSchema.parse({ name: "kit_churn", description: "swap kits while pads fire", params: [{ name: "rounds", type: "int", default: 20, help: "rounds" }] });
    expect(s.params[0].name).toBe("rounds");
  });
});
```

- [ ] **Step 7: Run the schemas test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/hil/schemas.test.ts`
Expected: FAIL with `Failed to load url ./schemas.js`.

- [ ] **Step 8: Write `src/hil/schemas.ts`**

Create `/home/matixan/GIT/crosspad-mcp/src/hil/schemas.ts`:

```ts
// src/hil/schemas.ts — zod mirrors of the crosspad_hil dataclasses / dicts
// (contract: devices.py, console.py, cdc.py, snapshot.py, serve.py). Every
// object is loose: the daemon may add keys and the TS side never rejects them.
import { z } from "zod";

const Rec = z.record(z.string(), z.unknown());

export const UsbModeSchema = z.enum(["default", "audio", "bootloader", "unknown"]);
export type UsbMode = z.infer<typeof UsbModeSchema>;

// devices.py SerialPortInfo
export const SerialPortInfoSchema = z.looseObject({
  path: z.string(),
  vid: z.number().int(),
  pid: z.number().int(),
  serial: z.string().nullable(),
  product: z.string().nullable(),
  location: z.string().nullable(),
});
export type SerialPortInfo = z.infer<typeof SerialPortInfoSchema>;

// devices.py MidiPortInfo
export const MidiPortInfoSchema = z.looseObject({
  name: z.string(),
  rtmidi_out: z.number().int().nullable(),
  rtmidi_in: z.number().int().nullable(),
  alsa_hw: z.string().nullable(),
  rawmidi: z.string().nullable(),
});
export type MidiPortInfo = z.infer<typeof MidiPortInfoSchema>;

// devices.py AudioCardInfo
export const AudioCardInfoSchema = z.looseObject({
  name: z.string(),
  sounddevice_index: z.number().int().nullable(),
  alsa_id: z.string().nullable(),
});
export type AudioCardInfo = z.infer<typeof AudioCardInfoSchema>;

// devices.py Ports — every role optional/null
export const PortsSchema = z.looseObject({
  cdc: SerialPortInfoSchema.nullable().optional(),
  console: SerialPortInfoSchema.nullable().optional(),
  esp_midi: MidiPortInfoSchema.nullable().optional(),
  stm_midi: MidiPortInfoSchema.nullable().optional(),
  uac2: AudioCardInfoSchema.nullable().optional(),
  bootloader: SerialPortInfoSchema.nullable().optional(),
});
export type Ports = z.infer<typeof PortsSchema>;

// devices.py Device.to_dict()
export const DeviceSchema = z.looseObject({
  id: z.string(),
  serial: z.string().nullable(),
  usb_mode: UsbModeSchema,
  ports: PortsSchema,
  board_rev: z.string().nullable().optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

// snapshot.py Snapshot.to_dict()
export const SnapshotSchema = z.looseObject({
  snapshot_id: z.string(),
  device: z.string(),
  usb_mode: z.string(),
  apps: Rec.nullable(),
  ui: Rec.nullable(),
  kit: Rec.nullable(),
  leds: Rec.nullable(),
  pads: Rec.nullable(),
  mem: Rec.nullable(),
  ble: Rec.nullable(),
  console: Rec.nullable(),
  ts: z.number(),
  changed: z.array(z.string()),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// cdc.py Reply
export const ReplySchema = z.looseObject({
  line: z.string(),
  parsed: Rec.nullable(),
  rtt_ms: z.number(),
  extra_lines: z.array(z.string()),
});
export type Reply = z.infer<typeof ReplySchema>;

// console.py ReadResult — lines: list[tuple[int, str]]
export const ReadResultSchema = z.looseObject({
  lines: z.array(z.tuple([z.number().int(), z.string()])),
  next_seq: z.number().int(),
  lines_lost: z.number().int(),
});
export type ReadResult = z.infer<typeof ReadResultSchema>;

// console.py ExpectResult
export const ExpectResultSchema = z.looseObject({
  hit: z.string().nullable(),
  rejected: z.string().nullable(),
  seq: z.number().int().nullable(),
  context: z.array(z.string()),
  elapsed_s: z.number(),
});
export type ExpectResult = z.infer<typeof ExpectResultSchema>;

// console.py BootResult
export const BootResultSchema = z.looseObject({
  complete: z.boolean(),
  missing: z.array(z.string()),
  fatal: z.array(Rec),
  errors: z.array(Rec),
  bootloops: z.number().int(),
  seconds: z.number(),
});
export type BootResult = z.infer<typeof BootResultSchema>;

// serve.py task.status
export const TaskErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  hint: z.string().nullable().optional(),
});
export const TaskStatusSchema = z.looseObject({
  task: z.string(),
  status: z.enum(["working", "completed", "failed", "cancelled"]),
  progress: z.number().nullable().optional(),
  total: z.number().nullable().optional(),
  message: z.string().nullable().optional(),
  result: z.unknown().optional(),
  error: TaskErrorSchema.optional(),
});
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// serve.py devices.doctor checks[]
export const DoctorCheckSchema = z.looseObject({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  fix: z.string().nullable().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

// serve.py scenario.list scenarios[]
export const ScenarioParamSchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  default: z.unknown().optional(),
  help: z.string().nullable().optional(),
});
export const ScenarioInfoSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  params: z.array(ScenarioParamSchema),
});
export type ScenarioInfo = z.infer<typeof ScenarioInfoSchema>;
```

- [ ] **Step 9: Run both tests and the type-check**

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/hil && npx tsc --noEmit`
Expected: PASS (daemon 14 tests, schemas 9 tests); `tsc` prints nothing.

- [ ] **Step 10: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add src/hil/daemon.ts src/hil/daemon.test.ts src/hil/schemas.ts src/hil/schemas.test.ts src/tool-result.ts src/utils/userConfig.ts && git commit -m "feat(hil): HilDaemon NDJSON proxy, contract schemas, hil_python config key"
```

---

### Task 2: HandleRegistry, JobRegistry (with daemon-task mirror) and `crosspad_task`

**Files:**
- Create: `/home/matixan/GIT/crosspad-mcp/src/handles.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/src/tasks.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/src/tool-context.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/src/tools/task.ts`
- Test: `/home/matixan/GIT/crosspad-mcp/src/handles.test.ts`
- Test: `/home/matixan/GIT/crosspad-mcp/src/tasks.test.ts`
- Test: `/home/matixan/GIT/crosspad-mcp/src/tools/task.test.ts`

**Interfaces:**
- Consumes: `HilDaemon.request()` and `HilError` (Task 1); `TaskStatusSchema` (Task 1); daemon ops verbatim from the contract: `task.status {task}`, `task.cancel {task}` → `{"ok"}`; `jsonResponse`/`errorResult` from `src/tool-result.ts`. **Step 7 onward** (the `crosspad_task` tool) also consumes `Policy` + `decide(policy, tool, args): Decision` from `src/policy/policy.ts` and `requireConfirmation(server, extra, tool, args, summary)` from `src/policy/confirm.ts` (chunk C2). If those files do not exist yet when you reach Step 7, finish Steps 1–6, commit, and return to Step 7 after C2's policy/confirm tasks land.
- Produces:
  - `src/handles.ts`: `export type HandleKind = "console"|"cdc"|"task"|"snapshot"`; `export interface HandleMeta { kind: HandleKind; device?: string; createdAt: number; lastTouch: number }`; `export class HandleRegistry { register(handle, meta: {kind, device?}): void; get(handle): HandleMeta|undefined; touch(handle): void; drop(handle): void; list(): Array<HandleMeta & {handle: string}> }` (`list()` sorted by handle); `export const handles = new HandleRegistry()`. Constructor takes an optional `now: () => number` (default `Date.now`) for tests.
  - `src/tasks.ts`: `export type JobState = "working"|"completed"|"failed"|"cancelled"`; `export interface JobStatus { task: string; kind: string; status: JobState; progress?: number; total?: number; message?: string; result?: unknown; error?: {code: string; message: string}; startedAt: number; finishedAt?: number }`; `export type ProgressFn = (p: number, total: number|undefined, msg: string) => void`; `export type JobRun = (signal: AbortSignal, progress: ProgressFn) => Promise<unknown>`; `export class JobRegistry { constructor(opts?: {retentionMs?: number; now?: () => number}); create(kind: string, run: JobRun): string; status(id: string): JobStatus; wait(id: string, timeoutMs: number): Promise<JobStatus>; cancel(id: string): boolean; list(): JobStatus[]; mirror(daemon: DaemonLike, daemonTask: string, kind: string, pollIntervalMs?: number): string }` where `export interface DaemonLike { request<T = unknown>(op: string, args: Record<string, unknown>, opts?: {signal?: AbortSignal; timeoutMs?: number}): Promise<T> }`; `export const jobs = new JobRegistry()`. Ids are `"task_<n>"` (n from 1). `status()` on an unknown/expired id throws `HilError("HANDLE_EXPIRED", …)`. Retention: 1 h (3 600 000 ms) after `finishedAt`, via an unref'd `setTimeout`. `cancel()` returns `false` when the job is already terminal or unknown. The mirror keeps the daemon's own `task_N` as `meta.daemon_task` in the status message chain: the TS job id is minted locally (`task_M`) and the daemon id is stored in `JobStatus.result`-independent field `daemonTask?: string` (added to `JobStatus`, optional).
  - `src/tool-context.ts`: `export interface ToolContext { daemon: () => HilDaemon; policy: Policy; jobs: JobRegistry; handles: HandleRegistry }`.
  - `src/tools/task.ts`: `export function registerTaskTool(server: McpServer, ctx: ToolContext): RegisteredTool` registering `crosspad_task` with `inputSchema = z.discriminatedUnion("action", [status{task}, wait{task, timeout_ms?=30000 (max 600000)}, cancel{task}, list{}])`, `outputSchema` = `{success, task?: JobStatus-shape, tasks?: JobStatus[], error?}`, annotations `{readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}` for the tool as a whole (tier `read` — cancel is a benign stop of our own job; chunk C2's `TOOL_TIERS.crosspad_task` must also be `"read"`).

- [ ] **Step 1: Write the failing handles test**

`/home/matixan/GIT/crosspad-mcp/src/handles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HandleRegistry, handles } from "./handles.js";

describe("HandleRegistry", () => {
  it("registers, gets, touches, drops", () => {
    let t = 1000;
    const r = new HandleRegistry(() => t);
    r.register("con_1", { kind: "console", device: "dev_3f2a" });
    expect(r.get("con_1")).toEqual({ kind: "console", device: "dev_3f2a", createdAt: 1000, lastTouch: 1000 });
    t = 2000;
    r.touch("con_1");
    expect(r.get("con_1")?.lastTouch).toBe(2000);
    expect(r.get("con_1")?.createdAt).toBe(1000);
    r.drop("con_1");
    expect(r.get("con_1")).toBeUndefined();
  });

  it("touch/drop of an unknown handle are no-ops", () => {
    const r = new HandleRegistry();
    expect(() => r.touch("nope")).not.toThrow();
    expect(() => r.drop("nope")).not.toThrow();
  });

  it("re-registering replaces meta", () => {
    const r = new HandleRegistry(() => 5);
    r.register("snap_1", { kind: "snapshot", device: "dev_1" });
    r.register("snap_1", { kind: "snapshot", device: "dev_2" });
    expect(r.get("snap_1")?.device).toBe("dev_2");
    expect(r.list()).toHaveLength(1);
  });

  it("list() is sorted by handle and carries the handle", () => {
    const r = new HandleRegistry(() => 1);
    r.register("task_2", { kind: "task" });
    r.register("cdc_1", { kind: "cdc", device: "dev_1" });
    r.register("con_1", { kind: "console", device: "dev_1" });
    expect(r.list().map((h) => h.handle)).toEqual(["cdc_1", "con_1", "task_2"]);
    expect(r.list()[0]).toMatchObject({ handle: "cdc_1", kind: "cdc", device: "dev_1" });
  });

  it("exports a shared instance", () => {
    expect(handles).toBeInstanceOf(HandleRegistry);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/handles.test.ts`
Expected: FAIL with `Failed to load url ./handles.js`.

- [ ] **Step 3: Write `src/handles.ts`**

```ts
// src/handles.ts — the TS-side view of handles (con_*, cdc_*, task_*, snap_*).
// The daemon owns device-side handles; this registry only tracks what this
// server minted or was given, so `crosspad://workspace` and expiry messages
// can name them. Single module, no globals inside tools (spec §3.7).
export type HandleKind = "console" | "cdc" | "task" | "snapshot";

export interface HandleMeta {
  kind: HandleKind;
  device?: string;
  createdAt: number;
  lastTouch: number;
}

export class HandleRegistry {
  private map = new Map<string, HandleMeta>();
  constructor(private readonly now: () => number = Date.now) {}

  register(handle: string, meta: { kind: HandleKind; device?: string }): void {
    const t = this.now();
    const m: HandleMeta = { kind: meta.kind, createdAt: t, lastTouch: t };
    if (meta.device !== undefined) m.device = meta.device;
    this.map.set(handle, m);
  }

  get(handle: string): HandleMeta | undefined {
    const m = this.map.get(handle);
    return m ? { ...m } : undefined;
  }

  touch(handle: string): void {
    const m = this.map.get(handle);
    if (m) m.lastTouch = this.now();
  }

  drop(handle: string): void {
    this.map.delete(handle);
  }

  list(): Array<HandleMeta & { handle: string }> {
    return [...this.map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([handle, m]) => ({ handle, ...m }));
  }
}

export const handles = new HandleRegistry();
```

- [ ] **Step 4: Run handles test**

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/handles.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing tasks test**

`/home/matixan/GIT/crosspad-mcp/src/tasks.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JobRegistry, jobs, type DaemonLike } from "./tasks.js";
import { HilError } from "./hil/daemon.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("JobRegistry lifecycle", () => {
  it("mints task_N ids and moves working → completed with the result", async () => {
    const r = new JobRegistry();
    const d = deferred<{ passed: boolean }>();
    const id = r.create("hil_run", async (_signal, progress) => { progress(1, 4, "round 1/4"); return d.promise; });
    expect(id).toBe("task_1");
    expect(r.create("build", async () => "x")).toBe("task_2");
    await Promise.resolve();
    expect(r.status(id)).toMatchObject({ task: "task_1", kind: "hil_run", status: "working", progress: 1, total: 4, message: "round 1/4" });
    d.resolve({ passed: true });
    const s = await r.wait(id, 1000);
    expect(s.status).toBe("completed");
    expect(s.result).toEqual({ passed: true });
    expect(typeof s.finishedAt).toBe("number");
  });

  it("a throwing run → failed with error {code,message}; HilError keeps its code", async () => {
    const r = new JobRegistry();
    const a = r.create("flash", async () => { throw new HilError("FLASH_FAILED", "OTA_ERROR at 40%", "retry"); });
    const b = r.create("flash", async () => { throw new Error("plain"); });
    expect(await r.wait(a, 1000)).toMatchObject({ status: "failed", error: { code: "FLASH_FAILED", message: "OTA_ERROR at 40%" } });
    expect(await r.wait(b, 1000)).toMatchObject({ status: "failed", error: { code: "INTERNAL", message: "plain" } });
  });

  it("wait() times out and returns the current (still working) status", async () => {
    const r = new JobRegistry();
    const d = deferred<void>();
    const id = r.create("capture", async () => d.promise);
    const s = await r.wait(id, 20);
    expect(s.status).toBe("working");
    d.resolve();
    expect((await r.wait(id, 1000)).status).toBe("completed");
  });

  it("cancel() aborts the signal; a run that honours it ends cancelled", async () => {
    const r = new JobRegistry();
    let aborted = false;
    const id = r.create("stimulus", (signal) => new Promise((_res, rej) => {
      signal.addEventListener("abort", () => { aborted = true; rej(new HilError("CANCELLED", "stopped")); });
    }));
    expect(r.cancel(id)).toBe(true);
    const s = await r.wait(id, 1000);
    expect(aborted).toBe(true);
    expect(s.status).toBe("cancelled");
    expect(r.cancel(id)).toBe(false);
  });

  it("a run that resolves after cancel is still reported cancelled", async () => {
    const r = new JobRegistry();
    const d = deferred<string>();
    const id = r.create("build", async () => d.promise);
    r.cancel(id);
    d.resolve("done anyway");
    const s = await r.wait(id, 1000);
    expect(s.status).toBe("cancelled");
    expect(s.result).toBeUndefined();
  });

  it("cancel/status of an unknown id", () => {
    const r = new JobRegistry();
    expect(r.cancel("task_99")).toBe(false);
    expect(() => r.status("task_99")).toThrow(HilError);
    try { r.status("task_99"); } catch (e) { expect((e as HilError).code).toBe("HANDLE_EXPIRED"); }
  });

  it("list() returns every job newest last", async () => {
    const r = new JobRegistry();
    r.create("a", async () => 1);
    r.create("b", async () => 2);
    expect(r.list().map((j) => j.task)).toEqual(["task_1", "task_2"]);
  });

  it("exports a shared instance", () => {
    expect(jobs).toBeInstanceOf(JobRegistry);
  });
});

describe("JobRegistry retention (1 h)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("forgets a finished job 1 h after finishedAt, keeps working ones", async () => {
    const r = new JobRegistry();
    const done = r.create("build", async () => 1);
    const d = deferred<void>();
    const live = r.create("capture", async () => d.promise);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status(done).status).toBe("completed");
    await vi.advanceTimersByTimeAsync(3_600_000 - 2);
    expect(() => r.status(done)).not.toThrow();
    await vi.advanceTimersByTimeAsync(5);
    expect(() => r.status(done)).toThrow(HilError);
    expect(r.status(live).status).toBe("working");
    expect(r.list().map((j) => j.task)).toEqual([live]);
    d.resolve();
  });
});

describe("JobRegistry.mirror — daemon-side tasks", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function fakeDaemon(statuses: Array<Record<string, unknown>>): DaemonLike & { calls: Array<[string, Record<string, unknown>]> } {
    const calls: Array<[string, Record<string, unknown>]> = [];
    let i = 0;
    return {
      calls,
      async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
        calls.push([op, args]);
        if (op === "task.status") { const s = statuses[Math.min(i, statuses.length - 1)]; i++; return s as T; }
        if (op === "task.cancel") return { ok: true } as T;
        throw new Error("unexpected op " + op);
      },
    };
  }

  it("polls task.status every 500 ms, forwards progress, completes with the daemon result", async () => {
    const daemon = fakeDaemon([
      { task: "task_9", status: "working", progress: 1, total: 3, message: "round 1/3" },
      { task: "task_9", status: "working", progress: 2, total: 3, message: "round 2/3" },
      { task: "task_9", status: "completed", progress: 3, total: 3, message: "done", result: { passed: true, summary: "ok" } },
    ]);
    const r = new JobRegistry();
    const id = r.mirror(daemon, "task_9", "hil_run");
    expect(id).toBe("task_1");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status(id)).toMatchObject({ status: "working", progress: 1, total: 3, message: "round 1/3", daemonTask: "task_9" });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.status(id)).toMatchObject({ status: "working", progress: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(r.status(id)).toMatchObject({ status: "completed", result: { passed: true, summary: "ok" } });
    expect(daemon.calls.filter(([op]) => op === "task.status")).toHaveLength(3);
    expect(daemon.calls[0]).toEqual(["task.status", { task: "task_9" }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(daemon.calls.filter(([op]) => op === "task.status")).toHaveLength(3);
  });

  it("maps a daemon failure to failed with its error", async () => {
    const daemon = fakeDaemon([{ task: "task_9", status: "failed", error: { code: "NO_DEVICE", message: "no CrossPad found" } }]);
    const r = new JobRegistry();
    const id = r.mirror(daemon, "task_9", "hil_run");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status(id)).toMatchObject({ status: "failed", error: { code: "NO_DEVICE", message: "no CrossPad found" } });
  });

  it("cancel() forwards task.cancel to the daemon and ends cancelled", async () => {
    const daemon = fakeDaemon([
      { task: "task_9", status: "working", progress: 0, total: 3 },
      { task: "task_9", status: "cancelled" },
    ]);
    const r = new JobRegistry();
    const id = r.mirror(daemon, "task_9", "hil_run");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.cancel(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(daemon.calls.some(([op, a]) => op === "task.cancel" && a.task === "task_9")).toBe(true);
    expect(r.status(id).status).toBe("cancelled");
  });

  it("a daemon that dies mid-poll fails the mirrored job with DAEMON_DIED", async () => {
    const daemon: DaemonLike = {
      async request<T>(): Promise<T> { throw new HilError("DAEMON_DIED", "daemon exited with code 1", "Traceback"); },
    };
    const r = new JobRegistry();
    const id = r.mirror(daemon, "task_9", "hil_run");
    await vi.advanceTimersByTimeAsync(1);
    expect(r.status(id)).toMatchObject({ status: "failed", error: { code: "DAEMON_DIED" } });
  });
});
```

- [ ] **Step 6: Run to verify it fails, then write `src/tasks.ts`**

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/tasks.test.ts`
Expected: FAIL with `Failed to load url ./tasks.js`.

Create `/home/matixan/GIT/crosspad-mcp/src/tasks.ts`:

```ts
// src/tasks.ts — one job registry for every long operation (build, flash,
// hil_run, capture, stimulus, submodule_update). Reachable through the SDK
// tasks capability when the client has it, and through `crosspad_task`
// otherwise — identical handle, identical states (spec §3.5). Results are
// retained 1 h after the terminal state. Daemon-side tasks are mirrored by a
// local job that polls `task.status` every 500 ms and forwards `task.cancel`.
import { HilError } from "./hil/daemon.js";
import { TaskStatusSchema } from "./hil/schemas.js";

export type JobState = "working" | "completed" | "failed" | "cancelled";

export interface JobStatus {
  task: string;
  kind: string;
  status: JobState;
  progress?: number;
  total?: number;
  message?: string;
  result?: unknown;
  error?: { code: string; message: string };
  startedAt: number;
  finishedAt?: number;
  /** For mirrored jobs: the daemon's own task handle (e.g. "task_9"). */
  daemonTask?: string;
}

export type ProgressFn = (p: number, total: number | undefined, msg: string) => void;
export type JobRun = (signal: AbortSignal, progress: ProgressFn) => Promise<unknown>;

export interface DaemonLike {
  request<T = unknown>(op: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
}

interface Job {
  status: JobStatus;
  controller: AbortController;
  waiters: Array<() => void>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  /** Mirror-only: extra work on cancel (forward to the daemon). */
  onCancel?: () => void;
}

export const RETENTION_MS = 3_600_000;
export const POLL_INTERVAL_MS = 500;

export class JobRegistry {
  private jobs = new Map<string, Job>();
  private seq = 1;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(opts: { retentionMs?: number; now?: () => number } = {}) {
    this.retentionMs = opts.retentionMs ?? RETENTION_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Start `run` immediately; returns "task_N". */
  create(kind: string, run: JobRun): string {
    const id = `task_${this.seq++}`;
    const controller = new AbortController();
    const job: Job = {
      status: { task: id, kind, status: "working", startedAt: this.now() },
      controller,
      waiters: [],
    };
    this.jobs.set(id, job);
    const progress: ProgressFn = (p, total, msg) => {
      if (job.status.status !== "working") return;
      job.status.progress = p;
      if (total !== undefined) job.status.total = total;
      job.status.message = msg;
    };
    Promise.resolve()
      .then(() => run(controller.signal, progress))
      .then(
        (result) => {
          if (controller.signal.aborted) this.finish(job, "cancelled");
          else { job.status.result = result; this.finish(job, "completed"); }
        },
        (e: unknown) => {
          if (controller.signal.aborted) this.finish(job, "cancelled");
          else {
            job.status.error = e instanceof HilError
              ? { code: e.code, message: e.message }
              : { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
            this.finish(job, "failed");
          }
        },
      );
    return id;
  }

  /** Mirror a daemon task ("task_N" from scenario.run / ota.flash) as a local job. */
  mirror(daemon: DaemonLike, daemonTask: string, kind: string, pollIntervalMs: number = POLL_INTERVAL_MS): string {
    const id = this.create(kind, (signal, progress) => new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const poll = async (): Promise<void> => {
        let st;
        try {
          const raw = await daemon.request("task.status", { task: daemonTask });
          st = TaskStatusSchema.parse(raw);
        } catch (e) {
          reject(e);
          return;
        }
        if (typeof st.progress === "number") {
          progress(st.progress, typeof st.total === "number" ? st.total : undefined, st.message ?? "");
        }
        if (st.status === "completed") { resolve(st.result); return; }
        if (st.status === "failed") {
          reject(new HilError(st.error?.code ?? "TASK_FAILED", st.error?.message ?? `daemon task ${daemonTask} failed`, st.error?.hint ?? undefined));
          return;
        }
        if (st.status === "cancelled") { reject(new HilError("CANCELLED", `daemon task ${daemonTask} cancelled`)); return; }
        timer = setTimeout(() => { void poll(); }, pollIntervalMs);
      };
      signal.addEventListener("abort", () => {
        // Keep polling after forwarding the cancel so the final daemon state
        // (cancelled) is observed; the registry marks us cancelled either way.
        daemon.request("task.cancel", { task: daemonTask }).catch(() => {});
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        void poll();
      }, { once: true });
      void poll();
    }));
    const job = this.jobs.get(id)!;
    job.status.daemonTask = daemonTask;
    return id;
  }

  status(id: string): JobStatus {
    const job = this.jobs.get(id);
    if (!job) {
      throw new HilError("HANDLE_EXPIRED", `unknown task ${id}`, "task results are kept 1 h after completion; use crosspad_task action=list", { task: id });
    }
    return { ...job.status };
  }

  /** Resolve when the job reaches a terminal state, or after timeoutMs with
   *  whatever the status is then (the caller checks `.status`). */
  wait(id: string, timeoutMs: number): Promise<JobStatus> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new HilError("HANDLE_EXPIRED", `unknown task ${id}`, "task results are kept 1 h after completion; use crosspad_task action=list", { task: id }));
    if (job.status.status !== "working") return Promise.resolve({ ...job.status });
    return new Promise<JobStatus>((resolve) => {
      const timer = setTimeout(() => {
        const i = job.waiters.indexOf(done);
        if (i >= 0) job.waiters.splice(i, 1);
        resolve({ ...job.status });
      }, timeoutMs);
      const done = (): void => { clearTimeout(timer); resolve({ ...job.status }); };
      job.waiters.push(done);
    });
  }

  /** Abort a working job. false when unknown or already terminal. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status.status !== "working") return false;
    job.controller.abort();
    return true;
  }

  list(): JobStatus[] {
    return [...this.jobs.values()].map((j) => ({ ...j.status }));
  }

  private finish(job: Job, state: JobState): void {
    if (job.status.status !== "working") return;
    job.status.status = state;
    job.status.finishedAt = this.now();
    const waiters = job.waiters;
    job.waiters = [];
    for (const w of waiters) w();
    job.retentionTimer = setTimeout(() => { this.jobs.delete(job.status.task); }, this.retentionMs);
    if (typeof job.retentionTimer === "object" && "unref" in job.retentionTimer) job.retentionTimer.unref();
  }
}

export const jobs = new JobRegistry();
```

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/tasks.test.ts`
Expected: PASS (13 tests).

Commit this half so the registries land independently of the policy chunk:

```bash
cd /home/matixan/GIT/crosspad-mcp && git add src/handles.ts src/handles.test.ts src/tasks.ts src/tasks.test.ts && git commit -m "feat(tasks): HandleRegistry and JobRegistry with 1 h retention and daemon-task mirror"
```

- [ ] **Step 7: Write `src/tool-context.ts` and the failing `crosspad_task` tool test**

Prerequisite: `src/policy/policy.ts` (exports `Policy`, `decide`) and `src/policy/confirm.ts` (exports `requireConfirmation`) from chunk C2 exist. Check with `ls /home/matixan/GIT/crosspad-mcp/src/policy/`.

Create `/home/matixan/GIT/crosspad-mcp/src/tool-context.ts`:

```ts
// src/tool-context.ts — everything a tool module needs, passed explicitly
// (no module-level globals inside tools — spec §3.7).
import type { HilDaemon } from "./hil/daemon.js";
import type { Policy } from "./policy/policy.js";
import type { JobRegistry } from "./tasks.js";
import type { HandleRegistry } from "./handles.js";

export interface ToolContext {
  daemon: () => HilDaemon;
  policy: Policy;
  jobs: JobRegistry;
  handles: HandleRegistry;
}
```

`/home/matixan/GIT/crosspad-mcp/src/tools/task.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTaskTool } from "./task.js";
import { JobRegistry } from "../tasks.js";
import { HandleRegistry } from "../handles.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";

async function harness(policy: Policy = { mode: "strict", rules: [] }) {
  const server = new McpServer({ name: "t", version: "0" });
  const jobs = new JobRegistry();
  const ctx: ToolContext = {
    daemon: () => { throw new Error("no daemon in this test"); },
    policy,
    jobs,
    handles: new HandleRegistry(),
  };
  const tool = registerTaskTool(server, ctx);
  const client = new Client({ name: "c", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "crosspad_task", arguments: args });
    return { r, sc: r.structuredContent as Record<string, unknown> };
  };
  return { server, client, jobs, ctx, tool, call };
}

describe("crosspad_task", () => {
  it("is registered with read-only annotations and a discriminated action schema", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "crosspad_task")!;
    expect(t).toBeDefined();
    expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(JSON.stringify(t.inputSchema)).toContain('"status"');
    expect(JSON.stringify(t.inputSchema)).toContain('"wait"');
    expect(JSON.stringify(t.inputSchema)).toContain('"cancel"');
    expect(JSON.stringify(t.inputSchema)).toContain('"list"');
  });

  it("status → the job status", async () => {
    const { jobs, call } = await harness();
    const id = jobs.create("build", async (_s, p) => { p(3, 10, "[3/10]"); return new Promise(() => {}); });
    await new Promise((r) => setTimeout(r, 1));
    const { sc } = await call({ action: "status", task: id });
    expect(sc.success).toBe(true);
    expect(sc.task).toMatchObject({ task: id, kind: "build", status: "working", progress: 3, total: 10, message: "[3/10]" });
  });

  it("wait → completed result; timeout returns working", async () => {
    const { jobs, call } = await harness();
    const fast = jobs.create("flash", async () => ({ bytes: 100 }));
    const { sc } = await call({ action: "wait", task: fast, timeout_ms: 1000 });
    expect(sc.task).toMatchObject({ status: "completed", result: { bytes: 100 } });
    const slow = jobs.create("capture", async () => new Promise(() => {}));
    const { sc: sc2 } = await call({ action: "wait", task: slow, timeout_ms: 10 });
    expect(sc2.task).toMatchObject({ status: "working" });
  });

  it("cancel → aborts; second cancel reports cancelled=false", async () => {
    const { jobs, call } = await harness();
    const id = jobs.create("stimulus", (signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("stop")))));
    const { sc } = await call({ action: "cancel", task: id });
    expect(sc.success).toBe(true);
    expect(sc.cancelled).toBe(true);
    expect(await jobs.wait(id, 1000)).toMatchObject({ status: "cancelled" });
    const { sc: sc2 } = await call({ action: "cancel", task: id });
    expect(sc2.cancelled).toBe(false);
  });

  it("list → every job", async () => {
    const { jobs, call } = await harness();
    jobs.create("a", async () => 1);
    jobs.create("b", async () => 2);
    const { sc } = await call({ action: "list" });
    expect((sc.tasks as Array<{ task: string }>).map((t) => t.task)).toEqual(["task_1", "task_2"]);
  });

  it("unknown task → isError with HANDLE_EXPIRED envelope", async () => {
    const { call } = await harness();
    const { r, sc } = await call({ action: "status", task: "task_404" });
    expect(r.isError).toBe(true);
    expect(sc.success).toBe(false);
    expect(sc.error).toMatchObject({ code: "HANDLE_EXPIRED" });
    expect((sc.error as { hint: string }).hint).toContain("1 h");
  });

  it("stays visible under readonly policy (read tier)", async () => {
    const { client } = await harness({ mode: "readonly", rules: [] });
    const { tools } = await client.listTools();
    expect(tools.some((x) => x.name === "crosspad_task")).toBe(true);
  });
});
```

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/tools/task.test.ts`
Expected: FAIL with `Failed to load url ./task.js`.

- [ ] **Step 8: Write `src/tools/task.ts`**

```ts
// src/tools/task.ts — crosspad_task {action: status|wait|cancel|list}: the
// fallback for clients without the tasks capability (spec §3.1/§3.5). Same
// registry, same handles, same states as the SDK task path.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResponse, errorResult, type ToolResult } from "../tool-result.js";
import { decide } from "../policy/policy.js";
import { requireConfirmation } from "../policy/confirm.js";

const TOOL = "crosspad_task";

const TaskId = z.string().regex(/^task_\d+$/, "task handle looks like task_<n>").describe("Task handle returned by a long-running tool (task_<n>)");

const InputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), task: TaskId }),
  z.object({
    action: z.literal("wait"),
    task: TaskId,
    timeout_ms: z.number().int().min(0).max(600_000).default(30_000).describe("How long to block before returning the current status (max 600000)"),
  }),
  z.object({ action: z.literal("cancel"), task: TaskId }),
  z.object({ action: z.literal("list") }),
]);

const JobStatusOut = z.object({
  task: z.string(),
  kind: z.string(),
  status: z.enum(["working", "completed", "failed", "cancelled"]),
  progress: z.number().optional(),
  total: z.number().optional(),
  message: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  daemonTask: z.string().optional(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  task: JobStatusOut.optional(),
  tasks: z.array(JobStatusOut).optional(),
  cancelled: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export function registerTaskTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL,
    {
      description: "Poll, wait on, cancel or list long-running crosspad tasks (build, flash, hil_run, capture, stimulus, submodule_update). Task handles are task_<n>; results are kept 1 h after completion. Use this when your client does not support the MCP tasks capability.",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra): Promise<ToolResult> => {
      const argRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL, argRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "POLICY_HIDDEN", message: `${TOOL} is hidden by the current policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(server, extra, TOOL, argRec, `${TOOL} ${args.action}${"task" in args ? " " + args.task : ""}`);
        if (c.status === "token") return c.result as ToolResult;
        if (c.status === "declined") {
          return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: "confirmation declined" } });
        }
      }
      try {
        switch (args.action) {
          case "status":
            return jsonResponse({ success: true, task: ctx.jobs.status(args.task) });
          case "wait":
            return jsonResponse({ success: true, task: await ctx.jobs.wait(args.task, args.timeout_ms) });
          case "cancel": {
            const cancelled = ctx.jobs.cancel(args.task);
            return jsonResponse({ success: true, cancelled, task: ctx.jobs.status(args.task) });
          }
          case "list":
            return jsonResponse({ success: true, tasks: ctx.jobs.list() });
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
```

- [ ] **Step 9: Run the tool test and the whole suite plus type-check**

Run: `cd /home/matixan/GIT/crosspad-mcp && npm test -- src/tools/task.test.ts && npm test && npx tsc --noEmit`
Expected: `task.test.ts` PASS (7 tests); full suite PASS; `tsc` prints nothing.

If `tsc` complains that `extra` does not match `requireConfirmation`'s `RequestHandlerExtra` parameter, import the type and cast at the call site: `extra as RequestHandlerExtra<ServerRequest, ServerNotification>` from `@modelcontextprotocol/sdk/shared/protocol.js` / `@modelcontextprotocol/sdk/types.js`.

- [ ] **Step 10: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add src/tool-context.ts src/tools/task.ts src/tools/task.test.ts && git commit -m "feat(tools): crosspad_task status/wait/cancel/list over the shared JobRegistry"
```
# Plan C — chunk C2: policy engine, confirmation, toolsets, registry, index restructure

Repo: `/home/matixan/GIT/crosspad-mcp` (TypeScript ESM, strict, `@modelcontextprotocol/sdk` 1.29.0, zod 4, vitest 4).
All commands run from `/home/matixan/GIT/crosspad-mcp`. Node 22 is required for vitest 4:

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22
```

Conventions copied from the existing code (read `src/index.ts` lines 119–149 and 197–207 before starting): every tool result is `{content:[{type:"text", text: JSON}], structuredContent, isError?}` produced by `jsonResponse()`; annotations are plain objects `{readOnlyHint, destructiveHint, idempotentHint, openWorldHint}`; tests live next to sources as `src/**/*.test.ts` (vitest config `include: ["src/**/*.test.ts"]`, `restoreMocks: true`).

Contract sections used here (verbatim names): `Tier`, `TOOL_TIERS`, `annotationsFor`, `tierOf`, `PolicyMode`, `PolicyRule`, `Policy`, `loadPolicy`, `Decision`, `decide`, `mintToken`, `verifyToken`, `requireConfirmation`, `TOOLSETS`, `ToolsetManager`, `ToolContext`, `registerAll`.

Dependencies on other chunks (types only until Task 4 Step 9 wires `index.ts`):
- `src/hil/daemon.ts` → `HilDaemon`, `getHilDaemon()` (chunk C1, Task 1)
- `src/handles.ts` → `HandleRegistry`, `handles` (chunk C1, Task 2)
- `src/tasks.ts` → `JobRegistry`, `jobs` (chunk C3)
Task 3 has **no** dependency on them. Task 4 Steps 1–8 have none either; Step 9 (`index.ts`) imports the three value singletons, so run Task 4 Step 9 after C1 Task 1–2 and C3's `tasks.ts` exist (or stub them locally with the exact exported names for the day).

---

### Task 3: Policy engine — tiers, policy file, confirmation tokens + elicitation

**Files:**
- Create: `src/response.ts` (shared `jsonResponse`/`ok`/`err`/`errorResult` — lifted verbatim from `src/index.ts:125-149`, plus the v10 `{code,message,hint}` variant)
- Create: `src/policy/tiers.ts`
- Create: `src/policy/policy.ts`
- Create: `src/policy/confirm.ts`
- Test: `src/policy/tiers.test.ts`, `src/policy/policy.test.ts`, `src/policy/confirm.test.ts`

**Interfaces:**
- Consumes: `McpServer` (`@modelcontextprotocol/sdk/server/mcp.js`), `RequestHandlerExtra<ServerRequest, ServerNotification>` (`@modelcontextprotocol/sdk/shared/protocol.js`), `CallToolResult` (`@modelcontextprotocol/sdk/types.js`), `server.server.getClientCapabilities()`, `server.server.elicitInput({message, requestedSchema})` → `{action: "accept"|"decline"|"cancel", content?}`.
- Produces:
  - `src/response.ts`: `export function jsonResponse(data: object): CallToolResult`, `export function ok(data?: Record<string,unknown>)`, `export function err(message: string, extra?: Record<string,unknown>)` (legacy string error, identical to index.ts), `export function errorResult(code: string, message: string, hint?: string, extra?: Record<string,unknown>): CallToolResult` → `{isError:true, content:[text JSON], structuredContent:{success:false, error:{code,message,hint}, ...extra}}`.
  - `src/policy/tiers.ts`: `export type Tier = "read"|"stimulus"|"mutate-host"|"danger"`; `export const TOOL_TIERS: Record<string, Tier | ((args: Record<string,unknown>) => Tier)>`; `export function tierOf(tool: string, args: Record<string,unknown>): Tier` (unknown tool → `"danger"`, the safe default — **chosen here, contract silent**); `export function annotationsFor(tier: Tier): {readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean}`.
  - `src/policy/policy.ts`: `PolicyMode`, `PolicyRule`, `Policy`, `loadPolicy(opts?)`, `Decision`, `decide(policy, tool, args)`, plus `export const DEFAULT_POLICY_FILE` and `export function ruleMatches(rule: PolicyRule, tool: string, args: Record<string,unknown>): boolean`. Env override for the file path: `CROSSPAD_MCP_POLICY_FILE` (**chosen here**, so tests can point at a temp file without touching `~/.config`).
  - `src/policy/confirm.ts`: `mintToken`, `verifyToken`, `requireConfirmation`, `export const CONFIRM_TTL_S = 120`, `export function canonicalJson(value: unknown): string`, `export function confirmationDeclined(tool: string): CallToolResult` (error code `CANCELLED_BY_USER`, spec §4.2), `export function policyDenied(tool: string, mode: PolicyMode): CallToolResult` (error code `POLICY_DENIED`), and the one-call guard every tool callback uses: `export async function enforce(server: McpServer, extra: RequestHandlerExtra<ServerRequest, ServerNotification>, policy: Policy, tool: string, args: Record<string,unknown>, summary: string): Promise<CallToolResult | null>` (null = proceed; otherwise return that result).

Arg-dependent tiers (contract + choices stated):
| tool | rule |
|---|---|
| `crosspad_build` | `mode` ∈ {`fullclean`,`clean`} → `mutate-host`; otherwise (`incremental`, `reconfigure`, missing) → `stimulus` (**chosen**: a build writes only under `build/`, non-destructive, idempotent) |
| `crosspad_cdc` | `verb` ∈ {`bootloader_request`,`stm_dfu`} → `danger`; `verb === "system"` with `op` ∈ same set → `danger`; `verb === "raw"` with `cmd` starting (case-insensitive) with `BOOTLOADER_REQUEST`, `STM_DFU`, `OTA_BEGIN` or `OTA_DELTA` → `danger`; `verb` ∈ {`mem`,`led`} or `verb` in the read-only verb list `app_list`,`app_versions`,`kit_list`,`kit_status`,`pad_stats`,`pad_notes`,`pad_info`,`enc_group`,`enc_focus`,`enc_state`,`ui_state`,`led_state`,`mem`,`mem_blocks`,`cdc_stats`,`audio_level`,`smpl_peak`,`ble_status`,`ble_devices` → `read`; anything else → `stimulus` |
| `crosspad_flash` | always `danger` |
| `crosspad_trace` | `action` ∈ {`write`,`call`} → `danger`; `action` ∈ {`doctor`,`status`,`symbols`,`read`,`export`,`list`,`config`} → `read`; otherwise → `stimulus` |
| `crosspad_console` | `action === "reset"` → `stimulus`; everything else (`open`,`read`,`expect`,`snapshot`,`close`, missing) → `read` (spec §4.1: "console read/expect" read, "console reset" stimulus) |
| `crosspad_task` | `action === "cancel"` → `stimulus`; else `read` |
| `crosspad_audio_route` | `action === "query"` → `read`; else `stimulus` |
| `crosspad_toolsets` | always `read` (changes only what the server advertises; the manager separately refuses to enable hidden tools) |

Fixed tiers: `read` = `crosspad_devices`, `crosspad_doctor`, `crosspad_snapshot`, `crosspad_repo_status`, `crosspad_check`, `crosspad_screenshot`, `crosspad_stats`, `crosspad_settings_get`, `crosspad_search_symbols`, `crosspad_list_interfaces`, `crosspad_interface_implementations`, `crosspad_capabilities`, `crosspad_list_apps_source`, `crosspad_repo_diff`, `crosspad_apps_list`. `stimulus` = `crosspad_ui`, `crosspad_midi`, `crosspad_usb_mode`, `crosspad_run`, `crosspad_kill`, `crosspad_input`, `crosspad_test_run`. `mutate-host` = `crosspad_settings_set`, `crosspad_submodule_update`, `crosspad_commit`, `crosspad_apps_install`, `crosspad_apps_remove`, `crosspad_apps_update`, `crosspad_apps_sync`. `danger` = `crosspad_flash`. The v9 leftover `crosspad_log` (still registered by `index.ts`) is `read`.

- [ ] **Step 1: Write the failing tier tests**

`src/policy/tiers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { TOOL_TIERS, tierOf, annotationsFor } from "./tiers.js";

const ALL_V10_TOOLS = [
  "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_build", "crosspad_flash",
  "crosspad_repo_status", "crosspad_toolsets", "crosspad_task",
  "crosspad_cdc", "crosspad_console", "crosspad_ui", "crosspad_midi", "crosspad_usb_mode", "crosspad_audio_route",
  "crosspad_run", "crosspad_kill", "crosspad_check", "crosspad_screenshot", "crosspad_input", "crosspad_stats",
  "crosspad_settings_get", "crosspad_settings_set", "crosspad_test_run",
  "crosspad_search_symbols", "crosspad_list_interfaces", "crosspad_interface_implementations",
  "crosspad_capabilities", "crosspad_list_apps_source",
  "crosspad_repo_diff", "crosspad_submodule_update", "crosspad_commit",
  "crosspad_apps_list", "crosspad_apps_install", "crosspad_apps_remove", "crosspad_apps_update", "crosspad_apps_sync",
  "crosspad_trace",
];

describe("TOOL_TIERS", () => {
  it("covers every v10 tool", () => {
    for (const t of ALL_V10_TOOLS) expect(TOOL_TIERS[t], t).toBeDefined();
  });
  it("unknown tools default to danger", () => {
    expect(tierOf("crosspad_does_not_exist", {})).toBe("danger");
  });
});

describe("tierOf arg-dependent tools", () => {
  it("crosspad_build: clean/fullclean mutate the host, incremental does not", () => {
    expect(tierOf("crosspad_build", { platform: "idf", mode: "fullclean" })).toBe("mutate-host");
    expect(tierOf("crosspad_build", { platform: "pc", mode: "clean" })).toBe("mutate-host");
    expect(tierOf("crosspad_build", { platform: "pc", mode: "incremental" })).toBe("stimulus");
    expect(tierOf("crosspad_build", {})).toBe("stimulus");
  });
  it("crosspad_cdc: bootloader_request / stm_dfu are danger, status verbs are read", () => {
    expect(tierOf("crosspad_cdc", { verb: "bootloader_request" })).toBe("danger");
    expect(tierOf("crosspad_cdc", { verb: "stm_dfu" })).toBe("danger");
    expect(tierOf("crosspad_cdc", { verb: "system", op: "stm_dfu" })).toBe("danger");
    expect(tierOf("crosspad_cdc", { verb: "raw", cmd: "ota_begin 1234 v1" })).toBe("danger");
    expect(tierOf("crosspad_cdc", { verb: "kit_status" })).toBe("read");
    expect(tierOf("crosspad_cdc", { verb: "mem" })).toBe("read");
    expect(tierOf("crosspad_cdc", { verb: "pad_press", idx: 3 })).toBe("stimulus");
    expect(tierOf("crosspad_cdc", { verb: "raw", cmd: "PAD_PRESS 3 100" })).toBe("stimulus");
  });
  it("crosspad_flash is always danger", () => {
    expect(tierOf("crosspad_flash", { target: "esp", transport: "ota" })).toBe("danger");
    expect(tierOf("crosspad_flash", {})).toBe("danger");
  });
  it("crosspad_trace: write/call are danger, doctor is read, start is stimulus", () => {
    expect(tierOf("crosspad_trace", { action: "write" })).toBe("danger");
    expect(tierOf("crosspad_trace", { action: "call" })).toBe("danger");
    expect(tierOf("crosspad_trace", { action: "doctor" })).toBe("read");
    expect(tierOf("crosspad_trace", { action: "start" })).toBe("stimulus");
  });
  it("crosspad_console: reset is stimulus, read/expect/open are read", () => {
    expect(tierOf("crosspad_console", { action: "reset", handle: "con_1" })).toBe("stimulus");
    expect(tierOf("crosspad_console", { action: "read", handle: "con_1" })).toBe("read");
    expect(tierOf("crosspad_console", { action: "open", device: "dev_1" })).toBe("read");
  });
  it("crosspad_task: cancel is stimulus, status is read", () => {
    expect(tierOf("crosspad_task", { action: "cancel", task: "task_1" })).toBe("stimulus");
    expect(tierOf("crosspad_task", { action: "status", task: "task_1" })).toBe("read");
  });
});

describe("annotationsFor", () => {
  it("mirrors the tier table", () => {
    expect(annotationsFor("read")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(annotationsFor("stimulus")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(annotationsFor("mutate-host")).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(annotationsFor("danger")).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
});
```

- [ ] **Step 2: Run the tier test to verify it fails**

Run: `npx vitest run src/policy/tiers.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./tiers.js"` (module not found).

- [ ] **Step 3: Write `src/response.ts` and `src/policy/tiers.ts`**

`src/response.ts` (lines 125–149 of `src/index.ts` moved verbatim, plus `errorResult`):
```ts
// Shared MCP result envelope. jsonResponse/ok/err are the v9 helpers lifted
// from index.ts unchanged; errorResult is the v10 {code,message,hint} shape
// that every daemon-backed tool returns (spec §2.2 error objects).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResponse(data: object): CallToolResult {
  // Emit structuredContent in addition to text content.
  // - Clients with outputSchema validate structuredContent.
  // - Clients without it ignore the field per spec.
  // - LLM still sees the same JSON in `content` for backwards compat.
  const dataAsRecord = data as Record<string, unknown>;
  const result: {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: Record<string, unknown>;
    isError?: boolean;
  } = {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: dataAsRecord,
  };
  if (dataAsRecord.success === false) result.isError = true;
  return result;
}

export function ok(data: Record<string, unknown> = {}): CallToolResult {
  return jsonResponse({ success: true, ...data });
}

/** v9 envelope: `error` is a plain string. Kept for the legacy tools in index.ts. */
export function err(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return jsonResponse({ success: false, error: message, ...extra });
}

/** v10 envelope: `error` is `{code, message, hint}` (HilError.to_dict shape). */
export function errorResult(
  code: string,
  message: string,
  hint?: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  const error: { code: string; message: string; hint?: string } = { code, message };
  if (hint !== undefined) error.hint = hint;
  return jsonResponse({ success: false, error, ...extra });
}
```

`src/policy/tiers.ts`:
```ts
// Safety tiers (spec §4.1). Server-enforced; annotations only mirror them.
export type Tier = "read" | "stimulus" | "mutate-host" | "danger";

type TierFn = (args: Record<string, unknown>) => Tier;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

// CDC verbs (verbs.py function names) that only read device state.
const CDC_READ_VERBS = new Set([
  "app_list", "app_versions", "kit_list", "kit_status", "pad_stats", "pad_notes", "pad_info",
  "enc_group", "enc_focus", "enc_state", "ui_state", "led_state", "mem", "mem_blocks",
  "cdc_stats", "audio_level", "smpl_peak", "ble_status", "ble_devices", "led",
]);
const CDC_DANGER_VERBS = new Set(["bootloader_request", "stm_dfu"]);
// Raw CDC commands that rewrite firmware or reboot into a bootloader
// (hil_control.cpp system verbs + the OTA stream opener).
const CDC_DANGER_RAW_PREFIXES = ["BOOTLOADER_REQUEST", "STM_DFU", "OTA_BEGIN", "OTA_DELTA"];

const cdcTier: TierFn = (args) => {
  const verb = str(args, "verb").toLowerCase();
  if (CDC_DANGER_VERBS.has(verb)) return "danger";
  if (verb === "system" && CDC_DANGER_VERBS.has(str(args, "op").toLowerCase())) return "danger";
  if (verb === "raw") {
    const cmd = str(args, "cmd").trim().toUpperCase();
    if (CDC_DANGER_RAW_PREFIXES.some((p) => cmd.startsWith(p))) return "danger";
    return "stimulus";
  }
  if (CDC_READ_VERBS.has(verb)) return "read";
  return "stimulus";
};

const buildTier: TierFn = (args) => {
  const mode = str(args, "mode");
  return mode === "fullclean" || mode === "clean" ? "mutate-host" : "stimulus";
};

const TRACE_READ_ACTIONS = new Set(["doctor", "status", "symbols", "read", "export", "list", "config"]);
const traceTier: TierFn = (args) => {
  const action = str(args, "action");
  if (action === "write" || action === "call") return "danger";
  if (TRACE_READ_ACTIONS.has(action)) return "read";
  return "stimulus";
};

const consoleTier: TierFn = (args) => (str(args, "action") === "reset" ? "stimulus" : "read");
const taskTier: TierFn = (args) => (str(args, "action") === "cancel" ? "stimulus" : "read");
const audioRouteTier: TierFn = (args) => (str(args, "action") === "query" ? "read" : "stimulus");

export const TOOL_TIERS: Record<string, Tier | TierFn> = {
  // core
  crosspad_devices: "read",
  crosspad_doctor: "read",
  crosspad_snapshot: "read",
  crosspad_build: buildTier,
  crosspad_flash: "danger",
  crosspad_repo_status: "read",
  crosspad_toolsets: "read",
  crosspad_task: taskTier,
  // device
  crosspad_cdc: cdcTier,
  crosspad_console: consoleTier,
  crosspad_ui: "stimulus",
  crosspad_midi: "stimulus",
  crosspad_usb_mode: "stimulus",
  crosspad_audio_route: audioRouteTier,
  // sim
  crosspad_run: "stimulus",
  crosspad_kill: "stimulus",
  crosspad_check: "read",
  crosspad_screenshot: "read",
  crosspad_input: "stimulus",
  crosspad_stats: "read",
  crosspad_settings_get: "read",
  crosspad_settings_set: "mutate-host",
  crosspad_test_run: "stimulus",
  crosspad_log: "read",
  // code
  crosspad_search_symbols: "read",
  crosspad_list_interfaces: "read",
  crosspad_interface_implementations: "read",
  crosspad_capabilities: "read",
  crosspad_list_apps_source: "read",
  // git
  crosspad_repo_diff: "read",
  crosspad_submodule_update: "mutate-host",
  crosspad_commit: "mutate-host",
  // apps
  crosspad_apps_list: "read",
  crosspad_apps_install: "mutate-host",
  crosspad_apps_remove: "mutate-host",
  crosspad_apps_update: "mutate-host",
  crosspad_apps_sync: "mutate-host",
  // trace
  crosspad_trace: traceTier,
};

/** Tier of a concrete call. Unknown tools are treated as danger — a tool that
 *  forgot to declare itself must not slip past confirmation. */
export function tierOf(tool: string, args: Record<string, unknown>): Tier {
  const entry = TOOL_TIERS[tool];
  if (entry === undefined) return "danger";
  return typeof entry === "function" ? entry(args ?? {}) : entry;
}

export function annotationsFor(tier: Tier): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  switch (tier) {
    case "read":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case "stimulus":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case "mutate-host":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    case "danger":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
}
```

- [ ] **Step 4: Run the tier test to verify it passes**

Run: `npx vitest run src/policy/tiers.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing policy tests**

`src/policy/policy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadPolicy, decide, ruleMatches, type Policy } from "./policy.js";

function tmpPolicy(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-policy-"));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

describe("loadPolicy precedence", () => {
  it("defaults to strict with no file and no env", () => {
    const p = loadPolicy({ file: "/nonexistent/crosspad/policy.json", env: {} });
    expect(p).toEqual({ mode: "strict", rules: [] });
  });
  it("reads mode and rules from the file", () => {
    const file = tmpPolicy({ mode: "lab", rules: [{ tool: "crosspad_flash", when: { transport: "ota" }, confirm: false }] });
    const p = loadPolicy({ file, env: {} });
    expect(p.mode).toBe("lab");
    expect(p.rules).toEqual([{ tool: "crosspad_flash", when: { transport: "ota" }, confirm: false }]);
  });
  it("env only makes it stricter: lab file + strict env → strict; strict file + lab env → strict", () => {
    const lab = tmpPolicy({ mode: "lab" });
    expect(loadPolicy({ file: lab, env: { CROSSPAD_MCP_POLICY: "strict" } }).mode).toBe("strict");
    const strict = tmpPolicy({ mode: "strict" });
    expect(loadPolicy({ file: strict, env: { CROSSPAD_MCP_POLICY: "lab" } }).mode).toBe("strict");
    expect(loadPolicy({ file: strict, env: { CROSSPAD_MCP_POLICY: "readonly" } }).mode).toBe("readonly");
  });
  it("--read-only always wins", () => {
    const lab = tmpPolicy({ mode: "lab" });
    expect(loadPolicy({ file: lab, env: { CROSSPAD_MCP_POLICY: "lab" }, readOnlyFlag: true }).mode).toBe("readonly");
  });
  it("ignores garbage in the file and env", () => {
    const bad = tmpPolicy("{ not json");
    expect(loadPolicy({ file: bad, env: { CROSSPAD_MCP_POLICY: "yolo" } })).toEqual({ mode: "strict", rules: [] });
    const badRules = tmpPolicy({ mode: "lab", rules: [{ nope: 1 }, { tool: "x", confirm: "yes" }, { tool: "ok_tool", confirm: true }] });
    expect(loadPolicy({ file: badRules, env: {} }).rules).toEqual([{ tool: "ok_tool", confirm: true }]);
  });
  it("CROSSPAD_MCP_POLICY_FILE selects the file", () => {
    const file = tmpPolicy({ mode: "lab" });
    expect(loadPolicy({ env: { CROSSPAD_MCP_POLICY_FILE: file } }).mode).toBe("lab");
  });
});

describe("ruleMatches", () => {
  const rule = { tool: "crosspad_flash", when: { transport: "ota", delta: { base_fw: "a.bin" } }, confirm: false };
  it("requires every when-key to deep-equal the arg", () => {
    expect(ruleMatches(rule, "crosspad_flash", { transport: "ota", delta: { base_fw: "a.bin" }, device: "dev_1" })).toBe(true);
    expect(ruleMatches(rule, "crosspad_flash", { transport: "uart", delta: { base_fw: "a.bin" } })).toBe(false);
    expect(ruleMatches(rule, "crosspad_flash", { transport: "ota", delta: { base_fw: "b.bin" } })).toBe(false);
    expect(ruleMatches(rule, "crosspad_flash", { transport: "ota" })).toBe(false);
    expect(ruleMatches(rule, "crosspad_build", { transport: "ota", delta: { base_fw: "a.bin" } })).toBe(false);
  });
  it("a rule without when matches every call of that tool", () => {
    expect(ruleMatches({ tool: "crosspad_flash", confirm: false }, "crosspad_flash", {})).toBe(true);
  });
});

describe("decide", () => {
  const strict: Policy = { mode: "strict", rules: [] };
  const readonly: Policy = { mode: "readonly", rules: [] };
  const lab: Policy = { mode: "lab", rules: [{ tool: "crosspad_flash", when: { transport: "ota" }, confirm: false }] };

  it("readonly hides everything that is not read tier", () => {
    expect(decide(readonly, "crosspad_devices", {})).toBe("allow");
    expect(decide(readonly, "crosspad_console", { action: "read" })).toBe("allow");
    expect(decide(readonly, "crosspad_console", { action: "reset" })).toBe("hidden");
    expect(decide(readonly, "crosspad_ui", { action: "press" })).toBe("hidden");
    expect(decide(readonly, "crosspad_commit", {})).toBe("hidden");
    expect(decide(readonly, "crosspad_flash", {})).toBe("hidden");
  });
  it("strict confirms danger and allows everything else", () => {
    expect(decide(strict, "crosspad_flash", { transport: "ota" })).toBe("confirm");
    expect(decide(strict, "crosspad_cdc", { verb: "stm_dfu" })).toBe("confirm");
    expect(decide(strict, "crosspad_trace", { action: "write" })).toBe("confirm");
    expect(decide(strict, "crosspad_commit", {})).toBe("allow");
    expect(decide(strict, "crosspad_ui", { action: "press" })).toBe("allow");
  });
  it("strict ignores confirm:false rules (a file cannot loosen strict)", () => {
    const strictWithRule: Policy = { mode: "strict", rules: [{ tool: "crosspad_flash", confirm: false }] };
    expect(decide(strictWithRule, "crosspad_flash", { transport: "ota" })).toBe("confirm");
  });
  it("lab pre-approves danger only when a rule with confirm:false matches", () => {
    expect(decide(lab, "crosspad_flash", { transport: "ota", device: "dev_1" })).toBe("allow");
    expect(decide(lab, "crosspad_flash", { transport: "uart" })).toBe("confirm");
    expect(decide(lab, "crosspad_cdc", { verb: "bootloader_request" })).toBe("confirm");
  });
  it("a confirm:true rule forces confirmation of a non-danger tool", () => {
    const p: Policy = { mode: "lab", rules: [{ tool: "crosspad_commit", confirm: true }] };
    expect(decide(p, "crosspad_commit", { repo: "idf" })).toBe("confirm");
  });
});
```

- [ ] **Step 6: Run the policy test to verify it fails**

Run: `npx vitest run src/policy/policy.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./policy.js"`.

- [ ] **Step 7: Write `src/policy/policy.ts`**

```ts
// Policy engine (spec §4.1). File = intent, env + flags only tighten.
import fs from "fs";
import os from "os";
import path from "path";
import { tierOf } from "./tiers.js";

export type PolicyMode = "strict" | "lab" | "readonly";

export interface PolicyRule {
  tool: string;
  when?: Record<string, unknown>;
  confirm: boolean;
}

export interface Policy {
  mode: PolicyMode;
  rules: PolicyRule[];
}

export type Decision = "allow" | "confirm" | "hidden";

export const DEFAULT_POLICY_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "crosspad-mcp",
  "policy.json",
);

// Strictness order — a later source may only move right on this line.
const STRICTNESS: Record<PolicyMode, number> = { lab: 0, strict: 1, readonly: 2 };

function isMode(v: unknown): v is PolicyMode {
  return v === "strict" || v === "lab" || v === "readonly";
}

function stricter(a: PolicyMode, b: PolicyMode): PolicyMode {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

function parseRules(raw: unknown): PolicyRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: PolicyRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.tool !== "string" || o.tool.length === 0) continue;
    if (typeof o.confirm !== "boolean") continue;
    const rule: PolicyRule = { tool: o.tool, confirm: o.confirm };
    if (o.when && typeof o.when === "object" && !Array.isArray(o.when)) {
      rule.when = o.when as Record<string, unknown>;
    }
    rules.push(rule);
  }
  return rules;
}

function readPolicyFile(file: string): Policy {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return { mode: "strict", rules: [] };
    const o = raw as Record<string, unknown>;
    return { mode: isMode(o.mode) ? o.mode : "strict", rules: parseRules(o.rules) };
  } catch {
    return { mode: "strict", rules: [] };
  }
}

/**
 * Resolution: file (opts.file → $CROSSPAD_MCP_POLICY_FILE → ~/.config/crosspad-mcp/policy.json)
 * gives mode + rules; $CROSSPAD_MCP_POLICY and --read-only can only make the
 * mode stricter (lab < strict < readonly).
 */
export function loadPolicy(opts: { file?: string; env?: NodeJS.ProcessEnv; readOnlyFlag?: boolean } = {}): Policy {
  const env = opts.env ?? process.env;
  const file = opts.file ?? env.CROSSPAD_MCP_POLICY_FILE ?? DEFAULT_POLICY_FILE;
  const fromFile = readPolicyFile(file);
  let mode = fromFile.mode;
  const envMode = env.CROSSPAD_MCP_POLICY;
  if (isMode(envMode)) mode = stricter(mode, envMode);
  if (opts.readOnlyFlag) mode = "readonly";
  return { mode, rules: fromFile.rules };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (!deepEqual(ak, bk)) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** Every key in `when` must deep-equal the corresponding call argument. */
export function ruleMatches(rule: PolicyRule, tool: string, args: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  if (!rule.when) return true;
  return Object.entries(rule.when).every(([k, v]) => k in args && deepEqual(args[k], v));
}

export function decide(policy: Policy, tool: string, args: Record<string, unknown>): Decision {
  const a = args ?? {};
  const tier = tierOf(tool, a);
  if (policy.mode === "readonly") return tier === "read" ? "allow" : "hidden";
  const matching = policy.rules.filter((r) => ruleMatches(r, tool, a));
  // A rule can always tighten (confirm:true), in any non-readonly mode.
  if (matching.some((r) => r.confirm)) return "confirm";
  if (tier !== "danger") return "allow";
  if (policy.mode === "lab" && matching.some((r) => !r.confirm)) return "allow";
  return "confirm";
}
```

- [ ] **Step 8: Run the policy test to verify it passes**

Run: `npx vitest run src/policy/policy.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 9: Write the failing confirmation tests**

`src/policy/confirm.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  mintToken, verifyToken, canonicalJson, requireConfirmation, enforce,
  confirmationDeclined, policyDenied, CONFIRM_TTL_S,
} from "./confirm.js";
import type { Policy } from "./policy.js";

const T0 = 1_700_000_000_000;
const ARGS = { target: "esp", transport: "ota", device: "dev_3f2a", delta: { base_fw: "old.bin" } };

function fakeServer(caps: Record<string, unknown> | undefined, elicit?: (p: unknown) => Promise<unknown>) {
  const elicitInput = vi.fn(elicit ?? (async () => ({ action: "decline" })));
  const server = { server: { getClientCapabilities: () => caps, elicitInput } } as unknown as McpServer;
  return { server, elicitInput };
}
const extra = {} as never;

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }))
      .toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe("token round-trip", () => {
  it("verifies the token it minted", () => {
    const tok = mintToken("crosspad_flash", ARGS, T0);
    expect(tok).toMatch(/^cfm_\d+_[0-9a-f]{64}$/);
    expect(verifyToken(tok, "crosspad_flash", ARGS, T0 + 1000)).toBe(true);
  });
  it("ignores key order and a confirm_token inside args", () => {
    const tok = mintToken("crosspad_flash", ARGS, T0);
    const reordered = { delta: { base_fw: "old.bin" }, device: "dev_3f2a", transport: "ota", target: "esp", confirm_token: tok };
    expect(verifyToken(tok, "crosspad_flash", reordered, T0 + 1000)).toBe(true);
  });
  it("rejects tampered args, another tool, and a forged hex", () => {
    const tok = mintToken("crosspad_flash", ARGS, T0);
    expect(verifyToken(tok, "crosspad_flash", { ...ARGS, transport: "uart" }, T0 + 1000)).toBe(false);
    expect(verifyToken(tok, "crosspad_flash", { ...ARGS, delta: { base_fw: "new.bin" } }, T0 + 1000)).toBe(false);
    expect(verifyToken(tok, "crosspad_cdc", ARGS, T0 + 1000)).toBe(false);
    const forged = tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0");
    expect(verifyToken(forged, "crosspad_flash", ARGS, T0 + 1000)).toBe(false);
    expect(verifyToken("garbage", "crosspad_flash", ARGS, T0)).toBe(false);
    expect(verifyToken("cfm_notanumber_00", "crosspad_flash", ARGS, T0)).toBe(false);
  });
  it("expires after CONFIRM_TTL_S and rejects tokens from the future", () => {
    const tok = mintToken("crosspad_flash", ARGS, T0);
    expect(verifyToken(tok, "crosspad_flash", ARGS, T0 + CONFIRM_TTL_S * 1000)).toBe(true);
    expect(verifyToken(tok, "crosspad_flash", ARGS, T0 + CONFIRM_TTL_S * 1000 + 1)).toBe(false);
    expect(verifyToken(tok, "crosspad_flash", ARGS, T0 - 1)).toBe(false);
  });
});

describe("requireConfirmation — token path (no elicitation capability)", () => {
  it("returns a confirmation_required result and performs nothing", async () => {
    const { server, elicitInput } = fakeServer({});
    const r = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "Flash esp over OTA on dev_3f2a");
    expect(r.status).toBe("token");
    if (r.status !== "token") return;
    expect(elicitInput).not.toHaveBeenCalled();
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as { resultType: string; confirmation: { token: string; expires_in_s: number; summary: string } };
    expect(sc.resultType).toBe("confirmation_required");
    expect(sc.confirmation.expires_in_s).toBe(120);
    expect(sc.confirmation.summary).toBe("Flash esp over OTA on dev_3f2a");
    expect(sc.confirmation.token).toMatch(/^cfm_/);
    expect(JSON.parse((r.result.content[0] as { text: string }).text).resultType).toBe("confirmation_required");
    // the token it handed out approves the identical call
    const again = await requireConfirmation(server, extra, "crosspad_flash", { ...ARGS, confirm_token: sc.confirmation.token }, "x");
    expect(again.status).toBe("approved");
  });
  it("a valid confirm_token short-circuits even when elicitation is available", async () => {
    const { server, elicitInput } = fakeServer({ elicitation: {} });
    const tok = mintToken("crosspad_flash", ARGS);
    const r = await requireConfirmation(server, extra, "crosspad_flash", { ...ARGS, confirm_token: tok }, "x");
    expect(r.status).toBe("approved");
    expect(elicitInput).not.toHaveBeenCalled();
  });
  it("an invalid confirm_token falls back to a fresh token result", async () => {
    const { server } = fakeServer(undefined);
    const r = await requireConfirmation(server, extra, "crosspad_flash", { ...ARGS, confirm_token: "cfm_1_00" }, "x");
    expect(r.status).toBe("token");
  });
});

describe("requireConfirmation — elicitation path", () => {
  it("accept with approve=true → approved", async () => {
    const { server, elicitInput } = fakeServer({ elicitation: {} }, async () => ({ action: "accept", content: { approve: true } }));
    const r = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "Flash esp over OTA on dev_3f2a");
    expect(r.status).toBe("approved");
    expect(elicitInput).toHaveBeenCalledTimes(1);
    const params = elicitInput.mock.calls[0][0] as { message: string; requestedSchema: { properties: Record<string, unknown>; required: string[] } };
    expect(params.message).toContain("Flash esp over OTA on dev_3f2a");
    expect(params.requestedSchema.required).toEqual(["approve"]);
  });
  it("decline / cancel / accept without approve → declined", async () => {
    for (const res of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { approve: false } }, { action: "accept" }]) {
      const { server } = fakeServer({ elicitation: {} }, async () => res);
      const r = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "x");
      expect(r.status).toBe("declined");
    }
  });
  it("an elicitInput failure falls back to the token path", async () => {
    const { server } = fakeServer({ elicitation: {} }, async () => { throw new Error("client went away"); });
    const r = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "x");
    expect(r.status).toBe("token");
  });
});

describe("enforce", () => {
  const strict: Policy = { mode: "strict", rules: [] };
  const readonly: Policy = { mode: "readonly", rules: [] };
  it("allow → null", async () => {
    const { server } = fakeServer({});
    expect(await enforce(server, extra, strict, "crosspad_devices", {}, "list devices")).toBeNull();
  });
  it("hidden → POLICY_DENIED error", async () => {
    const { server } = fakeServer({});
    const r = await enforce(server, extra, readonly, "crosspad_ui", { action: "press" }, "press");
    expect(r?.isError).toBe(true);
    expect((r?.structuredContent as { error: { code: string } }).error.code).toBe("POLICY_DENIED");
  });
  it("confirm without token → confirmation_required; declined → CANCELLED_BY_USER", async () => {
    const { server } = fakeServer({});
    const r = await enforce(server, extra, strict, "crosspad_flash", ARGS, "flash");
    expect((r?.structuredContent as { resultType: string }).resultType).toBe("confirmation_required");
    const declined = fakeServer({ elicitation: {} }, async () => ({ action: "decline" }));
    const d = await enforce(declined.server, extra, strict, "crosspad_flash", ARGS, "flash");
    expect(d?.isError).toBe(true);
    expect((d?.structuredContent as { error: { code: string } }).error.code).toBe("CANCELLED_BY_USER");
  });
  it("helpers carry code + hint", () => {
    expect((confirmationDeclined("crosspad_flash").structuredContent as { error: { code: string } }).error.code).toBe("CANCELLED_BY_USER");
    expect((policyDenied("crosspad_flash", "readonly").structuredContent as { error: { hint: string } }).error.hint).toContain("readonly");
  });
});
```

- [ ] **Step 10: Run the confirm test to verify it fails**

Run: `npx vitest run src/policy/confirm.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./confirm.js"`.

- [ ] **Step 11: Write `src/policy/confirm.ts`**

```ts
// Confirmation that does not depend on the client (spec §4.2).
//  1. Client declares `elicitation` → elicitInput form, decline → CANCELLED_BY_USER.
//  2. Otherwise → {resultType:"confirmation_required", confirmation:{token,…}},
//     nothing performed; the model re-issues the identical call with confirm_token.
// The token is an HMAC-SHA256 over (tool, canonical args, issuedAt) with a
// per-process random secret, so any argument change or a server restart
// invalidates it.
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { jsonResponse, errorResult } from "../response.js";
import { decide, type Policy, type PolicyMode } from "./policy.js";

export const CONFIRM_TTL_S = 120;
const TOKEN_ARG = "confirm_token";
const SECRET = randomBytes(32);

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalJson(v === undefined ? null : v)).join(",") + "]";
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

function canonicalArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) if (k !== TOKEN_ARG) out[k] = v;
  return out;
}

function mac(tool: string, args: Record<string, unknown>, issuedAt: number): string {
  return createHmac("sha256", SECRET)
    .update(tool + "\n" + canonicalJson(canonicalArgs(args)) + "\n" + String(issuedAt))
    .digest("hex");
}

export function mintToken(tool: string, args: Record<string, unknown>, now?: number): string {
  const issuedAt = Math.floor(now ?? Date.now());
  return `cfm_${issuedAt}_${mac(tool, args, issuedAt)}`;
}

export function verifyToken(token: string, tool: string, args: Record<string, unknown>, now?: number): boolean {
  if (typeof token !== "string") return false;
  const m = /^cfm_(\d{1,16})_([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  if (!Number.isFinite(issuedAt)) return false;
  const t = now ?? Date.now();
  if (t < issuedAt || t - issuedAt > CONFIRM_TTL_S * 1000) return false;
  const expected = Buffer.from(mac(tool, args, issuedAt), "hex");
  const given = Buffer.from(m[2], "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type ConfirmationOutcome =
  | { status: "approved" }
  | { status: "declined" }
  | { status: "token"; result: CallToolResult };

function tokenResult(tool: string, args: Record<string, unknown>, summary: string): CallToolResult {
  const token = mintToken(tool, args);
  return jsonResponse({
    resultType: "confirmation_required",
    confirmation: { token, expires_in_s: CONFIRM_TTL_S, summary },
    tool,
    hint: `Nothing was performed. Re-issue the identical ${tool} call with confirm_token="${token}" within ${CONFIRM_TTL_S} s to proceed.`,
  });
}

function clientHasElicitation(server: McpServer): boolean {
  try {
    const caps = server.server.getClientCapabilities() as Record<string, unknown> | undefined;
    return !!caps && caps.elicitation !== undefined && caps.elicitation !== null;
  } catch {
    return false;
  }
}

export async function requireConfirmation(
  server: McpServer,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  tool: string,
  args: Record<string, unknown>,
  summary: string,
): Promise<ConfirmationOutcome> {
  void extra;
  const presented = args?.[TOKEN_ARG];
  if (typeof presented === "string" && verifyToken(presented, tool, args)) return { status: "approved" };

  if (clientHasElicitation(server)) {
    try {
      const res = await server.server.elicitInput({
        message:
          `${summary}\n\nThis is a "danger"-tier operation (irreversible or brick-risk). ` +
          `Approve to run ${tool} now; decline to abort.`,
        requestedSchema: {
          type: "object",
          properties: {
            approve: { type: "boolean", title: "Approve", description: `Run ${tool} with the arguments shown above` },
          },
          required: ["approve"],
        },
      });
      const content = (res as { action: string; content?: Record<string, unknown> }).content;
      if (res.action === "accept" && content?.approve === true) return { status: "approved" };
      return { status: "declined" };
    } catch {
      // Client advertised elicitation but could not serve it — fall back to the
      // token path rather than blocking the operation forever.
      return { status: "token", result: tokenResult(tool, args, summary) };
    }
  }
  return { status: "token", result: tokenResult(tool, args, summary) };
}

export function confirmationDeclined(tool: string): CallToolResult {
  return errorResult(
    "CANCELLED_BY_USER",
    `${tool} was declined by the user.`,
    "Do not retry automatically; ask the user before issuing this call again.",
  );
}

export function policyDenied(tool: string, mode: PolicyMode): CallToolResult {
  return errorResult(
    "POLICY_DENIED",
    `${tool} with these arguments is not permitted under policy mode "${mode}".`,
    mode === "readonly"
      ? "The server runs in readonly mode (--read-only or CROSSPAD_MCP_POLICY=readonly); only read-tier tools are available."
      : "Adjust ~/.config/crosspad-mcp/policy.json or CROSSPAD_MCP_POLICY.",
  );
}

/**
 * The single guard every tool callback runs first:
 *   null → proceed; otherwise return the result as-is.
 */
export async function enforce(
  server: McpServer,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  policy: Policy,
  tool: string,
  args: Record<string, unknown>,
  summary: string,
): Promise<CallToolResult | null> {
  const decision = decide(policy, tool, canonicalArgs(args));
  if (decision === "allow") return null;
  if (decision === "hidden") return policyDenied(tool, policy.mode);
  const outcome = await requireConfirmation(server, extra, tool, args, summary);
  if (outcome.status === "approved") return null;
  if (outcome.status === "declined") return confirmationDeclined(tool);
  return outcome.result;
}
```

- [ ] **Step 12: Run all policy tests and the type check**

Run: `npx vitest run src/policy && npx tsc --noEmit`
Expected: PASS (tiers 8, policy 13, confirm 13 tests); `tsc` exits 0 with no output.

- [ ] **Step 13: Commit**

```bash
git add src/response.ts src/policy/tiers.ts src/policy/policy.ts src/policy/confirm.ts src/policy/tiers.test.ts src/policy/policy.test.ts src/policy/confirm.test.ts
git commit -m "feat(policy): tiers, policy file/env precedence, HMAC confirmation tokens and elicitation"
```

---

### Task 4: Toolsets — ToolsetManager, crosspad_toolsets, ToolContext, registry, index.ts restructure

**Files:**
- Create: `src/toolsets.ts`
- Create: `src/tool-context.ts`
- Create: `src/tools/toolsets-tool.ts`
- Create: `src/registry.ts`
- Modify: `src/index.ts` — lines 1–49 (imports), 51–79 (`SERVER_INSTRUCTIONS`), 119–149 (response helpers → import), every `server.registerTool(` call site (30 of them, lines 478–1470) → `registerLegacy(`, and lines 1672–1748 (START section: flags + wiring)
- Modify: `src/index.mcp.test.ts:80` (import) + `beforeAll` (enable all toolsets so the existing roundtrip tests still see their tools)
- Test: `src/toolsets.test.ts`, `src/tools/toolsets-tool.test.ts`, `src/registry.test.ts`

**Interfaces:**
- Consumes: `Policy`, `decide`, `loadPolicy` (Task 3); `tierOf`, `Tier` (Task 3); `jsonResponse`, `errorResult` (Task 3 `src/response.ts`); `enforce` (Task 3); `RegisteredTool` (`@modelcontextprotocol/sdk/server/mcp.js`); `McpServer.sendToolListChanged()` (guarded by `isConnected()` inside the SDK, safe before connect); `HilDaemon`/`getHilDaemon` (`src/hil/daemon.ts`, C1), `HandleRegistry`/`handles` (`src/handles.ts`, C1), `JobRegistry`/`jobs` (`src/tasks.ts`, C3) — Step 9 only.
- Produces:
  - `src/toolsets.ts`: `export const TOOLSETS: Record<string, string[]>` (keys in order `core, device, hil, sim, code, git, apps, trace`); `export const TOOLSET_DESCRIPTIONS: Record<string, string>`; `export const LEGACY_TOOLSET_OF: Record<string, string>` (`crosspad_log → "sim"`, **chosen**: a v9 tool not in the spec table); `export function toolsetOf(tool: string): string | undefined`; `export class ToolsetManager { constructor(server: McpServer, policy: Policy); register(name, tool, toolset): void; enable(toolset): string[]; disable(toolset): string[]; enabled(): string[]; visible(tool): boolean; isEnabled(tool): boolean; tools(toolset): string[]; hiddenTools(): string[]; describe(toolset): {name, description, enabled, tools: Array<{name, tier, enabled, hidden}>} }`; `export function initialToolsets(argv: string[], env: NodeJS.ProcessEnv): string[]` (`core` + `CROSSPAD_TOOLSETS` + `--toolsets a,b` / `--toolsets=a,b`; keyword `all`; unknown names ignored with a stderr warning); `export function hasReadOnlyFlag(argv: string[]): boolean`.
  - `src/tool-context.ts`: `export interface ToolContext { daemon: () => HilDaemon; policy: Policy; jobs: JobRegistry; handles: HandleRegistry }` (type-only imports).
  - `src/tools/toolsets-tool.ts`: `export function registerToolsetsTool(server: McpServer, ctx: ToolContext, manager: ToolsetManager): RegisteredTool` — **third parameter chosen** because `ToolContext` (contract) has no manager field; input `{action: "list"|"enable"|"disable"|"describe", toolset?: string}`.
  - `src/registry.ts`: `export function registerAll(server: McpServer, ctx: ToolContext, manager: ToolsetManager, legacy?: Map<string, RegisteredTool>): void` — optional 4th parameter (**chosen**) carrying the v9 tools that `index.ts` still registers inline; new-style `register*Tool` calls from chunks C1/C3 are added to `registerAll` by those chunks (each adds one line `manager.register("<name>", register<Name>Tool(server, ctx), "<toolset>")` **before** the legacy loop; the legacy loop skips names already registered).
  - `src/index.ts`: `export const legacyTools: Map<string, RegisteredTool>`, `export const policy: Policy`, `export const toolsetManager: ToolsetManager`, `export const toolContext: ToolContext`, existing `export const server`.

Disabled tools: the SDK has no "register disabled" option, so `ToolsetManager.register` calls `tool.disable()` immediately (its internal `sendToolListChanged` is a no-op before `connect`). Hidden-by-policy tools get `tool.remove()` so they never appear in `tools/list`. Deterministic order: `tools/list` order is the SDK's registration order; `registerAll` therefore registers toolsets in `TOOLSETS` key order and tools in array order, and `enable()`/`disable()`/`enabled()` return sorted arrays. Legacy tools registered by `index.ts` keep their file order (stable across runs, which is what prompt caching needs).

- [ ] **Step 1: Write the failing ToolsetManager tests**

`src/toolsets.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { TOOLSETS, ToolsetManager, initialToolsets, hasReadOnlyFlag, toolsetOf } from "./toolsets.js";
import type { Policy } from "./policy/policy.js";

const STRICT: Policy = { mode: "strict", rules: [] };
const READONLY: Policy = { mode: "readonly", rules: [] };

// Register one stub tool per name of every toolset, in TOOLSETS order.
function stubAll(server: McpServer, manager: ToolsetManager): void {
  for (const [toolset, names] of Object.entries(TOOLSETS)) {
    for (const name of names) {
      const tool = server.registerTool(
        name,
        { description: `stub ${name}`, inputSchema: { action: z.string().optional() } },
        async () => ({ content: [{ type: "text", text: name }] }),
      );
      manager.register(name, tool, toolset);
    }
  }
}

async function connect(server: McpServer) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const listNames = async () => (await client.listTools()).tools.map((t) => t.name);
  return { client, listNames };
}

describe("TOOLSETS", () => {
  it("has the spec §3.1 keys in order and core has 8 tools", () => {
    expect(Object.keys(TOOLSETS)).toEqual(["core", "device", "hil", "sim", "code", "git", "apps", "trace"]);
    expect(TOOLSETS.core).toEqual([
      "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_build", "crosspad_flash",
      "crosspad_repo_status", "crosspad_toolsets", "crosspad_task",
    ]);
    expect(TOOLSETS.hil).toEqual([]);
    expect(toolsetOf("crosspad_commit")).toBe("git");
    expect(toolsetOf("crosspad_log")).toBe("sim");
    expect(toolsetOf("nope")).toBeUndefined();
  });
});

describe("ToolsetManager", () => {
  let server: McpServer;
  let client: Client | null = null;
  beforeEach(() => { server = new McpServer({ name: "t", version: "0" }); });
  afterEach(async () => { await client?.close(); client = null; await server.close(); });

  it("only core is visible after enabling core", async () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    m.enable("core");
    const c = await connect(server); client = c.client;
    expect(await c.listNames()).toEqual(TOOLSETS.core);
    expect(m.enabled()).toEqual(["core"]);
  });

  it("nothing is visible before any enable", async () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    const c = await connect(server); client = c.client;
    expect(await c.listNames()).toEqual([]);
  });

  it("enable adds the toolset's tools and emits tools/list_changed", async () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    m.enable("core");
    const c = await connect(server); client = c.client;
    const spy = vi.spyOn(server, "sendToolListChanged");
    const added = m.enable("git");
    expect(added).toEqual(["crosspad_commit", "crosspad_repo_diff", "crosspad_submodule_update"]);
    expect(spy).toHaveBeenCalled();
    expect(await c.listNames()).toEqual([...TOOLSETS.core, ...TOOLSETS.git]);
    expect(m.enabled()).toEqual(["core", "git"]);
    // idempotent: enabling again adds nothing
    expect(m.enable("git")).toEqual([]);
  });

  it("disable removes the tools; core cannot be disabled", async () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    m.enable("core"); m.enable("sim");
    const c = await connect(server); client = c.client;
    const removed = m.disable("sim");
    expect(removed).toEqual([...TOOLSETS.sim].sort());
    expect(await c.listNames()).toEqual(TOOLSETS.core);
    expect(() => m.disable("core")).toThrow(/core/);
    expect(() => m.enable("nope")).toThrow(/unknown toolset/);
  });

  it("readonly never enables non-read tools, in any toolset", async () => {
    const m = new ToolsetManager(server, READONLY);
    stubAll(server, m);
    m.enable("core");
    m.enable("git");
    m.enable("sim");
    const c = await connect(server); client = c.client;
    const names = await c.listNames();
    expect(names).toEqual([
      "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_repo_status", "crosspad_toolsets", "crosspad_task",
      "crosspad_check", "crosspad_screenshot", "crosspad_stats", "crosspad_settings_get",
      "crosspad_repo_diff",
    ]);
    expect(m.visible("crosspad_flash")).toBe(false);
    expect(m.visible("crosspad_devices")).toBe(true);
    expect(m.hiddenTools()).toContain("crosspad_flash");
    expect(m.hiddenTools()).toContain("crosspad_commit");
    // calling a hidden tool is a protocol error, not a silent no-op
    await expect(c.client.callTool({ name: "crosspad_flash", arguments: {} })).rejects.toThrow();
  });

  it("order is deterministic across two servers", async () => {
    const s2 = new McpServer({ name: "t2", version: "0" });
    const m1 = new ToolsetManager(server, STRICT);
    const m2 = new ToolsetManager(s2, STRICT);
    stubAll(server, m1); stubAll(s2, m2);
    for (const ts of ["core", "apps", "device"]) { m1.enable(ts); m2.enable(ts); }
    const c1 = await connect(server); client = c1.client;
    const c2 = await connect(s2);
    expect(await c1.listNames()).toEqual(await c2.listNames());
    expect(await c1.listNames()).toEqual([...TOOLSETS.core, ...TOOLSETS.device, ...TOOLSETS.apps]);
    await c2.client.close(); await s2.close();
  });

  it("describe reports tier + state per tool", () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    m.enable("core");
    const d = m.describe("core");
    expect(d.name).toBe("core");
    expect(d.enabled).toBe(true);
    expect(d.tools.find((t) => t.name === "crosspad_flash")).toEqual({ name: "crosspad_flash", tier: "danger", enabled: true, hidden: false });
    expect(m.describe("git").enabled).toBe(false);
  });
});

describe("startup flags", () => {
  it("core always; env and --toolsets add; 'all' expands; unknown ignored", () => {
    expect(initialToolsets([], {})).toEqual(["core"]);
    expect(initialToolsets(["--toolsets", "git,sim"], {})).toEqual(["core", "sim", "git"]);
    expect(initialToolsets(["--toolsets=apps"], { CROSSPAD_TOOLSETS: "trace, device" })).toEqual(["core", "device", "apps", "trace"]);
    expect(initialToolsets(["--toolsets", "all"], {})).toEqual(Object.keys(TOOLSETS));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(initialToolsets(["--toolsets", "bogus,core"], {})).toEqual(["core"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bogus"));
  });
  it("--read-only", () => {
    expect(hasReadOnlyFlag(["--http", "3000"])).toBe(false);
    expect(hasReadOnlyFlag(["--read-only"])).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/toolsets.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./toolsets.js"`.

- [ ] **Step 3: Write `src/toolsets.ts` and `src/tool-context.ts`**

`src/tool-context.ts`:
```ts
// Everything a v10 tool module needs, passed explicitly (no module globals in tools).
import type { HilDaemon } from "./hil/daemon.js";
import type { Policy } from "./policy/policy.js";
import type { JobRegistry } from "./tasks.js";
import type { HandleRegistry } from "./handles.js";

export interface ToolContext {
  daemon: () => HilDaemon;
  policy: Policy;
  jobs: JobRegistry;
  handles: HandleRegistry;
}
```

`src/toolsets.ts`:
```ts
// Dynamic toolsets (spec §3.1). Only `core` is visible at start; the rest come
// from --toolsets / CROSSPAD_TOOLSETS / the crosspad_toolsets meta-tool.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decide, type Policy } from "./policy/policy.js";
import { tierOf, type Tier } from "./policy/tiers.js";

// Key order is the tools/list order; tool order within a set is fixed too.
export const TOOLSETS: Record<string, string[]> = {
  core: [
    "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_build", "crosspad_flash",
    "crosspad_repo_status", "crosspad_toolsets", "crosspad_task",
  ],
  device: [
    "crosspad_cdc", "crosspad_console", "crosspad_ui", "crosspad_midi", "crosspad_usb_mode", "crosspad_audio_route",
  ],
  hil: [],
  sim: [
    "crosspad_run", "crosspad_kill", "crosspad_check", "crosspad_screenshot", "crosspad_input", "crosspad_stats",
    "crosspad_settings_get", "crosspad_settings_set", "crosspad_test_run",
  ],
  code: [
    "crosspad_search_symbols", "crosspad_list_interfaces", "crosspad_interface_implementations",
    "crosspad_capabilities", "crosspad_list_apps_source",
  ],
  git: ["crosspad_repo_diff", "crosspad_submodule_update", "crosspad_commit"],
  apps: ["crosspad_apps_list", "crosspad_apps_install", "crosspad_apps_remove", "crosspad_apps_update", "crosspad_apps_sync"],
  trace: ["crosspad_trace"],
};

export const TOOLSET_DESCRIPTIONS: Record<string, string> = {
  core: "Always on: device inventory, doctor, snapshot, build, flash (confirmed), repo status, toolsets, task control.",
  device: "Device I/O through the crosspad-hil daemon: CDC verbs, console, UI driving, MIDI, USB mode, audio routing.",
  hil: "Hardware-in-the-loop scenarios, capture, analysis, stimulus, BLE (P1 — empty in this release).",
  sim: "PC simulator: run/kill/check, screenshot, input, stats, settings, test runner.",
  code: "Code intelligence: symbol search, interfaces, implementations, capabilities, registered apps.",
  git: "Repo mutations: submodule drift, submodule update, commit.",
  apps: "App package manager (crosspad-apps registry): list/install/remove/update/sync.",
  trace: "STM32 SWD variable tracer.",
};

// v9 tools still registered by index.ts that the spec table does not list.
export const LEGACY_TOOLSET_OF: Record<string, string> = { crosspad_log: "sim" };

export function toolsetOf(tool: string): string | undefined {
  for (const [ts, names] of Object.entries(TOOLSETS)) if (names.includes(tool)) return ts;
  return LEGACY_TOOLSET_OF[tool];
}

interface Entry {
  tool: RegisteredTool;
  toolset: string;
  hidden: boolean;
  enabled: boolean;
}

export class ToolsetManager {
  private readonly entries = new Map<string, Entry>();
  private readonly enabledSets = new Set<string>();

  constructor(private readonly server: McpServer, private readonly policy: Policy) {}

  /** Every tool starts disabled. Hidden-by-policy tools are removed outright. */
  register(name: string, tool: RegisteredTool, toolset: string): void {
    if (!(toolset in TOOLSETS)) throw new Error(`unknown toolset "${toolset}" for tool ${name}`);
    const hidden = !this.visible(name);
    if (hidden) tool.remove();
    else tool.disable();
    this.entries.set(name, { tool, toolset, hidden, enabled: false });
  }

  /** Policy visibility with no arguments: readonly hides every non-read tool. */
  visible(tool: string): boolean {
    return decide(this.policy, tool, {}) !== "hidden";
  }

  isEnabled(tool: string): boolean {
    return this.entries.get(tool)?.enabled ?? false;
  }

  tools(toolset: string): string[] {
    this.assertToolset(toolset);
    return [...this.entries.entries()].filter(([, e]) => e.toolset === toolset).map(([n]) => n).sort();
  }

  hiddenTools(): string[] {
    return [...this.entries.entries()].filter(([, e]) => e.hidden).map(([n]) => n).sort();
  }

  /** Enables the toolset; returns the sorted names newly enabled by this call. */
  enable(toolset: string): string[] {
    this.assertToolset(toolset);
    const changed: string[] = [];
    for (const [name, e] of this.entries) {
      if (e.toolset !== toolset || e.hidden || e.enabled) continue;
      e.tool.enable();
      e.enabled = true;
      changed.push(name);
    }
    this.enabledSets.add(toolset);
    changed.sort();
    if (changed.length > 0) this.notify();
    return changed;
  }

  /** Disables the toolset; returns the sorted names newly disabled. `core` is refused. */
  disable(toolset: string): string[] {
    this.assertToolset(toolset);
    if (toolset === "core") throw new Error("the core toolset cannot be disabled");
    const changed: string[] = [];
    for (const [name, e] of this.entries) {
      if (e.toolset !== toolset || !e.enabled) continue;
      e.tool.disable();
      e.enabled = false;
      changed.push(name);
    }
    this.enabledSets.delete(toolset);
    changed.sort();
    if (changed.length > 0) this.notify();
    return changed;
  }

  /** Enabled toolsets, in TOOLSETS key order. */
  enabled(): string[] {
    return Object.keys(TOOLSETS).filter((ts) => this.enabledSets.has(ts));
  }

  describe(toolset: string): {
    name: string;
    description: string;
    enabled: boolean;
    tools: Array<{ name: string; tier: Tier; enabled: boolean; hidden: boolean }>;
  } {
    this.assertToolset(toolset);
    const tools = TOOLSETS[toolset].map((name) => {
      const e = this.entries.get(name);
      return { name, tier: tierOf(name, {}), enabled: e?.enabled ?? false, hidden: e?.hidden ?? !this.visible(name) };
    });
    return { name: toolset, description: TOOLSET_DESCRIPTIONS[toolset] ?? "", enabled: this.enabledSets.has(toolset), tools };
  }

  private assertToolset(toolset: string): void {
    if (!(toolset in TOOLSETS)) {
      throw new Error(`unknown toolset "${toolset}"; known: ${Object.keys(TOOLSETS).join(", ")}`);
    }
  }

  private notify(): void {
    try {
      this.server.sendToolListChanged();
    } catch {
      // not connected yet — the initial list is served on first tools/list
    }
  }
}

function splitList(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `core` + $CROSSPAD_TOOLSETS + `--toolsets a,b` (or `--toolsets=a,b`); `all` expands; result in TOOLSETS order. */
export function initialToolsets(argv: string[], env: NodeJS.ProcessEnv): string[] {
  const wanted = new Set<string>(["core"]);
  const requested: string[] = splitList(env.CROSSPAD_TOOLSETS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--toolsets") requested.push(...splitList(argv[i + 1]));
    else if (a.startsWith("--toolsets=")) requested.push(...splitList(a.slice("--toolsets=".length)));
  }
  for (const r of requested) {
    if (r === "all") { for (const ts of Object.keys(TOOLSETS)) wanted.add(ts); continue; }
    if (r in TOOLSETS) wanted.add(r);
    else console.error(`crosspad-mcp: ignoring unknown toolset "${r}" (known: ${Object.keys(TOOLSETS).join(", ")})`);
  }
  return Object.keys(TOOLSETS).filter((ts) => wanted.has(ts));
}

export function hasReadOnlyFlag(argv: string[]): boolean {
  return argv.includes("--read-only");
}
```

- [ ] **Step 4: Run the ToolsetManager tests**

Run: `npx vitest run src/toolsets.test.ts`
Expected: PASS (10 tests). If `tsc` later complains that `./hil/daemon.js`, `./tasks.js` or `./handles.js` do not exist yet, that is the C1/C3 dependency — those files must exist before Step 9's `tsc`; vitest does not type-check so this step passes regardless.

- [ ] **Step 5: Write the failing `crosspad_toolsets` tool test**

`src/tools/toolsets-tool.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { TOOLSETS, ToolsetManager } from "../toolsets.js";
import { registerToolsetsTool } from "./toolsets-tool.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";

function ctxWith(policy: Policy): ToolContext {
  // Only `policy` is read by this tool; the rest are never touched here.
  return { policy, daemon: () => { throw new Error("no daemon in test"); }, jobs: {} as never, handles: {} as never };
}

async function setup(policy: Policy) {
  const server = new McpServer({ name: "t", version: "0" });
  const manager = new ToolsetManager(server, policy);
  for (const [toolset, names] of Object.entries(TOOLSETS)) {
    for (const name of names) {
      if (name === "crosspad_toolsets") continue;
      const tool = server.registerTool(name, { description: name, inputSchema: { x: z.string().optional() } },
        async () => ({ content: [{ type: "text", text: name }] }));
      manager.register(name, tool, toolset);
    }
  }
  manager.register("crosspad_toolsets", registerToolsetsTool(server, ctxWith(policy), manager), "core");
  manager.enable("core");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "crosspad_toolsets", arguments: args });
    return { r, sc: r.structuredContent as Record<string, any> };
  };
  return { server, client, manager, call };
}

describe("crosspad_toolsets", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup({ mode: "strict", rules: [] }); });
  afterEach(async () => { await s.client.close(); await s.server.close(); });

  it("list reports every toolset with enabled flag and tool names", async () => {
    const { sc } = await s.call({ action: "list" });
    expect(sc.success).toBe(true);
    expect(sc.policy_mode).toBe("strict");
    expect(sc.enabled).toEqual(["core"]);
    const core = sc.toolsets.find((t: any) => t.name === "core");
    expect(core.enabled).toBe(true);
    expect(core.tools).toEqual(TOOLSETS.core);
    expect(sc.toolsets.map((t: any) => t.name)).toEqual(Object.keys(TOOLSETS));
  });

  it("enable adds tools and they become callable", async () => {
    const { sc } = await s.call({ action: "enable", toolset: "git" });
    expect(sc.success).toBe(true);
    expect(sc.added).toEqual(["crosspad_commit", "crosspad_repo_diff", "crosspad_submodule_update"]);
    expect(sc.enabled).toEqual(["core", "git"]);
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("crosspad_commit");
    const r = await s.client.callTool({ name: "crosspad_commit", arguments: {} });
    expect((r.content as any)[0].text).toBe("crosspad_commit");
  });

  it("disable removes tools; disabling core / unknown names is a BAD_ARGS error", async () => {
    await s.call({ action: "enable", toolset: "sim" });
    const { sc } = await s.call({ action: "disable", toolset: "sim" });
    expect(sc.removed).toEqual([...TOOLSETS.sim].sort());
    const core = await s.call({ action: "disable", toolset: "core" });
    expect(core.r.isError).toBe(true);
    expect(core.sc.error.code).toBe("BAD_ARGS");
    const bogus = await s.call({ action: "enable", toolset: "bogus" });
    expect(bogus.r.isError).toBe(true);
    expect(bogus.sc.error.code).toBe("BAD_ARGS");
    expect(bogus.sc.error.hint).toContain("core, device, hil, sim, code, git, apps, trace");
  });

  it("enable/disable/describe without toolset is BAD_ARGS", async () => {
    const { r, sc } = await s.call({ action: "enable" });
    expect(r.isError).toBe(true);
    expect(sc.error.code).toBe("BAD_ARGS");
  });

  it("describe lists tier per tool", async () => {
    const { sc } = await s.call({ action: "describe", toolset: "core" });
    expect(sc.toolset.name).toBe("core");
    expect(sc.toolset.tools.find((t: any) => t.name === "crosspad_flash").tier).toBe("danger");
    expect(sc.toolset.tools.find((t: any) => t.name === "crosspad_devices").tier).toBe("read");
  });

  it("readonly: enable reports what stayed hidden", async () => {
    await s.client.close(); await s.server.close();
    s = await setup({ mode: "readonly", rules: [] });
    const { sc } = await s.call({ action: "enable", toolset: "git" });
    expect(sc.added).toEqual(["crosspad_repo_diff"]);
    expect(sc.hidden_by_policy).toEqual(["crosspad_commit", "crosspad_submodule_update"]);
    expect(sc.policy_mode).toBe("readonly");
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/tools/toolsets-tool.test.ts`
Expected: FAIL with `Error: Failed to resolve import "./toolsets-tool.js"`.

- [ ] **Step 7: Write `src/tools/toolsets-tool.ts`**

```ts
// crosspad_toolsets — the meta-tool that turns toolsets on and off at runtime
// (spec §3.1). Read tier: it only changes what the server advertises; the
// manager refuses to enable tools the policy hides.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResponse, errorResult } from "../response.js";
import { annotationsFor } from "../policy/tiers.js";
import { enforce } from "../policy/confirm.js";
import { TOOLSETS, TOOLSET_DESCRIPTIONS, type ToolsetManager } from "../toolsets.js";
import type { ToolContext } from "../tool-context.js";

const TOOL = "crosspad_toolsets";
const KNOWN = Object.keys(TOOLSETS).join(", ");

const O_Toolsets = {
  success: z.boolean(),
  policy_mode: z.string(),
  enabled: z.array(z.string()),
  toolsets: z
    .array(z.object({ name: z.string(), description: z.string(), enabled: z.boolean(), tools: z.array(z.string()) }))
    .optional(),
  toolset: z
    .object({
      name: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      tools: z.array(z.object({ name: z.string(), tier: z.string(), enabled: z.boolean(), hidden: z.boolean() })),
    })
    .optional(),
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  hidden_by_policy: z.array(z.string()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
};

export function registerToolsetsTool(server: McpServer, ctx: ToolContext, manager: ToolsetManager): RegisteredTool {
  return server.registerTool(
    TOOL,
    {
      description:
        "Manage which crosspad_* toolsets are visible. Only `core` is on at start. " +
        `Toolsets: ${KNOWN}. action=list shows all with enabled state; enable/disable take toolset=<name> ` +
        "(core cannot be disabled); describe lists each tool with its safety tier. " +
        "Enabling emits tools/list_changed — re-list tools afterwards. Tools hidden by a readonly policy never appear.",
      inputSchema: {
        action: z.enum(["list", "enable", "disable", "describe"]).describe("What to do"),
        toolset: z.string().optional().describe(`Toolset name for enable/disable/describe: ${KNOWN}`),
      },
      outputSchema: O_Toolsets,
      annotations: annotationsFor("read"),
    },
    async ({ action, toolset }, extra) => {
      const args: Record<string, unknown> = { action, toolset };
      const blocked = await enforce(server, extra, ctx.policy, TOOL, args, `${TOOL} ${action} ${toolset ?? ""}`.trim());
      if (blocked) return blocked;

      const base = { success: true, policy_mode: ctx.policy.mode };

      if (action === "list") {
        return jsonResponse({
          ...base,
          enabled: manager.enabled(),
          toolsets: Object.keys(TOOLSETS).map((name) => ({
            name,
            description: TOOLSET_DESCRIPTIONS[name] ?? "",
            enabled: manager.enabled().includes(name),
            tools: TOOLSETS[name],
          })),
        });
      }

      if (!toolset) {
        return errorResult("BAD_ARGS", `action=${action} needs toolset=<name>`, `known toolsets: ${KNOWN}`, { policy_mode: ctx.policy.mode, enabled: manager.enabled() });
      }
      if (!(toolset in TOOLSETS)) {
        return errorResult("BAD_ARGS", `unknown toolset "${toolset}"`, `known toolsets: ${KNOWN}`, { policy_mode: ctx.policy.mode, enabled: manager.enabled() });
      }

      if (action === "describe") {
        return jsonResponse({ ...base, enabled: manager.enabled(), toolset: manager.describe(toolset) });
      }

      if (action === "enable") {
        const added = manager.enable(toolset);
        const hidden = manager.hiddenTools().filter((n) => TOOLSETS[toolset].includes(n));
        return jsonResponse({ ...base, enabled: manager.enabled(), added, hidden_by_policy: hidden });
      }

      // disable
      if (toolset === "core") {
        return errorResult("BAD_ARGS", "the core toolset cannot be disabled", "disable any other toolset, or restart the server with a narrower --toolsets", { policy_mode: ctx.policy.mode, enabled: manager.enabled() });
      }
      const removed = manager.disable(toolset);
      return jsonResponse({ ...base, enabled: manager.enabled(), removed });
    },
  );
}
```

- [ ] **Step 8: Run the tool tests**

Run: `npx vitest run src/tools/toolsets-tool.test.ts src/toolsets.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 9: Write `src/registry.ts` with its test, then restructure `src/index.ts`**

`src/registry.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerAll } from "./registry.js";
import { ToolsetManager, TOOLSETS } from "./toolsets.js";
import type { ToolContext } from "./tool-context.js";

describe("registerAll", () => {
  it("registers crosspad_toolsets and files legacy tools into their toolsets; unknown legacy names go nowhere", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const policy = { mode: "strict" as const, rules: [] };
    const manager = new ToolsetManager(server, policy);
    const ctx: ToolContext = { policy, daemon: () => { throw new Error("none"); }, jobs: {} as never, handles: {} as never };
    const legacy = new Map<string, RegisteredTool>();
    for (const name of ["crosspad_build", "crosspad_commit", "crosspad_log", "crosspad_obsolete"]) {
      legacy.set(name, server.registerTool(name, { description: name, inputSchema: { x: z.string().optional() } },
        async () => ({ content: [{ type: "text", text: name }] })));
    }
    registerAll(server, ctx, manager, legacy);
    manager.enable("core");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["crosspad_build", "crosspad_toolsets"]);
    manager.enable("git"); manager.enable("sim");
    const after = (await client.listTools()).tools.map((t) => t.name);
    expect(after).toEqual(["crosspad_build", "crosspad_commit", "crosspad_log", "crosspad_toolsets"]);
    expect(after).not.toContain("crosspad_obsolete");
    expect(Object.keys(TOOLSETS)).toContain("hil");
    await client.close(); await server.close();
  });
});
```

`src/registry.ts`:
```ts
// One place that knows every tool and its toolset (spec §3.1).
// New-style tools (register<Name>Tool from src/tools/*) are registered first,
// in TOOLSETS order; v9 tools still registered inline by index.ts arrive via
// `legacy` and are filed into their toolset unless a new-style tool of the
// same name already replaced them. A legacy name with no toolset is removed.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolsetManager, toolsetOf } from "./toolsets.js";
import type { ToolContext } from "./tool-context.js";
import { registerToolsetsTool } from "./tools/toolsets-tool.js";

export function registerAll(
  server: McpServer,
  ctx: ToolContext,
  manager: ToolsetManager,
  legacy?: Map<string, RegisteredTool>,
): void {
  const registered = new Set<string>();

  // ── new-style tools (chunks C1/C3 append their lines here, in TOOLSETS order) ──
  manager.register("crosspad_toolsets", registerToolsetsTool(server, ctx, manager), "core");
  registered.add("crosspad_toolsets");

  // ── legacy v9 tools registered inline by index.ts ──
  for (const [name, tool] of legacy ?? []) {
    if (registered.has(name)) { tool.remove(); continue; }
    const toolset = toolsetOf(name);
    if (!toolset) { tool.remove(); continue; }
    manager.register(name, tool, toolset);
    registered.add(name);
  }
}
```

Now `src/index.ts`. Apply these edits in order (line numbers refer to the file as it is before any edit; do them bottom-up or re-grep after each):

(a) Response helpers → import. Delete lines 119–149 (the `RESPONSE HELPERS` banner through the closing brace of `err`) and add to the import block after line 5:
```ts
import { jsonResponse, ok, err } from "./response.js";
import type { RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { loadPolicy } from "./policy/policy.js";
import { ToolsetManager, initialToolsets, hasReadOnlyFlag } from "./toolsets.js";
import { registerAll } from "./registry.js";
import type { ToolContext } from "./tool-context.js";
import { getHilDaemon } from "./hil/daemon.js";
import { jobs } from "./tasks.js";
import { handles } from "./handles.js";
```
`ok` is unused after the move only if it was unused before; keep whatever `index.ts` actually references (grep `ok(` — if absent, do not import it).

(b) Immediately after `export const server = new McpServer(...)` (line 81–84) add:
```ts
// v9 tools are still registered inline below. Capturing them here lets
// registerAll() file each one into its toolset (spec §3.1) without moving
// 1 200 lines; the SDK's tools/list order is this file's order — stable.
export const legacyTools = new Map<string, RegisteredTool>();
function registerLegacy<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>,
): RegisteredTool {
  const tool = server.registerTool<OutputArgs, InputArgs>(name, config, cb);
  legacyTools.set(name, tool);
  return tool;
}
```

(c) Rewrite the 30 inline call sites in one pass:
```bash
sed -i 's/^server\.registerTool(/registerLegacy(/' src/index.ts
grep -c '^registerLegacy(' src/index.ts   # must print 30
grep -c '^server\.registerTool(' src/index.ts   # must print 0
```

(d) Server instructions: append this paragraph inside the `SERVER_INSTRUCTIONS` template (before the closing backtick, after the `DISCOVERY:` line):
```
TOOLSETS: only the \`core\` toolset (devices, doctor, snapshot, build, flash, repo_status, toolsets, task) is visible at start. Other tools live in toolsets — device (cdc/console/ui/midi/usb_mode/audio_route), sim (run/kill/check/screenshot/input/stats/settings/test_run), code (search_symbols/list_interfaces/…), git (repo_diff/submodule_update/commit), apps (apps_*), trace (crosspad_trace), hil. If a tool you need is not listed, call crosspad_toolsets action=enable toolset=<name> and re-list tools; do NOT fall back to the shell. The server also accepts --toolsets a,b / CROSSPAD_TOOLSETS at startup and --read-only (hides every non-read tool).

SAFETY: flash, bootloader/DFU requests, trace write/call are "danger" tier. In the default strict policy the tool returns resultType="confirmation_required" with a confirm_token instead of acting; re-issue the identical call with confirm_token to proceed (120 s), or the client is asked directly when it supports elicitation. A declined confirmation returns error code CANCELLED_BY_USER — do not retry it on your own.
```

(e) Wiring: insert right before the `// START — stdio (default) or HTTP` banner (line 1672 pre-edit):
```ts
// ═══════════════════════════════════════════════════════════════════════
// v10 WIRING — policy, toolsets, registry
// ═══════════════════════════════════════════════════════════════════════

const startupArgv = process.argv.slice(2);
export const policy = loadPolicy({ env: process.env, readOnlyFlag: hasReadOnlyFlag(startupArgv) });
export const toolContext: ToolContext = { daemon: getHilDaemon, policy, jobs, handles };
export const toolsetManager = new ToolsetManager(server, policy);
registerAll(server, toolContext, toolsetManager, legacyTools);
for (const ts of initialToolsets(startupArgv, process.env)) toolsetManager.enable(ts);
console.error(
  `crosspad-mcp v${version}: policy=${policy.mode} toolsets=${toolsetManager.enabled().join(",")}` +
    (toolsetManager.hiddenTools().length ? ` hidden=${toolsetManager.hiddenTools().length}` : ""),
);
```
`parseHttpPort` and `main()` stay exactly as they are (`--http` unchanged). `--toolsets` and `--read-only` are read by the block above, so `main()` needs no change.

(f) `src/index.mcp.test.ts`: the roundtrip tests exercise sim/trace/git tools that are now off by default and would also see a developer's own `policy.json`. At the very top of the file (before the first `import`) add:
```ts
import { vi } from "vitest";
vi.hoisted(() => {
  process.env.CROSSPAD_MCP_POLICY_FILE = "/nonexistent/crosspad-mcp/policy.json";
  process.env.CROSSPAD_TOOLSETS = "all";
  delete process.env.CROSSPAD_MCP_POLICY;
});
```
(vitest hoists `vi.hoisted` above the static imports, so `index.ts` reads these when it loads.) The existing `import { describe, it, expect, vi, ... } from "vitest"` on line 5 stays; a duplicate named import of `vi` from the same module is allowed by TypeScript only once — so change line 5 to drop `vi` from its list. No other change: line 80's `import { server, setTraceBrowserOpener } from "./index.js"` still works.

- [ ] **Step 10: Type-check, run the full suite, smoke the binary**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` silent, exit 0; vitest PASS for every file (the three new ones plus the existing suite; `index.mcp.test.ts` unchanged in outcome).

Run: `npm run build && node dist/index.js --read-only --toolsets git,bogus < /dev/null; echo "exit=$?"`
Expected: stderr contains `ignoring unknown toolset "bogus"` and `policy=readonly toolsets=core,git hidden=`; exit 0 (stdin EOF ends the stdio transport).

Run (tool list size check, the P0 exit criterion "< 2.5k tokens"):
```bash
node -e '
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
(async () => {
  const c = new Client({ name: "sz", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
  const t = (await c.listTools()).tools;
  console.log("tools:", t.map(x => x.name).join(","));
  console.log("approx tokens:", Math.round(JSON.stringify(t).length / 4));
  await c.close();
})();'
```
Expected: `tools:` lists only core names (`crosspad_build, crosspad_flash, crosspad_devices, crosspad_repo_status, crosspad_toolsets` in this file's order — `crosspad_doctor`, `crosspad_snapshot`, `crosspad_task` appear once C1/C3 register them) and `approx tokens:` well under 2500.

- [ ] **Step 11: Commit**

```bash
git add src/toolsets.ts src/toolsets.test.ts src/tool-context.ts src/tools/toolsets-tool.ts src/tools/toolsets-tool.test.ts src/registry.ts src/registry.test.ts src/index.ts src/index.mcp.test.ts
git commit -m "feat(toolsets): dynamic toolsets, crosspad_toolsets meta-tool, registry, --toolsets/--read-only"
```
# Plan C — chunk C3: devices/doctor, console + device resources, cdc/ui/snapshot

Repo: `/home/matixan/GIT/crosspad-mcp` (TypeScript ESM, strict, zod 4, `@modelcontextprotocol/sdk` 1.29, vitest 4).
Node: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22` before every `npx vitest` / `npx tsc` (system Node 18 is too old for vitest 4).

Every tool module in this chunk follows one shape (from the C contract):

```ts
export function register<Name>Tool(server: McpServer, ctx: ToolContext): RegisteredTool
```

with `ToolContext` from `src/tool-context.ts` (`{ daemon: () => HilDaemon; policy: Policy; jobs: JobRegistry; handles: HandleRegistry }`), policy gate via `decide()` (`src/policy/policy.ts`), confirmation via `requireConfirmation()` (`src/policy/confirm.ts`), annotations via `annotationsFor(tierOf(name, {}))` (`src/policy/tiers.ts`), daemon ops via `ctx.daemon().request(op, args)` (`src/hil/daemon.ts`), and schemas from `src/hil/schemas.ts`. Those modules are written by chunks C1/C2; this chunk only consumes their exported names verbatim.

Shared conventions this chunk relies on (state once, use everywhere):

- **Result envelope** — `src/tool-result.ts` (created in Task 5, Step 3a; if chunk C1 already created a file exporting `jsonResponse`, import from there instead and delete the duplicate — the function body is byte-identical to the one in `src/index.ts:125`).
- **Test fakes** — `src/testing/fake-daemon.ts` and `src/testing/fake-server.ts` (created in Task 5, Step 1a). They are plain TS (not `*.test.ts`) so every task's tests can import them; they never spawn a process.
- **Policy used in tests** — `{ mode: "lab", rules: [] }` (everything allowed, danger still confirms) unless a test says otherwise.
- **Daemon op names** — verbatim from the Python contract `serve.py` section: `devices.list`, `devices.doctor`, `console.open|read|expect|reset|snapshot|close`, `cdc.verb`, `cdc.transact`, `snapshot.take`.

---

### Task 5: `crosspad_devices` over the daemon + `crosspad_doctor`

**Files:**
- Create: `src/tool-result.ts`
- Create: `src/testing/fake-daemon.ts`
- Create: `src/testing/fake-server.ts`
- Create: `src/tools/devices.ts`
- Create: `src/tools/doctor.ts`
- Modify: `package.json` (add `"hilVersion": "1.0.0"` after `"version"`, line 3)
- Modify: `src/utils/userConfig.ts:6-19` (add `hil_python?: string` to `UserConfig`, only if chunk C1 has not already)
- Test: `src/tools/devices.test.ts`, `src/tools/doctor.test.ts`

**Interfaces:**
- Consumes:
  - `HilDaemon.request<T>(op: string, args: Record<string, unknown>, opts?: {signal?: AbortSignal; timeoutMs?: number}): Promise<T>` and `class HilError extends Error { code: string; hint?: string; details: Record<string, unknown> }` from `src/hil/daemon.ts`.
  - `DeviceSchema`, `DoctorCheckSchema` (+ inferred `Device`, `DoctorCheck`) from `src/hil/schemas.ts`.
  - `ToolContext` from `src/tool-context.ts`; `decide(policy, tool, args): "allow"|"confirm"|"hidden"` from `src/policy/policy.ts`; `annotationsFor(tier)`, `tierOf(tool, args)` from `src/policy/tiers.ts`.
  - `resolveConfigValue`, `loadUserConfig` from `src/utils/userConfig.ts`; `resolvedPython()` from `src/tools/trace-symbols.ts`; `runArgvStream` from `src/utils/exec.ts`; `CROSSPAD_IDF_ROOT`, `CROSSPAD_PC_ROOT`, `IDF_PATH`, `BIN_EXE`, `IS_WINDOWS` from `src/config.ts`.
- Produces:
  - `src/tool-result.ts`: `jsonResponse(data: object): CallToolResult-like`, `toolError(e: unknown): CallToolResult-like` (maps `HilError` → `{success:false, error:{code,message,hint}, details}`, other errors → code `"INTERNAL"`).
  - `src/testing/fake-daemon.ts`: `fakeDaemon(handlers: Record<string, (args: Record<string, unknown>) => unknown>): FakeDaemon` where `FakeDaemon = HilDaemon & { calls: Array<{op: string; args: Record<string, unknown>}> }`.
  - `src/testing/fake-server.ts`: `fakeServer(): { server: McpServer; tools: Map<string, FakeTool>; listChanged: number }`, `FakeTool = { config: any; cb: (args: any, extra: any) => Promise<any>; enabled: boolean }`, `fakeExtra(): RequestHandlerExtra-like` (no progress token, `signal = new AbortController().signal`).
  - `src/tools/devices.ts`: `export function registerDevicesTool(server, ctx): RegisteredTool`; `export function toV10DeviceRow(d: Device): DeviceRow`; `export interface DeviceRow extends Device { kind: "esp-native"|"stm-bridge"; port: string|null; vid: number|null; pid: number|null; is_crosspad: true }`; `export function selectedId(rows: DeviceRow[]): string|undefined`.
  - `src/tools/doctor.ts`: `export function registerDoctorTool(server, ctx): RegisteredTool`; `export interface DoctorProbe { hilPython(): string; pythonRunnable(py: string): Promise<boolean>; hilVersion(py: string): Promise<string|null>; requiredHilVersion(): string; idfRoot(): string; idfExportExists(): boolean; pcRoot(): string; exists(p: string): boolean; mtimeMs(p: string): number|null; newestSourceMtimeMs(root: string): number|null; simBinary(): string }`; `export async function runDoctorChecks(p: DoctorProbe, daemonChecks: () => Promise<DoctorCheck[]>): Promise<DoctorCheck[]>`; `export function realProbe(): DoctorProbe`; `export function compareVersions(a: string, b: string): number`.
  - `crosspad_doctor` result: `{ success, ok: boolean, checks: DoctorCheck[] }` where `DoctorCheck = {name, ok, detail, fix}` (`fix` is `""` when nothing to do).
  - `crosspad_devices` result: `{ success: true, devices: DeviceRow[], crosspad_count: number, selected?: string, ts: number }`.

Contract choices stated here (the contract is silent): `kind` is `"stm-bridge"` when `ports.console` is non-null (an STM VCP was paired), otherwise `"esp-native"`; `port` is `ports.cdc.path ?? ports.bootloader.path ?? ports.console.path ?? null`; `selected` is the id of the single device with an ESP side (`ports.cdc` or `ports.bootloader` non-null), matching `select()` in `devices.py`.

- [ ] **Step 1a: Write the shared fakes and the result helper**

`src/testing/fake-daemon.ts`:

```ts
// src/testing/fake-daemon.ts — a HilDaemon stand-in for vitest. Never spawns.
import { HilDaemon, HilError } from "../hil/daemon.js";

export type FakeDaemon = HilDaemon & { calls: Array<{ op: string; args: Record<string, unknown> }> };

/**
 * Build a daemon whose request() dispatches to `handlers[op]`. Unknown ops
 * raise HilError("UNKNOWN_OP") so a test that forgets a handler fails loudly
 * instead of resolving undefined. A handler may throw a HilError to simulate a
 * daemon error reply.
 */
export function fakeDaemon(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): FakeDaemon {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const d = Object.create(HilDaemon.prototype) as FakeDaemon;
  d.calls = calls;
  Object.defineProperty(d, "alive", { get: () => true });
  (d as any).start = async () => {};
  (d as any).stop = async () => {};
  (d as any).request = async (op: string, args: Record<string, unknown>) => {
    calls.push({ op, args });
    const h = handlers[op];
    if (!h) throw new HilError("UNKNOWN_OP", `fakeDaemon: no handler for ${op}`);
    return h(args);
  };
  return d;
}
```

`src/testing/fake-server.ts`:

```ts
// src/testing/fake-server.ts — captures registerTool/registerResource calls.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface FakeTool {
  config: any;
  cb: (args: any, extra: any) => Promise<any>;
  enabled: boolean;
}

export interface FakeResource {
  name: string;
  uriOrTemplate: any;
  config: any;
  cb: (...a: any[]) => Promise<any>;
}

export interface FakeServerHandle {
  server: McpServer;
  tools: Map<string, FakeTool>;
  resources: Map<string, FakeResource>;
  listChanged: number;
  /** what server.server.getClientCapabilities() returns; default {} (no elicitation) */
  clientCapabilities: Record<string, unknown>;
}

export function fakeServer(): FakeServerHandle {
  const tools = new Map<string, FakeTool>();
  const resources = new Map<string, FakeResource>();
  const handle: FakeServerHandle = {
    server: undefined as unknown as McpServer,
    tools,
    resources,
    listChanged: 0,
    clientCapabilities: {},
  };
  const server: any = {
    registerTool(name: string, config: any, cb: any) {
      const t: FakeTool = { config, cb, enabled: true };
      tools.set(name, t);
      return {
        enable: () => { t.enabled = true; },
        disable: () => { t.enabled = false; },
        remove: () => { tools.delete(name); },
        update: () => {},
        enabled: true,
      };
    },
    registerResource(name: string, uriOrTemplate: any, config: any, cb: any) {
      resources.set(name, { name, uriOrTemplate, config, cb });
      return { enable() {}, disable() {}, remove() {}, update() {} };
    },
    sendToolListChanged() { handle.listChanged++; },
    server: {
      getClientCapabilities: () => handle.clientCapabilities,
      elicitInput: async () => ({ action: "decline" }),
      sendLoggingMessage: async () => {},
    },
  };
  handle.server = server as McpServer;
  return handle;
}

/** Minimal RequestHandlerExtra for calling a tool callback directly. */
export function fakeExtra(): any {
  return {
    signal: new AbortController().signal,
    _meta: {},
    sendNotification: async () => {},
    sendRequest: async () => ({}),
    requestId: 1,
  };
}
```

`src/tool-result.ts` (body of `jsonResponse` copied from `src/index.ts:125-141`):

```ts
// src/tool-result.ts — the uniform { success, ...data } envelope every tool returns.
import { HilError } from "./hil/daemon.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  [k: string]: unknown;
}

// from src/index.ts jsonResponse(): text + structuredContent, isError when success===false
export function jsonResponse(data: object): ToolResult {
  const dataAsRecord = data as Record<string, unknown>;
  const result: ToolResult = {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: dataAsRecord,
  };
  if (dataAsRecord.success === false) result.isError = true;
  return result;
}

/** Map any thrown value to the v10 error envelope {success:false, error:{code,message,hint}}. */
export function toolError(e: unknown): ToolResult {
  if (e instanceof HilError) {
    return jsonResponse({
      success: false,
      error: { code: e.code, message: e.message, hint: e.hint ?? undefined },
      details: e.details,
    });
  }
  const message = e instanceof Error ? e.message : String(e);
  return jsonResponse({ success: false, error: { code: "INTERNAL", message } });
}
```

- [ ] **Step 1b: Write the failing tests**

`src/tools/devices.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerDevicesTool, toV10DeviceRow, selectedId } from "./devices.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";
import { HilError } from "../hil/daemon.js";

const cdc = { path: "/dev/ttyACM0", vid: 0x303a, pid: 0x3456, serial: "AABBCCDD", product: "Crosspad", location: "1-2.1" };
const con = { path: "/dev/ttyACM1", vid: 0x0483, pid: 0x5740, serial: "STM001", product: "CrossPad MIDI+Serial", location: "1-2.2" };
const devA = {
  id: "dev_3f2a", serial: "AABBCCDD", usb_mode: "default", board_rev: null,
  ports: { cdc, console: con, esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
};
const devB = {
  id: "dev_9c11", serial: "EEFF0011", usb_mode: "default", board_rev: null,
  ports: { cdc: { ...cdc, path: "/dev/ttyACM2", serial: "EEFF0011" }, console: null, esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
};

function ctxWith(daemon: any): ToolContext {
  return { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
}

describe("toV10DeviceRow", () => {
  it("tags a paired STM VCP as stm-bridge and keeps the CDC path as port", () => {
    const row = toV10DeviceRow(devA as any);
    expect(row.kind).toBe("stm-bridge");
    expect(row.port).toBe("/dev/ttyACM0");
    expect(row.vid).toBe(0x303a);
    expect(row.pid).toBe(0x3456);
    expect(row.is_crosspad).toBe(true);
    expect(row.id).toBe("dev_3f2a");
  });
  it("tags an ESP-only device as esp-native", () => {
    expect(toV10DeviceRow(devB as any).kind).toBe("esp-native");
  });
  it("falls back to the bootloader then console port", () => {
    const boot = { ...devB, ports: { ...devB.ports, cdc: null, bootloader: { ...cdc, path: "/dev/ttyACM5", pid: 0x1001 } } };
    expect(toV10DeviceRow(boot as any).port).toBe("/dev/ttyACM5");
    const stmOnly = { ...devA, ports: { ...devA.ports, cdc: null } };
    expect(toV10DeviceRow(stmOnly as any).port).toBe("/dev/ttyACM1");
  });
});

describe("selectedId", () => {
  it("is the single device with an ESP side", () => {
    expect(selectedId([toV10DeviceRow(devA as any)])).toBe("dev_3f2a");
  });
  it("is undefined with two candidates or none", () => {
    expect(selectedId([toV10DeviceRow(devA as any), toV10DeviceRow(devB as any)])).toBeUndefined();
    const stmOnly = { ...devA, ports: { ...devA.ports, cdc: null } };
    expect(selectedId([toV10DeviceRow(stmOnly as any)])).toBeUndefined();
  });
});

describe("crosspad_devices tool", () => {
  it("registers with read annotations and returns rows from devices.list", async () => {
    const daemon = fakeDaemon({ "devices.list": () => ({ devices: [devA, devB] }) });
    const fs = fakeServer();
    registerDevicesTool(fs.server, ctxWith(daemon));
    const tool = fs.tools.get("crosspad_devices")!;
    expect(tool.config.annotations.readOnlyHint).toBe(true);
    const res = await tool.cb({}, fakeExtra());
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.crosspad_count).toBe(2);
    expect(res.structuredContent.selected).toBeUndefined();
    expect(daemon.calls[0]).toEqual({ op: "devices.list", args: {} });
  });
  it("sets selected when exactly one device", async () => {
    const daemon = fakeDaemon({ "devices.list": () => ({ devices: [devA] }) });
    const fs = fakeServer();
    registerDevicesTool(fs.server, ctxWith(daemon));
    const res = await fs.tools.get("crosspad_devices")!.cb({}, fakeExtra());
    expect(res.structuredContent.selected).toBe("dev_3f2a");
  });
  it("maps a daemon error into the error envelope", async () => {
    const daemon = fakeDaemon({ "devices.list": () => { throw new HilError("ENV", "pyserial missing", "pip install pyserial"); } });
    const fs = fakeServer();
    registerDevicesTool(fs.server, ctxWith(daemon));
    const res = await fs.tools.get("crosspad_devices")!.cb({}, fakeExtra());
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "ENV", hint: "pip install pyserial" });
  });
});
```

`src/tools/doctor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runDoctorChecks, compareVersions, registerDoctorTool, type DoctorProbe } from "./doctor.js";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import { HilError } from "../hil/daemon.js";
import type { ToolContext } from "../tool-context.js";

const NOW = 1_700_000_000_000;

function probe(over: Partial<DoctorProbe> = {}): DoctorProbe {
  return {
    hilPython: () => "/venv/bin/python",
    pythonRunnable: async () => true,
    hilVersion: async () => "1.0.0",
    requiredHilVersion: () => "1.0.0",
    idfRoot: () => "/git/platform-idf",
    idfExportExists: () => true,
    pcRoot: () => "/git/crosspad-pc",
    exists: (p) => ["/git/platform-idf", "/git/crosspad-pc", "/git/platform-idf/build_v2", "/git/platform-idf/build_v2/CrossPad.bin", "/git/crosspad-pc/bin/CrossPad"].includes(p),
    mtimeMs: (p) => (p.endsWith("CrossPad") || p.endsWith("CrossPad.bin") ? NOW - 60_000 : null),
    newestSourceMtimeMs: () => NOW - 120_000,
    simBinary: () => "/git/crosspad-pc/bin/CrossPad",
    ...over,
  };
}

const byName = (checks: Array<{ name: string; ok: boolean; detail: string; fix: string }>) =>
  Object.fromEntries(checks.map((c) => [c.name, c]));

describe("compareVersions", () => {
  it("orders semver numerically", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.3")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBeLessThan(0);
  });
});

describe("runDoctorChecks", () => {
  it("is all-ok with a healthy probe and merges daemon checks", async () => {
    const checks = await runDoctorChecks(probe(), async () => [{ name: "udev_dialout", ok: true, detail: "in dialout", fix: "" }]);
    const m = byName(checks);
    expect(m.hil_python.ok).toBe(true);
    expect(m.hil_version.ok).toBe(true);
    expect(m.idf_root.ok).toBe(true);
    expect(m.idf_env.ok).toBe(true);
    expect(m.pc_root.ok).toBe(true);
    expect(m.build_dirs.ok).toBe(true);
    expect(m.sim_binary.ok).toBe(true);
    expect(m.udev_dialout.ok).toBe(true);
    expect(checks.every((c) => c.ok)).toBe(true);
  });
  it("fails hil_version when crosspad_hil is older than package.json hilVersion", async () => {
    const checks = await runDoctorChecks(probe({ hilVersion: async () => "0.9.0", requiredHilVersion: () => "1.0.0" }), async () => []);
    const m = byName(checks);
    expect(m.hil_version.ok).toBe(false);
    expect(m.hil_version.fix).toContain("crosspad-hil");
  });
  it("fails hil_python when the interpreter cannot run and skips the version check", async () => {
    const checks = await runDoctorChecks(probe({ pythonRunnable: async () => false }), async () => []);
    const m = byName(checks);
    expect(m.hil_python.ok).toBe(false);
    expect(m.hil_version.ok).toBe(false);
    expect(m.hil_version.detail).toContain("skipped");
  });
  it("reports a stale sim binary", async () => {
    const checks = await runDoctorChecks(probe({ newestSourceMtimeMs: () => NOW }), async () => []);
    expect(byName(checks).sim_binary.ok).toBe(false);
    expect(byName(checks).sim_binary.fix).toContain("crosspad_build");
  });
  it("reports no build dir at all", async () => {
    const checks = await runDoctorChecks(probe({ exists: (p) => ["/git/platform-idf", "/git/crosspad-pc"].includes(p) }), async () => []);
    const m = byName(checks);
    expect(m.build_dirs.ok).toBe(false);
    expect(m.sim_binary.ok).toBe(false);
  });
  it("turns a daemon failure into a single failed 'daemon' check", async () => {
    const checks = await runDoctorChecks(probe(), async () => { throw new HilError("DAEMON_DIED", "exit 1", "reinstall"); });
    const m = byName(checks);
    expect(m.daemon.ok).toBe(false);
    expect(m.daemon.detail).toContain("exit 1");
  });
});

describe("crosspad_doctor tool", () => {
  it("returns ok=false when any check fails", async () => {
    const daemon = fakeDaemon({ "devices.doctor": () => ({ checks: [{ name: "port_locks", ok: false, detail: "/dev/ttyACM0 held by pid 4242 (console)", fix: "kill 4242" }] }) });
    const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
    const fs = fakeServer();
    registerDoctorTool(fs.server, ctx, probe());
    const res = await fs.tools.get("crosspad_doctor")!.cb({}, fakeExtra());
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.ok).toBe(false);
    const names = (res.structuredContent.checks as any[]).map((c) => c.name);
    expect(names).toContain("port_locks");
    expect(names).toContain("hil_python");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/tools/devices.test.ts src/tools/doctor.test.ts`
Expected: FAIL with `Failed to resolve import "./devices.js"` / `Failed to resolve import "./doctor.js"`.

- [ ] **Step 3a: package.json + userConfig key**

`package.json` line 3 → after `"version": "9.3.0",` add a line `"hilVersion": "1.0.0",`.

`src/utils/userConfig.ts` — inside `export interface UserConfig { … }` add (skip if chunk C1 already added it):

```ts
  /** Python interpreter with `crosspad_hil` importable; spawns `-m crosspad_hil.serve`.
   *  Resolution: this key → $CROSSPAD_HIL_PYTHON → pyocd_python (tracer venv) → "python3". */
  hil_python?: string;
```

- [ ] **Step 3b: Write `src/tools/devices.ts`**

```ts
// src/tools/devices.ts — crosspad_devices: inventory from the crosspad-hil daemon.
// Output is a superset of v9 (port / vid / pid / is_crosspad / kind) on top of the
// contract's Device dict, so existing prompts that read `devices[].port` keep working.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceSchema, type Device } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { jsonResponse, toolError } from "../tool-result.js";

export const TOOL_NAME = "crosspad_devices";

export interface DeviceRow extends Device {
  /** v9 compatibility: rev <2.0 boards are "esp-native"; a paired STM VCP means "stm-bridge". */
  kind: "esp-native" | "stm-bridge";
  /** v9 compatibility: the port a flasher would talk to (CDC → bootloader → console). */
  port: string | null;
  vid: number | null;
  pid: number | null;
  is_crosspad: true;
}

const DeviceRowSchema = DeviceSchema.extend({
  kind: z.enum(["esp-native", "stm-bridge"]),
  port: z.string().nullable(),
  vid: z.number().int().nullable(),
  pid: z.number().int().nullable(),
  is_crosspad: z.literal(true),
});

export const O_DevicesV10 = {
  success: z.boolean(),
  devices: z.array(DeviceRowSchema).optional(),
  crosspad_count: z.number().int().optional(),
  selected: z.string().optional(),
  ts: z.number().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

export function toV10DeviceRow(d: Device): DeviceRow {
  const p = d.ports;
  const primary = p.cdc ?? p.bootloader ?? p.console ?? null;
  return {
    ...d,
    kind: p.console ? "stm-bridge" : "esp-native",
    port: primary ? primary.path : null,
    vid: primary ? primary.vid : null,
    pid: primary ? primary.pid : null,
    is_crosspad: true,
  };
}

/** Mirrors devices.select(): implicit selection only when exactly one device has an ESP side. */
export function selectedId(rows: DeviceRow[]): string | undefined {
  const esp = rows.filter((r) => r.ports.cdc !== null || r.ports.bootloader !== null);
  return esp.length === 1 ? esp[0].id : undefined;
}

export function registerDevicesTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] List connected CrossPads as seen by the crosspad-hil daemon: id (dev_xxxx, stable per USB serial), usb_mode (default|audio|bootloader|unknown), and every port role (cdc, console=STM VCP, esp_midi, stm_midi, uac2, bootloader). `kind` keeps the v9 meaning: 'esp-native' (rev <2.0) or 'stm-bridge' (rev 2.0, STM32 composite CDC+MIDI). `selected` is set when exactly one device would be chosen implicitly by every other tool.",
      inputSchema: {},
      outputSchema: O_DevicesV10,
      annotations: annotationsFor(tierOf(TOOL_NAME, {})),
    },
    async (_args, extra) => {
      if (decide(ctx.policy, TOOL_NAME, {}) === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      try {
        const raw = await ctx.daemon().request<{ devices: unknown[] }>("devices.list", {}, { signal: extra.signal });
        const devices = raw.devices.map((d) => toV10DeviceRow(DeviceSchema.parse(d)));
        const selected = selectedId(devices);
        return jsonResponse({
          success: true,
          devices,
          crosspad_count: devices.length,
          ...(selected ? { selected } : {}),
          ts: Date.now(),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
```

- [ ] **Step 3c: Write `src/tools/doctor.ts`**

```ts
// src/tools/doctor.ts — crosspad_doctor: host-side environment checks (TS) merged
// with the daemon's own devices.doctor (udev/dialout, port locks, rtmidi, sounddevice).
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DoctorCheckSchema, type DoctorCheck } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { jsonResponse, toolError } from "../tool-result.js";
import { resolveConfigValue } from "../utils/userConfig.js";
import { resolvedPython } from "./trace-symbols.js";
import { runArgvStream } from "../utils/exec.js";
import { CROSSPAD_IDF_ROOT, CROSSPAD_PC_ROOT, IDF_PATH, BIN_EXE, IS_WINDOWS } from "../config.js";

export const TOOL_NAME = "crosspad_doctor";

const require = createRequire(import.meta.url);

export interface DoctorProbe {
  hilPython(): string;
  pythonRunnable(py: string): Promise<boolean>;
  /** crosspad_hil.__version__ or null when not importable. */
  hilVersion(py: string): Promise<string | null>;
  requiredHilVersion(): string;
  idfRoot(): string;
  idfExportExists(): boolean;
  pcRoot(): string;
  exists(p: string): boolean;
  mtimeMs(p: string): number | null;
  /** Newest *.c/*.cpp/*.h/*.hpp mtime under root/src (bounded walk), or null. */
  newestSourceMtimeMs(root: string): number | null;
  simBinary(): string;
}

export const O_Doctor = {
  success: z.boolean(),
  ok: z.boolean().optional(),
  checks: z.array(DoctorCheckSchema).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/** Numeric semver compare on the first three dot-separated components (pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Same resolution as getHilDaemon(): config hil_python → $CROSSPAD_HIL_PYTHON → tracer venv python → python3. */
export function resolveHilPython(): string {
  return resolveConfigValue("hil_python", "CROSSPAD_HIL_PYTHON", process.env.CROSSPAD_HIL_PYTHON, resolvedPython());
}

function ageText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export async function runDoctorChecks(
  p: DoctorProbe,
  daemonChecks: () => Promise<DoctorCheck[]>,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. hil_python resolvable and runnable
  const py = p.hilPython();
  const runnable = await p.pythonRunnable(py);
  checks.push({
    name: "hil_python",
    ok: runnable,
    detail: runnable ? `interpreter: ${py}` : `cannot run ${py}`,
    fix: runnable ? "" : "Set config key 'hil_python' to a Python ≥3.10 with crosspad-hil installed (crosspad_trace action=config_set key=hil_python), or install it: python3 -m pip install 'crosspad-hil[all]'.",
  });

  // 2. crosspad_hil importable and new enough
  const required = p.requiredHilVersion();
  if (!runnable) {
    checks.push({ name: "hil_version", ok: false, detail: "skipped: interpreter not runnable", fix: "Fix hil_python first." });
  } else {
    const v = await p.hilVersion(py);
    if (v === null) {
      checks.push({
        name: "hil_version",
        ok: false,
        detail: `crosspad_hil not importable from ${py}`,
        fix: `${py} -m pip install 'crosspad-hil[all]>=${required}'`,
      });
    } else {
      const ok = compareVersions(v, required) >= 0;
      checks.push({
        name: "hil_version",
        ok,
        detail: ok ? `crosspad-hil ${v} (≥ ${required})` : `crosspad-hil ${v} is older than required ${required}`,
        fix: ok ? "" : `${py} -m pip install --upgrade 'crosspad-hil[all]>=${required}'`,
      });
    }
  }

  // 3. IDF project root
  const idfRoot = p.idfRoot();
  const idfOk = p.exists(idfRoot);
  checks.push({
    name: "idf_root",
    ok: idfOk,
    detail: idfOk ? idfRoot : `platform-idf not found at ${idfRoot}`,
    fix: idfOk ? "" : "Clone CrossPad/platform-idf or set CROSSPAD_IDF_ROOT.",
  });

  // 4. IDF environment (export.sh / export.bat)
  const idfEnv = p.idfExportExists();
  checks.push({
    name: "idf_env",
    ok: idfEnv,
    detail: idfEnv ? `ESP-IDF at ${IDF_PATH}` : `no export script under ${IDF_PATH}`,
    fix: idfEnv ? "" : "Install ESP-IDF v5.5 (~/esp/esp-idf) or set IDF_PATH.",
  });

  // 5. PC root
  const pcRoot = p.pcRoot();
  const pcOk = p.exists(pcRoot);
  checks.push({
    name: "pc_root",
    ok: pcOk,
    detail: pcOk ? pcRoot : `crosspad-pc not found at ${pcRoot}`,
    fix: pcOk ? "" : "Clone CrossPad/crosspad-pc or set CROSSPAD_PC_ROOT.",
  });

  // 6. per-revision build dirs and firmware age
  const found: string[] = [];
  for (const dir of ["build_v1", "build_v2", "build"]) {
    const full = path.join(idfRoot, dir);
    if (!p.exists(full)) continue;
    const bin = path.join(full, "CrossPad.bin");
    const m = p.exists(bin) ? p.mtimeMs(bin) : null;
    found.push(m === null ? `${dir} (no CrossPad.bin)` : `${dir} (CrossPad.bin ${ageText(Date.now() - m)} old)`);
  }
  checks.push({
    name: "build_dirs",
    ok: found.length > 0,
    detail: found.length > 0 ? found.join("; ") : "no build_v1 / build_v2 / build directory",
    fix: found.length > 0 ? "" : "crosspad_build platform=idf (per rev: idf.py -B build_v2 -DSDKCONFIG=sdkconfig.v2 build).",
  });

  // 7. sim binary presence and staleness vs sources
  const sim = p.simBinary();
  if (!p.exists(sim)) {
    checks.push({ name: "sim_binary", ok: false, detail: `no simulator binary at ${sim}`, fix: "crosspad_build platform=pc" });
  } else {
    const binM = p.mtimeMs(sim) ?? 0;
    const srcM = p.newestSourceMtimeMs(pcRoot);
    const stale = srcM !== null && srcM > binM;
    checks.push({
      name: "sim_binary",
      ok: !stale,
      detail: stale
        ? `${sim} is older than the newest source (${ageText(srcM - binM)} behind)`
        : `${sim} (${ageText(Date.now() - binM)} old, newer than sources)`,
      fix: stale ? "crosspad_build platform=pc" : "",
    });
  }

  // 8. daemon-side checks (udev/dialout, locks, rtmidi, sounddevice, …)
  try {
    const dc = await daemonChecks();
    for (const c of dc) checks.push(DoctorCheckSchema.parse(c));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = (e as { hint?: string }).hint;
    checks.push({
      name: "daemon",
      ok: false,
      detail: `crosspad-hil daemon unavailable: ${msg}`,
      fix: hint ?? "Fix hil_python / hil_version above, then retry.",
    });
  }

  return checks;
}

// ── real probe ──────────────────────────────────────────────────────────────

const SOURCE_EXT = new Set([".c", ".cpp", ".h", ".hpp"]);
const WALK_LIMIT = 5000;

function newestMtimeUnder(root: string): number | null {
  let newest: number | null = null;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0 && seen < WALK_LIMIT) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (seen++ >= WALK_LIMIT) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "build" || e.name === ".git" || e.name === "node_modules") continue;
        stack.push(full);
      } else if (SOURCE_EXT.has(path.extname(e.name))) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (newest === null || m > newest) newest = m;
        } catch { /* skip */ }
      }
    }
  }
  return newest;
}

export function realProbe(): DoctorProbe {
  return {
    hilPython: resolveHilPython,
    pythonRunnable: async (py) => {
      const r = await runArgvStream(py, ["-c", "import sys; print(sys.version_info[0])"], process.cwd(), () => {}, 10_000);
      return r.success;
    },
    hilVersion: async (py) => {
      let out = "";
      const r = await runArgvStream(
        py,
        ["-c", "import json, crosspad_hil; print(json.dumps({'version': crosspad_hil.__version__}))"],
        process.cwd(),
        (s, line) => { if (s === "stdout") out += line + "\n"; },
        15_000,
      );
      if (!r.success) return null;
      const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      if (!line) return null;
      try { return String(JSON.parse(line).version); } catch { return null; }
    },
    requiredHilVersion: () => String(require("../../package.json").hilVersion ?? "1.0.0"),
    idfRoot: () => CROSSPAD_IDF_ROOT,
    idfExportExists: () => fs.existsSync(path.join(IDF_PATH, IS_WINDOWS ? "export.bat" : "export.sh")),
    pcRoot: () => CROSSPAD_PC_ROOT,
    exists: (p) => fs.existsSync(p),
    mtimeMs: (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } },
    newestSourceMtimeMs: (root) => newestMtimeUnder(path.join(root, "src")),
    simBinary: () => BIN_EXE,
  };
}

export function registerDoctorTool(server: McpServer, ctx: ToolContext, probe: DoctorProbe = realProbe()): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "Environment doctor. Host checks: hil_python interpreter, crosspad-hil version vs the one this server needs, platform-idf root, ESP-IDF env, crosspad-pc root, per-rev build dirs and firmware age, simulator binary staleness. Daemon checks merged in: udev/dialout, port locks (holder PID + purpose), rtmidi/ALSA/sounddevice visibility. Each check is {name, ok, detail, fix}; `ok` is false when any check fails. Run this first when a device tool errors.",
      inputSchema: {},
      outputSchema: O_Doctor,
      annotations: annotationsFor(tierOf(TOOL_NAME, {})),
    },
    async (_args, extra) => {
      if (decide(ctx.policy, TOOL_NAME, {}) === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      try {
        const checks = await runDoctorChecks(probe, async () => {
          const r = await ctx.daemon().request<{ checks: DoctorCheck[] }>("devices.doctor", {}, { signal: extra.signal, timeoutMs: 30_000 });
          return r.checks;
        });
        return jsonResponse({ success: true, ok: checks.every((c) => c.ok), checks });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/tools/devices.test.ts src/tools/doctor.test.ts && npx tsc --noEmit`
Expected: `Test Files 2 passed`, `Tests 13 passed`; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add package.json src/utils/userConfig.ts src/tool-result.ts src/testing/fake-daemon.ts src/testing/fake-server.ts src/tools/devices.ts src/tools/doctor.ts src/tools/devices.test.ts src/tools/doctor.test.ts && git commit -m "feat(v10): crosspad_devices over the hil daemon and crosspad_doctor with merged host+daemon checks"
```

---

### Task 6: `crosspad_console` + device resources

**Files:**
- Create: `src/hil/console-logs.ts`
- Create: `src/tools/console.ts`
- Create: `src/resources/device.ts`
- Test: `src/tools/console.test.ts`, `src/resources/device.test.ts`

**Interfaces:**
- Consumes:
  - `HilDaemon.request` (Task 5 list); daemon ops verbatim: `console.open {device, reset?, log_to?} → {handle, port, log_path}`; `console.read {handle, since_seq?, wait_ms?, match?, limit?} → {lines: [[seq, line]…], next_seq, lines_lost}`; `console.expect {handle, patterns, reject?, timeout_s?} → {hit, rejected, seq, context, elapsed_s}`; `console.reset {handle} → {ok}`; `console.snapshot {handle} → dict`; `console.close {handle} → {ok}`; `snapshot.take {device, include?} → Snapshot dict`; `devices.list {} → {devices}`.
  - `HandleRegistry.register(handle, {kind: "console", device?})`, `.get(handle)`, `.touch(handle)`, `.drop(handle)` from `src/handles.ts`.
  - `ReadResultSchema`, `ExpectResultSchema`, `SnapshotSchema` from `src/hil/schemas.ts`.
  - `ResourceTemplate` from `@modelcontextprotocol/sdk/server/mcp.js` used exactly as `src/index.ts:1649-1671` does (`new ResourceTemplate(uri, { list: undefined })`, callback `(uri, variables)`).
- Produces:
  - `src/hil/console-logs.ts`: `export interface ConsoleLogEntry { handle: string; device: string; logPath: string; port: string }`; `export class ConsoleLogIndex { set(e: ConsoleLogEntry): void; byHandle(h: string): ConsoleLogEntry|undefined; byDevice(id: string): ConsoleLogEntry|undefined; dropHandle(h: string): void; list(): ConsoleLogEntry[] }`; `export const consoleLogs = new ConsoleLogIndex()`.
  - `src/tools/console.ts`: `export function registerConsoleTool(server, ctx): RegisteredTool`; `export const ConsoleInput` (zod discriminated union on `action`); `export const MAX_INLINE_LINES = 2000`; `export function consoleLogUri(device: string): string` → `crosspad://device/${device}/console/log`.
  - `src/resources/device.ts`: `export function registerDeviceResources(server: McpServer, ctx: ToolContext): void`; `export const MAX_LOG_BYTES = 1_048_576` (the resource returns the last 1 MiB of the file, prefixed with `…[truncated N bytes]\n` when cut — the tool result never inlines the file at all).
  - Every `crosspad_console` result carries `content: [text JSON, {type:"resource_link", uri: consoleLogUri(device), name: "console.log", mimeType: "text/plain"}]` once a handle is known.

Contract choices: `read` clamps `limit` to `MAX_INLINE_LINES` (2000, the "console reads capped at 2 000 lines per call" rule in spec §4.3) and defaults to 200; `expect.timeout_ms` (tool) → `timeout_s` (daemon) = `timeout_ms / 1000`, default 30 000; the device id needed for the resource link after `open` is the `device` arg when it is an id (`dev_…`), otherwise the daemon's `devices.list` is consulted once to map the returned `port` to an id (falls back to the raw arg).

- [ ] **Step 1: Write the failing tests**

`src/tools/console.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerConsoleTool, MAX_INLINE_LINES, consoleLogUri } from "./console.js";
import { consoleLogs } from "../hil/console-logs.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";
import { HilError } from "../hil/daemon.js";

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const handles = new HandleRegistry();
  const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles };
  const fs = fakeServer();
  registerConsoleTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_console")!;
  return { daemon, handles, tool, call: (args: any) => tool.cb(args, fakeExtra()) };
}

const OPEN = () => ({ handle: "con_1", port: "/dev/ttyACM1", log_path: "/tmp/hil_logs/console_dev_3f2a_20260826.log" });

describe("crosspad_console open", () => {
  it("registers the handle, indexes the log and returns a resource_link", async () => {
    const t = mk({ "console.open": OPEN });
    const res = await t.call({ action: "open", device: "dev_3f2a", reset: true });
    expect(t.daemon.calls[0]).toEqual({ op: "console.open", args: { device: "dev_3f2a", reset: true } });
    expect(res.structuredContent).toMatchObject({ success: true, handle: "con_1", port: "/dev/ttyACM1", device: "dev_3f2a" });
    expect(t.handles.get("con_1")).toMatchObject({ kind: "console", device: "dev_3f2a" });
    expect(consoleLogs.byHandle("con_1")?.logPath).toBe("/tmp/hil_logs/console_dev_3f2a_20260826.log");
    const link = res.content.find((c: any) => c.type === "resource_link");
    expect(link).toMatchObject({ type: "resource_link", uri: consoleLogUri("dev_3f2a"), mimeType: "text/plain" });
    expect(res.content[0].text).not.toContain("log_path_contents");
  });
  it("resolves a port path to the device id through devices.list", async () => {
    const t = mk({
      "console.open": OPEN,
      "devices.list": () => ({ devices: [{ id: "dev_3f2a", serial: "X", usb_mode: "default", board_rev: null, ports: { cdc: null, console: { path: "/dev/ttyACM1", vid: 0x483, pid: 0x5740, serial: null, product: null, location: null }, esp_midi: null, stm_midi: null, uac2: null, bootloader: null } }] }),
    });
    const res = await t.call({ action: "open", device: "/dev/ttyACM1" });
    expect(res.structuredContent.device).toBe("dev_3f2a");
  });
});

describe("crosspad_console read", () => {
  it("passes since_seq/wait_ms/match, clamps limit, touches the handle", async () => {
    const t = mk({
      "console.open": OPEN,
      "console.read": (a) => ({ lines: [[10, "I (1) boot"], [11, "I (2) ok"]], next_seq: 12, lines_lost: 0 }),
    });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "read", handle: "con_1", since_seq: 10, wait_ms: 100, match: "boot", limit: 99999 });
    expect(t.daemon.calls[1]).toEqual({ op: "console.read", args: { handle: "con_1", since_seq: 10, wait_ms: 100, match: "boot", limit: MAX_INLINE_LINES } });
    expect(res.structuredContent).toMatchObject({ success: true, next_seq: 12, lines_lost: 0 });
    expect((res.structuredContent.lines as any[]).length).toBe(2);
    expect(res.content.some((c: any) => c.type === "resource_link")).toBe(true);
  });
  it("never inlines more than `limit` lines even if the daemon over-delivers", async () => {
    const many = Array.from({ length: 50 }, (_, i) => [i, `line ${i}`]);
    const t = mk({ "console.open": OPEN, "console.read": () => ({ lines: many, next_seq: 50, lines_lost: 0 }) });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "read", handle: "con_1", limit: 10 });
    expect((res.structuredContent.lines as any[]).length).toBe(10);
    expect(res.structuredContent.truncated).toBe(true);
  });
  it("reports an unknown handle as HANDLE_EXPIRED without calling the daemon", async () => {
    const t = mk({});
    const res = await t.call({ action: "read", handle: "con_9" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "HANDLE_EXPIRED" });
    expect(t.daemon.calls.length).toBe(0);
  });
});

describe("crosspad_console expect / reset / snapshot / close", () => {
  it("expect converts timeout_ms to timeout_s and returns hit/rejected/context", async () => {
    const t = mk({
      "console.open": OPEN,
      "console.expect": () => ({ hit: "STM32 ident:", rejected: null, seq: 300, context: ["a", "b"], elapsed_s: 1.5 }),
    });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "expect", handle: "con_1", patterns: ["STM32 ident:"], reject: ["Guru Meditation"], timeout_ms: 5000 });
    expect(t.daemon.calls[1]).toEqual({ op: "console.expect", args: { handle: "con_1", patterns: ["STM32 ident:"], reject: ["Guru Meditation"], timeout_s: 5 } });
    expect(res.structuredContent).toMatchObject({ success: true, hit: "STM32 ident:", rejected: null, seq: 300, elapsed_s: 1.5 });
  });
  it("reset is stimulus tier and forwards the handle", async () => {
    const t = mk({ "console.open": OPEN, "console.reset": () => ({ ok: true }) });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "reset", handle: "con_1" });
    expect(t.daemon.calls[1]).toEqual({ op: "console.reset", args: { handle: "con_1" } });
    expect(res.structuredContent.success).toBe(true);
  });
  it("snapshot returns the parser snapshot", async () => {
    const t = mk({ "console.open": OPEN, "console.snapshot": () => ({ fatals: [], reboots: 1, reset_reasons: ["POWERON"], errors: [], markers_seen: {}, boot_complete: true, missing_markers: [], bootloops: 0, heap: {}, kit_requests: [], cdc_drops: 0, seq: 400, lines_lost: 0, log_path: "/tmp/x.log", port: "/dev/ttyACM1" }) });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "snapshot", handle: "con_1" });
    expect(res.structuredContent).toMatchObject({ success: true, reboots: 1, boot_complete: true });
  });
  it("close drops the handle but keeps the log index (file kept)", async () => {
    const t = mk({ "console.open": OPEN, "console.close": () => ({ ok: true }) });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "close", handle: "con_1" });
    expect(res.structuredContent).toMatchObject({ success: true, log_path: "/tmp/hil_logs/console_dev_3f2a_20260826.log" });
    expect(t.handles.get("con_1")).toBeUndefined();
    expect(consoleLogs.byDevice("dev_3f2a")?.logPath).toBe("/tmp/hil_logs/console_dev_3f2a_20260826.log");
  });
  it("a daemon HANDLE_EXPIRED drops the TS handle too", async () => {
    const t = mk({ "console.open": OPEN, "console.read": () => { throw new HilError("HANDLE_EXPIRED", "con_1 expired", "open again"); } });
    await t.call({ action: "open", device: "dev_3f2a" });
    const res = await t.call({ action: "read", handle: "con_1" });
    expect(res.structuredContent.error).toMatchObject({ code: "HANDLE_EXPIRED", hint: "open again" });
    expect(t.handles.get("con_1")).toBeUndefined();
  });
});
```

`src/resources/device.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer } from "../testing/fake-server.js";
import { registerDeviceResources, MAX_LOG_BYTES } from "./device.js";
import { consoleLogs } from "../hil/console-logs.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";

const dev = { id: "dev_3f2a", serial: "X", usb_mode: "default", board_rev: null, ports: { cdc: null, console: null, esp_midi: null, stm_midi: null, uac2: null, bootloader: null } };
const snap = { snapshot_id: "snap_1", device: "dev_3f2a", usb_mode: "default", apps: null, ui: null, kit: null, leds: null, pads: null, mem: null, ble: null, console: null, ts: 1, changed: [] };

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
  const fs = fakeServer();
  registerDeviceResources(fs.server, ctx);
  return { daemon, res: fs.resources };
}

describe("device resources", () => {
  it("registers the three URIs", () => {
    const { res } = mk({});
    expect(res.has("crosspad-devices")).toBe(true);
    expect(res.has("crosspad-device-state")).toBe(true);
    expect(res.has("crosspad-device-console-log")).toBe(true);
    expect(res.get("crosspad-devices")!.uriOrTemplate).toBe("crosspad://devices");
  });
  it("crosspad://devices reads devices.list", async () => {
    const { res, daemon } = mk({ "devices.list": () => ({ devices: [dev] }) });
    const out = await res.get("crosspad-devices")!.cb(new URL("crosspad://devices"));
    expect(daemon.calls[0].op).toBe("devices.list");
    expect(JSON.parse(out.contents[0].text).devices[0].id).toBe("dev_3f2a");
  });
  it("crosspad://device/{id}/state takes a fresh snapshot", async () => {
    const { res, daemon } = mk({ "snapshot.take": () => snap });
    const out = await res.get("crosspad-device-state")!.cb(new URL("crosspad://device/dev_3f2a/state"), { id: "dev_3f2a" });
    expect(daemon.calls[0]).toEqual({ op: "snapshot.take", args: { device: "dev_3f2a" } });
    expect(JSON.parse(out.contents[0].text).snapshot_id).toBe("snap_1");
  });
  it("crosspad://device/{id}/console/log serves the indexed file tail", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-log-"));
    const p = path.join(dir, "console.log");
    fs.writeFileSync(p, "boot\nline2\n");
    consoleLogs.set({ handle: "con_1", device: "dev_3f2a", logPath: p, port: "/dev/ttyACM1" });
    const { res } = mk({});
    const out = await res.get("crosspad-device-console-log")!.cb(new URL("crosspad://device/dev_3f2a/console/log"), { id: "dev_3f2a" });
    expect(out.contents[0].mimeType).toBe("text/plain");
    expect(out.contents[0].text).toBe("boot\nline2\n");
  });
  it("truncates to the last MAX_LOG_BYTES", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-log-"));
    const p = path.join(dir, "big.log");
    fs.writeFileSync(p, "x".repeat(MAX_LOG_BYTES + 10) + "END");
    consoleLogs.set({ handle: "con_2", device: "dev_big", logPath: p, port: "/dev/ttyACM1" });
    const { res } = mk({});
    const out = await res.get("crosspad-device-console-log")!.cb(new URL("crosspad://device/dev_big/console/log"), { id: "dev_big" });
    expect(out.contents[0].text.startsWith("…[truncated 13 bytes]\n")).toBe(true);
    expect(out.contents[0].text.endsWith("END")).toBe(true);
  });
  it("explains when no console was opened for that device", async () => {
    const { res } = mk({});
    const out = await res.get("crosspad-device-console-log")!.cb(new URL("crosspad://device/dev_none/console/log"), { id: "dev_none" });
    expect(out.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(out.contents[0].text).error.code).toBe("NO_CONSOLE");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/tools/console.test.ts src/resources/device.test.ts`
Expected: FAIL with `Failed to resolve import "./console.js"` and `Failed to resolve import "./device.js"`.

- [ ] **Step 3a: Write `src/hil/console-logs.ts`**

```ts
// src/hil/console-logs.ts — which log file backs crosspad://device/{id}/console/log.
// Kept separate from HandleRegistry (whose meta is {kind, device} only) and kept
// after close(): the daemon keeps the file, so the resource must keep serving it.
export interface ConsoleLogEntry {
  handle: string;
  device: string;
  logPath: string;
  port: string;
}

export class ConsoleLogIndex {
  private readonly byHandleMap = new Map<string, ConsoleLogEntry>();
  private readonly byDeviceMap = new Map<string, ConsoleLogEntry>();

  set(e: ConsoleLogEntry): void {
    this.byHandleMap.set(e.handle, e);
    this.byDeviceMap.set(e.device, e);
  }

  byHandle(handle: string): ConsoleLogEntry | undefined {
    return this.byHandleMap.get(handle);
  }

  /** The most recently opened console for a device (survives close). */
  byDevice(device: string): ConsoleLogEntry | undefined {
    return this.byDeviceMap.get(device);
  }

  dropHandle(handle: string): void {
    this.byHandleMap.delete(handle);
  }

  list(): ConsoleLogEntry[] {
    return [...this.byDeviceMap.values()];
  }
}

export const consoleLogs = new ConsoleLogIndex();
```

- [ ] **Step 3b: Write `src/tools/console.ts`**

```ts
// src/tools/console.ts — crosspad_console: the STM VCP console through the daemon.
// open/read/expect/reset/snapshot/close map 1:1 onto console.* ops; the log file is
// never inlined — results carry a resource_link to crosspad://device/{id}/console/log.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadResultSchema, ExpectResultSchema, DeviceSchema } from "../hil/schemas.js";
import { HilError } from "../hil/daemon.js";
import { consoleLogs } from "../hil/console-logs.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError, type ToolResult } from "../tool-result.js";

export const TOOL_NAME = "crosspad_console";
/** Spec §4.3: console reads capped at 2 000 lines per call. */
export const MAX_INLINE_LINES = 2000;
const DEFAULT_LIMIT = 200;
const DEFAULT_EXPECT_TIMEOUT_MS = 30_000;

export function consoleLogUri(device: string): string {
  return `crosspad://device/${device}/console/log`;
}

const Handle = z.string().regex(/^con_\d+$/, "handle must look like con_<n> (from action=open)");
const DeviceArg = z.string().min(1).describe("Device id (dev_xxxx) or a port path; omit when exactly one CrossPad is connected");

export const ConsoleInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    device: DeviceArg.optional(),
    reset: z.boolean().optional().describe("Pulse reset (DTR/RTS, works through the STM bridge) right after opening so the log starts at boot"),
    log_to: z.string().optional().describe("Explicit log file path; default hil_logs/console_<device>_<ts>.log"),
  }),
  z.object({
    action: z.literal("read"),
    handle: Handle,
    since_seq: z.number().int().min(0).optional().describe("Return lines with seq >= this (from a previous next_seq)"),
    wait_ms: z.number().int().min(0).max(60_000).optional().describe("Block up to this long for new lines"),
    match: z.string().optional().describe("Regex; only matching lines are returned"),
    limit: z.number().int().min(1).optional().describe(`Max lines inline (default ${DEFAULT_LIMIT}, hard cap ${MAX_INLINE_LINES}); the full log is the resource_link`),
  }),
  z.object({
    action: z.literal("expect"),
    handle: Handle,
    patterns: z.array(z.string().min(1)).min(1).describe("Regexes; the first to appear wins"),
    reject: z.array(z.string().min(1)).optional().describe("Regexes that end the wait as a failure (e.g. 'Guru Meditation')"),
    timeout_ms: z.number().int().min(1).max(600_000).optional().describe(`Default ${DEFAULT_EXPECT_TIMEOUT_MS}`),
  }),
  z.object({ action: z.literal("reset"), handle: Handle }),
  z.object({ action: z.literal("snapshot"), handle: Handle }),
  z.object({ action: z.literal("close"), handle: Handle }),
]);
export type ConsoleArgs = z.infer<typeof ConsoleInput>;

export const O_Console = {
  success: z.boolean(),
  action: z.string().optional(),
  device: z.string().optional(),
  handle: z.string().optional(),
  port: z.string().optional(),
  log_path: z.string().optional(),
  log_uri: z.string().optional(),
  lines: ReadResultSchema.shape.lines.optional(),
  next_seq: z.number().int().optional(),
  lines_lost: z.number().int().optional(),
  truncated: z.boolean().optional(),
  hit: ExpectResultSchema.shape.hit.optional(),
  rejected: ExpectResultSchema.shape.rejected.optional(),
  seq: z.number().int().nullable().optional(),
  context: z.array(z.string()).optional(),
  elapsed_s: z.number().optional(),
  ts: z.number().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/** Append the console-log resource_link to a tool result. */
function withLogLink(res: ToolResult, device: string): ToolResult {
  res.content.push({
    type: "resource_link",
    uri: consoleLogUri(device),
    name: "console.log",
    mimeType: "text/plain",
    description: `Console log of ${device} (full file; results inline at most ${MAX_INLINE_LINES} lines)`,
  } as unknown as { type: "text"; text: string });
  return res;
}

function handleExpired(handle: string): ToolResult {
  return jsonResponse({
    success: false,
    error: { code: "HANDLE_EXPIRED", message: `${handle} is not an open console handle`, hint: "crosspad_console action=open again; the log file, if any, is kept" },
  });
}

async function resolveDeviceId(ctx: ToolContext, arg: string | undefined, port: string, signal: AbortSignal): Promise<string> {
  if (arg && arg.startsWith("dev_")) return arg;
  try {
    const r = await ctx.daemon().request<{ devices: unknown[] }>("devices.list", {}, { signal });
    for (const raw of r.devices) {
      const d = DeviceSchema.parse(raw);
      const paths = [d.ports.cdc, d.ports.console, d.ports.bootloader].filter((p) => p !== null).map((p) => p!.path);
      if (paths.includes(port)) return d.id;
    }
  } catch { /* fall through */ }
  return arg ?? port;
}

export function registerConsoleTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] STM32-bridge console (boot log, panics, PerfMon) through the crosspad-hil daemon. open → con_N handle (DTR/RTS deasserted so opening never reboots the board; reset=true pulses reset explicitly); read {since_seq, wait_ms, match, limit} → {lines: [[seq, line]], next_seq, lines_lost}; expect {patterns, reject, timeout_ms} → which pattern hit first (or which reject), with 20 lines of context; reset; snapshot (parsed fatals/reboots/markers/heap/cdc_drops); close. Handles expire after 30 min idle. The log file is persisted to hil_logs/ and linked as crosspad://device/{id}/console/log — never inlined.",
      inputSchema: ConsoleInput,
      outputSchema: O_Console,
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "reset" })),
    },
    async (rawArgs, extra) => {
      const args = ConsoleInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} action=${args.action} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, `crosspad_console ${args.action} on ${"handle" in args ? args.handle : args.device ?? "auto"}`);
        if (c.status === "token") return c.result;
        if (c.status === "declined") return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: "declined" } });
      }
      const daemon = ctx.daemon();
      const signal = extra.signal;

      try {
        if (args.action === "open") {
          const opArgs: Record<string, unknown> = {};
          if (args.device !== undefined) opArgs.device = args.device;
          if (args.reset !== undefined) opArgs.reset = args.reset;
          if (args.log_to !== undefined) opArgs.log_to = args.log_to;
          const r = await daemon.request<{ handle: string; port: string; log_path: string }>("console.open", opArgs, { signal, timeoutMs: 20_000 });
          const device = await resolveDeviceId(ctx, args.device, r.port, signal);
          ctx.handles.register(r.handle, { kind: "console", device });
          consoleLogs.set({ handle: r.handle, device, logPath: r.log_path, port: r.port });
          return withLogLink(
            jsonResponse({ success: true, action: "open", device, handle: r.handle, port: r.port, log_path: r.log_path, log_uri: consoleLogUri(device), ts: Date.now() }),
            device,
          );
        }

        // every other action needs a live handle
        const meta = ctx.handles.get(args.handle);
        if (!meta || meta.kind !== "console") return handleExpired(args.handle);
        ctx.handles.touch(args.handle);
        const device = meta.device ?? consoleLogs.byHandle(args.handle)?.device ?? "unknown";

        if (args.action === "read") {
          const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_INLINE_LINES);
          const opArgs: Record<string, unknown> = { handle: args.handle };
          if (args.since_seq !== undefined) opArgs.since_seq = args.since_seq;
          if (args.wait_ms !== undefined) opArgs.wait_ms = args.wait_ms;
          if (args.match !== undefined) opArgs.match = args.match;
          opArgs.limit = limit;
          const r = ReadResultSchema.parse(await daemon.request("console.read", opArgs, { signal, timeoutMs: (args.wait_ms ?? 0) + 10_000 }));
          const truncated = r.lines.length > limit;
          const lines = truncated ? r.lines.slice(0, limit) : r.lines;
          return withLogLink(
            jsonResponse({ success: true, action: "read", device, handle: args.handle, lines, next_seq: r.next_seq, lines_lost: r.lines_lost, truncated, log_uri: consoleLogUri(device), ts: Date.now() }),
            device,
          );
        }

        if (args.action === "expect") {
          const timeoutMs = args.timeout_ms ?? DEFAULT_EXPECT_TIMEOUT_MS;
          const opArgs: Record<string, unknown> = { handle: args.handle, patterns: args.patterns };
          if (args.reject !== undefined) opArgs.reject = args.reject;
          opArgs.timeout_s = timeoutMs / 1000;
          const r = ExpectResultSchema.parse(await daemon.request("console.expect", opArgs, { signal, timeoutMs: timeoutMs + 10_000 }));
          return withLogLink(
            jsonResponse({ success: true, action: "expect", device, handle: args.handle, hit: r.hit, rejected: r.rejected, seq: r.seq, context: r.context, elapsed_s: r.elapsed_s, log_uri: consoleLogUri(device), ts: Date.now() }),
            device,
          );
        }

        if (args.action === "reset") {
          await daemon.request("console.reset", { handle: args.handle }, { signal, timeoutMs: 10_000 });
          return withLogLink(jsonResponse({ success: true, action: "reset", device, handle: args.handle, log_uri: consoleLogUri(device), ts: Date.now() }), device);
        }

        if (args.action === "snapshot") {
          const r = await daemon.request<Record<string, unknown>>("console.snapshot", { handle: args.handle }, { signal, timeoutMs: 10_000 });
          return withLogLink(jsonResponse({ success: true, action: "snapshot", device, handle: args.handle, ...r, log_uri: consoleLogUri(device), ts: Date.now() }), device);
        }

        // close
        await daemon.request("console.close", { handle: args.handle }, { signal, timeoutMs: 10_000 });
        const entry = consoleLogs.byHandle(args.handle);
        ctx.handles.drop(args.handle);
        consoleLogs.dropHandle(args.handle);
        return withLogLink(
          jsonResponse({ success: true, action: "close", device, handle: args.handle, log_path: entry?.logPath, log_uri: consoleLogUri(device), ts: Date.now() }),
          device,
        );
      } catch (e) {
        if (e instanceof HilError && e.code === "HANDLE_EXPIRED" && "handle" in args) {
          ctx.handles.drop(args.handle);
          consoleLogs.dropHandle(args.handle);
        }
        return toolError(e);
      }
    },
  );
}
```

- [ ] **Step 3c: Write `src/resources/device.ts`**

```ts
// src/resources/device.ts — crosspad://devices, crosspad://device/{id}/state,
// crosspad://device/{id}/console/log. Same registerResource/ResourceTemplate
// idiom as crosspad://symbols in src/index.ts.
import fs from "fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { consoleLogs } from "../hil/console-logs.js";

/** The console-log resource serves at most the last MiB of the file. */
export const MAX_LOG_BYTES = 1_048_576;

function firstVar(v: unknown): string {
  return decodeURIComponent(String(Array.isArray(v) ? v[0] : v ?? "")).trim();
}

function jsonContents(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
}

function errorPayload(e: unknown): { error: { code: string; message: string; hint?: string } } {
  const code = (e as { code?: string }).code ?? "INTERNAL";
  const hint = (e as { hint?: string }).hint;
  return { error: { code, message: e instanceof Error ? e.message : String(e), ...(hint ? { hint } : {}) } };
}

export function readLogTail(logPath: string): string {
  const size = fs.statSync(logPath).size;
  if (size <= MAX_LOG_BYTES) return fs.readFileSync(logPath, "utf-8");
  const fd = fs.openSync(logPath, "r");
  try {
    const buf = Buffer.alloc(MAX_LOG_BYTES);
    fs.readSync(fd, buf, 0, MAX_LOG_BYTES, size - MAX_LOG_BYTES);
    return `…[truncated ${size - MAX_LOG_BYTES} bytes]\n` + buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

export function registerDeviceResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "crosspad-devices",
    "crosspad://devices",
    {
      description: "Device inventory from the crosspad-hil daemon (same payload as crosspad_devices, raw Device dicts). ttl 0 — re-discovered on every read.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const r = await ctx.daemon().request<{ devices: unknown[] }>("devices.list", {});
        return jsonContents(uri.href, r);
      } catch (e) {
        return jsonContents(uri.href, errorPayload(e));
      }
    },
  );

  server.registerResource(
    "crosspad-device-state",
    new ResourceTemplate("crosspad://device/{id}/state", { list: undefined }),
    {
      description: "Fresh snapshot of one device (apps, ui, kit, leds, pads, mem, ble, console). URI: crosspad://device/<dev_xxxx>/state. Auto-refreshed on every read.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = firstVar(variables.id);
      if (!id) return jsonContents(uri.href, { error: { code: "BAD_ARGS", message: "URI must be crosspad://device/<id>/state" } });
      try {
        const snap = await ctx.daemon().request<Record<string, unknown>>("snapshot.take", { device: id });
        return jsonContents(uri.href, snap);
      } catch (e) {
        return jsonContents(uri.href, errorPayload(e));
      }
    },
  );

  server.registerResource(
    "crosspad-device-console-log",
    new ResourceTemplate("crosspad://device/{id}/console/log", { list: undefined }),
    {
      description: "The console log file of the most recent crosspad_console open for this device (kept after close). Last 1 MiB at most.",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const id = firstVar(variables.id);
      const entry = id ? consoleLogs.byDevice(id) : undefined;
      if (!entry) {
        return jsonContents(uri.href, {
          error: { code: "NO_CONSOLE", message: `no console has been opened for ${id || "<empty id>"} in this session`, hint: "crosspad_console action=open device=<id>" },
        });
      }
      try {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: readLogTail(entry.logPath) }] };
      } catch (e) {
        return jsonContents(uri.href, { ...errorPayload(e), log_path: entry.logPath });
      }
    },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/tools/console.test.ts src/resources/device.test.ts && npx tsc --noEmit`
Expected: `Test Files 2 passed`, `Tests 16 passed`; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add src/hil/console-logs.ts src/tools/console.ts src/resources/device.ts src/tools/console.test.ts src/resources/device.test.ts && git commit -m "feat(v10): crosspad_console over daemon console.* with log resource_link, and device resources"
```

---

### Task 7: `crosspad_cdc`, `crosspad_ui`, `crosspad_snapshot`

**Files:**
- Create: `src/tools/cdc.ts`
- Create: `src/tools/ui.ts`
- Create: `src/tools/snapshot.ts`
- Test: `src/tools/cdc.test.ts`, `src/tools/ui.test.ts`, `src/tools/snapshot.test.ts`

**Interfaces:**
- Consumes:
  - Daemon ops verbatim: `cdc.verb {device?, verb: string, args: dict} → verb result` (verb = function name in `verbs.py`); `cdc.transact {device?, cmd, expect?, timeout_s?} → Reply dict {line, parsed, rtt_ms, extra_lines}`; `snapshot.take {device, include?, previous?} → Snapshot dict`.
  - verbs.py names and args verbatim: `app_list`, `app_start {name, wait_s}`, `app_stop`, `app_destroy`, `app_self_close`, `app_versions`, `kit_list`, `kit_status`, `kit_load {kit_id, wait_s}`, `pad_press {idx, vel}`, `pad_release {idx}`, `pad_pressure {idx, val}`, `pad_stats {reset}`, `pad_notes`, `pad_info {idx}`, `enc_rotate {delta}`, `enc_press {ms}`, `enc_group`, `enc_focus`, `enc_state`, `ui_state`, `led_state`, `mem`, `mem_blocks`, `cdc_stats`, `audio_level`, `smpl_peak`, `audio_tasks {on}`, `ble_status`, `ble_start {mode}`, `ble_stop`, `ble_scan {ms}`, `ble_devices`, `ble_connect {addr}`, `ble_disconnect`, `ble_send {note, vel}`, `ble_txoff {semis}`, `bootloader_request`, `stm_dfu`.
  - `requireConfirmation(server, extra, tool, args, summary)` → `{status:"approved"} | {status:"declined"} | {status:"token", result}`; `decide`, `tierOf`, `annotationsFor`; `HandleRegistry.register(handle, {kind:"snapshot", device})`; `SnapshotSchema`, `ReplySchema`; `sendRemoteCommand`, `isSimulatorRunning` from `src/utils/remote-client.ts`.
- Produces:
  - `src/tools/cdc.ts`: `registerCdcTool(server, ctx): RegisteredTool`; `export const CdcInput` (discriminated union on `verb`); `export function toVerbCall(args: CdcArgs): { verb: string; args: Record<string, unknown> } | { raw: { cmd: string; expect?: string; timeout_s?: number } }` (pure mapping, unit-tested); `export function isDangerVerb(args: Record<string, unknown>): boolean` (true for `verb:"system"` with `action` in `bootloader_request|stm_dfu` — this is also what `TOOL_TIERS.crosspad_cdc` must return `"danger"` for; chunk C2 implements the tier function and this predicate is exported so it can reuse it).
  - `src/tools/ui.ts`: `registerUiTool(server, ctx): RegisteredTool`; `export const UiInput`; `export function refToDelta(group: Array<{ref: string; index: number}>, focusIndex: number, ref: string): number` (TS port of `snapshot.ref_to_delta`: `index(ref) − focus_index`, unknown ref → `HilError("BAD_ARGS")`).
  - `src/tools/snapshot.ts`: `registerSnapshotTool(server, ctx): RegisteredTool`; `export class SnapshotStore { put(snap: Snapshot): void; get(id: string): Snapshot|undefined; ids(): string[] }` keeping the last 20; `export const snapshots = new SnapshotStore()`; `export function simStatsToSnapshot(stats: Record<string, unknown>, id: string): Snapshot`; `export async function takeDeviceSnapshot(ctx, device: string|undefined, include: string[]|undefined, diffFrom: string|undefined, signal): Promise<Snapshot>` (used by `crosspad_ui`).
  - `crosspad_ui` result: `{ success, action, device, ...actionResult, snapshot?: Snapshot }`.

Contract choices: `crosspad_cdc` `verb` families and their `action` values: `app: list|start|stop|destroy|self_close|versions`; `kit: list|status|load`; `pad: press|release|pressure|stats|notes|info`; `enc: rotate|press|group|focus|state|ui_state`; `led: state`; `mem: info|blocks`; `audio: level|tasks|smpl_peak`; `ble: status|start|stop|scan|devices|connect|disconnect|send|txoff`; `system: cdc_stats|bootloader_request|stm_dfu`; `raw: {cmd, expect?, timeout_ms?}`. Mapping is `${verb}_${action}` except `enc/ui_state → ui_state`, `mem/info → mem`, `mem/blocks → mem_blocks`, `audio/smpl_peak → smpl_peak`, `system/* → the action name`. `crosspad_ui back` → `app_self_close` (the app's own Back path; `stop_app` → `app_stop` rebuilds the launcher). Sim snapshot: `device: "sim"`, `usb_mode: "unknown"`, `ui: null`, `ble: null`, `console: null`, `pads: {pressed: number[], playing: number[]}`, `leds.colors` from the 16 pad RGB triplets as `RRGGBB`, `kit: {current: settings.kit, name: null, loading: false, pending: -1}`, `mem: {sram_free, sram_total, psram_free, psram_total}` (the sim's own heap keys), ids minted TS-side as `snap_sim_<n>`; `changed` computed TS-side for sim (top-level keys whose JSON differs from `diff_from`).

- [ ] **Step 1: Write the failing tests**

`src/tools/cdc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerCdcTool, toVerbCall, isDangerVerb } from "./cdc.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>, policy: Policy = { mode: "lab", rules: [] }) {
  const daemon = fakeDaemon(handlers);
  const ctx: ToolContext = { daemon: () => daemon, policy, jobs: new JobRegistry(), handles: new HandleRegistry() };
  const fs = fakeServer();
  registerCdcTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_cdc")!;
  return { daemon, tool, call: (args: any) => tool.cb(args, fakeExtra()) };
}

describe("toVerbCall", () => {
  it("maps typed families to verbs.py names and args", () => {
    expect(toVerbCall({ verb: "app", action: "start", name: "Sampler", wait_s: 2 } as any)).toEqual({ verb: "app_start", args: { name: "Sampler", wait_s: 2 } });
    expect(toVerbCall({ verb: "app", action: "list" } as any)).toEqual({ verb: "app_list", args: {} });
    expect(toVerbCall({ verb: "kit", action: "load", kit_id: 3 } as any)).toEqual({ verb: "kit_load", args: { kit_id: 3 } });
    expect(toVerbCall({ verb: "pad", action: "press", idx: 5, vel: 100 } as any)).toEqual({ verb: "pad_press", args: { idx: 5, vel: 100 } });
    expect(toVerbCall({ verb: "pad", action: "stats", reset: true } as any)).toEqual({ verb: "pad_stats", args: { reset: true } });
    expect(toVerbCall({ verb: "enc", action: "rotate", delta: -2 } as any)).toEqual({ verb: "enc_rotate", args: { delta: -2 } });
    expect(toVerbCall({ verb: "enc", action: "ui_state" } as any)).toEqual({ verb: "ui_state", args: {} });
    expect(toVerbCall({ verb: "led", action: "state" } as any)).toEqual({ verb: "led_state", args: {} });
    expect(toVerbCall({ verb: "mem", action: "info" } as any)).toEqual({ verb: "mem", args: {} });
    expect(toVerbCall({ verb: "mem", action: "blocks" } as any)).toEqual({ verb: "mem_blocks", args: {} });
    expect(toVerbCall({ verb: "audio", action: "tasks", on: false } as any)).toEqual({ verb: "audio_tasks", args: { on: false } });
    expect(toVerbCall({ verb: "audio", action: "smpl_peak" } as any)).toEqual({ verb: "smpl_peak", args: {} });
    expect(toVerbCall({ verb: "ble", action: "send", note: 60, vel: 90 } as any)).toEqual({ verb: "ble_send", args: { note: 60, vel: 90 } });
    expect(toVerbCall({ verb: "ble", action: "start", mode: 1 } as any)).toEqual({ verb: "ble_start", args: { mode: 1 } });
    expect(toVerbCall({ verb: "system", action: "cdc_stats" } as any)).toEqual({ verb: "cdc_stats", args: {} });
    expect(toVerbCall({ verb: "system", action: "stm_dfu" } as any)).toEqual({ verb: "stm_dfu", args: {} });
  });
  it("maps raw to cdc.transact args with timeout_ms → timeout_s", () => {
    expect(toVerbCall({ verb: "raw", cmd: "KIT_STATUS", expect: "KITSTATUS:", timeout_ms: 2500 } as any)).toEqual({ raw: { cmd: "KIT_STATUS", expect: "KITSTATUS:", timeout_s: 2.5 } });
    expect(toVerbCall({ verb: "raw", cmd: "MEM" } as any)).toEqual({ raw: { cmd: "MEM" } });
  });
});

describe("isDangerVerb", () => {
  it("is true only for system bootloader_request / stm_dfu", () => {
    expect(isDangerVerb({ verb: "system", action: "bootloader_request" })).toBe(true);
    expect(isDangerVerb({ verb: "system", action: "stm_dfu" })).toBe(true);
    expect(isDangerVerb({ verb: "system", action: "cdc_stats" })).toBe(false);
    expect(isDangerVerb({ verb: "pad", action: "press" })).toBe(false);
  });
});

describe("crosspad_cdc tool", () => {
  it("calls cdc.verb with device passthrough and returns the parsed result", async () => {
    const t = mk({ "cdc.verb": () => ({ current: 3, loading: false, pending: -1, name: "DRUMS" }) });
    const res = await t.call({ verb: "kit", action: "status", device: "dev_3f2a" });
    expect(t.daemon.calls[0]).toEqual({ op: "cdc.verb", args: { device: "dev_3f2a", verb: "kit_status", args: {} } });
    expect(res.structuredContent).toMatchObject({ success: true, verb: "kit_status", result: { current: 3, name: "DRUMS" }, device: "dev_3f2a" });
  });
  it("raw goes through cdc.transact and returns line + parsed", async () => {
    const t = mk({ "cdc.transact": () => ({ line: "MEM: free=18712 largest=4096", parsed: { kind: "mem", free: 18712, largest: 4096 }, rtt_ms: 3.2, extra_lines: [] }) });
    const res = await t.call({ verb: "raw", cmd: "MEM" });
    expect(t.daemon.calls[0]).toEqual({ op: "cdc.transact", args: { cmd: "MEM" } });
    expect(res.structuredContent).toMatchObject({ success: true, line: "MEM: free=18712 largest=4096", rtt_ms: 3.2 });
  });
  it("refuses a raw cmd with a newline or control bytes", async () => {
    const t = mk({});
    const res = await t.call({ verb: "raw", cmd: "MEM\nOTA_BEGIN 1 x" });
    expect(res.isError).toBe(true);
    expect(t.daemon.calls.length).toBe(0);
  });
  it("system bootloader_request under strict policy returns a confirmation token and performs nothing", async () => {
    const t = mk({ "cdc.verb": () => ({ sent: true }) }, { mode: "strict", rules: [] });
    const res = await t.call({ verb: "system", action: "bootloader_request", device: "dev_3f2a" });
    expect(res.structuredContent.resultType).toBe("confirmation_required");
    expect(String((res.structuredContent.confirmation as any).token)).toMatch(/^cfm_/);
    expect(t.daemon.calls.length).toBe(0);
  });
  it("system bootloader_request with a valid confirm_token runs", async () => {
    const t = mk({ "cdc.verb": () => ({ sent: true }) }, { mode: "strict", rules: [] });
    const first = await t.call({ verb: "system", action: "bootloader_request", device: "dev_3f2a" });
    const token = (first.structuredContent.confirmation as any).token as string;
    const res = await t.call({ verb: "system", action: "bootloader_request", device: "dev_3f2a", confirm_token: token });
    expect(t.daemon.calls[0]).toEqual({ op: "cdc.verb", args: { device: "dev_3f2a", verb: "bootloader_request", args: {} } });
    expect(res.structuredContent).toMatchObject({ success: true, result: { sent: true } });
  });
  it("a lab rule with confirm:false pre-approves stm_dfu", async () => {
    const t = mk({ "cdc.verb": () => ({ sent: true }) }, { mode: "lab", rules: [{ tool: "crosspad_cdc", when: { verb: "system", action: "stm_dfu" }, confirm: false }] });
    const res = await t.call({ verb: "system", action: "stm_dfu" });
    expect(res.structuredContent.success).toBe(true);
    expect(t.daemon.calls.length).toBe(1);
  });
});
```

`src/tools/ui.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerUiTool, refToDelta } from "./ui.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";

const group = [
  { ref: "e0", index: 0, ptr: "0x3fc0", label: "Back" },
  { ref: "e1", index: 1, ptr: "0x3fc4", label: "Kit: DRUMS" },
  { ref: "e2", index: 2, ptr: "0x3fc8", label: "Load" },
];
const snap = { snapshot_id: "snap_7", device: "dev_3f2a", usb_mode: "default", apps: { running: "Sampler", available: ["Sampler"] }, ui: { focus: { ref: "e2", index: 2, label: "Load" }, group, drawer: false, theme: 1, app: "Sampler" }, kit: null, leds: null, pads: null, mem: null, ble: null, console: null, ts: 1, changed: [] };

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles: new HandleRegistry() };
  const fs = fakeServer();
  registerUiTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_ui")!;
  return { daemon, tool, call: (args: any) => tool.cb(args, fakeExtra()) };
}

describe("refToDelta", () => {
  it("is index(ref) − focus", () => {
    expect(refToDelta(group, 0, "e2")).toBe(2);
    expect(refToDelta(group, 2, "e0")).toBe(-2);
    expect(refToDelta(group, 1, "e1")).toBe(0);
  });
  it("rejects an unknown ref with BAD_ARGS", () => {
    expect(() => refToDelta(group, 0, "e9")).toThrowError(/e9/);
    try { refToDelta(group, 0, "e9"); } catch (e: any) { expect(e.code).toBe("BAD_ARGS"); }
  });
});

describe("crosspad_ui", () => {
  it("focus reads enc_group + enc_focus, rotates by the delta, then snapshots", async () => {
    const t = mk({
      "cdc.verb": (a) => {
        if (a.verb === "enc_group") return { group };
        if (a.verb === "enc_focus") return { index: 0, label: "Back", ptr: "0x3fc0" };
        if (a.verb === "enc_rotate") return { ok: true };
        throw new Error("unexpected " + a.verb);
      },
      "snapshot.take": () => snap,
    });
    const res = await t.call({ action: "focus", ref: "e2", device: "dev_3f2a" });
    const verbs = t.daemon.calls.map((c) => (c.op === "cdc.verb" ? c.args.verb : c.op));
    expect(verbs).toEqual(["enc_group", "enc_focus", "enc_rotate", "snapshot.take"]);
    expect(t.daemon.calls[2].args).toEqual({ device: "dev_3f2a", verb: "enc_rotate", args: { delta: 2 } });
    expect(res.structuredContent).toMatchObject({ success: true, action: "focus", delta: 2, snapshot: { snapshot_id: "snap_7" } });
  });
  it("focus with delta 0 does not rotate", async () => {
    const t = mk({
      "cdc.verb": (a) => (a.verb === "enc_group" ? { group } : a.verb === "enc_focus" ? { index: 2, label: "Load", ptr: "x" } : { ok: true }),
      "snapshot.take": () => snap,
    });
    await t.call({ action: "focus", ref: "e2" });
    expect(t.daemon.calls.some((c) => c.args.verb === "enc_rotate")).toBe(false);
  });
  it("press → enc_press ms=80 by default; rotate → enc_rotate; back → app_self_close; start_app → app_start; stop_app → app_stop", async () => {
    const t = mk({ "cdc.verb": () => ({ ok: true }), "snapshot.take": () => snap });
    await t.call({ action: "press" });
    await t.call({ action: "press", ms: 300 });
    await t.call({ action: "rotate", delta: -1 });
    await t.call({ action: "back" });
    await t.call({ action: "start_app", name: "Sampler" });
    await t.call({ action: "stop_app" });
    const verbCalls = t.daemon.calls.filter((c) => c.op === "cdc.verb").map((c) => [c.args.verb, c.args.args]);
    expect(verbCalls).toEqual([
      ["enc_press", { ms: 80 }],
      ["enc_press", { ms: 300 }],
      ["enc_rotate", { delta: -1 }],
      ["app_self_close", {}],
      ["app_start", { name: "Sampler", wait_s: 3 }],
      ["app_stop", {}],
    ]);
  });
  it("return_snapshot=false skips snapshot.take", async () => {
    const t = mk({ "cdc.verb": () => ({ ok: true }) });
    const res = await t.call({ action: "press", return_snapshot: false });
    expect(t.daemon.calls.some((c) => c.op === "snapshot.take")).toBe(false);
    expect(res.structuredContent.snapshot).toBeUndefined();
  });
  it("rejects rotate delta 0 at the schema", async () => {
    const t = mk({});
    const res = await t.call({ action: "rotate", delta: 0 });
    expect(res.isError).toBe(true);
    expect(t.daemon.calls.length).toBe(0);
  });
});
```

`src/tools/snapshot.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";

vi.mock("../utils/remote-client.js", () => ({
  isSimulatorRunning: vi.fn(async () => true),
  sendRemoteCommand: vi.fn(),
}));
import { isSimulatorRunning, sendRemoteCommand } from "../utils/remote-client.js";
import { registerSnapshotTool, simStatsToSnapshot, SnapshotStore, snapshots } from "./snapshot.js";

const snapA = { snapshot_id: "snap_1", device: "dev_3f2a", usb_mode: "default", apps: { running: null, available: ["Sampler"] }, ui: null, kit: { current: 1, name: "A", loading: false, pending: -1 }, leds: null, pads: null, mem: null, ble: null, console: null, ts: 1, changed: [] };
const snapB = { ...snapA, snapshot_id: "snap_2", kit: { current: 2, name: "B", loading: false, pending: -1 }, changed: ["kit"] };

const SIM_STATS = {
  capabilities_raw: 3, capabilities: ["Midi", "AudioOut"],
  pads: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 2, playing: i === 2 || i === 5, note: 36 + i, channel: 9, r: i === 2 ? 255 : 0, g: 0, b: i === 5 ? 128 : 0 })),
  active_pad_logic: "Sampler", registered_pad_logics: ["Sampler", "Sequencer"],
  app_count: 2, apps: ["Sampler", "Sequencer"],
  heap: { sram_free: 100000, sram_total: 400000, psram_free: 7000000, psram_total: 8000000 },
  settings: { lcd_brightness: 80, rgb_brightness: 60, theme_color: 1, audio_engine: true, kit: 4, perf_stats_flags: 0 },
};

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const handles = new HandleRegistry();
  const ctx: ToolContext = { daemon: () => daemon, policy: { mode: "lab", rules: [] }, jobs: new JobRegistry(), handles };
  const fs = fakeServer();
  registerSnapshotTool(fs.server, ctx);
  const tool = fs.tools.get("crosspad_snapshot")!;
  return { daemon, handles, tool, call: (args: any) => tool.cb(args, fakeExtra()) };
}

beforeEach(() => { vi.mocked(sendRemoteCommand).mockReset(); vi.mocked(isSimulatorRunning).mockResolvedValue(true); });

describe("SnapshotStore", () => {
  it("keeps only the last 20", () => {
    const s = new SnapshotStore();
    for (let i = 0; i < 25; i++) s.put({ ...snapA, snapshot_id: `snap_${i}` } as any);
    expect(s.ids().length).toBe(20);
    expect(s.get("snap_4")).toBeUndefined();
    expect(s.get("snap_24")).toBeDefined();
  });
});

describe("simStatsToSnapshot", () => {
  it("maps sim stats into the Snapshot shape with ui null", () => {
    const s = simStatsToSnapshot(SIM_STATS, "snap_sim_1");
    expect(s.device).toBe("sim");
    expect(s.usb_mode).toBe("unknown");
    expect(s.ui).toBeNull();
    expect(s.ble).toBeNull();
    expect(s.console).toBeNull();
    expect(s.apps).toEqual({ running: "Sampler", available: ["Sampler", "Sequencer"] });
    expect(s.kit).toEqual({ current: 4, name: null, loading: false, pending: -1 });
    expect(s.pads).toEqual({ pressed: [2], playing: [2, 5] });
    expect((s.leds as any).brightness).toBe(60);
    expect((s.leds as any).colors[2]).toBe("FF0000");
    expect((s.leds as any).colors[5]).toBe("000080");
    expect((s.leds as any).colors.length).toBe(16);
    expect(s.mem).toEqual({ sram_free: 100000, sram_total: 400000, psram_free: 7000000, psram_total: 8000000 });
  });
});

describe("crosspad_snapshot device", () => {
  it("calls snapshot.take with include and registers a snap handle", async () => {
    const t = mk({ "snapshot.take": () => snapA });
    const res = await t.call({ target: "device", device: "dev_3f2a", include: ["kit", "apps"] });
    expect(t.daemon.calls[0]).toEqual({ op: "snapshot.take", args: { device: "dev_3f2a", include: ["kit", "apps"] } });
    expect(res.structuredContent).toMatchObject({ success: true, snapshot_id: "snap_1", device: "dev_3f2a" });
    expect(t.handles.get("snap_1")).toMatchObject({ kind: "snapshot", device: "dev_3f2a" });
    expect(snapshots.get("snap_1")).toBeDefined();
  });
  it("passes the stored snapshot as previous for diff_from, full snapshot when unknown", async () => {
    const t = mk({ "snapshot.take": (a) => (a.previous ? snapB : snapA) });
    await t.call({ target: "device", device: "dev_3f2a" });
    const res = await t.call({ target: "device", device: "dev_3f2a", diff_from: "snap_1" });
    expect(t.daemon.calls[1].args.previous).toMatchObject({ snapshot_id: "snap_1" });
    expect(res.structuredContent.changed).toEqual(["kit"]);
    await t.call({ target: "device", device: "dev_3f2a", diff_from: "snap_nope" });
    expect(t.daemon.calls[2].args.previous).toBeUndefined();
  });
});

describe("crosspad_snapshot sim", () => {
  it("uses the remote stats command and mints snap_sim ids", async () => {
    vi.mocked(sendRemoteCommand).mockResolvedValue({ ok: true, ...SIM_STATS });
    const t = mk({});
    const res = await t.call({ target: "sim" });
    expect(vi.mocked(sendRemoteCommand)).toHaveBeenCalledWith({ cmd: "stats" });
    expect(String(res.structuredContent.snapshot_id)).toMatch(/^snap_sim_\d+$/);
    expect(res.structuredContent.device).toBe("sim");
    expect(res.structuredContent.ui).toBeNull();
    expect(t.daemon.calls.length).toBe(0);
  });
  it("computes changed against diff_from for sim", async () => {
    vi.mocked(sendRemoteCommand).mockResolvedValue({ ok: true, ...SIM_STATS });
    const t = mk({});
    const first = await t.call({ target: "sim" });
    vi.mocked(sendRemoteCommand).mockResolvedValue({ ok: true, ...SIM_STATS, settings: { ...SIM_STATS.settings, kit: 9 } });
    const res = await t.call({ target: "sim", diff_from: first.structuredContent.snapshot_id });
    expect(res.structuredContent.changed).toEqual(["kit"]);
  });
  it("errors when the sim is not running", async () => {
    vi.mocked(isSimulatorRunning).mockResolvedValue(false);
    const t = mk({});
    const res = await t.call({ target: "sim" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent.error as any).code).toBe("SIM_NOT_RUNNING");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/tools/cdc.test.ts src/tools/ui.test.ts src/tools/snapshot.test.ts`
Expected: FAIL with `Failed to resolve import "./cdc.js"`, `"./ui.js"`, `"./snapshot.js"`.

- [ ] **Step 3a: Write `src/tools/snapshot.ts`** (ui.ts depends on it)

```ts
// src/tools/snapshot.ts — crosspad_snapshot: one call, ~300 tokens, what the device
// (or the sim) is doing right now. Device → daemon snapshot.take; sim → the
// remote `stats` command mapped onto the same Snapshot shape (ui is null there
// until the sim grows ENC_GROUP — spec §11).
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SnapshotSchema, type Snapshot } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { jsonResponse, toolError } from "../tool-result.js";
import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";

export const TOOL_NAME = "crosspad_snapshot";
/** Spec §3.7: snap_* — last 20 kept; unknown diff_from → full snapshot. */
const KEEP = 20;

export const INCLUDE_KEYS = ["apps", "ui", "kit", "leds", "pads", "mem", "ble", "console"] as const;

export class SnapshotStore {
  private readonly order: string[] = [];
  private readonly map = new Map<string, Snapshot>();

  put(snap: Snapshot): void {
    if (!this.map.has(snap.snapshot_id)) this.order.push(snap.snapshot_id);
    this.map.set(snap.snapshot_id, snap);
    while (this.order.length > KEEP) {
      const old = this.order.shift()!;
      this.map.delete(old);
    }
  }

  get(id: string): Snapshot | undefined {
    return this.map.get(id);
  }

  ids(): string[] {
    return [...this.order];
  }
}

export const snapshots = new SnapshotStore();

let simSeq = 0;

function hex2(n: unknown): string {
  const v = typeof n === "number" ? Math.max(0, Math.min(255, Math.round(n))) : 0;
  return v.toString(16).toUpperCase().padStart(2, "0");
}

/** Map crosspad-pc RemoteControl.cpp handle_stats() output onto the Snapshot shape. */
export function simStatsToSnapshot(stats: Record<string, unknown>, id: string): Snapshot {
  const pads = Array.isArray(stats.pads) ? (stats.pads as Array<Record<string, unknown>>) : [];
  const settings = (stats.settings ?? {}) as Record<string, unknown>;
  const heap = (stats.heap ?? {}) as Record<string, unknown>;
  const apps = Array.isArray(stats.apps) ? (stats.apps as string[]) : [];
  const active = typeof stats.active_pad_logic === "string" && stats.active_pad_logic !== "none" ? (stats.active_pad_logic as string) : null;
  const pressed: number[] = [];
  const playing: number[] = [];
  const colors: string[] = [];
  pads.forEach((p, i) => {
    if (p.pressed === true) pressed.push(i);
    if (p.playing === true) playing.push(i);
    colors.push(hex2(p.r) + hex2(p.g) + hex2(p.b));
  });
  return SnapshotSchema.parse({
    snapshot_id: id,
    device: "sim",
    usb_mode: "unknown",
    apps: { running: active, available: apps },
    ui: null,
    kit: { current: typeof settings.kit === "number" ? settings.kit : -1, name: null, loading: false, pending: -1 },
    leds: { brightness: typeof settings.rgb_brightness === "number" ? settings.rgb_brightness : null, anim: null, colors },
    pads: { pressed, playing },
    mem: {
      sram_free: heap.sram_free ?? null,
      sram_total: heap.sram_total ?? null,
      psram_free: heap.psram_free ?? null,
      psram_total: heap.psram_total ?? null,
    },
    ble: null,
    console: null,
    ts: Date.now() / 1000,
    changed: [],
  });
}

/** Top-level keys whose JSON differs (same rule as snapshot.py: dict inequality). */
export function changedKeys(prev: Snapshot, cur: Snapshot): string[] {
  const out: string[] = [];
  for (const k of INCLUDE_KEYS) {
    const a = JSON.stringify((prev as Record<string, unknown>)[k] ?? null);
    const b = JSON.stringify((cur as Record<string, unknown>)[k] ?? null);
    if (a !== b) out.push(k);
  }
  return out;
}

export async function takeDeviceSnapshot(
  ctx: ToolContext,
  device: string | undefined,
  include: string[] | undefined,
  diffFrom: string | undefined,
  signal: AbortSignal,
): Promise<Snapshot> {
  const opArgs: Record<string, unknown> = {};
  if (device !== undefined) opArgs.device = device;
  if (include !== undefined) opArgs.include = include;
  const previous = diffFrom ? snapshots.get(diffFrom) : undefined;
  if (previous) opArgs.previous = previous;
  const raw = await ctx.daemon().request<Record<string, unknown>>("snapshot.take", opArgs, { signal, timeoutMs: 30_000 });
  const snap = SnapshotSchema.parse(raw);
  snapshots.put(snap);
  ctx.handles.register(snap.snapshot_id, { kind: "snapshot", device: snap.device });
  return snap;
}

export async function takeSimSnapshot(ctx: ToolContext, diffFrom: string | undefined): Promise<Snapshot> {
  if (!(await isSimulatorRunning())) {
    const e = new Error("Simulator is not running. Use crosspad_run to start it.") as Error & { code: string };
    e.code = "SIM_NOT_RUNNING";
    throw e;
  }
  const resp = await sendRemoteCommand({ cmd: "stats" });
  if (!resp.ok) {
    const e = new Error((resp.error as string) || "stats failed") as Error & { code: string };
    e.code = "SIM_STATS_FAILED";
    throw e;
  }
  const { ok: _ok, ...stats } = resp;
  simSeq += 1;
  const snap = simStatsToSnapshot(stats, `snap_sim_${simSeq}`);
  const previous = diffFrom ? snapshots.get(diffFrom) : undefined;
  if (previous) snap.changed = changedKeys(previous, snap);
  snapshots.put(snap);
  ctx.handles.register(snap.snapshot_id, { kind: "snapshot", device: "sim" });
  return snap;
}

export const SnapshotInput = z.object({
  target: z.enum(["device", "sim"]).describe("device = a connected CrossPad via the daemon; sim = the running PC simulator (ui is null there)"),
  device: z.string().min(1).optional().describe("Device id or port; omit when exactly one CrossPad is connected. Ignored for sim."),
  include: z.array(z.enum(INCLUDE_KEYS)).optional().describe("Sections to fill (default all). Fewer sections = fewer CDC round-trips."),
  diff_from: z.string().regex(/^snap_/).optional().describe("Earlier snapshot_id; result.changed lists the top-level keys that differ. Unknown id → full snapshot."),
});

export const O_Snapshot = {
  success: z.boolean(),
  ...SnapshotSchema.partial().shape,
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

function codedError(e: unknown) {
  const code = (e as { code?: string }).code;
  if (code && !(e instanceof Error && "details" in e)) {
    return jsonResponse({ success: false, error: { code, message: e instanceof Error ? e.message : String(e) } });
  }
  return toolError(e);
}

export function registerSnapshotTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW | PC sim] One-call state snapshot (~300 tokens): apps {running, available}, ui {focus {ref,label}, group [{ref,label}], drawer, theme, app}, kit, leds, pads, mem, ble, console counters. Refs `e<i>` are ENC_GROUP indices for crosspad_ui focus — any UI action invalidates them and the next snapshot re-mints them. diff_from=<snapshot_id> adds `changed`. target=sim maps the simulator's stats onto the same shape (ui null).",
      inputSchema: SnapshotInput,
      outputSchema: O_Snapshot,
      annotations: annotationsFor(tierOf(TOOL_NAME, {})),
    },
    async (rawArgs, extra) => {
      const args = SnapshotInput.parse(rawArgs);
      if (decide(ctx.policy, TOOL_NAME, args as Record<string, unknown>) === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      try {
        const snap = args.target === "sim"
          ? await takeSimSnapshot(ctx, args.diff_from)
          : await takeDeviceSnapshot(ctx, args.device, args.include, args.diff_from, extra.signal);
        return jsonResponse({ success: true, ...snap });
      } catch (e) {
        return codedError(e);
      }
    },
  );
}
```

- [ ] **Step 3b: Write `src/tools/cdc.ts`**

```ts
// src/tools/cdc.ts — crosspad_cdc: typed CDC verbs (verbs.py through cdc.verb) plus a
// raw escape hatch (cdc.transact). System verbs BOOTLOADER_REQUEST / STM_DFU are
// danger tier: they only run after requireConfirmation().
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReplySchema } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError } from "../tool-result.js";

export const TOOL_NAME = "crosspad_cdc";

const DeviceArg = z.string().min(1).optional().describe("Device id (dev_xxxx) or port; omit when exactly one CrossPad is connected");
const ConfirmToken = z.string().optional().describe("Token from a previous confirmation_required result (danger verbs only)");
const PadIdx = z.number().int().min(0).max(15);
const Vel = z.number().int().min(0).max(127);
const AppName = z.string().min(1).max(31).regex(/^[A-Za-z0-9_-]+$/);

export const CdcInput = z.discriminatedUnion("verb", [
  z.object({
    verb: z.literal("app"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["list", "start", "stop", "destroy", "self_close", "versions"]),
    name: AppName.optional().describe("start: app name as listed by action=list"),
    wait_s: z.number().min(0).max(30).optional().describe("start: wait for APPS running= to confirm (default 3)"),
  }),
  z.object({
    verb: z.literal("kit"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["list", "status", "load"]),
    kit_id: z.number().int().min(0).optional().describe("load: kit id from action=list"),
    wait_s: z.number().min(0).max(120).optional().describe("load: wait until current==kit_id and not loading (default 15)"),
  }),
  z.object({
    verb: z.literal("pad"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["press", "release", "pressure", "stats", "notes", "info"]),
    idx: PadIdx.optional(), vel: Vel.optional(), val: z.number().int().min(0).max(255).optional(),
    reset: z.boolean().optional().describe("stats: reset counters after reading"),
  }),
  z.object({
    verb: z.literal("enc"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["rotate", "press", "group", "focus", "state", "ui_state"]),
    delta: z.number().int().min(-64).max(64).optional(), ms: z.number().int().min(1).max(5000).optional(),
  }),
  z.object({ verb: z.literal("led"), device: DeviceArg, confirm_token: ConfirmToken, action: z.enum(["state"]) }),
  z.object({ verb: z.literal("mem"), device: DeviceArg, confirm_token: ConfirmToken, action: z.enum(["info", "blocks"]) }),
  z.object({
    verb: z.literal("audio"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["level", "tasks", "smpl_peak"]),
    on: z.boolean().optional().describe("tasks: resume (true) or park (false) the RT mixer"),
  }),
  z.object({
    verb: z.literal("ble"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["status", "start", "stop", "scan", "devices", "connect", "disconnect", "send", "txoff"]),
    mode: z.number().int().min(0).max(1).optional().describe("start: 0=server 1=host"),
    ms: z.number().int().min(100).max(60_000).optional().describe("scan: duration (default 5000)"),
    addr: z.string().regex(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/).optional().describe("connect: peer address"),
    note: Vel.optional(), vel: Vel.optional(),
    semis: z.number().int().min(-64).max(64).optional().describe("txoff: send transpose in semitones (not persisted)"),
  }),
  z.object({
    verb: z.literal("system"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["cdc_stats", "bootloader_request", "stm_dfu"]),
  }),
  z.object({
    verb: z.literal("raw"), device: DeviceArg, confirm_token: ConfirmToken,
    cmd: z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/, "cmd must be one printable ASCII line").describe("Exact CDC command line, e.g. 'KIT_STATUS'"),
    expect: z.string().max(40).optional().describe("Reply prefix to wait for (default: from the verb catalog)"),
    timeout_ms: z.number().int().min(50).max(60_000).optional(),
  }),
]);
export type CdcArgs = z.infer<typeof CdcInput>;

export const O_Cdc = {
  success: z.boolean(),
  device: z.string().optional(),
  verb: z.string().optional(),
  result: z.unknown().optional(),
  line: z.string().optional(),
  parsed: z.record(z.string(), z.unknown()).nullable().optional(),
  rtt_ms: z.number().optional(),
  extra_lines: z.array(z.string()).optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

const DANGER_ACTIONS = new Set(["bootloader_request", "stm_dfu"]);

export function isDangerVerb(args: Record<string, unknown>): boolean {
  return args.verb === "system" && typeof args.action === "string" && DANGER_ACTIONS.has(args.action);
}

function pick(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/** Pure: tool args → daemon cdc.verb {verb, args} or cdc.transact args. */
export function toVerbCall(args: CdcArgs): { verb: string; args: Record<string, unknown> } | { raw: { cmd: string; expect?: string; timeout_s?: number } } {
  const a = args as unknown as Record<string, unknown>;
  switch (args.verb) {
    case "raw": {
      const raw: { cmd: string; expect?: string; timeout_s?: number } = { cmd: args.cmd };
      if (args.expect !== undefined) raw.expect = args.expect;
      if (args.timeout_ms !== undefined) raw.timeout_s = args.timeout_ms / 1000;
      return { raw };
    }
    case "app":
      return { verb: `app_${args.action}`, args: args.action === "start" ? pick(a, ["name", "wait_s"]) : {} };
    case "kit":
      return { verb: `kit_${args.action}`, args: args.action === "load" ? pick(a, ["kit_id", "wait_s"]) : {} };
    case "pad": {
      const keys: Record<string, string[]> = { press: ["idx", "vel"], release: ["idx"], pressure: ["idx", "val"], stats: ["reset"], notes: [], info: ["idx"] };
      return { verb: `pad_${args.action}`, args: pick(a, keys[args.action]) };
    }
    case "enc": {
      if (args.action === "ui_state") return { verb: "ui_state", args: {} };
      const keys: Record<string, string[]> = { rotate: ["delta"], press: ["ms"], group: [], focus: [], state: [] };
      return { verb: `enc_${args.action}`, args: pick(a, keys[args.action]) };
    }
    case "led":
      return { verb: "led_state", args: {} };
    case "mem":
      return { verb: args.action === "info" ? "mem" : "mem_blocks", args: {} };
    case "audio":
      if (args.action === "smpl_peak") return { verb: "smpl_peak", args: {} };
      return { verb: `audio_${args.action}`, args: args.action === "tasks" ? pick(a, ["on"]) : {} };
    case "ble": {
      const keys: Record<string, string[]> = { status: [], start: ["mode"], stop: [], scan: ["ms"], devices: [], connect: ["addr"], disconnect: [], send: ["note", "vel"], txoff: ["semis"] };
      return { verb: `ble_${args.action}`, args: pick(a, keys[args.action]) };
    }
    case "system":
      return { verb: args.action, args: {} };
  }
}

function summarize(args: CdcArgs): string {
  if (args.verb === "raw") return `send raw CDC '${args.cmd}' to ${args.device ?? "the only CrossPad"}`;
  if (args.verb === "system" && args.action === "bootloader_request") return `BOOTLOADER_REQUEST on ${args.device ?? "the only CrossPad"}: the ESP reboots into download mode and stops running firmware until flashed`;
  if (args.verb === "system" && args.action === "stm_dfu") return `STM_DFU on ${args.device ?? "the only CrossPad"}: the STM32 bridge enters DFU — the USB console, CDC and MIDI vanish until STM firmware is flashed`;
  return `${args.verb} ${(args as { action?: string }).action ?? ""} on ${args.device ?? "the only CrossPad"}`;
}

export function registerCdcTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] Typed CDC control verbs (main/hil_control.cpp) through the crosspad-hil daemon. verb=app {list|start name|stop|destroy|self_close|versions}, kit {list|status|load kit_id}, pad {press idx vel|release idx|pressure idx val|stats [reset]|notes|info idx}, enc {rotate delta|press [ms]|group|focus|state|ui_state}, led state, mem {info|blocks}, audio {level|tasks on|smpl_peak}, ble {status|start mode|stop|scan ms|devices|connect addr|disconnect|send note vel|txoff semis}, system {cdc_stats|bootloader_request|stm_dfu}, raw {cmd, expect?, timeout_ms?}. Typed verbs return parsed objects; raw returns line + best-effort parsed. bootloader_request / stm_dfu are danger tier and need confirmation. For UI driving prefer crosspad_ui (it re-snapshots). USB profile switches go through crosspad_usb_mode, not raw USB_AUDIO.",
      inputSchema: CdcInput,
      outputSchema: O_Cdc,
      annotations: annotationsFor(tierOf(TOOL_NAME, { verb: "pad", action: "press" })),
    },
    async (rawArgs, extra) => {
      const args = CdcInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} ${args.verb} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summarize(args));
        if (c.status === "token") return c.result;
        if (c.status === "declined") return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: "declined by the user" } });
      }
      const call = toVerbCall(args);
      try {
        if ("raw" in call) {
          const opArgs: Record<string, unknown> = { ...call.raw };
          if (args.device !== undefined) opArgs.device = args.device;
          const reply = ReplySchema.parse(await ctx.daemon().request("cdc.transact", opArgs, { signal: extra.signal, timeoutMs: (call.raw.timeout_s ?? 2) * 1000 + 5000 }));
          return jsonResponse({ success: true, device: args.device, line: reply.line, parsed: reply.parsed, rtt_ms: reply.rtt_ms, extra_lines: reply.extra_lines, ts: Date.now() });
        }
        const opArgs: Record<string, unknown> = {};
        if (args.device !== undefined) opArgs.device = args.device;
        opArgs.verb = call.verb;
        opArgs.args = call.args;
        const waitS = typeof (call.args as { wait_s?: number }).wait_s === "number" ? (call.args as { wait_s: number }).wait_s : 15;
        const result = await ctx.daemon().request<unknown>("cdc.verb", opArgs, { signal: extra.signal, timeoutMs: waitS * 1000 + 10_000 });
        return jsonResponse({ success: true, device: args.device, verb: call.verb, result, ts: Date.now() });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
```

- [ ] **Step 3c: Write `src/tools/ui.ts`**

```ts
// src/tools/ui.ts — crosspad_ui: drive the screen by ref (Playwright-style).
// focus(ref) = ENC_GROUP + ENC_FOCUS → rotate by the index delta; press/rotate/
// back/start_app/stop_app are one verb each; every action ends with a fresh
// snapshot (refs are re-minted there) unless return_snapshot=false.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HilError } from "../hil/daemon.js";
import { SnapshotSchema } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError } from "../tool-result.js";
import { takeDeviceSnapshot } from "./snapshot.js";

export const TOOL_NAME = "crosspad_ui";
/** hil_control.cpp ENC_PRESS default: 80 ms (verbs.enc_press ms=80). */
const DEFAULT_PRESS_MS = 80;
/** verbs.app_start default wait_s. */
const DEFAULT_START_WAIT_S = 3;

const Common = {
  device: z.string().min(1).optional().describe("Device id or port; omit when exactly one CrossPad is connected"),
  return_snapshot: z.boolean().optional().describe("Take a fresh crosspad_snapshot after the action (default true)"),
  include: z.array(z.enum(["apps", "ui", "kit", "leds", "pads", "mem", "ble", "console"])).optional().describe("Snapshot sections (default all)"),
};

export const UiInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("focus"), ref: z.string().regex(/^e\d+$/, "ref looks like e<i> from a snapshot's ui.group"), ...Common }),
  z.object({ action: z.literal("press"), ms: z.number().int().min(1).max(5000).optional().describe(`Encoder button hold (default ${DEFAULT_PRESS_MS})`), ...Common }),
  z.object({ action: z.literal("rotate"), delta: z.number().int().min(-64).max(64).refine((d) => d !== 0, "delta must be non-zero"), ...Common }),
  z.object({ action: z.literal("back"), ...Common }),
  z.object({ action: z.literal("start_app"), name: z.string().min(1).max(31).regex(/^[A-Za-z0-9_-]+$/), wait_s: z.number().min(0).max(30).optional(), ...Common }),
  z.object({ action: z.literal("stop_app"), ...Common }),
]);
export type UiArgs = z.infer<typeof UiInput>;

export const O_Ui = {
  success: z.boolean(),
  action: z.string().optional(),
  device: z.string().optional(),
  delta: z.number().int().optional(),
  from_index: z.number().int().optional(),
  to_index: z.number().int().optional(),
  result: z.unknown().optional(),
  snapshot: SnapshotSchema.optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/** TS port of snapshot.ref_to_delta(): index(ref) − focus_index; unknown ref → BAD_ARGS. */
export function refToDelta(group: Array<{ ref: string; index: number }>, focusIndex: number, ref: string): number {
  const entry = group.find((g) => g.ref === ref);
  if (!entry) {
    throw new HilError("BAD_ARGS", `ref ${ref} is not in the current encoder group (${group.length} entries)`, "take crosspad_snapshot and use a ref from ui.group — refs are re-minted after every UI action");
  }
  return entry.index - focusIndex;
}

export function registerUiTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] Drive the device UI by snapshot refs. focus ref=e<i> moves the encoder focus to that group entry (ENC_GROUP + ENC_FOCUS → ENC_ROTATE by the delta); press = encoder click; rotate delta; back = the app's own Back (APP_SELF_CLOSE); start_app name; stop_app (APP_STOP, rebuilds the launcher). Every action returns a fresh snapshot by default — use its ui.group refs for the next step, old refs are invalid.",
      inputSchema: UiInput,
      outputSchema: O_Ui,
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "press" })),
    },
    async (rawArgs, extra) => {
      const args = UiInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, `crosspad_ui ${args.action} on ${args.device ?? "the only CrossPad"}`);
        if (c.status === "token") return c.result;
        if (c.status === "declined") return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: "declined by the user" } });
      }
      const daemon = ctx.daemon();
      const signal = extra.signal;
      const verb = async <T = unknown>(name: string, vargs: Record<string, unknown>, timeoutMs = 15_000): Promise<T> => {
        const opArgs: Record<string, unknown> = {};
        if (args.device !== undefined) opArgs.device = args.device;
        opArgs.verb = name;
        opArgs.args = vargs;
        return daemon.request<T>("cdc.verb", opArgs, { signal, timeoutMs });
      };

      try {
        const out: Record<string, unknown> = { success: true, action: args.action, device: args.device };
        if (args.action === "focus") {
          const g = await verb<{ group: Array<{ ref: string; index: number; ptr: string; label: string }> }>("enc_group", {});
          const f = await verb<{ index: number; label: string; ptr: string }>("enc_focus", {});
          const delta = refToDelta(g.group, f.index, args.ref);
          out.from_index = f.index;
          out.to_index = f.index + delta;
          out.delta = delta;
          if (delta !== 0) out.result = await verb("enc_rotate", { delta });
        } else if (args.action === "press") {
          out.result = await verb("enc_press", { ms: args.ms ?? DEFAULT_PRESS_MS });
        } else if (args.action === "rotate") {
          out.delta = args.delta;
          out.result = await verb("enc_rotate", { delta: args.delta });
        } else if (args.action === "back") {
          out.result = await verb("app_self_close", {});
        } else if (args.action === "start_app") {
          const wait_s = args.wait_s ?? DEFAULT_START_WAIT_S;
          out.result = await verb("app_start", { name: args.name, wait_s }, wait_s * 1000 + 10_000);
        } else {
          out.result = await verb("app_stop", {});
        }
        if (args.return_snapshot !== false) {
          out.snapshot = await takeDeviceSnapshot(ctx, args.device, args.include, undefined, signal);
        }
        out.ts = Date.now();
        return jsonResponse(out);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/tools/cdc.test.ts src/tools/ui.test.ts src/tools/snapshot.test.ts && npx tsc --noEmit`
Expected: `Test Files 3 passed`, `Tests 20 passed`; tsc prints nothing.

If `crosspad_cdc` under `strict` returns `success:true` instead of `confirmation_required`, the cause is `TOOL_TIERS.crosspad_cdc` (chunk C2) not returning `"danger"` for `{verb:"system", action:"bootloader_request"|"stm_dfu"}` — it must call `isDangerVerb(args)` from this file (`import { isDangerVerb } from "../tools/cdc.js"`). Fix the tier table, not the test.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add src/tools/cdc.ts src/tools/ui.ts src/tools/snapshot.ts src/tools/cdc.test.ts src/tools/ui.test.ts src/tools/snapshot.test.ts && git commit -m "feat(v10): crosspad_cdc typed verbs with danger confirmation, crosspad_ui by snapshot ref, crosspad_snapshot for device and sim"
```

---

### Wiring note for the chunk that owns `src/registry.ts`

`registerAll(server, ctx, manager)` must add, in this order:

```ts
manager.register("crosspad_devices",  registerDevicesTool(server, ctx),  "core");
manager.register("crosspad_doctor",   registerDoctorTool(server, ctx),   "core");
manager.register("crosspad_snapshot", registerSnapshotTool(server, ctx), "core");
manager.register("crosspad_cdc",      registerCdcTool(server, ctx),      "device");
manager.register("crosspad_console",  registerConsoleTool(server, ctx),  "device");
manager.register("crosspad_ui",       registerUiTool(server, ctx),       "device");
registerDeviceResources(server, ctx);
```

and `src/index.ts` must drop the v9 `crosspad_devices` block at lines 672-681 (the `listDevices()` import at line 20 stays only if `crosspad_log`/`crosspad_flash` still use `findCrosspadPort`).

### Task 8: MIDI, USB mode and audio routing over the daemon

**Files:**
- Create: `/home/matixan/GIT/crosspad-mcp/src/hil/select.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/src/tools/usb-mode.ts`
- Modify: `/home/matixan/GIT/crosspad-mcp/src/tools/midi.ts` — keep lines 1–150 (`MidiEventType`, `MidiSendParams`, `MidiSendResult`, `crosspadMidiSend`) byte-for-byte; add imports at the top and append the v10 section
- Modify: `/home/matixan/GIT/crosspad-mcp/src/tools/audio-route.ts` — replace lines 1–17 (header + `execFileSync` import), delete `findEspMidiPort` (lines 52–66) and `decodeState` (lines 92–102), rewrite `crosspadAudioRouteSet` (lines 104–121) and `crosspadAudioRouteQuery` (lines 123–147); `buildSetFrames`, `ADC_CODE`/`ADC_NAME`/`DAC_CODE`/`DAC_NAME` and the exported types stay
- Modify: `/home/matixan/GIT/crosspad-mcp/src/policy/tiers.ts` — add `usbModeTier`, change `crosspad_usb_mode` from the fixed `"stimulus"` to `usbModeTier`
- Modify: `/home/matixan/GIT/crosspad-mcp/src/registry.ts` — three `manager.register(...)` lines in the `device` block
- Modify: `/home/matixan/GIT/crosspad-mcp/src/index.ts` — delete the inline `crosspad_midi` block (lines 1089–1141), the inline `crosspad_audio_route` block (lines 1147–1183), the `O_Midi` (352–358) and `O_AudioRoute` (360–372) consts, and the now-unused `crosspadMidiSend` / `crosspadAudioRouteSet` / `crosspadAudioRouteQuery` imports
- Modify: `/home/matixan/GIT/crosspad-mcp/src/tools/audio-route.test.ts` — line 2 (import) and the `decodeState` describe block (lines 47–70); the `buildSetFrames` block is untouched
- Test: `/home/matixan/GIT/crosspad-mcp/src/hil/select.test.ts`
- Test: `/home/matixan/GIT/crosspad-mcp/src/tools/midi.device.test.ts`
- Test: `/home/matixan/GIT/crosspad-mcp/src/tools/usb-mode.test.ts`

**Interfaces:**

- Consumes:
  - `HilDaemon.request<T>(op: string, args: Record<string, unknown>, opts?: {signal?: AbortSignal; timeoutMs?: number}): Promise<T>` and `class HilError extends Error { code: string; hint?: string; details: Record<string, unknown> }` from `src/hil/daemon.ts` (Task 1).
  - `DeviceSchema` + `type Device` from `src/hil/schemas.ts` (Task 1).
  - `ToolContext` (`{daemon: () => HilDaemon; policy: Policy; jobs: JobRegistry; handles: HandleRegistry}`) from `src/tool-context.ts` (Tasks 2/4).
  - `decide(policy, tool, args): "allow"|"confirm"|"hidden"` from `src/policy/policy.ts` (Task 3); `tierOf(tool, args)`, `annotationsFor(tier)`, `TOOL_TIERS`, type `Tier` from `src/policy/tiers.ts` (Task 3).
  - `requireConfirmation(server, extra, tool, args, summary)` → `{status:"approved"} | {status:"declined"} | {status:"token", result}` from `src/policy/confirm.ts` (Task 3).
  - `jsonResponse(data: object): ToolResult`, `toolError(e: unknown): ToolResult` from `src/tool-result.ts` (Task 5).
  - `fakeDaemon(handlers)`, `fakeServer()`, `fakeExtra()` from `src/testing/fake-daemon.ts` / `src/testing/fake-server.ts` (Task 5).
  - `sendRemoteCommand`, `isSimulatorRunning` from `src/utils/remote-client.ts` (existing; used only by the unchanged sim path).
  - Daemon ops verbatim from the contract's `serve.py` table: `devices.list {}` → `{"devices": [Device.to_dict]}`; `midi.sysex {device, role?, frame}` → `{"sent": n}`; `midi.note {device, role?, on, note, vel?, channel?}`; `midi.echo_rtt {device, n?}` → `{sent, received, lost, rtt_ms:{p50,p90,max}}`; `midi.query_route {device}` → `{mic_src, adc:[a0,a1], out:[o0,o1], vol:[v0,v1], mute:[m0,m1]}`; `usbmode.set {device, mode, wait?}` → `Device` dict.

- Produces:
  - `src/hil/select.ts`: `export interface DaemonRequester { request<T = unknown>(op: string, args: Record<string, unknown>, opts?: {signal?: AbortSignal; timeoutMs?: number}): Promise<T> }`; `export async function listHilDevices(daemon: DaemonRequester, signal?: AbortSignal): Promise<Device[]>`; `export function pickDevice(devices: Device[], device?: string): Device` (TS port of `devices.py select()`); `export function espSide(d: Device): boolean`; `export function portPaths(d: Device): Array<{role: "cdc"|"console"|"bootloader"; path: string}>`; `export function roleOfPort(d: Device, path: string): "cdc"|"console"|"bootloader"|null`.
  - `src/tools/midi.ts` (additions): `export const TOOL_NAME = "crosspad_midi"`; `export type MidiRole = "esp" | "stm"`; `export const MidiInput` (`z.discriminatedUnion("target", [...])`); `export type MidiArgs = z.infer<typeof MidiInput>`; `export const O_Midi`; `export function toMidiOp(args: MidiArgs): {op: string; args: Record<string, unknown>}` (pure, unit-tested); `export function registerMidiTool(server: McpServer, ctx: ToolContext): RegisteredTool`. `crosspadMidiSend` and its types keep their current signatures.
  - `src/tools/usb-mode.ts`: `export const TOOL_NAME = "crosspad_usb_mode"`; `export const UsbModeInput`; `export type UsbModeArgs`; `export const O_UsbMode`; `export function usbModeRow(d: Device): {device: string; usb_mode: string; cdc: string|null; console: string|null; uac2: string|null; esp_midi: string|null; board_rev: string|null}`; `export function registerUsbModeTool(server: McpServer, ctx: ToolContext): RegisteredTool`.
  - `src/tools/audio-route.ts` (changed): `export const TOOL_NAME = "crosspad_audio_route"`; `export function hexFrame(bytes: number[]): string`; `export function stateFromQuery(q: Record<string, unknown>): AudioRouteState`; `export async function crosspadAudioRouteSet(daemon: DaemonRequester, device: string | undefined, params: AudioRouteSetParams, signal?: AbortSignal): Promise<AudioRouteResult>`; `export async function crosspadAudioRouteQuery(daemon: DaemonRequester, device: string | undefined, signal?: AbortSignal): Promise<AudioRouteResult>`; `export const AudioRouteInput`; `export type AudioRouteArgs`; `export const O_AudioRoute`; `export function registerAudioRouteTool(server: McpServer, ctx: ToolContext): RegisteredTool`. `buildSetFrames`, `AdcInput`, `DacOutput`, `AudioRouteSetParams`, `AudioRouteState`, `AudioRouteResult` unchanged. `findEspMidiPort` and `decodeState` are **removed** (the `amidi` transport they served no longer exists).
  - `src/policy/tiers.ts` (changed): `const usbModeTier: TierFn = (args) => (str(args, "action") === "get" ? "read" : "stimulus");` wired as `crosspad_usb_mode: usbModeTier`.

Contract choices stated here (the contract and Tasks 1–7 are silent):
- `crosspad_midi.target` is **required** (a `z.discriminatedUnion("target", …)`), not defaulted. v10 is a breaking release and a silent default would send a sim call to hardware or the reverse.
- `role` is accepted only on `target:"device"` with `action:"note"|"sysex"` — the contract gives `midi.echo_rtt` and `midi.query_route` no `role` arg (they need the ESP IN port; `MidiIO.receive` raises `NOT_SUPPORTED` for STM).
- `crosspad_audio_route` gains one optional field, `device` — additive, so the v9 schema and the v9 `{success, sent?, state?, port?, error?}` output shape both still validate. `port` is now the resolved device's `ports.esp_midi.alsa_hw ?? ports.esp_midi.name` instead of an `amidi -l` line.
- `crosspad_usb_mode` moves from the fixed `"stimulus"` of Task 3's table to arg-dependent: `action:"get"` is a pure `devices.list` read, so it stays available under `--read-only`. Task 3's `tiers.test.ts` only asserts `TOOL_TIERS.crosspad_usb_mode` is *defined*, so this keeps that suite green. `crosspad_midi` and `crosspad_audio_route` keep exactly the tiers Task 3 assigned.
- `pickDevice` lives in a new `src/hil/select.ts` rather than in `src/tools/devices.ts` because three tools (`usb_mode`, `audio_route`, and `flash` in Task 9) need it and `devices.ts` owns presentation (`toV10DeviceRow`), not selection.

---

- [ ] **Step 1: Write the failing selection test**

`/home/matixan/GIT/crosspad-mcp/src/hil/select.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HilError } from "./daemon.js";
import { listHilDevices, pickDevice, espSide, portPaths, roleOfPort } from "./select.js";

function port(path: string, vid = 0x303a, pid = 0x3456) {
  return { path, vid, pid, serial: null, product: null, location: "1-1.2" };
}

const ESP = {
  id: "dev_3f2a",
  serial: "AABB",
  usb_mode: "default" as const,
  ports: { cdc: port("/dev/ttyACM0"), console: port("/dev/ttyACM1", 0x0483, 0x5740), esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
  board_rev: "v2",
};
const CONSOLE_ONLY = {
  id: "dev_9911",
  serial: "CCDD",
  usb_mode: "unknown" as const,
  ports: { cdc: null, console: port("/dev/ttyACM3", 0x0483, 0x5740), esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
  board_rev: null,
};

describe("listHilDevices", () => {
  it("calls devices.list and parses every row", async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const daemon = {
      async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ op, args });
        return { devices: [ESP, CONSOLE_ONLY] } as unknown as T;
      },
    };
    const rows = await listHilDevices(daemon);
    expect(calls).toEqual([{ op: "devices.list", args: {} }]);
    expect(rows.map((d) => d.id)).toEqual(["dev_3f2a", "dev_9911"]);
    expect(rows[0].board_rev).toBe("v2");
  });
});

describe("pickDevice", () => {
  it("with no argument picks the only device that has an ESP side", () => {
    expect(pickDevice([ESP, CONSOLE_ONLY]).id).toBe("dev_3f2a");
  });

  it("raises NO_DEVICE when nothing has an ESP side", () => {
    try {
      pickDevice([CONSOLE_ONLY]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HilError);
      expect((e as HilError).code).toBe("NO_DEVICE");
      expect((e as HilError).message).toMatch(/bootloader/i);
    }
  });

  it("raises AMBIGUOUS_DEVICE with the candidate ids", () => {
    const second = { ...ESP, id: "dev_7c01" };
    try {
      pickDevice([ESP, second]);
      expect.unreachable("should have thrown");
    } catch (e) {
      const h = e as HilError;
      expect(h.code).toBe("AMBIGUOUS_DEVICE");
      expect(h.hint).toContain("device=");
      expect(h.details.candidates).toEqual(["dev_3f2a", "dev_7c01"]);
    }
  });

  it("matches by id and by any port path", () => {
    expect(pickDevice([ESP, CONSOLE_ONLY], "dev_9911").id).toBe("dev_9911");
    expect(pickDevice([ESP, CONSOLE_ONLY], "/dev/ttyACM3").id).toBe("dev_9911");
    expect(pickDevice([ESP, CONSOLE_ONLY], "/dev/ttyACM1").id).toBe("dev_3f2a");
  });

  it("an unknown id is NO_DEVICE and lists what is there", () => {
    try {
      pickDevice([ESP], "dev_beef");
      expect.unreachable("should have thrown");
    } catch (e) {
      const h = e as HilError;
      expect(h.code).toBe("NO_DEVICE");
      expect(h.details.candidates).toEqual(["dev_3f2a"]);
    }
  });
});

describe("port roles", () => {
  it("espSide is true only when a cdc or bootloader port exists", () => {
    expect(espSide(ESP)).toBe(true);
    expect(espSide(CONSOLE_ONLY)).toBe(false);
  });

  it("portPaths lists cdc, console and bootloader with their roles", () => {
    expect(portPaths(ESP)).toEqual([
      { role: "cdc", path: "/dev/ttyACM0" },
      { role: "console", path: "/dev/ttyACM1" },
    ]);
  });

  it("roleOfPort names the role of a path, or null", () => {
    expect(roleOfPort(ESP, "/dev/ttyACM1")).toBe("console");
    expect(roleOfPort(ESP, "/dev/ttyACM0")).toBe("cdc");
    expect(roleOfPort(ESP, "/dev/ttyUSB9")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/hil/select.test.ts`
Expected: FAIL with `Failed to load url ./select.js (resolved id: ./select.js) in /home/matixan/GIT/crosspad-mcp/src/hil/select.test.ts`.

- [ ] **Step 3: Write `src/hil/select.ts`**

```ts
// src/hil/select.ts — the TS half of devices.py discover()+select(). The daemon
// re-resolves `device` on every op, so this module never caches: it exists so a
// tool can name the device it is about to act on, refuse the wrong port role,
// and produce the same NO_DEVICE / AMBIGUOUS_DEVICE errors the daemon would.
import { HilError } from "./daemon.js";
import { DeviceSchema, type Device } from "./schemas.js";

export interface DaemonRequester {
  request<T = unknown>(
    op: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
}

/** devices.list {} → parsed Device rows, in daemon order. */
export async function listHilDevices(daemon: DaemonRequester, signal?: AbortSignal): Promise<Device[]> {
  const raw = await daemon.request<{ devices: unknown[] }>("devices.list", {}, signal ? { signal } : undefined);
  return (raw.devices ?? []).map((d) => DeviceSchema.parse(d));
}

/** True when the device has an ESP-side port (cdc or bootloader) — devices.py select(). */
export function espSide(d: Device): boolean {
  return !!d.ports.cdc || !!d.ports.bootloader;
}

/** Every serial port this device owns, tagged with its role. */
export function portPaths(d: Device): Array<{ role: "cdc" | "console" | "bootloader"; path: string }> {
  const out: Array<{ role: "cdc" | "console" | "bootloader"; path: string }> = [];
  if (d.ports.cdc) out.push({ role: "cdc", path: d.ports.cdc.path });
  if (d.ports.console) out.push({ role: "console", path: d.ports.console.path });
  if (d.ports.bootloader) out.push({ role: "bootloader", path: d.ports.bootloader.path });
  return out;
}

/** Which role a path plays on this device, or null when it is not one of its ports. */
export function roleOfPort(d: Device, path: string): "cdc" | "console" | "bootloader" | null {
  return portPaths(d).find((p) => p.path === path)?.role ?? null;
}

/**
 * devices.py select(): no argument → the single device with an ESP side;
 * an argument → the device with that id, or the device owning that port path.
 */
export function pickDevice(devices: Device[], device?: string): Device {
  const candidates = devices.map((d) => d.id);
  if (device === undefined || device === "") {
    const withEsp = devices.filter(espSide);
    if (withEsp.length === 1) return withEsp[0];
    if (withEsp.length === 0) {
      throw new HilError(
        "NO_DEVICE",
        "no CrossPad found; is it in bootloader/DFU?",
        "Check the cable, then run crosspad_devices — a device seen only as an STM32 bridge console has no ESP side to talk to.",
        { candidates },
      );
    }
    throw new HilError(
      "AMBIGUOUS_DEVICE",
      `${withEsp.length} CrossPads are connected; say which one.`,
      `pass device=<id> (one of ${withEsp.map((d) => d.id).join(", ")})`,
      { candidates: withEsp.map((d) => d.id) },
    );
  }
  const byId = devices.find((d) => d.id === device);
  if (byId) return byId;
  const byPort = devices.find((d) => roleOfPort(d, device) !== null);
  if (byPort) return byPort;
  throw new HilError(
    "NO_DEVICE",
    `no CrossPad matches "${device}"`,
    "pass a device id from crosspad_devices, or one of its port paths",
    { candidates },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/hil/select.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing MIDI test**

`/home/matixan/GIT/crosspad-mcp/src/tools/midi.device.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerMidiTool, toMidiOp, TOOL_NAME } from "./midi.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";
import { jobs } from "../tasks.js";
import { handles } from "../handles.js";

const STRICT: Policy = { mode: "strict", rules: [] };

function ctxFor(daemon: ReturnType<typeof fakeDaemon>): ToolContext {
  return { daemon: () => daemon, policy: STRICT, jobs, handles };
}

describe("toMidiOp", () => {
  it("maps note on/off to midi.note with the daemon's arg names", () => {
    expect(toMidiOp({ target: "device", action: "note", on: true, note: 40, vel: 110, channel: 2, role: "esp" } as never))
      .toEqual({ op: "midi.note", args: { role: "esp", on: true, note: 40, vel: 110, channel: 2 } });
    expect(toMidiOp({ target: "device", action: "note", on: false, note: 40 } as never))
      .toEqual({ op: "midi.note", args: { on: false, note: 40 } });
  });

  it("maps sysex to midi.sysex, keeping the hex string verbatim", () => {
    expect(toMidiOp({ target: "device", action: "sysex", frame: "F0 7D 1D 10 F7", role: "stm" } as never))
      .toEqual({ op: "midi.sysex", args: { role: "stm", frame: "F0 7D 1D 10 F7" } });
  });

  it("maps echo_rtt and query_route without a role", () => {
    expect(toMidiOp({ target: "device", action: "echo_rtt", n: 50 } as never))
      .toEqual({ op: "midi.echo_rtt", args: { n: 50 } });
    expect(toMidiOp({ target: "device", action: "query_route" } as never))
      .toEqual({ op: "midi.query_route", args: {} });
  });
});

describe("crosspad_midi target=device", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); });

  it("sends a note over the daemon and reports what it sent", async () => {
    const d = fakeDaemon({ "midi.note": () => ({ ok: true }) });
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "device", action: "note", on: true, note: 36, vel: 100, device: "dev_3f2a" },
      fakeExtra(),
    );
    expect(d.calls[0].op).toBe("midi.note");
    expect(d.calls[0].args).toEqual({ device: "dev_3f2a", on: true, note: 36, vel: 100 });
    expect(r.structuredContent).toMatchObject({ success: true, target: "device", action: "note", device: "dev_3f2a" });
  });

  it("passes the role through to the daemon", async () => {
    const d = fakeDaemon({ "midi.sysex": () => ({ sent: 5 }) });
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "device", action: "sysex", frame: "F0 7D 1B 02 F7", role: "stm" },
      fakeExtra(),
    );
    expect(d.calls[0].args).toEqual({ role: "stm", frame: "F0 7D 1B 02 F7" });
    expect(r.structuredContent.result).toEqual({ sent: 5 });
  });

  it("rejects a frame that is not F0 … F7 before touching the daemon", async () => {
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "device", action: "sysex", frame: "90 40 7F" },
      fakeExtra(),
    );
    expect(r.isError).toBe(true);
    expect(String((r.structuredContent.error as { message?: string })?.message)).toMatch(/F0/);
    expect(d.calls).toHaveLength(0);
  });

  it("surfaces a daemon error as the v10 error envelope", async () => {
    const { HilError } = await import("../hil/daemon.js");
    const d = fakeDaemon({ "midi.query_route": () => { throw new HilError("TIMEOUT", "no query reply within 1.0 s", "is the firmware built with audio_route_control?"); } });
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "device", action: "query_route" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "TIMEOUT", hint: "is the firmware built with audio_route_control?" });
  });

  it("reports echo_rtt statistics unchanged", async () => {
    const d = fakeDaemon({ "midi.echo_rtt": () => ({ sent: 20, received: 20, lost: 0, rtt_ms: { p50: 4.1, p90: 7.2, max: 11.0 } }) });
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "device", action: "echo_rtt", n: 20 }, fakeExtra());
    expect(r.structuredContent.result).toMatchObject({ sent: 20, lost: 0 });
  });
});

describe("crosspad_midi target=sim", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("cc is still refused with an actionable message and never reaches the daemon", async () => {
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "sim", type: "cc", channel: 0, cc_num: 7, value: 100 },
      fakeExtra(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.structuredContent.error)).toMatch(/not yet supported by the PC simulator/i);
    expect(String(r.structuredContent.error)).toMatch(/note_on\/note_off/);
    expect(d.calls).toHaveLength(0);
  });

  it("program_change is refused the same way", async () => {
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "sim", type: "program_change", channel: 0, program: 3 },
      fakeExtra(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.structuredContent.error)).toMatch(/midi_program_change/);
  });

  it("note_on still goes through crosspadMidiSend, not the daemon", async () => {
    const remote = await import("../utils/remote-client.js");
    vi.spyOn(remote, "isSimulatorRunning").mockResolvedValue(true);
    const send = vi.spyOn(remote, "sendRemoteCommand").mockResolvedValue({ ok: true } as never);
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "sim", type: "note_on", channel: 0, note: 60 },
      fakeExtra(),
    );
    expect(send).toHaveBeenCalledWith({ cmd: "midi_note_on", channel: 0, note: 60, velocity: 127 });
    expect(r.structuredContent).toMatchObject({ success: true, target: "sim", type: "note_on" });
    expect(d.calls).toHaveLength(0);
  });

  it("a missing note is refused before the sim is contacted", async () => {
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "sim", type: "note_on", channel: 0 }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(String(r.structuredContent.error)).toContain("'note' is required");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/midi.device.test.ts`
Expected: FAIL with `SyntaxError: The requested module './midi.js' does not provide an export named 'registerMidiTool'`.

- [ ] **Step 7: Extend `src/tools/midi.ts`**

Add these import lines directly under the existing `import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";` (line 8):

```ts
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { decide } from "../policy/policy.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError } from "../tool-result.js";
import { HilError } from "../hil/daemon.js";
```

Then append the whole v10 section to the end of the file (nothing above it changes):

```ts
// ═══════════════════════════════════════════════════════════════════════
// v10 — the same tool over two transports.
//   target="device" → the crosspad-hil daemon's MIDI ops against real hardware
//   target="sim"    → the PC simulator's TCP RemoteControl (unchanged v9 path)
// `target` is required: a MIDI note is a side effect and guessing which machine
// receives it is exactly the mistake this tool must not make.
// ═══════════════════════════════════════════════════════════════════════

export const TOOL_NAME = "crosspad_midi";

/** midi.py MidiRole — which USB MIDI endpoint the frame leaves by. */
export type MidiRole = "esp" | "stm";

const RoleArg = z.enum(["esp", "stm"]).optional()
  .describe("Which MIDI endpoint: 'esp' (default) = the ESP's native USB MIDI, the only port that answers queries; 'stm' = the STM32 bridge port ('CrossPad MIDI+Serial').");
const DeviceArg = z.string().min(1).optional()
  .describe("Device id (dev_xxxx) or one of its port paths; omit when exactly one CrossPad is connected.");

/** F0 … F7, whitespace-separated hex bytes. Validated before the daemon is called. */
const SysexFrame = z.string()
  .regex(/^\s*[Ff]0(\s+[0-9A-Fa-f]{2})*\s+[Ff]7\s*$/, "frame must be whitespace-separated hex bytes starting F0 and ending F7, e.g. 'F0 7D 1D 10 F7'")
  .describe("Raw SysEx frame as hex bytes, e.g. 'F0 7D 1D 10 F7'. Manufacturer 0x7D is CrossPad's; the daemon refuses the host-denylisted frames.");

export const MidiInput = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("device"),
    device: DeviceArg,
    action: z.enum(["note", "sysex", "echo_rtt", "query_route"])
      .describe("note = one note on/off; sysex = one raw frame; echo_rtt = round-trip timing over SysEx echo; query_route = read the audio routing state."),
    role: RoleArg,
    on: z.boolean().optional().describe("note: true = note on, false = note off."),
    note: z.number().int().min(0).max(127).optional().describe("note: MIDI note number 0-127."),
    vel: z.number().int().min(0).max(127).optional().describe("note: velocity 0-127 (default 100)."),
    channel: z.number().int().min(0).max(15).optional().describe("note: MIDI channel 0-15 (default 0)."),
    frame: SysexFrame.optional(),
    n: z.number().int().min(1).max(500).optional().describe("echo_rtt: how many echo frames to send (default 20)."),
  }),
  z.object({
    target: z.literal("sim"),
    type: z.enum(["note_on", "note_off", "cc", "program_change"])
      .describe("Sim MIDI event type. note_on/note_off need `note`; cc and program_change are not implemented by the sim and fail fast."),
    channel: z.number().int().min(0).max(15).default(0).describe("MIDI channel 0-15 (default 0)."),
    note: z.number().int().min(0).max(127).optional(),
    velocity: z.number().int().min(0).max(127).optional(),
    cc_num: z.number().int().min(0).max(127).optional(),
    value: z.number().int().min(0).max(127).optional(),
    program: z.number().int().min(0).max(127).optional(),
  }),
]);
export type MidiArgs = z.infer<typeof MidiInput>;

export const O_Midi = {
  success: z.boolean(),
  target: z.enum(["device", "sim"]).optional(),
  action: z.string().optional(),
  device: z.string().optional(),
  role: z.string().optional(),
  result: z.unknown().optional(),
  type: z.enum(["note_on", "note_off", "cc", "program_change"]).optional(),
  channel: z.number().int().optional(),
  details: z.record(z.string(), z.number()).optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
  ]).optional(),
};

/** Pure: device-branch args → the daemon op and its args (`device` added by the caller). */
export function toMidiOp(args: MidiArgs): { op: string; args: Record<string, unknown> } {
  if (args.target !== "device") {
    throw new HilError("BAD_ARGS", "toMidiOp is only defined for target='device'");
  }
  const out: Record<string, unknown> = {};
  switch (args.action) {
    case "note":
      if (args.role !== undefined) out.role = args.role;
      out.on = args.on ?? true;
      if (args.note === undefined) throw new HilError("BAD_ARGS", "action='note' requires 'note' (0-127)");
      out.note = args.note;
      if (args.vel !== undefined) out.vel = args.vel;
      if (args.channel !== undefined) out.channel = args.channel;
      return { op: "midi.note", args: out };
    case "sysex":
      if (args.frame === undefined) throw new HilError("BAD_ARGS", "action='sysex' requires 'frame' (e.g. 'F0 7D 1D 10 F7')");
      if (args.role !== undefined) out.role = args.role;
      out.frame = args.frame;
      return { op: "midi.sysex", args: out };
    case "echo_rtt":
      if (args.n !== undefined) out.n = args.n;
      return { op: "midi.echo_rtt", args: out };
    case "query_route":
      return { op: "midi.query_route", args: out };
  }
}

function summarizeMidi(args: MidiArgs): string {
  if (args.target === "sim") return `crosspad_midi sim ${args.type}`;
  return `crosspad_midi ${args.action} on ${args.device ?? "the only CrossPad"} (${args.role ?? "esp"} port)`;
}

async function runSim(args: Extract<MidiArgs, { target: "sim" }>) {
  const need = (field: string, val: unknown): string | null =>
    val === undefined ? `Field '${field}' is required for type='${args.type}'.` : null;
  let missing: string | null = null;
  switch (args.type) {
    case "note_on":
    case "note_off":
      missing = need("note", args.note); break;
    case "cc":
      missing = need("cc_num", args.cc_num) ?? need("value", args.value); break;
    case "program_change":
      missing = need("program", args.program); break;
  }
  if (missing) return jsonResponse({ success: false, target: "sim", type: args.type, error: missing });

  const sent = await crosspadMidiSend({
    type: args.type,
    channel: args.channel,
    note: args.note,
    velocity: args.velocity ?? (args.type === "note_off" ? 0 : args.type === "note_on" ? 127 : undefined),
    cc_num: args.cc_num,
    value: args.value,
    program: args.program,
  });
  return jsonResponse({ target: "sim", ...sent });
}

export function registerMidiTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[PC sim | ESP HW] Send MIDI. target='device' talks to a connected CrossPad through the crosspad-hil daemon:\n" +
        "  • action='note'        → note on/off (on, note, vel?, channel?, role?)\n" +
        "  • action='sysex'       → one raw frame (frame='F0 7D … F7', role?). Manufacturer 0x7D is CrossPad's.\n" +
        "  • action='echo_rtt'    → n? echo frames, returns {sent, received, lost, rtt_ms:{p50,p90,max}}\n" +
        "  • action='query_route' → the audio routing state (same data crosspad_audio_route action='query' returns)\n" +
        "  role='esp' (default) is the ESP's native USB MIDI — the ONLY port that answers queries; role='stm' is the STM32 bridge port.\n" +
        "target='sim' drives the running PC simulator over TCP RemoteControl: type='note_on'|'note_off' need `note` " +
        "(velocity defaults 127/0); type='cc' and 'program_change' are NOT implemented by the sim and fail fast. " +
        "USB profile switches go through crosspad_usb_mode, not a hand-built 0x1B frame.",
      inputSchema: MidiInput,
      outputSchema: O_Midi,
      annotations: annotationsFor(tierOf(TOOL_NAME, { target: "device", action: "note" })),
    },
    async (rawArgs, extra) => {
      const args = MidiInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summarizeMidi(args));
        if (c.status === "token") return c.result;
        if (c.status === "declined") {
          return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: `${TOOL_NAME} was declined by the user.` } });
        }
      }
      if (args.target === "sim") return runSim(args);
      try {
        const call = toMidiOp(args);
        const opArgs: Record<string, unknown> = { ...call.args };
        if (args.device !== undefined) opArgs.device = args.device;
        const result = await ctx.daemon().request<unknown>(call.op, opArgs, { signal: extra.signal, timeoutMs: 30_000 });
        return jsonResponse({
          success: true,
          target: "device",
          action: args.action,
          device: args.device,
          role: args.role ?? "esp",
          result,
          ts: Date.now(),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
```

- [ ] **Step 8: Run the MIDI tests**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/midi.device.test.ts src/tools/midi.test.ts`
Expected: PASS — 11 new tests plus the existing `midi.test.ts` suite unchanged (the sim helper it covers was not touched).

- [ ] **Step 9: Write the failing USB-mode and tier tests**

`/home/matixan/GIT/crosspad-mcp/src/tools/usb-mode.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerUsbModeTool, usbModeRow, TOOL_NAME } from "./usb-mode.js";
import { tierOf } from "../policy/tiers.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";
import { jobs } from "../tasks.js";
import { handles } from "../handles.js";

const STRICT: Policy = { mode: "strict", rules: [] };
const ctxFor = (d: ReturnType<typeof fakeDaemon>): ToolContext => ({ daemon: () => d, policy: STRICT, jobs, handles });

const port = (path: string, vid = 0x303a, pid = 0x3456) => ({ path, vid, pid, serial: null, product: null, location: "1-1.2" });

const DEFAULT_MODE = {
  id: "dev_3f2a", serial: "AABB", usb_mode: "default", board_rev: "v2",
  ports: {
    cdc: port("/dev/ttyACM0"),
    console: port("/dev/ttyACM1", 0x0483, 0x5740),
    esp_midi: { name: "Crosspad", rtmidi_out: 1, rtmidi_in: 1, alsa_hw: "hw:4,0,0", rawmidi: null },
    stm_midi: null, uac2: null, bootloader: null,
  },
};
const AUDIO_MODE = {
  ...DEFAULT_MODE,
  usb_mode: "audio",
  ports: { ...DEFAULT_MODE.ports, cdc: null, uac2: { name: "Crosspad Audio", sounddevice_index: 3, alsa_id: "hw:4" } },
};

describe("usbModeRow", () => {
  it("flattens the ports a mode switch changes", () => {
    expect(usbModeRow(DEFAULT_MODE as never)).toEqual({
      device: "dev_3f2a", usb_mode: "default", cdc: "/dev/ttyACM0", console: "/dev/ttyACM1",
      uac2: null, esp_midi: "hw:4,0,0", board_rev: "v2",
    });
    expect(usbModeRow(AUDIO_MODE as never)).toMatchObject({ usb_mode: "audio", cdc: null, uac2: "Crosspad Audio" });
  });
});

describe("crosspad_usb_mode", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); });

  it("action=get reads devices.list and never writes", async () => {
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEFAULT_MODE] }) });
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "get" }, fakeExtra());
    expect(d.calls.map((c) => c.op)).toEqual(["devices.list"]);
    expect(r.structuredContent).toMatchObject({ success: true, action: "get", mode: "default", device: "dev_3f2a" });
    expect((r.structuredContent as { ports: Record<string, unknown> }).ports).toMatchObject({ cdc: "/dev/ttyACM0", uac2: null });
  });

  it("action=get with several devices and no `device` says which ids exist", async () => {
    const other = { ...DEFAULT_MODE, id: "dev_7c01" };
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEFAULT_MODE, other] }) });
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "get" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "AMBIGUOUS_DEVICE" });
    expect((r.structuredContent as { details: { candidates: string[] } }).details.candidates).toEqual(["dev_3f2a", "dev_7c01"]);
  });

  it("action=set forwards mode and wait to usbmode.set and reports the refreshed device", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEFAULT_MODE] }),
      "usbmode.set": () => AUDIO_MODE,
    });
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "set", mode: "audio", device: "dev_3f2a" }, fakeExtra());
    expect(d.calls.map((c) => c.op)).toEqual(["usbmode.set"]);
    expect(d.calls[0].args).toEqual({ device: "dev_3f2a", mode: "audio", wait: true });
    expect(r.structuredContent).toMatchObject({ success: true, action: "set", mode: "audio", device: "dev_3f2a" });
    expect((r.structuredContent as { ports: Record<string, unknown> }).ports).toMatchObject({ cdc: null, uac2: "Crosspad Audio" });
  });

  it("action=set honours wait=false", async () => {
    const d = fakeDaemon({ "usbmode.set": () => ({ ...DEFAULT_MODE, usb_mode: "unknown" }) });
    registerUsbModeTool(fs.server, ctxFor(d));
    await fs.tools.get(TOOL_NAME)!.cb({ action: "set", mode: "default", device: "dev_3f2a", wait: false }, fakeExtra());
    expect(d.calls[0].args).toEqual({ device: "dev_3f2a", mode: "default", wait: false });
  });

  it("action=set without mode is refused before the daemon is touched", async () => {
    const d = fakeDaemon({});
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "set" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "BAD_ARGS" });
    expect(d.calls).toHaveLength(0);
  });

  it("a daemon TIMEOUT keeps its code and hint", async () => {
    const { HilError } = await import("../hil/daemon.js");
    const d = fakeDaemon({ "usbmode.set": () => { throw new HilError("TIMEOUT", "device did not re-enumerate as audio within 20.0 s", "unplug/replug, then crosspad_devices"); } });
    registerUsbModeTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ action: "set", mode: "audio", device: "dev_3f2a" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "TIMEOUT" });
  });
});

describe("crosspad_usb_mode tier", () => {
  it("get is read, set is stimulus", () => {
    expect(tierOf("crosspad_usb_mode", { action: "get" })).toBe("read");
    expect(tierOf("crosspad_usb_mode", { action: "set", mode: "audio" })).toBe("stimulus");
    expect(tierOf("crosspad_usb_mode", {})).toBe("stimulus");
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/usb-mode.test.ts`
Expected: FAIL with `Failed to load url ./usb-mode.js (resolved id: ./usb-mode.js)`.

- [ ] **Step 11: Write `src/tools/usb-mode.ts` and adjust the tier**

`/home/matixan/GIT/crosspad-mcp/src/tools/usb-mode.ts`:

```ts
// src/tools/usb-mode.ts — crosspad_usb_mode: read or switch the USB profile.
// "default" is MIDI+CDC (the control port every hil_* script needs); "audio" is
// MIDI+UAC2, which has NO CDC at all — every crosspad_cdc call fails with
// NO_CDC_IN_AUDIO_MODE until the device is switched back. The switch is a
// SysEx (0x1B) plus a re-enumeration wait, both owned by usbmode.py; this tool
// only names the device and reports which ports came back.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DeviceSchema, type Device } from "../hil/schemas.js";
import { HilError } from "../hil/daemon.js";
import { listHilDevices, pickDevice } from "../hil/select.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError } from "../tool-result.js";

export const TOOL_NAME = "crosspad_usb_mode";

export const UsbModeInput = z.object({
  action: z.enum(["get", "set"]).describe("'get' reads the current profile from devices.list; 'set' switches it."),
  device: z.string().min(1).optional().describe("Device id (dev_xxxx) or one of its port paths; omit when exactly one CrossPad is connected."),
  mode: z.enum(["default", "audio"]).optional()
    .describe("Required for action='set'. 'default' = MIDI + CDC (control port available); 'audio' = MIDI + UAC2 (NO CDC — crosspad_cdc stops working until you switch back)."),
  wait: z.boolean().optional()
    .describe("action='set': wait for the device to re-enumerate in the new profile before returning (default true). false returns immediately and the reported ports are the pre-switch ones."),
});
export type UsbModeArgs = z.infer<typeof UsbModeInput>;

export const O_UsbMode = {
  success: z.boolean(),
  action: z.enum(["get", "set"]).optional(),
  device: z.string().optional(),
  mode: z.string().optional(),
  requested_mode: z.string().optional(),
  ports: z.object({
    device: z.string(),
    usb_mode: z.string(),
    cdc: z.string().nullable(),
    console: z.string().nullable(),
    uac2: z.string().nullable(),
    esp_midi: z.string().nullable(),
    board_rev: z.string().nullable(),
  }).optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/** The ports a profile switch actually changes, flattened for the model. */
export function usbModeRow(d: Device): {
  device: string; usb_mode: string; cdc: string | null; console: string | null;
  uac2: string | null; esp_midi: string | null; board_rev: string | null;
} {
  return {
    device: d.id,
    usb_mode: d.usb_mode,
    cdc: d.ports.cdc?.path ?? null,
    console: d.ports.console?.path ?? null,
    uac2: d.ports.uac2?.name ?? null,
    esp_midi: d.ports.esp_midi?.alsa_hw ?? d.ports.esp_midi?.name ?? null,
    board_rev: d.board_rev ?? null,
  };
}

export function registerUsbModeTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] Read or switch the CrossPad's USB profile through the crosspad-hil daemon.\n" +
        "  • action='get' → the current profile and the ports that exist in it (cdc, console, uac2, esp_midi). Pure read.\n" +
        "  • action='set' with mode='default' → MIDI + CDC: the control port every crosspad_cdc / crosspad_console call needs.\n" +
        "  • action='set' with mode='audio'   → MIDI + UAC2 capture: there is NO CDC in this profile, so crosspad_cdc fails with " +
        "NO_CDC_IN_AUDIO_MODE until you switch back. The STM32 bridge console survives both profiles — read logs there.\n" +
        "wait=true (default) blocks until the device re-enumerates in the new profile and reports the refreshed ports.",
      inputSchema: UsbModeInput,
      outputSchema: O_UsbMode,
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "set" })),
    },
    async (rawArgs, extra) => {
      const args = UsbModeInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} ${args.action} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const summary = args.action === "get"
          ? `read the USB profile of ${args.device ?? "the only CrossPad"}`
          : `switch ${args.device ?? "the only CrossPad"} to USB profile "${args.mode}"`;
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summary);
        if (c.status === "token") return c.result;
        if (c.status === "declined") {
          return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: `${TOOL_NAME} was declined by the user.` } });
        }
      }
      try {
        if (args.action === "get") {
          const devices = await listHilDevices(ctx.daemon(), extra.signal);
          const d = pickDevice(devices, args.device);
          return jsonResponse({ success: true, action: "get", device: d.id, mode: d.usb_mode, ports: usbModeRow(d), ts: Date.now() });
        }
        if (args.mode === undefined) {
          throw new HilError("BAD_ARGS", "action='set' requires 'mode' ('default' or 'audio')", "action='get' reads the current profile without changing it");
        }
        const opArgs: Record<string, unknown> = { mode: args.mode, wait: args.wait ?? true };
        if (args.device !== undefined) opArgs.device = args.device;
        const refreshed = DeviceSchema.parse(
          await ctx.daemon().request<unknown>("usbmode.set", opArgs, { signal: extra.signal, timeoutMs: 45_000 }),
        );
        return jsonResponse({
          success: true,
          action: "set",
          device: refreshed.id,
          requested_mode: args.mode,
          mode: refreshed.usb_mode,
          ports: usbModeRow(refreshed),
          ts: Date.now(),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
```

In `/home/matixan/GIT/crosspad-mcp/src/policy/tiers.ts`, add this line directly after `const audioRouteTier: TierFn = …`:

```ts
// action='get' is a devices.list read — it must stay reachable under --read-only.
const usbModeTier: TierFn = (args) => (str(args, "action") === "get" ? "read" : "stimulus");
```

and change the `TOOL_TIERS` entry from `crosspad_usb_mode: "stimulus",` to:

```ts
  crosspad_usb_mode: usbModeTier,
```

- [ ] **Step 12: Run the USB-mode and policy tests**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/usb-mode.test.ts src/policy`
Expected: PASS — 7 new tests, and Task 3's `tiers.test.ts` / `policy.test.ts` / `confirm.test.ts` still green (they only assert `TOOL_TIERS.crosspad_usb_mode` is defined).

- [ ] **Step 13: Write the failing audio-route test**

In `/home/matixan/GIT/crosspad-mcp/src/tools/audio-route.test.ts`, change line 2 to:

```ts
import { buildSetFrames, hexFrame, stateFromQuery, crosspadAudioRouteSet, crosspadAudioRouteQuery } from "./audio-route.js";
```

and replace the `describe("decodeState", …)` block (lines 47–70) with:

```ts
  describe("hexFrame", () => {
    it("renders a frame as uppercase space-separated bytes", () => {
      expect(hexFrame([0xf0, 0x7d, 0x1d, 0x01, 1, 2, 0xf7])).toBe("F0 7D 1D 01 01 02 F7");
    });
  });

  describe("stateFromQuery", () => {
    it("decodes the hardware-verified reply of midi.query_route", () => {
      expect(stateFromQuery({ mic_src: 0, adc: [2, 0], out: [3, 3], vol: [80, 80], mute: [0, 0] })).toEqual({
        mic_src: 0,
        adc_input: ["line2", "diff"],
        dac_output: ["all", "all"],
        volume: [80, 80],
        mute: [false, false],
      });
    });

    it("decodes the DAC→ADC loop state", () => {
      expect(stateFromQuery({ mic_src: 1, adc: [1, 1], out: [1, 2], vol: [100, 65], mute: [0, 1] })).toEqual({
        mic_src: 1,
        adc_input: ["line1", "line1"],
        dac_output: ["line1", "line2"],
        volume: [100, 65],
        mute: [false, true],
      });
    });

    it("falls back to safe names on an out-of-range code rather than throwing", () => {
      expect(stateFromQuery({ mic_src: 0, adc: [9, 9], out: [9, 9], vol: [0, 0], mute: [true, false] })).toEqual({
        mic_src: 0,
        adc_input: ["diff", "diff"],
        dac_output: ["all", "all"],
        volume: [0, 0],
        mute: [true, false],
      });
    });
  });

  describe("crosspadAudioRouteSet over the daemon", () => {
    const DEV = {
      id: "dev_3f2a", serial: "AABB", usb_mode: "default", board_rev: "v2",
      ports: {
        cdc: { path: "/dev/ttyACM0", vid: 0x303a, pid: 0x3456, serial: null, product: null, location: "1-1.2" },
        console: null,
        esp_midi: { name: "Crosspad", rtmidi_out: 1, rtmidi_in: 1, alsa_hw: "hw:4,0,0", rawmidi: null },
        stm_midi: null, uac2: null, bootloader: null,
      },
    };

    it("sends one midi.sysex per frame and reports them as hex", async () => {
      const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
      const daemon = {
        async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
          calls.push({ op, args });
          return (op === "devices.list" ? { devices: [DEV] } : { sent: 7 }) as unknown as T;
        },
      };
      const r = await crosspadAudioRouteSet(daemon, undefined, { codec: 1, adc_input: "line1", volume: 90 });
      expect(r.success).toBe(true);
      expect(r.sent).toEqual(["F0 7D 1D 01 01 01 F7", "F0 7D 1D 04 01 5A F7"]);
      expect(r.port).toBe("hw:4,0,0");
      expect(calls.map((c) => c.op)).toEqual(["devices.list", "midi.sysex", "midi.sysex"]);
      expect(calls[1].args).toEqual({ device: "dev_3f2a", frame: "F0 7D 1D 01 01 01 F7" });
    });

    it("refuses an invalid set before contacting the daemon", async () => {
      const daemon = { async request<T>(): Promise<T> { throw new Error("must not be called"); } };
      const r = await crosspadAudioRouteSet(daemon, undefined, { adc_input: "diff" });
      expect(r.success).toBe(false);
      expect(r.error).toContain("codec");
    });

    it("reports which frames made it out when a later one fails", async () => {
      const { HilError } = await import("../hil/daemon.js");
      let n = 0;
      const daemon = {
        async request<T>(op: string): Promise<T> {
          if (op === "devices.list") return { devices: [DEV] } as unknown as T;
          if (n++ === 1) throw new HilError("PORT_BUSY", "MIDI out busy");
          return { sent: 7 } as unknown as T;
        },
      };
      const r = await crosspadAudioRouteSet(daemon, undefined, { codec: 0, adc_input: "line2", volume: 50 });
      expect(r.success).toBe(false);
      expect(r.sent).toEqual(["F0 7D 1D 01 00 02 F7"]);
      expect(r.error).toContain("PORT_BUSY");
    });
  });

  describe("crosspadAudioRouteQuery over the daemon", () => {
    const DEV = {
      id: "dev_3f2a", serial: "AABB", usb_mode: "default", board_rev: null,
      ports: {
        cdc: { path: "/dev/ttyACM0", vid: 0x303a, pid: 0x3456, serial: null, product: null, location: "1-1.2" },
        console: null,
        esp_midi: { name: "Crosspad", rtmidi_out: 1, rtmidi_in: 1, alsa_hw: null, rawmidi: null },
        stm_midi: null, uac2: null, bootloader: null,
      },
    };

    it("returns the v9 state shape from midi.query_route", async () => {
      const daemon = {
        async request<T>(op: string): Promise<T> {
          if (op === "devices.list") return { devices: [DEV] } as unknown as T;
          return { mic_src: 1, adc: [1, 1], out: [1, 1], vol: [100, 100], mute: [0, 0] } as unknown as T;
        },
      };
      const r = await crosspadAudioRouteQuery(daemon, "dev_3f2a");
      expect(r).toEqual({
        success: true,
        port: "Crosspad",
        state: { mic_src: 1, adc_input: ["line1", "line1"], dac_output: ["line1", "line1"], volume: [100, 100], mute: [false, false] },
      });
    });

    it("a daemon TIMEOUT becomes a readable error string, not a throw", async () => {
      const { HilError } = await import("../hil/daemon.js");
      const daemon = {
        async request<T>(op: string): Promise<T> {
          if (op === "devices.list") return { devices: [DEV] } as unknown as T;
          throw new HilError("TIMEOUT", "no query reply within 1.0 s", "is the firmware built with audio_route_control?");
        },
      };
      const r = await crosspadAudioRouteQuery(daemon, undefined);
      expect(r.success).toBe(false);
      expect(r.error).toContain("TIMEOUT");
      expect(r.error).toContain("audio_route_control");
    });
  });
```

- [ ] **Step 14: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/audio-route.test.ts`
Expected: FAIL with `SyntaxError: The requested module './audio-route.js' does not provide an export named 'hexFrame'`.

- [ ] **Step 15: Rewrite `src/tools/audio-route.ts`**

Whole file:

```ts
/**
 * Runtime audio routing control for CrossPad hardware over USB MIDI SysEx.
 *
 * Speaks CROSSPAD_CMD_AUDIO_ROUTE (0x1D) from crosspad-core's SysEx protocol
 * (handled by platform-idf main/audio_route_control.cpp): per-codec ADC input,
 * USB-mic capture source, DAC output route, volume, mute, and a state query.
 *
 * Transport (v10): the crosspad-hil daemon — `midi.sysex` for each set frame,
 * `midi.query_route` for the read-back. The daemon owns port discovery and the
 * reply parse, so this module no longer shells out to `amidi` and no longer
 * decodes raw bytes; that also makes it work on Windows and macOS, where the
 * old ALSA-only path could not run at all. Frame construction stays here
 * because it is the part worth unit-testing without a device.
 */

import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HilError } from "../hil/daemon.js";
import { listHilDevices, pickDevice, type DaemonRequester } from "../hil/select.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse } from "../tool-result.js";

export type { DaemonRequester };

export type AdcInput = "diff" | "line1" | "line2";
export type DacOutput = "line1" | "line2" | "all";

export interface AudioRouteSetParams {
  codec?: 0 | 1;
  adc_input?: AdcInput;
  mic_src?: 0 | 1;
  dac_output?: DacOutput;
  volume?: number;
  mute?: boolean;
}

export interface AudioRouteState {
  mic_src: number;
  adc_input: [AdcInput, AdcInput];
  dac_output: [DacOutput, DacOutput];
  volume: [number, number];
  mute: [boolean, boolean];
}

export interface AudioRouteResult {
  success: boolean;
  sent?: string[];
  state?: AudioRouteState;
  port?: string;
  error?: string;
}

const ADC_CODE: Record<AdcInput, number> = { diff: 0, line1: 1, line2: 2 };
const ADC_NAME: AdcInput[] = ["diff", "line1", "line2"];
const DAC_CODE: Record<DacOutput, number> = { line1: 1, line2: 2, all: 3 };
const DAC_NAME: DacOutput[] = ["all", "line1", "line2", "all"]; // 1-based codes; 0 unused

export const TOOL_NAME = "crosspad_audio_route";

/** One SysEx frame as the daemon's `frame` argument wants it: "F0 7D 1D 01 00 02 F7". */
export function hexFrame(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

/** Build the SysEx frames for a set request (exported for tests). */
export function buildSetFrames(p: AudioRouteSetParams): { frames: number[][]; error?: string } {
  const frames: number[][] = [];
  const needsCodec = p.adc_input !== undefined || p.dac_output !== undefined ||
                     p.volume !== undefined || p.mute !== undefined;
  if (needsCodec && p.codec === undefined) {
    return { frames, error: "Field 'codec' (0|1) is required for adc_input/dac_output/volume/mute." };
  }
  const wrap = (body: number[]) => [0xf0, 0x7d, 0x1d, ...body, 0xf7];
  if (p.adc_input !== undefined) frames.push(wrap([0x01, p.codec!, ADC_CODE[p.adc_input]]));
  if (p.mic_src !== undefined) frames.push(wrap([0x02, p.mic_src]));
  if (p.dac_output !== undefined) frames.push(wrap([0x03, p.codec!, DAC_CODE[p.dac_output]]));
  if (p.volume !== undefined) {
    if (p.volume < 0 || p.volume > 100) return { frames, error: "volume must be 0-100" };
    frames.push(wrap([0x04, p.codec!, p.volume]));
  }
  if (p.mute !== undefined) frames.push(wrap([0x05, p.codec!, p.mute ? 1 : 0]));
  if (frames.length === 0) return { frames, error: "Nothing to set — pass at least one of adc_input/mic_src/dac_output/volume/mute." };
  return { frames };
}

/** midi.py parse_query_reply() dict → the v9 state shape this tool has always returned. */
export function stateFromQuery(q: Record<string, unknown>): AudioRouteState {
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => Number(x)) : []);
  const adc = nums(q.adc);
  const out = nums(q.out);
  const vol = nums(q.vol);
  const mute = Array.isArray(q.mute) ? (q.mute as unknown[]) : [];
  const truthy = (v: unknown): boolean => v === true || Number(v) !== 0;
  return {
    mic_src: Number(q.mic_src ?? 0),
    adc_input: [ADC_NAME[adc[0]] ?? "diff", ADC_NAME[adc[1]] ?? "diff"],
    dac_output: [DAC_NAME[out[0]] ?? "all", DAC_NAME[out[1]] ?? "all"],
    volume: [vol[0] ?? 0, vol[1] ?? 0],
    mute: [truthy(mute[0]), truthy(mute[1])],
  };
}

function describeError(e: unknown): string {
  if (e instanceof HilError) return e.hint ? `${e.code}: ${e.message} — ${e.hint}` : `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** The MIDI endpoint the frames leave by, for the `port` field of the result. */
async function resolvePort(
  daemon: DaemonRequester,
  device: string | undefined,
  signal?: AbortSignal,
): Promise<{ id: string; port: string | undefined }> {
  const devices = await listHilDevices(daemon, signal);
  const d = pickDevice(devices, device);
  return { id: d.id, port: d.ports.esp_midi?.alsa_hw ?? d.ports.esp_midi?.name ?? undefined };
}

export async function crosspadAudioRouteSet(
  daemon: DaemonRequester,
  device: string | undefined,
  params: AudioRouteSetParams,
  signal?: AbortSignal,
): Promise<AudioRouteResult> {
  const { frames, error } = buildSetFrames(params);
  if (error) return { success: false, error };
  let target: { id: string; port: string | undefined };
  try {
    target = await resolvePort(daemon, device, signal);
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
  const sent: string[] = [];
  for (const frame of frames) {
    const f = hexFrame(frame);
    try {
      await daemon.request("midi.sysex", { device: target.id, frame: f }, signal ? { signal } : undefined);
    } catch (e) {
      return { success: false, sent, port: target.port, error: `SysEx send failed: ${describeError(e)}` };
    }
    sent.push(f);
  }
  return { success: true, sent, port: target.port };
}

export async function crosspadAudioRouteQuery(
  daemon: DaemonRequester,
  device: string | undefined,
  signal?: AbortSignal,
): Promise<AudioRouteResult> {
  let target: { id: string; port: string | undefined };
  try {
    target = await resolvePort(daemon, device, signal);
  } catch (e) {
    return { success: false, error: describeError(e) };
  }
  try {
    const q = await daemon.request<Record<string, unknown>>("midi.query_route", { device: target.id }, signal ? { signal } : undefined);
    return { success: true, port: target.port, state: stateFromQuery(q) };
  } catch (e) {
    return { success: false, port: target.port, error: describeError(e) };
  }
}

export const AudioRouteInput = z.object({
  action: z.enum(["set", "query"]).describe("'set' applies routing changes; 'query' reads the current state."),
  device: z.string().min(1).optional()
    .describe("Device id (dev_xxxx) or one of its port paths; omit when exactly one CrossPad is connected."),
  codec: z.union([z.literal(0), z.literal(1)]).optional()
    .describe("Target codec for adc_input/dac_output/volume/mute (0 = stock mic path, 1 = PCB-loopback codec)."),
  adc_input: z.enum(["diff", "line1", "line2"]).optional()
    .describe("ADC input mux of `codec`: differential, LINE1 (PCB loop on both codecs) or LINE2 (built-in mics on codec 0, jack on codec 1)."),
  mic_src: z.union([z.literal(0), z.literal(1)]).optional()
    .describe("Which codec feeds the USB mic path."),
  dac_output: z.enum(["line1", "line2", "all"]).optional()
    .describe("DAC output route of `codec`."),
  volume: z.number().int().min(0).max(100).optional().describe("Codec output volume 0-100."),
  mute: z.boolean().optional().describe("Codec output mute."),
});
export type AudioRouteArgs = z.infer<typeof AudioRouteInput>;

export const O_AudioRoute = {
  success: z.boolean(),
  sent: z.array(z.string()).optional(),
  state: z.object({
    mic_src: z.number().int(),
    adc_input: z.array(z.enum(["diff", "line1", "line2"])).length(2),
    dac_output: z.array(z.enum(["line1", "line2", "all"])).length(2),
    volume: z.array(z.number().int()).length(2),
    mute: z.array(z.boolean()).length(2),
  }).optional(),
  port: z.string().optional(),
  error: z.union([
    z.string(),
    z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
  ]).optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
};

export function registerAudioRouteTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] Runtime audio routing on a connected CrossPad, over USB MIDI SysEx " +
        "(CROSSPAD_CMD_AUDIO_ROUTE 0x1D) through the crosspad-hil daemon. Works in both USB profiles.\n" +
        "  • action='query' → read back the full routing state (mic_src, ADC inputs, DAC outputs, volumes, mutes).\n" +
        "  • action='set'   → apply any subset of: adc_input ('diff'|'line1'|'line2'), mic_src (0|1), " +
        "dac_output ('line1'|'line2'|'all'), volume (0-100), mute. Per-codec fields need `codec` (0|1).\n" +
        "Notes: codec0 LINE2 is the built-in mics; every other input is the DAC→ADC loop, and codec1 LINE1 is the " +
        "near-unity path with the better SNR (compresses above ~0.2 FS input). Routing reverts to firmware defaults " +
        "on device reset — only the named preset is persisted, by the firmware, not by this tool.",
      inputSchema: AudioRouteInput,
      outputSchema: O_AudioRoute,
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "set" })),
    },
    async (rawArgs, extra) => {
      const args = AudioRouteInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} ${args.action} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const summary = args.action === "query"
          ? `read the audio routing of ${args.device ?? "the only CrossPad"}`
          : `change the audio routing of ${args.device ?? "the only CrossPad"}`;
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summary);
        if (c.status === "token") return c.result;
        if (c.status === "declined") {
          return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: `${TOOL_NAME} was declined by the user.` } });
        }
      }
      const daemon = ctx.daemon();
      if (args.action === "query") {
        return jsonResponse({ ...(await crosspadAudioRouteQuery(daemon, args.device, extra.signal)) });
      }
      return jsonResponse({
        ...(await crosspadAudioRouteSet(daemon, args.device, {
          codec: args.codec,
          adc_input: args.adc_input,
          mic_src: args.mic_src,
          dac_output: args.dac_output,
          volume: args.volume,
          mute: args.mute,
        }, extra.signal)),
      });
    },
  );
}
```

- [ ] **Step 16: Run the audio-route tests**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/audio-route.test.ts`
Expected: PASS — the 5 untouched `buildSetFrames` tests plus 9 new ones (hexFrame 1, stateFromQuery 3, set 3, query 2).

- [ ] **Step 17: Wire the three tools into `src/registry.ts` and drop the legacy blocks**

In `registerAll`, after the `crosspad_ui` line of the device block:

```ts
  manager.register("crosspad_midi",        registerMidiTool(server, ctx),       "device");
  registered.add("crosspad_midi");
  manager.register("crosspad_usb_mode",    registerUsbModeTool(server, ctx),    "device");
  registered.add("crosspad_usb_mode");
  manager.register("crosspad_audio_route", registerAudioRouteTool(server, ctx), "device");
  registered.add("crosspad_audio_route");
```

with the imports:

```ts
import { registerMidiTool } from "./tools/midi.js";
import { registerUsbModeTool } from "./tools/usb-mode.js";
import { registerAudioRouteTool } from "./tools/audio-route.js";
```

In `src/index.ts`: delete the `SIM — MIDI` banner and its `registerLegacy("crosspad_midi", …)` block (lines 1085–1141); delete the `ESP HW — audio routing (SysEx 0x1D)` banner and its `registerLegacy("crosspad_audio_route", …)` block (lines 1143–1183); delete the now-unused `O_Midi` (lines 352–358) and `O_AudioRoute` (lines 360–372) const blocks; delete the imports `crosspadMidiSend`, `crosspadAudioRouteSet`, `crosspadAudioRouteQuery`.

- [ ] **Step 18: Run the whole suite and the type check**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run && npx tsc --noEmit`
Expected: PASS for every file; `tsc` exits 0 with no output. `src/index.mcp.test.ts` still lists `crosspad_midi` and `crosspad_audio_route` because its `beforeAll` enables every toolset (Task 4) and the `device` toolset now owns them.

- [ ] **Step 19: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add src/hil/select.ts src/hil/select.test.ts src/tools/midi.ts src/tools/midi.device.test.ts src/tools/usb-mode.ts src/tools/usb-mode.test.ts src/tools/audio-route.ts src/tools/audio-route.test.ts src/policy/tiers.ts src/registry.ts src/index.ts && git commit -m "feat(v10): crosspad_midi target=device, crosspad_usb_mode, and audio routing over the hil daemon instead of amidi"
```

---

### Task 9: `crosspad_flash` rewrite — preflight, confirmation, jobs and wait_boot

**Files:**
- Create: `/home/matixan/GIT/crosspad-mcp/src/tools/flash.ts`
- Modify: `/home/matixan/GIT/crosspad-mcp/src/tasks.ts` — extract the poll loop inside `JobRegistry.mirror()` into an exported `pumpDaemonTask`; `mirror()` keeps its signature and behaviour
- Modify: `/home/matixan/GIT/crosspad-mcp/src/registry.ts` — one `manager.register("crosspad_flash", …)` line in the `core` block
- Modify: `/home/matixan/GIT/crosspad-mcp/src/index.ts` — delete the `FLASH` banner and its `registerLegacy("crosspad_flash", …)` block (lines 581–631) and the `O_Flash` const (lines 260–271); delete the `crosspadIdfFlash` / `crosspadIdfOta` / `crosspadStmFlash` imports
- Modify: `/home/matixan/GIT/crosspad-mcp/src/tools/idf-flash.ts` — delete `crosspadIdfOta` (lines 105–184) and the helpers only it used (`extractDetectedPort`, `formatFileSize`); `crosspadIdfFlash` and `extractFlashError` stay
- Modify: `/home/matixan/GIT/crosspad-mcp/src/tools/idf-flash.test.ts` — delete the `crosspadIdfOta` describe block and its import
- Test: `/home/matixan/GIT/crosspad-mcp/src/tasks.pump.test.ts`
- Test: `/home/matixan/GIT/crosspad-mcp/src/tools/flash.preflight.test.ts`
- Test: `/home/matixan/GIT/crosspad-mcp/src/tools/flash.test.ts`

**Interfaces:**

- Consumes:
  - Daemon ops verbatim: `devices.list {}` → `{"devices": [Device.to_dict]}`; `ota.flash {device, firmware, delta_base?, wait_boot?}` → `{"task": "task_N"}`; `task.status {task}` → `{task, status, progress, total, message, result?, error?}`; `task.cancel {task}` → `{"ok"}`; `console.open {device, reset?, log_to?}` → `{"handle","port","log_path"}`; `console.wait_boot {handle, timeout_s?}` → `BootResult` dict; `console.close {handle}` → `{"ok"}`.
  - `listHilDevices`, `pickDevice`, `roleOfPort`, `type DaemonRequester` from `src/hil/select.ts` (Task 8).
  - `BootResultSchema`, `type BootResult`, `type Device` from `src/hil/schemas.ts` (Task 1); `HilError` from `src/hil/daemon.ts` (Task 1).
  - `JobRegistry.create(kind: string, run: JobRun): string`, `JobRegistry.status(id): JobStatus`, `JobRegistry.wait(id, timeoutMs): Promise<JobStatus>`, `type ProgressFn`, `type DaemonLike`, `POLL_INTERVAL_MS`, `TaskStatusSchema` (already imported by `tasks.ts`) from `src/tasks.ts` (Task 2).
  - `ToolContext` from `src/tool-context.ts`; `HandleRegistry.register(handle, {kind, device?})` / `.drop(handle)` / `.list()` from `src/handles.ts` (Task 2).
  - `decide` (Task 3), `tierOf` / `annotationsFor` (Task 3), `requireConfirmation` (Task 3), `jsonResponse` / `toolError` (Task 5).
  - `crosspadIdfFlash(port: string | undefined, onLine?: OnLine, signal?: AbortSignal): Promise<FlashResult>` from `src/tools/idf-flash.ts`; `crosspadStmFlash(method: "swd"|"dfu", buildType: string, firmwarePath: string | undefined, onLine?: OnLine, signal?: AbortSignal): Promise<StmFlashResult>` from `src/tools/stm-flash.ts`; `type OnLine` from `src/utils/exec.ts` (all unchanged — `crosspadIdfFlash` already goes through the argv-only `runIdfArgvStream` and honours `signal`).
  - `CROSSPAD_IDF_ROOT`, `CROSSPAD_STM_ROOT`, `stmArtifact`, `type StmPreset` from `src/config.ts`.
  - `fakeDaemon`, `fakeServer`, `fakeExtra` from `src/testing/` (Task 5).

- Produces:
  - `src/tasks.ts` (added): `export function pumpDaemonTask(daemon: DaemonLike, daemonTask: string, signal: AbortSignal, progress: ProgressFn, pollMs?: number): Promise<unknown>` — polls `task.status` every `pollMs` (default `POLL_INTERVAL_MS`), forwards `task.cancel` once on abort, resolves the daemon task's `result`, rejects with `HilError` on `failed` / `cancelled`. `mirror()` becomes `this.create(kind, (s, p) => pumpDaemonTask(daemon, daemonTask, s, p, pollIntervalMs))` plus the existing `daemonTask` stamp — signature and observable behaviour unchanged.
  - `src/tools/flash.ts`:
    - `export const TOOL_NAME = "crosspad_flash"`
    - `export const SOURCE_SUBDIRS: string[]`
    - `export interface FlashBlocker { code: string; message: string }`
    - `export interface FlashPreflight` (fields listed in the implementation below)
    - `export interface FlashProbe { exists(p: string): Promise<boolean>; mtimeMs(p: string): Promise<number | null>; binVersion(p: string): Promise<string | null>; newestSource(root: string, subdirs: string[]): Promise<{path: string; mtimeMs: number} | null>; buildBoardRev(idfRoot: string, buildDir: string): Promise<string | null> }`
    - `export function realFlashProbe(): FlashProbe`
    - `export function setFlashProbeForTest(p: FlashProbe): void`
    - `export function normalizeRev(s: string | null | undefined): "v1" | "v2" | null`
    - `export async function espPreflight(probe: FlashProbe, device: Device | null, args: {transport: "uart"|"ota"; port?: string; firmware_path?: string; build_dir?: string}, deviceError?: HilError): Promise<FlashPreflight>`
    - `export async function stmPreflight(probe: FlashProbe, args: {method: "swd"|"dfu"; build_type?: string; firmware_path?: string}): Promise<FlashPreflight>`
    - `export function applyForce(pf: FlashPreflight, force: boolean): FlashPreflight`
    - `export async function waitBootOnConsole(daemon: DaemonRequester, device: string, handles: HandleRegistry, timeoutS: number, signal?: AbortSignal): Promise<BootResult>`
    - `export const FlashInput`, `export type FlashArgs`, `export const O_Flash`
    - `export function registerFlashTool(server: McpServer, ctx: ToolContext): RegisteredTool`
  - Blocker codes (`FlashPreflight.blockers[].code`): `NO_BUILD_DIR`, `NO_FIRMWARE`, `NO_DEVICE`, `PORT_ROLE`, `BOARD_REV_MISMATCH`. Tool-level error code on refusal: `PREFLIGHT_BLOCKED`.

Contract choices stated here (the contract and Tasks 1–7 are silent):
- **Board-rev mismatch is a hard blocker**, not a warning. Flashing a rev-v1 binary onto a rev-v2 board gives a board with the wrong pinout — no display, no console, indistinguishable from dead hardware — and the recovery is a UART flash of the right image. `force: true` downgrades it; `PORT_ROLE` is the one blocker `force` cannot clear, because the STM console VCP is not a flash target under any argument.
- **`wait_boot` is done TS-side**, so `ota.flash` is always called with `wait_boot: false`. That gives OTA and UART the identical `console.open` → `console.wait_boot` → `console.close` sequence, one `BootResult` shape either way, and the console handle appears in `ctx.handles` while it is open.
- **One job handle covers flash + boot wait.** `jobs.create("flash", …)` wraps `ota.flash` + `pumpDaemonTask` + the optional boot wait in a single run function, rather than `jobs.mirror()` (which would mint a second handle for the boot wait). `pumpDaemonTask` is factored out of `mirror()` so there is exactly one daemon-task poll loop in the code base.
- **`wait_seconds` (default 0)** keeps the v9 ergonomics: 0 returns the handle immediately, >0 awaits `jobs.wait()` and inlines the terminal `JobStatus`. A `jobs.wait()` timeout is not an error — the job keeps running and the handle is still returned.
- **`dry_run`** returns the preflight and stops *before* the confirmation, so this danger-tier tool can be inspected without minting a token.
- **`target: "stm"` stays on this tool**, delegating to the unchanged `crosspadStmFlash` as a job, with an STM-shaped preflight (firmware existence + mtime; the ESP-only fields are `null` and `notes` says why). Dropping it would have silently removed a documented capability nothing else covers.
- **`crosspadIdfOta` is deleted.** OTA now runs through the daemon's `ota.flash`, and keeping a second, silently divergent OTA implementation (`tools/ota_flash.py` spawned from TS) is exactly the drift this rewrite removes.
- Firmware default is `<build_dir>/CrossPad.bin` with `build_dir` defaulting to `<CROSSPAD_IDF_ROOT>/build` — the same default `idf-flash.ts` used; `build_dir` is an input so the per-revision `build_v1` / `build_v2` dirs are reachable.
- Board rev is read from `<build_dir>/config/sdkconfig.json` key `BSP_BOARD_REV_STR` (verified present in every platform-idf build dir), falling back to `CONFIG_BSP_BOARD_REV_STR="…"` in `<idfRoot>/sdkconfig.v1|.v2|sdkconfig`.

---

- [ ] **Step 1: Write the failing `pumpDaemonTask` test**

`/home/matixan/GIT/crosspad-mcp/src/tasks.pump.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pumpDaemonTask, type DaemonLike, type ProgressFn } from "./tasks.js";
import { HilError } from "./hil/daemon.js";

function scriptedDaemon(statuses: unknown[]): DaemonLike & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let i = 0;
  return {
    calls,
    async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
      calls.push([op, args]);
      if (op === "task.cancel") return { ok: true } as unknown as T;
      return statuses[Math.min(i++, statuses.length - 1)] as T;
    },
  };
}

describe("pumpDaemonTask", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("forwards progress and resolves the daemon result", async () => {
    const d = scriptedDaemon([
      { task: "task_9", status: "working", progress: 4096, total: 1_200_000, message: "0%" },
      { task: "task_9", status: "working", progress: 600_000, total: 1_200_000, message: "50%" },
      { task: "task_9", status: "completed", result: { bytes: 1_200_000, seconds: 9.4, kbps: 128, version: "v20-3f2a", mode: "full" } },
    ]);
    const seen: Array<[number, number | undefined, string]> = [];
    const progress: ProgressFn = (p, t, m) => seen.push([p, t, m]);
    const promise = pumpDaemonTask(d, "task_9", new AbortController().signal, progress, 10);
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toMatchObject({ bytes: 1_200_000, version: "v20-3f2a" });
    expect(seen[0]).toEqual([4096, 1_200_000, "0%"]);
    expect(seen[1]).toEqual([600_000, 1_200_000, "50%"]);
  });

  it("rejects with the daemon's error code when the task fails", async () => {
    const d = scriptedDaemon([{ task: "task_9", status: "failed", error: { code: "FLASH_FAILED", message: "OTA_ERROR at 40%", hint: "retry over UART" } }]);
    const p = pumpDaemonTask(d, "task_9", new AbortController().signal, () => {}, 10);
    await vi.advanceTimersByTimeAsync(20);
    await expect(p).rejects.toMatchObject({ code: "FLASH_FAILED", hint: "retry over UART" });
  });

  it("forwards task.cancel exactly once on abort", async () => {
    const d = scriptedDaemon([
      { task: "task_9", status: "working", progress: 1, total: 2, message: "" },
      { task: "task_9", status: "cancelled" },
    ]);
    const ac = new AbortController();
    const p = pumpDaemonTask(d, "task_9", ac.signal, () => {}, 10);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    ac.abort();
    await vi.advanceTimersByTimeAsync(30);
    await expect(p).rejects.toBeInstanceOf(HilError);
    expect(d.calls.filter(([op]) => op === "task.cancel")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tasks.pump.test.ts`
Expected: FAIL with `SyntaxError: The requested module './tasks.js' does not provide an export named 'pumpDaemonTask'`.

- [ ] **Step 3: Extract `pumpDaemonTask` in `src/tasks.ts`**

Add this function immediately above `export class JobRegistry` (it uses `TaskStatusSchema` and `HilError`, both already imported at the top of the file):

```ts
/**
 * Poll one daemon-side task ("task_N" from ota.flash / scenario.run) to its
 * terminal state, forwarding progress. Abort forwards `task.cancel` once and
 * keeps polling so the daemon's own `cancelled` state is the one observed.
 * Factored out of JobRegistry.mirror() so flash can compose it with a boot
 * wait inside a single job — there is exactly one poll loop in this code base.
 */
export function pumpDaemonTask(
  daemon: DaemonLike,
  daemonTask: string,
  signal: AbortSignal,
  progress: ProgressFn,
  pollMs: number = POLL_INTERVAL_MS,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelSent = false;
    const poll = async (): Promise<void> => {
      let st;
      try {
        st = TaskStatusSchema.parse(await daemon.request("task.status", { task: daemonTask }));
      } catch (e) {
        reject(e);
        return;
      }
      if (typeof st.progress === "number") {
        progress(st.progress, typeof st.total === "number" ? st.total : undefined, st.message ?? "");
      }
      if (st.status === "completed") { resolve(st.result); return; }
      if (st.status === "failed") {
        reject(new HilError(
          st.error?.code ?? "TASK_FAILED",
          st.error?.message ?? `daemon task ${daemonTask} failed`,
          st.error?.hint ?? undefined,
        ));
        return;
      }
      if (st.status === "cancelled") { reject(new HilError("CANCELLED", `daemon task ${daemonTask} cancelled`)); return; }
      timer = setTimeout(() => { void poll(); }, pollMs);
    };
    signal.addEventListener("abort", () => {
      if (cancelSent) return;
      cancelSent = true;
      daemon.request("task.cancel", { task: daemonTask }).catch(() => {});
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      void poll();
    }, { once: true });
    void poll();
  });
}
```

and replace the whole body of `mirror()` with:

```ts
  /** Mirror a daemon task ("task_N" from scenario.run / ota.flash) as a local job. */
  mirror(daemon: DaemonLike, daemonTask: string, kind: string, pollIntervalMs: number = POLL_INTERVAL_MS): string {
    const id = this.create(kind, (signal, progress) => pumpDaemonTask(daemon, daemonTask, signal, progress, pollIntervalMs));
    const job = this.jobs.get(id)!;
    job.status.daemonTask = daemonTask;
    return id;
  }
```

- [ ] **Step 4: Run the task tests**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tasks.pump.test.ts src/tasks.test.ts src/tools/task.test.ts`
Expected: PASS — 3 new tests plus Task 2's suites unchanged (`mirror()` behaviour is identical).

- [ ] **Step 5: Write the failing preflight test**

`/home/matixan/GIT/crosspad-mcp/src/tools/flash.preflight.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { espPreflight, stmPreflight, applyForce, normalizeRev, type FlashProbe } from "./flash.js";
import { HilError } from "../hil/daemon.js";

const port = (path: string, vid = 0x303a, pid = 0x3456) => ({ path, vid, pid, serial: null, product: null, location: "1-1.2" });

const DEV_V2 = {
  id: "dev_3f2a", serial: "AABB", usb_mode: "default" as const, board_rev: "v2",
  ports: { cdc: port("/dev/ttyACM0"), console: port("/dev/ttyACM1", 0x0483, 0x5740), esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
};
const DEV_BOOTLOADER = {
  id: "dev_3f2a", serial: "AABB", usb_mode: "bootloader" as const, board_rev: "v2",
  ports: { cdc: null, console: null, esp_midi: null, stm_midi: null, uac2: null, bootloader: port("/dev/ttyACM0", 0x303a, 0x1001) },
};

/** Probe over an in-memory file table. mtimes are ms since epoch. */
function probeFor(
  files: Record<string, number>,
  opts: { version?: string | null; newest?: { path: string; mtimeMs: number } | null; rev?: string | null } = {},
): FlashProbe {
  return {
    async exists(p) { return p in files; },
    async mtimeMs(p) { return files[p] ?? null; },
    async binVersion() { return opts.version ?? null; },
    async newestSource() { return opts.newest ?? null; },
    async buildBoardRev() { return opts.rev ?? null; },
  };
}

const FW = "/idf/build/CrossPad.bin";
const BUILD = "/idf/build";

describe("normalizeRev", () => {
  it("folds every spelling the two sides use", () => {
    expect(normalizeRev("v2")).toBe("v2");
    expect(normalizeRev("V2")).toBe("v2");
    expect(normalizeRev("2.0")).toBe("v2");
    expect(normalizeRev("rev1")).toBe("v1");
    expect(normalizeRev("1.9")).toBe("v1");
    expect(normalizeRev(null)).toBeNull();
    expect(normalizeRev("v3")).toBeNull();
  });
});

describe("espPreflight", () => {
  it("passes on a fresh matching build and reports every field", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20-3f2a", newest: { path: "/idf/main/main.cpp", mtimeMs: 1000 }, rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.ok).toBe(true);
    expect(pf.blockers).toEqual([]);
    expect(pf).toMatchObject({
      target: "esp", device: "dev_3f2a", usb_mode: "default", transport: "ota",
      firmware_path: FW, firmware_exists: true, firmware_version: "v20-3f2a",
      stale: false, build_board_rev: "v2", device_board_rev: "v2", board_rev_match: true,
      bootloader_pid: false, port: "/dev/ttyACM0", port_role: "cdc",
    });
  });

  it("flags a firmware older than the newest source as stale, but does not block", async () => {
    const probe = probeFor({ [FW]: 1000, [BUILD]: 1000 }, { version: "v20-old", newest: { path: "/idf/components/bsp/crosspad/bsp_imu.cpp", mtimeMs: 5000 }, rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.stale).toBe(true);
    expect(pf.newest_source_path).toContain("bsp_imu.cpp");
    expect(pf.blockers).toEqual([]);
    expect(pf.warnings.join(" ")).toMatch(/older than/);
    expect(pf.ok).toBe(true);
  });

  it("blocks a missing firmware", async () => {
    const probe = probeFor({ [BUILD]: 1 }, { rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.ok).toBe(false);
    expect(pf.blockers.map((b) => b.code)).toEqual(["NO_FIRMWARE"]);
    expect(pf.blockers[0].message).toContain("crosspad_build platform=idf");
  });

  it("blocks a missing build directory", async () => {
    const probe = probeFor({}, {});
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "uart", firmware_path: FW, build_dir: BUILD });
    expect(pf.blockers.map((b) => b.code)).toContain("NO_BUILD_DIR");
  });

  it("refuses the STM console port and names its role", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "uart", port: "/dev/ttyACM1", firmware_path: FW, build_dir: BUILD });
    expect(pf.ok).toBe(false);
    const blocker = pf.blockers.find((b) => b.code === "PORT_ROLE")!;
    expect(blocker.message).toContain("/dev/ttyACM1");
    expect(blocker.message).toContain("console");
    expect(blocker.message).toContain("/dev/ttyACM0");
    expect(pf.port_role).toBe("console");
  });

  it("blocks a board-revision mismatch and says which is which", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v1" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.board_rev_match).toBe(false);
    const blocker = pf.blockers.find((b) => b.code === "BOARD_REV_MISMATCH")!;
    expect(blocker.message).toMatch(/v1/);
    expect(blocker.message).toMatch(/v2/);
  });

  it("warns rather than blocks when either revision is unknown", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: null });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.board_rev_match).toBeNull();
    expect(pf.blockers).toEqual([]);
    expect(pf.warnings.join(" ")).toMatch(/revision/i);
  });

  it("reports a bootloader-PID port and does not warn about download mode", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = await espPreflight(probe, DEV_BOOTLOADER as never, { transport: "uart", firmware_path: FW, build_dir: BUILD });
    expect(pf.bootloader_pid).toBe(true);
    expect(pf.port_role).toBe("bootloader");
    expect(pf.warnings.join(" ")).not.toMatch(/download mode/i);
  });

  it("warns that UART needs download mode when no bootloader port is present", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "uart", firmware_path: FW, build_dir: BUILD });
    expect(pf.warnings.join(" ")).toMatch(/download mode/i);
  });

  it("carries a device-resolution failure into the preflight instead of throwing", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = await espPreflight(probe, null, { transport: "ota", firmware_path: FW, build_dir: BUILD },
      new HilError("NO_DEVICE", "no CrossPad found; is it in bootloader/DFU?", "check the cable"));
    expect(pf.device).toBeNull();
    expect(pf.blockers.map((b) => b.code)).toContain("NO_DEVICE");
    expect(pf.firmware_exists).toBe(true);
  });
});

describe("applyForce", () => {
  it("downgrades every blocker except PORT_ROLE", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v1" });
    const pf = applyForce(await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD }), true);
    expect(pf.ok).toBe(true);
    expect(pf.warnings.join(" ")).toMatch(/forced past/i);
  });

  it("never clears PORT_ROLE", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = applyForce(await espPreflight(probe, DEV_V2 as never, { transport: "uart", port: "/dev/ttyACM1", firmware_path: FW, build_dir: BUILD }), true);
    expect(pf.ok).toBe(false);
    expect(pf.blockers.map((b) => b.code)).toEqual(["PORT_ROLE"]);
  });
});

describe("stmPreflight", () => {
  it("checks the STM binary and marks the ESP-only fields null", async () => {
    const bin = "/stm/build/Debug/CrossPad_STM32_r20.bin";
    const pf = await stmPreflight(probeFor({ [bin]: 4000 }), { method: "swd", firmware_path: bin });
    expect(pf).toMatchObject({ target: "stm", firmware_exists: true, device: null, usb_mode: null, board_rev_match: null });
    expect(pf.ok).toBe(true);
    expect(pf.notes.join(" ")).toMatch(/ST-Link|STM32_Programmer_CLI/);
  });

  it("blocks a missing STM binary", async () => {
    const pf = await stmPreflight(probeFor({}), { method: "dfu" });
    expect(pf.ok).toBe(false);
    expect(pf.blockers.map((b) => b.code)).toEqual(["NO_FIRMWARE"]);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/flash.preflight.test.ts`
Expected: FAIL with `Failed to load url ./flash.js (resolved id: ./flash.js) in /home/matixan/GIT/crosspad-mcp/src/tools/flash.preflight.test.ts`.

- [ ] **Step 7: Write the preflight half of `src/tools/flash.ts`**

Create the file with everything up to (and excluding) the tool section — imports, types, probe, preflight, force, boot wait:

```ts
// src/tools/flash.ts — crosspad_flash: the one danger-tier tool.
//
// Shape: preflight (always returned, even on refusal) → confirmation → a job.
// The preflight exists because every way this call goes wrong is knowable
// before a single byte is written: the wrong port role, a firmware built for
// the other board revision, a binary older than the sources, a device sitting
// in USB-audio mode. Refusing with the reason beats a bricked-looking board.
import fs from "fs";
import path from "path";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HilError } from "../hil/daemon.js";
import { BootResultSchema, type BootResult, type Device } from "../hil/schemas.js";
import { listHilDevices, pickDevice, roleOfPort, type DaemonRequester } from "../hil/select.js";
import type { HandleRegistry } from "../handles.js";
import { pumpDaemonTask, type ProgressFn } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError } from "../tool-result.js";
import { CROSSPAD_IDF_ROOT, CROSSPAD_STM_ROOT, stmArtifact, type StmPreset } from "../config.js";
import { crosspadIdfFlash } from "./idf-flash.js";
import { crosspadStmFlash } from "./stm-flash.js";
import type { OnLine } from "../utils/exec.js";

export const TOOL_NAME = "crosspad_flash";

/** Directories under the IDF project whose mtimes decide whether a build is stale. */
export const SOURCE_SUBDIRS = ["main", "components"];
/** Skipped while walking sources: build outputs and VCS metadata are not sources. */
const SKIP_DIRS = new Set([".git", "managed_components", ".crosspad", "node_modules", "__pycache__"]);
/** Safety valve for the source walk — platform-idf is ~2 000 units, not 200 000 files. */
const MAX_SOURCE_FILES = 40_000;

export interface FlashBlocker { code: string; message: string }

export interface FlashPreflight {
  target: "esp" | "stm";
  transport: string;
  device: string | null;
  usb_mode: string | null;
  port: string | null;
  port_role: "cdc" | "console" | "bootloader" | null;
  bootloader_pid: boolean;
  build_dir: string | null;
  firmware_path: string;
  firmware_exists: boolean;
  firmware_mtime_ms: number | null;
  firmware_version: string | null;
  newest_source_path: string | null;
  newest_source_mtime_ms: number | null;
  stale: boolean;
  build_board_rev: string | null;
  device_board_rev: string | null;
  board_rev_match: boolean | null;
  blockers: FlashBlocker[];
  warnings: string[];
  notes: string[];
  ok: boolean;
}

export interface FlashProbe {
  exists(p: string): Promise<boolean>;
  mtimeMs(p: string): Promise<number | null>;
  /** esp_app_desc_t.version: 32 bytes at file offset 48, NUL-terminated (ota_flash.py). */
  binVersion(p: string): Promise<string | null>;
  newestSource(root: string, subdirs: string[]): Promise<{ path: string; mtimeMs: number } | null>;
  buildBoardRev(idfRoot: string, buildDir: string): Promise<string | null>;
}

export function realFlashProbe(): FlashProbe {
  return {
    async exists(p) {
      try { await fs.promises.access(p); return true; } catch { return false; }
    },
    async mtimeMs(p) {
      try { return (await fs.promises.stat(p)).mtimeMs; } catch { return null; }
    },
    async binVersion(p) {
      let fh: Awaited<ReturnType<typeof fs.promises.open>> | null = null;
      try {
        fh = await fs.promises.open(p, "r");
        const buf = Buffer.alloc(32);
        const { bytesRead } = await fh.read(buf, 0, 32, 48);
        if (bytesRead < 1) return null;
        const nul = buf.indexOf(0);
        const s = buf.subarray(0, nul === -1 ? bytesRead : nul).toString("latin1").trim();
        return s.length > 0 && /^[\x20-\x7e]+$/.test(s) ? s : null;
      } catch {
        return null;
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    },
    async newestSource(root, subdirs) {
      let best: { path: string; mtimeMs: number } | null = null;
      let seen = 0;
      const walk = async (dir: string): Promise<void> => {
        if (seen >= MAX_SOURCE_FILES) return;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (seen >= MAX_SOURCE_FILES) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name) || e.name.startsWith("build")) continue;
            await walk(full);
            continue;
          }
          if (!e.isFile()) continue;
          seen++;
          let m: number;
          try { m = (await fs.promises.stat(full)).mtimeMs; } catch { continue; }
          if (!best || m > best.mtimeMs) best = { path: full, mtimeMs: m };
        }
      };
      for (const sub of subdirs) await walk(path.join(root, sub));
      return best;
    },
    async buildBoardRev(idfRoot, buildDir) {
      try {
        const j = JSON.parse(await fs.promises.readFile(path.join(buildDir, "config", "sdkconfig.json"), "utf-8")) as Record<string, unknown>;
        const s = j.BSP_BOARD_REV_STR;
        if (typeof s === "string" && s.length > 0) return s;
      } catch { /* fall through to the sdkconfig text files */ }
      const base = path.basename(buildDir);
      const suffixes = base === "build_v1" ? [".v1", "", ".v2"] : base === "build_v2" ? [".v2", "", ".v1"] : ["", ".v2", ".v1"];
      for (const suffix of suffixes) {
        try {
          const text = await fs.promises.readFile(path.join(idfRoot, `sdkconfig${suffix}`), "utf-8");
          const m = text.match(/^CONFIG_BSP_BOARD_REV_STR="([^"]+)"/m);
          if (m) return m[1];
        } catch { /* try the next candidate */ }
      }
      return null;
    },
  };
}

/** "v2" / "V2" / "2.0" / "rev2" → "v2"; anything this project does not build → null. */
export function normalizeRev(s: string | null | undefined): "v1" | "v2" | null {
  if (typeof s !== "string") return null;
  const m = s.trim().toLowerCase().match(/(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  if (major === 1) return "v1";
  if (major === 2) return "v2";
  return null;
}

function emptyPreflight(target: "esp" | "stm", transport: string, firmwarePath: string): FlashPreflight {
  return {
    target, transport,
    device: null, usb_mode: null, port: null, port_role: null, bootloader_pid: false,
    build_dir: null,
    firmware_path: firmwarePath, firmware_exists: false, firmware_mtime_ms: null, firmware_version: null,
    newest_source_path: null, newest_source_mtime_ms: null, stale: false,
    build_board_rev: null, device_board_rev: null, board_rev_match: null,
    blockers: [], warnings: [], notes: [], ok: true,
  };
}

export async function espPreflight(
  probe: FlashProbe,
  device: Device | null,
  args: { transport: "uart" | "ota"; port?: string; firmware_path?: string; build_dir?: string },
  deviceError?: HilError,
): Promise<FlashPreflight> {
  const buildDir = args.build_dir ?? path.join(CROSSPAD_IDF_ROOT, "build");
  const firmware = args.firmware_path ?? path.join(buildDir, "CrossPad.bin");
  const pf = emptyPreflight("esp", args.transport, firmware);
  pf.build_dir = buildDir;

  // ── the build ─────────────────────────────────────────────────────────
  if (!(await probe.exists(buildDir))) {
    pf.blockers.push({
      code: "NO_BUILD_DIR",
      message: `No build directory at ${buildDir}. Run crosspad_build platform=idf first (or pass build_dir for a per-revision dir such as build_v1/build_v2).`,
    });
  }
  pf.firmware_exists = await probe.exists(firmware);
  if (!pf.firmware_exists) {
    pf.blockers.push({ code: "NO_FIRMWARE", message: `Firmware not found at ${firmware}. Run crosspad_build platform=idf first.` });
  } else {
    pf.firmware_mtime_ms = await probe.mtimeMs(firmware);
    pf.firmware_version = await probe.binVersion(firmware);
  }
  const newest = await probe.newestSource(CROSSPAD_IDF_ROOT, SOURCE_SUBDIRS);
  if (newest) {
    pf.newest_source_path = newest.path;
    pf.newest_source_mtime_ms = newest.mtimeMs;
    if (pf.firmware_mtime_ms !== null && newest.mtimeMs > pf.firmware_mtime_ms) {
      pf.stale = true;
      pf.warnings.push(`The firmware is older than ${newest.path} — you are about to flash a build from before that edit. Run crosspad_build platform=idf if that is not intended.`);
    }
  }

  // ── the device ────────────────────────────────────────────────────────
  if (!device) {
    pf.blockers.push({
      code: "NO_DEVICE",
      message: deviceError
        ? `${deviceError.message}${deviceError.hint ? ` (${deviceError.hint})` : ""}`
        : "No CrossPad resolved for this flash.",
    });
  } else {
    pf.device = device.id;
    pf.usb_mode = device.usb_mode;
    pf.device_board_rev = device.board_rev ?? null;
    pf.bootloader_pid = !!device.ports.bootloader;
    const requested = args.port;
    if (requested !== undefined) {
      const role = roleOfPort(device, requested);
      pf.port = requested;
      pf.port_role = role;
      if (role === "console") {
        const target = device.ports.bootloader?.path ?? device.ports.cdc?.path;
        pf.blockers.push({
          code: "PORT_ROLE",
          message: `${requested} is this device's STM32 bridge console port (role: console) — it carries the ESP log, not the flash. ` +
            (target
              ? `Pass port=${target} (role: ${device.ports.bootloader ? "bootloader" : "cdc"}) or omit port to let the daemon choose.`
              : "This device currently exposes no ESP-side port to flash; put it in download mode first."),
        });
      } else if (role === null) {
        const known = [device.ports.cdc?.path, device.ports.console?.path, device.ports.bootloader?.path].filter(Boolean).join(", ");
        pf.warnings.push(`${requested} is not one of ${device.id}'s ports (${known || "none"}); flashing it addresses something else.`);
      }
    } else {
      pf.port = device.ports.bootloader?.path ?? device.ports.cdc?.path ?? null;
      pf.port_role = device.ports.bootloader ? "bootloader" : device.ports.cdc ? "cdc" : null;
    }
    if (args.transport === "ota" && device.usb_mode === "audio") {
      pf.notes.push("The device is in USB-audio mode, which has no CDC; ota.flash switches it back to the default profile first.");
    }
    if (args.transport === "uart" && !device.ports.bootloader && device.usb_mode !== "bootloader") {
      pf.warnings.push("No bootloader-PID port is present — the device is not in download mode. idf.py will try the esptool DTR/RTS auto-reset (which the STM32 bridge emulates); if that fails, use transport='ota' or hold the boot button.");
    }
  }

  // ── the revision ──────────────────────────────────────────────────────
  const buildRevRaw = await probe.buildBoardRev(CROSSPAD_IDF_ROOT, buildDir);
  pf.build_board_rev = buildRevRaw;
  const buildRev = normalizeRev(buildRevRaw);
  const devRev = normalizeRev(pf.device_board_rev);
  if (buildRev !== null && devRev !== null) {
    pf.board_rev_match = buildRev === devRev;
    if (!pf.board_rev_match) {
      pf.blockers.push({
        code: "BOARD_REV_MISMATCH",
        message: `The build in ${buildDir} is for board revision ${buildRev}, the device reports ${devRev}. ` +
          "The revisions differ in pinout: flashing the wrong one leaves a board with no display and no console. " +
          `Build with the matching sdkconfig (idf.py -B build_${devRev} -DSDKCONFIG=sdkconfig.${devRev} build), or pass force=true if you know better.`,
      });
    }
  } else {
    pf.board_rev_match = null;
    pf.warnings.push(`Board revision could not be compared (build: ${buildRevRaw ?? "unknown"}, device: ${pf.device_board_rev ?? "unknown"}) — the revision guard is not protecting this flash.`);
  }

  pf.ok = pf.blockers.length === 0;
  return pf;
}

export async function stmPreflight(
  probe: FlashProbe,
  args: { method: "swd" | "dfu"; build_type?: string; firmware_path?: string },
): Promise<FlashPreflight> {
  const preset: StmPreset = args.build_type === "Release" ? "Release" : "Debug";
  const firmware = args.firmware_path ?? stmArtifact(preset, "bin");
  const pf = emptyPreflight("stm", args.method, firmware);
  pf.firmware_exists = await probe.exists(firmware);
  if (!pf.firmware_exists) {
    pf.blockers.push({ code: "NO_FIRMWARE", message: `STM firmware not found at ${firmware}. Run crosspad_build platform=stm first.` });
  } else {
    pf.firmware_mtime_ms = await probe.mtimeMs(firmware);
  }
  const newest = await probe.newestSource(CROSSPAD_STM_ROOT, ["Core", "Drivers"]);
  if (newest) {
    pf.newest_source_path = newest.path;
    pf.newest_source_mtime_ms = newest.mtimeMs;
    if (pf.firmware_mtime_ms !== null && newest.mtimeMs > pf.firmware_mtime_ms) {
      pf.stale = true;
      pf.warnings.push(`The STM binary is older than ${newest.path}.`);
    }
  }
  pf.notes.push(
    args.method === "swd"
      ? "SWD flashing addresses the ST-Link probe, not a serial port — the ESP-side checks (USB mode, port role, board revision) do not apply."
      : "DFU flashing addresses the STM32 system bootloader (hold pad 1 at boot) via STM32_Programmer_CLI — the ESP-side checks do not apply.",
  );
  pf.ok = pf.blockers.length === 0;
  return pf;
}

/** force=true turns every blocker except the port-role refusal into a warning. */
export function applyForce(pf: FlashPreflight, force: boolean): FlashPreflight {
  if (!force) return pf;
  const kept = pf.blockers.filter((b) => b.code === "PORT_ROLE");
  const dropped = pf.blockers.filter((b) => b.code !== "PORT_ROLE");
  return {
    ...pf,
    blockers: kept,
    warnings: [...pf.warnings, ...dropped.map((b) => `forced past ${b.code}: ${b.message}`)],
    ok: kept.length === 0,
  };
}

/** console.open → console.wait_boot → console.close, with the handle tracked while it lives. */
export async function waitBootOnConsole(
  daemon: DaemonRequester,
  device: string,
  handles: HandleRegistry,
  timeoutS: number,
  signal?: AbortSignal,
): Promise<BootResult> {
  const opened = await daemon.request<{ handle: string; port: string; log_path: string | null }>(
    "console.open", { device, reset: false }, signal ? { signal } : undefined,
  );
  handles.register(opened.handle, { kind: "console", device });
  try {
    return BootResultSchema.parse(
      await daemon.request("console.wait_boot", { handle: opened.handle, timeout_s: timeoutS },
        { ...(signal ? { signal } : {}), timeoutMs: timeoutS * 1000 + 15_000 }),
    );
  } finally {
    await daemon.request("console.close", { handle: opened.handle }).catch(() => {});
    handles.drop(opened.handle);
  }
}
```

- [ ] **Step 8: Run the preflight tests**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/flash.preflight.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 9: Write the failing tool test**

`/home/matixan/GIT/crosspad-mcp/src/tools/flash.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerFlashTool, TOOL_NAME, setFlashProbeForTest, type FlashProbe } from "./flash.js";
import { JobRegistry } from "../tasks.js";
import { HandleRegistry } from "../handles.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";

const STRICT: Policy = { mode: "strict", rules: [] };

const port = (path: string, vid = 0x303a, pid = 0x3456) => ({ path, vid, pid, serial: null, product: null, location: "1-1.2" });
const DEV = {
  id: "dev_3f2a", serial: "AABB", usb_mode: "default", board_rev: "v2",
  ports: { cdc: port("/dev/ttyACM0"), console: port("/dev/ttyACM1", 0x0483, 0x5740), esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
};

function goodProbe(over: Partial<FlashProbe> = {}): FlashProbe {
  return {
    async exists() { return true; },
    async mtimeMs() { return 9_000; },
    async binVersion() { return "v20-3f2a"; },
    async newestSource() { return { path: "/idf/main/main.cpp", mtimeMs: 1_000 }; },
    async buildBoardRev() { return "v2"; },
    ...over,
  };
}

function ctxFor(daemon: ReturnType<typeof fakeDaemon>): ToolContext & { jobs: JobRegistry; handles: HandleRegistry } {
  return { daemon: () => daemon, policy: STRICT, jobs: new JobRegistry(), handles: new HandleRegistry() };
}

describe("crosspad_flash", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); setFlashProbeForTest(goodProbe()); });

  it("without a token it returns the confirmation AND the preflight, and writes nothing", async () => {
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.resultType).toBe("confirmation_required");
    expect(sc.confirmation.token).toMatch(/^cfm_/);
    expect(sc.preflight).toMatchObject({ ok: true, device: "dev_3f2a", firmware_version: "v20-3f2a", board_rev_match: true });
    expect(d.calls.map((c) => c.op)).toEqual(["devices.list"]);
  });

  it("a blocked preflight refuses before the confirmation and still returns the preflight", async () => {
    setFlashProbeForTest(goodProbe({ async buildBoardRev() { return "v1"; } }));
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(r.isError).toBe(true);
    expect(sc.error.code).toBe("PREFLIGHT_BLOCKED");
    expect(sc.preflight.blockers.map((b: { code: string }) => b.code)).toEqual(["BOARD_REV_MISMATCH"]);
    expect(sc.resultType).toBeUndefined();
  });

  it("dry_run returns the preflight without minting a token", async () => {
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota", dry_run: true }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc).toMatchObject({ success: true, dry_run: true });
    expect(sc.preflight.ok).toBe(true);
    expect(sc.confirmation).toBeUndefined();
    expect(sc.task).toBeUndefined();
  });

  it("the console port is refused by name and role, and force cannot clear it", async () => {
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "uart", port: "/dev/ttyACM1", force: true, dry_run: true },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.preflight.ok).toBe(false);
    expect(sc.preflight.blockers[0].code).toBe("PORT_ROLE");
    expect(sc.preflight.blockers[0].message).toContain("console");
  });

  it("an approved OTA starts ota.flash, polls it as a job and returns the handle", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEV] }),
      "ota.flash": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "completed", result: { bytes: 1_200_000, seconds: 9.4, kbps: 128, version: "v20-3f2a", mode: "full" } }),
    });
    registerFlashTool(fs.server, ctxFor(d));
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;

    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "ota", confirm_token: token, wait_seconds: 5 },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.success).toBe(true);
    expect(sc.task).toMatch(/^task_\d+$/);
    expect(sc.status.status).toBe("completed");
    expect(sc.status.result.flash).toMatchObject({ bytes: 1_200_000, version: "v20-3f2a" });
    expect(sc.status.result.boot).toBeNull();
    const ota = d.calls.find((c) => c.op === "ota.flash")!;
    expect(ota.args).toMatchObject({ device: "dev_3f2a", wait_boot: false });
    expect(String(ota.args.firmware)).toContain("CrossPad.bin");
  });

  it("wait_boot opens a console, waits, closes it, and returns the BootResult", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEV] }),
      "ota.flash": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "completed", result: { bytes: 10, seconds: 1, kbps: 10, version: "v20", mode: "full" } }),
      "console.open": () => ({ handle: "con_1", port: "/dev/ttyACM1", log_path: "/tmp/console.log" }),
      "console.wait_boot": () => ({ complete: true, missing: [], fatal: [], errors: [], bootloops: 0, seconds: 11.2 }),
      "console.close": () => ({ ok: true }),
    });
    const ctx = ctxFor(d);
    registerFlashTool(fs.server, ctx);
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota", wait_boot: true }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "ota", wait_boot: true, confirm_token: token, wait_seconds: 5 },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status.result.boot).toMatchObject({ complete: true, bootloops: 0, seconds: 11.2 });
    expect(d.calls.map((c) => c.op)).toContain("console.close");
    expect(ctx.handles.list().filter((h) => h.kind === "console")).toHaveLength(0);
  });

  it("wait_seconds=0 returns the handle immediately without a terminal status", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEV] }),
      "ota.flash": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "working", progress: 1, total: 100, message: "1%" }),
    });
    const ctx = ctxFor(d);
    registerFlashTool(fs.server, ctx);
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota", confirm_token: token }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.task).toMatch(/^task_\d+$/);
    expect(sc.status).toBeUndefined();
    expect(sc.hint).toContain("crosspad_task");
    expect(ctx.jobs.status(sc.task).status).toBe("working");
  });

  it("a failed daemon flash surfaces the code on the job, with the preflight still present", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEV] }),
      "ota.flash": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "failed", error: { code: "FLASH_FAILED", message: "OTA_ERROR at 40%" } }),
    });
    registerFlashTool(fs.server, ctxFor(d));
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "ota", confirm_token: token, wait_seconds: 5 },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status.status).toBe("failed");
    expect(sc.status.error.code).toBe("FLASH_FAILED");
    expect(sc.preflight.ok).toBe(true);
  });

  it("UART runs the idf.py argv path as a job and never calls ota.flash", async () => {
    const idf = await import("./idf-flash.js");
    vi.spyOn(idf, "crosspadIdfFlash").mockResolvedValue({
      success: true, method: "uart", port: "/dev/ttyACM0", duration_seconds: 31.2, output_tail: ["Hash of data verified."],
    });
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "uart" }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "uart", confirm_token: token, wait_seconds: 5 },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status.status).toBe("completed");
    expect(sc.status.result.flash).toMatchObject({ method: "uart", port: "/dev/ttyACM0" });
    expect(d.calls.some((c) => c.op === "ota.flash")).toBe(false);
    expect(idf.crosspadIdfFlash).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("target=stm needs a method and never resolves an ESP device", async () => {
    const d = fakeDaemon({});
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "stm", dry_run: true }, fakeExtra());
    expect(r.isError).toBe(true);
    expect((r.structuredContent as Record<string, any>).error.code).toBe("BAD_ARGS");
    expect(d.calls).toHaveLength(0);
  });

  it("target=stm dry_run reports an STM-shaped preflight", async () => {
    const d = fakeDaemon({});
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "stm", method: "swd", dry_run: true }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.preflight).toMatchObject({ target: "stm", transport: "swd", device: null, ok: true });
    expect(d.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/flash.test.ts`
Expected: FAIL with `SyntaxError: The requested module './flash.js' does not provide an export named 'registerFlashTool'`.

- [ ] **Step 11: Append the tool half of `src/tools/flash.ts`**

Append to the file written in Step 7:

```ts
// ═══════════════════════════════════════════════════════════════════════
// The tool
// ═══════════════════════════════════════════════════════════════════════

let activeProbe: FlashProbe = realFlashProbe();
/** @internal vitest only — swap the filesystem probe for an in-memory one. */
export function setFlashProbeForTest(p: FlashProbe): void { activeProbe = p; }

export const FlashInput = z.object({
  target: z.enum(["esp", "stm"]).default("esp")
    .describe("'esp' = ESP32-S3 application firmware (transport uart|ota); 'stm' = STM32G0 bridge firmware via STM32_Programmer_CLI (method swd|dfu)."),
  transport: z.enum(["uart", "ota"]).optional()
    .describe("ESP only. 'ota' streams the binary over USB CDC with the device running (no bootloader mode); 'uart' runs idf.py flash and needs download mode."),
  method: z.enum(["swd", "dfu"]).optional()
    .describe("STM only. 'swd' = ST-Link; 'dfu' = the STM32 system bootloader (hold pad 1 at boot)."),
  device: z.string().min(1).optional()
    .describe("ESP only. Device id (dev_xxxx) or one of its port paths; omit when exactly one CrossPad is connected."),
  port: z.string().min(1).optional()
    .describe("ESP only. Serial port to flash. Omit to let the daemon choose. The STM32 bridge console port is refused — it carries logs, not the flash."),
  build_dir: z.string().min(1).optional()
    .describe("ESP only. Build directory holding the binary and its sdkconfig (default '<idf-root>/build'; per-revision dirs are build_v1 / build_v2)."),
  firmware_path: z.string().min(1).optional()
    .describe("Custom binary. ESP default '<build_dir>/CrossPad.bin'; STM default '<stm-root>/build/<preset>/CrossPad_STM32_r20.bin'."),
  build_type: z.enum(["Debug", "Release", "RelWithDebInfo"]).optional()
    .describe("STM only. Picks the build/<preset> dir for the default binary. Default Debug."),
  delta_base: z.string().min(1).optional()
    .describe("ESP OTA only. Previously flashed binary to diff against — sends a delta instead of the whole image."),
  wait_boot: z.boolean().optional()
    .describe("ESP only. After flashing, open the console and wait for the boot markers; the job result carries a BootResult {complete, missing, fatal, errors, bootloops, seconds}. Default false."),
  boot_timeout_s: z.number().min(5).max(180).optional()
    .describe("wait_boot: how long to wait for a complete boot (default 45, the firmware's own boot budget)."),
  wait_seconds: z.number().min(0).max(900).optional()
    .describe("0 (default) returns the task handle immediately — poll it with crosspad_task. >0 waits that long and inlines the task status; a timeout is not an error, the job keeps running."),
  force: z.boolean().optional()
    .describe("Proceed despite preflight blockers (stale build, board-revision mismatch, missing device). The port-role refusal is never overridden."),
  dry_run: z.boolean().optional()
    .describe("Run the preflight and stop: no confirmation token is minted and nothing is written."),
  confirm_token: z.string().optional()
    .describe("Token from a previous confirmation_required result. Re-issue the identical call with it to proceed."),
});
export type FlashArgs = z.infer<typeof FlashInput>;

export const O_Flash = {
  success: z.boolean(),
  preflight: z.record(z.string(), z.unknown()).optional(),
  task: z.string().optional(),
  status: z.record(z.string(), z.unknown()).optional(),
  target: z.enum(["esp", "stm"]).optional(),
  transport: z.string().optional(),
  device: z.string().optional(),
  firmware_path: z.string().optional(),
  dry_run: z.boolean().optional(),
  hint: z.string().optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

function summarizeFlash(args: FlashArgs, pf: FlashPreflight): string {
  if (args.target === "stm") {
    return `Flash STM32 firmware ${pf.firmware_path} over ${String(args.method).toUpperCase()} — the USB console, CDC and MIDI vanish until it completes.`;
  }
  const rev = pf.build_board_rev ? ` (board rev ${pf.build_board_rev})` : "";
  const ver = pf.firmware_version ? ` version "${pf.firmware_version}"` : "";
  const stale = pf.stale ? " ⚠ this binary is older than the newest source file" : "";
  const warn = pf.warnings.length ? `\nWarnings: ${pf.warnings.join(" | ")}` : "";
  return `Flash ${pf.firmware_path}${ver}${rev} to ${pf.device ?? "the only CrossPad"} over ${String(args.transport).toUpperCase()}` +
    `${pf.port ? ` (${pf.port}, role ${pf.port_role})` : ""}. This overwrites the running firmware.${stale}${warn}`;
}

/** Drain a FlashResult-style onLine stream into the job's progress channel. */
function progressLines(progress: ProgressFn, label: string): OnLine {
  let n = 0;
  return (_stream, line) => { progress(++n, undefined, `${label}: ${line.slice(0, 200)}`); };
}

export function registerFlashTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW | STM HW] Flash firmware. Danger tier: it always runs a preflight first, always returns that preflight " +
        "(refusal included), and needs a confirmation before writing anything.\n" +
        "Preflight reports: the device's USB mode, which role the target port plays (the STM32 bridge console is refused as a " +
        "flash target), the binary's own version string, whether it is older than the newest file under main/ or components/, " +
        "and whether the build's board revision matches the device's — a mismatch is a blocker, because the revisions differ " +
        "in pinout and the wrong image looks like dead hardware.\n" +
        "target='esp': transport='ota' streams over USB CDC with the device running (no bootloader mode); transport='uart' " +
        "runs idf.py flash and needs download mode. wait_boot=true then opens the console and returns a BootResult.\n" +
        "target='stm': method='swd' (ST-Link) or 'dfu' (system bootloader, hold pad 1 at boot).\n" +
        "The flash runs as a job: wait_seconds=0 (default) returns a task handle for crosspad_task; wait_seconds>0 inlines the " +
        "final status. dry_run=true stops after the preflight. force=true overrides every blocker except the port-role refusal.",
      inputSchema: FlashInput,
      outputSchema: O_Flash,
      annotations: annotationsFor(tierOf(TOOL_NAME, {})),
    },
    async (rawArgs, extra) => {
      const args = FlashInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const daemon = ctx.daemon();

      try {
        // ── argument shape ────────────────────────────────────────────
        if (args.target === "stm") {
          if (!args.method) throw new HilError("BAD_ARGS", "target='stm' requires 'method' ('swd' or 'dfu')", "for ESP firmware use target='esp' with transport='uart'|'ota'");
          if (args.transport) throw new HilError("BAD_ARGS", "'transport' is ESP-only; STM uses 'method'");
          if (args.port || args.device) throw new HilError("BAD_ARGS", "'port'/'device' are ESP-only — STM flashing addresses the ST-Link or DFU device");
        } else {
          if (!args.transport) throw new HilError("BAD_ARGS", "target='esp' requires 'transport' ('ota' or 'uart')", "'ota' works with the device running; 'uart' needs download mode");
          if (args.method) throw new HilError("BAD_ARGS", "'method' is STM-only; ESP uses 'transport'");
          if (args.build_type) throw new HilError("BAD_ARGS", "'build_type' is STM-only — the ESP build type comes from sdkconfig");
          if (args.transport === "uart" && args.delta_base) throw new HilError("BAD_ARGS", "'delta_base' is OTA-only");
        }

        // ── preflight (always computed, always returned) ──────────────
        let preflight: FlashPreflight;
        let device: Device | null = null;
        if (args.target === "stm") {
          preflight = await stmPreflight(activeProbe, {
            method: args.method!,
            build_type: args.build_type,
            firmware_path: args.firmware_path,
          });
        } else {
          let deviceError: HilError | undefined;
          try {
            device = pickDevice(await listHilDevices(daemon, extra.signal), args.device);
          } catch (e) {
            deviceError = e instanceof HilError ? e : new HilError("NO_DEVICE", e instanceof Error ? e.message : String(e));
          }
          preflight = await espPreflight(activeProbe, device, {
            transport: args.transport!,
            port: args.port,
            firmware_path: args.firmware_path,
            build_dir: args.build_dir,
          }, deviceError);
        }
        preflight = applyForce(preflight, args.force === true);

        if (args.dry_run === true) {
          return jsonResponse({ success: true, dry_run: true, target: args.target, transport: preflight.transport, preflight, ts: Date.now() });
        }
        if (!preflight.ok) {
          return jsonResponse({
            success: false,
            preflight,
            error: {
              code: "PREFLIGHT_BLOCKED",
              message: preflight.blockers.map((b) => `${b.code}: ${b.message}`).join(" "),
              hint: preflight.blockers.every((b) => b.code === "PORT_ROLE")
                ? "Pass the ESP-side port (or omit port) — this blocker is never overridden."
                : "Fix the cause, or re-issue with force=true if you are certain.",
            },
          });
        }

        // ── policy and confirmation ───────────────────────────────────
        if (decide(ctx.policy, TOOL_NAME, argsRec) === "hidden") {
          return jsonResponse({ success: false, preflight, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
        }
        const c = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summarizeFlash(args, preflight));
        if (c.status === "token") {
          return jsonResponse({ ...(c.result.structuredContent as Record<string, unknown>), preflight });
        }
        if (c.status === "declined") {
          return jsonResponse({
            success: false,
            preflight,
            error: {
              code: "CANCELLED_BY_USER",
              message: `${TOOL_NAME} was declined by the user.`,
              hint: "Do not retry automatically; ask before issuing this call again.",
            },
          });
        }

        // ── the job ───────────────────────────────────────────────────
        const bootTimeout = args.boot_timeout_s ?? 45;
        const wantBoot = args.target === "esp" && args.wait_boot === true;
        const deviceId = device?.id;

        const taskId = ctx.jobs.create("flash", async (signal, progress) => {
          let flashResult: unknown;
          if (args.target === "stm") {
            progress(0, undefined, `STM ${args.method} flash starting`);
            flashResult = await crosspadStmFlash(args.method!, args.build_type ?? "Debug", args.firmware_path, progressLines(progress, "stm"), signal);
          } else if (args.transport === "ota") {
            const otaArgs: Record<string, unknown> = { firmware: preflight.firmware_path, wait_boot: false };
            if (deviceId !== undefined) otaArgs.device = deviceId;
            if (args.delta_base !== undefined) otaArgs.delta_base = args.delta_base;
            progress(0, undefined, "requesting ota.flash");
            const started = await daemon.request<{ task: string }>("ota.flash", otaArgs, { signal, timeoutMs: 30_000 });
            flashResult = await pumpDaemonTask(daemon, started.task, signal, progress);
          } else {
            progress(0, undefined, "idf.py flash starting");
            flashResult = await crosspadIdfFlash(args.port ?? preflight.port ?? undefined, progressLines(progress, "uart"), signal);
          }
          let boot: BootResult | null = null;
          if (wantBoot) {
            progress(0, undefined, "waiting for the boot markers");
            boot = await waitBootOnConsole(daemon, deviceId ?? args.device ?? "", ctx.handles, bootTimeout, signal);
          }
          return { flash: flashResult, boot };
        });
        ctx.handles.register(taskId, { kind: "task", device: deviceId });

        if ((args.wait_seconds ?? 0) > 0) {
          const status = await ctx.jobs.wait(taskId, (args.wait_seconds ?? 0) * 1000);
          return jsonResponse({
            success: status.status !== "failed",
            task: taskId,
            status,
            preflight,
            target: args.target,
            transport: preflight.transport,
            device: deviceId,
            firmware_path: preflight.firmware_path,
            ts: Date.now(),
          });
        }
        return jsonResponse({
          success: true,
          task: taskId,
          preflight,
          target: args.target,
          transport: preflight.transport,
          device: deviceId,
          firmware_path: preflight.firmware_path,
          hint: `Flashing in the background. Poll it with crosspad_task action='wait' task='${taskId}' (or action='status'); the result carries {flash, boot}.`,
          ts: Date.now(),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
```

- [ ] **Step 12: Run the flash tests**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run src/tools/flash.test.ts src/tools/flash.preflight.test.ts`
Expected: PASS (11 tool tests + 16 preflight tests).

- [ ] **Step 13: Wire it in and drop the legacy block**

In `src/registry.ts`, add to the `core` block (after `crosspad_snapshot`, keeping `TOOLSETS.core` order):

```ts
  manager.register("crosspad_flash", registerFlashTool(server, ctx), "core");
  registered.add("crosspad_flash");
```

with `import { registerFlashTool } from "./tools/flash.js";`.

In `src/index.ts`: delete the `FLASH — unified UART/OTA into one tool with 'transport' axis` banner and its `registerLegacy("crosspad_flash", …)` block (lines 581–631), delete the `O_Flash` const (lines 260–271), and delete the imports `crosspadIdfFlash`, `crosspadIdfOta`, `crosspadStmFlash`.

In `src/tools/idf-flash.ts`: delete `crosspadIdfOta` and the two helpers only it used, `extractDetectedPort` and `formatFileSize`. `crosspadIdfFlash` and `extractFlashError` stay. In `src/tools/idf-flash.test.ts`: delete the `crosspadIdfOta` describe block and drop `crosspadIdfOta` from the import.

- [ ] **Step 14: Run the whole suite and the type check**

Run: `cd /home/matixan/GIT/crosspad-mcp && npx vitest run && npx tsc --noEmit`
Expected: PASS for every file; `tsc` exits 0 with no output. `src/index.mcp.test.ts` still lists `crosspad_flash` (it is in `TOOLSETS.core`, enabled at startup).

- [ ] **Step 15: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add src/tools/flash.ts src/tools/flash.test.ts src/tools/flash.preflight.test.ts src/tasks.ts src/tasks.pump.test.ts src/tools/idf-flash.ts src/tools/idf-flash.test.ts src/registry.ts src/index.ts && git commit -m "feat(v10): crosspad_flash preflight, confirmation and job-backed OTA/UART with wait_boot"
```

# Plan C — chunk C4b: knowledge resources + release metadata + eval, and async everywhere

Repo: `/home/matixan/GIT/crosspad-mcp` (TypeScript ESM, strict, zod 4, `@modelcontextprotocol/sdk` 1.29, vitest 4).
Node: `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22` before every `npx vitest` / `npx tsc` / `node eval/grade.ts` (system Node 18 is too old for vitest 4, and `eval/grade.ts` is run by Node's own TypeScript stripping, which needs ≥ 22.18).

These two tasks close the P0 plan. Task 10 is documentation-and-metadata heavy but every claim it writes is asserted by a test; Task 11 is a pure refactor whose only new behaviour is concurrency and cancellation.

Shared conventions (identical to chunks C1–C3):
- Modules are ESM; relative imports end in `.js` even for `.ts` sources.
- Test fakes come from `src/testing/fake-daemon.ts` (`fakeDaemon(handlers)` → `FakeDaemon` with `.calls`) and `src/testing/fake-server.ts` (`fakeServer()` → `{ server, tools, resources, listChanged, clientCapabilities }`), both created in Task 5, Step 1a.
- Policy used in tests: `{ mode: "lab", rules: [] }`.
- Daemon op names are verbatim from the Python contract's `serve.py` section.

---

### Task 10: knowledge resources, release metadata, eval skeleton

**Files:**
- Create: `/home/matixan/GIT/crosspad-mcp/src/resources/knowledge.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/src/resources/knowledge.test.ts`
- Modify: `/home/matixan/GIT/crosspad-mcp/src/registry.ts` (import block at the top, and the resource-wiring lines at the end of `registerAll`, added by Task 6's wiring note)
- Modify: `/home/matixan/GIT/crosspad-mcp/package.json` (line 3 `version`, new `hilVersion` line after it, `scripts` block lines 34–40)
- Modify: `/home/matixan/GIT/crosspad-mcp/.claude-plugin/plugin.json` (line 4 `version`)
- Create: `/home/matixan/GIT/crosspad-mcp/CHANGELOG.md`
- Modify: `/home/matixan/GIT/crosspad-mcp/README.md` (line 10 banner; lines 93–97 heading + intro; the Build & flash table rows at lines 108–109; insert after line 111; Resources table after line 241; Migrations section after line 244)
- Create: `/home/matixan/GIT/crosspad-mcp/src/release.test.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/eval/tasks.json`
- Create: `/home/matixan/GIT/crosspad-mcp/eval/grade.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/eval/grade.test.ts`
- Create: `/home/matixan/GIT/crosspad-mcp/tsconfig.eval.json`
- Modify: `/home/matixan/GIT/crosspad-mcp/vitest.config.ts` (the `include` array, line 5)

**Interfaces:**
- Consumes:
  - `HilDaemon.request<T>(op: string, args: Record<string, unknown>, opts?: {signal?: AbortSignal; timeoutMs?: number}): Promise<T>` from `src/hil/daemon.ts` (Task 1).
  - `ToolContext { daemon: () => HilDaemon; policy: Policy; jobs: JobRegistry; handles: HandleRegistry }` from `src/tool-context.ts` (Task 2/4).
  - `ScenarioInfoSchema` (`z.looseObject({name: z.string(), description: z.string(), params: z.array(ScenarioParamSchema)})`) from `src/hil/schemas.ts` (Task 1).
  - `registerAll(server: McpServer, ctx: ToolContext, manager: ToolsetManager, legacy?: Map<string, RegisteredTool>): void` from `src/registry.ts` and `ToolsetManager`, `TOOLSETS` from `src/toolsets.ts` (Task 4).
  - `McpServer.registerResource(name, uriOrTemplate, metadata, cb)` used exactly as `src/index.ts:1648-1670` and `src/resources/device.ts` (Task 6) use it.
  - Daemon ops verbatim: `scenario.list {} → {"scenarios": [{name, description, params: [{name,type,default,help}]}]}`.
  - **Contract extension — a new daemon op that plan B must add to `crosspad_hil/serve.py`:**
    `knowledge.get {name: str} → dict`. It is a one-line wrapper over the contract's `crosspad_hil.knowledge.load(name)` (`knowledge/__init__.py`, `load(name) -> dict`), reading `crosspad_hil/knowledge/<name>.yaml` through `importlib.resources` with the same module-level cache. `name` must be one of `cdc`, `sysex`, `markers`; anything else raises `HilError(BAD_ARGS, "unknown knowledge file", hint="one of: cdc, sysex, markers")`. It is lock-free (no device is touched), so it belongs in the same "discovery is lock-free" group as `devices.list` and `scenario.list`. Add it to the OPS table in the contract next to `scenario.list`. Until it exists the three resources return their `{error: {...}}` payload instead of content — which is what the tests for the failure path assert, so this task is implementable and testable before plan B ships it.
- Produces:
  - `src/resources/knowledge.ts`:
    - `export const KNOWLEDGE_TTL_MS = 3_600_000` (1 h — the spec's "long" ttl for `crosspad://cdc`, `crosspad://sysex`, `crosspad://hil/catalog`; these change only when the firmware/daemon package changes, never within a session).
    - `export interface KnowledgeSpec { name: string; uri: string; op: string; args: Record<string, unknown>; description: string }`
    - `export const KNOWLEDGE_RESOURCES: KnowledgeSpec[]` — three entries, resource names `crosspad-cdc-catalog`, `crosspad-sysex-catalog`, `crosspad-hil-catalog`.
    - `export class KnowledgeCache { constructor(ttlMs?: number, now?: () => number); get(key: string): unknown | undefined; set(key: string, value: unknown): void; clear(): void; readonly size: number }`
    - `export const knowledgeCache: KnowledgeCache`
    - `export function registerKnowledgeResources(server: McpServer, ctx: ToolContext): void`
  - `package.json`: `"version": "10.0.0"`, `"hilVersion": "1.0.0"` (read by `DoctorProbe.requiredHilVersion()` from Task 5), scripts `eval:grade` and `typecheck:eval`.
  - `eval/grade.ts`: `export interface EvalTask { id: string; prompt: string; expected_tools: string[]; forbidden_shell_patterns: string[] }`; `export interface ToolCallRecord { tool: string; input?: Record<string, unknown> }`; `export interface ForbiddenHit { pattern: string; tool: string; command: string }`; `export interface EvalResult { id: string; passed: boolean; used_tools: string[]; missing_tools: string[]; forbidden_hits: ForbiddenHit[]; shell_calls: number; notes: string }`; `export const SHELL_TOOLS: Set<string>`; `export function shellCommandOf(call: ToolCallRecord): string | null`; `export function gradeTranscript(transcript: ToolCallRecord[], task: EvalTask): EvalResult`; `export function loadTasks(file?: string): EvalTask[]`; `export function formatResults(results: EvalResult[]): string`; `export function main(argv: string[]): number`.

**Contract choices stated here (the contract is silent):**
- The MCP resource metadata object has no `ttl` field, so "long ttl" is implemented on the server side: `KnowledgeCache` holds the fetched payload for `KNOWLEDGE_TTL_MS`, and the number is also advertised to clients in the resource `_meta` as `"crosspad/ttl_ms"` and repeated in the description. Errors are never cached.
- `crosspad://hil/catalog` returns `{scenarios, ttl_ms, generated_at}` — the daemon's `scenario.list` payload plus the two cache fields, so a client can tell a stale catalog from a fresh one.
- The v9 tool consolidations named in the README migration table (`crosspad_list_interfaces`/`crosspad_interface_implementations`/`crosspad_capabilities` → `crosspad_architecture`, `crosspad_apps_*` → `crosspad_apps`) are **not** implemented in P0. The migration table therefore carries a `status` column and marks them `P1 — v9 names still registered`, so the table documents what the server actually does. `crosspad_log target=idf` → `crosspad_console` **is** shipped (Task 6); `crosspad_log` stays registered for `target=pc`.

- [ ] **Step 1: Write the failing knowledge-resource test**

`/home/matixan/GIT/crosspad-mcp/src/resources/knowledge.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer } from "../testing/fake-server.js";
import {
  registerKnowledgeResources,
  KnowledgeCache,
  knowledgeCache,
  KNOWLEDGE_TTL_MS,
  KNOWLEDGE_RESOURCES,
} from "./knowledge.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import { ToolsetManager } from "../toolsets.js";
import { registerAll } from "../registry.js";
import type { ToolContext } from "../tool-context.js";

const CDC_YAML = {
  verbs: {
    KIT_LOAD: { args: ["id"], reply: "KITSTATUS:", end: null, profile: "default" },
    ENC_GROUP: { args: [], reply: "ENCGROUP:", end: null, profile: "default" },
  },
};
const SYSEX_YAML = {
  manufacturer: 0x7d,
  usb_mode: { id: 0x1b, default: 0x01, audio: 0x02 },
  host_denylist: [[0x19, 0x01]],
};
const SCENARIOS = {
  scenarios: [
    { name: "smoke", description: "boot and check markers", params: [{ name: "timeout", type: "int", default: 25, help: "seconds" }] },
    { name: "kit_churn", description: "swap kits while pads fire", params: [{ name: "rounds", type: "int", default: 20, help: "rounds" }] },
  ],
};

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const ctx: ToolContext = {
    daemon: () => daemon,
    policy: { mode: "lab", rules: [] },
    jobs: new JobRegistry(),
    handles: new HandleRegistry(),
  };
  const fs = fakeServer();
  registerKnowledgeResources(fs.server, ctx);
  return { daemon, res: fs.resources, ctx, fs };
}

beforeEach(() => {
  knowledgeCache.clear();
});

describe("knowledge resources", () => {
  it("registers the three long-ttl URIs", () => {
    const { res } = mk({});
    expect(res.get("crosspad-cdc-catalog")!.uriOrTemplate).toBe("crosspad://cdc");
    expect(res.get("crosspad-sysex-catalog")!.uriOrTemplate).toBe("crosspad://sysex");
    expect(res.get("crosspad-hil-catalog")!.uriOrTemplate).toBe("crosspad://hil/catalog");
    expect(res.get("crosspad-cdc-catalog")!.config._meta["crosspad/ttl_ms"]).toBe(KNOWLEDGE_TTL_MS);
    expect(KNOWLEDGE_RESOURCES.map((r) => r.name)).toEqual([
      "crosspad-cdc-catalog",
      "crosspad-sysex-catalog",
      "crosspad-hil-catalog",
    ]);
  });

  it("crosspad://cdc reads knowledge.get {name: cdc}", async () => {
    const { res, daemon } = mk({ "knowledge.get": () => CDC_YAML });
    const out = await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    expect(daemon.calls[0]).toEqual({ op: "knowledge.get", args: { name: "cdc" } });
    expect(out.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(out.contents[0].text).verbs.KIT_LOAD.reply).toBe("KITSTATUS:");
  });

  it("crosspad://sysex reads knowledge.get {name: sysex}", async () => {
    const { res, daemon } = mk({ "knowledge.get": () => SYSEX_YAML });
    const out = await res.get("crosspad-sysex-catalog")!.cb(new URL("crosspad://sysex"));
    expect(daemon.calls[0]).toEqual({ op: "knowledge.get", args: { name: "sysex" } });
    expect(JSON.parse(out.contents[0].text).host_denylist).toEqual([[0x19, 0x01]]);
  });

  it("serves the second read from cache without touching the daemon", async () => {
    const { res, daemon } = mk({ "knowledge.get": () => CDC_YAML });
    await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    expect(daemon.calls.length).toBe(1);
  });

  it("crosspad://hil/catalog reads scenario.list and validates params", async () => {
    const { res, daemon } = mk({ "scenario.list": () => SCENARIOS });
    const out = await res.get("crosspad-hil-catalog")!.cb(new URL("crosspad://hil/catalog"));
    expect(daemon.calls[0]).toEqual({ op: "scenario.list", args: {} });
    const parsed = JSON.parse(out.contents[0].text);
    expect(parsed.scenarios.map((s: { name: string }) => s.name)).toEqual(["smoke", "kit_churn"]);
    expect(parsed.scenarios[1].params[0].name).toBe("rounds");
    expect(parsed.ttl_ms).toBe(KNOWLEDGE_TTL_MS);
    expect(typeof parsed.generated_at).toBe("number");
  });

  it("reports a daemon error as a payload and does not cache it", async () => {
    let calls = 0;
    const { res, daemon } = mk({
      "knowledge.get": () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("unknown knowledge file"), { code: "BAD_ARGS", hint: "one of: cdc, sysex, markers" });
        return CDC_YAML;
      },
    });
    const bad = await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    const payload = JSON.parse(bad.contents[0].text);
    expect(payload.error.code).toBe("BAD_ARGS");
    expect(payload.error.hint).toBe("one of: cdc, sysex, markers");
    const good = await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    expect(JSON.parse(good.contents[0].text).verbs).toBeDefined();
    expect(daemon.calls.length).toBe(2);
  });

  it("registerAll wires the knowledge resources", () => {
    const fs = fakeServer();
    const ctx: ToolContext = {
      daemon: () => fakeDaemon({}),
      policy: { mode: "lab", rules: [] },
      jobs: new JobRegistry(),
      handles: new HandleRegistry(),
    };
    const manager = new ToolsetManager(fs.server, ctx.policy);
    registerAll(fs.server, ctx, manager);
    expect(fs.resources.has("crosspad-cdc-catalog")).toBe(true);
    expect(fs.resources.has("crosspad-sysex-catalog")).toBe(true);
    expect(fs.resources.has("crosspad-hil-catalog")).toBe(true);
  });
});

describe("KnowledgeCache", () => {
  it("expires entries after ttlMs", () => {
    let now = 1_000;
    const c = new KnowledgeCache(500, () => now);
    c.set("k", { a: 1 });
    expect(c.get("k")).toEqual({ a: 1 });
    now = 1_499;
    expect(c.get("k")).toEqual({ a: 1 });
    now = 1_501;
    expect(c.get("k")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("clear() drops everything", () => {
    const c = new KnowledgeCache(1000, () => 0);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.size).toBe(2);
    c.clear();
    expect(c.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/resources/knowledge.test.ts`
Expected: FAIL with `Failed to load url ./knowledge.js`.

- [ ] **Step 3: Write `src/resources/knowledge.ts`**

```ts
// src/resources/knowledge.ts — crosspad://cdc, crosspad://sysex,
// crosspad://hil/catalog. Firmware-coupled reference data lives in the
// crosspad-hil package (knowledge/*.yaml), not here: it must version with the
// firmware, not with this server. These resources are the read-only window on
// it, cached for KNOWLEDGE_TTL_MS because the payloads cannot change while the
// daemon process lives.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { ScenarioInfoSchema } from "../hil/schemas.js";

/** "long" ttl from spec §3.3 — one hour. */
export const KNOWLEDGE_TTL_MS = 3_600_000;

export interface KnowledgeSpec {
  name: string;
  uri: string;
  op: string;
  args: Record<string, unknown>;
  description: string;
}

export const KNOWLEDGE_RESOURCES: KnowledgeSpec[] = [
  {
    name: "crosspad-cdc-catalog",
    uri: "crosspad://cdc",
    op: "knowledge.get",
    args: { name: "cdc" },
    description:
      "CDC verb catalog with reply grammar (crosspad_hil/knowledge/cdc.yaml, generated from hil_control.cpp): every verb, its args, its reply prefix, whether the reply is single-line/OK/multi, and which USB profile it works in. Read this before sending a raw command with crosspad_cdc verb=raw — a reply prefix is not an acknowledgement of your command. Cached 1 h.",
  },
  {
    name: "crosspad-sysex-catalog",
    uri: "crosspad://sysex",
    op: "knowledge.get",
    args: { name: "sysex" },
    description:
      "0x7D SysEx catalog (crosspad_hil/knowledge/sysex.yaml): manufacturer id, USB-mode ids, the 0x1D audio-route sub-verbs, bootloader ids, and the host denylist (frames this server refuses to send). Cached 1 h.",
  },
  {
    name: "crosspad-hil-catalog",
    uri: "crosspad://hil/catalog",
    op: "scenario.list",
    args: {},
    description:
      "Scenarios the crosspad-hil daemon can run, with their parameters, defaults and help text — the machine-readable form of tools/hil_*.py. Cached 1 h.",
  },
];

/** Time-boxed value cache. Errors are never stored. */
export class KnowledgeCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { value: unknown; at: number }>();

  constructor(ttlMs: number = KNOWLEDGE_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string): unknown | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: unknown): void {
    this.entries.set(key, { value, at: this.now() });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export const knowledgeCache = new KnowledgeCache();

function jsonContents(uri: string, data: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
}

// Same shape as src/resources/device.ts — a resource read never throws at the
// client, it answers with the error it hit.
function errorPayload(e: unknown): { error: { code: string; message: string; hint?: string } } {
  const code = (e as { code?: string }).code ?? "INTERNAL";
  const hint = (e as { hint?: string }).hint;
  return { error: { code, message: e instanceof Error ? e.message : String(e), ...(hint ? { hint } : {}) } };
}

async function fetchKnowledge(ctx: ToolContext, spec: KnowledgeSpec): Promise<unknown> {
  const cached = knowledgeCache.get(spec.uri);
  if (cached !== undefined) return cached;

  const raw = await ctx.daemon().request<Record<string, unknown>>(spec.op, spec.args, { timeoutMs: 15_000 });
  const value =
    spec.op === "scenario.list"
      ? {
          scenarios: (raw.scenarios as unknown[]).map((s) => ScenarioInfoSchema.parse(s)),
          ttl_ms: KNOWLEDGE_TTL_MS,
          generated_at: Date.now(),
        }
      : raw;

  knowledgeCache.set(spec.uri, value);
  return value;
}

export function registerKnowledgeResources(server: McpServer, ctx: ToolContext): void {
  for (const spec of KNOWLEDGE_RESOURCES) {
    server.registerResource(
      spec.name,
      spec.uri,
      {
        description: spec.description,
        mimeType: "application/json",
        _meta: { "crosspad/ttl_ms": KNOWLEDGE_TTL_MS },
      },
      async (uri) => {
        try {
          return jsonContents(uri.href, await fetchKnowledge(ctx, spec));
        } catch (e) {
          return jsonContents(uri.href, errorPayload(e));
        }
      },
    );
  }
}
```

- [ ] **Step 4: Wire them into `registerAll`**

`src/registry.ts` — add the import next to the existing resource import, and one call next to `registerDeviceResources(server, ctx)` (added by Task 6's wiring note) at the end of `registerAll`:

```ts
import { registerKnowledgeResources } from "./resources/knowledge.js";
```

```ts
  registerDeviceResources(server, ctx);
  registerKnowledgeResources(server, ctx);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/resources/knowledge.test.ts && npx tsc --noEmit`
Expected: `Test Files 1 passed`, `Tests 9 passed`; tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add src/resources/knowledge.ts src/resources/knowledge.test.ts src/registry.ts && git commit -m "feat(v10): crosspad://cdc, crosspad://sysex and crosspad://hil/catalog resources with a 1 h cache"
```

- [ ] **Step 7: Write the failing release-metadata test**

`/home/matixan/GIT/crosspad-mcp/src/release.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TOOLSETS } from "./toolsets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf-8");
const pkg = JSON.parse(read("package.json")) as Record<string, string> & { scripts: Record<string, string> };
const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as Record<string, string>;
const readme = read("README.md");
const changelog = read("CHANGELOG.md");

const ALL_TOOLS = [...new Set(Object.values(TOOLSETS).flat())];

describe("release metadata", () => {
  it("package.json is the 10.0.0 breaking release", () => {
    expect(pkg.version).toBe("10.0.0");
  });

  it("declares the crosspad-hil version it requires", () => {
    expect(pkg.hilVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.hilVersion).toBe("1.0.0");
  });

  it("plugin.json version is synced with package.json", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("ships the eval scripts", () => {
    expect(pkg.scripts["eval:grade"]).toBe("node eval/grade.ts");
    expect(pkg.scripts["typecheck:eval"]).toBe("tsc -p tsconfig.eval.json --noEmit");
  });

  it("CHANGELOG's newest entry is 10.0.0", () => {
    const firstHeading = changelog.split("\n").find((l) => l.startsWith("## ["));
    expect(firstHeading).toBe("## [10.0.0] — 2026-08-26");
    expect(changelog).toContain("crosspad-hil");
  });
});

describe("README documents what the server actually does", () => {
  it("has the v9 → v10 migration table", () => {
    expect(readme).toContain("<b>v9 → v10</b>");
    expect(readme).toContain("`crosspad_log` with `target: idf`");
    expect(readme).toContain("`crosspad_architecture`");
    expect(readme).toContain("`crosspad_apps`");
    expect(readme).toContain("P1 — v9 names still registered");
  });

  it("documents every toolset name", () => {
    for (const name of Object.keys(TOOLSETS)) {
      expect(readme, `toolset ${name} missing from README`).toContain(`\`${name}\``);
    }
  });

  it("documents the startup flags", () => {
    expect(readme).toContain("--read-only");
    expect(readme).toContain("--toolsets");
    expect(readme).toContain("CROSSPAD_TOOLSETS");
  });

  it("names every tool that a toolset contains", () => {
    for (const tool of ALL_TOOLS) {
      expect(readme, `${tool} missing from README`).toContain(`\`${tool}\``);
    }
  });

  it("the banner counts match the toolset map", () => {
    const banner = readme.split("\n").find((l) => l.includes("tools in") && l.includes("toolsets"));
    expect(banner, "README banner line not found").toBeDefined();
    const toolCount = Number(banner!.match(/\*\*(\d+) tools/)![1]);
    const toolsetCount = Number(banner!.match(/in (\d+) toolsets/)![1]);
    expect(toolCount).toBe(ALL_TOOLS.length);
    expect(toolsetCount).toBe(Object.keys(TOOLSETS).length);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/release.test.ts`
Expected: FAIL — first with `ENOENT: no such file or directory, open '.../CHANGELOG.md'`, then (once Step 9c lands) with `expected '9.3.0' to be '10.0.0'`.

- [ ] **Step 9a: Bump `package.json`**

Replace line 3 (`  "version": "9.3.0",`) with these two lines:

```json
  "version": "10.0.0",
  "hilVersion": "1.0.0",
```

and replace the `scripts` block (lines 34–40) with:

```json
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "eval:grade": "node eval/grade.ts",
    "typecheck:eval": "tsc -p tsconfig.eval.json --noEmit"
  },
```

- [ ] **Step 9b: Sync `.claude-plugin/plugin.json`**

Replace line 4 (`  "version": "9.1.1",`) with:

```json
  "version": "10.0.0",
```

- [ ] **Step 9c: Write `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to crosspad-mcp-server. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [10.0.0] — 2026-08-26

Breaking. The server stops being a bag of shell wrappers and becomes a thin,
safe front over the [crosspad-hil](https://github.com/CrossPad/crosspad-hil)
daemon (`hilVersion` 1.0.0, spawned as `python -m crosspad_hil.serve`).

### Added
- **Toolsets.** `tools/list` starts with the `core` toolset only (8 tools).
  Everything else is registered disabled and enabled on demand with
  `crosspad_toolsets action=enable toolset=<name>`, `--toolsets a,b` or
  `CROSSPAD_TOOLSETS`. Toolsets: `core`, `device`, `hil`, `sim`, `code`, `git`,
  `apps`, `trace`.
- **Policy tiers and confirmations.** Every tool has a tier
  (`read`/`stimulus`/`mutate-host`/`danger`); annotations are derived from it.
  Danger-tier calls return `resultType="confirmation_required"` with a
  120 s `confirm_token` instead of acting, or ask the client directly when it
  supports elicitation. `--read-only` / `CROSSPAD_MCP_POLICY=readonly` hides
  every non-`read` tool.
- **Device tools over the daemon**: `crosspad_console` (boot log, `expect`,
  parsed snapshot, log file as a `resource_link`), `crosspad_cdc` (typed verbs
  from `verbs.py`), `crosspad_ui` (drive the encoder by snapshot ref),
  `crosspad_snapshot`, `crosspad_doctor`, `crosspad_usb_mode`, `crosspad_task`.
- **Handles and jobs.** `con_N` / `cdc_N` / `snap_N` / `task_N` are explicit;
  long operations (build, flash, scenarios) run as jobs polled through
  `crosspad_task {status|wait|cancel|list}` and keep results for 1 h.
- **Resources**: `crosspad://devices`, `crosspad://device/{id}/state`,
  `crosspad://device/{id}/console/log`, `crosspad://cdc`, `crosspad://sysex`,
  `crosspad://hil/catalog` (the last three cached for 1 h).
- **Eval harness** (`eval/tasks.json`, `eval/grade.ts`) for the meta-bug in
  `todo.md`: 10 recorded-transcript tasks that fail when the model shells out
  instead of calling a `crosspad_*` tool.

### Changed
- `crosspad_devices` enumerates through the daemon (`devices.list`): USB mode,
  paired STM32 bridge, MIDI ports and the UAC2 card, not just a serial list.
- `crosspad_flash` always returns a preflight (USB mode, port role, firmware
  mtime vs sources, bin version, board rev) and runs as a job.
- `crosspad_midi` and `crosspad_audio_route` talk to the daemon instead of
  shelling out to `amidi`; `crosspad_midi` gained `target: device|sim`.
- No `execSync`/`spawnSync` on the request path: `crosspad_repo_status` runs its
  per-repo git calls concurrently (limit 4) and every subprocess honours
  cancellation.

### Removed
- The v9 inline device enumeration (`listDevices()` on the tool path).
- `logging/message` server logs (deprecated in MCP 2026-07-28); progress goes
  through `notifications/progress`.

### Requires
- `crosspad-hil` ≥ 1.0.0 on the interpreter named by the `hil_python` config
  key / `CROSSPAD_HIL_PYTHON` (falls back to the tracer's python, then
  `python3`). `crosspad_doctor` reports the version mismatch.
```

- [ ] **Step 9d: Update `README.md`**

(a) Replace line 10 (the banner) with:

```markdown
**38 tools in 8 toolsets (8 visible at start) · 10 resources · 2 bundled Claude Code skills · stdio & HTTP transports**
```

(b) Replace lines 93–97 (`## Tools (30) + resources` through the "Each tool is focused…" paragraph) with:

```markdown
## Tools + resources

> v10 put the tools behind **toolsets** and a **policy**: `tools/list` starts with the `core` toolset only, so the startup context stays small, and everything that writes to a device or the host is tiered and confirmable. Migration table at the bottom of this file.

Each tool is focused on a single action. Strict schema validation (ranges on MIDI/pad values, enums on platforms/repos) catches bad inputs before execution.

### Toolsets

| Toolset | Contains | On at start |
|---|---|---|
| `core` | `crosspad_devices`, `crosspad_doctor`, `crosspad_snapshot`, `crosspad_build`, `crosspad_flash`, `crosspad_repo_status`, `crosspad_toolsets`, `crosspad_task` | yes |
| `device` | `crosspad_cdc`, `crosspad_console`, `crosspad_ui`, `crosspad_midi`, `crosspad_usb_mode`, `crosspad_audio_route` | no |
| `hil` | scenario runner (`crosspad_hil_run` and friends — P1) | no |
| `sim` | `crosspad_run`, `crosspad_kill`, `crosspad_check`, `crosspad_screenshot`, `crosspad_input`, `crosspad_stats`, `crosspad_settings_get`, `crosspad_settings_set`, `crosspad_test_run`, `crosspad_log` | no |
| `code` | `crosspad_search_symbols`, `crosspad_list_interfaces`, `crosspad_interface_implementations`, `crosspad_capabilities`, `crosspad_list_apps_source` | no |
| `git` | `crosspad_repo_diff`, `crosspad_submodule_update`, `crosspad_commit` | no |
| `apps` | `crosspad_apps_list`, `crosspad_apps_install`, `crosspad_apps_remove`, `crosspad_apps_update`, `crosspad_apps_sync` | no |
| `trace` | `crosspad_trace` | no |

Enable one at runtime with `crosspad_toolsets action=enable toolset=device` (the tool list changes and the client is notified). At startup: `--toolsets device,code` (or `CROSSPAD_TOOLSETS=device,code`, keyword `all`). `--read-only` (or `CROSSPAD_MCP_POLICY=readonly`) removes every non-`read` tool from the list regardless of toolset flags — read-only always wins.

Danger-tier tools (`crosspad_flash`, bootloader/DFU requests, `crosspad_trace` write/call) return `resultType="confirmation_required"` with a `confirm_token` valid for 120 s; re-issue the identical call carrying the token to proceed. A declined confirmation is `CANCELLED_BY_USER` and must not be retried automatically.
```

(c) Replace the `crosspad_log` and `crosspad_devices` rows (lines 108–109) with:

```markdown
| `crosspad_log` | Capture simulator logs (`target: pc` spawns the binary). For device logs use `crosspad_console` — it does not reboot the board. |
| `crosspad_devices` | Devices through the crosspad-hil daemon: USB mode, CDC + STM32-bridge ports, MIDI ports, UAC2 card, which one is selected |
```

(d) Insert after line 111 (the `crosspad_audio_route` row, before `### SWD tracing (crosspad_trace)`):

```markdown

### Device (crosspad-hil daemon)

Everything here needs a connected board (`[ESP HW]`) and the `device` toolset.

| Tool | Purpose |
|------|---------|
| `crosspad_doctor` | Host + daemon environment checks (python, crosspad-hil version, IDF export, sim binary, ports) with a `fix` per failed check |
| `crosspad_console` | STM32-bridge console: `open` (never reboots the board — DTR/RTS deasserted), `read`, `expect`, `reset`, `snapshot`, `close`. Log file linked as a resource, never inlined; reads cap at 2 000 lines |
| `crosspad_cdc` | Typed CDC verbs (`app`, `kit`, `pad`, `enc`, `led`, `mem`, `audio`, `ble`, `system`, `raw`) — the `hil_control.cpp` command set with reply parsing |
| `crosspad_ui` | Drive the UI by snapshot ref: rotate to a labelled row, press, back. Returns a fresh snapshot |
| `crosspad_snapshot` | One coherent read of a device (apps, ui, kit, leds, pads, mem, ble, console) or of the simulator; diffable against a previous snapshot |
| `crosspad_usb_mode` | Get/set the USB profile (`default` = MIDI+CDC, `audio` = UAC2) and wait for re-enumeration |
| `crosspad_task` | `status` / `wait` / `cancel` / `list` for long operations (build, flash, scenarios) |
```

(e) Append to the Resources table (after line 241):

```markdown
| `crosspad://devices` | Device inventory from the daemon — the raw `Device` dicts behind `crosspad_devices`. Re-discovered on every read. |
| `crosspad://device/{id}/state` | Fresh snapshot of one device (apps, ui, kit, leds, pads, mem, ble, console). |
| `crosspad://device/{id}/console/log` | The console log file of the most recent `crosspad_console open` for that device (last 1 MiB). |
| `crosspad://cdc` | CDC verb catalog with reply grammar, from `crosspad_hil/knowledge/cdc.yaml`. Cached 1 h. |
| `crosspad://sysex` | 0x7D SysEx catalog: USB-mode and audio-route ids, plus the host denylist. Cached 1 h. |
| `crosspad://hil/catalog` | Scenarios the daemon can run, with parameters, defaults and help. Cached 1 h. |
```

(f) Insert directly after line 244 (the blank line under `### Migrations`, above the v7 → v8 block):

```markdown
<details>
<summary><b>v9 → v10</b> — the device side moved into the crosspad-hil daemon; tools live in toolsets</summary>

| Old (v9) | New (v10) | Status |
|---|---|---|
| `crosspad_log` with `target: idf` | `crosspad_console` (`open`/`read`/`expect`/`snapshot`/`close`) | shipped — `crosspad_log` keeps `target: pc` |
| `crosspad_devices` (serial-port list) | `crosspad_devices` (daemon `devices.list`: USB mode, paired STM32 bridge, MIDI, UAC2) | shipped — same name, richer result |
| raw SysEx via `amidi` inside `crosspad_audio_route` | daemon `midi.sysex` / `midi.query_route`, tool schema unchanged | shipped |
| `crosspad_flash` (fire and forget) | `crosspad_flash` with an always-returned preflight, a job handle and `wait_boot` | shipped |
| — | `crosspad_cdc`, `crosspad_ui`, `crosspad_snapshot`, `crosspad_doctor`, `crosspad_usb_mode`, `crosspad_task`, `crosspad_toolsets` | new |
| `crosspad_list_interfaces`, `crosspad_interface_implementations`, `crosspad_capabilities` | `crosspad_architecture` with an `action` field | P1 — v9 names still registered (toolset `code`) |
| `crosspad_apps_list/install/remove/update/sync` | `crosspad_apps` with an `action` field | P1 — v9 names still registered (toolset `apps`) |

Startup surface: `tools/list` returns the `core` toolset only. Enable the rest with `crosspad_toolsets`, `--toolsets a,b` or `CROSSPAD_TOOLSETS`; hide every writing tool with `--read-only`. Requires `crosspad-hil` ≥ 1.0.0 (`package.json` → `hilVersion`); `crosspad_doctor` tells you when it is missing or too old.

</details>

```

- [ ] **Step 10: Run the release test**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run src/release.test.ts`
Expected: `Test Files 1 passed`, `Tests 10 passed`.

If `the banner counts match the toolset map` fails, the `TOOLSETS` map is authoritative: put the two numbers the failure reports (`expected 38 to be N`) into the README banner line and re-run. Do **not** change `TOOLSETS` to match the prose.

- [ ] **Step 11: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add package.json .claude-plugin/plugin.json CHANGELOG.md README.md src/release.test.ts && git commit -m "docs(v10): 10.0.0 release metadata, hilVersion, CHANGELOG and the v9 to v10 migration table"
```

- [ ] **Step 12: Write the failing eval-grader test**

First make the `eval/` directory visible to vitest and to a type-check — `tsconfig.json` keeps `rootDir: "src"` so `npm run build` stays unchanged.

`/home/matixan/GIT/crosspad-mcp/vitest.config.ts` — replace line 5:

```ts
    include: ["src/**/*.test.ts", "eval/**/*.test.ts"],
```

`/home/matixan/GIT/crosspad-mcp/tsconfig.eval.json` (new):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "declaration": false,
    "sourceMap": false,
    "allowImportingTsExtensions": true
  },
  "include": ["eval/**/*.ts"]
}
```

`/home/matixan/GIT/crosspad-mcp/eval/grade.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  gradeTranscript,
  loadTasks,
  shellCommandOf,
  formatResults,
  SHELL_TOOLS,
  type EvalTask,
  type ToolCallRecord,
} from "./grade.js";
import { TOOLSETS } from "../src/toolsets.js";

const ALL_TOOLS = new Set(Object.values(TOOLSETS).flat());

const task: EvalTask = {
  id: "repo-status-not-git-status",
  prompt: "What is dirty across the CrossPad repos right now?",
  expected_tools: ["crosspad_repo_status"],
  forbidden_shell_patterns: ["\\bgit\\s+status\\b", "\\bgit\\s+-C\\b"],
};

describe("gradeTranscript", () => {
  it("passes when the expected tool was called and no shell rule was broken", () => {
    const t: ToolCallRecord[] = [{ tool: "crosspad_repo_status", input: {} }];
    const r = gradeTranscript(t, task);
    expect(r.passed).toBe(true);
    expect(r.missing_tools).toEqual([]);
    expect(r.forbidden_hits).toEqual([]);
    expect(r.used_tools).toEqual(["crosspad_repo_status"]);
    expect(r.id).toBe(task.id);
  });

  it("fails when the model shelled out instead", () => {
    const t: ToolCallRecord[] = [{ tool: "Bash", input: { command: "cd ~/GIT/platform-idf && git status --porcelain" } }];
    const r = gradeTranscript(t, task);
    expect(r.passed).toBe(false);
    expect(r.missing_tools).toEqual(["crosspad_repo_status"]);
    expect(r.forbidden_hits).toEqual([
      { pattern: "\\bgit\\s+status\\b", tool: "Bash", command: "cd ~/GIT/platform-idf && git status --porcelain" },
    ]);
    expect(r.shell_calls).toBe(1);
  });

  it("fails on a forbidden shell call even when the tool was also used", () => {
    const t: ToolCallRecord[] = [
      { tool: "crosspad_repo_status", input: {} },
      { tool: "Bash", input: { command: "git status" } },
    ];
    const r = gradeTranscript(t, task);
    expect(r.passed).toBe(false);
    expect(r.missing_tools).toEqual([]);
    expect(r.forbidden_hits.length).toBe(1);
  });

  it("allows unrelated shell calls", () => {
    const t: ToolCallRecord[] = [
      { tool: "crosspad_repo_status", input: {} },
      { tool: "Bash", input: { command: "ls ~/GIT" } },
    ];
    const r = gradeTranscript(t, task).passed;
    expect(t.length).toBe(2);
    expect(r).toBe(true);
  });

  it("matches case-insensitively and reports each distinct pattern once per call", () => {
    const t: ToolCallRecord[] = [{ tool: "Bash", input: { command: "GIT STATUS && git -C /x status" } }];
    const r = gradeTranscript(t, task);
    expect(r.forbidden_hits.map((h) => h.pattern).sort()).toEqual(["\\bgit\\s+-C\\b", "\\bgit\\s+status\\b"]);
  });

  it("deduplicates repeated tool calls in used_tools", () => {
    const t: ToolCallRecord[] = [
      { tool: "crosspad_repo_status", input: {} },
      { tool: "crosspad_repo_status", input: {} },
    ];
    expect(gradeTranscript(t, task).used_tools).toEqual(["crosspad_repo_status"]);
  });
});

describe("shellCommandOf", () => {
  it("reads command / cmd / script from any known shell tool", () => {
    expect(shellCommandOf({ tool: "Bash", input: { command: "ls" } })).toBe("ls");
    expect(shellCommandOf({ tool: "shell", input: { cmd: "ls" } })).toBe("ls");
    expect(shellCommandOf({ tool: "run_shell_command", input: { script: "ls" } })).toBe("ls");
    expect(shellCommandOf({ tool: "crosspad_repo_status", input: { command: "ls" } })).toBeNull();
    expect(shellCommandOf({ tool: "Bash" })).toBeNull();
    expect(SHELL_TOOLS.has("Bash")).toBe(true);
  });
});

describe("eval/tasks.json", () => {
  const tasks = loadTasks();

  it("has exactly 10 tasks with unique ids", () => {
    expect(tasks.length).toBe(10);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(10);
  });

  it("every task names a real prompt, at least one expected tool and one forbidden pattern", () => {
    for (const t of tasks) {
      expect(t.prompt.length, t.id).toBeGreaterThan(20);
      expect(t.expected_tools.length, t.id).toBeGreaterThan(0);
      expect(t.forbidden_shell_patterns.length, t.id).toBeGreaterThan(0);
    }
  });

  it("every expected tool exists in a toolset", () => {
    for (const t of tasks) {
      for (const tool of t.expected_tools) {
        expect(ALL_TOOLS.has(tool), `${t.id} expects unknown tool ${tool}`).toBe(true);
      }
    }
  });

  it("every forbidden pattern compiles as a regex", () => {
    for (const t of tasks) {
      for (const p of t.forbidden_shell_patterns) {
        expect(() => new RegExp(p, "i"), `${t.id}: ${p}`).not.toThrow();
      }
    }
  });

  it("a transcript that calls only the expected tools passes every task", () => {
    for (const t of tasks) {
      const transcript = t.expected_tools.map((tool) => ({ tool, input: {} }));
      expect(gradeTranscript(transcript, t).passed, t.id).toBe(true);
    }
  });
});

describe("formatResults", () => {
  it("renders one line per task with PASS/FAIL", () => {
    const out = formatResults([
      gradeTranscript([{ tool: "crosspad_repo_status" }], task),
      gradeTranscript([{ tool: "Bash", input: { command: "git status" } }], task),
    ]);
    expect(out).toContain("PASS repo-status-not-git-status");
    expect(out).toContain("FAIL repo-status-not-git-status");
    expect(out).toContain("1/2 passed");
  });
});
```

- [ ] **Step 13: Run it to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run eval/grade.test.ts`
Expected: FAIL with `Failed to load url ./grade.js`.

- [ ] **Step 14: Write `eval/tasks.json`**

Ten tasks aimed at the meta-bug recorded in `todo.md` (⭐ *Meta-bug*: "Claude w sesji często NIE używa `crosspad_*` tools — robi raw `git status`, `grep`, `cmake` ręcznie"). Each `prompt` is what the user says; `expected_tools` is what a correct run must call; `forbidden_shell_patterns` is what a wrong run reaches for instead.

```json
{
  "version": 1,
  "description": "Does the model use crosspad_* tools, or does it shell out? Each task is graded against a recorded transcript of tool calls by eval/grade.ts.",
  "tasks": [
    {
      "id": "repo-status-not-git-status",
      "prompt": "What's dirty across the CrossPad repos right now, and which submodule pins have drifted?",
      "expected_tools": ["crosspad_repo_status"],
      "forbidden_shell_patterns": ["\\bgit\\s+status\\b", "\\bgit\\s+-C\\b", "\\bgit\\s+submodule\\s+status\\b"]
    },
    {
      "id": "symbols-not-grep",
      "prompt": "Where is PadLedController defined, and which repos have a copy of it?",
      "expected_tools": ["crosspad_search_symbols"],
      "forbidden_shell_patterns": ["\\bgrep\\s+-[a-zA-Z]*r", "\\bgit\\s+grep\\b", "\\brg\\s", "\\back\\s", "\\bfind\\s+\\S+\\s+-name\\b"]
    },
    {
      "id": "interfaces-not-find",
      "prompt": "List the crosspad-core interfaces and tell me which classes implement IPadLogicHandler.",
      "expected_tools": ["crosspad_list_interfaces", "crosspad_interface_implementations"],
      "forbidden_shell_patterns": ["\\bls\\s+.*include/crosspad", "\\bfind\\s+\\S*crosspad-core", "\\bgit\\s+grep\\b", "\\bgrep\\s+-[a-zA-Z]*r"]
    },
    {
      "id": "devices-not-lsusb",
      "prompt": "Is a CrossPad plugged in, and which USB mode is it in?",
      "expected_tools": ["crosspad_devices"],
      "forbidden_shell_patterns": ["\\blsusb\\b", "\\bls\\s+/dev/tty", "\\bdmesg\\b", "\\bsystem_profiler\\b", "\\bmode -a\\b"]
    },
    {
      "id": "console-not-idf-monitor",
      "prompt": "The board reboots on startup — show me the boot log and tell me which required marker is missing.",
      "expected_tools": ["crosspad_console"],
      "forbidden_shell_patterns": ["idf\\.py\\s+monitor", "\\bcat\\s+/dev/tty", "\\bscreen\\s+/dev/tty", "\\bminicom\\b", "\\bpicocom\\b", "python3?\\s+\\S*tools/hil_smoke\\.py"]
    },
    {
      "id": "build-not-idfpy",
      "prompt": "Build the ESP-IDF firmware and tell me if it compiled clean.",
      "expected_tools": ["crosspad_build"],
      "forbidden_shell_patterns": ["idf\\.py\\s+build", "\\bninja\\b", "cmake\\s+--build", "\\bmake\\s+-j"]
    },
    {
      "id": "flash-not-esptool",
      "prompt": "Flash the firmware you just built over OTA and wait until it boots.",
      "expected_tools": ["crosspad_flash", "crosspad_task"],
      "forbidden_shell_patterns": ["idf\\.py\\s+.*flash", "\\besptool(\\.py)?\\b", "python3?\\s+\\S*tools/ota_flash\\.py", "python3?\\s+\\S*tools/requestBootloader\\.py", "\\bsleep\\s+\\d+"]
    },
    {
      "id": "pad-hit-not-hil-script",
      "prompt": "Press pad 3 with velocity 100 on the connected board and tell me whether the sampler played a voice.",
      "expected_tools": ["crosspad_cdc"],
      "forbidden_shell_patterns": ["python3?\\s+\\S*tools/hil_", "\\bamidi\\b", "python3?\\s+-c\\s+.*serial", "\\becho\\s+.*>\\s*/dev/tty"]
    },
    {
      "id": "kit-load-not-serial-echo",
      "prompt": "Load kit 8 on the device and confirm it finished loading rather than queueing behind another load.",
      "expected_tools": ["crosspad_cdc"],
      "forbidden_shell_patterns": ["\\becho\\s+.*KIT_LOAD", "python3?\\s+-c\\s+.*serial", "python3?\\s+\\S*tools/hil_kit_churn\\.py", "\\bcu\\s+-l\\b"]
    },
    {
      "id": "missing-tool-enable-toolset",
      "prompt": "I need to drive the encoder on the physical device but I only see the core tools. Get to a state where you can do it.",
      "expected_tools": ["crosspad_toolsets", "crosspad_ui"],
      "forbidden_shell_patterns": ["\\bnpx\\s+crosspad", "\\bnode\\s+\\S*dist/index\\.js", "claude\\s+mcp\\b", "\\bexport\\s+CROSSPAD_TOOLSETS"]
    }
  ]
}
```

- [ ] **Step 15: Write `eval/grade.ts`**

Run directly by Node's TypeScript stripping (`node eval/grade.ts`), so: no enums, no namespaces, no parameter properties, and no relative imports of other `.ts` files at runtime.

```ts
#!/usr/bin/env node
// eval/grade.ts — grade a recorded transcript of tool calls against
// eval/tasks.json. The bug being measured is in todo.md (⭐ Meta-bug): the
// model shells out (`git status`, `grep -r`, `idf.py flash`) instead of calling
// the crosspad_* tool that exists for exactly that job. A task passes only when
// every expected tool was called AND no forbidden shell command was issued.
//
//   node eval/grade.ts transcripts/run-2026-08-26.json
//   node eval/grade.ts transcripts/*.json --json
//
// Transcript file format:
//   { "runs": [ { "task": "<task id>",
//                 "calls": [ { "tool": "Bash", "input": { "command": "git status" } } ] } ] }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EvalTask {
  id: string;
  prompt: string;
  expected_tools: string[];
  forbidden_shell_patterns: string[];
}

export interface ToolCallRecord {
  tool: string;
  input?: Record<string, unknown>;
}

export interface ForbiddenHit {
  pattern: string;
  tool: string;
  command: string;
}

export interface EvalResult {
  id: string;
  passed: boolean;
  used_tools: string[];
  missing_tools: string[];
  forbidden_hits: ForbiddenHit[];
  shell_calls: number;
  notes: string;
}

interface TranscriptRun {
  task: string;
  calls: ToolCallRecord[];
}

/** Tool names that execute a shell command, across the clients we grade. */
export const SHELL_TOOLS = new Set([
  "Bash",
  "BashOutput",
  "shell",
  "run_shell_command",
  "execute_command",
  "terminal",
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS_FILE = path.join(HERE, "tasks.json");

/** The shell command a call issued, or null when the call is not a shell call. */
export function shellCommandOf(call: ToolCallRecord): string | null {
  if (!SHELL_TOOLS.has(call.tool)) return null;
  const input = call.input ?? {};
  for (const key of ["command", "cmd", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function gradeTranscript(transcript: ToolCallRecord[], task: EvalTask): EvalResult {
  const used: string[] = [];
  for (const call of transcript) {
    if (!used.includes(call.tool)) used.push(call.tool);
  }

  const missing = task.expected_tools.filter((t) => !used.includes(t));

  const hits: ForbiddenHit[] = [];
  let shellCalls = 0;
  for (const call of transcript) {
    const command = shellCommandOf(call);
    if (command === null) continue;
    shellCalls++;
    for (const pattern of task.forbidden_shell_patterns) {
      if (new RegExp(pattern, "i").test(command)) {
        hits.push({ pattern, tool: call.tool, command });
      }
    }
  }

  const passed = missing.length === 0 && hits.length === 0;
  const notes = passed
    ? `called ${task.expected_tools.join(", ")}${shellCalls > 0 ? ` (${shellCalls} unrelated shell call(s))` : ""}`
    : [
        missing.length > 0 ? `never called ${missing.join(", ")}` : "",
        hits.length > 0 ? `shelled out: ${hits.map((h) => h.command).join(" | ")}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("; ");

  return { id: task.id, passed, used_tools: used, missing_tools: missing, forbidden_hits: hits, shell_calls: shellCalls, notes };
}

export function loadTasks(file: string = DEFAULT_TASKS_FILE): EvalTask[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { tasks: EvalTask[] };
  return parsed.tasks;
}

export function formatResults(results: EvalResult[]): string {
  const lines = results.map((r) => `${r.passed ? "PASS" : "FAIL"} ${r.id} — ${r.notes}`);
  const passed = results.filter((r) => r.passed).length;
  lines.push(`${passed}/${results.length} passed`);
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const asJson = argv.includes("--json");
  const tasksFlag = argv.indexOf("--tasks");
  const tasksFile = tasksFlag >= 0 ? argv[tasksFlag + 1] : DEFAULT_TASKS_FILE;
  const files = argv.filter((a, i) => !a.startsWith("--") && i !== tasksFlag + 1);

  if (files.length === 0) {
    process.stderr.write("usage: node eval/grade.ts <transcript.json> [more.json] [--tasks eval/tasks.json] [--json]\n");
    return 2;
  }

  const tasks = new Map(loadTasks(tasksFile).map((t) => [t.id, t]));
  const results: EvalResult[] = [];

  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { runs: TranscriptRun[] };
    for (const run of parsed.runs) {
      const task = tasks.get(run.task);
      if (!task) {
        process.stderr.write(`error: transcript ${file} references unknown task "${run.task}"\n`);
        return 2;
      }
      results.push(gradeTranscript(run.calls, task));
    }
  }

  process.stdout.write(asJson ? `${JSON.stringify(results, null, 2)}\n` : `${formatResults(results)}\n`);
  return results.every((r) => r.passed) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
```

- [ ] **Step 16: Run the eval tests, type-check and smoke the CLI**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run eval/grade.test.ts && npm run typecheck:eval`
Expected: `Test Files 1 passed`, `Tests 14 passed`; `tsc -p tsconfig.eval.json` prints nothing.

Run (CLI smoke — a two-run transcript, one correct and one shelled out):
```bash
cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null
cat > /tmp/crosspad-eval-smoke.json <<'JSON'
{"runs":[
 {"task":"repo-status-not-git-status","calls":[{"tool":"crosspad_repo_status","input":{}}]},
 {"task":"symbols-not-grep","calls":[{"tool":"Bash","input":{"command":"grep -rn PadLedController ~/GIT"}}]}
]}
JSON
node eval/grade.ts /tmp/crosspad-eval-smoke.json; echo "exit=$?"
```
Expected:
```
PASS repo-status-not-git-status — called crosspad_repo_status
FAIL symbols-not-grep — never called crosspad_search_symbols; shelled out: grep -rn PadLedController ~/GIT
1/2 passed
exit=1
```

- [ ] **Step 17: Run the whole suite**

Run: `cd /home/matixan/GIT/crosspad-mcp && export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npx vitest run && npx tsc --noEmit`
Expected: every test file passes (the eval file is now picked up by the `include` change); tsc silent.

- [ ] **Step 18: Commit**

```bash
cd /home/matixan/GIT/crosspad-mcp && git add eval/tasks.json eval/grade.ts eval/grade.test.ts tsconfig.eval.json vitest.config.ts && git commit -m "test(eval): 10-task shell-vs-tool eval with a transcript grader"
```

---

---

## Cross-plan verification (run 2026-08-26, before execution)

Mechanical checks over the three assembled plans plus the frozen contract:

| Check | Result |
|---|---|
| Placeholder scan (`TBD`, `TODO`, `implement later`, `similar to Task N`, `add appropriate …`, trailing `...`) | clean — the only `...` is the `Scenario` Protocol stub in plan B Task 1, which is valid Python |
| Task numbering | no duplicates, no gaps: core 1–12, scenarios/CLI/daemon 1–10, mcp 1–11 |
| Error codes | every code used across all plans is one of the 15 defined in the contract's `errors.py`; none invented |
| Cross-plan call sites (`set_mode`, `take_snapshot`, `run_scenario`, `open_console`, `open_cdc`, `kit_load`, `app_start`) | argument names and defaults at every call site match the definitions in plan A |
| Daemon op names | every op the MCP plan requests (`devices.list`, `devices.doctor`, `console.open/read/expect/reset/snapshot/close`, `cdc.transact`, `cdc.verb`, `snapshot.take`, `task.status/wait/cancel`, `serve.ping`, and in tasks 8–11 `midi.*`, `usbmode.set`, `ota.flash`, `console.wait_boot`, `scenario.list`, `knowledge.get`) is registered by plan B Task 9 — except `knowledge.get`, which plan C Task 10 explicitly flags as an op to add to `serve.py` |
| Hardware in tests | no test in any plan opens a real port, spawns the real daemon, or needs a board; every I/O boundary is injected (`serial_factory`, `Backends`, `discover_fn`, mocked `HilDaemon`) |

What this check does **not** cover, and should be done by a reader before task 1: semantic review of the ported regexes and byte sequences against the current firmware (`main/hil_control.cpp` moves), and whether each test actually fails for the stated reason.

### Correction found on real hardware (2026-08-26)

Plan A Task 4 pairs the ESP CDC and the STM console port by the longest common
prefix of pyserial's `location`. On the connected rev2 board the two interfaces
enumerate on **different USB paths**:

```
/dev/ttyACM1  0x303a:0x3456  'Crosspad'              serial='123456'        location=1-4:1.0
/dev/ttyACM0  0x0483:0x5740  'CrossPad MIDI+Serial'  serial='205D36865830'  location=7-2:1.0
```

They are two independent USB devices (separate cables/hubs), so no location
prefix is shared and the serial numbers are unrelated. Consequences for the
implementation:

- The single-pair rule (exactly one ESP side + exactly one STM side → one
  `Device`) is the primary rule and must not be gated on location similarity.
- Location prefix may only be used as a tie-breaker when **more than one** of
  each kind is present, and when it yields no match the discovery must return
  them as separate `Device`s and let `select()` raise `AMBIGUOUS_DEVICE` rather
  than guess.
- `Device.id` must come from the ESP serial (`123456` here — note it is not
  unique across boards, so the id derivation needs the port path mixed in when
  the serial is a known placeholder).
