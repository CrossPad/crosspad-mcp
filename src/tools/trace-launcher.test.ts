import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import http from "http";
import net from "net";
import { Dashboard } from "./trace-webui.js";
import type { DoctorResult } from "./trace-doctor.js";
import type { Frame, TraceSession } from "./trace-session.js";
import { HilError } from "../hil/daemon.js";
import {
  BENCH_HOLDER_ENV, DEFAULT_BENCH_HOLDER,
  DEFAULT_DASHBOARD_PORT, DEFAULT_SIGNALS, EXIT_ENVIRONMENT, EXIT_OK, EXIT_RACE_GRACE_MS, EXIT_TRACE_FAILED,
  PROBE_TIMEOUT_MS, SETUP_VENV_SCRIPT, TRACE_RATE_HZ, USAGE,
  benchHolder, doctorExitCode, formatBenchRefusal, formatDoctorVerdict, parseHello, parseTraceCliArgs,
  probeDashboard, runTraceCli,
  type StopSignal, type TraceCliDeps, type TraceRun,
} from "./trace-launcher.js";

const servers: net.Server[] = [];
const dashboards: Dashboard[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dashboards.splice(0)) (d as any).server?.close();
});
afterEach(() => { vi.unstubAllEnvs(); });

async function listen(s: net.Server): Promise<number> {
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as net.AddressInfo).port;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

async function startDashboard(): Promise<Dashboard> {
  const d = new Dashboard();
  dashboards.push(d);
  await d.ensureStarted(0);
  return d;
}

const OK_DOCTOR: DoctorResult = { ok: true, issues: [] };
const NO_VENV: DoctorResult = {
  ok: false,
  issues: [{
    id: "pyocd_missing", severity: "blocking",
    detail: "pyocd Python package not importable — required to talk to the ST-Link.",
    suggested_fix: "Run: pip install pyocd pyelftools  (use the interpreter set in config key 'pyocd_python').",
  }],
};
const NO_ELF: DoctorResult = {
  ok: false,
  issues: [{
    id: "elf_missing", severity: "blocking",
    detail: "Firmware ELF not found at /fw/build/Debug/CrossPad_STM32_r20.elf — symbol resolution needs it.",
    suggested_fix: "Build a Debug firmware (cmake --build build/Debug) or set config key 'stm_elf_path' to the real ELF.",
  }],
};
const NO_PROBE: DoctorResult = {
  ok: false,
  issues: [{
    id: "no_probe_detected", severity: "error",
    detail: "No ST-Link detected on USB (replug the probe).",
    suggested_fix: "Reconnect the ST-Link USB cable; verify with `pyocd list` / `lsusb`.",
  }],
};

describe("parseTraceCliArgs", () => {
  it("defaults: battery + pad pressures, port 7373, browser on", () => {
    expect(parseTraceCliArgs([])).toEqual({
      kind: "run",
      opts: { signals: ["s_vbat_mv", "s_inputs[3:19]"], port: DEFAULT_DASHBOARD_PORT, open: true },
    });
  });

  it("splits --signals on commas, trims, drops empty specs", () => {
    const r = parseTraceCliArgs(["--signals", " s_vbat_mv, ,g_trace_demo.demo_sine "]);
    expect(r).toMatchObject({ kind: "run", opts: { signals: ["s_vbat_mv", "g_trace_demo.demo_sine"] } });
  });

  it("accepts --signals=value with bracket syntax", () => {
    expect(parseTraceCliArgs(["--signals=s_adc_raw[*]"])).toMatchObject({ opts: { signals: ["s_adc_raw[*]"] } });
  });

  it("returns a copy of the defaults, never the constant itself", () => {
    const r = parseTraceCliArgs([]);
    expect(r.kind === "run" && r.opts.signals).not.toBe(DEFAULT_SIGNALS);
  });

  it("--port and --no-open", () => {
    expect(parseTraceCliArgs(["--port", "17373", "--no-open"])).toEqual({
      kind: "run", opts: { signals: [...DEFAULT_SIGNALS], port: 17373, open: false },
    });
  });

  it.each([[""], [","], [" , "]])("rejects --signals %j with no spec", (v) => {
    const r = parseTraceCliArgs(["--signals", v]);
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.message).toContain("--signals");
  });

  it.each([["0"], ["65536"], ["abc"], ["7373.5"], [""]])("rejects --port %j", (v) => {
    const r = parseTraceCliArgs(["--port", v]);
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.message).toContain("--port");
  });

  it("rejects unknown flags and positionals", () => {
    expect(parseTraceCliArgs(["--rate", "100"]).kind).toBe("error");
    expect(parseTraceCliArgs(["s_vbat_mv"]).kind).toBe("error");
    expect(parseTraceCliArgs(["--signals"]).kind).toBe("error");
  });

  it("-h / --help", () => {
    expect(parseTraceCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseTraceCliArgs(["--help"])).toEqual({ kind: "help" });
  });
});

