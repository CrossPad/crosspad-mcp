#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// v10: response helpers, policy, toolsets and the tool registry. The 30 tools
// below are still registered inline (moving 1 200 lines would have made this
// release unreviewable); registerLegacy() captures them so registerAll() can
// file each into its toolset.
import { jsonResponse, ok, err } from "./response.js";
import type { RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { loadPolicy } from "./policy/policy.js";
import { ToolsetManager, initialToolsets, hasReadOnlyFlag } from "./toolsets.js";
import { registerAll, loadV10Modules } from "./registry.js";
import type { ToolContext } from "./tool-context.js";
import { getHilDaemon } from "./hil/daemon.js";
import { jobs } from "./tasks.js";
import { handles } from "./handles.js";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

import { crosspadBuild, crosspadRun, crosspadKill } from "./tools/build.js";
import { crosspadBuildCheck } from "./tools/build-check.js";
import { BIN_EXE as _BIN_EXE } from "./config.js";
import { crosspadLog } from "./tools/log.js";
import { crosspadIdfBuild } from "./tools/idf-build.js";
import { crosspadStmBuild } from "./tools/stm-build.js";
import { crosspadIdfMonitor } from "./tools/idf-monitor.js";
import { listDevices } from "./utils/device.js";
import { crosspadTest } from "./tools/test.js";
import { crosspadReposStatus } from "./tools/repos.js";
import { crosspadDiffCore } from "./tools/diff-core.js";
import { crosspadSubmoduleUpdate, crosspadCommit } from "./tools/repo-actions.js";
import { crosspadSearchSymbols } from "./tools/symbols.js";
import { crosspadInterfaces, crosspadApps } from "./tools/architecture.js";
import { crosspadScreenshot } from "./tools/screenshot.js";
import { crosspadInput } from "./tools/input.js";
import { crosspadStats } from "./tools/stats.js";
import { crosspadSettingsGet, crosspadSettingsSet, settingsCategories } from "./tools/settings.js";
import {
  crosspadAppList,
  crosspadAppInstall,
  crosspadAppRemove,
  crosspadAppUpdate,
  crosspadAppSync,
} from "./tools/app-manager.js";
import { runDoctor, realProbe } from "./tools/trace-doctor.js";
import { setConfigValue, resolveConfigValue, type UserConfig } from "./utils/userConfig.js";
import { listSymbols } from "./tools/trace-symbols.js";
import { getDeviceState } from "./tools/trace-device.js";
import { TraceSession, getActiveSession, setActiveSession, traceWrite, traceCall } from "./tools/trace-session.js";
import { getDashboard, openInBrowser, buildUiUrl } from "./tools/trace-webui.js";
import { writeCsv } from "./tools/trace-export.js";

import type { OnLine } from "./utils/exec.js";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

// Server instructions — MCP clients prepend these to the LLM system prompt.
// This is the *primary* mechanism by which a Claude session "knows" to pick
// crosspad_* tools when working inside any CrossPad repo. CLAUDE.md and memory
// alone proved insufficient; these instructions are loaded by the protocol
// itself before the user's first message and survive context compaction.
const SERVER_INSTRUCTIONS = `
You have access to the CrossPad MCP server, which exposes purpose-built tools for the CrossPad embedded music controller monorepo (repos: crosspad-pc, platform-idf, ESP32-S3, crosspad-core, crosspad-gui, plus app submodules).

NEW TO A CROSSPAD REPO OR SETTING UP? Use the \`crosspad\` skill first — it maps the ecosystem (repos, MCP tools, roles), walks install/config, and routes to per-role guides + an FAQ. Run \`bash scripts/doctor.sh\` from that skill to check your environment.

TOOL TAGS — a tool description starting with a bracket tag has a platform/hardware precondition. Atomic tokens: \`[PC]\` = the crosspad-pc repo + host toolchain (build/test/inspect — no running sim); \`[PC sim]\` = a RUNNING simulator instance (launch it with crosspad_run first); \`[ESP HW]\` = a connected ESP32-S3 device; \`[STM HW]\` = an ST-Link + STM32 board. Tokens combine: \`+\` = both contexts at once (e.g. \`[PC + ESP]\`); \`|\` = either, depending on a param (e.g. \`[PC | ESP HW]\`). Untagged tools (code search, repo/git, apps registry) need no hardware.

WHEN TO USE THESE TOOLS — in any conversation that touches a CrossPad repo, prefer the crosspad_* tools over raw shell equivalents:

- Inspecting code  → crosspad_search_symbols (NOT \`grep -r\`); crosspad_list_interfaces; crosspad_interface_implementations.
- Repo state       → crosspad_repo_status (NOT \`git status\` across N repos); crosspad_repo_diff for submodule drift.
- Building PC sim  → crosspad_check platform=pc → crosspad_build platform=pc (NOT raw cmake/ninja). Then crosspad_run; crosspad_kill when done.
- Building ESP fw  → crosspad_build platform=idf (NOT raw \`idf.py build\`); crosspad_flash target=esp transport=uart|ota.
- Building STM fw   → crosspad_build platform=stm (NOT raw cmake/STM32_Programmer_CLI for CrossPad_STM32_r20); crosspad_flash target=stm method=swd|dfu.
- Tests            → crosspad_test_run (NOT raw catch2 binary).
- Sim interaction  → crosspad_screenshot, crosspad_input, crosspad_midi, crosspad_stats, crosspad_settings_get/set.
- Apps (registry)  → crosspad_apps_list / install / remove / update / sync (NOT manual submodule git ops).
- Commits          → crosspad_commit (NOT raw \`git commit\`) — handles multi-repo paths and refuses on merge conflicts.
- SWD tracing    → crosspad_trace (STM32 firmware variable RT trace over ST-Link). Run action=doctor first; resolve issues; then action=symbols → start → read.

WHY: these tools resolve repos dynamically from env vars, parse build output into structured errors[], stream progress, and refuse unsafe operations. Manual shell equivalents will work but lose this scaffolding and frequently break across the 5 repos.

DISCOVERY: if unsure whether a repo is detected, check the \`crosspad://workspace\` resource — it lists detected repos, current branches, dirty counts, and sim status.

TOOLSETS: only the \`core\` toolset (devices, doctor, snapshot, build, flash, repo_status, toolsets, task) is visible at start. Other tools live in toolsets — device (cdc/console/ui/midi/usb_mode/audio_route), sim (run/kill/check/screenshot/input/stats/settings/test_run), code (search_symbols/list_interfaces/…), git (repo_diff/submodule_update/commit), apps (apps_*), trace (crosspad_trace), hil. If a tool you need is not listed, call crosspad_toolsets action=enable toolset=<name> and re-list tools; do NOT fall back to the shell. The server also accepts --toolsets a,b / CROSSPAD_TOOLSETS at startup and --read-only (hides every non-read tool).

SAFETY: flash, bootloader/DFU requests, trace write/call are "danger" tier. In the default strict policy the tool returns resultType="confirmation_required" with a confirm_token instead of acting; re-issue the identical call with confirm_token to proceed (120 s), or the client is asked directly when it supports elicitation. A declined confirmation returns error code CANCELLED_BY_USER — do not retry it on your own.
`.trim();

export const server = new McpServer(
  { name: "crosspad", version },
  { capabilities: { logging: {}, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS }
);

// v9 tools are still registered inline below. Capturing them here lets
// registerAll() file each one into its toolset (spec §3.1) without moving
// 1 200 lines; the SDK's tools/list order is this file's order — stable,
// which is what prompt caching needs.
export const legacyTools = new Map<string, RegisteredTool>();
function registerLegacy<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>,
): RegisteredTool {
  const tool = server.registerTool<OutputArgs, InputArgs>(name, config, cb);
  legacyTools.set(name, tool);
  return tool;
}

function makeStreamLogger(logger: string): OnLine {
  return (stream, line) => {
    if (!line.trim()) return;
    const level: LoggingLevel = stream === "stderr" ? "warning" : "info";
    server.server.sendLoggingMessage({ level, logger, data: line }).catch(() => {});
  };
}

/**
 * Compose a stream logger that ALSO emits notifications/progress when the
 * client supplied a progress token. Build/test/flash callers see a moving
 * counter (lines processed) and the latest log line as the message.
 *
 * Lines remain on the logging channel for diagnostics; progress is the
 * spec-compliant signal for "still working."
 */
function makeProgressLogger(logger: string, extra: any): OnLine {
  const stream = makeStreamLogger(logger);
  const token = extra?._meta?.progressToken as string | number | undefined;
  if (token === undefined || token === null) return stream;
  let counter = 0;
  return (s, line) => {
    stream(s, line);
    counter++;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: counter, message: line.slice(0, 200) },
      })
      .catch(() => {});
  };
}

/**
 * Link the simulator's captured stdout/stderr rather than inline the file.
 * A launch that failed already carries its last lines in `log_tail`; the link
 * is there for the rest, which can be thousands of LVGL and SDL lines.
 */
