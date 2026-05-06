#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

import { crosspadBuild, crosspadRun, crosspadKill } from "./tools/build.js";
import { crosspadBuildCheck } from "./tools/build-check.js";
import { crosspadLog } from "./tools/log.js";
import { crosspadIdfBuild } from "./tools/idf-build.js";
import { crosspadIdfFlash, crosspadIdfOta } from "./tools/idf-flash.js";
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
import { crosspadSettingsGet, crosspadSettingsSet } from "./tools/settings.js";
import { crosspadMidiSend } from "./tools/midi.js";
import {
  crosspadAppList,
  crosspadAppInstall,
  crosspadAppRemove,
  crosspadAppUpdate,
  crosspadAppSync,
} from "./tools/app-manager.js";

import type { OnLine } from "./utils/exec.js";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

// Server instructions — MCP clients prepend these to the LLM system prompt.
// This is the *primary* mechanism by which a Claude session "knows" to pick
// crosspad_* tools when working inside any CrossPad repo. CLAUDE.md and memory
// alone proved insufficient; these instructions are loaded by the protocol
// itself before the user's first message and survive context compaction.
const SERVER_INSTRUCTIONS = `
You have access to the CrossPad MCP server, which exposes purpose-built tools for the CrossPad embedded music controller monorepo (repos: crosspad-pc, platform-idf, ESP32-S3, crosspad-core, crosspad-gui, plus app submodules).

WHEN TO USE THESE TOOLS — in any conversation that touches a CrossPad repo, prefer the crosspad_* tools over raw shell equivalents:

- Inspecting code  → crosspad_search_symbols (NOT \`grep -r\`); crosspad_list_interfaces; crosspad_interface_implementations.
- Repo state       → crosspad_repo_status (NOT \`git status\` across N repos); crosspad_repo_diff for submodule drift.
- Building PC sim  → crosspad_check platform=pc → crosspad_build platform=pc (NOT raw cmake/ninja). Then crosspad_run; crosspad_kill when done.
- Building firmware→ crosspad_build platform=idf (NOT raw \`idf.py build\`); crosspad_flash transport=uart|ota.
- Tests            → crosspad_test_run (NOT raw catch2 binary).
- Sim interaction  → crosspad_screenshot, crosspad_input, crosspad_midi, crosspad_stats, crosspad_settings_get/set.
- Apps (registry)  → crosspad_apps_list / install / remove / update / sync (NOT manual submodule git ops).
- Commits          → crosspad_commit (NOT raw \`git commit\`) — handles multi-repo paths and refuses on merge conflicts.

WHY: these tools resolve repos dynamically from env vars, parse build output into structured errors[], stream progress, and refuse unsafe operations. Manual shell equivalents will work but lose this scaffolding and frequently break across the 5 repos.

DISCOVERY: if unsure whether a repo is detected, check the \`crosspad://workspace\` resource — it lists detected repos, current branches, dirty counts, and sim status.
`.trim();

