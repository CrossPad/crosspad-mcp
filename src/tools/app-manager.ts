/**
 * MCP tool: manage CrossPad app packages via the crosspad-apps registry.
 * - list: reads registry + manifest JSON directly (no Python needed)
 * - install/remove/update/sync: delegates to app_manager.py via Python subprocess
 */

import fs from "fs";
import path from "path";
import { CROSSPAD_IDF_ROOT } from "../config.js";
import { runCommand, runCommandStream, OnLine } from "../utils/exec.js";

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

interface AppEntry {
  name: string;
  version: string;
  description: string;
  repo: string;
  component_path: string;
  icon: string;
  category: string;
  platforms: string[];
  requires: Record<string, string>;
}

interface InstalledEntry {
  version: string;
  ref: string;
  repo: string;
  installed_at: string;
  updated_at?: string;
}

export interface AppListResult {
  success: boolean;
  platform: string;
  apps: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    category: string;
    platforms: string[];
    installed: boolean;
    installed_version?: string;
    installed_ref?: string;
    compatible: boolean;
  }>;
  installed_count: number;
  total_count: number;
  error?: string;
}

export interface AppActionResult {
  success: boolean;
  action: string;
  app_name?: string;
  output: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

const PLATFORM = "esp-idf";

function loadRegistryJson(): Record<string, AppEntry> | null {
  // Try local cache first, then cached registry
  const candidates = [
    path.join(CROSSPAD_IDF_ROOT, "app-registry.json"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf-8"));
        return data.apps ?? {};
      } catch {
        continue;
      }
    }
  }

  return null;
}

function loadManifest(): Record<string, InstalledEntry> {
  const manifestPath = path.join(CROSSPAD_IDF_ROOT, "apps.json");
  if (!fs.existsSync(manifestPath)) return {};

  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return data.installed ?? {};
  } catch {
    return {};
  }
}

function isCompatible(app: AppEntry): boolean {
  return app.platforms.includes(PLATFORM);
}

/**
 * Build a Python command that invokes app_manager.py's AppManager class.
 */
function buildPythonCmd(method: string, args: string = ""): string {
  const toolsDir = path.join(CROSSPAD_IDF_ROOT, "tools").replace(/\\/g, "/");
  const projectDir = CROSSPAD_IDF_ROOT.replace(/\\/g, "/");

  // Inline Python script that imports and calls AppManager
  const script = [
    `import sys, os`,
    `sys.path.insert(0, '${toolsDir}')`,
    `from app_manager import AppManager`,
    `mgr = AppManager('${projectDir}')`,
    `mgr.${method}(${args})`,
  ].join("; ");

  return `python3 -c "${script}"`;
}

// ═══════════════════════════════════════════════════════════════════════
// LIST — reads JSON directly, fast, no Python dependency
// ═══════════════════════════════════════════════════════════════════════

