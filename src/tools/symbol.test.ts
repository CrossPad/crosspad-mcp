import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import {
  crosspadSymbol,
  parseHover,
  rankCandidates,
  kindName,
  flattenDocumentSymbols,
  registerSymbolTool,
  SYMBOL_ACTIONS,
} from "./symbol.js";
import { ClangdError, type ClangdClient, type CompileDb } from "../utils/clangd.js";
import { fakeServer } from "../testing/fake-server.js";
import type { ToolContext } from "../tool-context.js";

// ── A stand-in for clangd: canned LSP replies, no process anywhere ───────────

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "symbol-"));
const SRC = path.join(ROOT, "pad_manager.cpp");
fs.writeFileSync(
  SRC,
  [
    "#include \"PadManager.hpp\"",
    "",
    "void PadManager::handlePadPress(uint8_t idx) {",
    "    active_ = idx;",
    "}",
  ].join("\n"),
);
const SRC_URI = pathToFileURL(SRC).href;

const DB: CompileDb = { project: "pc", root: ROOT, dir: path.join(ROOT, "build"), file: path.join(ROOT, "build", "compile_commands.json"), mtimeMs: 7 };

const range = (line: number, character = 5) => ({ start: { line, character }, end: { line, character: character + 4 } });

interface FakeOpts {
  replies?: Record<string, unknown>;
  indexing?: boolean;
  opened?: string[];
}

function fakeClient(opts: FakeOpts = {}): { client: ClangdClient; asked: Array<{ method: string; params: unknown }> } {
  const asked: Array<{ method: string; params: unknown }> = [];
  const opened = opts.opened ?? [];
  const client = {
    root: ROOT,
    alive: true,
    warmed: true,
    indexing: opts.indexing ?? false,
    openFile: (f: string) => opened.push(f),
    request: async (method: string, params: unknown) => {
      asked.push({ method, params });
      if (!(method in (opts.replies ?? {}))) throw new ClangdError("LSP_ERROR", `no canned reply for ${method}`);
      return opts.replies![method];
    },
    // The real client waits out the background index here; the tool only cares
    // that it gets a list back.
    workspaceSymbol: async (query: string) => {
      asked.push({ method: "workspace/symbol", params: { query } });
      return (opts.replies?.["workspace/symbol"] as unknown[]) ?? [];
    },
  } as unknown as ClangdClient;
  return { client, asked };
}

const call = (args: Parameters<typeof crosspadSymbol>[0], opts: FakeOpts = {}, db: CompileDb | null = DB) =>
  crosspadSymbol(
    args,
    async () => fakeClient(opts).client,
    () => db,
  );

const structured = async (r: Awaited<ReturnType<typeof crosspadSymbol>>) => r.structuredContent;

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("rankCandidates", () => {
  const sym = (name: string, containerName?: string) => ({ name, containerName, location: { uri: SRC_URI, range: range(0) } });

  it("puts an exact qualified match first", () => {
    const ranked = rankCandidates([sym("handlePadPressLater"), sym("handlePadPress", "PadManager")], "PadManager::handlePadPress");
    expect(ranked[0].name).toBe("handlePadPress");
  });

  it("prefers the exact bare name over a fuzzy prefix match", () => {
    const ranked = rankCandidates([sym("PadManagerTest"), sym("PadManager")], "PadManager");
    expect(ranked[0].name).toBe("PadManager");
  });
});

describe("parseHover", () => {
  it("pulls the declaration out of the code block and keeps the doc comment", () => {
    const h = parseHover({ kind: "markdown", value: "```cpp\nvoid handlePadPress(uint8_t idx)\n```\nFires the pad." });
    expect(h?.signature).toBe("void handlePadPress(uint8_t idx)");
    expect(h?.text).toContain("Fires the pad.");
  });

  it("is null for an empty hover rather than an empty object", () => {
    expect(parseHover(null)).toBeNull();
    expect(parseHover([])).toBeNull();
  });
});

describe("kindName", () => {
  it("names LSP SymbolKind numbers", () => {
    expect(kindName(5)).toBe("class");
    expect(kindName(12)).toBe("function");
    expect(kindName(undefined)).toBeUndefined();
    expect(kindName(99)).toBe("kind-99");
  });
});

describe("flattenDocumentSymbols", () => {
  it("flattens the tree, indenting by depth and keeping 1-based lines", () => {
    const out = flattenDocumentSymbols(
      [
        {
          name: "PadManager",
          kind: 5,
          range: range(2),
          selectionRange: range(2),
          children: [{ name: "handlePadPress", kind: 6, range: range(3), selectionRange: range(3) }],
        },
      ],
      SRC,
      new Map(),
    );
    expect(out.map((s) => s.name)).toEqual(["PadManager", "  handlePadPress"]);
    expect(out[0].line).toBe(3);
    expect(out[1].kind).toBe("method");
  });
});

