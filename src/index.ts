#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { crosspadBuild, crosspadRun } from "./tools/build.js";
import { crosspadReposStatus } from "./tools/repos.js";
import { crosspadScaffoldApp } from "./tools/scaffold.js";
import { crosspadInterfaces, crosspadApps } from "./tools/architecture.js";
import { crosspadBuildCheck } from "./tools/build-check.js";
import { crosspadSearchSymbols } from "./tools/symbols.js";
import { crosspadDiffCore } from "./tools/diff-core.js";
import { crosspadLog } from "./tools/log.js";
import { crosspadTest, crosspadTestScaffold } from "./tools/test.js";
import { crosspadScreenshot } from "./tools/screenshot.js";
import { crosspadInput, InputAction } from "./tools/input.js";
import { crosspadSettingsGet, crosspadSettingsSet } from "./tools/settings.js";
import { crosspadStats } from "./tools/stats.js";
import type { OnLine } from "./utils/exec.js";
import type { LoggingLevel } from "@modelcontextprotocol/sdk/types.js";

const server = new McpServer(
  {
    name: "crosspad",
    version: "4.0.0",
  },
  {
    capabilities: {
      logging: {},
    },
  }
);

/**
 * Create an OnLine callback that streams each line to the MCP client
 * via logging notifications. Build output is "info", errors are "error".
 */
function makeStreamLogger(logger: string): OnLine {
  return (stream, line) => {
    if (!line.trim()) return; // skip empty lines
    const level: LoggingLevel = stream === "stderr" ? "warning" : "info";
    server.server.sendLoggingMessage({ level, logger, data: line }).catch(() => {});
  };
}

