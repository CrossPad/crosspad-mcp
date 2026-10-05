import { z } from "zod";
// Confirmation that does not depend on the client (spec §4.2).
//  1. Client declares `elicitation` and a person answers the form → approve runs,
//     decline → CANCELLED_BY_USER.
//  2. Otherwise → {resultType:"confirmation_required", confirmation:{token,…}},
//     nothing performed. The model calls `crosspad_confirm(token)`, a destructive
//     tool of its own, so the client's own permission prompt is where the person
//     approves (Claude Code shows one; it does not render elicitation forms -- it
//     declares the capability and answers "decline" at once). Re-issuing the
//     identical call with confirm_token still works too.
// The token is an HMAC-SHA256 over (tool, canonical args, device, issuedAt,
// nonce) with a per-process random secret, so any argument change, a different
// board, or a server restart invalidates it. It is also good for exactly one
// call: see `consumeToken`.
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

/**
 * `device` is the device the call was *resolved* to, not the `device` argument
 * — omitting the argument is the normal case with one board attached, and
 * without this a "yes" given for board A would still be valid once board B is
 * what the implicit selection lands on (spec §4.2).
 */
function mac(
  tool: string,
  args: Record<string, unknown>,
  device: string | null,
  issuedAt: number,
  nonce: string,
): string {
  return createHmac("sha256", SECRET)
    .update([tool, canonicalJson(canonicalArgs(args)), device ?? "", String(issuedAt), nonce].join("\n"))
    .digest("hex");
}

const TOKEN_RE = /^cfm_(\d{1,16})_([0-9a-f]{16})_([0-9a-f]{64})$/;

export function mintToken(
  tool: string,
  args: Record<string, unknown>,
  device: string | null = null,
  now?: number,
): string {
  const issuedAt = Math.floor(now ?? Date.now());
  // The nonce makes two approvals of the identical call distinct tokens, which
  // the single-use registry below needs to tell one from the other.
  const nonce = randomBytes(8).toString("hex");
  return `cfm_${issuedAt}_${nonce}_${mac(tool, args, device, issuedAt, nonce)}`;
}

export function verifyToken(
  token: string,
  tool: string,
  args: Record<string, unknown>,
  device: string | null = null,
  now?: number,
): boolean {
  if (typeof token !== "string") return false;
  const m = TOKEN_RE.exec(token);
  if (!m) return false;
  const issuedAt = Number(m[1]);
  if (!Number.isFinite(issuedAt)) return false;
  const t = now ?? Date.now();
  if (t < issuedAt || t - issuedAt > CONFIRM_TTL_S * 1000) return false;
  const expected = Buffer.from(mac(tool, args, device, issuedAt, m[2]), "hex");
  const given = Buffer.from(m[3], "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// One human approval is one call. Without a spent-token registry the model can
// replay the same "yes" for the whole TTL — flashing twice, or re-issuing
// BOOTLOADER_REQUEST — off a single confirmation nobody gave twice.
const spent = new Map<string, number>();

export type TokenCheck = "ok" | "invalid" | "replayed";

/** Verify and spend in one step. `replayed` means the token was already used. */
export function consumeToken(
  token: string,
  tool: string,
  args: Record<string, unknown>,
  device: string | null = null,
  now?: number,
): TokenCheck {
  const t = now ?? Date.now();
  if (!verifyToken(token, tool, args, device, t)) return "invalid";
  // A token past its TTL can never verify again, so forgetting it is safe and
  // keeps the registry bounded by the confirmation rate, not by uptime.
  for (const [old, issuedAt] of spent) if (t - issuedAt > CONFIRM_TTL_S * 1000) spent.delete(old);
  if (spent.has(token)) return "replayed";
  spent.set(token, Number(TOKEN_RE.exec(token)![1]));
  return "ok";
}

/** @internal vitest only — the registry outlives a single test otherwise. */
export function resetSpentTokens(): void {
  spent.clear();
}

/** Output-schema fields a confirmation gate adds to any tool's result. */
export const CONFIRMATION_OUTPUT = {
  resultType: z.string().optional(),
  elicitation: z.record(z.string(), z.unknown()).optional(),
  confirmation: z
    .object({ token: z.string(), expires_in_s: z.number(), summary: z.string() })
    .optional(),
  tool: z.string().optional(),
  hint: z.string().optional(),
};

export type ConfirmationOutcome =
  | { status: "approved" }
  | { status: "declined" }
  | { status: "token"; result: CallToolResult };

// ── pending actions for crosspad_confirm ────────────────────────────────────
// A confirmation_required result leaves the call it stands for here, keyed by
// its token: crosspad_confirm(token) runs exactly that call, once.

export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  issuedAt: number;
}

const pending = new Map<string, PendingAction>();

function prunePending(now: number): void {
  for (const [t, p] of pending) if (now - p.issuedAt > CONFIRM_TTL_S * 1000) pending.delete(t);
}

/** The action a token stands for, without spending it; null when unknown or expired. */
export function peekPending(token: string, now: number = Date.now()): PendingAction | null {
  prunePending(now);
  return pending.get(token) ?? null;
}

/** Take (and forget) the action a token stands for; null when unknown, spent or expired. */
export function takePending(token: string, now: number = Date.now()): PendingAction | null {
  const p = peekPending(token, now);
  if (p) pending.delete(token);
  return p;
}

/** @internal vitest only */
export function resetPending(): void {
  pending.clear();
}

// ── what the client did with the last form, for the diagnosis ───────────────
export interface ElicitationNote {
  declared: boolean;
  forced_token?: boolean;
  action?: string;
  ms?: number;
  error?: string;
  why_token?: string;
}

function tokenResult(
  tool: string,
  args: Record<string, unknown>,
  device: string | null,
  summary: string,
  replayed = false,
  elicitation?: ElicitationNote,
): CallToolResult {
  const token = mintToken(tool, args, device);
  const now = Date.now();
  prunePending(now);
  pending.set(token, { tool, args: canonicalArgs(args), summary, issuedAt: now });
  const payload: Record<string, unknown> = {
    // Every tool's outputSchema requires `success`, and nothing was performed.
    success: false,
    resultType: "confirmation_required",
    confirmation: { token, expires_in_s: CONFIRM_TTL_S, summary },
    tool,
    hint:
      (replayed
        ? "The confirm_token you presented was already spent — a confirmation approves exactly one call. "
        : "") +
      `Nothing was performed. Call crosspad_confirm with token="${token}" and summary set to ` +
      `confirmation.summary, word for word, now (within ${CONFIRM_TTL_S} s) -- do not ask the ` +
      `user in chat first: the client's own permission prompt for crosspad_confirm shows them ` +
      `that summary, and approving it is the confirmation. (Re-issuing the identical ${tool} ` +
      `call with confirm_token works too.)`,
  };
  if (elicitation) payload.elicitation = elicitation;
  // Deliberately NOT isError: a confirmation gate is a question, not a failure,
  // and a model that reads it as a failure will report the flash as broken
  // instead of asking for approval.
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * `CROSSPAD_MCP_CONFIRM=token` forces the token round-trip even where the client
 * advertises elicitation — for a client that declares the capability and then
 * answers the form itself instead of showing it to anybody.
 */
function elicitationUsable(server: McpServer, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CROSSPAD_MCP_CONFIRM === "token") return false;
  try {
    const caps = server.server.getClientCapabilities() as Record<string, unknown> | undefined;
    return !!caps && caps.elicitation !== undefined && caps.elicitation !== null;
  } catch {
    return false;
  }
}

/** A decline faster than this was not read by anybody
 *  (CROSSPAD_MCP_ELICIT_MIN_MS overrides it; tests set 0). */
export const ELICIT_MIN_HUMAN_MS = 500;

function minHumanMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.CROSSPAD_MCP_ELICIT_MIN_MS);
  return env.CROSSPAD_MCP_ELICIT_MIN_MS !== undefined && Number.isFinite(v) ? v : ELICIT_MIN_HUMAN_MS;
}