describe("parseHello", () => {
  it("reads the dashboard greeting", () => {
    expect(parseHello('{"type":"hello","active":true,"signals":["s_vbat_mv",7,"s_inputs[3]"]}'))
      .toEqual({ active: true, signals: ["s_vbat_mv", "s_inputs[3]"] });
    expect(parseHello('{"type":"hello","active":false}')).toEqual({ active: false, signals: [] });
  });

  it("is null for anything else", () => {
    expect(parseHello('{"type":"sample","t":1,"values":{}}')).toBeNull();
    expect(parseHello("<html>")).toBeNull();
    expect(parseHello("null")).toBeNull();
  });
});

describe("probeDashboard", () => {
  it("recognises the tracer dashboard by its hello", async () => {
    const d = await startDashboard();
    expect(await probeDashboard(d.port)).toEqual({ active: false, signals: [] });
  });

  it("is null for a closed port", async () => {
    expect(await probeDashboard(await freePort())).toBeNull();
  });

  it("is null for an HTTP server that is not the dashboard", async () => {
    const port = await listen(http.createServer((_req, res) => { res.writeHead(404); res.end(); }));
    expect(await probeDashboard(port)).toBeNull();
  });

  it("gives up on a port that accepts and never answers", async () => {
    const port = await listen(net.createServer());
    const quick = PROBE_TIMEOUT_MS / 5;
    const t0 = Date.now();
    expect(await probeDashboard(port, quick)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(PROBE_TIMEOUT_MS);
  });
});

describe("doctor verdict", () => {
  it("ready, with warnings shown and info hidden", () => {
    const lines = formatDoctorVerdict({
      ok: true,
      issues: [
        { id: "udev_missing", severity: "warning", detail: "No ST-Link udev rules found", suggested_fix: "bash install-udev-rules.sh" },
        { id: "config_defaults", severity: "info", detail: "No user-config keys set", suggested_fix: "config_set" },
      ],
    });
    expect(lines[0]).toBe("Tracer doctor: ready.");
    expect(lines.join("\n")).toContain("[warning] udev_missing: No ST-Link udev rules found");
    expect(lines.join("\n")).toContain("fix: bash install-udev-rules.sh");
    expect(lines.join("\n")).not.toContain("config_defaults");
  });

  it("a missing venv names the fix, the setup script and the config key", () => {
    const text = formatDoctorVerdict(NO_VENV).join("\n");
    expect(text).toContain("Tracer doctor: not ready.");
    expect(text).toContain("[blocking] pyocd_missing");
    expect(text).toContain("fix: Run: pip install pyocd pyelftools");
    expect(text).toContain(SETUP_VENV_SCRIPT);
    expect(text).toContain("pyocd_python");
    expect(text).toContain("CROSSPAD_TRACE_PYTHON");
  });

  it("a missing ELF names the config key and the env var", () => {
    const text = formatDoctorVerdict(NO_ELF).join("\n");
    expect(text).toContain("stm_elf_path");
    expect(text).toContain("CROSSPAD_STM_ELF");
  });

  it("the setup script it points at exists", () => {
    expect(fs.existsSync(SETUP_VENV_SCRIPT)).toBe(true);
  });

  it("exit code: environment 2, probe 1, ready 0", () => {
    expect(doctorExitCode(OK_DOCTOR)).toBe(EXIT_OK);
    expect(doctorExitCode(NO_VENV)).toBe(EXIT_ENVIRONMENT);
    expect(doctorExitCode(NO_ELF)).toBe(EXIT_ENVIRONMENT);
    expect(doctorExitCode(NO_PROBE)).toBe(EXIT_TRACE_FAILED);
    expect(doctorExitCode({ ok: false, issues: [...NO_PROBE.issues, ...NO_VENV.issues] })).toBe(EXIT_ENVIRONMENT);
  });
});

class FakeRun implements TraceRun {
  deviceState = "connecting";
  filePath: string | null = "/traces/trace-4242.cptrace";
  starts = 0;
  stops = 0;
  private running = true;
  private stoppedCbs: Array<() => void> = [];
  constructor(private readonly first: Frame | null, private readonly tail = "") {}
  start(): void { this.starts++; }
  waitForFirstFrame(): Promise<Frame | null> { return Promise.resolve(this.first); }
  stop(): void { this.stops++; this.exit("exited"); }
  onStopped(cb: () => void): void { if (this.running) this.stoppedCbs.push(cb); else cb(); }
  isRunning(): boolean { return this.running; }
  stderrTail(): string { return this.tail; }
  /** The daemon process going away, whatever the reason. */
  exit(state: string): void {
    if (!this.running) return;
    this.running = false;
    this.deviceState = state;
    for (const cb of this.stoppedCbs.splice(0)) cb();
  }
}

const SIGNALS_FRAME: Frame = { type: "signals", signals: [], unresolved: [] };
const READY_LINE = "Ctrl+C stops the trace.";

function manualStop(): { signal: StopSignal; trigger: () => void } {
  let fire: () => void = () => {};
  const state = { requested: false };
  const promise = new Promise<void>((resolve) => { fire = resolve; });
  return {
    signal: { get requested() { return state.requested; }, promise },
    trigger: () => { state.requested = true; fire(); },
  };
}

function harness(session: FakeRun = new FakeRun(SIGNALS_FRAME)) {
  const out: string[] = [];
  const err: string[] = [];
  const stop = manualStop();
  const deps: TraceCliDeps<FakeRun> = {
    probeDashboard: vi.fn(async () => null),
    benchCheck: vi.fn(async (_holder: string) => {}),
    runDoctor: vi.fn(async () => OK_DOCTOR),
    dashboard: {
      ensureStarted: vi.fn(async (port: number) => `http://localhost:${port}/`),
      bind: vi.fn(),
      unbind: vi.fn(),
    },
    createSession: vi.fn(() => session),
    openBrowser: vi.fn(() => true),
    stop: stop.signal,
    out: (line) => { out.push(line); },
    err: (line) => { err.push(line); },
  };
  return { deps, out, err, stop, session };
}

describe("runTraceCli — arguments", () => {
  it("--help prints the usage and exits 0", async () => {
    const h = harness();
    expect(await runTraceCli(["--help"], h.deps)).toBe(EXIT_OK);
    expect(h.out).toEqual([USAGE]);
    expect(h.deps.probeDashboard).not.toHaveBeenCalled();
  });

  it("a bad flag prints the error and the usage, exits 2, touches nothing", async () => {
    const h = harness();
    expect(await runTraceCli(["--port", "nope"], h.deps)).toBe(EXIT_ENVIRONMENT);
    expect(h.err[0]).toContain("--port");
    expect(h.err[1]).toBe(USAGE);
    expect(h.deps.probeDashboard).not.toHaveBeenCalled();
    expect(h.deps.dashboard.ensureStarted).not.toHaveBeenCalled();
  });
});

describe("runTraceCli — a dashboard already answers on the port", () => {
  it("opens the running dashboard and starts no session", async () => {
    const d = await startDashboard();
    const h = harness();
    h.deps.probeDashboard = (port) => probeDashboard(port);
    expect(await runTraceCli(["--port", String(d.port)], h.deps)).toBe(EXIT_OK);
    expect(h.deps.openBrowser).toHaveBeenCalledWith(`http://localhost:${d.port}/`);
    expect(h.deps.dashboard.ensureStarted).not.toHaveBeenCalled();
    expect(h.deps.benchCheck).not.toHaveBeenCalled();
    expect(h.deps.runDoctor).not.toHaveBeenCalled();
    expect(h.deps.createSession).not.toHaveBeenCalled();
    const text = h.out.join("\n");
    expect(text).toContain("no second pyOCD");
    expect(text).toContain("no trace running");
  });

  it("names the signals of the trace that dashboard shows", async () => {
    const d = await startDashboard();
    d.bind({ onFrame: () => {}, buffer: { signalNames: () => ["s_vbat_mv", "s_inputs[3]"] } } as unknown as TraceSession);
    const h = harness();
    h.deps.probeDashboard = (port) => probeDashboard(port);
    expect(await runTraceCli(["--port", String(d.port)], h.deps)).toBe(EXIT_OK);
    expect(h.out.join("\n")).toContain("It is tracing s_vbat_mv, s_inputs[3].");
  });

  it("--no-open attaches without a browser", async () => {
    const d = await startDashboard();
    const h = harness();
    h.deps.probeDashboard = (port) => probeDashboard(port);
    expect(await runTraceCli(["--port", String(d.port), "--no-open"], h.deps)).toBe(EXIT_OK);
    expect(h.deps.openBrowser).not.toHaveBeenCalled();
    expect(h.out.join("\n")).toContain(`http://localhost:${d.port}/`);
  });

  it("attaches to the instance that won the race for the port", async () => {
    const h = harness();
    h.deps.probeDashboard = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ active: true, signals: ["s_vbat_mv"] });
    h.deps.dashboard.ensureStarted = vi.fn(async () => {
      throw Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:7373"), { code: "EADDRINUSE" });
    });
    expect(await runTraceCli([], h.deps)).toBe(EXIT_OK);
    expect(h.deps.probeDashboard).toHaveBeenCalledTimes(2);
    expect(h.deps.benchCheck).not.toHaveBeenCalled();
    expect(h.deps.runDoctor).not.toHaveBeenCalled();
    expect(h.deps.createSession).not.toHaveBeenCalled();
    expect(h.out.join("\n")).toContain("It is tracing s_vbat_mv.");
  });

  it("refuses a port held by a program that is not the dashboard", async () => {
    const port = await listen(http.createServer((_req, res) => { res.writeHead(404); res.end(); }));
    const real = new Dashboard();
    const h = harness();
    h.deps.probeDashboard = (p) => probeDashboard(p);
    h.deps.dashboard = { ensureStarted: (p) => real.ensureStarted(p), bind: vi.fn(), unbind: vi.fn() };
    expect(await runTraceCli(["--port", String(port)], h.deps)).toBe(EXIT_ENVIRONMENT);
    const text = h.err.join("\n");
    expect(text).toContain(`Port ${port}`);
    expect(text).toContain("not the tracer dashboard");
    expect(h.deps.runDoctor).not.toHaveBeenCalled();
    expect(h.deps.createSession).not.toHaveBeenCalled();
  });

  it("any other listen failure exits 2 without probing twice", async () => {
    const h = harness();
    h.deps.dashboard.ensureStarted = vi.fn(async () => {
      throw Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:80"), { code: "EACCES" });
    });
    expect(await runTraceCli(["--port", "80"], h.deps)).toBe(EXIT_ENVIRONMENT);
    expect(h.err.join("\n")).toContain("EACCES");
    expect(h.deps.probeDashboard).toHaveBeenCalledTimes(1);
  });
});

