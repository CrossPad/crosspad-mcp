// One place that knows every tool and its toolset (spec §3.1).
//
// New-style tools (`register<Name>Tool` from src/tools/*) are registered first,
// in TOOLSETS order; the v9 tools still registered inline by index.ts arrive via
// `legacy` and are filed into their toolset unless a new-style tool of the same
// name already replaced them. A legacy name with no toolset is removed outright.
//
// The v10 tool modules land across several plan tasks, so they are looked up by
// specifier at startup rather than statically imported: a module that has not
// been written yet is skipped, and the server still starts with everything else.
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolsetManager, toolsetOf, toolsetOrder, toolOrder } from "./toolsets.js";
import type { ToolContext } from "./tool-context.js";
import { registerToolsetsTool } from "./tools/toolsets-tool.js";
import { registerTaskTool } from "./tools/task.js";
import { registerKnowledgeResources } from "./resources/knowledge.js";
import { registerPrompts } from "./prompts.js";
import { registerIntrospectionResources } from "./resources/introspect.js";

/** A v10 tool module's registration entry point, plus where the tool belongs. */
export interface ToolRegistrar {
  name: string;
  toolset: string;
  register: (server: McpServer, ctx: ToolContext) => RegisteredTool;
}

/** A v10 resource module's entry point. Resources are not toolset-gated. */
export type ResourceRegistrar = (server: McpServer, ctx: ToolContext) => void;

/** What `loadV10Modules()` found in this tree. */
export interface V10Modules {
  tools: ToolRegistrar[];
  resources: ResourceRegistrar[];
}

interface ModuleSpec {
  name: string;
  toolset: string;
  module: string;
  export: string;
}

/**
 * v10 tool modules that are loaded if present. Each entry is exactly the
 * `register<Name>Tool(server, ctx)` contract from the plan's Interfaces blocks.
 * Tools whose module has not been written yet simply do not appear in
 * `tools/list`; `crosspad_doctor` reports what is missing.
 */
export const V10_MODULES: ModuleSpec[] = [
  { name: "crosspad_devices", toolset: "core", module: "./tools/devices.js", export: "registerDevicesTool" },
  { name: "crosspad_doctor", toolset: "core", module: "./tools/doctor.js", export: "registerDoctorTool" },
  { name: "crosspad_snapshot", toolset: "core", module: "./tools/snapshot.js", export: "registerSnapshotTool" },
  { name: "crosspad_flash", toolset: "core", module: "./tools/flash.js", export: "registerFlashTool" },
  { name: "crosspad_cdc", toolset: "device", module: "./tools/cdc.js", export: "registerCdcTool" },
  { name: "crosspad_console", toolset: "device", module: "./tools/console.js", export: "registerConsoleTool" },
  { name: "crosspad_ui", toolset: "device", module: "./tools/ui.js", export: "registerUiTool" },
  { name: "crosspad_midi", toolset: "device", module: "./tools/midi.js", export: "registerMidiTool" },
  { name: "crosspad_usb_mode", toolset: "device", module: "./tools/usb-mode.js", export: "registerUsbModeTool" },
  { name: "crosspad_audio_route", toolset: "device", module: "./tools/audio-route.js", export: "registerAudioRouteTool" },
];

/** Resource modules loaded the same way. `toolset` is unused; it keeps one shape. */
export const V10_RESOURCE_MODULES: ModuleSpec[] = [
  { name: "crosspad_hil_run", toolset: "hil", module: "./tools/hil-run.js", export: "registerHilRunTool" },
  { name: "crosspad://device/*", toolset: "device", module: "./resources/device.js", export: "registerDeviceResources" },
];

function isMissingModule(e: unknown, spec: string): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /Cannot find module|Failed to load url|Failed to resolve import/.test(msg) && msg.includes(spec.replace("./", ""));
}

/**
 * Resolve the v10 tool modules that exist in this tree. A module that is not
 * there yet is skipped silently (it is a planned file, not a broken install);
 * a module that is there but fails to load is reported on stderr and skipped,
 * because one unfinished tool must not take the whole server down.
 */