function logElicitation(tool: string, note: ElicitationNote): void {
  console.error(`crosspad-mcp: elicitation for ${tool}: ${JSON.stringify(note)}`);
}

export async function requireConfirmation(
  server: McpServer,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  tool: string,
  args: Record<string, unknown>,
  summary: string,
  device: string | null = null,
): Promise<ConfirmationOutcome> {
  void extra;
  const presented = args?.[TOKEN_ARG];
  let replayed = false;
  if (typeof presented === "string") {
    const check = consumeToken(presented, tool, args, device);
    if (check === "ok") return { status: "approved" };
    replayed = check === "replayed";
  }

  const declared = elicitationUsable(server);
  const note: ElicitationNote = { declared };
  if (process.env.CROSSPAD_MCP_CONFIRM === "token") note.forced_token = true;
  if (declared) {
    const t0 = Date.now();
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
      const { action, content } = res as { action: string; content?: Record<string, unknown> };
      note.action = action;
      note.ms = Date.now() - t0;
      logElicitation(tool, note);
      if (action === "accept") return content?.approve === true ? { status: "approved" } : { status: "declined" };
      // CROSSPAD_MCP_CONFIRM=form keeps every decline a decline: for a client
      // that pre-approves tools, where crosspad_confirm would ask nobody.
      if (action === "decline"
          && (note.ms >= minHumanMs() || process.env.CROSSPAD_MCP_CONFIRM === "form")) {
        return { status: "declined" };
      }
      // An instant "decline" is not an answer: Claude Code declares elicitation
      // and declines every form at once without showing it (nobody read it in
      // under half a second). "cancel" is a form dismissed without an answer.
      // Either way the gate stays, through the token and crosspad_confirm.
      note.why_token = action === "decline" ? `declined in ${note.ms} ms: nobody saw the form`
        : "the form was dismissed without an answer";
      return { status: "token", result: tokenResult(tool, args, device, summary, replayed, note) };
    } catch (e) {
      // Client advertised elicitation but could not serve it — fall back to the
      // token path rather than blocking the operation forever.
      note.error = e instanceof Error ? e.message : String(e);
      note.why_token = "the client could not serve the form";
      logElicitation(tool, note);
      return { status: "token", result: tokenResult(tool, args, device, summary, replayed, note) };
    }
  }
  note.why_token = note.forced_token ? "CROSSPAD_MCP_CONFIRM=token"
    : "the client does not declare elicitation";
  return { status: "token", result: tokenResult(tool, args, device, summary, replayed, note) };
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
  device: string | null = null,
): Promise<CallToolResult | null> {
  const decision = decide(policy, tool, canonicalArgs(args));
  if (decision === "allow") return null;
  if (decision === "hidden") return policyDenied(tool, policy.mode);
  const outcome = await requireConfirmation(server, extra, tool, args, summary, device);
  if (outcome.status === "approved") return null;
  if (outcome.status === "declined") return confirmationDeclined(tool);
  return outcome.result;
}
