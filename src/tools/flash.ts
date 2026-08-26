// src/tools/flash.ts — crosspad_flash: the one danger-tier tool.
//
// Shape: preflight (always returned, even on refusal) → confirmation → a job.
// The preflight exists because every way this call goes wrong is knowable
// before a single byte is written: the wrong port role, a firmware built for
// the other board revision, a binary older than the sources, a device sitting
// in USB-audio mode. Refusing with the reason beats a bricked-looking board.
import fs from "fs";
import path from "path";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HilError } from "../hil/daemon.js";
import { BootResultSchema, type BootResult, type Device } from "../hil/schemas.js";
import { listHilDevices, pickDevice, roleOfPort, type DaemonRequester } from "../hil/select.js";
import type { HandleRegistry } from "../handles.js";
import { pumpDaemonTask, type ProgressFn } from "../tasks.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError, type ToolResult } from "../tool-result.js";
import { CROSSPAD_IDF_ROOT, CROSSPAD_STM_ROOT, stmArtifact, type StmPreset } from "../config.js";
import { crosspadIdfFlash } from "./idf-flash.js";
import { crosspadStmFlash } from "./stm-flash.js";
import type { OnLine } from "../utils/exec.js";

export const TOOL_NAME = "crosspad_flash";

/** Directories under the IDF project whose mtimes decide whether a build is stale. */
export const SOURCE_SUBDIRS = ["main", "components"];
/** Skipped while walking sources: build outputs and VCS metadata are not sources. */
const SKIP_DIRS = new Set([".git", "managed_components", ".crosspad", "node_modules", "__pycache__"]);
/** Safety valve for the source walk — platform-idf is ~2 000 units, not 200 000 files. */
const MAX_SOURCE_FILES = 40_000;

export interface FlashBlocker { code: string; message: string }

export interface FlashPreflight {
  target: "esp" | "stm";
  transport: string;
  device: string | null;
  usb_mode: string | null;
  port: string | null;
  port_role: "cdc" | "console" | "bootloader" | null;
  bootloader_pid: boolean;
  build_dir: string | null;
  firmware_path: string;
  firmware_exists: boolean;
  firmware_mtime_ms: number | null;
  firmware_version: string | null;
  newest_source_path: string | null;
  newest_source_mtime_ms: number | null;
  stale: boolean;
  build_board_rev: string | null;
  device_board_rev: string | null;
  board_rev_match: boolean | null;
  blockers: FlashBlocker[];
  warnings: string[];
  notes: string[];
  ok: boolean;
}

export interface FlashProbe {
  exists(p: string): Promise<boolean>;
  mtimeMs(p: string): Promise<number | null>;
  /** esp_app_desc_t.version: 32 bytes at file offset 48, NUL-terminated (ota_flash.py). */
  binVersion(p: string): Promise<string | null>;
  newestSource(root: string, subdirs: string[]): Promise<{ path: string; mtimeMs: number } | null>;
  buildBoardRev(idfRoot: string, buildDir: string): Promise<string | null>;
}

