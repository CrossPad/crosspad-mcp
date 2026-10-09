#!/usr/bin/env node
// crosspad-trace: the SWD tracer and its dashboard without an MCP client.
import { getHilDaemon } from "./hil/daemon.js";
import { benchGate } from "./tools/bench.js";
import { runDoctor, realProbe } from "./tools/trace-doctor.js";
import { TraceSession } from "./tools/trace-session.js";
import { getDashboard, openInBrowser } from "./tools/trace-webui.js";
import { BENCH_OP, EXIT_TRACE_FAILED, probeDashboard, runTraceCli, type StopSignal } from "./tools/trace-launcher.js";

/** The same check crosspad_trace start makes. CROSSPAD_BENCH_MODE reaches the
 *  daemon through the inherited environment. The trace itself never needs the
 *  daemon, so it is stopped once the answer is in. */
async function benchCheck(holder: string): Promise<void> {
  const daemon = getHilDaemon();
  daemon.benchHolder = holder;
  try {
    await benchGate(daemon, BENCH_OP);
  } finally {
    await daemon.stop();
  }
}

/** SIGTERM is how a parent (CP Tools) ends the trace; it gets the same clean stop as Ctrl+C. */
function stopOnSignals(): StopSignal {
  let requested = false;
  let fire: () => void = () => {};
  const promise = new Promise<void>((resolve) => { fire = resolve; });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { requested = true; fire(); });
  }
  return { get requested() { return requested; }, promise };
}

try {
  const code = await runTraceCli(process.argv.slice(2), {
    probeDashboard: (port) => probeDashboard(port),
    benchCheck,
    runDoctor: () => runDoctor(realProbe()),
    dashboard: getDashboard(),
    createSession: (opts) => new TraceSession(opts),
    openBrowser: openInBrowser,
    stop: stopOnSignals(),
    out: (line) => { process.stdout.write(line + "\n"); },
    err: (line) => { process.stderr.write(line + "\n"); },
  });
  process.exit(code);
} catch (e) {
  process.stderr.write(`crosspad-trace failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(EXIT_TRACE_FAILED);
}