function withSimLog(result: CallToolResult, logPath: string | undefined): CallToolResult {
  if (!logPath) return result;
  (result.content as unknown[]).push({
    type: "resource_link",
    uri: `file://${logPath}`,
    name: logPath.split("/").pop() ?? "sim.log",
    mimeType: "text/plain",
    description: "Everything the simulator wrote to stdout and stderr",
  });
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// SHARED ZOD SCHEMAS
// ═══════════════════════════════════════════════════════════════════════

const Velocity = z.number().int().min(0).max(127).describe("MIDI velocity 0-127");
const Note = z.number().int().min(0).max(127).describe("MIDI note number 0-127 (60 = middle C)");
const Channel = z.number().int().min(0).max(15).default(0).describe("MIDI channel 0-15");
const PadIndex = z.number().int().min(0).max(15).describe("Pad index 0-15 (4x4 grid)");
const Cc = z.number().int().min(0).max(127).describe("MIDI CC number 0-127");
const Cc7 = z.number().int().min(0).max(127).describe("MIDI value 0-127");
const Program = z.number().int().min(0).max(127).describe("MIDI program number 0-127");
// Port allow-list — must match Linux/macOS device paths or Windows COM ports.
// Prevents shell-injection via crafted port strings flowing into command lines.
const Port = z.string()
  .regex(
    /^(?:\/dev\/(?:tty(?:ACM|USB)\d+|cu\.usb[A-Za-z0-9._-]+|cu\.usbmodem[A-Za-z0-9._-]+|cu\.usbserial[A-Za-z0-9._-]+)|COM\d+)$/,
    "Port must be /dev/ttyACM*, /dev/ttyUSB*, /dev/cu.usb*, or COM*"
  )
  .describe("Serial port path (e.g. /dev/ttyACM0, COM3). Auto-detected if omitted; required when multiple devices connected.");
const TimeoutSec = z.number().int().min(1).max(600).describe("Capture duration in seconds");
const MaxLines = z.number().int().min(1).max(10000).describe("Max output lines to return");

const RepoAlias = z.enum(["idf", "pc", "arduino", "core", "gui", "platform-idf", "crosspad-pc", "ESP32-S3", "crosspad-core", "crosspad-gui"])
  .describe("Repo to target. Aliases: idf=platform-idf, pc=crosspad-pc, arduino=ESP32-S3, core=crosspad-core, gui=crosspad-gui.");

const Submodule = z.enum(["crosspad-core", "crosspad-gui", "crosspad-instructions", "crosspad-sampler"])
  .describe("Which submodule to operate on");

const Platform = z.enum(["idf", "pc", "arduino"]).describe("Platform repo (idf=platform-idf, pc=crosspad-pc, arduino=ESP32-S3)");

// Git refs (branch / tag / commit SHA) — restricted to safe characters so they
// can flow into shell-invoked git commands without injection risk. Matches
// git's own ref-name rules (see git-check-ref-format) loosely.
const GitRef = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, "Invalid git ref — letters/digits/._/- only")
  .refine((s) => !s.startsWith("-"), "Ref cannot start with '-'")
  .refine((s) => !s.includes(".."), "Ref cannot contain '..'");

// App / submodule names also flow into shell args — keep them strict.
const AppName = z.string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/, "App name must be alphanumeric (with _ or -)");

// ═══════════════════════════════════════════════════════════════════════
// TOOL ANNOTATIONS — hints for MCP clients (used for confirmation gating).
// Per spec these are *hints*, not guarantees — clients trust at their own risk.
// ═══════════════════════════════════════════════════════════════════════

const ANN_READ_ONLY = { readOnlyHint: true } as const;
const ANN_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;
const ANN_DESTRUCTIVE_OPEN = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const ANN_READ_OPEN = { readOnlyHint: true, openWorldHint: true } as const;
const ANN_SIDE_EFFECT = { readOnlyHint: false, destructiveHint: false } as const;

// ═══════════════════════════════════════════════════════════════════════
// OUTPUT SCHEMAS — typed result shapes per tool, exposed as `outputSchema`
// so clients can validate `structuredContent`. Loose by design (most fields
// optional, no .strict()) — implementations are free to return additional
// keys; the schema documents the *expected* shape, not a tight contract.
// ═══════════════════════════════════════════════════════════════════════

const ErrorField = { error: z.string().optional() };

// Loose union — covers PC build (warnings_count + output_path), IDF build
// (warnings[] + tail[] + auto_reconfigured) and the early-exit error envelope
// ({success:false, error}). Only `success` is required; everything else is
// optional so the MCP outputSchema validator accepts every code path.
export const O_Build = {
  success: z.boolean(),
  duration_seconds: z.number().optional(),
  errors: z.array(z.string()).optional(),
  // PC-only
  warnings_count: z.number().int().optional(),
  output_path: z.string().optional(),
  // IDF-only
  warnings: z.array(z.string()).optional(),
  tail: z.array(z.string()).optional(),
  auto_reconfigured: z.boolean().optional(),
  ...ErrorField,
};

const O_Run = {
  success: z.boolean(),
  pid: z.number().int().nullable().optional(),
  exe_path: z.string(),
  already_running: z.boolean().optional(),
  responsive: z.boolean().optional(),
  log_path: z.string().optional(),
  log_tail: z.array(z.string()).optional(),
  ...ErrorField,
};

const O_Kill = {
  success: z.boolean(),
  killed_pids: z.array(z.number().int()),
  was_running: z.boolean(),
  ...ErrorField,
};

const O_BuildCheck = {
  success: z.boolean(),
  needs_rebuild: z.boolean(),
  reasons: z.array(z.string()),
  exe_exists: z.boolean(),
  exe_path: z.string(),
  ...ErrorField,
};

// Log result is target-dependent; keep it permissive.
const O_Log = {
  success: z.boolean(),
  // pc fields
  exe_path: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exit_code: z.number().int().nullable().optional(),
  duration_seconds: z.number().optional(),
  truncated: z.boolean().optional(),
  // idf fields
  port: z.string().optional(),
  lines: z.array(z.string()).optional(),
  line_count: z.number().int().optional(),
  ...ErrorField,
};

const O_Devices = {
  success: z.boolean(),
  devices: z.array(z.object({
    port: z.string(),
    description: z.string().optional(),
    vid: z.number().int().optional(),
    pid: z.number().int().optional(),
    is_crosspad: z.boolean(),
    kind: z.enum(["esp-native", "stm-bridge"]).nullable().optional(),
  }).passthrough()),
  crosspad_count: z.number().int().optional(),
  ...ErrorField,
};

const O_Trace = {
  success: z.boolean(),
  action: z.string().optional(),
  ok: z.boolean().optional(),
  issues: z.array(z.record(z.string(), z.unknown())).optional(),
  symbols: z.array(z.record(z.string(), z.unknown())).optional(),
  device_state: z.string().optional(),
  actual_fs: z.number().optional(),
  sample_count: z.number().int().optional(),
  signals: z.array(z.string()).optional(),
  series: z.record(z.string(), z.unknown()).optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
  file_path: z.string().optional(),
  ui_url: z.string().optional(),
  key: z.string().optional(),
  // §11.6: last few daemon stderr lines, surfaced when device_state is an
  // error / probe_lost / exited so the caller sees *why* without a re-run.
  stderr_tail: z.string().optional(),
  ...ErrorField,
};

const O_Test = {
  success: z.boolean(),
  tests_found: z.boolean(),
  build_output: z.string(),
  test_output: z.string(),
  passed: z.number().int(),
  failed: z.number().int(),
  errors: z.array(z.string()),
  duration_seconds: z.number(),
  runner: z.enum(["catch2", "ctest"]).optional(),
  labels: z.array(z.string()).optional(),
  ...ErrorField,
};

