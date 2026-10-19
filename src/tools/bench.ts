// src/tools/bench.ts — crosspad_bench_claim / _release / _status: the bench lease.
//
// Several Claude sessions share one CrossPad, and opening its CDC port for a
// moment, or flashing it, breaks whoever is mid-test. crosspad-hil keeps a
// lease per board (one holder, a queue, what firmware was left on it, expiry
// after a ttl without renewal) in a file every session's daemon shares; every
// daemon op that touches the board checks it.
//
// This server is one Claude session, so the name it claimed with is remembered
// on the daemon client (`HilDaemon.benchHolder`) and sent with every daemon
// request: the hardware tools pass the caller's holder without each growing a
// parameter. Paths that touch the board outside the daemon (idf.py, the
// ST-Link) ask `bench.check` first — `benchGate()` below.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HilError } from "../hil/daemon.js";
import type { DaemonRequester } from "../hil/select.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { jsonResponse, toolError, type ToolResult, ErrorSchema } from "../tool-result.js";

export const CLAIM_TOOL = "crosspad_bench_claim";
export const RELEASE_TOOL = "crosspad_bench_release";
export const STATUS_TOOL = "crosspad_bench_status";

export const BENCH_BUSY = "BENCH_BUSY";

/** The holder name this session claimed with, if any. */
export interface HolderSlot { benchHolder?: string | null }

/** A daemon that predates the bench answers "unknown op", and one that cannot
 *  start at all (no crosspad-hil installed: an STM-only setup) has no lease to
 *  honour either. Neither may stop a flash or a trace. */
function noBenchSupport(e: unknown): boolean {
  if (!(e instanceof HilError)) return false;
  if (e.code === "UNKNOWN_OP" || e.code === "DAEMON_DIED") return true;
  return e.code === "BAD_ARGS" && /unknown op 'bench\./.test(e.message);
}

/**
 * For a path that touches the board without going through a daemon op (idf.py
 * flash, STM32_Programmer_CLI, pyOCD): may this session do `op` now? Throws the
 * daemon's BENCH_BUSY HilError — naming the holder and their ETA — when another
 * session holds the board. `device` omitted: the daemon picks the single board,
 * or checks every lease when it cannot tell.
 */
export async function benchGate(
  daemon: DaemonRequester, op: string, device?: string, signal?: AbortSignal,
): Promise<void> {
  const args: Record<string, unknown> = { op };
  if (device) args.device = device;
  try {
    await daemon.request("bench.check", args, { signal, timeoutMs: 15_000 });
  } catch (e) {
    if (noBenchSupport(e)) return;
    if (e instanceof HilError && (e.code === "NO_DEVICE" || e.code === "AMBIGUOUS_DEVICE")) return;
    throw e;
  }
}

// ── shared schema pieces ─────────────────────────────────────────────────────

const Device = z.string().min(1).optional()
  .describe("Device id (dev_xxxx) or one of its port paths; omit when one CrossPad is connected. An id works even while the board is unplugged or in DFU.");

const LeaseOut = z.record(z.string(), z.unknown()).nullable();

