// src/utils/userConfig.ts
import fs from "fs";
import os from "os";
import path from "path";

export interface UserConfig {
  stm_elf_path?: string;
  pyocd_python?: string;
  probe_serial?: string;
  trace_dir?: string;
}

let testPathOverride: string | null = null;
/** @internal test-only — override the config file path. Pass null to clear. */
export function _setConfigPathForTest(p: string | null): void {
  testPathOverride = p;
}

export function userConfigPath(): string {
  if (testPathOverride) return testPathOverride;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "crosspad-mcp", "config.json");
}

export function loadUserConfig(): UserConfig {
  try {
    const raw = fs.readFileSync(userConfigPath(), "utf-8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as UserConfig) : {};
  } catch {
    return {};
  }
}

/** Resolution order: config file → env var → default. envValue is the *already-read* process.env value. */
export function resolveConfigValue(
  key: keyof UserConfig,
  _envName: string,
  envValue: string | undefined,
  defaultValue: string,
): string {
  const cfg = loadUserConfig();
  const fromCfg = cfg[key];
  if (typeof fromCfg === "string" && fromCfg.length > 0) return fromCfg;
  if (envValue && envValue.length > 0) return envValue;
  return defaultValue;
}

export function setConfigValue(key: keyof UserConfig, value: string): void {
  const p = userConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cfg = loadUserConfig();
  cfg[key] = value;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
