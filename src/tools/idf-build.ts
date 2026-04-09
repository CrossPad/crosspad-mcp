import fs from "fs";
import path from "path";
import { CROSSPAD_IDF_ROOT } from "../config.js";
import { runIdf, runIdfStream, OnLine } from "../utils/exec.js";

export interface IdfBuildResult {
  success: boolean;
  duration_seconds: number;
  errors: string[];
  warnings: string[];
  tail: string[];
  auto_reconfigured?: boolean;
}

/**
 * Detect app directories that have REGISTER_APP in their sources but are NOT
 * listed in the auto-generated app_registry_init.cpp. This means CMake hasn't
 * seen them yet (file(GLOB) only runs at configure time).
 */
/** @internal exported for testing */
export function detectUnregisteredApps(): string[] {
  const appsDir = path.join(CROSSPAD_IDF_ROOT, "main", "app");
  const registryFile = path.join(appsDir, "app_registry_init.cpp");

  if (!fs.existsSync(registryFile)) return [];

  const registryContent = fs.readFileSync(registryFile, "utf-8");

  const unregistered: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(appsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const appCmake = path.join(appsDir, entry.name, "CMakeLists.txt");
    if (!fs.existsSync(appCmake)) continue;

    // Scan .cpp files in this app dir for REGISTER_APP
    const appDir = path.join(appsDir, entry.name);
    let hasRegisterApp = false;
    let appName = "";

    try {
      for (const file of fs.readdirSync(appDir)) {
        if (!file.endsWith(".cpp")) continue;
        const content = fs.readFileSync(path.join(appDir, file), "utf-8");
        const match = content.match(/REGISTER_APP\((\w+)/);
        if (match) {
          hasRegisterApp = true;
          appName = match[1];
          break;
        }
      }
    } catch {
      continue;
    }

    if (hasRegisterApp && appName) {
      // Check if this app is in the registry
      const registerFn = `_register_${appName}_app`;
      if (!registryContent.includes(registerFn)) {
        unregistered.push(appName);
      }
    }
  }

  return unregistered;
}

/** @internal exported for testing */
export function parseErrors(output: string): string[] {
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/:\d+:\d+: (?:fatal )?error:/.test(trimmed)) {
      errors.push(trimmed);
    } else if (/^.*ld.*: error:/.test(trimmed) || /undefined reference to/.test(trimmed)) {
      errors.push(trimmed);
    } else if (/^CMake Error/i.test(trimmed)) {
      errors.push(trimmed);
    } else if (/FAILED:/.test(trimmed) && !trimmed.startsWith("[")) {
      errors.push(trimmed);
    }
  }
  return errors.slice(0, 30);
}

/** @internal exported for testing */
export function parseWarnings(output: string): string[] {
  const warnings: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/:\d+:\d+: warning:/.test(trimmed)) {
      warnings.push(trimmed);
    }
  }
  return warnings.slice(0, 20);
}

/** @internal exported for testing */
export function getTail(output: string, n: number): string[] {
  return output.split("\n").filter(l => l.trim()).slice(-n);
}

async function runIdfCmd(
  cmd: string,
  onLine: OnLine | undefined,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  if (onLine) {
    const r = await runIdfStream(cmd, CROSSPAD_IDF_ROOT, onLine, timeoutMs);
    return r;
  }
  return runIdf(cmd, CROSSPAD_IDF_ROOT, timeoutMs);
}

export async function crosspadIdfBuild(
  mode: "build" | "fullclean" | "clean",
  onLine?: OnLine
): Promise<IdfBuildResult> {
  const startTime = Date.now();
  let autoReconfigured = false;

  // Auto-detect unregistered apps — if found, escalate to fullclean
  if (mode === "build") {
    const unregistered = detectUnregisteredApps();
    if (unregistered.length > 0) {
      onLine?.("stdout", `[idf] Detected ${unregistered.length} unregistered app(s): ${unregistered.join(", ")} — running fullclean`);
      mode = "fullclean";
      autoReconfigured = true;
    }
  }

  if (mode === "fullclean") {
    onLine?.("stdout", "[idf] Running idf.py fullclean...");
    const r = await runIdfCmd("idf.py fullclean", onLine, 60_000);
    if (!r.success) {
      const combined = r.stdout + "\n" + r.stderr;
      return {
        success: false,
        duration_seconds: (Date.now() - startTime) / 1000,
        errors: parseErrors(combined),
        warnings: [],
        tail: getTail(combined, 20),
        auto_reconfigured: autoReconfigured,
      };
    }
  }

  if (mode === "clean") {
    const buildDir = path.join(CROSSPAD_IDF_ROOT, "build");
    if (fs.existsSync(buildDir)) {
      onLine?.("stdout", "[idf] Removing build directory...");
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  }

  onLine?.("stdout", "[idf] Building...");

  const r = await runIdfCmd("idf.py build", onLine, 600_000);
  const combined = r.stdout + "\n" + r.stderr;
  const errors = parseErrors(combined);
  const warnings = parseWarnings(combined);

  const result: IdfBuildResult = {
    success: r.success,
    duration_seconds: (Date.now() - startTime) / 1000,
    errors,
    warnings,
    tail: getTail(combined, r.success ? 10 : 30),
  };

  if (autoReconfigured) {
    result.auto_reconfigured = true;
  }

  onLine?.("stdout", `[idf] Build ${result.success ? "succeeded" : "FAILED"} in ${result.duration_seconds.toFixed(1)}s`);
  return result;
}
