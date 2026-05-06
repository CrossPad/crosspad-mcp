#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

import { crosspadBuild, crosspadRun } from "./tools/build.js";
import { crosspadBuildCheck } from "./tools/build-check.js";
import { crosspadLog } from "./tools/log.js";
import { crosspadIdfBuild } from "./tools/idf-build.js";
import { crosspadIdfFlash, crosspadIdfOta } from "./tools/idf-flash.js";
import { crosspadIdfMonitor } from "./tools/idf-monitor.js";
import { listDevices } from "./utils/device.js";
import { crosspadTest, crosspadTestScaffold } from "./tools/test.js";
import { crosspadReposStatus } from "./tools/repos.js";
import { crosspadDiffCore } from "./tools/diff-core.js";
import { crosspadSubmoduleUpdate, crosspadCommit } from "./tools/repo-actions.js";
import { crosspadSearchSymbols } from "./tools/symbols.js";
import { crosspadInterfaces, crosspadApps } from "./tools/architecture.js";
import { crosspadScaffoldApp } from "./tools/scaffold.js";
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

const server = new McpServer(
  { name: "crosspad", version },
  { capabilities: { logging: {} } }
);

function makeStreamLogger(logger: string): OnLine {
  return (stream, line) => {
    if (!line.trim()) return;
    const level: LoggingLevel = stream === "stderr" ? "warning" : "info";
    server.server.sendLoggingMessage({ level, logger, data: line }).catch(() => {});
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
  "Build the CrossPad PC simulator (CMake + Ninja). Returns errors[], warnings_count, output_path. Streams progress lines.",
  {
    mode: z.enum(["incremental", "clean", "reconfigure"])
      .default("incremental")
      .describe("incremental: rebuild only what changed (fastest). clean: wipe build dir + reconfigure + build. reconfigure: re-run cmake without wiping."),
  },
  ANN_DESTRUCTIVE,
  async ({ mode }) => {
    const onLine = makeStreamLogger("build_pc");
    return jsonResponse(envelope({ ...(await crosspadBuild(mode, onLine)) }));
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
    return ok({ pid: result.pid, exe_path: result.exe_path });
  }
);

server.tool(
  "crosspad_check_pc",
  "Health check for the PC build — detects stale exe, new sources missing from build system, dirty submodules. Use before crosspad_build_pc to decide if rebuild needed.",
  {},
  ANN_READ_ONLY,
  async () => jsonResponse(envelope({ ...crosspadBuildCheck() }))
);

server.tool(
  "crosspad_log_pc",
  "Run the PC simulator binary, capture stdout+stderr for N seconds, kill it. Use to inspect startup logs without leaving the simulator running.",
  {
    timeout_seconds: TimeoutSec.default(5),
    max_lines: MaxLines.default(200),
  },
  ANN_SIDE_EFFECT,
  async ({ timeout_seconds, max_lines }) => {
    const onLine = makeStreamLogger("log_pc");
    return jsonResponse(envelope({ ...(await crosspadLog(timeout_seconds, max_lines, onLine)) }));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// BUILD — ESP-IDF firmware
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_build_idf",
  "Build CrossPad firmware for ESP32-S3 via idf.py. Auto-detects unregistered apps and escalates to fullclean when needed. Returns errors[], warnings[], tail.",
  {
    mode: z.enum(["build", "fullclean", "clean"])
      .default("build")
      .describe("build: incremental (auto-fullclean if new apps detected). fullclean: idf.py fullclean then build. clean: wipe build dir then build."),
  },
  ANN_DESTRUCTIVE,
  async ({ mode }) => {
    const onLine = makeStreamLogger("build_idf");
    return jsonResponse(envelope({ ...(await crosspadIdfBuild(mode, onLine)) }));
  }
);

server.tool(
  "crosspad_flash_uart",
  "Flash firmware to a connected CrossPad over UART (idf.py flash). Device must be in bootloader mode. Requires prior crosspad_build_idf.",
  {
    port: Port.optional(),
  },
  ANN_DESTRUCTIVE,
  async ({ port }) => {
    const onLine = makeStreamLogger("flash_uart");
    return jsonResponse(envelope({ ...(await crosspadIdfFlash(port, onLine)) }));
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
  async ({ port, firmware_path }) => {
    const onLine = makeStreamLogger("flash_ota");
    return jsonResponse(envelope({ ...(await crosspadIdfOta(port, firmware_path, onLine)) }));
  }
);

server.tool(
  "crosspad_log_idf",
  "Capture serial logs from a connected CrossPad device for N seconds. Uses pyserial (no TTY required).",
  {
    port: Port.optional(),
    timeout_seconds: TimeoutSec.default(10),
    max_lines: MaxLines.default(500),
    filter: z.string().optional()
      .describe("Case-insensitive substring filter. Only lines containing this string are returned."),
  },
  ANN_READ_ONLY,
  async ({ port, timeout_seconds, max_lines, filter }) => {
    const onLine = makeStreamLogger("log_idf");
    return jsonResponse(envelope({ ...(await crosspadIdfMonitor(port, timeout_seconds, max_lines, filter, onLine)) }));
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
  "Build and run the Catch2 test suite for crosspad-pc. Returns passed/failed counts + errors. Configures cmake with BUILD_TESTING=ON automatically.",
  {
    filter: z.string().default("")
      .describe("Catch2 test filter (e.g. '[core]', 'PadManager*'). Empty = run all."),
    list_only: z.boolean().default(false)
      .describe("List discovered tests without running them."),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const,
  async ({ filter, list_only }) => {
    const onLine = makeStreamLogger("test");
    return jsonResponse(envelope({ ...(await crosspadTest(filter, list_only, onLine)) }));
  }
);

server.tool(
  "crosspad_test_scaffold",
  "Generate Catch2 test infrastructure (tests/CMakeLists.txt + sample test). Returns file contents — does NOT write to disk. Caller writes files.",
  {},
  ANN_READ_ONLY,
  async () => jsonResponse({ success: true, ...crosspadTestScaffold() })
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
  "crosspad_pad_press",
  "Press a pad on the simulator (16-pad grid). Send crosspad_pad_release to release.",
  {
    pad: PadIndex,
    velocity: Velocity.default(127),
  },
  ANN_SIDE_EFFECT,
  async ({ pad, velocity }) =>
    jsonResponse(envelope({ ...(await crosspadInput({ action: "pad_press", pad, velocity })) }))
);

server.tool(
  "crosspad_pad_release",
  "Release a previously-pressed pad on the simulator.",
  { pad: PadIndex },
  ANN_SIDE_EFFECT,
  async ({ pad }) =>
    jsonResponse(envelope({ ...(await crosspadInput({ action: "pad_release", pad })) }))
);

server.tool(
  "crosspad_encoder_rotate",
  "Rotate the encoder on the simulator. Positive delta = clockwise.",
  {
    delta: z.number().int().describe("Rotation delta. Positive = clockwise, negative = counter-clockwise. Typical range -10..10."),
  },
  ANN_SIDE_EFFECT,
  async ({ delta }) =>
    jsonResponse(envelope({ ...(await crosspadInput({ action: "encoder_rotate", delta })) }))
);

server.tool(
  "crosspad_encoder_press",
  "Press the encoder button on the simulator.",
  {},
  ANN_SIDE_EFFECT,
  async () => jsonResponse(envelope({ ...(await crosspadInput({ action: "encoder_press" })) }))
);

server.tool(
  "crosspad_encoder_release",
  "Release the encoder button on the simulator.",
  {},
  ANN_SIDE_EFFECT,
  async () => jsonResponse(envelope({ ...(await crosspadInput({ action: "encoder_release" })) }))
);

server.tool(
  "crosspad_click",
  "Click at (x, y) coordinates in the simulator window.",
  {
    x: z.number().int().min(0).describe("X pixel coordinate (window-relative)"),
    y: z.number().int().min(0).describe("Y pixel coordinate (window-relative)"),
  },
  ANN_SIDE_EFFECT,
  async ({ x, y }) =>
    jsonResponse(envelope({ ...(await crosspadInput({ action: "click", x, y })) }))
);

server.tool(
  "crosspad_key",
  "Send a key event to the simulator using an SDL keycode.",
  {
    keycode: z.number().int().describe("SDL keycode (see SDL_keycode.h). E.g. 27=ESC, 32=SPACE, 13=RETURN."),
  },
  ANN_SIDE_EFFECT,
  async ({ keycode }) =>
    jsonResponse(envelope({ ...(await crosspadInput({ action: "key", keycode })) }))
);

// ═══════════════════════════════════════════════════════════════════════
// SIM — MIDI
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_midi_note_on",
  "Send a MIDI note_on event to the simulator.",
  { channel: Channel, note: Note, velocity: Velocity.default(127) },
  ANN_SIDE_EFFECT,
  async ({ channel, note, velocity }) =>
    jsonResponse(envelope({ ...(await crosspadMidiSend({ type: "note_on", channel, note, velocity })) }))
);

server.tool(
  "crosspad_midi_note_off",
  "Send a MIDI note_off event to the simulator.",
  { channel: Channel, note: Note, velocity: Velocity.default(0) },
  ANN_SIDE_EFFECT,
  async ({ channel, note, velocity }) =>
    jsonResponse(envelope({ ...(await crosspadMidiSend({ type: "note_off", channel, note, velocity })) }))
);

server.tool(
  "crosspad_midi_cc",
  "Send a MIDI control change (CC) event to the simulator.",
  { channel: Channel, cc_num: Cc, value: Cc7 },
  ANN_SIDE_EFFECT,
  async ({ channel, cc_num, value }) =>
    jsonResponse(envelope({ ...(await crosspadMidiSend({ type: "cc", channel, cc_num, value })) }))
);

server.tool(
  "crosspad_midi_program_change",
  "Send a MIDI program_change event to the simulator.",
  { channel: Channel, program: Program },
  ANN_SIDE_EFFECT,
  async ({ channel, program }) =>
    jsonResponse(envelope({ ...(await crosspadMidiSend({ type: "program_change", channel, program })) }))
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
  "Git status across all detected CrossPad repos: branch, HEAD, dirty files, submodule sync state.",
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
  "Commit staged changes in a specific repo. Refuses if merge conflicts present. Never pushes. If files[] supplied, stages them first; otherwise commits whatever is currently staged.",
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
  "Search for symbol DEFINITIONS (classes, functions, macros, enums, typedefs) across CrossPad repos via git grep. Substring match: query 'Foo' matches FooBar, MyFoo, etc. Skips usage sites.",
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

server.tool(
  "crosspad_scaffold_app",
  "Generate boilerplate for a new CrossPad app (cpp, hpp, CMakeLists.txt). Returns file contents — does NOT write to disk. Caller writes files.",
  {
    name: z.string().min(1).regex(/^[A-Z][A-Za-z0-9]*$/, "Must be PascalCase (e.g. 'Metronome')")
      .describe("PascalCase app name"),
    display_name: z.string().optional()
      .describe("Human-readable name shown in UI. Defaults to `name`."),
    has_pad_logic: z.boolean().default(false)
      .describe("Generate IPadLogicHandler stub for pad-aware apps."),
    icon: z.string().default("CrossPad_Logo_110w.png")
      .describe("Icon filename (resolved against platform asset prefix)."),
    platform: z.enum(["pc", "idf", "arduino"]).default("pc")
      .describe("Target platform. PC pulls in pc_stubs; idf/arduino do not."),
  },
  ANN_READ_ONLY,
  async ({ name, display_name, has_pad_logic, icon, platform }) =>
    jsonResponse({ success: true, ...crosspadScaffoldApp({ name, display_name, has_pad_logic, icon, platform }) })
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
  async ({ platform, app_name, ref, force }) => {
    const onLine = makeStreamLogger("apps_install");
    return jsonResponse(envelope({ ...(await crosspadAppInstall(app_name, platform, ref, force, onLine)) }));
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
  async ({ platform, app_name }) => {
    const onLine = makeStreamLogger("apps_remove");
    return jsonResponse(envelope({ ...(await crosspadAppRemove(app_name, platform, onLine)) }));
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
  async ({ platform, app_name, update_all }) => {
    const onLine = makeStreamLogger("apps_update");
    return jsonResponse(envelope({ ...(await crosspadAppUpdate(platform, app_name, update_all, onLine)) }));
  }
);

server.tool(
  "crosspad_apps_sync",
  "Sync a platform's apps.json manifest with existing submodules (rebuild manifest from disk state).",
  { platform: Platform },
  ANN_DESTRUCTIVE,
  async ({ platform }) => {
    const onLine = makeStreamLogger("apps_sync");
    return jsonResponse(envelope({ ...(await crosspadAppSync(platform, onLine)) }));
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
