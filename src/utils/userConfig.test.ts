// src/utils/userConfig.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadUserConfig, resolveConfigValue, setConfigValue, _setConfigPathForTest } from "./userConfig.js";

let tmpDir: string;
let cfgPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpcfg-"));
  cfgPath = path.join(tmpDir, "config.json");
  _setConfigPathForTest(cfgPath);
});
afterEach(() => {
  _setConfigPathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadUserConfig", () => {
  it("returns {} when no config file exists", () => {
    expect(loadUserConfig()).toEqual({});
  });
  it("reads an existing config file", () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ stm_elf_path: "/x/a.elf" }));
    expect(loadUserConfig()).toEqual({ stm_elf_path: "/x/a.elf" });
  });
  it("returns {} on malformed JSON (never throws)", () => {
    fs.writeFileSync(cfgPath, "{not json");
    expect(loadUserConfig()).toEqual({});
  });
});

describe("resolveConfigValue", () => {
  it("prefers config file over env over default", () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ probe_serial: "FROM_CFG" }));
    expect(resolveConfigValue("probe_serial", "ENVV", "FROM_ENV", "DEF")).toBe("FROM_CFG");
  });
  it("falls back to env when key absent in config", () => {
    expect(resolveConfigValue("probe_serial", "ENVV", "FROM_ENV", "DEF")).toBe("FROM_ENV");
  });
  it("falls back to default when config and env absent", () => {
    expect(resolveConfigValue("probe_serial", "ENVV", undefined, "DEF")).toBe("DEF");
  });
});

describe("setConfigValue", () => {
  it("creates the file and persists a value", () => {
    setConfigValue("trace_dir", "/home/u/fw");
    expect(JSON.parse(fs.readFileSync(cfgPath, "utf-8"))).toEqual({ trace_dir: "/home/u/fw" });
  });
  it("merges into existing config without clobbering other keys", () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ trace_dir: "/a" }));
    setConfigValue("stm_elf_path", "/a/x.elf");
    expect(loadUserConfig()).toEqual({ trace_dir: "/a", stm_elf_path: "/a/x.elf" });
  });
});
