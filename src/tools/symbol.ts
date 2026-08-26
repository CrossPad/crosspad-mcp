// src/tools/symbol.ts — crosspad_symbol: compiler-backed answers about C/C++
// symbols, via clangd over LSP (spec §8, P3; toolset `code`).
//
// `crosspad_search_symbols` greps definition lines. That is the right tool for
// "where is IPadLogicHandler declared" and the wrong one for everything else:
// a grep cannot tell a call from a mention in a comment, cannot follow a
// virtual through its overrides, and cannot say what `auto` resolved to. Those
// answers exist in the compilation database every build already emits, and
// clangd is what reads it.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResponse } from "../tool-result.js";
import type { ToolResult } from "../tool-result.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import {
  ClangdError,
  findCompileDb,
  getClangdClient,
  noCompileDbError,
  uriToPath,
  type ClangdClient,
  type CompileDb,
  type ProjectId,
} from "../utils/clangd.js";

const TOOL = "crosspad_symbol";

export const SYMBOL_ACTIONS = [
  "definition",
  "references",
  "hover",
  "implementations",
  "call_hierarchy",
  "document_symbols",
] as const;
export type SymbolAction = (typeof SYMBOL_ACTIONS)[number];

// ── LSP shapes we actually read ──────────────────────────────────────────────

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspLocation { uri: string; range: LspRange }
interface LspSymbolInformation { name: string; kind?: number; containerName?: string; location: LspLocation }
interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind?: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
interface LspCallHierarchyItem {
  name: string;
  detail?: string;
  kind?: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}
interface LspIncomingCall { from: LspCallHierarchyItem; fromRanges?: LspRange[] }

/** LSP SymbolKind numbers → the names a reader expects. */
const SYMBOL_KINDS: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
  12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null",
  22: "enum-member", 23: "struct", 24: "event", 25: "operator", 26: "type-parameter",
};

export function kindName(kind: number | undefined): string | undefined {
  return kind === undefined ? undefined : SYMBOL_KINDS[kind] ?? `kind-${kind}`;
}

// ── Output records ───────────────────────────────────────────────────────────

export interface SymbolLocation {
  file: string;
  line: number;
  character: number;
  end_line?: number;
  name?: string;
  kind?: string;
  container?: string;
  preview?: string;
}

/** Per-call source cache: the same file supplies the preview for every hit. */
type LineCache = Map<string, string[]>;

function sourceLine(file: string, line: number, cache: LineCache): string | undefined {
  let lines = cache.get(file);
  if (!lines) {
    try {
      lines = fs.readFileSync(file, "utf-8").split("\n");
    } catch {
      lines = [];
    }
    cache.set(file, lines);
  }
  const text = lines[line - 1];
  return text === undefined ? undefined : text.trim().slice(0, 200);
}

/** LSP location (0-based) → the 1-based shape every other CrossPad tool uses. */
export function toLocation(loc: LspLocation, cache: LineCache, extra: Partial<SymbolLocation> = {}): SymbolLocation {
  const file = uriToPath(loc.uri);
  const line = (loc.range?.start?.line ?? 0) + 1;
  const out: SymbolLocation = { file, line, character: (loc.range?.start?.character ?? 0) + 1, ...extra };
  const end = (loc.range?.end?.line ?? 0) + 1;
  if (end !== line) out.end_line = end;
  const preview = sourceLine(file, line, cache);
  if (preview) out.preview = preview;
  return out;
}

function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === null || v === undefined) return [];
  return [v as T];
}

// ── Resolving a name to a position ───────────────────────────────────────────

export interface Target {
  file: string;
  /** 0-based, i.e. already in LSP coordinates. */
  position: LspPosition;
  name?: string;
  kind?: string;
  container?: string;
}

/**
 * Rank workspace/symbol hits for a name. clangd returns fuzzy matches, so
 * "PadManager" also brings back "PadManagerTest" and "makePadManager"; an
 * exact name (or an exact trailing `::name`) has to win, or the tool answers
 * a question nobody asked.
 */
export function rankCandidates(symbols: LspSymbolInformation[], query: string): LspSymbolInformation[] {
  const q = query.trim();
  const bare = q.includes("::") ? q.slice(q.lastIndexOf("::") + 2) : q;
  const score = (s: LspSymbolInformation): number => {
    const qualified = s.containerName ? `${s.containerName}::${s.name}` : s.name;
    if (qualified === q) return 0;
    if (s.name === bare) return 1;
    if (s.name.toLowerCase() === bare.toLowerCase()) return 2;
    if (s.name.startsWith(bare)) return 3;
    return 4;
  };
  return [...symbols].sort((a, b) => score(a) - score(b) || a.name.length - b.name.length);
}