const server = new McpServer(
  { name: "crosspad", version },
  { capabilities: { logging: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS }
);

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

// ═══════════════════════════════════════════════════════════════════════
// RESPONSE HELPERS — uniform { success, ...data, error? } envelope
// MCP spec: tool-level errors must set `isError: true` on the result so the
// client/LLM can distinguish them from successful tool calls.
// ═══════════════════════════════════════════════════════════════════════

function jsonResponse(data: object) {
  // Emit structuredContent in addition to text content.
  // - Clients with outputSchema validate structuredContent.
  // - Clients without it ignore the field per spec.
  // - LLM still sees the same JSON in `content` for backwards compat.
  const dataAsRecord = data as Record<string, unknown>;
  const result: {
    content: Array<{ type: "text"; text: string }>;
    structuredContent: Record<string, unknown>;
    isError?: boolean;
  } = {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: dataAsRecord,
  };
  if (dataAsRecord.success === false) result.isError = true;
  return result;
}

function ok(data: Record<string, unknown> = {}) {
  return jsonResponse({ success: true, ...data });
}

function err(message: string, extra: Record<string, unknown> = {}) {
  return jsonResponse({ success: false, error: message, ...extra });
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

const O_Build = {
  success: z.boolean(),
  duration_seconds: z.number(),
  errors: z.array(z.string()),
  warnings_count: z.number().int(),
  output_path: z.string(),
  ...ErrorField,
};

const O_Run = {
  success: z.boolean(),
  pid: z.number().int().nullable().optional(),
  exe_path: z.string(),
  already_running: z.boolean().optional(),
  responsive: z.boolean().optional(),
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

const O_IdfBuild = {
  success: z.boolean(),
  duration_seconds: z.number(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  tail: z.array(z.string()),
  auto_reconfigured: z.boolean().optional(),
  ...ErrorField,
};

const O_Flash = {
  success: z.boolean(),
  method: z.enum(["uart", "ota"]),
  port: z.string(),
  duration_seconds: z.number(),
  output_tail: z.array(z.string()),
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
    vid: z.string().optional(),
    pid: z.string().optional(),
    is_crosspad: z.boolean(),
  }).passthrough()),
  crosspad_count: z.number().int().optional(),
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
  ...ErrorField,
};

const O_Screenshot = {
  success: z.boolean(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  format: z.string().optional(),
  file_path: z.string().optional(),
  size: z.number().int().optional(),
  ...ErrorField,
};

const O_Input = {
  success: z.boolean(),
  ...ErrorField,
};

const O_Midi = {
  success: z.boolean(),
  type: z.enum(["note_on", "note_off", "cc", "program_change"]).optional(),
  channel: z.number().int().optional(),
  details: z.record(z.string(), z.number()).optional(),
  ...ErrorField,
};

const O_Stats = {
  success: z.boolean(),
  stats: z.record(z.string(), z.unknown()).optional(),
  ...ErrorField,
};

const O_SettingsGet = {
  success: z.boolean(),
  settings: z.record(z.string(), z.unknown()).optional(),
  ...ErrorField,
};

const O_SettingsSet = {
  success: z.boolean(),
  key: z.string().optional(),
  value: z.number().optional(),
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

const BuildPlatform = z.enum(["pc", "idf"]).describe("Target platform: 'pc' = host simulator, 'idf' = ESP32-S3 firmware.");
const PlatformPcOnly = z.enum(["pc"]).default("pc").describe("Platform — currently only 'pc' is supported here.");

server.registerTool(
  "crosspad_build",
  {
    description: "Build CrossPad for the given platform. platform=pc → CMake + Ninja host simulator (PREFER THIS over `cmake --build build` — picks the right MSVC env on Windows, parses errors/warnings, streams progress). platform=idf → idf.py build for ESP32-S3 firmware (PREFER THIS over `idf.py build` — sources IDF env, auto-fullcleans when new apps detected, parses errors/warnings).",
    inputSchema: {
      platform: BuildPlatform,
      mode: z.enum(["incremental", "clean", "fullclean", "reconfigure"])
        .default("incremental")
        .describe("incremental: rebuild only what changed (default). clean: wipe build dir then build. reconfigure: re-run cmake without wiping (PC only). fullclean: idf.py fullclean then build (IDF only)."),
      build_type: z.enum(["Debug", "Release", "RelWithDebInfo"])
        .default("Debug")
        .describe("CMake build type — PC only. Only honored on clean/reconfigure (incremental keeps existing cache)."),
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
    // idf
    if (mode === "reconfigure") return err("mode='reconfigure' is PC-only. IDF supports: incremental, clean, fullclean.");
    const idfMode = mode === "incremental" ? "build" : mode;
    const onLine = makeProgressLogger("build-idf", extra);
    return jsonResponse(await crosspadIdfBuild(idfMode as "build" | "fullclean" | "clean", onLine, extra.signal));
  }
);

server.registerTool(
  "crosspad_run",
  {
    description: "Launch the built simulator binary in the background. Returns pid + exe_path. Refuses to spawn a duplicate if one is already responding on the TCP control port (use force=true to override). Fails if binary not built — call crosspad_build first. Currently PC-only (IDF firmware doesn't run on the host).",
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
      return err(
        `Simulator process started (pid=${result.pid}) but TCP control port did not respond within 3s. Process may have crashed during startup.`,
        { pid: result.pid, exe_path: result.exe_path, responsive: false },
      );
    }
    return ok({ pid: result.pid, exe_path: result.exe_path, responsive: result.responsive });
  }
);

server.registerTool(
  "crosspad_kill",
  {
    description: "Stop the running PC simulator. Sends SIGTERM to processes named 'CrossPad'. Returns killed PIDs and whether the TCP control port stopped responding. Currently PC-only.",
    inputSchema: {
      platform: PlatformPcOnly,
    },
    outputSchema: O_Kill,
    annotations: ANN_DESTRUCTIVE,
  },
  async () => jsonResponse(await crosspadKill())
);

server.registerTool(
  "crosspad_check",
  {
    description: "Health check for a build — detects stale exe, new sources missing from build system, dirty submodules. Use before crosspad_build to decide if rebuild needed. Currently PC-only.",
    inputSchema: {
      platform: PlatformPcOnly,
    },
    outputSchema: O_BuildCheck,
    annotations: ANN_READ_ONLY,
  },
  async () => jsonResponse(crosspadBuildCheck())
);

// ═══════════════════════════════════════════════════════════════════════
// FLASH — unified UART/OTA into one tool with `transport` axis
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_flash",
  {
    description: "Flash firmware to a connected CrossPad device. transport='uart' uses idf.py flash (device must be in bootloader mode). transport='ota' uses platform-idf/tools/ota_flash.py over USB CDC (no bootloader mode required). Requires prior crosspad_build platform=idf.",
    inputSchema: {
      transport: z.enum(["uart", "ota"]).describe("'uart' = bootloader-mode flash via idf.py; 'ota' = USB-CDC OTA flash via ota_flash.py."),
      port: Port.optional(),
      firmware_path: z.string().optional()
        .describe("Custom firmware binary path (OTA only). Defaults to <idf-root>/build/CrossPad.bin."),
    },
    outputSchema: O_Flash,
    annotations: ANN_DESTRUCTIVE,
  },
  async ({ transport, port, firmware_path }, extra: any) => {
    if (transport === "uart") {
      if (firmware_path) return err("Field 'firmware_path' is OTA-only — UART flash always uses the active build dir.");
      const onLine = makeProgressLogger("flash-uart", extra);
      return jsonResponse(await crosspadIdfFlash(port, onLine, extra.signal));
    }
    // ota
    const onLine = makeProgressLogger("flash-ota", extra);
    return jsonResponse(await crosspadIdfOta(port, firmware_path, onLine, extra.signal));
  }
);

server.registerTool(
  "crosspad_log",
  {
    description: "Capture logs from PC simulator (target='pc': spawn binary, capture stdout/stderr, kill) or connected ESP32-S3 device (target='idf': read serial via pyserial, no TTY needed). Consolidated tool — replaces crosspad_log_pc and crosspad_log_idf in v6.",
    inputSchema: {
      target: z.enum(["pc", "idf"]).describe("'pc' = run + capture sim binary; 'idf' = read serial from connected device."),
      port: Port.optional().describe("Serial port (idf only). Auto-detected if omitted; required when multiple devices connected."),
      timeout_seconds: TimeoutSec.optional().describe("Capture duration. Defaults: 5s for pc, 10s for idf."),
      max_lines: MaxLines.optional().describe("Max output lines. Defaults: 200 for pc, 500 for idf."),
      filter: z.string().optional()
        .describe("Case-insensitive substring filter (idf only). Only lines containing this string are returned."),
    },
    outputSchema: O_Log,
    annotations: ANN_READ_ONLY,
  },
  async ({ target, port, timeout_seconds, max_lines, filter }, extra: any) => {
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
      ...(await crosspadIdfMonitor(port, timeout_seconds ?? 10, max_lines ?? 500, filter, onLine, extra.signal)),
    });
  }
);