const O_Bench = {
  success: z.boolean(),
  granted: z.boolean().optional(),
  released: z.boolean().optional(),
  left_queue: z.boolean().optional(),
  holder: z.string().optional(),
  device: z.string().optional(),
  position: z.number().int().optional(),
  message: z.string().optional(),
  lease: LeaseOut.optional(),
  queue: z.array(z.record(z.string(), z.unknown())).optional(),
  reserved_for: z.record(z.string(), z.unknown()).optional(),
  firmware: z.record(z.string(), z.unknown()).nullable().optional(),
  history: z.array(z.record(z.string(), z.unknown())).optional(),
  devices: z.array(z.record(z.string(), z.unknown())).optional(),
  now: z.number().optional(),
  now_at: z.string().optional(),
  path: z.string().optional(),
  session_holder: z.string().nullable().optional(),
  hint: z.string().optional(),
  ts: z.number().optional(),
  error: ErrorSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

function hidden(ctx: ToolContext, tool: string, args: Record<string, unknown>): ToolResult | null {
  if (decide(ctx.policy, tool, args) !== "hidden") return null;
  return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${tool} is hidden by policy` } });
}

// ── crosspad_bench_claim ─────────────────────────────────────────────────────

export const ClaimInput = {
  holder: z.string().trim().min(1).max(120)
    .describe("Your session's name, e.g. 'platform-idf-cf' or 'crosspad-web-twin'. Use the same name every time: it is how the lease knows you."),
  purpose: z.string().trim().min(1).max(500)
    .describe("What you are about to do and which firmware you will flash, e.g. 'firmware_app test on pidf eac76e8, ~40 min'. Other sessions see it."),
  ttl_min: z.number().min(1).max(720).optional()
    .describe("Minutes before the lease expires unless renewed (default 30). Every hardware call you make renews it, and a running scenario or OTA keeps it alive."),
  device: Device,
  force: z.boolean().optional()
    .describe("Take the board from its current holder. Only for a holder that is gone (no answer, long past its ETA); it is logged in the board's history."),
};

export function registerBenchClaimTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    CLAIM_TOOL,
    {
      description:
        "[ESP HW | STM HW] Claim the shared CrossPad before touching it. Several sessions use one board; opening its CDC port for a " +
        "moment or flashing it breaks whoever is mid-test, so the board is leased: one holder, a queue behind it, expiry after the ttl " +
        "without renewal.\n" +
        "granted=true: you hold it. This server then sends your holder name with every hardware call (flash, cdc, console, midi, " +
        "snapshot, hil_run, capture, trace…) and each call renews the lease.\n" +
        "granted=false: someone else holds it — `message` names them and their ETA, `position` is your place in the queue. Hardware " +
        "tools refuse with BENCH_BUSY until you hold it; call this again later (it refreshes your place; a place not refreshed for an " +
        "hour lapses). When the holder releases, the head of the queue has 10 minutes to claim.\n" +
        "Calling it while you hold the board renews the lease. When done, crosspad_bench_release with firmware_left.",
      inputSchema: ClaimInput,
      outputSchema: O_Bench,
      annotations: annotationsFor(tierOf(CLAIM_TOOL, {})),
    },
    async (args, extra): Promise<ToolResult> => {
      const blocked = hidden(ctx, CLAIM_TOOL, args as Record<string, unknown>);
      if (blocked) return blocked;
      const daemon = ctx.daemon();
      try {
        const opArgs: Record<string, unknown> = { holder: args.holder, purpose: args.purpose };
        if (args.ttl_min !== undefined) opArgs.ttl_s = Math.round(args.ttl_min * 60);
        if (args.device) opArgs.device = args.device;
        if (args.force) opArgs.bench_force = true;
        const r = await daemon.request<Record<string, unknown>>("bench.claim", opArgs, { signal: extra.signal });
        (daemon as HolderSlot).benchHolder = args.holder;
        const hint = r.granted
          ? "You hold the board. Release it with crosspad_bench_release firmware_left='<what is on the board now>' when you are done."
          : "Not yours yet: do not touch the board. Call crosspad_bench_claim again later to check (and keep your place); crosspad_bench_status shows the queue.";
        return jsonResponse({ success: true, ...r, hint, ts: Date.now() });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}

// ── crosspad_bench_release ───────────────────────────────────────────────────

export const ReleaseInput = {
  firmware_left: z.string().trim().min(1).max(500)
    .describe("What is on the board now — repo, branch, commit (ESP and STM) — e.g. 'ESP: platform-idf feat/fw-homebrew-r2 eac76e8; STM unchanged'. The next session reads it instead of guessing."),
  holder: z.string().trim().min(1).max(120).optional()
    .describe("Defaults to the name this session claimed with."),
  device: Device,
  force: z.boolean().optional()
    .describe("Release somebody else's lease (a session that died holding it). Logged in the board's history."),
};

export function registerBenchReleaseTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    RELEASE_TOOL,
    {
      description:
        "[ESP HW | STM HW] Give the shared CrossPad back after crosspad_bench_claim, recording what firmware you left on it. The head of " +
        "the queue gets the board next. Called while you are only queued, it takes you out of the queue.",
      inputSchema: ReleaseInput,
      outputSchema: O_Bench,
      annotations: annotationsFor(tierOf(RELEASE_TOOL, {})),
    },
    async (args, extra): Promise<ToolResult> => {
      const blocked = hidden(ctx, RELEASE_TOOL, args as Record<string, unknown>);
      if (blocked) return blocked;
      const daemon = ctx.daemon();
      try {
        const holder = args.holder ?? (daemon as HolderSlot).benchHolder ?? undefined;
        if (!holder) {
          throw new HilError("BAD_ARGS", "no holder: this session has not claimed the bench",
            "pass holder=<the name the lease was claimed with>");
        }
        const opArgs: Record<string, unknown> = { holder, firmware_left: args.firmware_left };
        if (args.device) opArgs.device = args.device;
        if (args.force) opArgs.bench_force = true;
        const r = await daemon.request<Record<string, unknown>>("bench.release", opArgs, { signal: extra.signal });
        return jsonResponse({ success: true, holder, ...r, ts: Date.now() });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}

// ── crosspad_bench_status ────────────────────────────────────────────────────

export const StatusInput = {
  device: Device,
  history: z.number().int().min(0).max(30).optional()
    .describe("How many past leases to include per board (default 10)."),
};

export function registerBenchStatusTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    STATUS_TOOL,
    {
      description:
        "Who holds the shared CrossPad, until when, who is queued, what firmware the last holder left on it, and the recent history " +
        "(releases, expiries, forced overrides). Touches no hardware. `session_holder` is the name this session claimed with.",
      inputSchema: StatusInput,
      outputSchema: O_Bench,
      annotations: annotationsFor(tierOf(STATUS_TOOL, {})),
    },
    async (args, extra): Promise<ToolResult> => {
      const blocked = hidden(ctx, STATUS_TOOL, args as Record<string, unknown>);
      if (blocked) return blocked;
      const daemon = ctx.daemon();
      try {
        const opArgs: Record<string, unknown> = {};
        if (args.device) opArgs.device = args.device;
        if (args.history !== undefined) opArgs.history = args.history;
        const r = await daemon.request<Record<string, unknown>>("bench.status", opArgs, { signal: extra.signal });
        return jsonResponse({
          success: true, ...r, session_holder: (daemon as HolderSlot).benchHolder ?? null, ts: Date.now(),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
