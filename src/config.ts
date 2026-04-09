import fs from "fs";
import path from "path";
import os from "os";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

// ═══════════════════════════════════════════════════════════════════════
// BASE PATH — only used as fallback when per-repo env vars are not set
// ═══════════════════════════════════════════════════════════════════════

const GIT_DIR = process.env.CROSSPAD_GIT_DIR || path.join(os.homedir(), "GIT");

// ═══════════════════════════════════════════════════════════════════════
// PER-REPO PATHS — each overridable via its own env var
// Env var takes priority → then flat layout ($GIT_DIR/<name>)
// ═══════════════════════════════════════════════════════════════════════

export const CROSSPAD_PC_ROOT =
  process.env.CROSSPAD_PC_ROOT || path.join(GIT_DIR, "crosspad-pc");

export const CROSSPAD_IDF_ROOT =
  process.env.CROSSPAD_IDF_ROOT || path.join(GIT_DIR, "platform-idf");

const CROSSPAD_ARDUINO_ROOT =
  process.env.CROSSPAD_ARDUINO_ROOT || path.join(GIT_DIR, "ESP32-S3");

const CROSSPAD_CORE_ROOT =
  process.env.CROSSPAD_CORE_ROOT || path.join(GIT_DIR, "crosspad-core");

const CROSSPAD_GUI_ROOT =
  process.env.CROSSPAD_GUI_ROOT || path.join(GIT_DIR, "crosspad-gui");


// ═══════════════════════════════════════════════════════════════════════
// ESP-IDF SDK PATH — fallback chain
// ═══════════════════════════════════════════════════════════════════════

function findIdfPath(): string {
  if (process.env.IDF_PATH) return process.env.IDF_PATH;

  const candidates = [
    path.join(os.homedir(), "esp", "esp-idf"),
    path.join(os.homedir(), "esp", "v5.5.4", "esp-idf"),
    path.join(os.homedir(), "esp", "v5.5", "esp-idf"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

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
// REPOS — dynamic discovery from per-repo paths, cached
// ═══════════════════════════════════════════════════════════════════════

/** Maps repo name → resolved path (from env vars or flat layout default) */
const REPO_CANDIDATES: Record<string, string> = {
  "crosspad-core": CROSSPAD_CORE_ROOT,
  "crosspad-gui": CROSSPAD_GUI_ROOT,
  "crosspad-pc": CROSSPAD_PC_ROOT,
  "platform-idf": CROSSPAD_IDF_ROOT,
  "ESP32-S3": CROSSPAD_ARDUINO_ROOT,
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

// Legacy compat
export const REPOS = REPO_CANDIDATES;

// ═══════════════════════════════════════════════════════════════════════
// CROSSPAD-CORE RESOLUTION — finds crosspad-core wherever it lives
// ═══════════════════════════════════════════════════════════════════════

let cachedCrosspadCorePath: string | null | undefined = undefined;

/**
 * Resolve the crosspad-core path. Checks:
 * 1. Standalone repo ($CROSSPAD_CORE_ROOT or $GIT_DIR/crosspad-core)
 * 2. Submodule inside platform-idf: $IDF_ROOT/components/crosspad-core
 * 3. Submodule inside crosspad-pc: $PC_ROOT/crosspad-core
 * Returns null if not found anywhere.
 */
export function resolveCrosspadCore(): string | null {
  if (cachedCrosspadCorePath !== undefined) return cachedCrosspadCorePath;

  const candidates = [
    CROSSPAD_CORE_ROOT,
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
