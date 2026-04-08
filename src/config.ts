import fs from "fs";
import path from "path";
import os from "os";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

// ═══════════════════════════════════════════════════════════════════════
// BASE PATHS — all overridable via env vars
// ═══════════════════════════════════════════════════════════════════════

const GIT_DIR = process.env.CROSSPAD_GIT_DIR || path.join(os.homedir(), "GIT");

export const CROSSPAD_PC_ROOT =
  process.env.CROSSPAD_PC_ROOT || path.join(GIT_DIR, "crosspad-pc");

export const CROSSPAD_IDF_ROOT =
  process.env.CROSSPAD_IDF_ROOT || path.join(GIT_DIR, "platform-idf");

// ═══════════════════════════════════════════════════════════════════════
// ESP-IDF SDK PATH — fallback chain
// ═══════════════════════════════════════════════════════════════════════

function findIdfPath(): string {
  if (process.env.IDF_PATH) return process.env.IDF_PATH;

  // Try common paths
  const candidates = [
    path.join(os.homedir(), "esp", "esp-idf"),
    path.join(os.homedir(), "esp", "v5.5.4", "esp-idf"),
    path.join(os.homedir(), "esp", "v5.5", "esp-idf"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Last resort — return the most common default even if missing
  return path.join(os.homedir(), "esp", "esp-idf");
}

export const IDF_PATH = findIdfPath();

// ═══════════════════════════════════════════════════════════════════════
// MSVC / VCPKG — Windows-only build tools
// ═══════════════════════════════════════════════════════════════════════

export const VCVARSALL =
  process.env.VCVARSALL ||
  "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvarsall.bat";

const defaultVcpkgRoot = IS_WINDOWS ? "C:/vcpkg" : path.join(os.homedir(), "vcpkg");
const vcpkgRoot = process.env.VCPKG_ROOT || defaultVcpkgRoot;
export const VCPKG_TOOLCHAIN = path.join(vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake");

// ═══════════════════════════════════════════════════════════════════════
// PC SIMULATOR PATHS
// ═══════════════════════════════════════════════════════════════════════

export const BUILD_DIR = path.join(CROSSPAD_PC_ROOT, "build");

const EXE_EXT = IS_WINDOWS ? ".exe" : "";
export const BIN_EXE = path.join(CROSSPAD_PC_ROOT, "bin", `main${EXE_EXT}`);

// ═══════════════════════════════════════════════════════════════════════
// REPOS — dynamic discovery, cached
// ═══════════════════════════════════════════════════════════════════════

/** Known repo candidates: name → expected path */
const REPO_CANDIDATES: Record<string, string> = {
  "crosspad-core": path.join(GIT_DIR, "crosspad-core"),
  "crosspad-gui": path.join(GIT_DIR, "crosspad-gui"),
  "crosspad-pc": CROSSPAD_PC_ROOT,
  "platform-idf": CROSSPAD_IDF_ROOT,
  "ESP32-S3": path.join(GIT_DIR, "ESP32-S3"),
  "2playerCrosspad": path.join(GIT_DIR, "2playerCrosspad"),
};

let cachedRepos: Record<string, string> | null = null;

/** Returns only repos that actually exist on disk. Cached for server lifetime. */
export function getRepos(): Record<string, string> {
  if (cachedRepos) return cachedRepos;

  const found: Record<string, string> = {};
  for (const [name, repoPath] of Object.entries(REPO_CANDIDATES)) {
    if (fs.existsSync(repoPath)) {
      found[name] = repoPath;
    }
  }

  cachedRepos = found;
  return found;
}

// Legacy compat — some tool files still import REPOS directly
export const REPOS = REPO_CANDIDATES;

// ═══════════════════════════════════════════════════════════════════════
// CROSSPAD-CORE RESOLUTION — finds crosspad-core wherever it lives
// ═══════════════════════════════════════════════════════════════════════

let cachedCrosspadCorePath: string | null | undefined = undefined;

/**
 * Resolve the crosspad-core include path. Checks:
 * 1. Standalone repo at $GIT_DIR/crosspad-core
 * 2. Submodule inside platform-idf: $IDF_ROOT/components/crosspad-core
 * 3. Submodule inside crosspad-pc: $PC_ROOT/crosspad-core
 * Returns null if not found anywhere.
 */
export function resolveCrosspadCore(): string | null {
  if (cachedCrosspadCorePath !== undefined) return cachedCrosspadCorePath;

  const candidates = [
    path.join(GIT_DIR, "crosspad-core"),
    path.join(CROSSPAD_IDF_ROOT, "components", "crosspad-core"),
    path.join(CROSSPAD_PC_ROOT, "crosspad-core"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(path.join(p, "include", "crosspad"))) {
      cachedCrosspadCorePath = p;
      return p;
    }
  }

  cachedCrosspadCorePath = null;
  return null;
}
