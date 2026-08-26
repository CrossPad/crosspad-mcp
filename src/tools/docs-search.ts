// src/tools/docs-search.ts — crosspad_docs_search: search the ecosystem's
// prose, not its code.
//
// The answer to "why does the board reset when I open the console" or "what is
// REGISTER_APP_PL" is written down; grep over the repos finds the code instead,
// and reading whole pages to answer one question is what burns a context
// window. This ranks the matching sections and returns those, with the page
// path so the caller can read the rest if it wants. Spec §3.1 (toolset `code`).
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResponse, ErrorSchema } from "../tool-result.js";
import type { ToolResult } from "../tool-result.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { CROSSPAD_IDF_ROOT, GIT_DIR } from "../config.js";

const TOOL = "crosspad_docs_search";

export interface DocSection {
  file: string;
  heading: string;
  line: number;
  text: string;
}

export interface DocHit extends DocSection {
  score: number;
  excerpt: string;
}

/** Markdown → sections, each headed by the nearest preceding heading. */
export function splitSections(markdown: string, file: string): DocSection[] {
  const lines = markdown.split("\n");
  const out: DocSection[] = [];
  let heading = path.basename(file);
  let start = 0;
  let buf: string[] = [];
  let fenced = false;

  const flush = (endLine: number) => {
    const text = buf.join("\n").trim();
    if (text) out.push({ file, heading, line: start + 1, text });
    buf = [];
    start = endLine;
  };

  lines.forEach((line, i) => {
    // A "#" inside a fenced block is shell, not a heading.
    if (/^\s*```/.test(line)) fenced = !fenced;
    const h = !fenced && /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (h) {
      flush(i);
      heading = h[2];
      start = i;
      return;
    }
    buf.push(line);
  });
  flush(lines.length);
  return out;
}

/**
 * Score a section against the query terms.
 *
 * Whole-word matches beat substrings, a hit in the heading counts for more than
 * one in the body, and a section that contains every term outranks one that
 * repeats a single term — asking about "kit load async" should not be answered
 * by the page that says "kit" the most times.
 */
export function scoreSection(section: DocSection, terms: string[]): number {
  if (terms.length === 0) return 0;
  const heading = section.heading.toLowerCase();
  const body = section.text.toLowerCase();
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const word = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const inHeading = (heading.match(word) ?? []).length;
    const inBody = (body.match(word) ?? []).length;
    const substring = inBody === 0 && body.includes(term) ? 1 : 0;
    if (inHeading + inBody + substring > 0) matched++;
    score += inHeading * 8 + Math.min(inBody, 6) * 2 + substring;
  }
  if (matched === 0) return 0;
  // Every term present is the strongest signal there is.
  return score * (matched === terms.length ? 3 : 1);
}

/** A window of the section around the first hit, not the whole section. */
export function excerptAround(text: string, terms: string[], max = 600): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, max);
  const from = Math.max(0, at - Math.floor(max / 3));
  const slice = text.slice(from, from + max);
  return (from > 0 ? "…" : "") + slice + (from + max < text.length ? "…" : "");
}

function walkMarkdown(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith("build")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out, depth + 1);
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Where the ecosystem's prose lives, in the order it is searched. */
export function docRoots(): { label: string; dir: string }[] {
  const roots = [
    { label: "crosspad-docs", dir: path.join(GIT_DIR, "crosspad-docs", "docs") },
    { label: "platform-idf", dir: path.join(CROSSPAD_IDF_ROOT, "components", "bsp", "crosspad") },
    { label: "crosspad-mcp/skills", dir: path.join(GIT_DIR, "crosspad-mcp", "skills") },
  ];
  return roots.filter((r) => fs.existsSync(r.dir));
}

export function searchDocs(query: string, limit: number, roots = docRoots()): DocHit[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const hits: DocHit[] = [];
  for (const root of roots) {
    for (const file of walkMarkdown(root.dir)) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      for (const section of splitSections(text, file)) {
        const score = scoreSection(section, terms);
        if (score > 0) hits.push({ ...section, score, excerpt: excerptAround(section.text, terms) });
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return hits.slice(0, limit);
}

export function registerDocsSearchTool(server: McpServer, _ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL,
    {
      title: "Search the CrossPad documentation",
      description:
        "Search the ecosystem's prose (crosspad-docs, the BSP guides, the bundled skill pages) and return the matching sections rather than whole pages. Use it for 'how does X work' and 'why does the board do Y' questions — the hardware traps, the app lifecycle, the audio routing and the HIL workflow are written down. For code, use crosspad_search_symbols instead.",
      inputSchema: {
        query: z.string().min(2).describe("Words to look for, e.g. 'kit load async' or 'DTR RTS reset'"),
        limit: z.number().int().min(1).max(25).default(5).describe("How many sections to return (default 5)"),
      },
      outputSchema: {
        success: z.boolean(),
        query: z.string().optional(),
        count: z.number().int().optional(),
        searched: z.array(z.string()).optional(),
        hits: z
          .array(
            z.object({
              file: z.string(),
              heading: z.string(),
              line: z.number().int(),
              score: z.number(),
              excerpt: z.string(),
            }),
          )
          .optional(),
        error: ErrorSchema.optional(),
      },
      annotations: annotationsFor(tierOf(TOOL, {})),
    },
    async (args: { query: string; limit?: number }): Promise<ToolResult> => {
      const roots = docRoots();
      if (roots.length === 0) {
        return jsonResponse({
          success: false,
          error: {
            code: "ENV",
            message: "no documentation found on disk",
            hint: "clone CrossPad/crosspad-docs next to the other repos, or set CROSSPAD_IDF_ROOT",
          },
        });
      }
      const hits = searchDocs(args.query, args.limit ?? 5, roots);
      return jsonResponse({
        success: true,
        query: args.query,
        count: hits.length,
        searched: roots.map((r) => r.label),
        hits: hits.map((h) => ({
          file: h.file,
          heading: h.heading,
          line: h.line,
          score: h.score,
          excerpt: h.excerpt,
        })),
      });
    },
  );
}
