// src/tools/doctor.ts — crosspad_doctor: host-side environment checks (TS) merged
// with the daemon's own devices.doctor (udev/dialout, port locks, rtmidi, sounddevice).
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { findClangd } from "../utils/clangd.js";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DoctorCheckSchema, type DoctorCheck } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { jsonResponse, toolError, type ToolResult } from "../tool-result.js";
import { resolveConfigValue } from "../utils/userConfig.js";
import { resolvedPython } from "./trace-symbols.js";
import { runArgvStream } from "../utils/exec.js";
import { CROSSPAD_IDF_ROOT, CROSSPAD_PC_ROOT, IDF_PATH, BIN_EXE, IS_WINDOWS } from "../config.js";

export const TOOL_NAME = "crosspad_doctor";

const requireJson = createRequire(import.meta.url);

export interface DoctorProbe {
  hilPython(): string;
  pythonRunnable(py: string): Promise<boolean>;
  /** crosspad_hil.__version__ or null when not importable. */
  hilVersion(py: string): Promise<string | null>;
  requiredHilVersion(): string;
  idfRoot(): string;
  idfExportExists(): boolean;
  pcRoot(): string;
  exists(p: string): boolean;
  mtimeMs(p: string): number | null;
  /** Newest *.c/*.cpp/*.h/*.hpp mtime under root/src (bounded walk), or null. */
  newestSourceMtimeMs(root: string): number | null;
  simBinary(): string;
  clangdPath(): string | null;
}

export const O_Doctor = {
  success: z.boolean(),
  ok: z.boolean().optional(),
  checks: z.array(DoctorCheckSchema).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/** Numeric semver compare on the first three dot-separated components (pre-release tags ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Same resolution as getHilDaemon(): config hil_python → $CROSSPAD_HIL_PYTHON → tracer venv python → python3. */
export function resolveHilPython(): string {
  return resolveConfigValue("hil_python", "CROSSPAD_HIL_PYTHON", process.env.CROSSPAD_HIL_PYTHON, resolvedPython());
}

function ageText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export async function runDoctorChecks(
  p: DoctorProbe,
  daemonChecks: () => Promise<DoctorCheck[]>,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. hil_python resolvable and runnable
  const py = p.hilPython();
  const runnable = await p.pythonRunnable(py);
  checks.push({
    name: "hil_python",
    ok: runnable,
    detail: runnable ? `interpreter: ${py}` : `cannot run ${py}`,
    fix: runnable ? "" : "Set config key 'hil_python' to a Python ≥3.10 with crosspad-hil installed (crosspad_trace action=config_set key=hil_python), or install it: python3 -m pip install 'crosspad-hil[all]'.",
  });

  // 2. crosspad_hil importable and new enough
  const required = p.requiredHilVersion();
  if (!runnable) {
    checks.push({ name: "hil_version", ok: false, detail: "skipped: interpreter not runnable", fix: "Fix hil_python first." });
  } else {
    const v = await p.hilVersion(py);
    if (v === null) {
      checks.push({
        name: "hil_version",
        ok: false,
        detail: `crosspad_hil not importable from ${py}`,
        fix: `${py} -m pip install 'crosspad-hil[all]>=${required}'`,
      });
    } else {
      const ok = compareVersions(v, required) >= 0;
      checks.push({
        name: "hil_version",
        ok,
        detail: ok ? `crosspad-hil ${v} (≥ ${required})` : `crosspad-hil ${v} is older than required ${required}`,
        fix: ok ? "" : `${py} -m pip install --upgrade 'crosspad-hil[all]>=${required}'`,
      });
    }
  }

  // 3. IDF project root
  const idfRoot = p.idfRoot();
  const idfOk = p.exists(idfRoot);
  checks.push({
    name: "idf_root",
    ok: idfOk,
    detail: idfOk ? idfRoot : `platform-idf not found at ${idfRoot}`,
    fix: idfOk ? "" : "Clone CrossPad/platform-idf or set CROSSPAD_IDF_ROOT.",
  });

  // 4. IDF environment (export.sh / export.bat)
  const idfEnv = p.idfExportExists();
  checks.push({
    name: "idf_env",
    ok: idfEnv,
    detail: idfEnv ? `ESP-IDF at ${IDF_PATH}` : `no export script under ${IDF_PATH}`,
    fix: idfEnv ? "" : "Install ESP-IDF v5.5 (~/esp/esp-idf) or set IDF_PATH.",
  });

  // 5. PC root
  const pcRoot = p.pcRoot();
  const pcOk = p.exists(pcRoot);
  checks.push({
    name: "pc_root",
    ok: pcOk,
    detail: pcOk ? pcRoot : `crosspad-pc not found at ${pcRoot}`,
    fix: pcOk ? "" : "Clone CrossPad/crosspad-pc or set CROSSPAD_PC_ROOT.",
  });

  // 6. per-revision build dirs and firmware age
  const found: string[] = [];
  for (const dir of ["build_v1", "build_v2", "build"]) {
    const full = path.join(idfRoot, dir);
    if (!p.exists(full)) continue;
    const bin = path.join(full, "CrossPad.bin");
    const m = p.exists(bin) ? p.mtimeMs(bin) : null;
    found.push(m === null ? `${dir} (no CrossPad.bin)` : `${dir} (CrossPad.bin ${ageText(Date.now() - m)} old)`);
  }
  checks.push({
    name: "build_dirs",
    ok: found.length > 0,
    detail: found.length > 0 ? found.join("; ") : "no build_v1 / build_v2 / build directory",
    fix: found.length > 0 ? "" : "crosspad_build platform=idf (per rev: idf.py -B build_v2 -DSDKCONFIG=sdkconfig.v2 build).",
  });

  // 6b. clangd — crosspad_symbol is the only thing that needs it, and a missing
  // language server there looks like a broken tool rather than an absent binary.
  const clangd = p.clangdPath();
  checks.push({
    name: "clangd",
    ok: clangd !== null,
    detail: clangd ?? "not on PATH (looked for clangd and clangd-14..20)",
    fix: clangd ? "" : "Install clangd (apt install clangd / brew install llvm) or set CROSSPAD_CLANGD. Only crosspad_symbol needs it.",
  });

  // 7. sim binary presence and staleness vs sources
  const sim = p.simBinary();
  if (!p.exists(sim)) {
    checks.push({ name: "sim_binary", ok: false, detail: `no simulator binary at ${sim}`, fix: "crosspad_build platform=pc" });
  } else {
    const binM = p.mtimeMs(sim) ?? 0;
    const srcM = p.newestSourceMtimeMs(pcRoot);
    const stale = srcM !== null && srcM > binM;
    checks.push({
      name: "sim_binary",
      ok: !stale,
      detail: stale
        ? `${sim} is older than the newest source (${ageText(srcM - binM)} behind)`
        : `${sim} (${ageText(Date.now() - binM)} old, newer than sources)`,
      fix: stale ? "crosspad_build platform=pc" : "",
    });
  }

  // 8. daemon-side checks (udev/dialout, locks, rtmidi, sounddevice, …)
  try {
    const dc = await daemonChecks();
    for (const c of dc) checks.push(DoctorCheckSchema.parse(c));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = (e as { hint?: string }).hint;
    checks.push({
      name: "daemon",
      ok: false,
      detail: `crosspad-hil daemon unavailable: ${msg}`,
      fix: hint ?? "Fix hil_python / hil_version above, then retry.",
    });
  }

  return checks;
}

// ── real probe ──────────────────────────────────────────────────────────────

const SOURCE_EXT = new Set([".c", ".cpp", ".h", ".hpp"]);
const WALK_LIMIT = 5000;

function newestMtimeUnder(root: string): number | null {
  let newest: number | null = null;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0 && seen < WALK_LIMIT) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (seen++ >= WALK_LIMIT) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "build" || e.name === ".git" || e.name === "node_modules") continue;
        stack.push(full);
      } else if (SOURCE_EXT.has(path.extname(e.name))) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (newest === null || m > newest) newest = m;
        } catch { /* skip */ }
      }
    }
  }
  return newest;
}

