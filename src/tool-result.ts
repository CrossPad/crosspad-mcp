// src/tool-result.ts — the `{ success, ...data, error? }` envelope used by
// every crosspad_* tool (same shape as the private helpers in src/index.ts).
import { z } from "zod";
import { HilError } from "./hil/daemon.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/** Emit structuredContent in addition to text content. Clients with an
 *  outputSchema validate structuredContent; the LLM sees the same JSON in
 *  `content`. `success === false` sets `isError` per the MCP spec. */
/**
 * The error object every tool reports, as a schema.
 *
 * Loose on purpose. `errorResult` attaches `details` whenever a HilError
 * carries any, and the daemon decides what goes in there — a tool that
 * declared `{code, message, hint}` and nothing else rejected its own error
 * the first time one arrived with details, which is how a path-allowlist
 * refusal came back as "structured content does not match the tool's output
 * schema" instead of as the refusal.
 */
export const ErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  hint: z.string().nullish(),
  details: z.record(z.string(), z.unknown()).optional(),
});

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

/** Alias — later chunks of the v10 plan import this name for `errorResult`. */
export const toolError = errorResult;
