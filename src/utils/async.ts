// src/utils/async.ts — bounded-concurrency helpers for the request path.
//
// v10 removed execSync/spawnSync from every tool handler (spec §3.7): a
// synchronous subprocess blocks the whole event loop, so nothing else the
// server is doing — a daemon reply, a progress notification, a cancellation —
// can be serviced while git is running. The replacements are promise-returning,
// which means N repos can be walked at once; that is what mapLimit bounds, so
// "check every repo" does not fork 12 gits at the same instant.
export const DEFAULT_CONCURRENCY = 4;

export class AbortedError extends Error {
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortedError";
  }
}

/**
 * Map `items` through `fn` with at most `limit` in flight, preserving input
 * order in the result. A rejection is propagated once every in-flight worker
 * has settled (so no rejection is left unhandled) and no further items start.
 *
 * `signal` stops *scheduling*; work already in flight is expected to honour the
 * same signal itself (every runner in utils/exec.ts does).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (failed || signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (!failed) {
          failed = true;
          failure = e;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  if (failed) throw failure;
  if (signal?.aborted) throw new AbortedError();
  return results;
}

/** mapLimit over the entries of a record, keyed results back into a record. */
export async function mapRecordLimit<V, R>(
  record: Record<string, V>,
  limit: number,
  fn: (key: string, value: V) => Promise<R>,
  signal?: AbortSignal,
): Promise<Record<string, R>> {
  const entries = Object.entries(record);
  const values = await mapLimit(entries, limit, ([k, v]) => fn(k, v), signal);
  const out: Record<string, R> = {};
  entries.forEach(([k], i) => { out[k] = values[i]; });
  return out;
}
