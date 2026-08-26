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
