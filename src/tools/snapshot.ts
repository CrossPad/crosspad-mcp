// src/tools/snapshot.ts — crosspad_snapshot: one call, ~300 tokens, what the device
// (or the sim) is doing right now. Device → daemon snapshot.take; sim → the
// remote `stats` command mapped onto the same Snapshot shape (ui is null there
// until the sim grows ENC_GROUP — spec §11).
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SnapshotSchema, type Snapshot } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { jsonResponse, toolError, type ToolResult } from "../tool-result.js";
import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";

export const TOOL_NAME = "crosspad_snapshot";
/** Spec §3.7: snap_* — last 20 kept; unknown diff_from → full snapshot. */
const KEEP = 20;

export const INCLUDE_KEYS = ["apps", "ui", "kit", "leds", "pads", "mem", "ble", "console"] as const;

export class SnapshotStore {
  private readonly order: string[] = [];
  private readonly map = new Map<string, Snapshot>();

  put(snap: Snapshot): void {
    if (!this.map.has(snap.snapshot_id)) this.order.push(snap.snapshot_id);
    this.map.set(snap.snapshot_id, snap);
    while (this.order.length > KEEP) {
      const old = this.order.shift()!;
      this.map.delete(old);
    }
  }

  get(id: string): Snapshot | undefined {
    return this.map.get(id);
  }

  ids(): string[] {
    return [...this.order];
  }
}

export const snapshots = new SnapshotStore();

let simSeq = 0;

function hex2(n: unknown): string {
  const v = typeof n === "number" ? Math.max(0, Math.min(255, Math.round(n))) : 0;
  return v.toString(16).toUpperCase().padStart(2, "0");
}

/** Map crosspad-pc RemoteControl.cpp handle_stats() output onto the Snapshot shape. */
export function simStatsToSnapshot(stats: Record<string, unknown>, id: string): Snapshot {
  const pads = Array.isArray(stats.pads) ? (stats.pads as Array<Record<string, unknown>>) : [];
  const settings = (stats.settings ?? {}) as Record<string, unknown>;
  const heap = (stats.heap ?? {}) as Record<string, unknown>;
  const apps = Array.isArray(stats.apps) ? (stats.apps as string[]) : [];
  const active = typeof stats.active_pad_logic === "string" && stats.active_pad_logic !== "none" ? (stats.active_pad_logic as string) : null;
  const pressed: number[] = [];
  const playing: number[] = [];
  const colors: string[] = [];
  pads.forEach((p, i) => {
    if (p.pressed === true) pressed.push(i);
    if (p.playing === true) playing.push(i);
    colors.push(hex2(p.r) + hex2(p.g) + hex2(p.b));
  });
  return SnapshotSchema.parse({
    snapshot_id: id,
    device: "sim",
    usb_mode: "unknown",
    apps: { running: active, available: apps },
    ui: null,
    kit: { current: typeof settings.kit === "number" ? settings.kit : -1, name: null, loading: false, pending: -1 },
    leds: { brightness: typeof settings.rgb_brightness === "number" ? settings.rgb_brightness : null, anim: null, colors },
    pads: { pressed, playing },
    mem: {
      sram_free: heap.sram_free ?? null,
      sram_total: heap.sram_total ?? null,
      psram_free: heap.psram_free ?? null,
      psram_total: heap.psram_total ?? null,
    },
    ble: null,
    console: null,
    ts: Date.now() / 1000,
    changed: [],
  });
}

/** Top-level keys whose JSON differs (same rule as snapshot.py: dict inequality). */
export function changedKeys(prev: Snapshot, cur: Snapshot): string[] {
  const out: string[] = [];
  for (const k of INCLUDE_KEYS) {
    const a = JSON.stringify((prev as Record<string, unknown>)[k] ?? null);
    const b = JSON.stringify((cur as Record<string, unknown>)[k] ?? null);
    if (a !== b) out.push(k);
  }
  return out;
}

