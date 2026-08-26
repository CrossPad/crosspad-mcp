import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadPolicy, decide, ruleMatches, type Policy } from "./policy.js";

function tmpPolicy(content: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-policy-"));
  const file = path.join(dir, "policy.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

describe("loadPolicy precedence", () => {
  it("defaults to strict with no file and no env", () => {
    const p = loadPolicy({ file: "/nonexistent/crosspad/policy.json", env: {} });
    expect(p).toEqual({ mode: "strict", rules: [] });
  });
  it("reads mode and rules from the file", () => {
    const file = tmpPolicy({ mode: "lab", rules: [{ tool: "crosspad_flash", when: { transport: "ota" }, confirm: false }] });
    const p = loadPolicy({ file, env: {} });
    expect(p.mode).toBe("lab");
    expect(p.rules).toEqual([{ tool: "crosspad_flash", when: { transport: "ota" }, confirm: false }]);
  });
  it("env only makes it stricter: lab file + strict env → strict; strict file + lab env → strict", () => {
    const lab = tmpPolicy({ mode: "lab" });
    expect(loadPolicy({ file: lab, env: { CROSSPAD_MCP_POLICY: "strict" } }).mode).toBe("strict");
    const strict = tmpPolicy({ mode: "strict" });
    expect(loadPolicy({ file: strict, env: { CROSSPAD_MCP_POLICY: "lab" } }).mode).toBe("strict");
    expect(loadPolicy({ file: strict, env: { CROSSPAD_MCP_POLICY: "readonly" } }).mode).toBe("readonly");
  });
  it("--read-only always wins", () => {
    const lab = tmpPolicy({ mode: "lab" });
    expect(loadPolicy({ file: lab, env: { CROSSPAD_MCP_POLICY: "lab" }, readOnlyFlag: true }).mode).toBe("readonly");
  });
  it("ignores garbage in the file and env", () => {
    const bad = tmpPolicy("{ not json");
    expect(loadPolicy({ file: bad, env: { CROSSPAD_MCP_POLICY: "yolo" } })).toEqual({ mode: "strict", rules: [] });
    const badRules = tmpPolicy({ mode: "lab", rules: [{ nope: 1 }, { tool: "x", confirm: "yes" }, { tool: "ok_tool", confirm: true }] });
    expect(loadPolicy({ file: badRules, env: {} }).rules).toEqual([{ tool: "ok_tool", confirm: true }]);
  });
  it("CROSSPAD_MCP_POLICY_FILE selects the file", () => {
    const file = tmpPolicy({ mode: "lab" });
    expect(loadPolicy({ env: { CROSSPAD_MCP_POLICY_FILE: file } }).mode).toBe("lab");
  });
});

describe("ruleMatches", () => {
  const rule = { tool: "crosspad_flash", when: { transport: "ota", delta: { base_fw: "a.bin" } }, confirm: false };
  it("requires every when-key to deep-equal the arg", () => {
    expect(ruleMatches(rule, "crosspad_flash", { transport: "ota", delta: { base_fw: "a.bin" }, device: "dev_1" })).toBe(true);
    expect(ruleMatches(rule, "crosspad_flash", { transport: "uart", delta: { base_fw: "a.bin" } })).toBe(false);
    expect(ruleMatches(rule, "crosspad_flash", { transport: "ota", delta: { base_fw: "b.bin" } })).toBe(false);
    expect(ruleMatches(rule, "crosspad_flash", { transport: "ota" })).toBe(false);
    expect(ruleMatches(rule, "crosspad_build", { transport: "ota", delta: { base_fw: "a.bin" } })).toBe(false);
  });
  it("a rule without when matches every call of that tool", () => {
    expect(ruleMatches({ tool: "crosspad_flash", confirm: false }, "crosspad_flash", {})).toBe(true);
  });
});

describe("decide", () => {
  const strict: Policy = { mode: "strict", rules: [] };
  const readonly: Policy = { mode: "readonly", rules: [] };
  const lab: Policy = { mode: "lab", rules: [{ tool: "crosspad_flash", when: { transport: "ota" }, confirm: false }] };

  it("readonly hides everything that is not read tier", () => {
    expect(decide(readonly, "crosspad_devices", {})).toBe("allow");
    expect(decide(readonly, "crosspad_console", { action: "read" })).toBe("allow");
    expect(decide(readonly, "crosspad_console", { action: "reset" })).toBe("hidden");
    expect(decide(readonly, "crosspad_ui", { action: "press" })).toBe("hidden");
    expect(decide(readonly, "crosspad_commit", {})).toBe("hidden");
    expect(decide(readonly, "crosspad_flash", {})).toBe("hidden");
  });
  it("strict confirms danger and allows everything else", () => {
    expect(decide(strict, "crosspad_flash", { transport: "ota" })).toBe("confirm");
    expect(decide(strict, "crosspad_cdc", { verb: "stm_dfu" })).toBe("confirm");
    expect(decide(strict, "crosspad_trace", { action: "write" })).toBe("confirm");
    expect(decide(strict, "crosspad_commit", {})).toBe("allow");
    expect(decide(strict, "crosspad_ui", { action: "press" })).toBe("allow");
  });
  it("strict ignores confirm:false rules (a file cannot loosen strict)", () => {
    const strictWithRule: Policy = { mode: "strict", rules: [{ tool: "crosspad_flash", confirm: false }] };
    expect(decide(strictWithRule, "crosspad_flash", { transport: "ota" })).toBe("confirm");
  });
  it("lab pre-approves danger only when a rule with confirm:false matches", () => {
    expect(decide(lab, "crosspad_flash", { transport: "ota", device: "dev_1" })).toBe("allow");
    expect(decide(lab, "crosspad_flash", { transport: "uart" })).toBe("confirm");
    expect(decide(lab, "crosspad_cdc", { verb: "bootloader_request" })).toBe("confirm");
  });
  it("a confirm:true rule forces confirmation of a non-danger tool", () => {
    const p: Policy = { mode: "lab", rules: [{ tool: "crosspad_commit", confirm: true }] };
    expect(decide(p, "crosspad_commit", { repo: "idf" })).toBe("confirm");
  });
});
