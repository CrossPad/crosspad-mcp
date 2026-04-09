/**
 * MCP tool: manage CrossPad app packages via the crosspad-apps registry.
 * - list: reads registry + manifest JSON from ALL detected repos (no Python needed)
 * - install/remove/update/sync: delegates to app_manager.py via Python subprocess
 *
 * Each platform repo has app_manager.py at a different path:
 *   platform-idf  → tools/app_manager.py
 *   crosspad-pc   → scripts/app_manager.py
 *   ESP32-S3      → scripts/app_manager.py
 */

import fs from "fs";
import path from "path";
import { CROSSPAD_IDF_ROOT, CROSSPAD_PC_ROOT, getRepos } from "../config.js";
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
  apps: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    category: string;
    platforms: string[];
    installed_in: Array<{
      platform: string;
      version: string;
      ref: string;
    }>;
    compatible: boolean;
  }>;
  installed_count: number;
  total_count: number;
  error?: string;
}

export interface AppActionResult {
  success: boolean;
  action: string;
  platform: string;
  app_name?: string;
  output: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// PLATFORM REGISTRY — maps repo names to platform labels and paths
// ═══════════════════════════════════════════════════════════════════════

interface PlatformInfo {
  label: string;
  root: string;
  scriptDir: string; // relative path to app_manager.py's directory
  platformId: string; // platform ID used in registry ("esp-idf", "arduino", "pc")
}

/** @internal exported for testing */
export function getAvailablePlatforms(): PlatformInfo[] {
  const repos = getRepos();
  const platforms: PlatformInfo[] = [];

  if (repos["platform-idf"]) {
    platforms.push({
      label: "idf",
      root: repos["platform-idf"],
      scriptDir: "tools",
      platformId: "esp-idf",
    });
  }
  if (repos["crosspad-pc"]) {
    platforms.push({
      label: "pc",
      root: repos["crosspad-pc"],
      scriptDir: "scripts",
      platformId: "pc",
    });
  }
  if (repos["ESP32-S3"]) {
    platforms.push({
      label: "arduino",
      root: repos["ESP32-S3"],
      scriptDir: "scripts",
      platformId: "arduino",
    });
  }

  return platforms;
}

function resolvePlatform(platform: string): PlatformInfo | null {
  return getAvailablePlatforms().find((p) => p.label === platform) ?? null;
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function loadRegistryJsonFrom(repoRoot: string): Record<string, AppEntry> | null {
  const registryPath = path.join(repoRoot, "app-registry.json");
  if (!fs.existsSync(registryPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
    return data.apps ?? {};
  } catch {
    return null;
  }
}

function loadManifestFrom(repoRoot: string): Record<string, InstalledEntry> {
  const manifestPath = path.join(repoRoot, "apps.json");
  if (!fs.existsSync(manifestPath)) return {};

  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    return data.installed ?? {};
  } catch {
    return {};
  }
}

/** @internal exported for testing */
export function isCompatible(app: AppEntry, platformId: string): boolean {
  return app.platforms.includes(platformId);
}

/**
 * Build a Python command that invokes app_manager.py's AppManager class.
 */
/** @internal exported for testing */
export function buildPythonCmd(projectRoot: string, scriptDir: string, method: string, args: string = ""): string {
  const toolsDir = path.join(projectRoot, scriptDir).replace(/\\/g, "/");
  const projectDir = projectRoot.replace(/\\/g, "/");

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
// LIST — reads JSON from ALL repos, aggregates installation status
// ═══════════════════════════════════════════════════════════════════════

export function crosspadAppList(showAll: boolean = false): AppListResult {
  const platforms = getAvailablePlatforms();

  if (platforms.length === 0) {
    return {
      success: false,
      apps: [],
      installed_count: 0,
      total_count: 0,
      error: "No CrossPad repos found on disk.",
    };
  }

  // Load registry from first repo that has it
  let registry: Record<string, AppEntry> | null = null;
  for (const plat of platforms) {
    registry = loadRegistryJsonFrom(plat.root);
    if (registry) break;
  }

  if (!registry) {
    // Try refreshing via Python on the first available platform
    const plat = platforms[0];
    const refreshCmd = buildPythonCmd(plat.root, plat.scriptDir, "_load_registry");
    runCommand(refreshCmd, plat.root, 30_000);
    registry = loadRegistryJsonFrom(plat.root);
  }

  if (!registry) {
    return {
      success: false,
      apps: [],
      installed_count: 0,
      total_count: 0,
      error: "Could not load registry. Ensure 'gh' CLI is installed and authenticated.",
    };
  }

  // Load manifests from ALL repos
  const manifests: Array<{ platform: string; platformId: string; installed: Record<string, InstalledEntry> }> = [];
  for (const plat of platforms) {
    const installed = loadManifestFrom(plat.root);
    if (Object.keys(installed).length > 0) {
      manifests.push({ platform: plat.label, platformId: plat.platformId, installed });
    }
  }

  const result: AppListResult["apps"] = [];

  for (const [id, app] of Object.entries(registry)) {
    // Check where this app is installed
    const installedIn: AppListResult["apps"][0]["installed_in"] = [];
    for (const m of manifests) {
      const entry = m.installed[id];
      if (entry) {
        installedIn.push({
          platform: m.platform,
          version: entry.version,
          ref: entry.ref,
        });
      }
    }

    // Compatible = supported on at least one detected platform
    const compatible = platforms.some((p) => app.platforms.includes(p.platformId));
    if (!showAll && !compatible) continue;

    result.push({
      id,
      name: app.name,
      version: app.version,
      description: app.description,
      category: app.category,
      platforms: app.platforms,
      installed_in: installedIn,
      compatible,
    });
  }

  const installedCount = result.filter((a) => a.installed_in.length > 0).length;

  return {
    success: true,
    apps: result,
    installed_count: installedCount,
    total_count: Object.keys(registry).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// INSTALL / REMOVE / UPDATE / SYNC — delegates to Python per platform
// ═══════════════════════════════════════════════════════════════════════

function requirePlatform(platform: string): { info: PlatformInfo } | { error: AppActionResult } {
  const info = resolvePlatform(platform);
  if (!info) {
    const available = getAvailablePlatforms().map((p) => p.label);
    return {
      error: {
        success: false,
        action: "",
        platform,
        output: "",
        error: `Unknown platform "${platform}". Available: ${available.join(", ")}`,
      },
    };
  }
  return { info };
}

async function runPythonAction(
  info: PlatformInfo,
  action: string,
  method: string,
  args: string,
  appName: string | undefined,
  onLine: OnLine | undefined,
  timeoutMs: number,
): Promise<AppActionResult> {
  const cmd = buildPythonCmd(info.root, info.scriptDir, method, args);

  if (onLine) {
    const result = await runCommandStream(cmd, info.root, onLine, timeoutMs);
    return {
      success: result.success,
      action,
      platform: info.label,
      app_name: appName,
      output: result.stdout,
      error: result.success ? undefined : result.stderr || result.stdout,
    };
  }

  const result = runCommand(cmd, info.root, timeoutMs);
  return {
    success: result.success,
    action,
    platform: info.label,
    app_name: appName,
    output: result.stdout,
    error: result.success ? undefined : result.stderr || result.stdout,
  };
}

export async function crosspadAppInstall(
  appName: string,
  platform: string,
  ref: string = "main",
  force: boolean = false,
  onLine?: OnLine,
): Promise<AppActionResult> {
  const resolved = requirePlatform(platform);
  if ("error" in resolved) return { ...resolved.error, action: "install" };

  const forceArg = force ? ", force=True" : "";
  onLine?.("stdout", `[app-manager] Installing ${appName} on ${platform} (ref=${ref})...`);

  return runPythonAction(
    resolved.info, "install",
    "install", `'${appName}', ref='${ref}'${forceArg}`,
    appName, onLine, 120_000,
  );
}

export async function crosspadAppRemove(
  appName: string,
  platform: string,
  onLine?: OnLine,
): Promise<AppActionResult> {
  const resolved = requirePlatform(platform);
  if ("error" in resolved) return { ...resolved.error, action: "remove" };

  onLine?.("stdout", `[app-manager] Removing ${appName} from ${platform}...`);

  return runPythonAction(
    resolved.info, "remove",
    "remove", `'${appName}'`,
    appName, onLine, 60_000,
  );
}

export async function crosspadAppUpdate(
  platform: string,
  appName?: string,
  updateAll: boolean = false,
  onLine?: OnLine,
): Promise<AppActionResult> {
  const resolved = requirePlatform(platform);
  if ("error" in resolved) return { ...resolved.error, action: "update" };

  let args: string;
  if (updateAll) {
    args = "update_all=True";
  } else if (appName) {
    args = `app_name='${appName}'`;
  } else {
    return {
      success: false,
      action: "update",
      platform,
      output: "",
      error: "Specify app_name or set update_all=true",
    };
  }

  const label = updateAll ? "all apps" : appName!;
  onLine?.("stdout", `[app-manager] Updating ${label} on ${platform}...`);

  return runPythonAction(
    resolved.info, "update", "update", args,
    appName, onLine, 120_000,
  );
}

export async function crosspadAppSync(
  platform: string,
  onLine?: OnLine,
): Promise<AppActionResult> {
  const resolved = requirePlatform(platform);
  if ("error" in resolved) return { ...resolved.error, action: "sync" };

  onLine?.("stdout", `[app-manager] Syncing manifest on ${platform}...`);

  return runPythonAction(
    resolved.info, "sync", "sync", "",
    undefined, onLine, 60_000,
  );
}
