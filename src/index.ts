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
- Building PC sim  → crosspad_check_pc → crosspad_build_pc (NOT raw cmake/ninja). Then crosspad_run_pc; crosspad_kill_pc when done.
- Building firmware→ crosspad_build_idf (NOT raw \`idf.py build\`); crosspad_flash_uart or crosspad_flash_ota.
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

function jsonResponse(data: Record<string, unknown>) {
  const result: { content: Array<{ type: "text"; text: string }>; isError?: boolean } = {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
  if (data.success === false) result.isError = true;
  return result;
}

/** Wrap a result so it always has a `success` field. */
function envelope(data: Record<string, unknown>): Record<string, unknown> {
  if ("success" in data) return data;
  return { success: true, ...data };
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
// BUILD — PC simulator
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_build_pc",
  "Build the CrossPad PC simulator (CMake + Ninja). PREFER THIS over running raw `cmake --build build` — it picks the right MSVC env on Windows, parses errors[], warnings_count, output_path, and streams progress. Returns structured result.",
  {
    mode: z.enum(["incremental", "clean", "reconfigure"])
      .default("incremental")
      .describe("incremental: rebuild only what changed (fastest). clean: wipe build dir + reconfigure + build. reconfigure: re-run cmake without wiping."),
    build_type: z.enum(["Debug", "Release", "RelWithDebInfo"])
      .default("Debug")
      .describe("CMake build type. Only honored on clean/reconfigure (incremental keeps the existing cache)."),
  },
  ANN_DESTRUCTIVE,
  async ({ mode, build_type }, extra: any) => {
    const onLine = makeProgressLogger("build-pc", extra);
    return jsonResponse(envelope({ ...(await crosspadBuild(mode, onLine, build_type, extra.signal)) }));
  }
);

server.tool(
  "crosspad_run_pc",
  "Launch the built PC simulator binary in the background. Returns pid + exe_path. Refuses to spawn a duplicate if a simulator is already responding on port 19840 (use force=true to override). Fails if binary not built — call crosspad_build_pc first.",
  {
    force: z.boolean().default(false)
      .describe("Spawn another instance even if one is already running. Default: false."),
  },
  ANN_SIDE_EFFECT,
  async ({ force }) => {
    const result = await crosspadRun(force);
    if (result.already_running) {
      return err(result.error ?? "Simulator already running.", { exe_path: result.exe_path, already_running: true });
    }
    if (result.pid === null) {
      return err(`Binary not found: ${result.exe_path}. Run crosspad_build_pc first.`, { exe_path: result.exe_path });
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

server.tool(
  "crosspad_kill_pc",
  "Stop the running PC simulator. Sends SIGTERM to processes named 'CrossPad'. Returns the killed PIDs and whether the TCP control port stopped responding.",
  {},
  ANN_DESTRUCTIVE,
  async () => jsonResponse(envelope({ ...(await crosspadKill()) }))
);

server.tool(
  "crosspad_check_pc",
  "Health check for the PC build — detects stale exe, new sources missing from build system, dirty submodules. Use before crosspad_build_pc to decide if rebuild needed.",
  {},
  ANN_READ_ONLY,
  async () => jsonResponse(envelope({ ...crosspadBuildCheck() }))
);


// ═══════════════════════════════════════════════════════════════════════
// BUILD — ESP-IDF firmware
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_build_idf",
  "Build CrossPad firmware for ESP32-S3 via idf.py. PREFER THIS over running raw `idf.py build` — it sources the IDF env automatically, auto-detects unregistered apps and escalates to fullclean when needed, and parses errors[], warnings[], tail into structured output.",
  {
    mode: z.enum(["build", "fullclean", "clean"])
      .default("build")
      .describe("build: incremental (auto-fullclean if new apps detected). fullclean: idf.py fullclean then build. clean: wipe build dir then build."),
  },
  ANN_DESTRUCTIVE,
  async ({ mode }, extra: any) => {
    const onLine = makeProgressLogger("build-idf", extra);
    return jsonResponse(envelope({ ...(await crosspadIdfBuild(mode, onLine, extra.signal)) }));
  }
);

server.tool(
  "crosspad_flash_uart",
  "Flash firmware to a connected CrossPad over UART (idf.py flash). Device must be in bootloader mode. Requires prior crosspad_build_idf.",
  {
    port: Port.optional(),
  },
  ANN_DESTRUCTIVE,
  async ({ port }, extra: any) => {
    const onLine = makeProgressLogger("flash-uart", extra);
    return jsonResponse(envelope({ ...(await crosspadIdfFlash(port, onLine, extra.signal)) }));
  }
);

server.tool(
  "crosspad_flash_ota",
  "Flash firmware via OTA over USB CDC (no bootloader mode required). Uses platform-idf/tools/ota_flash.py. Requires prior crosspad_build_idf.",
  {
    port: Port.optional(),
    firmware_path: z.string().optional()
      .describe("Custom firmware binary path. Defaults to <idf-root>/build/CrossPad.bin."),
  },
  ANN_DESTRUCTIVE,
  async ({ port, firmware_path }, extra: any) => {
    const onLine = makeProgressLogger("flash-ota", extra);
    return jsonResponse(envelope({ ...(await crosspadIdfOta(port, firmware_path, onLine, extra.signal)) }));
  }
);

server.tool(
  "crosspad_log",
  "Capture logs from PC simulator (target='pc': spawn binary, capture stdout/stderr, kill) or connected ESP32-S3 device (target='idf': read serial via pyserial, no TTY needed). Consolidated tool — replaces crosspad_log_pc and crosspad_log_idf in v6.",
  {
    target: z.enum(["pc", "idf"]).describe("'pc' = run + capture sim binary; 'idf' = read serial from connected device."),
    port: Port.optional().describe("Serial port (idf only). Auto-detected if omitted; required when multiple devices connected."),
    timeout_seconds: TimeoutSec.optional().describe("Capture duration. Defaults: 5s for pc, 10s for idf."),
    max_lines: MaxLines.optional().describe("Max output lines. Defaults: 200 for pc, 500 for idf."),
    filter: z.string().optional()
      .describe("Case-insensitive substring filter (idf only). Only lines containing this string are returned."),
  },
  ANN_READ_ONLY,
  async ({ target, port, timeout_seconds, max_lines, filter }, extra: any) => {
    if (target === "pc") {
      if (port) return err("Field 'port' is not used when target='pc'.");
      if (filter) return err("Field 'filter' is not used when target='pc'.");
      const onLine = makeProgressLogger("log-pc", extra);
      return jsonResponse(envelope({
        ...(await crosspadLog(timeout_seconds ?? 5, max_lines ?? 200, onLine, extra.signal)),
      }));
    }
    // target === "idf"
    const onLine = makeProgressLogger("log-idf", extra);
    return jsonResponse(envelope({
      ...(await crosspadIdfMonitor(port, timeout_seconds ?? 10, max_lines ?? 500, filter, onLine, extra.signal)),
    }));
  }
);

server.tool(
  "crosspad_devices",
  "List all connected USB serial devices. Identifies CrossPad devices (Espressif VID 0x303a, PID 0x3456) separately from other ports.",
  {},
  ANN_READ_ONLY,
  async () => jsonResponse(envelope({ ...listDevices() }))
);

// ═══════════════════════════════════════════════════════════════════════
// TEST
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_test_run",
  "Build and run the Catch2 test suite for crosspad-pc. PREFER THIS over invoking the test binary directly — configures cmake with BUILD_TESTING=ON, parses Catch2 output into passed/failed counts and errors, supports filter and list_only.",
  {
    filter: z.string().default("")
      .describe("Catch2 test filter (e.g. '[core]', 'PadManager*'). Empty = run all."),
    list_only: z.boolean().default(false)
      .describe("List discovered tests without running them."),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const,
  async ({ filter, list_only }, extra: any) => {
    const onLine = makeProgressLogger("test", extra);
    return jsonResponse(envelope({ ...(await crosspadTest(filter, list_only, onLine, extra.signal)) }));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — screenshot
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_screenshot",
  "Capture a PNG screenshot from the running PC simulator. By default saves to disk and returns the file_path. Set return_inline=true for inline image content (consumes more tokens).",
  {
    filename: z.string().optional()
      .describe("Custom filename (saved under <crosspad-pc>/screenshots/). Default: screenshot_<timestamp>.png"),
    return_inline: z.boolean().default(false)
      .describe("If true, returns inline base64 image content instead of file_path. Use only when the image is needed in-conversation."),
  },
  ANN_SIDE_EFFECT,
  async ({ filename, return_inline }) => {
    const result = await crosspadScreenshot(!return_inline, filename);
    if (!result.success) return jsonResponse({ ...result });

    if (return_inline) {
      // Inline path — simulator returned base64 directly
      if (result.data_base64) {
        return {
          content: [
            { type: "image" as const, data: result.data_base64, mimeType: "image/png" },
            { type: "text" as const, text: JSON.stringify({ success: true, width: result.width, height: result.height, format: result.format }, null, 2) },
          ],
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

server.tool(
  "crosspad_input",
  "Send a single input event to the running PC simulator (consolidated tool — replaces 7 separate tools in v6). Required fields depend on `action`: pad_press={pad,velocity?} · pad_release={pad} · encoder_rotate={delta} · encoder_press / encoder_release={} · click={x,y} · key={keycode}. The simulator validates and rejects bad combinations.",
  {
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
  ANN_SIDE_EFFECT,
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
    return jsonResponse(envelope({ ...(await crosspadInput(params)) }));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — MIDI
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_midi",
  "Send a single MIDI event to the running simulator (consolidated tool — replaces 4 separate tools in v6). Required fields depend on `type`: note_on/note_off={note,velocity?} · cc={cc_num,value} · program_change={program}.",
  {
    type: z.enum(["note_on", "note_off", "cc", "program_change"])
      .describe("MIDI event type."),
    channel: Channel,
    note: Note.optional().describe("MIDI note number (note_on, note_off)."),
    velocity: Velocity.optional().describe("Velocity (note_on default 127, note_off default 0)."),
    cc_num: Cc.optional().describe("Controller number (cc)."),
    value: Cc7.optional().describe("Controller value (cc)."),
    program: Program.optional().describe("Program number (program_change)."),
  },
  ANN_SIDE_EFFECT,
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

    return jsonResponse(envelope({
      ...(await crosspadMidiSend({
        type,
        channel,
        note,
        velocity: velocity ?? (type === "note_off" ? 0 : type === "note_on" ? 127 : undefined),
        cc_num,
        value,
        program,
      })),
    }));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — runtime state
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_stats",
  "Read runtime statistics from the running PC simulator: pad state, capabilities, heap, registered apps, active pad logic.",
  {},
  ANN_READ_ONLY,
  async () => jsonResponse(envelope({ ...(await crosspadStats()) }))
);

server.tool(
  "crosspad_settings_get",
  "Read settings from the running simulator.",
  {
    category: z.enum(["all", "display", "keypad", "vibration", "wireless", "audio", "system"])
      .default("all")
      .describe("Settings category. Use 'all' to fetch everything."),
  },
  ANN_READ_ONLY,
  async ({ category }) => jsonResponse(envelope({ ...(await crosspadSettingsGet(category)) }))
);

server.tool(
  "crosspad_settings_set",
  "Write a single setting on the running simulator.",
  {
    key: z.string().min(1)
      .describe("Setting key (e.g. 'lcd_brightness', 'keypad.eco_mode', 'vibration.enable')"),
    value: z.number()
      .describe("Numeric value. Booleans: 0=false, 1=true."),
  },
  ANN_DESTRUCTIVE,
  async ({ key, value }) => jsonResponse(envelope({ ...(await crosspadSettingsSet(key, value)) }))
);

// ═══════════════════════════════════════════════════════════════════════
// REPO — read-only
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_repo_status",
  "Git status across ALL detected CrossPad repos in one call: branch, HEAD, dirty files, submodule sync state. PREFER THIS over running `git status` per repo — handles the 5-repo monorepo layout in one shot.",
  {},
  ANN_READ_ONLY,
  async () => jsonResponse({ success: true, ...crosspadReposStatus() })
);

server.tool(
  "crosspad_repo_diff",
  "Show submodule drift in a parent repo (crosspad-pc or platform-idf): commits ahead/behind pinned, changed files, uncommitted work. Use to inspect dev-mode work before pinning.",
  {
    submodule: z.enum(["crosspad-core", "crosspad-gui", "both"]).default("both")
      .describe("Which submodule to inspect."),
    parent: z.enum(["crosspad-pc", "platform-idf"]).default("crosspad-pc")
      .describe("Parent repo containing the submodule. Defaults to crosspad-pc."),
  },
  ANN_READ_ONLY,
  async ({ submodule, parent }) =>
    jsonResponse({ success: true, ...crosspadDiffCore(submodule, parent) })
);

// ═══════════════════════════════════════════════════════════════════════
// REPO — mutations
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_submodule_update",
  "Update a submodule in a parent repo to the latest commit on a tracking branch (git fetch + checkout origin/<branch> + stage). Destructive: discards local commits in the submodule that aren't on the remote branch.",
  {
    submodule: Submodule,
    repo: RepoAlias.describe("Parent repo containing the submodule (idf, pc, arduino, or full name)"),
    branch: GitRef.default("main").describe("Remote branch to track (e.g. main, develop)"),
  },
  ANN_DESTRUCTIVE_OPEN,
  async ({ submodule, repo, branch }) =>
    jsonResponse(envelope({ ...crosspadSubmoduleUpdate(submodule, repo, branch) }))
);

server.tool(
  "crosspad_commit",
  "Commit staged changes in a specific CrossPad repo. PREFER THIS over raw `git commit` — handles repo aliases (idf/pc/arduino/core/gui), refuses on merge conflicts, uses 0600 tempfiles for messages (no shell-quoting issues with quotes/newlines/backticks), and never pushes. Stages files[] first if supplied.",
  {
    repo: RepoAlias,
    message: z.string().min(1).describe("Commit message"),
    files: z.array(z.string()).optional()
      .describe("Specific files to stage+commit. Omit to commit currently-staged changes."),
  },
  ANN_DESTRUCTIVE,
  async ({ repo, message, files }) =>
    jsonResponse(envelope({ ...crosspadCommit(repo, message, files) }))
);

// ═══════════════════════════════════════════════════════════════════════
// CODE — search and analysis
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_search_symbols",
  "Search for symbol DEFINITIONS (classes, functions, macros, enums, typedefs) across CrossPad repos via git grep. PREFER THIS over raw `grep -r` or `git grep` — it filters to definitions only (skips call sites/declarations), classifies kind, and aggregates across all 5 repos automatically. Substring match: 'Foo' matches FooBar, MyFoo.",
  {
    query: z.string().min(1).describe("Symbol name (substring match, case-insensitive on filter)"),
    kind: z.enum(["class", "function", "macro", "enum", "typedef", "all"]).default("all"),
    repos: z.array(z.string()).default(["all"])
      .describe("Repo names to scan, or ['all']. Names: crosspad-core, crosspad-gui, crosspad-pc, platform-idf, ESP32-S3."),
    max_results: z.number().int().min(1).max(500).default(50),
    context_lines: z.number().int().min(0).max(10).default(0)
      .describe("Surrounding lines per match (like grep -C). 0 = no context."),
  },
  ANN_READ_ONLY,
  async ({ query, kind, repos, max_results, context_lines }) =>
    jsonResponse({ success: true, ...crosspadSearchSymbols(query, kind, repos, max_results, context_lines) })
);

server.tool(
  "crosspad_list_interfaces",
  "List all crosspad-core interfaces (I*-prefixed classes in crosspad-core/include/crosspad/).",
  {},
  ANN_READ_ONLY,
  async () => jsonResponse({ success: true, ...crosspadInterfaces("list") })
);

server.tool(
  "crosspad_interface_implementations",
  "Find all classes implementing a given interface across CrossPad repos. Returns className, file path, platform.",
  {
    interface_name: z.string().min(1).describe("Interface name (e.g. 'IDisplay', 'IPadLogicHandler')"),
  },
  ANN_READ_ONLY,
  async ({ interface_name }) =>
    jsonResponse({ success: true, ...crosspadInterfaces(`implementations ${interface_name}`) })
);

server.tool(
  "crosspad_capabilities",
  "List platform capability flags (Capability enum) and which capabilities each platform sets.",
  {},
  ANN_READ_ONLY,
  async () => jsonResponse({ success: true, ...crosspadInterfaces("capabilities") })
);

server.tool(
  "crosspad_list_apps_source",
  "List apps registered via REGISTER_APP() macro by scanning source files. Different from crosspad_apps_list (which reads the package registry).",
  {
    platform: z.enum(["pc", "idf", "arduino", "all"]).default("all"),
  },
  ANN_READ_ONLY,
  async ({ platform }) =>
    jsonResponse({ success: true, apps: crosspadApps(platform) })
);

// ═══════════════════════════════════════════════════════════════════════
// APPS — package manager (crosspad-apps registry)
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_apps_list",
  "List apps from the crosspad-apps registry, aggregating installation status across all detected platform repos. Reads JSON; no Python required.",
  {
    show_all: z.boolean().default(false)
      .describe("Include apps incompatible with detected platforms."),
  },
  ANN_READ_OPEN,
  async ({ show_all }) =>
    jsonResponse(envelope({ ...crosspadAppList(show_all) }))
);

server.tool(
  "crosspad_apps_install",
  "Install an app from the crosspad-apps registry as a git submodule. Requires gh CLI authenticated. Delegates to <repo>/{tools|scripts}/app_manager.py.",
  {
    platform: Platform,
    app_name: AppName.describe("App ID from registry (e.g. 'metronome')"),
    ref: GitRef.default("main").describe("Git ref (branch, tag, or commit SHA)"),
    force: z.boolean().default(false).describe("Install even if marked incompatible."),
  },
  ANN_DESTRUCTIVE_OPEN,
  async ({ platform, app_name, ref, force }, extra: any) => {
    const onLine = makeProgressLogger("apps-install", extra);
    return jsonResponse(envelope({ ...(await crosspadAppInstall(app_name, platform, ref, force, onLine, extra.signal)) }));
  }
);

server.tool(
  "crosspad_apps_remove",
  "Remove an installed app submodule from a platform repo. Delegates to app_manager.py.",
  {
    platform: Platform,
    app_name: AppName,
  },
  ANN_DESTRUCTIVE,
  async ({ platform, app_name }, extra: any) => {
    const onLine = makeProgressLogger("apps-remove", extra);
    return jsonResponse(envelope({ ...(await crosspadAppRemove(app_name, platform, onLine, extra.signal)) }));
  }
);

server.tool(
  "crosspad_apps_update",
  "Update one or all installed apps on a platform. Specify app_name OR set update_all=true.",
  {
    platform: Platform,
    app_name: AppName.optional().describe("App ID to update. Required unless update_all=true."),
    update_all: z.boolean().default(false),
  },
  ANN_DESTRUCTIVE_OPEN,
  async ({ platform, app_name, update_all }, extra: any) => {
    const onLine = makeProgressLogger("apps-update", extra);
    return jsonResponse(envelope({ ...(await crosspadAppUpdate(platform, app_name, update_all, onLine, extra.signal)) }));
  }
);

server.tool(
  "crosspad_apps_sync",
  "Sync a platform's apps.json manifest with existing submodules (rebuild manifest from disk state).",
  { platform: Platform },
  ANN_DESTRUCTIVE,
  async ({ platform }, extra: any) => {
    const onLine = makeProgressLogger("apps-sync", extra);
    return jsonResponse(envelope({ ...(await crosspadAppSync(platform, onLine, extra.signal)) }));
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
