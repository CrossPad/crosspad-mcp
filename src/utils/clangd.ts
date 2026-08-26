// src/utils/clangd.ts — a minimal LSP client for clangd, driven over stdio.
//
// Why a language server at all: `crosspad_search_symbols` greps for definition
// lines, which answers "where is this declared" and nothing else. "Who calls
// this", "what overrides this", "what type does `auto` actually bind to" are
// questions only a compiler-backed index can answer, and clangd already has
// one — every repo here emits `compile_commands.json` as a side effect of
// building.
//
// The framing here is LSP's `Content-Length` header, not the daemon's newline
// NDJSON, so the reader is its own thing; the spawn / pending-id / kill
// escalation shape is deliberately the same as src/hil/daemon.ts.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { pathToFileURL, fileURLToPath } from "node:url";
import { CROSSPAD_PC_ROOT, CROSSPAD_IDF_ROOT, IS_WINDOWS } from "../config.js";

// ── Errors ───────────────────────────────────────────────────────────────────

export const CLANGD_MISSING = "CLANGD_MISSING";
export const NO_COMPILE_COMMANDS = "NO_COMPILE_COMMANDS";
export const CLANGD_TIMEOUT = "CLANGD_TIMEOUT";
export const CLANGD_DIED = "CLANGD_DIED";
export const LSP_ERROR = "LSP_ERROR";

/** Same `{code, message, hint, details}` shape the daemon errors carry, so the
 *  tool layer can render both through one envelope. */