server.registerTool(
  "crosspad_devices",
  {
    description: "List all connected USB serial devices. Identifies CrossPad devices (Espressif VID 0x303a, PID 0x3456) separately from other ports.",
    inputSchema: {},
    outputSchema: O_Devices,
    annotations: ANN_READ_ONLY,
  },
  async () => jsonResponse(listDevices())
);

// ═══════════════════════════════════════════════════════════════════════
// TEST
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_test_run",
  {
    description: "Build and run the Catch2 test suite for crosspad-pc. PREFER THIS over invoking the test binary directly — configures cmake with BUILD_TESTING=ON, parses Catch2 output into passed/failed counts and errors, supports filter and list_only.",
    inputSchema: {
      filter: z.string().default("")
        .describe("Catch2 test filter (e.g. '[core]', 'PadManager*'). Empty = run all."),
      list_only: z.boolean().default(false)
        .describe("List discovered tests without running them."),
    },
    outputSchema: O_Test,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ filter, list_only }, extra: any) => {
    const onLine = makeProgressLogger("test", extra);
    return jsonResponse((await crosspadTest(filter, list_only, onLine, extra.signal)));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — screenshot
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_screenshot",
  {
    description: "Capture a PNG screenshot from the running PC simulator. By default saves to disk and returns the file_path. Set return_inline=true for inline image content (consumes more tokens).",
    inputSchema: {
      filename: z.string().optional()
        .describe("Custom filename (saved under <crosspad-pc>/screenshots/). Default: screenshot_<timestamp>.png"),
      return_inline: z.boolean().default(false)
        .describe("If true, returns inline base64 image content instead of file_path. Use only when the image is needed in-conversation."),
    },
    outputSchema: O_Screenshot,
    annotations: ANN_SIDE_EFFECT,
  },
  async ({ filename, return_inline }) => {
    const result = await crosspadScreenshot(!return_inline, filename);
    if (!result.success) return jsonResponse({ ...result });

    if (return_inline) {
      // Inline path — simulator returned base64 directly. Include
      // structuredContent so clients honoring outputSchema see metadata
      // alongside the image part.
      if (result.data_base64) {
        const meta = { success: true, width: result.width, height: result.height, format: result.format };
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
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — input events
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_input",
  {
    description: "Send a single input event to the running PC simulator (consolidated tool — replaces 7 separate tools in v6). Required fields depend on `action`: pad_press={pad,velocity?} · pad_release={pad} · encoder_rotate={delta} · encoder_press / encoder_release={} · click={x,y} · key={keycode}. The simulator validates and rejects bad combinations.",
    inputSchema: {
      action: z.enum([
        "pad_press", "pad_release",
        "encoder_rotate", "encoder_press", "encoder_release",
        "click", "key",
      ]).describe("Which input event to dispatch."),
      pad: PadIndex.optional().describe("Pad index (pad_press / pad_release)."),
      velocity: Velocity.optional().describe("Pad velocity (pad_press, default 127)."),
      delta: z.number().int().optional().describe("Encoder rotation delta. Positive=CW, negative=CCW. Typical -10..10."),
      x: z.number().int().min(0).optional().describe("X pixel coordinate (click)."),
      y: z.number().int().min(0).optional().describe("Y pixel coordinate (click)."),
      keycode: z.number().int().optional().describe("SDL keycode (key). E.g. 27=ESC, 32=SPACE, 13=RETURN."),
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
// SIM — MIDI
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_midi",
  {
    description: "Send a single MIDI event to the running simulator (consolidated tool — replaces 4 separate tools in v6). Required fields depend on `type`: note_on/note_off={note,velocity?} · cc={cc_num,value} · program_change={program}.",
    inputSchema: {
      type: z.enum(["note_on", "note_off", "cc", "program_change"])
        .describe("MIDI event type."),
      channel: Channel,
      note: Note.optional().describe("MIDI note number (note_on, note_off)."),
      velocity: Velocity.optional().describe("Velocity (note_on default 127, note_off default 0)."),
      cc_num: Cc.optional().describe("Controller number (cc)."),
      value: Cc7.optional().describe("Controller value (cc)."),
      program: Program.optional().describe("Program number (program_change)."),
    },
    outputSchema: O_Midi,
    annotations: ANN_SIDE_EFFECT,
  },
  async ({ type, channel, note, velocity, cc_num, value, program }) => {
    const need = (field: string, val: unknown): string | null =>
      val === undefined ? `Field '${field}' is required for type='${type}'.` : null;
    let missing: string | null = null;
    switch (type) {
      case "note_on":
      case "note_off":
        missing = need("note", note); break;
      case "cc":
        missing = need("cc_num", cc_num) ?? need("value", value); break;
      case "program_change":
        missing = need("program", program); break;
    }
    if (missing) return err(missing);

    return jsonResponse({
      ...(await crosspadMidiSend({
        type,
        channel,
        note,
        velocity: velocity ?? (type === "note_off" ? 0 : type === "note_on" ? 127 : undefined),
        cc_num,
        value,
        program,
      })),
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — runtime state
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_stats",
  {
    description: "Read runtime statistics from the running PC simulator: pad state, capabilities, heap, registered apps, active pad logic.",
    inputSchema: {},
    outputSchema: O_Stats,
    annotations: ANN_READ_ONLY,
  },
  async () => jsonResponse((await crosspadStats()))
);

server.registerTool(
  "crosspad_settings_get",
  {
    description: "Read settings from the running simulator.",
    inputSchema: {
      category: z.enum(["all", "display", "keypad", "vibration", "wireless", "audio", "system"])
        .default("all")
        .describe("Settings category. Use 'all' to fetch everything."),
    },
    outputSchema: O_SettingsGet,
    annotations: ANN_READ_ONLY,
  },
  async ({ category }) => jsonResponse((await crosspadSettingsGet(category)))
);

server.registerTool(
  "crosspad_settings_set",
  {
    description: "Write a single setting on the running simulator.",
    inputSchema: {
      key: z.string().min(1)
        .describe("Setting key (e.g. 'lcd_brightness', 'keypad.eco_mode', 'vibration.enable')"),
      value: z.number()
        .describe("Numeric value. Booleans: 0=false, 1=true."),
    },
    outputSchema: O_SettingsSet,
    annotations: ANN_DESTRUCTIVE,
  },
  async ({ key, value }) => jsonResponse((await crosspadSettingsSet(key, value)))
);

// ═══════════════════════════════════════════════════════════════════════
// REPO — read-only
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_repo_status",
  {
    description: "Git status across ALL detected CrossPad repos in one call: branch, HEAD, dirty files, submodule sync state. PREFER THIS over running `git status` per repo — handles the 5-repo monorepo layout in one shot.",
    inputSchema: {},
    outputSchema: O_RepoStatus,
    annotations: ANN_READ_ONLY,
  },
  async () => jsonResponse({ success: true, ...crosspadReposStatus() })
);

server.registerTool(
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
  async ({ submodule, parent }) =>
    jsonResponse({ success: true, ...crosspadDiffCore(submodule, parent) })
);

// ═══════════════════════════════════════════════════════════════════════
// REPO — mutations
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
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
  async ({ submodule, repo, branch }) =>
    jsonResponse(crosspadSubmoduleUpdate(submodule, repo, branch))
);

server.registerTool(
  "crosspad_commit",
  {
    description: "Commit staged changes in a specific CrossPad repo. PREFER THIS over raw `git commit` — handles repo aliases (idf/pc/arduino/core/gui), refuses on merge conflicts, uses 0600 tempfiles for messages (no shell-quoting issues with quotes/newlines/backticks), and never pushes. Stages files[] first if supplied.",
    inputSchema: {
      repo: RepoAlias,
      message: z.string().min(1).describe("Commit message"),
      files: z.array(z.string()).optional()
        .describe("Specific files to stage+commit. Omit to commit currently-staged changes."),
    },
    outputSchema: O_Commit,
    annotations: ANN_DESTRUCTIVE,
  },
  async ({ repo, message, files }) =>
    jsonResponse(crosspadCommit(repo, message, files))
);

// ═══════════════════════════════════════════════════════════════════════
// CODE — search and analysis
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_search_symbols",
  {
    description: "Search for symbol DEFINITIONS (classes, functions, macros, enums, typedefs) across CrossPad repos via git grep. PREFER THIS over raw `grep -r` or `git grep` — it filters to definitions only (skips call sites/declarations), classifies kind, and aggregates across all 5 repos automatically. Substring match: 'Foo' matches FooBar, MyFoo.",
    inputSchema: {
      query: z.string().min(1).describe("Symbol name (substring match, case-insensitive on filter)"),
      kind: z.enum(["class", "function", "macro", "enum", "typedef", "all"]).default("all"),
      repos: z.array(z.string()).default(["all"])
        .describe("Repo names to scan, or ['all']. Names: crosspad-core, crosspad-gui, crosspad-pc, platform-idf, ESP32-S3."),
      max_results: z.number().int().min(1).max(500).default(50),
      context_lines: z.number().int().min(0).max(10).default(0)
        .describe("Surrounding lines per match (like grep -C). 0 = no context."),
    },
    outputSchema: O_SearchSymbols,
    annotations: ANN_READ_ONLY,
  },
  async ({ query, kind, repos, max_results, context_lines }) =>
    jsonResponse({ success: true, ...crosspadSearchSymbols(query, kind, repos, max_results, context_lines) })
);

server.registerTool(
  "crosspad_list_interfaces",
  {
    description: "List all crosspad-core interfaces (I*-prefixed classes in crosspad-core/include/crosspad/).",
    inputSchema: {},
    outputSchema: O_Architecture,
    annotations: ANN_READ_ONLY,
  },
  async () => jsonResponse({ success: true, ...crosspadInterfaces("list") })
);

server.registerTool(
  "crosspad_interface_implementations",
  {
    description: "Find all classes implementing a given interface across CrossPad repos. Returns className, file path, platform.",
    inputSchema: {
      interface_name: z.string().min(1).describe("Interface name (e.g. 'IDisplay', 'IPadLogicHandler')"),
    },
    outputSchema: O_Architecture,
    annotations: ANN_READ_ONLY,
  },
  async ({ interface_name }) =>
    jsonResponse({ success: true, ...crosspadInterfaces(`implementations ${interface_name}`) })
);

server.registerTool(
  "crosspad_capabilities",
  {
    description: "List platform capability flags (Capability enum) and which capabilities each platform sets.",
    inputSchema: {},
    outputSchema: O_Architecture,
    annotations: ANN_READ_ONLY,
  },
  async () => jsonResponse({ success: true, ...crosspadInterfaces("capabilities") })
);

server.registerTool(
  "crosspad_list_apps_source",
  {
    description: "List apps registered via REGISTER_APP() macro by scanning source files. Different from crosspad_apps_list (which reads the package registry).",
    inputSchema: {
      platform: z.enum(["pc", "idf", "arduino", "all"]).default("all"),
    },
    outputSchema: O_AppsSource,
    annotations: ANN_READ_ONLY,
  },
  async ({ platform }) =>
    jsonResponse({ success: true, apps: crosspadApps(platform) })
);

// ═══════════════════════════════════════════════════════════════════════
// APPS — package manager (crosspad-apps registry)
// ═══════════════════════════════════════════════════════════════════════

server.registerTool(
  "crosspad_apps_list",
  {
    description: "List apps from the crosspad-apps registry, aggregating installation status across all detected platform repos. Reads JSON; no Python required.",
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
  "crosspad_apps_update",
  {
    description: "Update one or all installed apps on a platform. Specify app_name OR set update_all=true.",
    inputSchema: {
      platform: Platform,
      app_name: AppName.optional().describe("App ID to update. Required unless update_all=true."),
      update_all: z.boolean().default(false),
    },
    outputSchema: O_AppAction,
    annotations: ANN_DESTRUCTIVE_OPEN,
  },
  async ({ platform, app_name, update_all }, extra: any) => {
    const onLine = makeProgressLogger("apps-update", extra);
    return jsonResponse((await crosspadAppUpdate(platform, app_name, update_all, onLine, extra.signal)));
  }
);

server.registerTool(
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
    for (const [name, root] of Object.entries(repos)) {
      const head = _getHead(root);
      // Quick branch + dirty count via single-shot porcelain
      const { runCommand: _runCmd } = await import("./utils/exec.js");
      const branch = _runCmd("git rev-parse --abbrev-ref HEAD", root, 5000);
      const dirty = _runCmd("git status --porcelain", root, 5000);
      const dirtyCount = dirty.success
        ? dirty.stdout.split("\n").filter((l) => l.trim().length > 0).length
        : 0;
      repoSummary[name] = {
        path: root,
        head: head ?? null,
        branch: branch.success ? branch.stdout.trim() : null,
        dirty_count: dirtyCount,
      };
    }
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
// START
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});
