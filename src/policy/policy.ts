// Policy engine (spec §4.1). File = intent, env + flags only tighten.
import fs from "fs";
import os from "os";
import path from "path";
import { tierOf } from "./tiers.js";

export type PolicyMode = "strict" | "lab" | "readonly";

export interface PolicyRule {
  tool: string;
  when?: Record<string, unknown>;
  confirm: boolean;
}

export interface Policy {
  mode: PolicyMode;
  rules: PolicyRule[];
}

export type Decision = "allow" | "confirm" | "hidden";

export const DEFAULT_POLICY_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "crosspad-mcp",
  "policy.json",
);

// Strictness order — a later source may only move right on this line.
const STRICTNESS: Record<PolicyMode, number> = { lab: 0, strict: 1, readonly: 2 };

function isMode(v: unknown): v is PolicyMode {
  return v === "strict" || v === "lab" || v === "readonly";
}

function stricter(a: PolicyMode, b: PolicyMode): PolicyMode {
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

function parseRules(raw: unknown): PolicyRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: PolicyRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.tool !== "string" || o.tool.length === 0) continue;
    if (typeof o.confirm !== "boolean") continue;
    const rule: PolicyRule = { tool: o.tool, confirm: o.confirm };
    if (o.when && typeof o.when === "object" && !Array.isArray(o.when)) {
      rule.when = o.when as Record<string, unknown>;
    }
    rules.push(rule);
  }
  return rules;
}

function readPolicyFile(file: string): Policy {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    if (!raw || typeof raw !== "object") return { mode: "strict", rules: [] };
    const o = raw as Record<string, unknown>;
    return { mode: isMode(o.mode) ? o.mode : "strict", rules: parseRules(o.rules) };
  } catch {
    return { mode: "strict", rules: [] };
  }
}

/**
 * Resolution: file (opts.file → $CROSSPAD_MCP_POLICY_FILE → ~/.config/crosspad-mcp/policy.json)
 * gives mode + rules; $CROSSPAD_MCP_POLICY and --read-only can only make the
 * mode stricter (lab < strict < readonly).
 */
export function loadPolicy(opts: { file?: string; env?: NodeJS.ProcessEnv; readOnlyFlag?: boolean } = {}): Policy {
  const env = opts.env ?? process.env;
  const file = opts.file ?? env.CROSSPAD_MCP_POLICY_FILE ?? DEFAULT_POLICY_FILE;
  const fromFile = readPolicyFile(file);
  let mode = fromFile.mode;
  const envMode = env.CROSSPAD_MCP_POLICY;
  if (isMode(envMode)) mode = stricter(mode, envMode);
  if (opts.readOnlyFlag) mode = "readonly";
  return { mode, rules: fromFile.rules };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (!deepEqual(ak, bk)) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** Every key in `when` must deep-equal the corresponding call argument. */
export function ruleMatches(rule: PolicyRule, tool: string, args: Record<string, unknown>): boolean {
  if (rule.tool !== tool) return false;
  if (!rule.when) return true;
  return Object.entries(rule.when).every(([k, v]) => k in args && deepEqual(args[k], v));
}

export function decide(policy: Policy, tool: string, args: Record<string, unknown>): Decision {
  const a = args ?? {};
  const tier = tierOf(tool, a);
  if (policy.mode === "readonly") return tier === "read" ? "allow" : "hidden";
  const matching = policy.rules.filter((r) => ruleMatches(r, tool, a));
  // A rule can always tighten (confirm:true), in any non-readonly mode.
  if (matching.some((r) => r.confirm)) return "confirm";
  if (tier !== "danger") return "allow";
  if (policy.mode === "lab" && matching.some((r) => !r.confirm)) return "allow";
  return "confirm";
}