const BUSY = new HilError(
  "BENCH_BUSY",
  "dev_ab12 is claimed by platform-idf-cf (firmware_app test) since 10:02; the lease runs to 10:40 (in 12 min) " +
    "unless renewed; you (crosspad-trace) may not run crosspad-trace start",
  "claim it to join the queue (crosspad_bench_claim / `crosspad-hil bench claim`), crosspad_bench_status shows the queue",
  {
    device: "dev_ab12", op: "crosspad-trace start", caller: "crosspad-trace",
    holder: "platform-idf-cf", purpose: "firmware_app test", since: 1760000000, expires: 1760002280,
    expires_in_s: 720, queue: ["crosspad-web-twin", "cp-tools"],
  },
);

describe("bench lease text", () => {
  it("holder: CROSSPAD_BENCH_HOLDER, else crosspad-trace", () => {
    expect(benchHolder({})).toBe(DEFAULT_BENCH_HOLDER);
    expect(benchHolder({ [BENCH_HOLDER_ENV]: "  " })).toBe(DEFAULT_BENCH_HOLDER);
    expect(benchHolder({ [BENCH_HOLDER_ENV]: " cp-tools " })).toBe("cp-tools");
  });

  it("a busy board names holder, purpose, expiry and queue in plain text", () => {
    const text = formatBenchRefusal(BUSY).join("\n");
    expect(text).toContain("Bench busy: dev_ab12 is claimed by platform-idf-cf");
    expect(text).toContain("holder: platform-idf-cf");
    expect(text).toContain("purpose: firmware_app test");
    expect(text).toContain("expires in: 12 min");
    expect(text).toContain("queue: crosspad-web-twin, cp-tools");
    expect(text).toContain("hint: claim it to join the queue");
  });

  it("an empty queue says so, and a board held for the queue head has no expiry line", () => {
    const reserved = new HilError("BENCH_BUSY", "dev_ab12 is free but held for cp-tools, first in the queue, until 10:50 (in 8 min)",
      undefined, { holder: "cp-tools", reserved_until: 1760002800, queue: [] });
    const text = formatBenchRefusal(reserved).join("\n");
    expect(text).toContain("holder: cp-tools");
    expect(text).toContain("queue: empty");
    expect(text).not.toContain("expires in");
  });

  it("any other daemon error is shown with its code", () => {
    const text = formatBenchRefusal(new HilError("TIMEOUT", "bench.check timed out after 15000 ms", "check `doctor`")).join("\n");
    expect(text).toContain("Bench check failed: TIMEOUT: bench.check timed out after 15000 ms");
    expect(text).toContain("hint: check `doctor`");
  });
});