// ── The tool ─────────────────────────────────────────────────────────────────

describe("crosspad_symbol actions", () => {
  const workspaceSymbol = [{ name: "handlePadPress", kind: 6, containerName: "PadManager", location: { uri: SRC_URI, range: range(2, 18) } }];

  it("resolves a name through workspace/symbol, then answers definition", async () => {
    const r = await call(
      { action: "definition", symbol: "PadManager::handlePadPress" },
      { replies: { "workspace/symbol": workspaceSymbol, "textDocument/definition": { uri: SRC_URI, range: range(2, 18) } } },
    );
    const s = (await structured(r)) as Record<string, any>;
    expect(s.success).toBe(true);
    expect(s.project).toBe("pc");
    expect(s.resolved).toMatchObject({ file: SRC, line: 3, character: 19, name: "handlePadPress", kind: "method" });
    expect(s.locations).toHaveLength(1);
    // 1-based line, with the source line as a preview.
    expect(s.locations[0]).toMatchObject({ file: SRC, line: 3, preview: "void PadManager::handlePadPress(uint8_t idx) {" });
  });

  it("references asks with includeDeclaration false — the caller already has the declaration", async () => {
    const { client, asked } = fakeClient({
      replies: { "workspace/symbol": workspaceSymbol, "textDocument/references": [{ uri: SRC_URI, range: range(3) }] },
    });
    const r = await crosspadSymbol({ action: "references", symbol: "handlePadPress" }, async () => client, () => DB);
    const s = (await structured(r)) as Record<string, any>;
    expect(s.count).toBe(1);
    const ref = asked.find((a) => a.method === "textDocument/references")!;
    expect((ref.params as any).context).toEqual({ includeDeclaration: false });
  });

  it("hover returns the parsed card under its own field", async () => {
    const r = await call(
      { action: "hover", symbol: "handlePadPress" },
      {
        replies: {
          "workspace/symbol": workspaceSymbol,
          "textDocument/hover": { contents: { kind: "markdown", value: "```cpp\nvoid handlePadPress(uint8_t)\n```\ndocs" } },
        },
      },
    );
    const s = (await structured(r)) as Record<string, any>;
    expect(s.hover.signature).toBe("void handlePadPress(uint8_t)");
    expect(s.locations).toBeUndefined();
  });

  it("implementations uses textDocument/implementation", async () => {
    const { client, asked } = fakeClient({
      replies: { "workspace/symbol": workspaceSymbol, "textDocument/implementation": [{ uri: SRC_URI, range: range(2) }] },
    });
    const r = await crosspadSymbol({ action: "implementations", symbol: "IPadLogicHandler" }, async () => client, () => DB);
    expect((await structured(r)).success).toBe(true);
    expect(asked.map((a) => a.method)).toContain("textDocument/implementation");
  });

  it("call_hierarchy prepares an item, then lists incoming callers with their call lines", async () => {
    const item = { name: "handlePadPress", kind: 6, uri: SRC_URI, range: range(2), selectionRange: range(2) };
    const r = await call(
      { action: "call_hierarchy", symbol: "handlePadPress" },
      {
        replies: {
          "workspace/symbol": workspaceSymbol,
          "textDocument/prepareCallHierarchy": [item],
          "callHierarchy/incomingCalls": [
            { from: { name: "onPadEvent", kind: 12, uri: SRC_URI, range: range(9), selectionRange: range(9) }, fromRanges: [range(11), range(14)] },
          ],
        },
      },
    );
    const s = (await structured(r)) as Record<string, any>;
    expect(s.calls).toEqual([
      { caller: "onPadEvent", kind: "function", detail: undefined, file: SRC, line: 10, call_lines: [12, 15] },
    ]);
  });

  it("document_symbols needs no position, only a file", async () => {
    const { client, asked } = fakeClient({
      replies: {
        "textDocument/documentSymbol": [
          { name: "PadManager", kind: 5, range: range(2), selectionRange: range(2), children: [] },
        ],
      },
    });
    const r = await crosspadSymbol({ action: "document_symbols", file: SRC }, async () => client, () => DB);
    const s = (await structured(r)) as Record<string, any>;
    expect(s.symbols[0]).toMatchObject({ name: "PadManager", kind: "class", line: 3 });
    // No name to resolve, so the index was never queried.
    expect(asked.map((a) => a.method)).toEqual(["textDocument/documentSymbol"]);
  });

  it("document_symbols without a file is a typed BAD_INPUT, not a crash", async () => {
    const s = (await structured(await call({ action: "document_symbols" }, { replies: {} }))) as Record<string, any>;
    expect(s.success).toBe(false);
    expect(s.error.code).toBe("BAD_INPUT");
    expect(s.error.hint).toContain("file=");
  });

  it("an explicit file+line skips the index and converts to 0-based LSP coordinates", async () => {
    const { client, asked } = fakeClient({ replies: { "textDocument/definition": [] } });
    await crosspadSymbol({ action: "definition", file: SRC, line: 4, character: 9 }, async () => client, () => DB);
    const def = asked.find((a) => a.method === "textDocument/definition")!;
    expect((def.params as any).position).toEqual({ line: 3, character: 8 });
    expect(asked.some((a) => a.method === "workspace/symbol")).toBe(false);
  });

  it("reports every candidate when a name was ambiguous", async () => {
    const s = (await structured(
      await call(
        { action: "definition", symbol: "Pad" },
        {
          replies: {
            "workspace/symbol": [
              { name: "PadManager", kind: 5, location: { uri: SRC_URI, range: range(2) } },
              { name: "PadAnimator", kind: 5, location: { uri: SRC_URI, range: range(4) } },
            ],
            "textDocument/definition": [{ uri: SRC_URI, range: range(2) }],
          },
        },
      ),
    )) as Record<string, any>;
    expect(s.candidates).toHaveLength(2);
    expect(s.resolved.name).toBe("PadManager");
  });

  it("truncates at `limit` and says so", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ uri: SRC_URI, range: range(i) }));
    const s = (await structured(
      await call({ action: "references", symbol: "handlePadPress", limit: 2 }, { replies: { "workspace/symbol": workspaceSymbol, "textDocument/references": many } }),
    )) as Record<string, any>;
    expect(s.count).toBe(2);
    expect(s.truncated).toBe(true);
  });
});

