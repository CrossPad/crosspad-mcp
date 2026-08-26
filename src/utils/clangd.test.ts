import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ClangdClient,
  ClangdError,
  findClangd,
  findCompileDb,
  compileDbCandidates,
  noCompileDbError,
  getClangdClient,
  seedFile,
  languageIdOf,
  uriToPath,
  _resetClangdForTest,
  type ChildLike,
  type CompileDb,
} from "./clangd.js";

// ── A fake child that speaks LSP framing ─────────────────────────────────────

class FakeClangd extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 909;
  killed: string[] = [];
  messages: Array<Record<string, unknown>> = [];
  private buf = Buffer.alloc(0);

  constructor() {
    super();
    this.stdin.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      for (;;) {
        const sep = this.buf.indexOf("\r\n\r\n");
        if (sep < 0) return;
        const len = Number(/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString())![1]);
        if (this.buf.length < sep + 4 + len) return;
        this.messages.push(JSON.parse(this.buf.subarray(sep + 4, sep + 4 + len).toString()));
        this.buf = this.buf.subarray(sep + 4 + len);
      }
    });
  }

  kill(sig?: string): boolean {
    this.killed.push(sig ?? "SIGTERM");
    return true;
  }

  /** Write one LSP message back, framed. */
  send(msg: unknown, opts: { split?: boolean } = {}): void {
    const body = JSON.stringify(msg);
    const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    if (opts.split) {
      // Prove the reader carries a partial frame across chunks.
      const at = Math.floor(framed.length / 2);
      this.stdout.write(framed.slice(0, at));
      this.stdout.write(framed.slice(at));
    } else {
      this.stdout.write(framed);
    }
  }

  reply(id: number, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  async waitMessages(n: number): Promise<Array<Record<string, unknown>>> {
    for (let i = 0; i < 400 && this.messages.length < n; i++) await new Promise((r) => setTimeout(r, 1));
    return this.messages;
  }

  /** Answer the pending `initialize` so start() resolves. */
  async completeHandshake(): Promise<void> {
    const [init] = await this.waitMessages(1);
    expect(init.method).toBe("initialize");
    this.reply(init.id as number, { capabilities: {} });
  }
}

const DB: CompileDb = { project: "pc", root: "/repo", dir: "/repo/build", file: "/repo/build/compile_commands.json", mtimeMs: 1 };

function makeClient(over: Partial<ConstructorParameters<typeof ClangdClient>[0]> = {}): {
  client: ClangdClient;
  children: FakeClangd[];
  spawns: string[][];
} {
  const children: FakeClangd[] = [];
  const spawns: string[][] = [];
  const client = new ClangdClient({
    binary: "/usr/bin/clangd",
    db: DB,
    spawnFn: (cmd, args) => {
      spawns.push([cmd, ...args]);
      const c = new FakeClangd();
      children.push(c);
      return c;
    },
    ...over,
  });
  return { client, children, spawns };
}

async function started(h: ReturnType<typeof makeClient>): Promise<FakeClangd> {
  const p = h.client.start();
  const child = h.children[0];
  await child.completeHandshake();
  await p;
  return child;
}

afterEach(() => {
  _resetClangdForTest();
});

// ── Handshake and framing ────────────────────────────────────────────────────

describe("ClangdClient handshake", () => {
  it("spawns clangd pointed at the compile-commands dir and initializes", async () => {
    const h = makeClient();
    const child = await started(h);
    expect(h.spawns[0][0]).toBe("/usr/bin/clangd");
    expect(h.spawns[0]).toContain("--compile-commands-dir=/repo/build");
    expect(h.spawns[0]).toContain("--background-index");
    const msgs = await child.waitMessages(2);
    expect(msgs[1].method).toBe("initialized");
    expect(h.client.alive).toBe(true);
  });

  it("start() is idempotent — a second call spawns nothing new", async () => {
    const h = makeClient();
    await started(h);
    await h.client.start();
    expect(h.children).toHaveLength(1);
  });

  it("reads a reply split across two chunks", async () => {
    const h = makeClient();
    const child = await started(h);
    const p = h.client.request("textDocument/hover", {});
    const msgs = await child.waitMessages(3);
    child.send({ jsonrpc: "2.0", id: msgs[2].id, result: { contents: "ok" } }, { split: true });
    await expect(p).resolves.toEqual({ contents: "ok" });
  });

  it("answers server→client requests so clangd is never left waiting", async () => {
    const h = makeClient();
    const child = await started(h);
    child.send({ jsonrpc: "2.0", id: 77, method: "window/workDoneProgress/create", params: { token: "t" } });
    const msgs = await child.waitMessages(3);
    expect(msgs[2]).toMatchObject({ id: 77, result: null });
  });

  it("tracks background indexing from $/progress", async () => {
    const h = makeClient();
    const child = await started(h);
    expect(h.client.indexing).toBe(false);
    child.send({ jsonrpc: "2.0", method: "$/progress", params: { token: "bg", value: { kind: "begin", title: "indexing" } } });
    await child.waitMessages(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.client.indexing).toBe(true);
    child.send({ jsonrpc: "2.0", method: "$/progress", params: { token: "bg", value: { kind: "end" } } });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.client.indexing).toBe(false);
  });

  it("surfaces an LSP error reply as LSP_ERROR", async () => {
    const h = makeClient();
    const child = await started(h);
    const p = h.client.request("textDocument/definition", {});
    const msgs = await child.waitMessages(3);
    child.send({ jsonrpc: "2.0", id: msgs[2].id, error: { code: -32602, message: "bad position" } });
    await expect(p).rejects.toMatchObject({ code: "LSP_ERROR" });
  });
});