export class ClangdError extends Error {
  code: string;
  hint?: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, hint?: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ClangdError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

// ── Locating the binary ──────────────────────────────────────────────────────

// Distros ship clangd under a versioned name and often no unsuffixed alias, so
// a bare `clangd` lookup reports "not installed" on a machine that has it.
const CLANGD_NAMES = ["clangd", "clangd-20", "clangd-19", "clangd-18", "clangd-17", "clangd-16", "clangd-15", "clangd-14"];

export const CLANGD_INSTALL_HINT =
  IS_WINDOWS
    ? "install LLVM (winget install LLVM.LLVM) or set CROSSPAD_CLANGD to a clangd.exe"
    : os.platform() === "darwin"
      ? "brew install llvm (clangd ships with it), or set CROSSPAD_CLANGD"
      : "sudo apt install clangd  (or: sudo apt install clangd-18), or set CROSSPAD_CLANGD";

function isExecutable(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `$CROSSPAD_CLANGD` → the first `clangd*` on `$PATH`. Returns null when there
 * is none; the tool turns that into a typed ENV error rather than spawning a
 * command that does not exist and waiting for a reply that never comes.
 */
export function findClangd(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.CROSSPAD_CLANGD;
  if (explicit && explicit.length > 0) return isExecutable(explicit) ? explicit : null;

  const exts = IS_WINDOWS ? [".exe", ".bat", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const name of CLANGD_NAMES) {
      for (const ext of exts) {
        const full = path.join(dir, name + ext);
        if (isExecutable(full)) return full;
      }
    }
  }
  return null;
}

// ── Locating compile_commands.json ───────────────────────────────────────────

export type ProjectId = "pc" | "idf";

export interface CompileDb {
  project: ProjectId;
  /** Repo root — clangd's workspace root, and what file paths are relative to. */
  root: string;
  /** Directory holding compile_commands.json (clangd's --compile-commands-dir). */
  dir: string;
  file: string;
  mtimeMs: number;
}

/** The `crosspad_build` invocation that would produce the missing database. */
export const BUILD_HINT: Record<ProjectId, string> = {
  pc: "crosspad_build platform=pc",
  idf: "crosspad_build platform=idf",
};

function statMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Candidate build directories per project. crosspad-pc has one `build`;
 * platform-idf has a `build`-prefixed one per hardware revision and per feature
 * profile (`build_v1`, `build_v2`, `build_lite`, …), so the newest one wins —
 * it is the one whose flags match what the developer last compiled.
 */
export function compileDbCandidates(project: ProjectId): CompileDb[] {
  const root = project === "pc" ? CROSSPAD_PC_ROOT : CROSSPAD_IDF_ROOT;
  const dirs: string[] = [];
  if (project === "pc") {
    dirs.push(path.join(root, "build"));
  } else {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith("build")) dirs.push(path.join(root, e.name));
    }
  }

  const found: CompileDb[] = [];
  for (const dir of dirs) {
    const file = path.join(dir, "compile_commands.json");
    const mtimeMs = statMtime(file);
    if (mtimeMs > 0) found.push({ project, root, dir, file, mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/**
 * The compilation database to index. With no `project`, whichever exists —
 * and if both do, the one built most recently, because that is the tree the
 * caller is working in.
 */
export function findCompileDb(project?: ProjectId): CompileDb | null {
  const projects: ProjectId[] = project ? [project] : ["pc", "idf"];
  const all = projects.flatMap(compileDbCandidates);
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all[0] ?? null;
}

/** Typed "there is no index" error naming the build that would create one. */
export function noCompileDbError(project?: ProjectId): ClangdError {
  const which: ProjectId[] = project ? [project] : ["pc", "idf"];
  const builds = which.map((p) => BUILD_HINT[p]).join(" or ");
  return new ClangdError(
    NO_COMPILE_COMMANDS,
    `no compile_commands.json for ${which.join("/")} — clangd has nothing to index`,
    `run ${builds} first (crosspad-pc emits build/compile_commands.json; platform-idf emits one per build*/ directory)`,
    { searched: which },
  );
}

/**
 * A translation unit to open purely to get clangd working.
 *
 * Measured, not guessed: `--background-index` does nothing until the client
 * opens a document — a `workspace/symbol` query on a freshly started clangd
 * answers instantly with an empty list, indefinitely. Opening one TU starts the
 * index, and the query then works within seconds. The first entry of
 * compile_commands.json is as good a seed as any, and reading the head of the
 * file avoids parsing a database that runs to tens of megabytes.
 */
export function seedFile(db: CompileDb): string | null {
  let head: string;
  try {
    const fd = fs.openSync(db.file, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const m of head.matchAll(/"file"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const file = m[1].replace(/\\(.)/g, "$1");
    const abs = path.isAbsolute(file) ? file : path.resolve(db.dir, file);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
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

// ── Client ───────────────────────────────────────────────────────────────────

// The first request on a cold tree waits for clangd to parse the translation
// unit and load (or build) its background index; on platform-idf that is ~1950
// compilation units. Later requests hit a warm index and should never take
// this long — a minute of silence there means clangd is wedged, not busy.
export const FIRST_REQUEST_TIMEOUT_MS = 120_000;
export const REQUEST_TIMEOUT_MS = 20_000;
// How long a name lookup may wait for the background index to produce it, and
// how long it waits for indexing to even begin before concluding the symbol is
// genuinely not there.
export const INDEX_WAIT_MS = 60_000;
export const INDEX_POLL_MS = 1000;
export const INDEX_GRACE_MS = 3000;
const STDERR_RING = 50;
const TERM_AFTER_MS = 1000;
const KILL_AFTER_MS = 4000;

export interface ClangdOpts {
  binary: string;
  db: CompileDb;
  spawnFn?: SpawnFn;
  firstRequestTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Index-wait knobs; overridden by tests so they need no real waiting. */
  indexWaitMs?: number;
  indexPollMs?: number;
  indexGraceMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: ClangdError) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface Position {
  line: number;
  character: number;
}

export class ClangdClient {
  private proc: ChildLike | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = Buffer.alloc(0);
  private stderrLines: string[] = [];
  private stderrBuf = "";
  private starting: Promise<void> | null = null;
  private opened = new Set<string>();
  private warm = false;
  private indexingTitles = new Set<string>();
  private sawIndex = false;
  private seeded = false;
  private termTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly spawnFn: SpawnFn;

  constructor(private readonly opts: ClangdOpts) {
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
  }

  get alive(): boolean {
    return this.proc !== null;
  }

  /** True once a request has completed — i.e. the index is loaded. */
  get warmed(): boolean {
    return this.warm;
  }

  /** True while clangd reports a background-indexing progress token. */
  get indexing(): boolean {
    return this.indexingTitles.size > 0;
  }

  /** True once clangd has started indexing at least once this session. */
  get sawIndexing(): boolean {
    return this.sawIndex;
  }

  get root(): string {
    return this.opts.db.root;
  }

  stderrTail(n: number = STDERR_RING): string {
    return this.stderrLines.slice(-n).join("\n");
  }

  /** Spawn clangd and complete the `initialize` handshake. Idempotent; a
   *  second call while starting shares the same promise. */
  start(): Promise<void> {
    if (this.proc) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.buf = Buffer.alloc(0);
    this.stderrBuf = "";
    this.stderrLines = [];
    this.opened.clear();
    const args = [
      `--compile-commands-dir=${this.opts.db.dir}`,
      // Background indexing is what makes references/call hierarchy work
      // across translation units; without it clangd only knows the open file.
      "--background-index",
      "--limit-results=200",
      "--log=error",
    ];
    const child = this.spawnFn(this.opts.binary, args, { cwd: this.opts.db.root });
    this.proc = child;
    child.stdout?.on("data", (c: Buffer | string) => this.ingest(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    child.stderr?.on("data", (c: Buffer | string) => this.ingestStderr(c.toString()));
    child.on("exit", (code: number | null) => this.onExit(code, null));
    // A missing binary surfaces as 'error', not a non-zero exit; unhandled it
    // would take the whole MCP server down.
    child.on("error", (e: Error) => this.onExit(null, e));

    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.opts.db.root).href,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: false },
          implementation: { linkSupport: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: {},
        },
        workspace: { symbol: {} },
        window: { workDoneProgress: true },
      },
    });
    this.notify("initialized", {});
  }

  /**
   * One LSP request. The first one gets the generous index warm-up budget;
   * after that a timeout means clangd is stuck, so the process is killed and
   * the next call gets a fresh one — a hung language server must never become
   * a hung MCP server.
   */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const proc = this.proc;
    if (!proc || !proc.stdin) {
      return Promise.reject(new ClangdError(CLANGD_DIED, "clangd is not running", this.lastStderr()));
    }
    const budget = timeoutMs ?? (this.warm ? this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS : this.opts.firstRequestTimeoutMs ?? FIRST_REQUEST_TIMEOUT_MS);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const cold = !this.warm;
        this.kill();
        reject(
          new ClangdError(
            CLANGD_TIMEOUT,
            `clangd ${method} did not answer within ${budget} ms`,
            cold
              ? "the background index was still building; retry — the second call reuses the index clangd just wrote"
              : "clangd was restarted; retry, and check `crosspad_build` produced a current compile_commands.json",
            { method, timeout_ms: budget },
          ),
        );
      }, budget);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer, method });
      try {
        proc.stdin!.write(frame({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        this.settle(id);
        reject(new ClangdError(CLANGD_DIED, `write to clangd failed: ${(e as Error).message}`, this.lastStderr()));
      }
    });
  }

  notify(method: string, params: unknown): void {
    try {
      this.proc?.stdin?.write(frame({ jsonrpc: "2.0", method, params }));
    } catch {
      // the exit handler already rejected everything in flight
    }
  }

  /**
   * clangd answers position requests only for documents the client has opened,
   * so every file is pushed once per session. Sending its text (rather than
   * relying on the file on disk) is also what lets the answer reflect an edit
   * that has not been saved yet.
   */
  openFile(file: string): void {
    const abs = path.resolve(file);
    if (this.opened.has(abs)) return;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch (e) {
      throw new ClangdError("ENOENT", `cannot read ${abs}: ${(e as Error).message}`, "pass a path that exists in the checkout");
    }
    this.opened.add(abs);
    this.notify("textDocument/didOpen", {
      textDocument: { uri: pathToFileURL(abs).href, languageId: languageIdOf(abs), version: 1, text },
    });
  }

  /** Open one TU so `--background-index` has something to start from. Cheap
   *  and idempotent; a no-op once any file has been opened. */
  warmup(): void {
    if (this.seeded || this.opened.size > 0) {
      this.seeded = true;
      return;
    }
    this.seeded = true;
    const seed = seedFile(this.opts.db);
    if (!seed) return;
    try {
      this.openFile(seed);
    } catch {
      // a database entry pointing at a deleted file is not worth failing over
    }
  }

  /**
   * Name → index hits, waiting out the background index.
   *
   * A cold clangd answers `workspace/symbol` immediately with an empty list,
   * which is indistinguishable from "no such symbol" unless you wait: hence
   * the seed open above, then a poll while indexing is in flight. Once nothing
   * is indexing and the grace period has passed, an empty answer is the truth.
   */
  async workspaceSymbol<T = unknown>(query: string): Promise<T[]> {
    this.warmup();
    const deadline = Date.now() + (this.opts.indexWaitMs ?? INDEX_WAIT_MS);
    const grace = this.opts.indexGraceMs ?? INDEX_GRACE_MS;
    const poll = this.opts.indexPollMs ?? INDEX_POLL_MS;
    const start = Date.now();
    for (;;) {
      const hits = (await this.request<T[] | null>("workspace/symbol", { query })) ?? [];
      if (hits.length > 0) return hits;
      const elapsed = Date.now() - start;
      if (Date.now() >= deadline) return [];
      if (!this.indexing && !this.sawIndex && elapsed >= grace) return [];
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  /** `shutdown` + `exit`, then SIGTERM/SIGKILL if it lingers. Idempotent. */
  async stop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    try {
      await this.request("shutdown", null, 2000);
    } catch {
      // a clangd that will not answer shutdown gets signalled below
    }
    this.notify("exit", null);
    if (this.termTimer || this.killTimer) return; // a stop() is already in flight
    this.termTimer = setTimeout(() => {
      this.termTimer = null;
      if (this.proc === p) signal(p, "SIGTERM");
    }, TERM_AFTER_MS);
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.proc === p) signal(p, "SIGKILL");
    }, KILL_AFTER_MS);
  }

  /** Hard kill — used on timeout, where the process is presumed wedged. */
  kill(): void {
    const p = this.proc;
    if (!p) return;
    signal(p, "SIGKILL");
    this.onExit(null, new Error("clangd killed after a request timeout"));
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    clearTimeout(p.timer);
    return p;
  }

  private lastStderr(): string | undefined {
    const last = this.stderrLines[this.stderrLines.length - 1];
    return last && last.length > 0 ? last : undefined;
  }

  /** `Content-Length: N\r\n\r\n<json>` framing, with a carried partial tail.
   *  Lengths are byte counts, not characters, so the buffer stays a Buffer. */
  private ingest(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buf.subarray(0, sep).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Unparseable header — drop it rather than desynchronise forever.
        this.buf = this.buf.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString("utf-8");
      this.buf = this.buf.subarray(start + len);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    // A server→client request (progress token creation, capability
    // registration). Unanswered, clangd waits on it and the next real request
    // looks like a hang, so everything gets a null result.
    if (msg.method !== undefined && msg.id !== undefined) {
      this.replyOk(msg.id as number | string);
      return;
    }
    if (msg.method !== undefined) {
      this.onNotification(msg.method as string, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.settle(msg.id);
    if (!p) return;
    this.warm = true;
    const e = msg.error as { code?: number; message?: string } | undefined;
    if (e) {
      p.reject(new ClangdError(LSP_ERROR, `clangd ${p.method}: ${e.message ?? "error"}`, undefined, { lsp_code: e.code }));
      return;
    }
    p.resolve(msg.result);
  }

  private replyOk(id: number | string): void {
    try {
      this.proc?.stdin?.write(frame({ jsonrpc: "2.0", id, result: null }));
    } catch {
      /* */
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "$/progress") return;
    const p = params as { token?: unknown; value?: { kind?: string; title?: string } } | undefined;
    const token = String(p?.token ?? "");
    const kind = p?.value?.kind;
    if (kind === "begin" && /index/i.test(p?.value?.title ?? "")) {
      this.indexingTitles.add(token);
      this.sawIndex = true;
    }
    else if (kind === "end") this.indexingTitles.delete(token);
  }

  private ingestStderr(text: string): void {
    this.stderrBuf += text;
    const parts = this.stderrBuf.split("\n");
    this.stderrBuf = parts.pop() ?? "";
    for (const line of parts) {
      const s = line.replace(/\r$/, "");
      if (s.length > 0) this.stderrLines.push(s);
    }
    if (this.stderrLines.length > STDERR_RING) {
      this.stderrLines.splice(0, this.stderrLines.length - STDERR_RING);
    }
  }

  private onExit(code: number | null, spawnError: Error | null): void {
    if (this.proc === null) return;
    this.proc = null;
    this.opened.clear();
    this.indexingTitles.clear();
    this.seeded = false;
    if (this.termTimer) { clearTimeout(this.termTimer); this.termTimer = null; }
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
    const why = spawnError ? `clangd failed: ${spawnError.message}` : `clangd exited with code ${code ?? "null"}`;
    const err = new ClangdError(CLANGD_DIED, why, this.lastStderr(), { exit_code: code, stderr_tail: this.stderrTail() });
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(err);
  }
}

/** kill() on an already-dead child throws on some platforms; never fatal. */
function signal(p: ChildLike, sig: NodeJS.Signals): void {
  try {
    p.kill(sig);
  } catch {
    /* already gone */
  }
}

function frame(msg: unknown): string {
  const body = JSON.stringify(msg);
  return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

/** clangd wants a languageId; headers are compiled as C++ everywhere here. */
export function languageIdOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".c") return "c";
  if (ext === ".m" || ext === ".mm") return "objective-c";
  return "cpp";
}

