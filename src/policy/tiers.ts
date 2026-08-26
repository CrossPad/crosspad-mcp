// Safety tiers (spec §4.1). Server-enforced; annotations only mirror them.
export type Tier = "read" | "stimulus" | "mutate-host" | "danger";

type TierFn = (args: Record<string, unknown>) => Tier;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

// CDC verbs (verbs.py function names) that only read device state.
const CDC_READ_VERBS = new Set([
  "app_list", "app_versions", "kit_list", "kit_status", "pad_stats", "pad_notes", "pad_info",
  "enc_group", "enc_focus", "enc_state", "ui_state", "led_state", "mem", "mem_blocks",
  "cdc_stats", "audio_level", "smpl_peak", "ble_status", "ble_devices", "led",
]);
const CDC_DANGER_VERBS = new Set(["bootloader_request", "stm_dfu"]);
// Raw CDC commands that rewrite firmware or reboot into a bootloader
// (hil_control.cpp system verbs + the OTA stream opener).
const CDC_DANGER_RAW_PREFIXES = ["BOOTLOADER_REQUEST", "STM_DFU", "OTA_BEGIN", "OTA_DELTA"];

const cdcTier: TierFn = (args) => {
  // crosspad_cdc takes a verb *family* plus an `action` (kit+status → kit_status);
  // older call sites pass the full verb name in `verb` (and once, in `op`).
  const verb = str(args, "verb").toLowerCase();
  const action = str(args, "action").toLowerCase();
  if (CDC_DANGER_VERBS.has(verb)) return "danger";
  if (verb === "system" && (CDC_DANGER_VERBS.has(action) || CDC_DANGER_VERBS.has(str(args, "op").toLowerCase()))) {
    return "danger";
  }
  if (verb === "raw") {
    const cmd = str(args, "cmd").trim().toUpperCase();
    if (CDC_DANGER_RAW_PREFIXES.some((p) => cmd.startsWith(p))) return "danger";
    return "stimulus";
  }
  const candidates = [verb, action && `${verb}_${action}`, action];
  if (candidates.some((c) => c !== "" && CDC_READ_VERBS.has(c))) return "read";
  return "stimulus";
};

const buildTier: TierFn = (args) => {
  const mode = str(args, "mode");
  return mode === "fullclean" || mode === "clean" ? "mutate-host" : "stimulus";
};

const TRACE_READ_ACTIONS = new Set(["doctor", "status", "symbols", "read", "export", "list", "config"]);
const traceTier: TierFn = (args) => {
  const action = str(args, "action");
  if (action === "write" || action === "call") return "danger";
  if (TRACE_READ_ACTIONS.has(action)) return "read";
  return "stimulus";
};

const consoleTier: TierFn = (args) => (str(args, "action") === "reset" ? "stimulus" : "read");
const taskTier: TierFn = (args) => (str(args, "action") === "cancel" ? "stimulus" : "read");
const audioRouteTier: TierFn = (args) => (str(args, "action") === "query" ? "read" : "stimulus");
// action='get' is a devices.list read — it must stay reachable under --read-only.
const usbModeTier: TierFn = (args) => (str(args, "action") === "get" ? "read" : "stimulus");

export const TOOL_TIERS: Record<string, Tier | TierFn> = {
  // core
  crosspad_devices: "read",
  crosspad_doctor: "read",
  crosspad_snapshot: "read",
  crosspad_build: buildTier,
  crosspad_flash: "danger",
  crosspad_repo_status: "read",
  crosspad_toolsets: "read",
  crosspad_task: taskTier,
  // device
  // A scenario only stimulates the board unless it was told to flash.
  crosspad_hil_run: (args) =>
    (args as { params?: { flash?: unknown } } | undefined)?.params?.flash ? "danger" : "stimulus",
  crosspad_cdc: cdcTier,
  crosspad_console: consoleTier,
  crosspad_ui: "stimulus",
  crosspad_midi: "stimulus",
  crosspad_usb_mode: usbModeTier,
  crosspad_audio_route: audioRouteTier,
  // sim
  crosspad_run: "stimulus",
  crosspad_kill: "stimulus",
  crosspad_check: "read",
  crosspad_screenshot: "read",
  crosspad_input: "stimulus",
  crosspad_stats: "read",
  crosspad_settings_get: "read",
  crosspad_settings_set: "mutate-host",
  crosspad_test_run: "stimulus",
  crosspad_log: "read",
  // code
  crosspad_search_symbols: "read",
  crosspad_list_interfaces: "read",
  crosspad_interface_implementations: "read",
  crosspad_capabilities: "read",
  crosspad_list_apps_source: "read",
  // git
  crosspad_repo_diff: "read",
  crosspad_submodule_update: "mutate-host",
  crosspad_commit: "mutate-host",
  // apps
  crosspad_apps_list: "read",
  crosspad_apps_install: "mutate-host",
  crosspad_apps_remove: "mutate-host",
  crosspad_apps_update: "mutate-host",
  crosspad_apps_sync: "mutate-host",
  // trace
  crosspad_trace: traceTier,
};

/** Tier of a concrete call. Unknown tools are treated as danger — a tool that
 *  forgot to declare itself must not slip past confirmation. */
export function tierOf(tool: string, args: Record<string, unknown>): Tier {
  const entry = TOOL_TIERS[tool];
  if (entry === undefined) return "danger";
  return typeof entry === "function" ? entry(args ?? {}) : entry;
}

export function annotationsFor(tier: Tier): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  switch (tier) {
    case "read":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case "stimulus":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case "mutate-host":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    case "danger":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  }
}
