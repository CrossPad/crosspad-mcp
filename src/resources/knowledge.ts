// src/resources/knowledge.ts — crosspad://cdc, crosspad://sysex,
// crosspad://hil/catalog. Firmware-coupled reference data lives in the
// crosspad-hil package (knowledge/*.yaml), not here: it must version with the
// firmware, not with this server. These resources are the read-only window on
// it, cached for KNOWLEDGE_TTL_MS because the payloads cannot change while the
// daemon process lives — so a daemon restart has to clear the cache, or the
// scenario catalog the restart was meant to refresh stays stale for an hour.
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