const O_Screenshot = {
  success: z.boolean(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  format: z.string().optional(),
  file_path: z.string().optional(),
  size: z.number().int().optional(),
  region: z.enum(["full", "lcd"]).optional(),
  ...ErrorField,
};

const O_Input = {
  success: z.boolean(),
  ...ErrorField,
};

const O_Stats = {
  success: z.boolean(),
  stats: z.record(z.string(), z.unknown()).optional(),
  ...ErrorField,
};

const O_SettingsGet = {
  success: z.boolean(),
  category: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  ...ErrorField,
};

const O_SettingsSet = {
  success: z.boolean(),
  key: z.string().optional(),
  value: z.union([z.number(), z.boolean()]).optional(),
  ...ErrorField,
};

// Repo-status & repo-diff are loose aggregate structures — only the top
// `success` is guaranteed; everything else passes through.
const O_RepoStatus = {
  success: z.boolean(),
  repos: z.array(z.record(z.string(), z.unknown())).optional(),
  ...ErrorField,
};

const O_RepoDiff = {
  success: z.boolean(),
  parent: z.string().optional(),
  submodules: z.array(z.record(z.string(), z.unknown())).optional(),
  ...ErrorField,
};

const O_SubmoduleUpdate = {
  success: z.boolean(),
  submodule: z.string(),
  repo: z.string(),
  old_sha: z.string().nullable(),
  new_sha: z.string().nullable(),
  commits_pulled: z.number().int(),
  changed_files: z.array(z.string()),
  staged: z.boolean(),
  ...ErrorField,
};

const O_Commit = {
  success: z.boolean(),
  repo: z.string(),
  commit_hash: z.string().nullable(),
  message: z.string(),
  files_committed: z.array(z.string()),
  ...ErrorField,
};

const O_SearchSymbols = {
  success: z.boolean(),
  matches: z.array(z.record(z.string(), z.unknown())).optional(),
  total: z.number().int().optional(),
  truncated: z.boolean().optional(),
  ...ErrorField,
};

const O_Architecture = {
  success: z.boolean(),
  // any of: interfaces[], implementations[], capabilities, etc.
  interfaces: z.array(z.unknown()).optional(),
  implementations: z.array(z.unknown()).optional(),
  capabilities: z.array(z.unknown()).optional(),
  platforms: z.record(z.string(), z.unknown()).optional(),
  ...ErrorField,
};

const O_AppsSource = {
  success: z.boolean(),
  apps: z.array(z.record(z.string(), z.unknown())),
  ...ErrorField,
};

const O_AppsList = {
  success: z.boolean(),
  apps: z.array(z.record(z.string(), z.unknown())),
  installed_count: z.number().int(),
  total_count: z.number().int(),
  ...ErrorField,
};

const O_AppAction = {
  success: z.boolean(),
  action: z.string(),
  platform: z.string(),
  app_name: z.string().optional(),
  output: z.string(),
  ...ErrorField,
};

// ═══════════════════════════════════════════════════════════════════════
// BUILD — unified across platforms (pc, idf)
// `platform` arg disambiguates. Modes are validated per-platform at runtime.
// ═══════════════════════════════════════════════════════════════════════

const BuildPlatform = z.enum(["pc", "idf", "stm"]).describe("Target platform: 'pc' = host simulator, 'idf' = ESP32-S3 firmware, 'stm' = STM32G0 firmware (CrossPad r20).");
const PlatformPcOnly = z.enum(["pc"]).default("pc").describe("Platform — currently only 'pc' is supported here.");

registerLegacy(
  "crosspad_build",
  {
    description:
      "[PC | ESP | STM HW] Build CrossPad for the given platform.\n" +
      "  • platform='pc'  → CMake + Ninja host simulator. PREFER THIS over `cmake --build build` (picks right MSVC env on Windows, parses errors/warnings, streams progress).\n" +
      "  • platform='idf' → idf.py build for ESP32-S3 firmware. PREFER THIS over raw `idf.py build` (sources IDF env, auto-fullcleans when new apps detected, parses errors/warnings).\n" +
      "  • platform='stm' → CMake + Ninja + arm-none-eabi for STM32G0 firmware (CrossPad r20). Uses CMakePresets (Debug/Release); output is build/<preset>/CrossPad_STM32_r20.elf.\n" +
      "Mode×platform compatibility:\n" +
      "  • incremental → all (default)\n" +
      "  • clean       → all (wipes build dir, then builds)\n" +
      "  • reconfigure → PC & STM (re-runs cmake without wiping cache)\n" +
      "  • fullclean   → IDF only (runs idf.py fullclean, then builds)",
    inputSchema: {
      platform: BuildPlatform,
      mode: z.enum(["incremental", "clean", "fullclean", "reconfigure"])
        .default("incremental")
        .describe(
          "Build mode. Compatibility: incremental & clean = all platforms; reconfigure = PC & STM; fullclean = IDF only. " +
          "Pick incremental for normal iteration; clean if you suspect stale artifacts; fullclean (IDF) after adding new apps; reconfigure (PC/STM) after editing CMakeLists/presets.",
        ),
      build_type: z.enum(["Debug", "Release", "RelWithDebInfo"])
        .default("Debug")
        .describe("CMake build type — PC & STM (ignored for IDF; ESP32 build type comes from sdkconfig). STM maps to the Debug/Release preset (RelWithDebInfo→Release). Only honored on mode=clean|reconfigure (incremental keeps existing cache)."),
    },
    outputSchema: O_Build,
    annotations: ANN_DESTRUCTIVE,
  },
  async ({ platform, mode, build_type }, extra: any) => {
    if (platform === "pc") {
      if (mode === "fullclean") return err("mode='fullclean' is IDF-only. PC supports: incremental, clean, reconfigure.");
      const onLine = makeProgressLogger("build-pc", extra);
      return jsonResponse(await crosspadBuild(mode as "incremental" | "clean" | "reconfigure", onLine, build_type, extra.signal));
    }
    if (platform === "stm") {
      if (mode === "fullclean") return err("mode='fullclean' is IDF-only. STM supports: incremental, clean, reconfigure.");
      const onLine = makeProgressLogger("build-stm", extra);
      return jsonResponse(await crosspadStmBuild(mode as "incremental" | "clean" | "reconfigure", onLine, build_type, extra.signal));
    }
    // idf
    if (mode === "reconfigure") return err("mode='reconfigure' is PC/STM-only. IDF supports: incremental, clean, fullclean.");
    const idfMode = mode === "incremental" ? "build" : mode;
    const onLine = makeProgressLogger("build-idf", extra);
    return jsonResponse(await crosspadIdfBuild(idfMode as "build" | "fullclean" | "clean", onLine, extra.signal));
  }
);

registerLegacy(
  "crosspad_run",
  {
    description: "[PC] Launch the built simulator binary in the background. Returns pid + exe_path. Refuses to spawn a duplicate if one is already responding on the TCP control port (use force=true to override). Fails if binary not built — call crosspad_build first. Currently PC-only (IDF firmware doesn't run on the host).",
    inputSchema: {
      platform: PlatformPcOnly,
      force: z.boolean().default(false)
        .describe("Spawn another instance even if one is already running. Default: false."),
    },
    outputSchema: O_Run,
    annotations: ANN_SIDE_EFFECT,
  },
  async ({ force }) => {
    const result = await crosspadRun(force);
    if (result.already_running) {
      return err(result.error ?? "Simulator already running.", { exe_path: result.exe_path, already_running: true });
    }
    if (result.pid === null) {
      return err(`Binary not found: ${result.exe_path}. Run crosspad_build first.`, { exe_path: result.exe_path });
    }
    if (result.responsive === false) {
      const why = result.error ?? `TCP control port did not respond within 3s. Process may have crashed during startup.`;
      return withSimLog(
        err(`Simulator process started (pid=${result.pid}) but ${why}`, {
          pid: result.pid,
          exe_path: result.exe_path,
          responsive: false,
          log_path: result.log_path,
          // The failed probe says nothing about the cause; the sim's own last
          // words usually do, so they ride along instead of only being linked.
          log_tail: result.log_tail,
        }),
        result.log_path,
      );
    }
    return withSimLog(
      ok({ pid: result.pid, exe_path: result.exe_path, responsive: result.responsive, log_path: result.log_path }),
      result.log_path,
    );
  }
);

registerLegacy(
  "crosspad_kill",
  {
    description: "[PC sim] Stop the running PC simulator. Identifies the process by /proc/<pid>/exe match against the built binary (Linux) or pgrep -x basename (macOS/Windows), sends SIGTERM, waits up to 3s, then SIGKILL stragglers. Returns killed PIDs and whether anything still answers on the TCP control port. Currently PC-only.",
    inputSchema: {
      platform: PlatformPcOnly,
    },
    outputSchema: O_Kill,
    annotations: ANN_DESTRUCTIVE,
  },
  async () => jsonResponse(await crosspadKill())
);

registerLegacy(
  "crosspad_check",
  {
    description: "[PC] Health check for a build — detects stale exe, new sources missing from build system, dirty submodules. Use before crosspad_build to decide if rebuild needed. Currently PC-only.",
    inputSchema: {
      platform: PlatformPcOnly,
    },
    outputSchema: O_BuildCheck,
    annotations: ANN_READ_ONLY,
  },
  async (_args: unknown, extra: any) => jsonResponse({ success: true, exe_path: _BIN_EXE, ...(await crosspadBuildCheck({ signal: extra?.signal })) })
);

registerLegacy(
  "crosspad_log",
  {
    description:
      "[PC | ESP HW] Capture logs (consolidated; replaces crosspad_log_pc and crosspad_log_idf in v6).\n" +
      "  • target='pc'  → spawn the built sim binary, capture stdout/stderr, then kill it. " +
      "Fields used: timeout_seconds (default 5), max_lines (default 200). `port` and `filter` MUST be omitted.\n" +
      "  • target='idf' → read serial from a connected ESP32-S3 via pyserial (no TTY needed). " +
      "Fields used: port (auto-detected if omitted), timeout_seconds (default 10), max_lines (default 500), filter (substring, case-insensitive).",
    inputSchema: {
      target: z.enum(["pc", "idf"]).describe("'pc' = run+capture sim binary (uses timeout_seconds?,max_lines? — port/filter MUST be omitted); 'idf' = read serial from connected ESP device (uses port?,timeout_seconds?,max_lines?,filter?,reset_to_boot?)."),
      port: Port.optional().describe("idf only. Serial port path. Auto-detected if omitted; required when multiple devices connected. MUST be omitted for target=pc."),
      timeout_seconds: TimeoutSec.optional().describe("Capture duration in seconds. Defaults: 5 (pc), 10 (idf)."),
      max_lines: MaxLines.optional().describe("Max output lines. Defaults: 200 (pc), 500 (idf)."),
      filter: z.string().optional()
        .describe("idf only. Case-insensitive substring filter — only matching lines returned. MUST be omitted for target=pc."),
      reset_to_boot: z.boolean().optional()
        .describe("idf only. Pulse the device reset (esptool DTR/RTS sequence, works through the STM bridge) before capturing, so the log starts at boot t=0. Use for boot-time profiling. Default false (passive read of the running device)."),
    },
    outputSchema: O_Log,
    annotations: ANN_READ_ONLY,
  },
  async ({ target, port, timeout_seconds, max_lines, filter, reset_to_boot }, extra: any) => {
    if (target === "pc") {
      if (port) return err("Field 'port' is not used when target='pc'.");
      if (filter) return err("Field 'filter' is not used when target='pc'.");
      const onLine = makeProgressLogger("log-pc", extra);
      return jsonResponse({
        ...(await crosspadLog(timeout_seconds ?? 5, max_lines ?? 200, onLine, extra.signal)),
      });
    }
    // target === "idf"
    const onLine = makeProgressLogger("log-idf", extra);
    return jsonResponse({
      ...(await crosspadIdfMonitor(port, timeout_seconds ?? 10, max_lines ?? 500, filter, onLine, extra.signal, reset_to_boot ?? false)),
    });
  }
);

registerLegacy(
  "crosspad_devices",
  {
    description: "[ESP HW] List all connected USB serial devices. Identifies CrossPad devices separately and tags each with `kind`: 'esp-native' (rev <2.0, ESP32-S3 native USB, VID 0x303a/PID 0x3456) or 'stm-bridge' (rev 2.0, STM32 composite CDC+MIDI bridge, VID 0x0483/PID 0x5740 — STM programs the ESP over LPUART2).",
    inputSchema: {},
    outputSchema: O_Devices,
    annotations: ANN_READ_ONLY,
  },
  async () => jsonResponse(listDevices())
);

// ═══════════════════════════════════════════════════════════════════════
// SWD TRACER
// ═══════════════════════════════════════════════════════════════════════

// §12.4 injectable browser opener — defaults to the real platform opener but is
// overridable (setTraceBrowserOpener) so a unit test can assert auto-open is
// called/skipped without launching a real browser. Returns true if it spawned.
let traceBrowserOpener: (url: string) => boolean = openInBrowser;
export function setTraceBrowserOpener(fn: (url: string) => boolean): void { traceBrowserOpener = fn; }

const TraceAction = z.enum([
  "doctor", "config_set", "symbols", "start", "stop",
  "add", "remove", "status", "read", "save", "device_state", "ui",
  "write", "call",
]);

registerLegacy(
  "crosspad_trace",
  {
    description:
      "[STM HW] Real-time SWD tracer for the STM32G0B1 firmware (ST-Link). Non-halting RAM polling of firmware variables resolved from the Debug ELF (like ST-Studio/CubeMonitor). Pick an `action`:\n" +
      "  • doctor       → environment precheck → issues[] (run this FIRST; resolve issues, then config_set).\n" +
      "  • config_set   → persist a resolved path/serial to ~/.config/crosspad-mcp/config.json (key,value).\n" +
      "  • symbols      → list/search traceable variables from the ELF (query optional).\n" +
      "  • start        → begin a background trace (signals[], rate_hz).\n" +
      "  • stop         → end the active trace.\n" +
      "  • add/remove   → mutate the live poll set of the active trace (signals[]); returns the current signal set.\n" +
      "  • status       → device_state (running/stop_suspected/exited), sample_count, actual_fs, signals.\n" +
      "  • read         → recent samples downsampled + per-signal stats (cheap; safe for the LLM).\n" +
      "  • save         → export the in-memory buffer to CSV (returns file_path).\n" +
      "  • device_state → deep low-power/STOP register dump.\n" +
      "  • ui           → returns the localhost dashboard URL.\n" +
      "Signal names accept array indexing, e.g. 's_inputs[0]', 's_adc_raw[3]'.",
    inputSchema: {
      action: TraceAction.describe(
        "Required params per action — doctor/stop/status/device_state/ui: (none); " +
        "config_set: key,value; symbols: query?; start: signals[],rate_hz?; " +
        "add/remove: signals[]; read: window_from?,window_to?,max_points?; save: format?; " +
        "write: writes[]; call: func,args?,confirm,ret_type?,timeout?."
      ),
      signals: z.array(z.string()).optional().describe("start: variable names from `symbols` (e.g. ['s_vbat_mv','s_inputs[0]']). Also accepts raw @address specs that bypass DWARF — '@0x40021000' (u32), '@0x40021000:u16' (u8|u16|u32|i8|i16|i32|f32), '@0x20000000:u8[16]' (16-element block) — for peripheral registers / arbitrary RAM."),
      rate_hz: z.number().int().min(0).max(2000).optional().describe("start: target sample rate (0 = as fast as the probe allows). Actual Fs is reported."),
      swo: z.array(z.string()).optional().describe("start (EXPERIMENTAL): map ITM stimulus ports to signal names, e.g. ['0:phase','1:isr_us']. Requires firmware that emits ITM on the SWO pin (NOT present in current CrossPad firmware — UNTESTED against real ITM). Omit for plain RAM polling. Fails soft: if SWV init fails, polling continues normally."),
      query: z.string().optional().describe("symbols: case-insensitive substring filter."),
      key: z.string().optional().describe("config_set: one of stm_elf_path|pyocd_python|probe_serial|trace_dir|ui_open|stm_programmer_cli. stm_programmer_cli = path to STM32_Programmer_CLI for crosspad_flash target=stm. ui_open ∈ vscode(default: reply with the link → user clicks → opens in the VS Code Simple Browser; system-browser fallback after 30s if unopened)|browser(open system browser immediately)|none(never auto-open)."),
      value: z.string().optional().describe("config_set: the value to persist."),
      window_from: z.number().optional().describe("read: start time (s) of the window."),
      window_to: z.number().optional().describe("read: end time (s) of the window."),
      max_points: z.number().int().min(1).max(5000).optional().describe("read: max points per signal (default 200)."),
      format: z.enum(["csv"]).optional().describe("save: export format (csv)."),
      writes: z.array(z.string()).optional().describe("write: list of 'target=value' specs. target = @0xADDR[:type] (u8|u16|u32|i8|i16|i32|f32, default u32) or a DWARF symbol; value = hex 0x.. or decimal (float for f32). e.g. ['@0x50000414:u16=0xFFFF','s_vbat_mv=4200']. Allowlist: SRAM/peripheral/PPB only — Code/flash region is blocked."),
      func: z.string().optional().describe("call: firmware function symbol to invoke (AAPCS)."),
      args: z.array(z.number().int()).max(4).optional().describe("call: up to 4 integer args → r0-r3."),
      confirm: z.boolean().optional().describe("call: must be true — acknowledges the core is halted for the call."),
      ret_type: z.enum(["u32","i32","u16","i16","u8","i8","f32"]).optional().describe("call: decode r0 as this type (default u32; raw r0 always returned)."),
      timeout: z.number().min(0.1).max(30).optional().describe("call: max seconds to wait for the function to return (default 2)."),
    },
    outputSchema: O_Trace,
    annotations: ANN_SIDE_EFFECT,
  },
  async ({ action, signals, rate_hz, swo, query, key, value, window_from, window_to, max_points, format, writes, func, args, confirm, ret_type, timeout }, extra: any) => {
    switch (action) {
      case "doctor": {
        const r = await runDoctor(realProbe());
        return ok({ action, ok: r.ok, issues: r.issues, device_state: r.probe ? "connected" : "no_probe" });
      }
      case "config_set": {
        const allowed = ["stm_elf_path", "pyocd_python", "probe_serial", "trace_dir", "ui_open", "stm_programmer_cli"];
        if (!key || !allowed.includes(key)) return err(`config_set requires key in ${allowed.join("|")}`);
        if (value === undefined) return err("config_set requires `value`.");
        setConfigValue(key as keyof UserConfig, value);
        return ok({ action, key, file_path: "~/.config/crosspad-mcp/config.json" });
      }
      case "symbols": {
        const r = await listSymbols(query, undefined, extra.signal);
        if (!r.success) return err(r.error ?? "symbol resolution failed", { action });
        return ok({ action, symbols: r.symbols });
      }
      case "start": {
        if (!signals || signals.length === 0) return err("start requires non-empty signals[].");
        if (getActiveSession()?.isRunning()) return err("A trace is already running — stop it first.");
        const doc = await runDoctor(realProbe());
        if (!doc.ok) {
          // §11.7: a vanished probe gets a distinct, actionable refusal.
          if (doc.issues.some((i) => i.id === "no_probe_detected")) {
            return err("No ST-Link detected on USB — replug the probe and retry (verify with `pyocd list` / `lsusb`).", { action, issues: doc.issues, device_state: "no_probe" });
          }
          return err("Doctor reported blocking issues — resolve them first.", { action, issues: doc.issues });
        }
        const sess = new TraceSession({ signals, rateHz: rate_hz ?? 0, swo });
        sess.start();
        setActiveSession(sess);
        // §12.1/§12.4: ensure the PERSISTENT dashboard server is up (idempotent —
        // reuses it across traces), auto-open the browser ONLY if no client is
        // already connected (covers an external browser AND a VS Code Simple
        // Browser tab opened on a previous trace), then bind this session so its
        // frames broadcast to the UI (also emits trace_start).
        const dashboard = getDashboard();
        let uiUrl: string | undefined;
        try {
          uiUrl = await dashboard.ensureStarted();
          dashboard.bind(sess);
          // §12.6 open behavior, by ui_open config (default "vscode"):
          //   vscode  → DON'T pop anything now. The agent always replies with the
          //             dashboard link; the user clicks it → it opens in the VS Code
          //             Simple Browser via their workbench.externalUriOpeners. If
          //             nobody opens it within the fallback window, fall back to the
          //             system browser so a first-timer is never left staring at nothing.
          //   browser → open the system browser immediately.
          //   none    → never auto-open (rely on an already-open persistent tab).
          if (uiUrl && !dashboard.hasClients()) {
            const mode = resolveConfigValue("ui_open", "CROSSPAD_TRACE_UI_OPEN", process.env.CROSSPAD_TRACE_UI_OPEN, "vscode");
            if (mode === "browser") {
              traceBrowserOpener(uiUrl);
            } else if (mode === "vscode") {
              const ms = Number(process.env.CROSSPAD_TRACE_OPEN_FALLBACK_MS) || 30000;
              const url = uiUrl;
              setTimeout(() => {
                // Only fall back if THIS trace is still the active one and nobody
                // ever opened the in-editor link.
                if (getActiveSession() === sess && sess.isRunning() && !getDashboard().hasClients()) {
                  traceBrowserOpener(url);
                }
              }, ms);
            }
          }
        } catch { /* UI optional — never block a trace on the dashboard */ }
        // §11.6: don't lie. Wait for the first real frame and report what the
        // daemon actually did (connect can fail fast → error/exit) instead of an
        // optimistic "running" that masks a dead connect.
        const first = await sess.waitForFirstFrame(3000);
        if (first?.type === "error") {
          // Connect failed — the daemon already exited. Clear the active session
          // and surface the daemon's error + stderr tail. Unbind the dashboard
          // (server stays up) so the next trace starts from a clean idle state.
          sess.stop();
          dashboard.unbind();
          setActiveSession(null);
          return err(`Trace connect failed: ${first.error}`, { action, device_state: "error: " + first.error, stderr_tail: sess.stderrTail(5) || undefined });
        }
        if (first && (first.type === "signals" || first.type === "sample")) {
          return ok({ action, device_state: "running", signals, file_path: sess.filePath ?? undefined, ui_url: uiUrl });
        }
        // No frame within the window. If the proc already died, it's a failure;
        // otherwise it's still connecting (honest) — caller can poll status.
        if (!sess.isRunning()) {
          dashboard.unbind();
          setActiveSession(null);
          return err(`Trace daemon exited before producing data (${sess.deviceState}).`, { action, device_state: sess.deviceState, stderr_tail: sess.stderrTail(5) || undefined });
        }
        return ok({ action, device_state: "connecting", signals, file_path: sess.filePath ?? undefined, ui_url: uiUrl });
      }
      case "stop": {
        const s = getActiveSession();
        if (!s) return err("No active trace.");
        const count = s.buffer.count();
        // §11.5/§12.1: initiate teardown, but defer unbinding the dashboard and
        // clearing the active session until the daemon has REALLY exited (the
        // stop→SIGTERM→SIGKILL escalation can take ~4.5s). Clearing early would
        // let a racing `start` spawn a second daemon onto the still-busy probe
        // and make `status` report idle mid-teardown. onStopped fires
        // synchronously if the process is already gone.
        const d = getDashboard();
        s.onStopped(() => {
          d.unbind();
          if (getActiveSession() === s) setActiveSession(null);
        });
        s.stop();
        return ok({ action, sample_count: count, file_path: s.filePath ?? undefined });
      }
      case "status": {
        const s = getActiveSession();
        if (!s) return ok({ action, device_state: "idle", sample_count: 0 });
        const n = s.buffer.count();
        const elapsed = (performance.now() - s.startedAt) / 1000;
        // §11.6: when the daemon is unhealthy, fold in the last stderr lines so
        // the caller sees *why* without re-running.
        const ds = s.deviceState;
        const unhealthy = ds.startsWith("error") || ds === "probe_lost" || ds === "exited" || ds.startsWith("spawn_failed");
        const tail = unhealthy ? (s.stderrTail(5) || undefined) : undefined;
        return ok({ action, device_state: ds, sample_count: n, actual_fs: elapsed > 0 ? n / elapsed : 0, signals: s.buffer.signalNames(), stderr_tail: tail });
      }
      case "read": {
        const s = getActiveSession();
        if (!s) return err("No active trace.");
        const mp = max_points ?? 200;
        const win = (window_from !== undefined || window_to !== undefined) ? { fromT: window_from, toT: window_to } : undefined;
        const series: Record<string, unknown> = {};
        const stats: Record<string, unknown> = {};
        for (const sig of s.buffer.signalNames()) {
          series[sig] = s.buffer.downsample(sig, mp, win);
          stats[sig] = s.buffer.stats(sig);
        }
        return ok({ action, series, stats, device_state: s.deviceState, sample_count: s.buffer.count() });
      }
      case "save": {
        const s = getActiveSession();
        if (!s) return err("No active trace.");
        // `format` is constrained to "csv" by the input schema — no runtime branch needed.
        const csvPath = (s.filePath ?? "/tmp/trace").replace(/\.cptrace$/, "") + ".csv";
        writeCsv(csvPath, s.buffer, s.buffer.signalNames());
        return ok({ action, file_path: csvPath });
      }
      case "device_state": {
        const r = await getDeviceState(extra.signal);
        if (!r.success) return err(r.error ?? "device_state read failed", { action });
        // Pack regs/decoded into `stats` (a schema field) so they survive
        // outputSchema validation — O_Trace has no top-level regs/decoded keys.
        return ok({
          action,
          device_state: r.accessible ? "accessible" : "inaccessible",
          stats: { regs: r.regs, decoded: r.decoded, accessible: r.accessible },
        });
      }
      case "ui": {
        // §12.1: the dashboard is persistent and independent of any trace — just
        // ensure the server is up and hand back the url. Works even when idle
        // (no active trace): the UI shows a "waiting for trace…" state and
        // /symbols falls back to the default ELF for autocomplete.
        const url = await getDashboard().ensureStarted();
        return ok({ action, ui_url: url });
      }
      case "add":
      case "remove": {
        const s = getActiveSession();
        if (!s || !s.isRunning()) return err("No active trace — start one first.", { action });
        if (!signals || signals.length === 0) return err(`${action} requires non-empty signals[].`, { action });
        // §4/§6: await the post-reconcile set (so the response reflects array
        // expansion and dropped `unresolved` specs, not the pre-reconcile guess).
        const reconciled = action === "add" ? await s.addSignals(signals) : await s.removeSignals(signals);
        return ok({ action, signals: reconciled });
      }
      case "write": {
        if (!writes || writes.length === 0) return err("write requires `writes` (['target=value', ...]).");
        try {
          const r = await traceWrite(writes);
          return ok({ action, ok: r.ok, results: r.results, error: r.error });
        } catch (e) {
          return err(`write failed: ${String(e)}`, { action });
        }
      }
      case "call": {
        if (!func) return err("call requires `func` (function symbol).");
        if (!confirm) return err("call requires confirm:true (the core is halted for the call).");
        if (args && args.length > 4) return err("call accepts at most 4 args (r0-r3).");
        try {
          const r = await traceCall(func, args ?? [], true, ret_type ?? "u32", timeout ?? 2);
          return ok({ action, ...r });
        } catch (e) {
          return err(`call failed: ${String(e)}`, { action });
        }
      }
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TEST
// ═══════════════════════════════════════════════════════════════════════

registerLegacy(
  "crosspad_test_run",
  {
    description: "[PC] Build and run the Catch2 test suite for crosspad-pc. PREFER THIS over invoking the test binary directly — configures cmake with BUILD_TESTING=ON, parses Catch2 output into passed/failed counts and errors, supports filter and list_only. Pass `labels` to run the GUI harness instead: those cases live in a second executable that only CTest knows how to launch.",
    inputSchema: {
      filter: z.string().default("")
        .describe("Catch2 test filter (e.g. '[core]', 'PadManager*'). Default '' (empty) runs ALL tests — there is no opt-out for 'no tests'. With `labels` it becomes a regex over CTest entry names instead."),
      list_only: z.boolean().default(false)
        .describe("If true, list discovered tests matching `filter` without running them. Default false."),
      labels: z.array(z.enum(["gui", "flaky"])).default([])
        .describe("CTest labels to run instead of the Catch2 binary. 'gui' = the simulator harness ([gui] cases), which excludes the flaky entries unless 'flaky' is listed too. Default [] = the crosspad_tests binary, as before."),
    },
    outputSchema: O_Test,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ filter, list_only, labels }, extra: any) => {
    const onLine = makeProgressLogger("test", extra);
    return jsonResponse((await crosspadTest(filter, list_only, onLine, extra.signal, labels)));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — screenshot
// ═══════════════════════════════════════════════════════════════════════

registerLegacy(
  "crosspad_screenshot",
  {
    description:
      "[PC sim] Capture a PNG screenshot from the running PC simulator. " +
      "Default behavior (return_inline=false): saves to <crosspad-pc>/screenshots/ and returns metadata + file_path (cheap, no token cost). " +
      "Set return_inline=true ONLY when the LLM needs to actually see the image — that returns base64 inline and burns ~50-150k tokens.",
    inputSchema: {
      filename: z.string().optional()
        .describe("Custom filename (saved under <crosspad-pc>/screenshots/). Default: screenshot_<timestamp>.png. Ignored when return_inline=true."),
      return_inline: z.boolean().default(false)
        .describe("false (default) = save to disk, return file_path (token-cheap). true = return base64 image content for the LLM to view (token-expensive — only when the image must be analyzed)."),
      region: z.enum(["full", "lcd"]).default("full")
        .describe("'full' (default) = the whole emulator window. 'lcd' = only the 320x240 screen, cropped by this server (the simulator's own lcd crop is 18 px stale)."),
    },
    outputSchema: O_Screenshot,
    annotations: ANN_SIDE_EFFECT,
  },
  async ({ filename, return_inline, region }) => {
    const result = await crosspadScreenshot(!return_inline, filename, region);
    if (!result.success) return jsonResponse({ ...result });

    if (return_inline) {
      // Inline path — simulator returned base64 directly. Include
      // structuredContent so clients honoring outputSchema see metadata
      // alongside the image part.
      if (result.data_base64) {
        const meta = { success: true, width: result.width, height: result.height, format: result.format, region: result.region };
        return {
          content: [
            { type: "image" as const, data: result.data_base64, mimeType: "image/png" },
            { type: "text" as const, text: JSON.stringify(meta, null, 2) },
          ],
          structuredContent: meta,
        };
      }
    }

    // File path — return metadata only, no base64 dump
    return jsonResponse({
      success: true,
      width: result.width,
      height: result.height,
      format: result.format,
      file_path: result.file_path,
      size: result.size,
      region: result.region,
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — input events
// ═══════════════════════════════════════════════════════════════════════

registerLegacy(
  "crosspad_input",
  {
    description:
      "[PC sim] Send one input event to the running PC simulator (consolidated; replaces 7 v5 tools). " +
      "Pick an `action`, then supply ONLY the fields it needs — extras are ignored. " +
      "Required fields per action:\n" +
      "  • pad_press            → pad (velocity optional, default 127)\n" +
      "  • pad_release          → pad\n" +
      "  • encoder_rotate       → delta (positive=CW, negative=CCW)\n" +
      "  • encoder_press        → (none)\n" +
      "  • encoder_release      → (none)\n" +
      "  • click                → x, y\n" +
      "  • key                  → keycode (SDL keycode int)\n" +
      "Requires the simulator to be running (crosspad_run first).",
    inputSchema: {
      action: z.enum([
        "pad_press", "pad_release",
        "encoder_rotate", "encoder_press", "encoder_release",
        "click", "key",
      ]).describe("Which input event to dispatch. Required params — pad_press: pad (velocity?); pad_release: pad; encoder_rotate: delta; encoder_press/encoder_release: (none); click: x,y; key: keycode."),
      pad: PadIndex.optional().describe("Required for action=pad_press|pad_release. Pad index 0-15."),
      velocity: Velocity.optional().describe("Optional for action=pad_press (default 127). Ignored for other actions."),
      delta: z.number().int().optional().describe("Required for action=encoder_rotate. Positive=CW, negative=CCW. Typical range -10..10."),
      x: z.number().int().min(0).optional().describe("Required for action=click. X pixel coordinate (0 = left)."),
      y: z.number().int().min(0).optional().describe("Required for action=click. Y pixel coordinate (0 = top)."),
      keycode: z.number().int().optional().describe("Required for action=key. SDL keycode (e.g. 27=ESC, 32=SPACE, 13=RETURN)."),
    },
    outputSchema: O_Input,
    annotations: ANN_SIDE_EFFECT,
  },
  async ({ action, pad, velocity, delta, x, y, keycode }) => {
    // Per-action required-field validation. Cleaner than letting the sim reject
    // because the error here cites the missing field by name.
    const need = (field: string, val: unknown): string | null =>
      val === undefined ? `Field '${field}' is required for action='${action}'.` : null;
    let missing: string | null = null;
    switch (action) {
      case "pad_press":
        missing = need("pad", pad); break;
      case "pad_release":
        missing = need("pad", pad); break;
      case "encoder_rotate":
        missing = need("delta", delta); break;
      case "click":
        missing = need("x", x) ?? need("y", y); break;
      case "key":
        missing = need("keycode", keycode); break;
    }
    if (missing) return err(missing);

    const params: Parameters<typeof crosspadInput>[0] =
      action === "pad_press"
        ? { action, pad: pad!, velocity: velocity ?? 127 }
        : action === "pad_release"
        ? { action, pad: pad! }
        : action === "encoder_rotate"
        ? { action, delta: delta! }
        : action === "click"
        ? { action, x: x!, y: y! }
        : action === "key"
        ? { action, keycode: keycode! }
        : { action };
    return jsonResponse((await crosspadInput(params)));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — runtime state
// ═══════════════════════════════════════════════════════════════════════

registerLegacy(
  "crosspad_stats",
  {
    description: "[PC sim] Read runtime statistics from the running PC simulator: pad state, capabilities, heap, registered apps, active pad logic.",
    inputSchema: {},
    outputSchema: O_Stats,
    annotations: ANN_READ_ONLY,
  },
  async () => jsonResponse((await crosspadStats()))
);

registerLegacy(
  "crosspad_settings_get",
  {
    description: "[PC sim] Read settings from the running simulator.",
    inputSchema: {
      // Derived from CrosspadSettings itself rather than typed out here, so a
      // group added to the firmware does not need this file edited.
      category: z.enum(settingsCategories() as [string, ...string[]])
        .default("all")
        .describe("Settings category, one per group CrosspadSettings declares. Use 'all' to fetch everything."),
    },
    outputSchema: O_SettingsGet,
    annotations: ANN_READ_ONLY,
  },
  async ({ category }) => jsonResponse((await crosspadSettingsGet(category)))
);

registerLegacy(
  "crosspad_settings_set",
  {
    description: "[PC sim] Write a single setting on the running simulator.",
    inputSchema: {
      key: z.string().min(1)
        .describe("Setting key. Either a flat name ('lcd_brightness') or dotted category.field ('keypad.eco_mode', 'vibration.enable'). Use crosspad_settings_get to discover valid keys."),
      value: z.union([z.number(), z.boolean()])
        .describe("The value, matching the field's type in the CrosspadSettings schema: a number, or true/false for a bool field (encoded as 1/0 on the wire for you)."),
    },
    outputSchema: O_SettingsSet,
    annotations: ANN_DESTRUCTIVE,
  },
  async ({ key, value }) => jsonResponse((await crosspadSettingsSet(key, value)))
);

// ═══════════════════════════════════════════════════════════════════════
// REPO — read-only
// ═══════════════════════════════════════════════════════════════════════

registerLegacy(
  "crosspad_repo_status",
  {
    description: "Git status across ALL detected CrossPad repos in one call: branch, HEAD, dirty files, submodule sync state. PREFER THIS over running `git status` per repo — handles the 5-repo monorepo layout in one shot.",
    inputSchema: {},
    outputSchema: O_RepoStatus,
    annotations: ANN_READ_ONLY,
  },
  async (_args: unknown, extra: any) => jsonResponse({ success: true, ...(await crosspadReposStatus({ signal: extra?.signal })) })
);

registerLegacy(
  "crosspad_repo_diff",
  {
    description: "Show submodule drift in a parent repo (crosspad-pc or platform-idf): commits ahead/behind pinned, changed files, uncommitted work. Use to inspect dev-mode work before pinning.",
    inputSchema: {
      submodule: z.enum(["crosspad-core", "crosspad-gui", "both"]).default("both")
        .describe("Which submodule to inspect."),
      parent: z.enum(["crosspad-pc", "platform-idf"]).default("crosspad-pc")
        .describe("Parent repo containing the submodule. Defaults to crosspad-pc."),
    },
    outputSchema: O_RepoDiff,
    annotations: ANN_READ_ONLY,
  },
  async ({ submodule, parent }, extra: any) =>
    jsonResponse({ success: true, ...(await crosspadDiffCore(submodule, parent, { signal: extra?.signal })) })
);

// ═══════════════════════════════════════════════════════════════════════
// REPO — mutations
// ═══════════════════════════════════════════════════════════════════════

registerLegacy(
  "crosspad_submodule_update",
  {
    description: "Update a submodule in a parent repo to the latest commit on a tracking branch (git fetch + checkout origin/<branch> + stage). Destructive: discards local commits in the submodule that aren't on the remote branch.",
    inputSchema: {
      submodule: Submodule,
      repo: RepoAlias.describe("Parent repo containing the submodule (idf, pc, arduino, or full name)"),
      branch: GitRef.default("main").describe("Remote branch to track (e.g. main, develop)"),
    },
    outputSchema: O_SubmoduleUpdate,
    annotations: ANN_DESTRUCTIVE_OPEN,
  },
  async ({ submodule, repo, branch }, extra: any) =>
    jsonResponse(await crosspadSubmoduleUpdate(submodule, repo, branch, { signal: extra?.signal }))
);

registerLegacy(
  "crosspad_commit",
  {
    description: "Commit staged changes in a specific CrossPad repo. PREFER THIS over raw `git commit` — handles repo aliases (idf/pc/arduino/core/gui), refuses on merge conflicts, uses 0600 tempfiles for messages (no shell-quoting issues with quotes/newlines/backticks), and never pushes. Stages files[] first if supplied.",
    inputSchema: {
      repo: RepoAlias,
      message: z.string().min(1).describe("Commit message. Newlines/quotes/backticks are safe — passed via 0600 tempfile, not shell-quoted."),
      files: z.array(z.string()).optional()
        .describe("If supplied: stage exactly these files (repo-relative paths) then commit. If omitted: commit whatever is currently staged in the repo (no auto-stage)."),
    },
    outputSchema: O_Commit,
    annotations: ANN_DESTRUCTIVE,
  },
  async ({ repo, message, files }, extra: any) =>
    jsonResponse(await crosspadCommit(repo, message, files, { signal: extra?.signal }))
);

// ═══════════════════════════════════════════════════════════════════════
// CODE — search and analysis
// ═══════════════════════════════════════════════════════════════════════

registerLegacy(
  "crosspad_search_symbols",
  {
    description: "Search for symbol DEFINITIONS (classes, functions, macros, enums, typedefs) across CrossPad repos via git grep. PREFER THIS over raw `grep -r` or `git grep` — it filters to definitions only (skips call sites/declarations), classifies kind, and aggregates across all repos automatically. Substring match: 'Foo' matches FooBar, MyFoo. Vendored/generated trees (lvgl, managed_components, thorvg, TFT_eSPI, STM Drivers/Middlewares/CMSIS, build, …) are skipped by default — pass include_vendored=true to scan them.",
    inputSchema: {
      query: z.string().min(1).describe("Symbol name (substring match, case-insensitive on filter)"),
      kind: z.enum(["class", "function", "macro", "enum", "typedef", "all"]).default("all"),
      repos: z.array(z.string()).default(["all"])
        .describe("Repo names to scan, or ['all']. Names: crosspad-core, crosspad-gui, crosspad-pc, platform-idf, ESP32-S3, stm32-r20."),
      max_results: z.number().int().min(1).max(500).default(50),
      context_lines: z.number().int().min(0).max(10).default(0)
        .describe("Surrounding lines per match (like grep -C). 0 = no context."),
      include_vendored: z.boolean().default(false)
        .describe("Scan vendored/generated trees too (lvgl, managed_components, STM Drivers/Middlewares, build, …). Default false — these are almost always noise."),
    },
    outputSchema: O_SearchSymbols,
    annotations: ANN_READ_ONLY,
  },
  async ({ query, kind, repos, max_results, context_lines, include_vendored }, extra: any) =>
    jsonResponse({ success: true, ...(await crosspadSearchSymbols(query, kind, repos, max_results, context_lines, include_vendored, { signal: extra?.signal })) })
);

registerLegacy(
  "crosspad_list_interfaces",
  {
    description: "List all crosspad-core interfaces (I*-prefixed classes in crosspad-core/include/crosspad/).",
    inputSchema: {},
    outputSchema: O_Architecture,
    annotations: ANN_READ_ONLY,
  },
  async (_args: unknown, extra: any) => jsonResponse({ success: true, ...(await crosspadInterfaces("list", { signal: extra?.signal })) })
);

registerLegacy(
  "crosspad_interface_implementations",
  {
    description: "Find all classes implementing a given interface across CrossPad repos. Returns className, file path, platform. Use crosspad_list_interfaces first if you don't know exact names.",
    inputSchema: {
      interface_name: z.string().min(1)
        .regex(/^I[A-Z][A-Za-z0-9_]*$/, "Interface name must start with 'I' followed by an uppercase letter (e.g. 'IDisplay').")
        .describe("Interface name — MUST start with 'I' and use the exact crosspad-core casing (e.g. 'IDisplay', 'IPadLogicHandler', 'IKeyValueStore'). Not 'Display', not 'iDisplay'."),
    },
    outputSchema: O_Architecture,
    annotations: ANN_READ_ONLY,
  },
  async ({ interface_name }) =>
    jsonResponse({ success: true, ...(await crosspadInterfaces(`implementations ${interface_name}`)) })
);

registerLegacy(
  "crosspad_capabilities",
  {
    description: "List platform capability flags (Capability enum) and which capabilities each platform sets.",
    inputSchema: {},
    outputSchema: O_Architecture,
    annotations: ANN_READ_ONLY,
  },
  async (_args: unknown, extra: any) => jsonResponse({ success: true, ...(await crosspadInterfaces("capabilities", { signal: extra?.signal })) })
);

registerLegacy(
  "crosspad_list_apps_source",
  {
    description: "List apps registered via REGISTER_APP() macro by scanning source files. Different from crosspad_apps_list (which reads the package registry).",
    inputSchema: {
      platform: z.enum(["pc", "idf", "arduino", "all"]).default("all"),
    },
    outputSchema: O_AppsSource,
    annotations: ANN_READ_ONLY,
  },
  async ({ platform }, extra: any) =>
    jsonResponse({ success: true, apps: await crosspadApps(platform, { signal: extra?.signal }) })
);

// ═══════════════════════════════════════════════════════════════════════
// APPS — package manager (crosspad-apps registry)
// ═══════════════════════════════════════════════════════════════════════

registerLegacy(
  "crosspad_apps_list",
  {
    description: "List apps from the crosspad-apps registry, aggregating installation status across all detected platform repos. Reads JSON; no Python required. Different from crosspad_list_apps_source (which scans REGISTER_APP() in source code).",
    inputSchema: {
      show_all: z.boolean().default(false)
        .describe("Include apps incompatible with detected platforms."),
    },
    outputSchema: O_AppsList,
    annotations: ANN_READ_OPEN,
  },
  async ({ show_all }) =>
    jsonResponse(crosspadAppList(show_all))
);

registerLegacy(
  "crosspad_apps_install",
  {
    description: "Install an app from the crosspad-apps registry as a git submodule. Requires gh CLI authenticated. Delegates to <repo>/{tools|scripts}/app_manager.py.",
    inputSchema: {
      platform: Platform,
      app_name: AppName.describe("App ID from registry (e.g. 'metronome')"),
      ref: GitRef.default("main").describe("Git ref (branch, tag, or commit SHA)"),
      force: z.boolean().default(false).describe("Install even if marked incompatible."),
    },
    outputSchema: O_AppAction,
    annotations: ANN_DESTRUCTIVE_OPEN,
  },
  async ({ platform, app_name, ref, force }, extra: any) => {
    const onLine = makeProgressLogger("apps-install", extra);
    return jsonResponse((await crosspadAppInstall(app_name, platform, ref, force, onLine, extra.signal)));
  }
);

registerLegacy(
  "crosspad_apps_remove",
  {
    description: "Remove an installed app submodule from a platform repo. Delegates to app_manager.py.",
    inputSchema: {
      platform: Platform,
      app_name: AppName,
    },
    outputSchema: O_AppAction,
    annotations: ANN_DESTRUCTIVE,
  },
  async ({ platform, app_name }, extra: any) => {
    const onLine = makeProgressLogger("apps-remove", extra);
    return jsonResponse((await crosspadAppRemove(app_name, platform, onLine, extra.signal)));
  }
);

registerLegacy(
  "crosspad_apps_update",
  {
    description:
      "Update one or all installed apps on a platform. EXACTLY ONE of these must be supplied: " +
      "set `app_name` to update a single app, OR set `update_all=true` to update every installed app on the platform. " +
      "Supplying both, or neither, is an error.",
    inputSchema: {
      platform: Platform,
      app_name: AppName.optional().describe("App ID (e.g. 'metronome') to update one app. Mutually exclusive with update_all=true."),
      update_all: z.boolean().default(false).describe("If true, update all installed apps on `platform`. Mutually exclusive with app_name."),
    },
    outputSchema: O_AppAction,
    annotations: ANN_DESTRUCTIVE_OPEN,
  },
  async ({ platform, app_name, update_all }, extra: any) => {
    if (!app_name && !update_all) {
      return err("Specify `app_name` to update a single app, OR set `update_all=true` to update every installed app.");
    }
    if (app_name && update_all) {
      return err("`app_name` and `update_all=true` are mutually exclusive — pick one.");
    }
    const onLine = makeProgressLogger("apps-update", extra);
    return jsonResponse((await crosspadAppUpdate(platform, app_name, update_all, onLine, extra.signal)));
  }
);

registerLegacy(
  "crosspad_apps_sync",
  {
    description: "Sync a platform's apps.json manifest with existing submodules (rebuild manifest from disk state).",
    inputSchema: { platform: Platform },
    outputSchema: O_AppAction,
    annotations: ANN_DESTRUCTIVE,
  },
  async ({ platform }, extra: any) => {
    const onLine = makeProgressLogger("apps-sync", extra);
    return jsonResponse((await crosspadAppSync(platform, onLine, extra.signal)));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// RESOURCES
// crosspad://workspace — agregat (repos, branches, dirty, sim status).
// Eksponowane jako resource (nie tool) → klient może załadować raz na
// początek sesji bez tool call, dając LLM tani sygnał kontekstowy.
// ═══════════════════════════════════════════════════════════════════════

import { isSimulatorRunning as _isSimRunning } from "./utils/remote-client.js";
import { getRepos as _getRepos } from "./config.js";
import { getHead as _getHead } from "./utils/git.js";
import { mapLimit as _mapLimit, DEFAULT_CONCURRENCY as _DEFAULT_CONCURRENCY } from "./utils/async.js";

server.resource(
  "crosspad-workspace",
  "crosspad://workspace",
  {
    description: "Detected CrossPad repos with branch, HEAD, dirty count, plus PC simulator running status. Cheap snapshot — load once per session for context.",
    mimeType: "application/json",
  },
  async () => {
    const repos = _getRepos();
    const repoSummary: Record<string, unknown> = {};
    // One repo's three git reads run together, and the repos themselves run
    // DEFAULT_CONCURRENCY at a time — none of it blocks the event loop.
    const { git: _git } = await import("./utils/git.js");
    const summaries = await _mapLimit(
      Object.entries(repos),
      _DEFAULT_CONCURRENCY,
      async ([name, root]) => {
        const [head, branch, dirty] = await Promise.all([
          _getHead(root, { timeoutMs: 5000 }),
          _git("git rev-parse --abbrev-ref HEAD", root, { timeoutMs: 5000 }),
          _git("git status --porcelain", root, { timeoutMs: 5000 }),
        ]);
        const dirtyCount = dirty.success
          ? dirty.stdout.split("\n").filter((l) => l.trim().length > 0).length
          : 0;
        return {
          name,
          value: {
            path: root,
            head: head ?? null,
            branch: branch.success ? branch.stdout.trim() : null,
            dirty_count: dirtyCount,
          },
        };
      },
    );
    for (const { name, value } of summaries) repoSummary[name] = value;
    const simRunning = await _isSimRunning();
    const payload = {
      detected_repos: Object.keys(repos),
      repos: repoSummary,
      pc_simulator: { running: simRunning },
      hint: "If a repo you expected isn't detected, set its path env var (CROSSPAD_PC_ROOT, CROSSPAD_IDF_ROOT, etc.) and restart the MCP server.",
    };
    return {
      contents: [
        {
          uri: "crosspad://workspace",
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// crosspad://trace — live SWD trace session status. Cheap snapshot the LLM
// can read without a tool call to learn whether a trace is running, the
// device state, achieved Fs, signals, and the dashboard URL.
// ═══════════════════════════════════════════════════════════════════════

server.resource(
  "crosspad-trace",
  "crosspad://trace",
  {
    description: "Live SWD trace session status: active flag, device_state, sample_count, achieved Fs, traced signals, and the web UI URL. Returns {active:false} when idle.",
    mimeType: "application/json",
  },
  async () => {
    const s = getActiveSession();
    const payload = s
      ? {
          active: true,
          device_state: s.deviceState,
          sample_count: s.buffer.count(),
          actual_fs: (() => {
            const elapsed = (performance.now() - s.startedAt) / 1000;
            return elapsed > 0 ? s.buffer.count() / elapsed : 0;
          })(),
          signals: s.buffer.signalNames(),
          file_path: s.filePath ?? null,
          // §12.1: the dashboard URL is owned by the persistent singleton; it's a
          // stable loopback URL once any trace/ui action has started the server.
          ui_url: getDashboard().port ? buildUiUrl(getDashboard().port) : null,
        }
      : { active: false };
    return {
      contents: [
        {
          uri: "crosspad://trace",
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// RESOURCES — apps registry & installed manifest per platform
// One static resource per file-per-detected-platform. LLM/clients can
// inspect raw JSON without spending a tool call. Resource set updates only
// at server start (registries don't appear/disappear mid-session).
// ═══════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";

(() => {
  const repos = _getRepos();
  // Map repo name -> platform label for stable URIs.
  const platformByRepo: Record<string, string> = {
    "platform-idf": "idf",
    "crosspad-pc": "pc",
    "ESP32-S3": "esp32-s3",
  };
  for (const [repoName, root] of Object.entries(repos)) {
    const platform = platformByRepo[repoName];
    if (!platform) continue;

    const registryPath = path.join(root, "app-registry.json");
    if (fs.existsSync(registryPath)) {
      const uri = `crosspad://apps/registry/${platform}`;
      server.resource(
        `crosspad-apps-registry-${platform}`,
        uri,
        {
          description: `Raw app-registry.json from ${repoName} — declared apps, versions, platforms, requires.`,
          mimeType: "application/json",
        },
        async () => ({
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: fs.readFileSync(registryPath, "utf-8"),
            },
          ],
        }),
      );
    }

    const manifestPath = path.join(root, "apps.json");
    if (fs.existsSync(manifestPath)) {
      const uri = `crosspad://apps/installed/${platform}`;
      server.resource(
        `crosspad-apps-installed-${platform}`,
        uri,
        {
          description: `Raw apps.json (installed manifest) from ${repoName} — what's currently installed, ref, install/update timestamps.`,
          mimeType: "application/json",
        },
        async () => ({
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: fs.readFileSync(manifestPath, "utf-8"),
            },
          ],
        }),
      );
    }
  }
})();

// ═══════════════════════════════════════════════════════════════════════
// RESOURCES — code navigation via URI templates (MCP-native)
// crosspad://symbols/{repo}/{symbol} — resolve a single symbol's definitions
// in a single repo without spending a tool call. Repo "all" searches every
// detected repo. listCallback is undefined (cannot enumerate every symbol);
// clients must construct concrete URIs.
// ═══════════════════════════════════════════════════════════════════════

server.registerResource(
  "crosspad-symbol",
  new ResourceTemplate("crosspad://symbols/{repo}/{symbol}", { list: undefined }),
  {
    description: "Resolve a single symbol by repo+name. URI: crosspad://symbols/<repo>/<symbol>. <repo> is one of: crosspad-core, crosspad-gui, crosspad-pc, platform-idf, ESP32-S3, stm32-r20, or 'all'. Returns JSON with matching definition(s) (class/function/macro/enum/typedef). For substring/wildcard search, use the crosspad_search_symbols tool.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const repo = decodeURIComponent(String(Array.isArray(variables.repo) ? variables.repo[0] : variables.repo ?? "")).trim();
    const symbol = decodeURIComponent(String(Array.isArray(variables.symbol) ? variables.symbol[0] : variables.symbol ?? "")).trim();
    if (!repo || !symbol) {
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "URI must be crosspad://symbols/<repo>/<symbol>" }, null, 2) }],
      };
    }
    const reposScope = repo === "all" ? ["all"] : [repo];
    const result = await crosspadSearchSymbols(symbol, "all", reposScope, 50, 0);
    return {
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// v10 WIRING — policy, toolsets, registry
//
// Everything above registered eagerly at import time; this block decides what
// the client actually sees. `loadV10Registrars()` picks up the v10 tool modules
// that exist in this tree — one that has not been written yet is skipped rather
// than taking the server down with it.
// ═══════════════════════════════════════════════════════════════════════

const startupArgv = process.argv.slice(2);
export const policy = loadPolicy({ env: process.env, readOnlyFlag: hasReadOnlyFlag(startupArgv) });
export const toolContext: ToolContext = { daemon: getHilDaemon, policy, jobs, handles };
export const toolsetManager = new ToolsetManager(server, policy);
registerAll(server, toolContext, toolsetManager, legacyTools, await loadV10Modules());
for (const ts of initialToolsets(startupArgv, process.env)) toolsetManager.enable(ts);
console.error(
  `crosspad-mcp v${version}: policy=${policy.mode} toolsets=${toolsetManager.enabled().join(",")}` +
    (toolsetManager.hiddenTools().length ? ` hidden=${toolsetManager.hiddenTools().length}` : ""),
);

// ═══════════════════════════════════════════════════════════════════════
// START — stdio (default) or HTTP (--http <port>)
// HTTP transport is opt-in via CLI flag for remote dev boxes / browsers.
// Stateful sessions: each initialize gets a session ID; subsequent requests
// must echo it. Single shared transport multiplexes sessions internally.
// ═══════════════════════════════════════════════════════════════════════

function parseHttpPort(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--http") {
      const next = argv[i + 1];
      if (!next) return 3000;
      const n = parseInt(next, 10);
      return Number.isFinite(n) && n > 0 && n < 65536 ? n : NaN as unknown as number;
    }
    if (a.startsWith("--http=")) {
      const n = parseInt(a.slice("--http=".length), 10);
      return Number.isFinite(n) && n > 0 && n < 65536 ? n : NaN as unknown as number;
    }
  }
  return null;
}

async function main() {
  const httpPort = parseHttpPort(process.argv.slice(2));
  if (httpPort !== null) {
    if (Number.isNaN(httpPort)) {
      console.error("Invalid --http port (must be 1..65535)");
      process.exit(1);
    }
    const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { createServer } = await import("http");
    const { randomUUID } = await import("crypto");

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);

    const httpServer = createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found — MCP endpoint is at /mcp");
        return;
      }
      transport.handleRequest(req, res).catch((e) => {
        console.error("MCP HTTP request failed:", e);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal error");
        }
      });
    });

    httpServer.listen(httpPort, () => {
      console.error(`crosspad-mcp HTTP transport listening on http://localhost:${httpPort}/mcp`);
    });
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run main() only when this module is the process entry point. Importing the
// module from a test must NOT spin up the stdio transport.
import { pathToFileURL } from "url";
const isEntry = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main().catch((err) => {
    console.error("MCP server failed:", err);
    process.exit(1);
  });
}
