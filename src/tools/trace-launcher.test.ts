import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import net from "net";
import { Dashboard } from "./trace-webui.js";
import type { DoctorResult } from "./trace-doctor.js";
import {
  DEFAULT_DASHBOARD_PORT, DEFAULT_SIGNALS, EXIT_ENVIRONMENT, EXIT_OK, EXIT_TRACE_FAILED,
  PROBE_TIMEOUT_MS, SETUP_VENV_SCRIPT,
  doctorExitCode, formatDoctorVerdict, parseHello, parseTraceCliArgs, probeDashboard,
} from "./trace-launcher.js";

const servers: net.Server[] = [];
const dashboards: Dashboard[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dashboards.splice(0)) (d as any).server?.close();
});

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