// ── The two failure modes that must never hang the server ────────────────────

describe("ClangdClient timeouts", () => {
  it("kills the process and rejects with CLANGD_TIMEOUT when a request goes unanswered", async () => {
    const h = makeClient({ firstRequestTimeoutMs: 20 });
    // Nobody answers `initialize`.
    const assertion = expect(h.client.start()).rejects.toMatchObject({
      code: "CLANGD_TIMEOUT",
      hint: expect.stringContaining("index"),
    });
    const child = h.children[0];
    await assertion;
    expect(child.killed).toContain("SIGKILL");
    expect(h.client.alive).toBe(false);
  });

  it("a warm request gets the short budget, and its hint says clangd was restarted", async () => {
    const h = makeClient({ firstRequestTimeoutMs: 30_000, requestTimeoutMs: 20 });
    const child = await started(h);
    // The handshake reply already marked the client warm.
    const assertion = expect(h.client.request("workspace/symbol", { query: "x" })).rejects.toMatchObject({
      code: "CLANGD_TIMEOUT",
      hint: expect.stringContaining("restarted"),
    });
    await child.waitMessages(3);
    await assertion;
  });

  it("rejects everything in flight when clangd dies", async () => {
    const h = makeClient();
    const child = await started(h);
    const assertion = expect(h.client.request("textDocument/references", {})).rejects.toMatchObject({
      code: "CLANGD_DIED",
      hint: "clangd: fatal",
    });
    await child.waitMessages(3);
    child.stderr.write("clangd: fatal\n");
    await new Promise((r) => setTimeout(r, 5));
    child.emit("exit", 1, null);
    await assertion;
  });

  it("a spawn failure (bad binary) becomes CLANGD_DIED, not an uncaught throw", async () => {
    const children: FakeClangd[] = [];
    const client = new ClangdClient({
      binary: "/nope/clangd",
      db: DB,
      spawnFn: () => {
        const c = new FakeClangd();
        children.push(c);
        setTimeout(() => c.emit("error", new Error("spawn ENOENT")), 1);
        return c;
      },
    });
    await expect(client.start()).rejects.toMatchObject({ code: "CLANGD_DIED" });
  });
});

// ── Locating clangd ──────────────────────────────────────────────────────────