describe("crosspad_symbol environment errors", () => {
  it("no compile_commands.json names the build that would create one", async () => {
    const s = (await structured(await call({ symbol: "x" }, {}, null))) as Record<string, any>;
    expect(s.success).toBe(false);
    expect(s.error.code).toBe("NO_COMPILE_COMMANDS");
    expect(s.error.hint).toContain("crosspad_build");
  });

  it("a missing clangd is a typed error carrying the install line", async () => {
    const r = await crosspadSymbol(
      { symbol: "x" },
      async () => {
        throw new ClangdError("CLANGD_MISSING", "clangd is not installed (or not on PATH)", "sudo apt install clangd");
      },
      () => DB,
    );
    const s = (await structured(r)) as Record<string, any>;
    expect(s.success).toBe(false);
    expect(s.error).toMatchObject({ code: "CLANGD_MISSING", hint: "sudo apt install clangd" });
    expect(r.isError).toBe(true);
  });

  it("a timeout comes back as an error envelope, not a rejected promise", async () => {
    const r = await crosspadSymbol(
      { symbol: "x" },
      async () => {
        throw new ClangdError("CLANGD_TIMEOUT", "clangd workspace/symbol did not answer within 20000 ms", "retry", { method: "workspace/symbol" });
      },
      () => DB,
    );
    const s = (await structured(r)) as Record<string, any>;
    expect(s.error).toMatchObject({ code: "CLANGD_TIMEOUT", details: { method: "workspace/symbol" } });
  });

  it("an unindexed name suggests the grep-based tool instead", async () => {
    const s = (await structured(await call({ symbol: "NoSuchThing" }, { replies: { "workspace/symbol": [] } }))) as Record<string, any>;
    expect(s.error.code).toBe("NOT_FOUND");
    expect(s.error.hint).toContain("crosspad_search_symbols");
  });

  it("while the index is still building, the hint says to retry", async () => {
    const s = (await structured(
      await call({ symbol: "NoSuchThing" }, { replies: { "workspace/symbol": [] }, indexing: true }),
    )) as Record<string, any>;
    expect(s.error.hint).toContain("index");
  });
});

describe("crosspad_symbol registration", () => {
  it("registers as a read-only tool whose description warns about the cold first call", () => {
    const h = fakeServer();
    registerSymbolTool(h.server, {} as ToolContext);
    const t = h.tools.get("crosspad_symbol")!;
    expect(t).toBeDefined();
    expect(t.config.annotations.readOnlyHint).toBe(true);
    expect(t.config.description).toMatch(/clangd/);
    expect(t.config.description).toMatch(/compile_commands\.json/);
    expect(t.config.description).toMatch(/FIRST call/);
    for (const a of SYMBOL_ACTIONS) expect(t.config.description).toContain(a);
  });
});
