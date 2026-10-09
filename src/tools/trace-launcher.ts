// src/tools/trace-launcher.ts — `crosspad-trace`: the SWD tracer and its
// dashboard from a terminal, built from trace-doctor, trace-session and
// trace-webui.
import path from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { WebSocket } from "ws";
import type { DoctorIssue, DoctorResult } from "./trace-doctor.js";
import { userConfigPath } from "../utils/userConfig.js";

export const EXIT_OK = 0;
export const EXIT_TRACE_FAILED = 1;
export const EXIT_ENVIRONMENT = 2;

export const DEFAULT_DASHBOARD_PORT = 7373;
/** Battery millivolts and the sixteen pad pressures (reg_map.h REG_IN_PAD_SUM_BASE):
 *  in every r20 Debug ELF, and pressing a pad shows the whole chain is live. */
export const DEFAULT_SIGNALS: readonly string[] = ["s_vbat_mv", "s_inputs[3:19]"];
/** As fast as the probe allows — the MCP tool's `start` default. */
export const TRACE_RATE_HZ = 0;
/** The dashboard greets every WebSocket client on connect; loopback needs far less. */
export const PROBE_TIMEOUT_MS = 1000;
const MAX_TCP_PORT = 65535;

/** Doctor issues the user fixes in their setup (venv, ELF path), not at the probe. */
const ENVIRONMENT_ISSUES = new Set(["pyocd_missing", "elf_missing"]);

/** skills/ ships in the npm package next to dist/, so this holds from src/ and dist/. */
export const SETUP_VENV_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "swd-tracer", "scripts", "setup-venv.sh",
);

export interface TraceCliOptions { signals: string[]; port: number; open: boolean; }

export type ParsedArgs =
  | { kind: "run"; opts: TraceCliOptions }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const USAGE = [
  "Usage: crosspad-trace [--signals <spec,...>] [--port <n>] [--no-open]",
  "",
  "Traces STM32 firmware variables over the ST-Link and opens the live dashboard.",
  "If a tracer dashboard already answers on the port, opens that one and starts",
  "nothing (--signals is then ignored). Ctrl+C stops the trace.",
  "",
  `  --signals  comma-separated signal specs (default: ${DEFAULT_SIGNALS.join(",")})`,
  `  --port     dashboard port (default: ${DEFAULT_DASHBOARD_PORT})`,
  "  --no-open  print the dashboard URL, do not open a browser",
  "",
  `Exit: ${EXIT_OK} ok or stopped, ${EXIT_TRACE_FAILED} no ST-Link or the trace failed,`,
  `      ${EXIT_ENVIRONMENT} setup (pyOCD venv, ELF, port taken, bad flag, bench busy).`,
].join("\n");

export function parseTraceCliArgs(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        signals: { type: "string" },
        port: { type: "string" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  const { values } = parsed;
  if (values.help) return { kind: "help" };

  const signals = values.signals === undefined
    ? [...DEFAULT_SIGNALS]
    : values.signals.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (signals.length === 0) return { kind: "error", message: "--signals needs at least one signal spec" };

  const port = values.port === undefined ? DEFAULT_DASHBOARD_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > MAX_TCP_PORT) {
    return { kind: "error", message: `--port must be an integer 1..${MAX_TCP_PORT}, got "${values.port}"` };
  }
  return { kind: "run", opts: { signals, port, open: !values["no-open"] } };
}

export interface DashboardHello { active: boolean; signals: string[]; }

export function parseHello(raw: string): DashboardHello | null {
  try {
    const m = JSON.parse(raw);
    if (!m || m.type !== "hello") return null;
    const signals = Array.isArray(m.signals)
      ? m.signals.filter((s: unknown): s is string => typeof s === "string")
      : [];
    return { active: m.active === true, signals };
  } catch {
    return null;
  }
}

/** Is the tracer dashboard serving `port` on loopback? It greets every WebSocket
 *  client with {type:"hello"}, which nothing else on the port sends. */
export function probeDashboard(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<DashboardHello | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const finish = (hello: DashboardHello | null): void => {
      clearTimeout(timer);
      ws.removeAllListeners();
      // terminate() on a socket still connecting emits 'error'; with no
      // listener the EventEmitter would throw it.
      ws.on("error", () => {});
      ws.terminate();
      resolve(hello);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    ws.on("message", (data) => finish(parseHello(data.toString())));
    ws.on("error", () => finish(null));
    ws.on("close", () => finish(null));
  });
}

export function isBlocking(issue: DoctorIssue): boolean {
  return issue.severity === "blocking" || issue.severity === "error";
}

export function doctorExitCode(r: DoctorResult): number {
  if (r.ok) return EXIT_OK;
  return r.issues.some((i) => isBlocking(i) && ENVIRONMENT_ISSUES.has(i.id)) ? EXIT_ENVIRONMENT : EXIT_TRACE_FAILED;
}

export function formatDoctorVerdict(r: DoctorResult): string[] {
  const lines = [r.ok ? "Tracer doctor: ready." : "Tracer doctor: not ready."];
  for (const issue of r.issues) {
    if (issue.severity === "info") continue;
    lines.push(`  [${issue.severity}] ${issue.id}: ${issue.detail}`);
    lines.push(`    fix: ${issue.suggested_fix}`);
    if (issue.id === "pyocd_missing") {
      lines.push(`    venv: bash ${SETUP_VENV_SCRIPT}, then set "pyocd_python" in ${userConfigPath()} (or CROSSPAD_TRACE_PYTHON)`);
    }
    if (issue.id === "elf_missing") {
      lines.push(`    config: "stm_elf_path" in ${userConfigPath()} (or CROSSPAD_STM_ELF)`);
    }
  }
  return lines;
}
