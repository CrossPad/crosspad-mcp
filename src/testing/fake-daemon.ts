// src/testing/fake-daemon.ts — a HilDaemon stand-in for vitest. Never spawns.
import { HilDaemon, HilError } from "../hil/daemon.js";

export type FakeDaemon = HilDaemon & { calls: Array<{ op: string; args: Record<string, unknown> }> };

/**
 * Build a daemon whose request() dispatches to `handlers[op]`. Unknown ops
 * raise HilError("UNKNOWN_OP") so a test that forgets a handler fails loudly
 * instead of resolving undefined. A handler may throw a HilError to simulate a
 * daemon error reply.
 */
export function fakeDaemon(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): FakeDaemon {
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const d = Object.create(HilDaemon.prototype) as FakeDaemon;
  d.calls = calls;
  Object.defineProperty(d, "alive", { get: () => true });
  (d as unknown as Record<string, unknown>).start = async () => {};
  (d as unknown as Record<string, unknown>).stop = async () => {};
  (d as unknown as Record<string, unknown>).request = async (
    op: string,
    args: Record<string, unknown>,
  ) => {
    calls.push({ op, args });
    const h = handlers[op];
    if (!h) throw new HilError("UNKNOWN_OP", `fakeDaemon: no handler for ${op}`);
    return h(args);
  };
  return d;
}
