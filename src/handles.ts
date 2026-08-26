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

export class HandleRegistry {
  private map = new Map<string, HandleMeta>();
  constructor(private readonly now: () => number = Date.now) {}

  register(handle: string, meta: { kind: HandleKind; device?: string }): void {
    const t = this.now();
    const m: HandleMeta = { kind: meta.kind, createdAt: t, lastTouch: t };
    if (meta.device !== undefined) m.device = meta.device;
    this.map.set(handle, m);
  }

  get(handle: string): HandleMeta | undefined {
    const m = this.map.get(handle);
    return m ? { ...m } : undefined;
  }

  touch(handle: string): void {
    const m = this.map.get(handle);
    if (m) m.lastTouch = this.now();
  }

  drop(handle: string): void {
    this.map.delete(handle);
  }

  list(): Array<HandleMeta & { handle: string }> {
    return [...this.map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([handle, m]) => ({ handle, ...m }));
  }
}

export const handles = new HandleRegistry();
