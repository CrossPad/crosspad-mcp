// Dynamic toolsets (spec §3.1). Only `core` is visible at start; the rest come
// from --toolsets / CROSSPAD_TOOLSETS / the crosspad_toolsets meta-tool.
//
// Why the server hides tools at all: a v9 session paid ~30 tool schemas of
// context before the first message. The startup surface is now 8, and a model
// that needs more asks for the toolset by name.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decide, type Policy } from "./policy/policy.js";
import { tierOf, type Tier } from "./policy/tiers.js";

// Key order is the tools/list order; tool order within a set is fixed too.
export const TOOLSETS: Record<string, string[]> = {
  core: [
    "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_build", "crosspad_flash",
    "crosspad_repo_status", "crosspad_toolsets", "crosspad_task",
  ],
  device: [
    "crosspad_cdc", "crosspad_console", "crosspad_ui", "crosspad_midi", "crosspad_usb_mode", "crosspad_audio_route", "crosspad_diagnose_crash",
  ],
  hil: [
    "crosspad_hil_run", "crosspad_capture", "crosspad_analyze",
    "crosspad_stimulus", "crosspad_ble",
  ],
  sim: [
    "crosspad_run", "crosspad_kill", "crosspad_check", "crosspad_screenshot", "crosspad_input", "crosspad_stats",
    "crosspad_settings_get", "crosspad_settings_set", "crosspad_test_run",
  ],
  code: [
    "crosspad_docs_search", "crosspad_architecture",
    "crosspad_search_symbols", "crosspad_list_interfaces", "crosspad_interface_implementations",
    "crosspad_capabilities", "crosspad_list_apps_source",
  ],
  git: ["crosspad_repo_diff", "crosspad_submodule_update", "crosspad_commit"],
  apps: ["crosspad_apps", "crosspad_apps_list", "crosspad_apps_install", "crosspad_apps_remove", "crosspad_apps_update", "crosspad_apps_sync"],
  trace: ["crosspad_trace"],
};

export const TOOLSET_DESCRIPTIONS: Record<string, string> = {
  core: "Always on: device inventory, doctor, snapshot, build, flash (confirmed), repo status, toolsets, task control.",
  device: "Device I/O through the crosspad-hil daemon: CDC verbs, console, UI driving, MIDI, USB mode, audio routing.",
  hil: "Hardware-in-the-loop scenarios, audio capture and analysis, pad stimulus, host-side BLE.",
  sim: "PC simulator: run/kill/check, screenshot, input, stats, settings, test runner.",
  code: "Code intelligence: symbol search, interfaces, implementations, capabilities, registered apps.",
  git: "Repo mutations: submodule drift, submodule update, commit.",
  apps: "App package manager (crosspad-apps registry): list/install/remove/update/sync.",
  trace: "STM32 SWD variable tracer.",
};

// v9 tools still registered by index.ts that the spec table does not list.
export const LEGACY_TOOLSET_OF: Record<string, string> = { crosspad_log: "sim" };

export function toolsetOf(tool: string): string | undefined {
  for (const [ts, names] of Object.entries(TOOLSETS)) if (names.includes(tool)) return ts;
  return LEGACY_TOOLSET_OF[tool];
}

