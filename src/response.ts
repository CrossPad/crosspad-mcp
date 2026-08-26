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