describe("runTraceCli — bench lease", () => {
  it("asks the bench as crosspad-trace after binding the port and before the doctor", async () => {
    const h = harness();
    const run = runTraceCli([], h.deps);
    await vi.waitFor(() => expect(h.out).toContain(READY_LINE));
    expect(h.deps.benchCheck).toHaveBeenCalledWith(DEFAULT_BENCH_HOLDER);
    const bindOrder = vi.mocked(h.deps.dashboard.ensureStarted).mock.invocationCallOrder[0];
    const benchOrder = vi.mocked(h.deps.benchCheck).mock.invocationCallOrder[0];
    const doctorOrder = vi.mocked(h.deps.runDoctor).mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(benchOrder);
    expect(benchOrder).toBeLessThan(doctorOrder);
    h.stop.trigger();
    expect(await run).toBe(EXIT_OK);
  });

  it("asks as CROSSPAD_BENCH_HOLDER when it is set", async () => {
    vi.stubEnv(BENCH_HOLDER_ENV, "cp-tools");
    const h = harness();
    const run = runTraceCli([], h.deps);
    await vi.waitFor(() => expect(h.out).toContain(READY_LINE));
    expect(h.deps.benchCheck).toHaveBeenCalledWith("cp-tools");
    h.stop.trigger();
    await run;
  });

  it("a board held by another session: prints the lease, exits 2, no doctor, no pyOCD", async () => {
    const h = harness();
    h.deps.benchCheck = vi.fn(async () => { throw BUSY; });
    expect(await runTraceCli([], h.deps)).toBe(EXIT_ENVIRONMENT);
    const text = h.err.join("\n");
    expect(text).toContain("holder: platform-idf-cf");
    expect(text).toContain("purpose: firmware_app test");
    expect(text).toContain("expires in: 12 min");
    expect(text).toContain("queue: crosspad-web-twin, cp-tools");
    expect(h.deps.runDoctor).not.toHaveBeenCalled();
    expect(h.deps.createSession).not.toHaveBeenCalled();
  });

  it("a bench check that fails another way also exits 2 without pyOCD", async () => {
    const h = harness();
    h.deps.benchCheck = vi.fn(async () => { throw new HilError("TIMEOUT", "bench.check timed out after 15000 ms"); });
    expect(await runTraceCli([], h.deps)).toBe(EXIT_ENVIRONMENT);
    expect(h.err.join("\n")).toContain("TIMEOUT");
    expect(h.deps.createSession).not.toHaveBeenCalled();
  });
});

