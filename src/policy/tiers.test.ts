import { describe, it, expect } from "vitest";
import { TOOL_TIERS, tierOf, annotationsFor } from "./tiers.js";

const ALL_V10_TOOLS = [
  "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_build", "crosspad_flash",
  "crosspad_repo_status", "crosspad_toolsets", "crosspad_task",
  "crosspad_cdc", "crosspad_console", "crosspad_ui", "crosspad_midi", "crosspad_usb_mode", "crosspad_audio_route",
  "crosspad_run", "crosspad_kill", "crosspad_check", "crosspad_screenshot", "crosspad_input", "crosspad_stats",
  "crosspad_settings_get", "crosspad_settings_set", "crosspad_test_run",
  "crosspad_search_symbols", "crosspad_list_interfaces", "crosspad_interface_implementations",
  "crosspad_capabilities", "crosspad_list_apps_source",
  "crosspad_repo_diff", "crosspad_submodule_update", "crosspad_commit",
  "crosspad_apps_list", "crosspad_apps_install", "crosspad_apps_remove", "crosspad_apps_update", "crosspad_apps_sync",
  "crosspad_trace",
];

describe("TOOL_TIERS", () => {
  it("covers every v10 tool", () => {
    for (const t of ALL_V10_TOOLS) expect(TOOL_TIERS[t], t).toBeDefined();
  });
  it("unknown tools default to danger", () => {
    expect(tierOf("crosspad_does_not_exist", {})).toBe("danger");
  });
});

describe("tierOf arg-dependent tools", () => {
  it("crosspad_build: clean/fullclean mutate the host, incremental does not", () => {
    expect(tierOf("crosspad_build", { platform: "idf", mode: "fullclean" })).toBe("mutate-host");
    expect(tierOf("crosspad_build", { platform: "pc", mode: "clean" })).toBe("mutate-host");
    expect(tierOf("crosspad_build", { platform: "pc", mode: "incremental" })).toBe("stimulus");
    expect(tierOf("crosspad_build", {})).toBe("stimulus");
  });
  it("crosspad_cdc: bootloader_request / stm_dfu are danger, status verbs are read", () => {
    expect(tierOf("crosspad_cdc", { verb: "bootloader_request" })).toBe("danger");
    expect(tierOf("crosspad_cdc", { verb: "stm_dfu" })).toBe("danger");
    expect(tierOf("crosspad_cdc", { verb: "system", op: "stm_dfu" })).toBe("danger");
    expect(tierOf("crosspad_cdc", { verb: "raw", cmd: "ota_begin 1234 v1" })).toBe("danger");
    expect(tierOf("crosspad_cdc", { verb: "kit_status" })).toBe("read");
    expect(tierOf("crosspad_cdc", { verb: "mem" })).toBe("read");
    expect(tierOf("crosspad_cdc", { verb: "pad_press", idx: 3 })).toBe("stimulus");
    expect(tierOf("crosspad_cdc", { verb: "raw", cmd: "PAD_PRESS 3 100" })).toBe("stimulus");
  });
  it("crosspad_flash is always danger", () => {
    expect(tierOf("crosspad_flash", { target: "esp", transport: "ota" })).toBe("danger");
    expect(tierOf("crosspad_flash", {})).toBe("danger");
  });
  it("crosspad_trace: write/call are danger, doctor is read, start is stimulus", () => {
    expect(tierOf("crosspad_trace", { action: "write" })).toBe("danger");
    expect(tierOf("crosspad_trace", { action: "call" })).toBe("danger");
    expect(tierOf("crosspad_trace", { action: "doctor" })).toBe("read");
    expect(tierOf("crosspad_trace", { action: "start" })).toBe("stimulus");
  });
  it("crosspad_console: reset is stimulus, read/expect/open are read", () => {
    expect(tierOf("crosspad_console", { action: "reset", handle: "con_1" })).toBe("stimulus");
    expect(tierOf("crosspad_console", { action: "read", handle: "con_1" })).toBe("read");
    expect(tierOf("crosspad_console", { action: "open", device: "dev_1" })).toBe("read");
  });
  it("crosspad_task: cancel is stimulus, status is read", () => {
    expect(tierOf("crosspad_task", { action: "cancel", task: "task_1" })).toBe("stimulus");
    expect(tierOf("crosspad_task", { action: "status", task: "task_1" })).toBe("read");
  });
});

describe("annotationsFor", () => {
  it("mirrors the tier table", () => {
    expect(annotationsFor("read")).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(annotationsFor("stimulus")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(annotationsFor("mutate-host")).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    expect(annotationsFor("danger")).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
});
