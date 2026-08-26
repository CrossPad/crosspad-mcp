// src/resources/skills.ts — the bundled skill documents as `skill://` resources.
//
// The knowledge in skills/crosspad/ (hardware traps, the HIL workflow, where
// code belongs) is what stops an agent walking into a reset it caused itself.
// Serving it as resources means a client can pull the one page it needs instead
// of the whole skill, and clients that never install the plugin still get it.
// Spec §3.3.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";

/** Package root, from this module's location (dist/resources → package root). */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/resources/skills.js → dist/resources → dist → root
  // src/resources/skills.ts  → src/resources  → src  → root  (vitest)
  return path.resolve(here, "..", "..");
}

export interface SkillDoc {
  /** URI slug: `crosspad/hil-testing`, `crosspad` for the skill's own SKILL.md */
  id: string;
  file: string;
  title: string;
  bytes: number;
}

/** First markdown heading, or the file name if it has none. */
export function titleOf(markdown: string, fallback: string): string {
  for (const line of markdown.split("\n", 40)) {
    const m = /^#{1,2}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/^`|`$/g, "");
    // Skip YAML frontmatter and blank lines.
    if (line.trim() && !line.startsWith("---") && !line.includes(":")) break;
  }
  return fallback;
}

/** Find the bundled skill documents. Returns [] when the package has none. */
export function discoverSkillDocs(root: string = packageRoot()): SkillDoc[] {
  const skillsDir = path.join(root, "skills");
  let skills: string[];
  try {
    skills = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const docs: SkillDoc[] = [];
  for (const skill of skills) {
    const candidates: { id: string; file: string }[] = [
      { id: skill, file: path.join(skillsDir, skill, "SKILL.md") },
    ];
    const refDir = path.join(skillsDir, skill, "reference");
    try {
      for (const f of fs.readdirSync(refDir).sort()) {
        if (!f.endsWith(".md")) continue;
        candidates.push({ id: `${skill}/${f.replace(/\.md$/, "")}`, file: path.join(refDir, f) });
      }
    } catch { /* a skill without reference/ is fine */ }

    for (const c of candidates) {
      let text: string;
      let bytes: number;
      try {
        const stat = fs.statSync(c.file);
        bytes = stat.size;
        text = fs.readFileSync(c.file, "utf-8");
      } catch {
        continue;
      }
      docs.push({ id: c.id, file: c.file, title: titleOf(text, path.basename(c.file)), bytes });
    }
  }
  return docs;
}

/**
 * Register one resource per bundled skill document, plus `skill://index`
 * listing them — a client that cannot enumerate resources can still find out
 * what is on offer with one read.
 */
export function registerSkillResources(server: McpServer, _ctx: ToolContext, root?: string): string[] {
  const docs = discoverSkillDocs(root);
  const uris: string[] = [];

  const indexUri = "skill://index";
  server.registerResource(
    "crosspad-skill-index",
    indexUri,
    { description: "The bundled skill documents available as skill:// resources", mimeType: "application/json" },
    async () => ({
      contents: [
        {
          uri: indexUri,
          mimeType: "application/json",
          text: JSON.stringify(
            { count: docs.length, docs: docs.map((d) => ({ uri: `skill://${d.id}`, title: d.title, bytes: d.bytes })) },
            null,
            2,
          ),
        },
      ],
    }),
  );
  uris.push(indexUri);

  for (const doc of docs) {
    const uri = `skill://${doc.id}`;
    server.registerResource(
      `crosspad-skill-${doc.id.replace(/\//g, "-")}`,
      uri,
      { description: doc.title, mimeType: "text/markdown" },
      async () => ({
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            // Read at request time: editing a skill during a session should show
            // up without restarting the server.
            text: fs.readFileSync(doc.file, "utf-8"),
          },
        ],
      }),
    );
    uris.push(uri);
  }
  return uris;
}