async function loadExports(specs: ModuleSpec[]): Promise<Array<{ spec: ModuleSpec; fn: Function }>> {
  const found: Array<{ spec: ModuleSpec; fn: Function }> = [];
  for (const spec of specs) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(spec.module)) as Record<string, unknown>;
    } catch (e) {
      if (!isMissingModule(e, spec.module)) {
        console.error(`crosspad-mcp: ${spec.name} unavailable — ${spec.module} failed to load: ${String(e)}`);
      }
      continue;
    }
    const fn = mod[spec.export];
    if (typeof fn !== "function") {
      console.error(`crosspad-mcp: ${spec.module} has no ${spec.export}() — ${spec.name} not registered`);
      continue;
    }
    found.push({ spec, fn: fn as Function });
  }
  return found;
}

export async function loadV10Registrars(specs: ModuleSpec[] = V10_MODULES): Promise<ToolRegistrar[]> {
  const found = await loadExports(specs);
  return found.map(({ spec, fn }) => ({
    name: spec.name,
    toolset: spec.toolset,
    register: fn as ToolRegistrar["register"],
  }));
}

export async function loadV10ResourceRegistrars(specs: ModuleSpec[] = V10_RESOURCE_MODULES): Promise<ResourceRegistrar[]> {
  const found = await loadExports(specs);
  return found.map(({ fn }) => fn as ResourceRegistrar);
}

/** Everything the v10 rollout has actually landed in this tree. */
export async function loadV10Modules(): Promise<V10Modules> {
  const [tools, resources] = await Promise.all([loadV10Registrars(), loadV10ResourceRegistrars()]);
  return { tools, resources };
}

/** TOOLSETS key order, then the tool's position inside its toolset array. */
function byToolsetOrder(a: ToolRegistrar, b: ToolRegistrar): number {
  return toolsetOrder(a.toolset) - toolsetOrder(b.toolset) || toolOrder(a.name) - toolOrder(b.name);
}

export function registerAll(
  server: McpServer,
  ctx: ToolContext,
  manager: ToolsetManager,
  legacy?: Map<string, RegisteredTool>,
  extra: Partial<V10Modules> = {},
): void {
  const extras = extra.tools ?? [];
  const registered = new Set<string>();

  // ── new-style tools, in TOOLSETS order ──
  const builtIn: ToolRegistrar[] = [
    { name: "crosspad_toolsets", toolset: "core", register: (s, c) => registerToolsetsTool(s, c, manager) },
    { name: "crosspad_task", toolset: "core", register: registerTaskTool },
  ];
  const newStyle = [...builtIn, ...extras].sort(byToolsetOrder);

  for (const r of newStyle) {
    if (registered.has(r.name)) continue;
    // A v9 tool of the same name still holds the slot; the SDK refuses a
    // duplicate registration, so retire the old one before the new one lands.
    legacy?.get(r.name)?.remove();
    manager.register(r.name, r.register(server, ctx), r.toolset);
    registered.add(r.name);
  }

  // ── legacy v9 tools registered inline by index.ts ──
  for (const [name, tool] of legacy ?? []) {
    // Already retired above, before its v10 replacement took the slot.
    // Calling remove() again would delete the *new* tool: the SDK's remove()
    // is `update({name: null})`, which deletes whatever currently holds the
    // name, not the object it was called on.
    if (registered.has(name)) continue;
    const toolset = toolsetOf(name);
    if (!toolset) { tool.remove(); continue; }
    manager.register(name, tool, toolset);
    registered.add(name);
  }

  // ── resources (not toolset-gated: a resource costs no tool-schema context) ──
  for (const register of extra.resources ?? []) register(server, ctx);
  // The knowledge catalogs have no optional dependency to probe for — they are
  // three daemon reads — so they are wired statically rather than through the
  // load-if-present path the device resources use.
  registerKnowledgeResources(server, ctx);
  // Parsed from the crosspad-core headers, so they cannot drift from the
  // firmware; each read is mtime-checked rather than cached for the process.
  registerIntrospectionResources(server, ctx);

  // ── prompts (user-selectable workflows; no tool-schema cost either) ──
  registerPrompts(server);
}