/** Position of a tool inside its toolset array, for deterministic registration order. */
export function toolOrder(tool: string): number {
  const ts = toolsetOf(tool);
  if (ts === undefined) return Number.MAX_SAFE_INTEGER;
  const i = TOOLSETS[ts].indexOf(tool);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

/** Position of a toolset in TOOLSETS key order. */
export function toolsetOrder(toolset: string): number {
  const i = Object.keys(TOOLSETS).indexOf(toolset);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

interface Entry {
  tool: RegisteredTool;
  toolset: string;
  hidden: boolean;
  enabled: boolean;
}

export class ToolsetManager {
  private readonly entries = new Map<string, Entry>();
  private readonly enabledSets = new Set<string>();

  constructor(private readonly server: McpServer, private readonly policy: Policy) {}

  /** Every tool starts disabled. Hidden-by-policy tools are removed outright. */
  register(name: string, tool: RegisteredTool, toolset: string): void {
    if (!(toolset in TOOLSETS)) throw new Error(`unknown toolset "${toolset}" for tool ${name}`);
    const hidden = !this.visible(name);
    if (hidden) tool.remove();
    else tool.disable();
    this.entries.set(name, { tool, toolset, hidden, enabled: false });
  }

  /** Policy visibility with no arguments: readonly hides every non-read tool. */
  visible(tool: string): boolean {
    return decide(this.policy, tool, {}) !== "hidden";
  }

  isEnabled(tool: string): boolean {
    return this.entries.get(tool)?.enabled ?? false;
  }

  tools(toolset: string): string[] {
    this.assertToolset(toolset);
    return [...this.entries.entries()].filter(([, e]) => e.toolset === toolset).map(([n]) => n).sort();
  }

  hiddenTools(): string[] {
    return [...this.entries.entries()].filter(([, e]) => e.hidden).map(([n]) => n).sort();
  }

  /** Enables the toolset; returns the sorted names newly enabled by this call. */
  enable(toolset: string): string[] {
    this.assertToolset(toolset);
    const changed: string[] = [];
    for (const [name, e] of this.entries) {
      if (e.toolset !== toolset || e.hidden || e.enabled) continue;
      e.tool.enable();
      e.enabled = true;
      changed.push(name);
    }
    this.enabledSets.add(toolset);
    changed.sort();
    if (changed.length > 0) this.notify();
    return changed;
  }

  /** Disables the toolset; returns the sorted names newly disabled. `core` is refused. */
  disable(toolset: string): string[] {
    this.assertToolset(toolset);
    if (toolset === "core") throw new Error("the core toolset cannot be disabled");
    const changed: string[] = [];
    for (const [name, e] of this.entries) {
      if (e.toolset !== toolset || !e.enabled) continue;
      e.tool.disable();
      e.enabled = false;
      changed.push(name);
    }
    this.enabledSets.delete(toolset);
    changed.sort();
    if (changed.length > 0) this.notify();
    return changed;
  }

  /** Enabled toolsets, in TOOLSETS key order. */
  enabled(): string[] {
    return Object.keys(TOOLSETS).filter((ts) => this.enabledSets.has(ts));
  }

  describe(toolset: string): {
    name: string;
    description: string;
    enabled: boolean;
    tools: Array<{ name: string; tier: Tier; enabled: boolean; hidden: boolean }>;
  } {
    this.assertToolset(toolset);
    const tools = TOOLSETS[toolset].map((name) => {
      const e = this.entries.get(name);
      return { name, tier: tierOf(name, {}), enabled: e?.enabled ?? false, hidden: e?.hidden ?? !this.visible(name) };
    });
    return { name: toolset, description: TOOLSET_DESCRIPTIONS[toolset] ?? "", enabled: this.enabledSets.has(toolset), tools };
  }

  private assertToolset(toolset: string): void {
    if (!(toolset in TOOLSETS)) {
      throw new Error(`unknown toolset "${toolset}"; known: ${Object.keys(TOOLSETS).join(", ")}`);
    }
  }

  private notify(): void {
    try {
      this.server.sendToolListChanged();
    } catch {
      // not connected yet — the initial list is served on first tools/list
    }
  }
}

function splitList(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** `core` + $CROSSPAD_TOOLSETS + `--toolsets a,b` (or `--toolsets=a,b`); `all` expands; result in TOOLSETS order. */
export function initialToolsets(argv: string[], env: NodeJS.ProcessEnv): string[] {
  const wanted = new Set<string>(["core"]);
  const requested: string[] = splitList(env.CROSSPAD_TOOLSETS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--toolsets") requested.push(...splitList(argv[i + 1]));
    else if (a.startsWith("--toolsets=")) requested.push(...splitList(a.slice("--toolsets=".length)));
  }
  for (const r of requested) {
    if (r === "all") { for (const ts of Object.keys(TOOLSETS)) wanted.add(ts); continue; }
    if (r in TOOLSETS) wanted.add(r);
    else console.error(`crosspad-mcp: ignoring unknown toolset "${r}" (known: ${Object.keys(TOOLSETS).join(", ")})`);
  }
  return Object.keys(TOOLSETS).filter((ts) => wanted.has(ts));
}

export function hasReadOnlyFlag(argv: string[]): boolean {
  return argv.includes("--read-only");
}