/** Explicit file+line wins; a bare name goes through workspace/symbol first. */
export async function resolveTarget(
  client: ClangdClient,
  args: { symbol?: string; file?: string; line?: number; character?: number },
): Promise<{ target: Target; candidates: SymbolLocation[] }> {
  const cache: LineCache = new Map();

  if (args.file && args.line !== undefined) {
    const abs = path.isAbsolute(args.file) ? args.file : path.resolve(client.root, args.file);
    client.openFile(abs);
    return {
      target: { file: abs, position: { line: args.line - 1, character: Math.max(0, (args.character ?? 1) - 1) } },
      candidates: [],
    };
  }

  const name = args.symbol?.trim();
  if (!name) {
    throw new ClangdError("BAD_INPUT", "pass either `symbol` or `file` + `line`", "e.g. {symbol: 'PadManager::handlePadPress'} or {file: 'main/main.cpp', line: 120, character: 9}");
  }

  // workspaceSymbol() waits out the background index; an empty answer here has
  // already been given every chance to become a non-empty one.
  const hits = rankCandidates(await client.workspaceSymbol<LspSymbolInformation>(name), name);
  if (hits.length === 0) {
    throw new ClangdError(
      "NOT_FOUND",
      `clangd's index has no symbol matching "${name}"`,
      client.indexing
        ? "the background index is still building — retry in a few seconds"
        : "check the spelling, or try crosspad_search_symbols (it greps the whole tree, including files this build does not compile)",
      { query: name },
    );
  }

  const best = hits[0];
  const file = uriToPath(best.location.uri);
  client.openFile(file);
  return {
    target: {
      file,
      // selectionRange is not part of SymbolInformation, so the definition
      // range's start is the position we probe — it lands on the name.
      position: { line: best.location.range.start.line, character: best.location.range.start.character },
      name: best.name,
      kind: kindName(best.kind),
      container: best.containerName,
    },
    candidates: hits.slice(0, 10).map((h) =>
      toLocation(h.location, cache, { name: h.name, kind: kindName(h.kind), container: h.containerName }),
    ),
  };
}

// ── The actions ──────────────────────────────────────────────────────────────

export interface HoverInfo {
  /** The signature/type line clangd puts in the hover's code block. */
  signature?: string;
  /** The whole hover card, markdown as clangd wrote it (doc comment included). */
  text: string;
}

/** clangd's hover is markdown: a ```cpp block with the declaration, then the
 *  doc comment. The block is the answer to "what type is this actually". */
export function parseHover(contents: unknown): HoverInfo | null {
  const parts: string[] = [];
  for (const c of asArray<unknown>(contents)) {
    if (typeof c === "string") parts.push(c);
    else if (c && typeof c === "object" && typeof (c as { value?: unknown }).value === "string") {
      parts.push((c as { value: string }).value);
    }
  }
  const text = parts.join("\n").trim();
  if (text.length === 0) return null;
  const block = /```(?:cpp|c\+\+|c)?\n([\s\S]*?)```/.exec(text);
  const signature = block ? block[1].trim().split("\n").filter((l) => l.trim().length > 0).join(" ").slice(0, 400) : undefined;
  return signature ? { signature, text } : { text };
}

export interface IncomingCall {
  caller: string;
  kind?: string;
  detail?: string;
  file: string;
  line: number;
  /** Lines inside the caller where the call itself appears. */
  call_lines: number[];
}

/** DocumentSymbol is a tree; a flat list with a depth reads better in a JSON
 *  result and keeps the schema closed. */
export function flattenDocumentSymbols(
  symbols: LspDocumentSymbol[],
  file: string,
  cache: LineCache,
  depth = 0,
  out: SymbolLocation[] = [],
): SymbolLocation[] {
  for (const s of symbols) {
    const range = s.selectionRange ?? s.range;
    out.push({
      file,
      line: (range?.start?.line ?? 0) + 1,
      character: (range?.start?.character ?? 0) + 1,
      end_line: (s.range?.end?.line ?? 0) + 1,
      name: "  ".repeat(depth) + s.name,
      kind: kindName(s.kind),
      preview: s.detail ?? sourceLine(file, (range?.start?.line ?? 0) + 1, cache),
    });
    if (s.children && s.children.length > 0) flattenDocumentSymbols(s.children, file, cache, depth + 1, out);
  }
  return out;
}

