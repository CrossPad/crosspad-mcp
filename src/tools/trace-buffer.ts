export interface Sample { t: number; values: Record<string, number>; }
export interface SignalStats { min: number; max: number; avg: number; last: number; slope: number; first_t: number; last_t: number; n: number; }
export interface Point { t: number; v: number; }

export class TraceBuffer {
  private buf: Sample[] = [];
  constructor(private signals: string[], private capacity: number) {}

  push(s: Sample): void {
    this.buf.push(s);
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  count(): number { return this.buf.length; }
  signalNames(): string[] { return [...this.signals]; }

  stats(sig: string): SignalStats | null {
    const pts = this.buf.filter((s) => sig in s.values);
    if (pts.length === 0) return null;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const p of pts) { const v = p.values[sig]; if (v < min) min = v; if (v > max) max = v; sum += v; }
    const first = pts[0], last = pts[pts.length - 1];
    const dt = last.t - first.t;
    const slope = dt !== 0 ? (last.values[sig] - first.values[sig]) / dt : 0;
    return { min, max, avg: sum / pts.length, last: last.values[sig], slope, first_t: first.t, last_t: last.t, n: pts.length };
  }

  downsample(sig: string, maxPoints: number, window?: { fromT?: number; toT?: number }): Point[] {
    let pts: Point[] = this.buf
      .filter((s) => sig in s.values)
      .map((s) => ({ t: s.t, v: s.values[sig] }));
    if (window) {
      const lo = window.fromT ?? -Infinity, hi = window.toT ?? Infinity;
      pts = pts.filter((p) => p.t >= lo && p.t <= hi);
    }
    if (pts.length <= maxPoints) return pts;
    const last = pts[pts.length - 1];
    const stride = Math.ceil(pts.length / maxPoints);
    const out: Point[] = [];
    for (let i = 0; i < pts.length - 1; i += stride) {
      out.push(pts[i]);
      if (out.length >= maxPoints - 1) break;
    }
    if (out[out.length - 1].t !== last.t) out.push(last);
    return out;
  }

  /** Read-only view of stored samples (oldest→newest). */
  samples(): readonly Sample[] { return this.buf; }
}