describe("runTraceCli — doctor", () => {
  it("a missing venv prints the verdict with its fix and exits 2 without a session", async () => {
    const h = harness();
    h.deps.runDoctor = vi.fn(async () => NO_VENV);
    expect(await runTraceCli([], h.deps)).toBe(EXIT_ENVIRONMENT);
    const text = h.err.join("\n");
    expect(text).toContain("pyocd_missing");
    expect(text).toContain("fix: Run: pip install pyocd");
    expect(h.deps.createSession).not.toHaveBeenCalled();
  });

  it("no ST-Link exits 1 without a session", async () => {
    const h = harness();
    h.deps.runDoctor = vi.fn(async () => NO_PROBE);
    expect(await runTraceCli([], h.deps)).toBe(EXIT_TRACE_FAILED);
    expect(h.err.join("\n")).toContain("no_probe_detected");
    expect(h.deps.createSession).not.toHaveBeenCalled();
  });

  it("Ctrl+C while the doctor runs starts no daemon", async () => {
    const h = harness();
    h.deps.runDoctor = vi.fn(async () => { h.stop.trigger(); return OK_DOCTOR; });
    expect(await runTraceCli([], h.deps)).toBe(EXIT_OK);
    expect(h.deps.createSession).not.toHaveBeenCalled();
  });
});