/** Absolute path out of an LSP `file://` uri, or the string unchanged. */
export function uriToPath(uri: string): string {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

// ── One client per index root ────────────────────────────────────────────────

const clients = new Map<string, ClangdClient>();

/**
 * Lazily start (and then reuse) the client for a compilation database. One
 * server per index root: clangd's index is per-workspace, and a second process
 * over the same tree would rebuild the whole thing for nothing.
 */
export async function getClangdClient(db: CompileDb, opts: Partial<ClangdOpts> = {}): Promise<ClangdClient> {
  const key = db.dir;
  const existing = clients.get(key);
  if (existing && existing.alive) return existing;
  const binary = opts.binary ?? findClangd();
  if (!binary) {
    throw new ClangdError(
      CLANGD_MISSING,
      "clangd is not installed (or not on PATH)",
      CLANGD_INSTALL_HINT,
      { looked_for: CLANGD_NAMES },
    );
  }
  const client = new ClangdClient({ ...opts, binary, db });
  clients.set(key, client);
  try {
    await client.start();
  } catch (e) {
    clients.delete(key);
    throw e;
  }
  return client;
}

/** Stop every running server — called on MCP server shutdown and by tests. */
export async function stopAllClangd(): Promise<void> {
  const all = [...clients.values()];
  clients.clear();
  await Promise.all(all.map((c) => c.stop().catch(() => undefined)));
}

/** @internal test-only */
export function _resetClangdForTest(): void {
  for (const c of clients.values()) c.kill();
  clients.clear();
}
