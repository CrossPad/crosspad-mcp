import { describe, it, expect } from "vitest";
import { TOOL_TIERS, tierOf, annotationsFor } from "./tiers.js";
import { TOOLSETS, LEGACY_TOOLSET_OF } from "../toolsets.js";

// Derived from the registration tables rather than retyped. A hand-kept literal
// silently stopped naming ten tools, and this is the invariant that least
// tolerates that: an undeclared tool falls through to `danger`, and `danger` is
// removed outright under --read-only, so forgetting one makes it vanish.
const ALL_V10_TOOLS = [...new Set([...Object.values(TOOLSETS).flat(), ...Object.keys(LEGACY_TOOLSET_OF)])];

describe("TOOL_TIERS", () => {
  it("covers every tool the server registers", () => {
    for (const t of ALL_V10_TOOLS) expect(TOOL_TIERS[t], t).toBeDefined();
  });
  it("declares nothing that is not registered — a stale entry hides a rename", () => {
    for (const t of Object.keys(TOOL_TIERS)) expect(ALL_V10_TOOLS, t).toContain(t);
  });
  it("no registered tool relies on the unknown-tool default", () => {
    for (const t of ALL_V10_TOOLS) expect(tierOf(t, {}), t).not.toBe(undefined);
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