// ═══════════════════════════════════════════════════════════════════════
// BUILD & RUN
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_build",
  "Build crosspad-pc simulator (incremental, clean, or reconfigure)",
  {
    mode: z
      .enum(["incremental", "clean", "reconfigure"])
      .default("incremental")
      .describe(
        "incremental: just cmake --build. clean: delete build dir + full rebuild. reconfigure: cmake configure + build (use after adding new source files)"
      ),
  },
  async ({ mode }) => {
    const onLine = makeStreamLogger("build");
    const result = await crosspadBuild(mode, onLine);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_run",
  "Launch the crosspad-pc simulator (bin/main.exe). Returns immediately with PID.",
  {},
  async () => {
    const result = crosspadRun();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_build_check",
  "Quick health check: is the build up to date? Detects stale exe, new source files needing reconfigure, submodule drift, dirty working trees. Use before build to know what mode to use.",
  {},
  async () => {
    const result = crosspadBuildCheck();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_log",
  "Launch main.exe, capture stdout/stderr for a few seconds, then kill it. Great for checking init sequence, crash messages, or runtime errors without leaving the process running.",
  {
    timeout_seconds: z
      .number()
      .default(5)
      .describe("How long to let the process run before killing it (default: 5)"),
    max_lines: z
      .number()
      .default(200)
      .describe("Max lines of output to return (default: 200)"),
  },
  async ({ timeout_seconds, max_lines }) => {
    const onLine = makeStreamLogger("log");
    const result = await crosspadLog(timeout_seconds, max_lines, onLine);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// TEST
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_test",
  "Build and run the Catch2 test suite. If no tests/ dir exists, tells you to scaffold. Supports filtering by test name.",
  {
    filter: z
      .string()
      .default("")
      .describe("Catch2 test name filter (e.g. '[core]' or 'PadManager')"),
    list_only: z
      .boolean()
      .default(false)
      .describe("Just list available tests without running them"),
  },
  async ({ filter, list_only }) => {
    const onLine = makeStreamLogger("test");
    const result = await crosspadTest(filter, list_only, onLine);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_test_scaffold",
  "Generate test infrastructure: tests/CMakeLists.txt (Catch2 v3), sample test file, and CMake patch instructions. Returns file contents — does NOT write to disk.",
  {},
  async () => {
    const result = crosspadTestScaffold();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// REPOS & SUBMODULES
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_repos_status",
  "Show git status across all CrossPad repos (crosspad-core, crosspad-gui, crosspad-pc, ESP32-S3, 2playerCrosspad). Detects dev-mode vs submodule-mode and checks submodule pin sync.",
  {},
  async () => {
    const result = crosspadReposStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_diff_core",
  "Show what changed in crosspad-core and/or crosspad-gui relative to the pinned submodule commit. Shows commits ahead/behind, changed files, uncommitted changes. Essential for dev-mode workflows.",
  {
    submodule: z
      .enum(["crosspad-core", "crosspad-gui", "both"])
      .default("both")
      .describe("Which submodule(s) to diff"),
  },
  async ({ submodule }) => {
    const result = crosspadDiffCore(submodule);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// CODE & ARCHITECTURE
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_search_symbols",
  "Search for classes, functions, macros, enums across all CrossPad repos. Faster than manual grep — uses git grep under the hood.",
  {
    query: z.string().describe("Symbol name or substring to search for"),
    kind: z
      .enum(["class", "function", "macro", "enum", "typedef", "all"])
      .default("all")
      .describe("Filter by symbol kind"),
    repos: z
      .array(z.string())
      .default(["all"])
      .describe('Repo names to search: "crosspad-core", "crosspad-pc", "ESP32-S3", etc. or ["all"]'),
    max_results: z
      .number()
      .default(50)
      .describe("Max results to return"),
  },
  async ({ query, kind, repos, max_results }) => {
    const result = crosspadSearchSymbols(query, kind, repos, max_results);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_scaffold_app",
  "Generate boilerplate for a new CrossPad app (cpp, hpp, CMakeLists.txt, optional pad logic). Returns file contents for Claude to write — does NOT create files on disk.",
  {
    name: z
      .string()
      .describe("PascalCase app name, e.g. 'Metronome'"),
    display_name: z
      .string()
      .optional()
      .describe("Human-readable name (defaults to name)"),
    has_pad_logic: z
      .boolean()
      .default(false)
      .describe("Generate IPadLogicHandler stub"),
    icon: z
      .string()
      .default("CrossPad_Logo_110w.png")
      .describe("Icon filename"),
  },
  async ({ name, display_name, has_pad_logic, icon }) => {
    const result = crosspadScaffoldApp({
      name,
      display_name,
      has_pad_logic,
      icon,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_interfaces",
  'Query crosspad-core interfaces and their implementations across all platforms. Use query="list" to list all interfaces, "implementations <InterfaceName>" to find implementations, or "capabilities" to show platform capability flags.',
  {
    query: z
      .string()
      .describe(
        '"list", "implementations <InterfaceName>", or "capabilities"'
      ),
  },
  async ({ query }) => {
    const result = crosspadInterfaces(query);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_apps",
  "List all registered CrossPad apps (found via REGISTER_APP macro or _register_*_app functions).",
  {
    platform: z
      .enum(["pc", "esp32", "2player", "all"])
      .default("pc")
      .describe("Which platform to scan"),
  },
  async ({ platform }) => {
    const result = crosspadApps(platform);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════
// SIMULATOR INTERACTION (requires running simulator with remote control)
// ═══════════════════════════════════════════════════════════════════════

server.tool(
  "crosspad_screenshot",
  "Capture a screenshot from the running CrossPad simulator. Saves BMP to screenshots/ dir by default. Requires the simulator to be running (use crosspad_run first).",
  {
    save_to_file: z
      .boolean()
      .default(true)
      .describe("Save to disk (default: true). If false, returns base64 data inline."),
    filename: z
      .string()
      .optional()
      .describe("Custom filename (default: screenshot_<timestamp>.bmp)"),
  },
  async ({ save_to_file, filename }) => {
    const result = await crosspadScreenshot(save_to_file, filename);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_input",
  `Send input events to the running CrossPad simulator. Requires simulator to be running.

Actions:
  click {x, y}           — mouse click at window coordinates (490x680 window)
  pad_press {pad, vel}    — press pad 0-15 with velocity 0-127
  pad_release {pad}       — release pad 0-15
  encoder_rotate {delta}  — rotate encoder (positive=CW, negative=CCW)
  encoder_press           — press encoder button
  encoder_release         — release encoder button
  key {keycode}           — SDL keycode (e.g. 13=Enter, 27=Escape)

LCD area is centered at roughly x=85..405, y=20..260 within the 490x680 window.`,
  {
    action: z
      .enum(["click", "pad_press", "pad_release", "encoder_rotate", "encoder_press", "encoder_release", "key"])
      .describe("Input action type"),
    x: z.number().optional().describe("X coordinate for click"),
    y: z.number().optional().describe("Y coordinate for click"),
    pad: z.number().optional().describe("Pad index 0-15 for pad_press/pad_release"),
    velocity: z.number().optional().describe("Velocity 0-127 for pad_press (default: 127)"),
    delta: z.number().optional().describe("Rotation delta for encoder_rotate"),
    keycode: z.number().optional().describe("SDL keycode for key action"),
  },
  async ({ action, x, y, pad, velocity, delta, keycode }) => {
    let input: InputAction;

    switch (action) {
      case "click":
        input = { action: "click", x: x ?? 0, y: y ?? 0 };
        break;
      case "pad_press":
        input = { action: "pad_press", pad: pad ?? 0, velocity: velocity ?? 127 };
        break;
      case "pad_release":
        input = { action: "pad_release", pad: pad ?? 0 };
        break;
      case "encoder_rotate":
        input = { action: "encoder_rotate", delta: delta ?? 1 };
        break;
      case "encoder_press":
        input = { action: "encoder_press" };
        break;
      case "encoder_release":
        input = { action: "encoder_release" };
        break;
      case "key":
        input = { action: "key", keycode: keycode ?? 0 };
        break;
      default:
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "Unknown action" }) }],
        };
    }

    const result = await crosspadInput(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_stats",
  `Query runtime statistics from the running simulator. Returns:
- Platform capabilities (active flags)
- Pad state (16 pads: pressed, playing, note, channel, RGB color)
- Active/registered pad logic handlers
- Registered apps list
- Heap stats (SRAM/PSRAM free/total)
- Settings summary (brightness, theme, kit, audio engine)`,
  {},
  async () => {
    const result = await crosspadStats();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "crosspad_settings",
  `Read or write CrossPad settings on the running simulator.

Read: action="get", category="all"|"display"|"keypad"|"vibration"|"wireless"|"audio"|"system"
Write: action="set", key="<setting_key>", value=<number> (booleans: 0/1)

Writable keys:
  lcd_brightness (0-255), rgb_brightness (0-255), theme_color (0-255), perf_stats_flags (bitmask)
  kit (0-255), audio_engine (0/1)
  keypad.enable, keypad.inactive_lights, keypad.eco_mode, keypad.send_stm/ble/usb/cc (0/1)
  vibration.enable, vibration.on_touch, vibration.in_min/max, vibration.out_min/max (0-255)
  master_fx.mute (0/1), master_fx.in_volume, master_fx.out_volume (0-100)

Changes are auto-saved to ~/.crosspad/preferences.json.`,
  {
    action: z
      .enum(["get", "set"])
      .describe("Read or write settings"),
    category: z
      .string()
      .default("all")
      .describe("For get: all, display, keypad, vibration, wireless, audio, system"),
    key: z
      .string()
      .optional()
      .describe("For set: dotted key name (e.g. 'lcd_brightness', 'keypad.eco_mode')"),
    value: z
      .number()
      .optional()
      .describe("For set: numeric value (booleans: 0=false, 1=true)"),
  },
  async ({ action, category, key, value }) => {
    if (action === "get") {
      const result = await crosspadSettingsGet(category);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } else {
      if (!key || value === undefined) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "key and value required for set" }) }],
        };
      }
      const result = await crosspadSettingsSet(key, value);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
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