describe("runTraceCli — the trace", () => {
  it("binds the port, then the doctor, then the default signals at full rate, then the browser; Ctrl+C stops it", async () => {
    const h = harness();
    const run = runTraceCli([], h.deps);
    await vi.waitFor(() => expect(h.out).toContain(READY_LINE));
    const bindOrder = vi.mocked(h.deps.dashboard.ensureStarted).mock.invocationCallOrder[0];
    const doctorOrder = vi.mocked(h.deps.runDoctor).mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(doctorOrder);
    expect(h.deps.dashboard.ensureStarted).toHaveBeenCalledWith(DEFAULT_DASHBOARD_PORT);
    expect(h.deps.createSession).toHaveBeenCalledWith({ signals: [...DEFAULT_SIGNALS], rateHz: TRACE_RATE_HZ });
    expect(h.session.starts).toBe(1);
    expect(h.deps.dashboard.bind).toHaveBeenCalledWith(h.session);
    expect(h.deps.openBrowser).toHaveBeenCalledWith(`http://localhost:${DEFAULT_DASHBOARD_PORT}/`);
    expect(h.out).toContain("Tracer doctor: ready.");

    h.stop.trigger();
    expect(await run).toBe(EXIT_OK);
    expect(h.session.stops).toBe(1);
    expect(h.deps.dashboard.unbind).toHaveBeenCalled();
    expect(h.out.join("\n")).toContain("/traces/trace-4242.cptrace");
  });

  it("--signals and --no-open reach the session and the opener", async () => {
    const h = harness();
    const run = runTraceCli(["--signals", "g_trace_demo.demo_sine", "--no-open"], h.deps);
    await vi.waitFor(() => expect(h.out).toContain(READY_LINE));
    expect(h.deps.createSession).toHaveBeenCalledWith({ signals: ["g_trace_demo.demo_sine"], rateHz: TRACE_RATE_HZ });
    expect(h.deps.openBrowser).not.toHaveBeenCalled();
    h.stop.trigger();
    expect(await run).toBe(EXIT_OK);
  });

  it("a declined browser open still prints the URL and a note", async () => {
    const h = harness();
    h.deps.openBrowser = vi.fn(() => false);
    const run = runTraceCli([], h.deps);
    await vi.waitFor(() => expect(h.out).toContain(READY_LINE));
    const text = h.out.join("\n");
    expect(text).toContain(`http://localhost:${DEFAULT_DASHBOARD_PORT}/`);
    expect(text).toContain("open the URL yourself");
    h.stop.trigger();
    await run;
  });

  it("a daemon that cannot be spawned exits 2 and binds nothing", async () => {
    const s = new FakeRun(SIGNALS_FRAME);
    s.start = () => { throw new Error("EACCES: permission denied, mkdir '/opt/traces'"); };
    const h = harness(s);
    expect(await runTraceCli([], h.deps)).toBe(EXIT_ENVIRONMENT);
    expect(h.err.join("\n")).toContain("EACCES");
    expect(h.deps.dashboard.bind).not.toHaveBeenCalled();
  });

  it("a connect error frame exits 1 with the daemon's error and stderr tail, and frees the probe", async () => {
    const s = new FakeRun({ type: "error", error: "no debug probe detected" }, "pyocd.probe: ST-Link not found");
    const h = harness(s);
    expect(await runTraceCli([], h.deps)).toBe(EXIT_TRACE_FAILED);
    const text = h.err.join("\n");
    expect(text).toContain("Trace connect failed: no debug probe detected");
    expect(text).toContain("pyocd.probe: ST-Link not found");
    expect(s.stops).toBe(1);
    expect(h.deps.dashboard.unbind).toHaveBeenCalled();
    expect(h.deps.openBrowser).not.toHaveBeenCalled();
  });

  it("a daemon gone before its first frame exits 1 with its state", async () => {
    const s = new FakeRun(null);
    s.exit("error: daemon exited code 1");
    const h = harness(s);
    expect(await runTraceCli([], h.deps)).toBe(EXIT_TRACE_FAILED);
    expect(h.err.join("\n")).toContain("exited before producing data (error: daemon exited code 1)");
    expect(h.deps.dashboard.unbind).toHaveBeenCalled();
  });

  it("no frame yet but alive: carries on as connecting", async () => {
    const h = harness(new FakeRun(null));
    const run = runTraceCli([], h.deps);
    await vi.waitFor(() => expect(h.out).toContain(READY_LINE));
    expect(h.out.join("\n")).toContain("still connecting");
    h.stop.trigger();
    expect(await run).toBe(EXIT_OK);
  });

  it("a daemon that dies mid-trace exits 1 with its state", async () => {
    const h = harness();
    const run = runTraceCli([], h.deps);
    await vi.waitFor(() => expect(h.out).toContain(READY_LINE));
    h.session.exit("probe_lost");
    expect(await run).toBe(EXIT_TRACE_FAILED);
    expect(h.err.join("\n")).toContain("Trace ended on its own: probe_lost");
    expect(h.deps.dashboard.unbind).toHaveBeenCalled();
  });

  it("Ctrl+C that reaches the daemon before this process still counts as a stop", async () => {
    const h = harness();
    const run = runTraceCli([], h.deps);
    await vi.waitFor(() => expect(h.out).toContain(READY_LINE));
    h.session.exit("error: KeyboardInterrupt");
    setTimeout(h.stop.trigger, EXIT_RACE_GRACE_MS / 10);
    expect(await run).toBe(EXIT_OK);
    expect(h.out.join("\n")).toContain("Trace stopped");
  });
});
