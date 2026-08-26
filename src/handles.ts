// src/handles.ts — the TS-side view of handles (con_*, cdc_*, task_*, snap_*).
// The daemon owns device-side handles; this registry only tracks what this
// server minted or was given, so `crosspad://workspace` and expiry messages
// can name them. Single module, no globals inside tools (spec §3.7).
export type HandleKind = "console" | "cdc" | "task" | "snapshot" | "capture" | "stimulus" | "ble";

export interface HandleMeta {
  kind: HandleKind;
  device?: string;
  createdAt: number;
  lastTouch: number;
}

/** Why a handle stopped being usable — the model needs to tell "you waited too
 *  long" apart from "you made that id up". */
export type ExpiryReason = "idle" | "max_age" | "evicted";

export type Lookup =
  | { status: "live"; meta: HandleMeta }
  | { status: "expired"; kind: HandleKind; reason: ExpiryReason; hint: string }
  | { status: "unknown" };

const MIN = 60_000;

interface Expiry {
  /** Dropped this long after the last touch. */
  idle?: number;
  /** Dropped this long after being minted, however busy it was. */
  max?: number;
  /** Only the newest N of this kind survive. */
  keep?: number;
  hint: string;
}

// Spec §3.7's table, verbatim where it says something. A kind it does not list
// keeps no TTL rather than getting one invented for it.
const EXPIRY: Record<HandleKind, Expiry> = {
  console: { idle: 30 * MIN, hint: "console.open again; the log file it was writing is kept" },
  // cdc_* is the same shape of thing as con_* — a port held open on the caller's
  // behalf — so it ages out on the same idle clock.
  cdc: { idle: 30 * MIN, hint: "re-open the CDC connection" },
  // The registry cannot see a job finish, and JobRegistry drops a job an hour
  // after it reaches a terminal state, so "an hour with nobody asking" is the
  // closest honest stand-in for the spec's "1 h after terminal". Expiring the
  // handle only removes it from the listing — crosspad_task reads JobRegistry
  // directly and keeps working on a long soak that nobody polls.
  task: { idle: 60 * MIN, hint: "crosspad_task {action:\"list\"} for jobs the registry still has" },
  capture: { max: 15 * MIN, hint: "crosspad_capture {action:\"stop\"} — an abandoned take leaves the board in the USB-audio profile" },
  stimulus: { max: 15 * MIN, hint: "crosspad_stimulus {action:\"stop\"} to be sure the pads are quiet" },
  ble: { hint: "" },
  snapshot: { keep: 20, hint: "take a fresh snapshot; diff_from against an evicted id falls back to a full one" },
};

/** How many expired handles stay nameable. Enough to cover a session's worth of
 *  "why did that stop working", small enough that this cannot become the leak. */
const TOMBSTONES = 64;

export class HandleRegistry {
  private map = new Map<string, HandleMeta>();
  private dead = new Map<string, { kind: HandleKind; reason: ExpiryReason }>();
  constructor(private readonly now: () => number = Date.now) {}

  register(handle: string, meta: { kind: HandleKind; device?: string }): void {
    const t = this.now();
    this.sweep(t);
    const m: HandleMeta = { kind: meta.kind, createdAt: t, lastTouch: t };
    if (meta.device !== undefined) m.device = meta.device;
    this.dead.delete(handle);
    this.map.set(handle, m);
    this.evictOverflow(meta.kind);
  }

  get(handle: string): HandleMeta | undefined {
    const r = this.lookup(handle);
    return r.status === "live" ? r.meta : undefined;
  }

  /** The answer `get` cannot give: expired is not the same as never existed. */
  lookup(handle: string): Lookup {
    this.sweep(this.now());
    const m = this.map.get(handle);
    if (m) return { status: "live", meta: { ...m } };
    const d = this.dead.get(handle);
    if (d) return { status: "expired", kind: d.kind, reason: d.reason, hint: EXPIRY[d.kind].hint };
    return { status: "unknown" };
  }

  touch(handle: string): void {
    const t = this.now();
    this.sweep(t);
    const m = this.map.get(handle);
    if (m) m.lastTouch = t;
  }

  drop(handle: string): void {
    this.map.delete(handle);
    this.dead.delete(handle);
  }

  list(): Array<HandleMeta & { handle: string }> {
    this.sweep(this.now());
    return [...this.map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([handle, m]) => ({ handle, ...m }));
  }

  /** Time-based expiry, run whenever the registry is touched — a timer here
   *  would keep the whole process alive for the sake of bookkeeping. */
  private sweep(now: number): void {
    for (const [handle, m] of this.map) {
      const e = EXPIRY[m.kind];
      if (e.max !== undefined && now - m.createdAt >= e.max) this.bury(handle, m.kind, "max_age");
      else if (e.idle !== undefined && now - m.lastTouch >= e.idle) this.bury(handle, m.kind, "idle");
    }
  }

  /** Count-capped kinds (snap_*: last 20) drop their oldest on the way in. */
  private evictOverflow(kind: HandleKind): void {
    const keep = EXPIRY[kind].keep;
    if (keep === undefined) return;
    // Map iterates in insertion order, and register() re-inserts, so the head
    // of this list is the least recently minted.
    const ofKind = [...this.map.entries()].filter(([, m]) => m.kind === kind);
    for (const [handle] of ofKind.slice(0, Math.max(0, ofKind.length - keep))) {
      this.bury(handle, kind, "evicted");
    }
  }

  private bury(handle: string, kind: HandleKind, reason: ExpiryReason): void {
    this.map.delete(handle);
    this.dead.set(handle, { kind, reason });
    while (this.dead.size > TOMBSTONES) this.dead.delete(this.dead.keys().next().value!);
  }
}

export const handles = new HandleRegistry();