export async function takeDeviceSnapshot(
  ctx: ToolContext,
  device: string | undefined,
  include: string[] | undefined,
  diffFrom: string | undefined,
  signal: AbortSignal,
): Promise<Snapshot> {
  const opArgs: Record<string, unknown> = {};
  if (device !== undefined) opArgs.device = device;
  if (include !== undefined) opArgs.include = include;
  const previous = diffFrom ? snapshots.get(diffFrom) : undefined;
  if (previous) opArgs.previous = previous;
  const raw = await ctx.daemon().request<Record<string, unknown>>("snapshot.take", opArgs, { signal, timeoutMs: 30_000 });
  const snap = SnapshotSchema.parse(raw);
  snapshots.put(snap);
  ctx.handles.register(snap.snapshot_id, { kind: "snapshot", device: snap.device });
  return snap;
}

export async function takeSimSnapshot(ctx: ToolContext, diffFrom: string | undefined): Promise<Snapshot> {
  if (!(await isSimulatorRunning())) {
    const e = new Error("Simulator is not running. Use crosspad_run to start it.") as Error & { code: string };
    e.code = "SIM_NOT_RUNNING";
    throw e;
  }
  const resp = await sendRemoteCommand({ cmd: "stats" });
  if (!resp.ok) {
    const e = new Error((resp.error as string) || "stats failed") as Error & { code: string };
    e.code = "SIM_STATS_FAILED";
    throw e;
  }
  const { ok: _ok, ...stats } = resp;
  simSeq += 1;
  const snap = simStatsToSnapshot(stats, `snap_sim_${simSeq}`);
  const previous = diffFrom ? snapshots.get(diffFrom) : undefined;
  if (previous) snap.changed = changedKeys(previous, snap);
  snapshots.put(snap);
  ctx.handles.register(snap.snapshot_id, { kind: "snapshot", device: "sim" });
  return snap;
}

export const SnapshotInputShape = {
  target: z.enum(["device", "sim"]).describe("device = a connected CrossPad via the daemon; sim = the running PC simulator (ui is null there)"),
  device: z.string().min(1).optional().describe("Device id or port; omit when exactly one CrossPad is connected. Ignored for sim."),
  include: z.array(z.enum(INCLUDE_KEYS)).optional().describe("Sections to fill (default all). Fewer sections = fewer CDC round-trips."),
  diff_from: z.string().regex(/^snap_/).optional().describe("Earlier snapshot_id; result.changed lists the top-level keys that differ. Unknown id → full snapshot."),
};

export const SnapshotInput = z.object(SnapshotInputShape);

// The daemon's reply is spread into this envelope whole, and §3.3 says
// snapshot.take will grow top-level keys. Extending SnapshotSchema keeps its
// catchall, so a key we have never heard of is published as
// `additionalProperties` and passes the client's output validation. Spreading
// `.partial().shape` instead re-wrapped the keys in a fresh closed object, and
// the first new daemon key would have failed every call at the client.
export const O_Snapshot = SnapshotSchema.partial().extend({
  success: z.boolean(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

function codedError(e: unknown): ToolResult {
  const code = (e as { code?: string }).code;
  if (code && !(e instanceof Error && "details" in e)) {
    return jsonResponse({ success: false, error: { code, message: e instanceof Error ? e.message : String(e) } });
  }
  return toolError(e);
}

export function registerSnapshotTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW | PC sim] One-call state snapshot (~300 tokens): apps {running, available}, ui {focus {ref,label}, group [{ref,label}], drawer, theme, app}, kit, leds, pads, mem, ble, console counters. Refs `e<i>` are ENC_GROUP indices for crosspad_ui focus — any UI action invalidates them and the next snapshot re-mints them. diff_from=<snapshot_id> adds `changed`. target=sim maps the simulator's stats onto the same shape (ui null).",
      inputSchema: SnapshotInputShape,
      outputSchema: O_Snapshot,
      annotations: annotationsFor(tierOf(TOOL_NAME, {})),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const parsed = SnapshotInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: { code: "INVALID_ARGS", message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") },
        });
      }
      const args = parsed.data;
      if (decide(ctx.policy, TOOL_NAME, args as Record<string, unknown>) === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      try {
        const snap = args.target === "sim"
          ? await takeSimSnapshot(ctx, args.diff_from)
          : await takeDeviceSnapshot(ctx, args.device, args.include, args.diff_from, extra.signal);
        return jsonResponse({ success: true, ...snap });
      } catch (e) {
        return codedError(e);
      }
    },
  );
}