export function realFlashProbe(): FlashProbe {
  return {
    async exists(p) {
      try { await fs.promises.access(p); return true; } catch { return false; }
    },
    async mtimeMs(p) {
      try { return (await fs.promises.stat(p)).mtimeMs; } catch { return null; }
    },
    async binVersion(p) {
      let fh: Awaited<ReturnType<typeof fs.promises.open>> | null = null;
      try {
        fh = await fs.promises.open(p, "r");
        const buf = Buffer.alloc(32);
        const { bytesRead } = await fh.read(buf, 0, 32, 48);
        if (bytesRead < 1) return null;
        const nul = buf.indexOf(0);
        const s = buf.subarray(0, nul === -1 ? bytesRead : nul).toString("latin1").trim();
        return s.length > 0 && /^[\x20-\x7e]+$/.test(s) ? s : null;
      } catch {
        return null;
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    },
    async newestSource(root, subdirs) {
      let best: { path: string; mtimeMs: number } | null = null;
      let seen = 0;
      const walk = async (dir: string): Promise<void> => {
        if (seen >= MAX_SOURCE_FILES) return;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (seen >= MAX_SOURCE_FILES) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name) || e.name.startsWith("build")) continue;
            await walk(full);
            continue;
          }
          if (!e.isFile()) continue;
          seen++;
          let m: number;
          try { m = (await fs.promises.stat(full)).mtimeMs; } catch { continue; }
          if (!best || m > best.mtimeMs) best = { path: full, mtimeMs: m };
        }
      };
      for (const sub of subdirs) await walk(path.join(root, sub));
      return best;
    },
    async buildBoardRev(idfRoot, buildDir) {
      try {
        const j = JSON.parse(await fs.promises.readFile(path.join(buildDir, "config", "sdkconfig.json"), "utf-8")) as Record<string, unknown>;
        const s = j.BSP_BOARD_REV_STR;
        if (typeof s === "string" && s.length > 0) return s;
      } catch { /* fall through to the sdkconfig text files */ }
      const base = path.basename(buildDir);
      const suffixes = base === "build_v1" ? [".v1", "", ".v2"] : base === "build_v2" ? [".v2", "", ".v1"] : ["", ".v2", ".v1"];
      for (const suffix of suffixes) {
        try {
          const text = await fs.promises.readFile(path.join(idfRoot, `sdkconfig${suffix}`), "utf-8");
          const m = text.match(/^CONFIG_BSP_BOARD_REV_STR="([^"]+)"/m);
          if (m) return m[1];
        } catch { /* try the next candidate */ }
      }
      return null;
    },
  };
}