export interface ActionPayload {
  locations?: SymbolLocation[];
  hover?: HoverInfo;
  calls?: IncomingCall[];
  symbols?: SymbolLocation[];
}

export async function runAction(
  client: ClangdClient,
  action: SymbolAction,
  target: Target,
  limit: number,
): Promise<ActionPayload> {
  const cache: LineCache = new Map();
  const doc = { textDocument: { uri: fileUri(target.file) }, position: target.position };

  switch (action) {
    case "definition": {
      const r = asArray<LspLocation>(await client.request("textDocument/definition", doc));
      return { locations: r.slice(0, limit).map((l) => toLocation(l, cache)) };
    }
    case "references": {
      const r = asArray<LspLocation>(
        // The declaration is what the caller already has; the point of asking
        // is the other N places.
        await client.request("textDocument/references", { ...doc, context: { includeDeclaration: false } }),
      );
      return { locations: r.slice(0, limit).map((l) => toLocation(l, cache)) };
    }
    case "implementations": {
      const r = asArray<LspLocation>(await client.request("textDocument/implementation", doc));
      return { locations: r.slice(0, limit).map((l) => toLocation(l, cache)) };
    }
    case "hover": {
      const r = (await client.request("textDocument/hover", doc)) as { contents?: unknown } | null;
      const hover = parseHover(r?.contents);
      return hover ? { hover } : {};
    }
    case "call_hierarchy": {
      const items = asArray<LspCallHierarchyItem>(await client.request("textDocument/prepareCallHierarchy", doc));
      if (items.length === 0) return { calls: [] };
      const incoming = asArray<LspIncomingCall>(await client.request("callHierarchy/incomingCalls", { item: items[0] }));
      return {
        calls: incoming.slice(0, limit).map((c) => ({
          caller: c.from.name,
          kind: kindName(c.from.kind),
          detail: c.from.detail,
          file: uriToPath(c.from.uri),
          line: (c.from.selectionRange?.start?.line ?? c.from.range?.start?.line ?? 0) + 1,
          call_lines: (c.fromRanges ?? []).map((r) => r.start.line + 1),
        })),
      };
    }
    case "document_symbols": {
      const r = await client.request<unknown>("textDocument/documentSymbol", { textDocument: { uri: fileUri(target.file) } });
      const arr = asArray<LspDocumentSymbol & { location?: LspLocation }>(r);
      // clangd answers with DocumentSymbol; older servers answer with the flat
      // SymbolInformation form, which has `location` instead of `range`.
      const symbols = arr.length > 0 && arr[0].location !== undefined
        ? arr.map((s) => toLocation(s.location!, cache, { name: s.name, kind: kindName(s.kind) }))
        : flattenDocumentSymbols(arr, target.file, cache);
      return { symbols: symbols.slice(0, limit) };
    }
  }
}

function fileUri(file: string): string {
  return pathToFileURL(path.resolve(file)).href;
}

// ── Tool ─────────────────────────────────────────────────────────────────────

const LocationSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  character: z.number().int(),
  end_line: z.number().int().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  container: z.string().optional(),
  preview: z.string().optional(),
});

const outputSchema = {
  success: z.boolean(),
  action: z.string().optional(),
  project: z.string().optional(),
  compile_commands: z.string().optional(),
  /** Where the query landed — always report it, because a name lookup picks. */
  resolved: z
    .object({
      file: z.string(),
      line: z.number().int(),
      character: z.number().int(),
      name: z.string().optional(),
      kind: z.string().optional(),
      container: z.string().optional(),
    })
    .optional(),
  candidates: z.array(LocationSchema).optional(),
  count: z.number().int().optional(),
  truncated: z.boolean().optional(),
  indexing: z.boolean().optional(),
  locations: z.array(LocationSchema).optional(),
  // House rule: a sub-result gets its own field, never a spread into this
  // schema — hover's shape is clangd's, not ours.
  hover: z.record(z.string(), z.unknown()).optional(),
  calls: z.array(z.record(z.string(), z.unknown())).optional(),
  symbols: z.array(LocationSchema).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      hint: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
};

/** ClangdError (and anything else) → the `{success:false, error:{…}}` envelope. */
export function symbolError(e: unknown): ToolResult {
  if (e instanceof ClangdError) {
    const error: Record<string, unknown> = { code: e.code, message: e.message };
    if (e.hint !== undefined) error.hint = e.hint;
    if (Object.keys(e.details).length > 0) error.details = e.details;
    return jsonResponse({ success: false, error });
  }
  return jsonResponse({
    success: false,
    error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) },
  });
}

