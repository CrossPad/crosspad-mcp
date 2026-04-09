#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// Tool implementations
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
import { crosspadInput, InputAction } from "./tools/input.js";
import { crosspadStats } from "./tools/stats.js";
import { crosspadSettingsGet, crosspadSettingsSet } from "./tools/settings.js";
import { crosspadMidiSend, MidiEventType } from "./tools/midi.js";
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

function jsonResponse(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ═══════════════════════════════════════════════════════════════════════
// TOOL 1: crosspad_build
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_build",
  "Build, run, flash, or monitor CrossPad — PC simulator and ESP-IDF firmware. Supports multiple connected devices.",
  {
    action: z.enum(["pc", "pc_run", "pc_check", "pc_log", "idf", "idf_flash", "idf_ota", "idf_monitor", "devices"])
      .describe("pc: build simulator. pc_run: launch exe. pc_check: build health check. pc_log: capture stdout. idf: build ESP-IDF firmware. idf_flash: flash via UART. idf_ota: flash via OTA CDC. idf_monitor: capture serial logs. devices: list connected CrossPad devices."),
    mode: z.enum(["incremental", "clean", "reconfigure", "fullclean"]).default("incremental")
      .describe("Build mode (pc: incremental/clean/reconfigure, idf: build/fullclean/clean)").optional(),
    port: z.string().optional()
      .describe("idf_flash/idf_ota/idf_monitor: serial port (auto-detect if omitted, required when multiple devices connected)"),
    firmware_path: z.string().optional()
      .describe("idf_ota: custom firmware binary path (default: build/CrossPad.bin)"),
    timeout_seconds: z.number().default(5).optional()
      .describe("pc_log/idf_monitor: capture duration in seconds"),
    max_lines: z.number().default(200).optional()
      .describe("pc_log/idf_monitor: max output lines"),
    filter: z.string().optional()
      .describe("idf_monitor: only return lines containing this string"),
  },
  async ({ action, mode, port, firmware_path, timeout_seconds, max_lines, filter }) => {
    const onLine = makeStreamLogger("build");

    switch (action) {
      case "pc": {
        const m = (mode === "fullclean" ? "clean" : mode ?? "incremental") as "incremental" | "clean" | "reconfigure";
        return jsonResponse(await crosspadBuild(m, onLine));
      }
      case "pc_run":
        return jsonResponse(crosspadRun());
      case "pc_check":
        return jsonResponse(crosspadBuildCheck());
      case "pc_log":
        return jsonResponse(await crosspadLog(timeout_seconds ?? 5, max_lines ?? 200, onLine));
      case "idf": {
        const m = (mode === "reconfigure" ? "build" : mode ?? "build") as "build" | "fullclean" | "clean";
        return jsonResponse(await crosspadIdfBuild(m, onLine));
      }
      case "idf_flash":
        return jsonResponse(await crosspadIdfFlash(port, onLine));
      case "idf_ota":
        return jsonResponse(await crosspadIdfOta(port, firmware_path, onLine));
      case "idf_monitor":
        return jsonResponse(await crosspadIdfMonitor(port, timeout_seconds ?? 10, max_lines ?? 500, filter, onLine));
      case "devices":
        return jsonResponse(listDevices());
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TOOL 2: crosspad_test
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_test",
  "Run Catch2 tests or scaffold test infrastructure for crosspad-pc.",
  {
    action: z.enum(["run", "scaffold"])
      .describe("run: build + run tests. scaffold: generate test boilerplate."),
    filter: z.string().default("").optional()
      .describe("Catch2 test name filter (e.g. '[core]')"),
    list_only: z.boolean().default(false).optional()
      .describe("List tests without running"),
  },
  async ({ action, filter, list_only }) => {
    if (action === "scaffold") {
      return jsonResponse(crosspadTestScaffold());
    }
    const onLine = makeStreamLogger("test");
    return jsonResponse(await crosspadTest(filter ?? "", list_only ?? false, onLine));
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TOOL 3: crosspad_sim
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_sim",
  "Interact with the running simulator: screenshots, input, MIDI, stats, settings.",
  {
    action: z.enum(["screenshot", "input", "midi_send", "stats", "settings_get", "settings_set"])
      .describe("screenshot: capture PNG. input: send event. midi_send: send MIDI to simulator. stats: runtime diagnostics. settings_get/set: read/write settings."),
    // screenshot params
    region: z.enum(["full", "lcd"]).default("full").optional()
      .describe("screenshot: full window or LCD only"),
    filename: z.string().optional()
      .describe("screenshot: custom filename"),
    save_to_file: z.boolean().default(true).optional()
      .describe("screenshot: save to disk (default) or return base64"),
    // input params
    input_action: z.enum(["click", "pad_press", "pad_release", "encoder_rotate", "encoder_press", "encoder_release", "key"]).optional()
      .describe("input: event type"),
    x: z.number().optional().describe("input click: X coordinate"),
    y: z.number().optional().describe("input click: Y coordinate"),
    pad: z.number().optional().describe("input pad: index 0-15"),
    velocity: z.number().optional().describe("input pad_press: velocity 0-127"),
    delta: z.number().optional().describe("input encoder_rotate: rotation delta"),
    keycode: z.number().optional().describe("input key: SDL keycode"),
    // midi params
    midi_type: z.enum(["note_on", "note_off", "cc", "program_change"]).optional()
      .describe("midi_send: MIDI event type"),
    channel: z.number().default(0).optional()
      .describe("midi_send: MIDI channel 0-15"),
    note: z.number().optional()
      .describe("midi_send: note number 0-127 (note_on/note_off)"),
    cc_num: z.number().optional()
      .describe("midi_send: CC number 0-127 (cc)"),
    midi_value: z.number().optional()
      .describe("midi_send: value 0-127 (cc value or program number)"),
    // settings params
    category: z.string().default("all").optional()
      .describe("settings_get: all/display/keypad/vibration/wireless/audio/system"),
    key: z.string().optional()
      .describe("settings_set: dotted key name (e.g. 'lcd_brightness')"),
    value: z.number().optional()
      .describe("settings_set: numeric value"),
  },
  async ({ action, region, filename, save_to_file, input_action, x, y, pad, velocity, delta, keycode, midi_type, channel, note, cc_num, midi_value, category, key, value }) => {
    switch (action) {
      case "screenshot": {
        const result = await crosspadScreenshot(save_to_file ?? true, filename);
        if (result.success) {
          let imageData: string | undefined = result.data_base64;
          // Read from file if saved to disk
          if (!imageData && result.file_path) {
            try {
              imageData = fs.readFileSync(result.file_path).toString("base64");
            } catch { /* fall through to JSON response */ }
          }
          if (imageData) {
            return {
              content: [
                { type: "image" as const, data: imageData, mimeType: "image/png" },
                { type: "text" as const, text: JSON.stringify({ success: true, width: result.width, height: result.height, format: result.format, file_path: result.file_path }, null, 2) },
              ],
            };
          }
        }
        return jsonResponse(result);
      }

      case "input": {
        if (!input_action) {
          return jsonResponse({ success: false, error: "input_action is required for action=input" });
        }
        let input: InputAction;
        switch (input_action) {
          case "click": input = { action: "click", x: x ?? 0, y: y ?? 0 }; break;
          case "pad_press": input = { action: "pad_press", pad: pad ?? 0, velocity: velocity ?? 127 }; break;
          case "pad_release": input = { action: "pad_release", pad: pad ?? 0 }; break;
          case "encoder_rotate": input = { action: "encoder_rotate", delta: delta ?? 1 }; break;
          case "encoder_press": input = { action: "encoder_press" }; break;
          case "encoder_release": input = { action: "encoder_release" }; break;
          case "key": input = { action: "key", keycode: keycode ?? 0 }; break;
        }
        return jsonResponse(await crosspadInput(input));
      }

      case "midi_send": {
        if (!midi_type) {
          return jsonResponse({ success: false, error: "midi_type is required for action=midi_send" });
        }
        return jsonResponse(await crosspadMidiSend({
          type: midi_type as MidiEventType,
          channel: channel ?? 0,
          note,
          velocity,
          cc_num,
          value: midi_value,
          program: midi_value,
        }));
      }

      case "stats":
        return jsonResponse(await crosspadStats());

      case "settings_get":
        return jsonResponse(await crosspadSettingsGet(category ?? "all"));

      case "settings_set": {
        if (!key || value === undefined) {
          return jsonResponse({ success: false, error: "key and value required for settings_set" });
        }
        return jsonResponse(await crosspadSettingsSet(key, value));
      }
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TOOL 4: crosspad_repo
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_repo",
  "Git status, submodule diffs, submodule updates, and commits across CrossPad repos.",
  {
    action: z.enum(["status", "diff", "submodule_update", "commit"])
      .describe("status: git status all repos. diff: submodule drift. submodule_update: pull latest submodule. commit: commit staged changes."),
    submodule: z.enum(["crosspad-core", "crosspad-gui", "crosspad-instructions", "crosspad-sampler", "both"]).default("both").optional()
      .describe("diff/submodule_update: which submodule"),
    repo: z.string().optional()
      .describe("submodule_update/commit: target repo (idf, pc, arduino, core, gui, or full name)"),
    branch: z.string().default("main").optional()
      .describe("submodule_update: remote branch to checkout (default: main)"),
    message: z.string().optional()
      .describe("commit: commit message"),
    files: z.array(z.string()).optional()
      .describe("commit: specific files to stage+commit (omit to commit what's staged)"),
  },
  async ({ action, submodule, repo, branch, message, files }) => {
    switch (action) {
      case "status":
        return jsonResponse(crosspadReposStatus());
      case "diff":
        return jsonResponse(crosspadDiffCore(submodule === "both" ? "both" : submodule as "crosspad-core" | "crosspad-gui" ?? "both"));
      case "submodule_update": {
        if (!submodule || submodule === "both") {
          return jsonResponse({ error: "Specify a single submodule (e.g. crosspad-core)" });
        }
        if (!repo) {
          return jsonResponse({ error: "repo is required for submodule_update (e.g. idf, pc, arduino)" });
        }
        return jsonResponse(crosspadSubmoduleUpdate(submodule, repo, branch ?? "main"));
      }
      case "commit": {
        if (!repo) {
          return jsonResponse({ error: "repo is required for commit" });
        }
        if (!message) {
          return jsonResponse({ error: "message is required for commit" });
        }
        return jsonResponse(crosspadCommit(repo, message, files));
      }
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TOOL 5: crosspad_code
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_code",
  "Search symbols, query interfaces, list registered apps, or scaffold new apps across CrossPad repos.",
  {
    action: z.enum(["search", "interfaces", "apps", "scaffold"])
      .describe("search: find classes/functions/macros. interfaces: query crosspad-core interfaces. apps: list REGISTER_APP registrations. scaffold: generate app boilerplate."),
    // search params
    query: z.string().optional()
      .describe("search: symbol name. interfaces: 'list', 'implementations <Name>', or 'capabilities'."),
    kind: z.enum(["class", "function", "macro", "enum", "typedef", "all"]).default("all").optional()
      .describe("search: filter by symbol kind"),
    repos: z.array(z.string()).default(["all"]).optional()
      .describe("search: repo names to scan, or ['all']"),
    max_results: z.number().default(50).optional()
      .describe("search: result cap"),
    context_lines: z.number().default(0).optional()
      .describe("search: lines of surrounding context (0-10, like grep -C)"),
    // apps params
    platform: z.enum(["pc", "idf", "arduino", "all"]).default("all").optional()
      .describe("apps: platform to scan"),
    // scaffold params
    name: z.string().optional()
      .describe("scaffold: PascalCase app name"),
    display_name: z.string().optional()
      .describe("scaffold: human-readable name"),
    has_pad_logic: z.boolean().default(false).optional()
      .describe("scaffold: generate IPadLogicHandler stub"),
    icon: z.string().default("CrossPad_Logo_110w.png").optional()
      .describe("scaffold: icon filename"),
  },
  async ({ action, query, kind, repos, max_results, context_lines, platform, name, display_name, has_pad_logic, icon }) => {
    switch (action) {
      case "search": {
        if (!query) return jsonResponse({ error: "query is required for action=search" });
        return jsonResponse(crosspadSearchSymbols(query, kind ?? "all", repos ?? ["all"], max_results ?? 50, context_lines ?? 0));
      }
      case "interfaces": {
        return jsonResponse(crosspadInterfaces(query ?? "list"));
      }
      case "apps":
        return jsonResponse(crosspadApps(platform ?? "all"));
      case "scaffold": {
        if (!name) return jsonResponse({ error: "name is required for action=scaffold" });
        return jsonResponse(crosspadScaffoldApp({ name, display_name, has_pad_logic: has_pad_logic ?? false, icon: icon ?? "CrossPad_Logo_110w.png" }));
      }
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TOOL 6: crosspad_apps
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_apps",
  "Manage CrossPad app packages: list, install, remove, update from the crosspad-apps registry. List aggregates status across all detected repos (idf, pc, arduino).",
  {
    action: z.enum(["list", "install", "remove", "update", "sync"])
      .describe("list: available apps + where installed. install: add app submodule. remove: remove app. update: update app(s). sync: sync manifest."),
    platform: z.enum(["idf", "pc", "arduino"]).optional()
      .describe("install/remove/update/sync: target platform repo (required for mutations)"),
    app_name: z.string().optional()
      .describe("install/remove/update: app ID from registry"),
    ref: z.string().default("main").optional()
      .describe("install: git ref (branch/tag/commit)"),
    force: z.boolean().default(false).optional()
      .describe("install: install even if incompatible"),
    update_all: z.boolean().default(false).optional()
      .describe("update: update all installed apps"),
    show_all: z.boolean().default(false).optional()
      .describe("list: include incompatible apps"),
  },
  async ({ action, platform, app_name, ref, force, update_all, show_all }) => {
    const onLine = makeStreamLogger("app-manager");

    switch (action) {
      case "list":
        return jsonResponse(crosspadAppList(show_all ?? false));

      case "install": {
        if (!app_name) return jsonResponse({ success: false, error: "app_name required" });
        if (!platform) return jsonResponse({ success: false, error: "platform required for install (idf, pc, or arduino)" });
        return jsonResponse(await crosspadAppInstall(app_name, platform, ref ?? "main", force ?? false, onLine));
      }

      case "remove": {
        if (!app_name) return jsonResponse({ success: false, error: "app_name required" });
        if (!platform) return jsonResponse({ success: false, error: "platform required for remove (idf, pc, or arduino)" });
        return jsonResponse(await crosspadAppRemove(app_name, platform, onLine));
      }

      case "update": {
        if (!platform) return jsonResponse({ success: false, error: "platform required for update (idf, pc, or arduino)" });
        return jsonResponse(await crosspadAppUpdate(platform, app_name, update_all ?? false, onLine));
      }

      case "sync": {
        if (!platform) return jsonResponse({ success: false, error: "platform required for sync (idf, pc, or arduino)" });
        return jsonResponse(await crosspadAppSync(platform, onLine));
      }
    }
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