describe("findClangd", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clangd-"));

  it("returns null when nothing on PATH looks like clangd", () => {
    expect(findClangd({ PATH: tmp } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("finds a versioned clangd-N when there is no plain alias", () => {
    const bin = path.join(tmp, "clangd-18");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    expect(findClangd({ PATH: tmp } as NodeJS.ProcessEnv)).toBe(bin);
  });

  it("CROSSPAD_CLANGD wins, and a bogus one is null rather than a spawn attempt", () => {
    const bin = path.join(tmp, "clangd-18");
    expect(findClangd({ CROSSPAD_CLANGD: bin, PATH: "" } as NodeJS.ProcessEnv)).toBe(bin);
    expect(findClangd({ CROSSPAD_CLANGD: path.join(tmp, "absent"), PATH: tmp } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("getClangdClient", () => {
  it("returns a typed CLANGD_MISSING error with an install line, and never spawns", async () => {
    // Pointing CROSSPAD_CLANGD at a path that does not exist is the one way to
    // force the miss on a machine that does have clangd installed.
    const before = process.env.CROSSPAD_CLANGD;
    process.env.CROSSPAD_CLANGD = path.join(os.tmpdir(), "definitely-not-clangd");
    try {
      const e = (await getClangdClient(DB).catch((x: unknown) => x)) as ClangdError;
      expect(e).toBeInstanceOf(ClangdError);
      expect(e.code).toBe("CLANGD_MISSING");
      expect(e.hint).toMatch(/clangd|LLVM/);
    } finally {
      if (before === undefined) delete process.env.CROSSPAD_CLANGD;
      else process.env.CROSSPAD_CLANGD = before;
    }
  });

  it("reuses one server per index root", async () => {
    const children: FakeClangd[] = [];
    const spawnFn = () => {
      const c = new FakeClangd();
      children.push(c);
      void c.completeHandshake();
      return c;
    };
    const a = await getClangdClient(DB, { binary: "/usr/bin/clangd", spawnFn });
    const b = await getClangdClient(DB, { binary: "/usr/bin/clangd", spawnFn });
    expect(b).toBe(a);
    expect(children).toHaveLength(1);
  });
});

// ── compile_commands.json discovery ──────────────────────────────────────────

describe("compile db discovery", () => {
  it("names the build that would produce the missing database", () => {
    const e = noCompileDbError("idf");
    expect(e.code).toBe("NO_COMPILE_COMMANDS");
    expect(e.hint).toContain("crosspad_build platform=idf");
    expect(noCompileDbError().hint).toContain("crosspad_build platform=pc");
  });

  it("picks the most recently built database when several exist", () => {
    // compileDbCandidates reads the real roots; whatever it finds must come
    // back newest-first, which is the rule the default `project` relies on.
    const idf = compileDbCandidates("idf");
    for (let i = 1; i < idf.length; i++) expect(idf[i - 1].mtimeMs).toBeGreaterThanOrEqual(idf[i].mtimeMs);
    const best = findCompileDb();
    if (best) expect(fs.existsSync(best.file)).toBe(true);
  });
});

// ── The cold-index trap ──────────────────────────────────────────────────────

describe("workspaceSymbol warm-up", () => {
  // Measured against a real clangd: --background-index does not start until a
  // document is open, so a name lookup on a fresh server answers "no such
  // symbol" instantly and forever. These two tests pin that fix.
  const seeded = (): { db: CompileDb; dir: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccdb-"));
    const src = path.join(dir, "seed.cpp");
    fs.writeFileSync(src, "int main() { return 0; }\n");
    fs.writeFileSync(
      path.join(dir, "compile_commands.json"),
      JSON.stringify([{ directory: dir, command: "c++ -c seed.cpp", file: src }]),
    );
    return { db: { project: "pc", root: dir, dir, file: path.join(dir, "compile_commands.json"), mtimeMs: 1 }, dir };
  };

  it("seedFile picks the first entry of the compilation database", () => {
    const { db, dir } = seeded();
    expect(seedFile(db)).toBe(path.join(dir, "seed.cpp"));
    expect(seedFile({ ...db, file: path.join(dir, "absent.json") })).toBeNull();
  });

  it("opens a seed translation unit before querying, so indexing actually starts", async () => {
    const { db } = seeded();
    const h = makeClient({ db });
    const child = await started(h);
    const p = h.client.workspaceSymbol("Anything");
    const msgs = await child.waitMessages(4);
    expect(msgs[2].method).toBe("textDocument/didOpen");
    child.reply(msgs[3].id as number, [{ name: "Anything", location: { uri: "file:///x.cpp", range: {} } }]);
    await expect(p).resolves.toHaveLength(1);
  });

  it("keeps re-asking while clangd reports indexing, then answers empty", async () => {
    const { db } = seeded();
    const h = makeClient({ db, indexWaitMs: 400, indexPollMs: 10, indexGraceMs: 10 });
    const child = await started(h);
    const p = h.client.workspaceSymbol("Later");
    // First answer is empty while the index is still building…
    const first = await child.waitMessages(4);
    child.send({ jsonrpc: "2.0", method: "$/progress", params: { token: "bg", value: { kind: "begin", title: "indexing" } } });
    child.reply(first[3].id as number, []);
    // …the second finds it, which only happens because the client asked again.
    const second = await child.waitMessages(5);
    child.reply(second[4].id as number, [{ name: "Later", location: { uri: "file:///x.cpp", range: {} } }]);
    await expect(p).resolves.toHaveLength(1);
  });

  it("gives up quickly when nothing is indexing — an empty answer is then the truth", async () => {
    const { db } = seeded();
    const h = makeClient({ db, indexWaitMs: 5000, indexPollMs: 5, indexGraceMs: 0 });
    const child = await started(h);
    const p = h.client.workspaceSymbol("Nope");
    const msgs = await child.waitMessages(4);
    child.reply(msgs[3].id as number, []);
    await expect(p).resolves.toEqual([]);
  });
});

describe("small helpers", () => {
  it("maps extensions to LSP language ids", () => {
    expect(languageIdOf("/a/b.cpp")).toBe("cpp");
    expect(languageIdOf("/a/b.h")).toBe("cpp");
    expect(languageIdOf("/a/b.c")).toBe("c");
  });

  it("converts file uris back to paths and leaves others alone", () => {
    expect(uriToPath("file:///repo/main.cpp")).toBe("/repo/main.cpp");
    expect(uriToPath("not-a-uri")).toBe("not-a-uri");
  });
});