export interface SymbolArgs {
  action?: SymbolAction;
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  project?: ProjectId;
  limit?: number;
}

/** The whole call, with the clangd lookup injectable so tests need no clangd. */
export async function crosspadSymbol(
  args: SymbolArgs,
  connect: (db: CompileDb) => Promise<ClangdClient> = (db) => getClangdClient(db),
  locate: (p?: ProjectId) => CompileDb | null = findCompileDb,
): Promise<ToolResult> {
  const action = args.action ?? "definition";
  const limit = args.limit ?? 30;
  try {
    const db = locate(args.project);
    if (!db) throw noCompileDbError(args.project);

    const client = await connect(db);

    // An outline is a whole-file question, so it needs no position — but it
    // does need a file, and asking for one without it is the easy mistake.
    let target: Target;
    let candidates: SymbolLocation[] = [];
    if (action === "document_symbols") {
      if (!args.file) {
        throw new ClangdError(
          "BAD_INPUT",
          "document_symbols needs a `file`",
          "pass file='main/gui/gui.cpp' (relative to the project root, or absolute)",
        );
      }
      const abs = path.isAbsolute(args.file) ? args.file : path.resolve(client.root, args.file);
      client.openFile(abs);
      target = { file: abs, position: { line: 0, character: 0 } };
    } else {
      ({ target, candidates } = await resolveTarget(client, args));
    }

    const payload = await runAction(client, action, target, limit);
    const found = payload.locations ?? payload.calls ?? payload.symbols;

    return jsonResponse({
      success: true,
      action,
      project: db.project,
      compile_commands: db.file,
      resolved: {
        file: target.file,
        line: target.position.line + 1,
        character: target.position.character + 1,
        ...(target.name ? { name: target.name } : {}),
        ...(target.kind ? { kind: target.kind } : {}),
        ...(target.container ? { container: target.container } : {}),
      },
      ...(candidates.length > 1 ? { candidates } : {}),
      ...(found ? { count: found.length, truncated: found.length >= limit } : {}),
      ...(client.indexing ? { indexing: true } : {}),
      // Each action's result gets its own named field rather than being merged
      // into the envelope — a closed output schema and a spread do not mix.
      ...(payload.locations ? { locations: payload.locations } : {}),
      ...(payload.hover ? { hover: payload.hover } : {}),
      ...(payload.calls ? { calls: payload.calls } : {}),
      ...(payload.symbols ? { symbols: payload.symbols } : {}),
    });
  } catch (e) {
    return symbolError(e);
  }
}

export function registerSymbolTool(server: McpServer, _ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL,
    {
      title: "Ask clangd about a C/C++ symbol",
      description:
        "Compiler-backed symbol intelligence via clangd over the project's compile_commands.json. Answers what a grep cannot: `references` (who actually calls this), `implementations` (what overrides this virtual), `hover` (resolved type plus the doc comment), `call_hierarchy` (incoming callers), `definition`, `document_symbols` (an outline of one file). Give it a `symbol` name — resolved through clangd's index — or an exact `file` + `line` (+ `character`), 1-based. `project` picks pc or idf; by default whichever was built most recently. Needs clangd installed and a build that emitted compile_commands.json (crosspad_build); both are reported as typed errors, never as a hang. The FIRST call on a cold tree can take a minute or two while the background index is built — platform-idf is ~1950 translation units — and later calls are fast. For a plain 'where is X declared' over every repo (including files this build does not compile), crosspad_search_symbols is cheaper.",
      inputSchema: {
        action: z.enum(SYMBOL_ACTIONS).default("definition").describe("What to ask clangd (default: definition)"),
        symbol: z.string().min(1).optional().describe("Symbol name, optionally qualified: 'PadManager' or 'PadManager::handlePadPress'"),
        file: z.string().optional().describe("Source file — absolute, or relative to the project root. Required for document_symbols"),
        line: z.number().int().min(1).optional().describe("1-based line, when pointing at an exact position instead of naming a symbol"),
        character: z.number().int().min(1).default(1).describe("1-based column within `line` (default 1)"),
        project: z.enum(["pc", "idf"]).optional().describe("Which compilation database to index (default: the most recently built)"),
        limit: z.number().int().min(1).max(200).default(30).describe("Maximum results (default 30)"),
      },
      outputSchema,
      annotations: annotationsFor(tierOf(TOOL, {})),
    },
    async (args: SymbolArgs): Promise<ToolResult> => crosspadSymbol(args),
  );
}