export function realProbe(): DoctorProbe {
  return {
    hilPython: resolveHilPython,
    pythonRunnable: async (py) => {
      const r = await runArgvStream(py, ["-c", "import sys; print(sys.version_info[0])"], process.cwd(), () => {}, 10_000);
      return r.success;
    },
    hilVersion: async (py) => {
      let out = "";
      const r = await runArgvStream(
        py,
        ["-c", "import json, crosspad_hil; print(json.dumps({'version': crosspad_hil.__version__}))"],
        process.cwd(),
        (s, line) => { if (s === "stdout") out += line + "\n"; },
        15_000,
      );
      if (!r.success) return null;
      const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      if (!line) return null;
      try { return String((JSON.parse(line) as { version: unknown }).version); } catch { return null; }
    },
    requiredHilVersion: () => String((requireJson("../../package.json") as { hilVersion?: string }).hilVersion ?? "1.0.0"),
    idfRoot: () => CROSSPAD_IDF_ROOT,
    idfExportExists: () => fs.existsSync(path.join(IDF_PATH, IS_WINDOWS ? "export.bat" : "export.sh")),
    pcRoot: () => CROSSPAD_PC_ROOT,
    exists: (p) => fs.existsSync(p),
    mtimeMs: (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } },
    newestSourceMtimeMs: (root) => newestMtimeUnder(path.join(root, "src")),
    simBinary: () => BIN_EXE,
    clangdPath: () => findClangd(),
  };
}

export function registerDoctorTool(server: McpServer, ctx: ToolContext, probe: DoctorProbe = realProbe()): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "Environment doctor. Host checks: hil_python interpreter, crosspad-hil version vs the one this server needs, platform-idf root, ESP-IDF env, crosspad-pc root, per-rev build dirs and firmware age, simulator binary staleness. Daemon checks merged in: udev/dialout, port locks (holder PID + purpose), rtmidi/ALSA/sounddevice visibility. Each check is {name, ok, detail, fix}; `ok` is false when any check fails. Run this first when a device tool errors.",
      inputSchema: {},
      outputSchema: O_Doctor,
      annotations: annotationsFor(tierOf(TOOL_NAME, {})),
    },
    async (_args, extra): Promise<ToolResult> => {
      if (decide(ctx.policy, TOOL_NAME, {}) === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      try {
        const checks = await runDoctorChecks(probe, async () => {
          const r = await ctx.daemon().request<{ checks: DoctorCheck[] }>("devices.doctor", {}, { signal: extra.signal, timeoutMs: 30_000 });
          return r.checks;
        });
        return jsonResponse({ success: true, ok: checks.every((c) => c.ok), checks });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