/** "v2" / "V2" / "2.0" / "rev2" → "v2"; anything this project does not build → null. */
export function normalizeRev(s: string | null | undefined): "v1" | "v2" | null {
  if (typeof s !== "string") return null;
  const m = s.trim().toLowerCase().match(/(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  if (major === 1) return "v1";
  if (major === 2) return "v2";
  return null;
}

function emptyPreflight(target: "esp" | "stm", transport: string, firmwarePath: string): FlashPreflight {
  return {
    target, transport,
    device: null, usb_mode: null, port: null, port_role: null, bootloader_pid: false,
    build_dir: null,
    firmware_path: firmwarePath, firmware_exists: false, firmware_mtime_ms: null, firmware_version: null,
    newest_source_path: null, newest_source_mtime_ms: null, stale: false,
    build_board_rev: null, device_board_rev: null, board_rev_match: null,
    blockers: [], warnings: [], notes: [], ok: true,
  };
}

export async function espPreflight(
  probe: FlashProbe,
  device: Device | null,
  args: { transport: "uart" | "ota"; port?: string; firmware_path?: string; build_dir?: string },
  deviceError?: HilError,
): Promise<FlashPreflight> {
  const buildDir = args.build_dir ?? path.join(CROSSPAD_IDF_ROOT, "build");
  const firmware = args.firmware_path ?? path.join(buildDir, "CrossPad.bin");
  const pf = emptyPreflight("esp", args.transport, firmware);
  pf.build_dir = buildDir;

  // ── the build ─────────────────────────────────────────────────────────
  if (!(await probe.exists(buildDir))) {
    pf.blockers.push({
      code: "NO_BUILD_DIR",
      message: `No build directory at ${buildDir}. Run crosspad_build platform=idf first (or pass build_dir for a per-revision dir such as build_v1/build_v2).`,
    });
  }
  pf.firmware_exists = await probe.exists(firmware);
  if (!pf.firmware_exists) {
    pf.blockers.push({ code: "NO_FIRMWARE", message: `Firmware not found at ${firmware}. Run crosspad_build platform=idf first.` });
  } else {
    pf.firmware_mtime_ms = await probe.mtimeMs(firmware);
    pf.firmware_version = await probe.binVersion(firmware);
  }
  const newest = await probe.newestSource(CROSSPAD_IDF_ROOT, SOURCE_SUBDIRS);
  if (newest) {
    pf.newest_source_path = newest.path;
    pf.newest_source_mtime_ms = newest.mtimeMs;
    if (pf.firmware_mtime_ms !== null && newest.mtimeMs > pf.firmware_mtime_ms) {
      pf.stale = true;
      pf.warnings.push(`The firmware is older than ${newest.path} — you are about to flash a build from before that edit. Run crosspad_build platform=idf if that is not intended.`);
    }
  }

  // ── the device ────────────────────────────────────────────────────────
  if (!device) {
    pf.blockers.push({
      code: "NO_DEVICE",
      message: deviceError
        ? `${deviceError.message}${deviceError.hint ? ` (${deviceError.hint})` : ""}`
        : "No CrossPad resolved for this flash.",
    });
  } else {
    pf.device = device.id;
    pf.usb_mode = device.usb_mode;
    pf.device_board_rev = device.board_rev ?? null;
    pf.bootloader_pid = !!device.ports.bootloader;
    const requested = args.port;
    if (requested !== undefined) {
      const role = roleOfPort(device, requested);
      pf.port = requested;
      pf.port_role = role;
      if (role === "console") {
        const target = device.ports.bootloader?.path ?? device.ports.cdc?.path;
        pf.blockers.push({
          code: "PORT_ROLE",
          message: `${requested} is this device's STM32 bridge console port (role: console) — it carries the ESP log, not the flash. ` +
            (target
              ? `Pass port=${target} (role: ${device.ports.bootloader ? "bootloader" : "cdc"}) or omit port to let the daemon choose.`
              : "This device currently exposes no ESP-side port to flash; put it in download mode first."),
        });
      } else if (role === null) {
        const known = [device.ports.cdc?.path, device.ports.console?.path, device.ports.bootloader?.path].filter(Boolean).join(", ");
        pf.warnings.push(`${requested} is not one of ${device.id}'s ports (${known || "none"}); flashing it addresses something else.`);
      }
    } else {
      pf.port = device.ports.bootloader?.path ?? device.ports.cdc?.path ?? null;
      pf.port_role = device.ports.bootloader ? "bootloader" : device.ports.cdc ? "cdc" : null;
    }
    if (args.transport === "ota" && device.usb_mode === "audio") {
      pf.notes.push("The device is in USB-audio mode, which has no CDC; ota.flash switches it back to the default profile first.");
    }
    if (args.transport === "uart" && !device.ports.bootloader && device.usb_mode !== "bootloader") {
      pf.warnings.push("No bootloader-PID port is present — the device is not in download mode. idf.py will try the esptool DTR/RTS auto-reset (which the STM32 bridge emulates); if that fails, use transport='ota' or hold the boot button.");
    }
  }

  // ── the revision ──────────────────────────────────────────────────────
  const buildRevRaw = await probe.buildBoardRev(CROSSPAD_IDF_ROOT, buildDir);
  pf.build_board_rev = buildRevRaw;
  const buildRev = normalizeRev(buildRevRaw);
  const devRev = normalizeRev(pf.device_board_rev);
  if (buildRev !== null && devRev !== null) {
    pf.board_rev_match = buildRev === devRev;
    if (!pf.board_rev_match) {
      pf.blockers.push({
        code: "BOARD_REV_MISMATCH",
        message: `The build in ${buildDir} is for board revision ${buildRev}, the device reports ${devRev}. ` +
          "The revisions differ in pinout: flashing the wrong one leaves a board with no display and no console. " +
          `Build with the matching sdkconfig (idf.py -B build_${devRev} -DSDKCONFIG=sdkconfig.${devRev} build), or pass force=true if you know better.`,
      });
    }
  } else {
    pf.board_rev_match = null;
    pf.warnings.push(`Board revision could not be compared (build: ${buildRevRaw ?? "unknown"}, device: ${pf.device_board_rev ?? "unknown"}) — the revision guard is not protecting this flash.`);
  }

  pf.ok = pf.blockers.length === 0;
  return pf;
}

export async function stmPreflight(
  probe: FlashProbe,
  args: { method: "swd" | "dfu"; build_type?: string; firmware_path?: string },
): Promise<FlashPreflight> {
  const preset: StmPreset = args.build_type === "Release" ? "Release" : "Debug";
  const firmware = args.firmware_path ?? stmArtifact(preset, "bin");
  const pf = emptyPreflight("stm", args.method, firmware);
  pf.firmware_exists = await probe.exists(firmware);
  if (!pf.firmware_exists) {
    pf.blockers.push({ code: "NO_FIRMWARE", message: `STM firmware not found at ${firmware}. Run crosspad_build platform=stm first.` });
  } else {
    pf.firmware_mtime_ms = await probe.mtimeMs(firmware);
  }
  const newest = await probe.newestSource(CROSSPAD_STM_ROOT, ["Core", "Drivers"]);
  if (newest) {
    pf.newest_source_path = newest.path;
    pf.newest_source_mtime_ms = newest.mtimeMs;
    if (pf.firmware_mtime_ms !== null && newest.mtimeMs > pf.firmware_mtime_ms) {
      pf.stale = true;
      pf.warnings.push(`The STM binary is older than ${newest.path}.`);
    }
  }
  pf.notes.push(
    args.method === "swd"
      ? "SWD flashing addresses the ST-Link probe, not a serial port — the ESP-side checks (USB mode, port role, board revision) do not apply."
      : "DFU flashing addresses the STM32 system bootloader (hold pad 1 at boot) via STM32_Programmer_CLI — the ESP-side checks do not apply.",
  );
  pf.ok = pf.blockers.length === 0;
  return pf;
}

/** force=true turns every blocker except the port-role refusal into a warning. */
export function applyForce(pf: FlashPreflight, force: boolean): FlashPreflight {
  if (!force) return pf;
  const kept = pf.blockers.filter((b) => b.code === "PORT_ROLE");
  const dropped = pf.blockers.filter((b) => b.code !== "PORT_ROLE");
  return {
    ...pf,
    blockers: kept,
    warnings: [...pf.warnings, ...dropped.map((b) => `forced past ${b.code}: ${b.message}`)],
    ok: kept.length === 0,
  };
}

/** console.open → console.wait_boot → console.close, with the handle tracked while it lives. */
export async function waitBootOnConsole(
  daemon: DaemonRequester,
  device: string,
  handles: HandleRegistry,
  timeoutS: number,
  signal?: AbortSignal,
): Promise<BootResult> {
  const opened = await daemon.request<{ handle: string; port: string; log_path: string | null }>(
    "console.open", { device, reset: false }, signal ? { signal } : undefined,
  );
  handles.register(opened.handle, { kind: "console", device });
  try {
    return BootResultSchema.parse(
      await daemon.request("console.wait_boot", { handle: opened.handle, timeout_s: timeoutS },
        { ...(signal ? { signal } : {}), timeoutMs: timeoutS * 1000 + 15_000 }),
    );
  } finally {
    await daemon.request("console.close", { handle: opened.handle }).catch(() => {});
    handles.drop(opened.handle);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// The tool
// ═══════════════════════════════════════════════════════════════════════

let activeProbe: FlashProbe = realFlashProbe();
/** @internal vitest only — swap the filesystem probe for an in-memory one. */
export function setFlashProbeForTest(p: FlashProbe): void { activeProbe = p; }

export const FlashInput = z.object({
  target: z.enum(["esp", "stm"]).default("esp")
    .describe("'esp' = ESP32-S3 application firmware (transport uart|ota); 'stm' = STM32G0 bridge firmware via STM32_Programmer_CLI (method swd|dfu)."),
  transport: z.enum(["uart", "ota"]).optional()
    .describe("ESP only. 'ota' streams the binary over USB CDC with the device running (no bootloader mode); 'uart' runs idf.py flash and needs download mode."),
  method: z.enum(["swd", "dfu"]).optional()
    .describe("STM only. 'swd' = ST-Link; 'dfu' = the STM32 system bootloader (hold pad 1 at boot)."),
  device: z.string().min(1).optional()
    .describe("ESP only. Device id (dev_xxxx) or one of its port paths; omit when exactly one CrossPad is connected."),
  port: z.string().min(1).optional()
    .describe("ESP only. Serial port to flash. Omit to let the daemon choose. The STM32 bridge console port is refused — it carries logs, not the flash."),
  build_dir: z.string().min(1).optional()
    .describe("ESP only. Build directory holding the binary and its sdkconfig (default '<idf-root>/build'; per-revision dirs are build_v1 / build_v2)."),
  firmware_path: z.string().min(1).optional()
    .describe("Custom binary. ESP default '<build_dir>/CrossPad.bin'; STM default '<stm-root>/build/<preset>/CrossPad_STM32_r20.bin'."),
  build_type: z.enum(["Debug", "Release", "RelWithDebInfo"]).optional()
    .describe("STM only. Picks the build/<preset> dir for the default binary. Default Debug."),
  delta_base: z.string().min(1).optional()
    .describe("ESP OTA only. Previously flashed binary to diff against — sends a delta instead of the whole image."),
  wait_boot: z.boolean().optional()
    .describe("ESP only. After flashing, open the console and wait for the boot markers; the job result carries a BootResult {complete, missing, fatal, errors, bootloops, seconds}. Default false."),
  boot_timeout_s: z.number().min(5).max(180).optional()
    .describe("wait_boot: how long to wait for a complete boot (default 45, the firmware's own boot budget)."),
  wait_seconds: z.number().min(0).max(900).optional()
    .describe("0 (default) returns the task handle immediately — poll it with crosspad_task. >0 waits that long and inlines the task status; a timeout is not an error, the job keeps running."),
  force: z.boolean().optional()
    .describe("Proceed despite preflight blockers (stale build, board-revision mismatch, missing device). The port-role refusal is never overridden."),
  dry_run: z.boolean().optional()
    .describe("Run the preflight and stop: no confirmation token is minted and nothing is written."),
  confirm_token: z.string().optional()
    .describe("Token from a previous confirmation_required result. Re-issue the identical call with it to proceed."),
});
export type FlashArgs = z.infer<typeof FlashInput>;

export const O_Flash = {
  success: z.boolean(),
  preflight: z.record(z.string(), z.unknown()).optional(),
  task: z.string().optional(),
  status: z.record(z.string(), z.unknown()).optional(),
  target: z.enum(["esp", "stm"]).optional(),
  transport: z.string().optional(),
  device: z.string().optional(),
  firmware_path: z.string().optional(),
  dry_run: z.boolean().optional(),
  hint: z.string().optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

function summarizeFlash(args: FlashArgs, pf: FlashPreflight): string {
  if (args.target === "stm") {
    return `Flash STM32 firmware ${pf.firmware_path} over ${String(args.method).toUpperCase()} — the USB console, CDC and MIDI vanish until it completes.`;
  }
  const rev = pf.build_board_rev ? ` (board rev ${pf.build_board_rev})` : "";
  const ver = pf.firmware_version ? ` version "${pf.firmware_version}"` : "";
  const stale = pf.stale ? " ⚠ this binary is older than the newest source file" : "";
  const warn = pf.warnings.length ? `\nWarnings: ${pf.warnings.join(" | ")}` : "";
  return `Flash ${pf.firmware_path}${ver}${rev} to ${pf.device ?? "the only CrossPad"} over ${String(args.transport).toUpperCase()}` +
    `${pf.port ? ` (${pf.port}, role ${pf.port_role})` : ""}. This overwrites the running firmware.${stale}${warn}`;
}

/** Drain a FlashResult-style onLine stream into the job's progress channel. */
function progressLines(progress: ProgressFn, label: string): OnLine {
  let n = 0;
  return (_stream, line) => { progress(++n, undefined, `${label}: ${line.slice(0, 200)}`); };
}

export function registerFlashTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW | STM HW] Flash firmware. Danger tier: it always runs a preflight first, always returns that preflight " +
        "(refusal included), and needs a confirmation before writing anything.\n" +
        "Preflight reports: the device's USB mode, which role the target port plays (the STM32 bridge console is refused as a " +
        "flash target), the binary's own version string, whether it is older than the newest file under main/ or components/, " +
        "and whether the build's board revision matches the device's — a mismatch is a blocker, because the revisions differ " +
        "in pinout and the wrong image looks like dead hardware.\n" +
        "target='esp': transport='ota' streams over USB CDC with the device running (no bootloader mode); transport='uart' " +
        "runs idf.py flash and needs download mode. wait_boot=true then opens the console and returns a BootResult.\n" +
        "target='stm': method='swd' (ST-Link) or 'dfu' (system bootloader, hold pad 1 at boot).\n" +
        "The flash runs as a job: wait_seconds=0 (default) returns a task handle for crosspad_task; wait_seconds>0 inlines the " +
        "final status. dry_run=true stops after the preflight. force=true overrides every blocker except the port-role refusal.",
      inputSchema: FlashInput.shape,
      outputSchema: O_Flash,
      annotations: annotationsFor(tierOf(TOOL_NAME, {})),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const args = FlashInput.parse(rawArgs);
      const argsRec = args as unknown as Record<string, unknown>;
      const daemon = ctx.daemon();

      try {
        // ── argument shape ────────────────────────────────────────────
        if (args.target === "stm") {
          if (!args.method) throw new HilError("BAD_ARGS", "target='stm' requires 'method' ('swd' or 'dfu')", "for ESP firmware use target='esp' with transport='uart'|'ota'");
          if (args.transport) throw new HilError("BAD_ARGS", "'transport' is ESP-only; STM uses 'method'");
          if (args.port || args.device) throw new HilError("BAD_ARGS", "'port'/'device' are ESP-only — STM flashing addresses the ST-Link or DFU device");
        } else {
          if (!args.transport) throw new HilError("BAD_ARGS", "target='esp' requires 'transport' ('ota' or 'uart')", "'ota' works with the device running; 'uart' needs download mode");
          if (args.method) throw new HilError("BAD_ARGS", "'method' is STM-only; ESP uses 'transport'");
          if (args.build_type) throw new HilError("BAD_ARGS", "'build_type' is STM-only — the ESP build type comes from sdkconfig");
          if (args.transport === "uart" && args.delta_base) throw new HilError("BAD_ARGS", "'delta_base' is OTA-only");
        }

        // ── preflight (always computed, always returned) ──────────────
        let preflight: FlashPreflight;
        let device: Device | null = null;
        if (args.target === "stm") {
          preflight = await stmPreflight(activeProbe, {
            method: args.method!,
            build_type: args.build_type,
            firmware_path: args.firmware_path,
          });
        } else {
          let deviceError: HilError | undefined;
          try {
            device = pickDevice(await listHilDevices(daemon, extra.signal), args.device);
          } catch (e) {
            deviceError = e instanceof HilError ? e : new HilError("NO_DEVICE", e instanceof Error ? e.message : String(e));
          }
          preflight = await espPreflight(activeProbe, device, {
            transport: args.transport!,
            port: args.port,
            firmware_path: args.firmware_path,
            build_dir: args.build_dir,
          }, deviceError);
        }
        preflight = applyForce(preflight, args.force === true);

        if (args.dry_run === true) {
          return jsonResponse({ success: true, dry_run: true, target: args.target, transport: preflight.transport, preflight, ts: Date.now() });
        }
        if (!preflight.ok) {
          return jsonResponse({
            success: false,
            preflight,
            error: {
              code: "PREFLIGHT_BLOCKED",
              message: preflight.blockers.map((b) => `${b.code}: ${b.message}`).join(" "),
              hint: preflight.blockers.every((b) => b.code === "PORT_ROLE")
                ? "Pass the ESP-side port (or omit port) — this blocker is never overridden."
                : "Fix the cause, or re-issue with force=true if you are certain.",
            },
          });
        }

        // ── policy and confirmation ───────────────────────────────────
        if (decide(ctx.policy, TOOL_NAME, argsRec) === "hidden") {
          return jsonResponse({ success: false, preflight, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
        }
        // The token binds what is written, not how long the caller blocks for it:
        // a re-issue that adds wait_seconds is the same flash, and must not be
        // sent back for a second confirmation.
        const confirmArgs: Record<string, unknown> = { ...argsRec };
        delete confirmArgs.wait_seconds;
        const c = await requireConfirmation(server, extra, TOOL_NAME, confirmArgs, summarizeFlash(args, preflight));
        if (c.status === "token") {
          return jsonResponse({ ...(c.result.structuredContent as Record<string, unknown>), preflight });
        }
        if (c.status === "declined") {
          return jsonResponse({
            success: false,
            preflight,
            error: {
              code: "CANCELLED_BY_USER",
              message: `${TOOL_NAME} was declined by the user.`,
              hint: "Do not retry automatically; ask before issuing this call again.",
            },
          });
        }

        // ── the job ───────────────────────────────────────────────────
        const bootTimeout = args.boot_timeout_s ?? 45;
        const wantBoot = args.target === "esp" && args.wait_boot === true;
        const deviceId = device?.id;

        const taskId = ctx.jobs.create("flash", async (signal, progress) => {
          let flashResult: unknown;
          if (args.target === "stm") {
            progress(0, undefined, `STM ${args.method} flash starting`);
            flashResult = await crosspadStmFlash(args.method!, args.build_type ?? "Debug", args.firmware_path, progressLines(progress, "stm"), signal);
          } else if (args.transport === "ota") {
            const otaArgs: Record<string, unknown> = { firmware: preflight.firmware_path, wait_boot: false };
            if (deviceId !== undefined) otaArgs.device = deviceId;
            if (args.delta_base !== undefined) otaArgs.delta_base = args.delta_base;
            progress(0, undefined, "requesting ota.flash");
            const started = await daemon.request<{ task: string }>("ota.flash", otaArgs, { signal, timeoutMs: 30_000 });
            flashResult = await pumpDaemonTask(daemon, started.task, signal, progress);
          } else {
            progress(0, undefined, "idf.py flash starting");
            flashResult = await crosspadIdfFlash(args.port ?? preflight.port ?? undefined, progressLines(progress, "uart"), signal);
          }
          let boot: BootResult | null = null;
          if (wantBoot) {
            progress(0, undefined, "waiting for the boot markers");
            boot = await waitBootOnConsole(daemon, deviceId ?? args.device ?? "", ctx.handles, bootTimeout, signal);
          }
          return { flash: flashResult, boot };
        });
        ctx.handles.register(taskId, { kind: "task", device: deviceId });

        if ((args.wait_seconds ?? 0) > 0) {
          const status = await ctx.jobs.wait(taskId, (args.wait_seconds ?? 0) * 1000);
          return jsonResponse({
            success: status.status !== "failed",
            task: taskId,
            status,
            preflight,
            target: args.target,
            transport: preflight.transport,
            device: deviceId,
            firmware_path: preflight.firmware_path,
            ts: Date.now(),
          });
        }
        return jsonResponse({
          success: true,
          task: taskId,
          preflight,
          target: args.target,
          transport: preflight.transport,
          device: deviceId,
          firmware_path: preflight.firmware_path,
          hint: `Flashing in the background. Poll it with crosspad_task action='wait' task='${taskId}' (or action='status'); the result carries {flash, boot}.`,
          ts: Date.now(),
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