export function crosspadAppList(showAll: boolean = false): AppListResult {
  if (!fs.existsSync(CROSSPAD_IDF_ROOT)) {
    return {
      success: false,
      platform: PLATFORM,
      apps: [],
      installed_count: 0,
      total_count: 0,
      error: `platform-idf not found at ${CROSSPAD_IDF_ROOT}`,
    };
  }

  // Try to refresh registry if stale or missing
  let apps = loadRegistryJson();
  if (!apps) {
    // Try fetching via Python (which downloads registry on first use)
    const refreshCmd = buildPythonCmd("_load_registry");
    runCommand(refreshCmd, CROSSPAD_IDF_ROOT, 30_000);
    apps = loadRegistryJson();
  }

  if (!apps) {
    return {
      success: false,
      platform: PLATFORM,
      apps: [],
      installed_count: 0,
      total_count: 0,
      error: "Could not load registry. Ensure 'gh' CLI is installed and authenticated.",
    };
  }

  const manifest = loadManifest();
  const result: AppListResult["apps"] = [];

  for (const [id, app] of Object.entries(apps)) {
    const compatible = isCompatible(app);
    if (!showAll && !compatible) continue;

    const installed = manifest[id];
    result.push({
      id,
      name: app.name,
      version: app.version,
      description: app.description,
      category: app.category,
      platforms: app.platforms,
      installed: !!installed,
      installed_version: installed?.version,
      installed_ref: installed?.ref,
      compatible,
    });
  }

  const installedCount = result.filter((a) => a.installed).length;

  return {
    success: true,
    platform: PLATFORM,
    apps: result,
    installed_count: installedCount,
    total_count: Object.keys(apps).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// INSTALL / REMOVE / UPDATE / SYNC — delegates to Python
// ═══════════════════════════════════════════════════════════════════════

export async function crosspadAppInstall(
  appName: string,
  ref: string = "main",
  force: boolean = false,
  onLine?: OnLine
): Promise<AppActionResult> {
  const forceArg = force ? ", force=True" : "";
  const cmd = buildPythonCmd("install", `'${appName}', ref='${ref}'${forceArg}`);

  onLine?.("stdout", `[app-manager] Installing ${appName} (ref=${ref})...`);

  if (onLine) {
    const result = await runCommandStream(cmd, CROSSPAD_IDF_ROOT, onLine, 120_000);
    return {
      success: result.success,
      action: "install",
      app_name: appName,
      output: result.stdout,
      error: result.success ? undefined : result.stderr || result.stdout,
    };
  }

  const result = runCommand(cmd, CROSSPAD_IDF_ROOT, 120_000);
  return {
    success: result.success,
    action: "install",
    app_name: appName,
    output: result.stdout,
    error: result.success ? undefined : result.stderr || result.stdout,
  };
}

export async function crosspadAppRemove(
  appName: string,
  onLine?: OnLine
): Promise<AppActionResult> {
  const cmd = buildPythonCmd("remove", `'${appName}'`);

  onLine?.("stdout", `[app-manager] Removing ${appName}...`);

  if (onLine) {
    const result = await runCommandStream(cmd, CROSSPAD_IDF_ROOT, onLine, 60_000);
    return {
      success: result.success,
      action: "remove",
      app_name: appName,
      output: result.stdout,
      error: result.success ? undefined : result.stderr || result.stdout,
    };
  }

  const result = runCommand(cmd, CROSSPAD_IDF_ROOT, 60_000);
  return {
    success: result.success,
    action: "remove",
    app_name: appName,
    output: result.stdout,
    error: result.success ? undefined : result.stderr || result.stdout,
  };
}

export async function crosspadAppUpdate(
  appName?: string,
  updateAll: boolean = false,
  onLine?: OnLine
): Promise<AppActionResult> {
  let args: string;
  if (updateAll) {
    args = "update_all=True";
  } else if (appName) {
    args = `app_name='${appName}'`;
  } else {
    return {
      success: false,
      action: "update",
      output: "",
      error: "Specify app_name or set update_all=true",
    };
  }

  const cmd = buildPythonCmd("update", args);
  const label = updateAll ? "all apps" : appName!;
  onLine?.("stdout", `[app-manager] Updating ${label}...`);

  if (onLine) {
    const result = await runCommandStream(cmd, CROSSPAD_IDF_ROOT, onLine, 120_000);
    return {
      success: result.success,
      action: "update",
      app_name: appName,
      output: result.stdout,
      error: result.success ? undefined : result.stderr || result.stdout,
    };
  }

  const result = runCommand(cmd, CROSSPAD_IDF_ROOT, 120_000);
  return {
    success: result.success,
    action: "update",
    app_name: appName,
    output: result.stdout,
    error: result.success ? undefined : result.stderr || result.stdout,
  };
}

export async function crosspadAppSync(
  onLine?: OnLine
): Promise<AppActionResult> {
  const cmd = buildPythonCmd("sync");

  onLine?.("stdout", "[app-manager] Syncing manifest...");

  if (onLine) {
    const result = await runCommandStream(cmd, CROSSPAD_IDF_ROOT, onLine, 60_000);
    return {
      success: result.success,
      action: "sync",
      output: result.stdout,
      error: result.success ? undefined : result.stderr || result.stdout,
    };
  }

  const result = runCommand(cmd, CROSSPAD_IDF_ROOT, 60_000);
  return {
    success: result.success,
    action: "sync",
    output: result.stdout,
    error: result.success ? undefined : result.stderr || result.stdout,
  };
}
