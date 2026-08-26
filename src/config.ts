import fs from "fs";
import path from "path";
import os from "os";

export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

// ═══════════════════════════════════════════════════════════════════════
// BASE PATH — only used as fallback when per-repo env vars are not set
// ═══════════════════════════════════════════════════════════════════════

export const GIT_DIR = process.env.CROSSPAD_GIT_DIR || path.join(os.homedir(), "GIT");

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

// STM32 firmware (CrossPad r20 single-board target). Separate repo, not a
// submodule of the others — but its code (sleep/power/reg-map/charger) is part
// of day-to-day development, so symbol search / repo status should cover it.
export const CROSSPAD_STM_ROOT =
  process.env.CROSSPAD_STM_ROOT || path.join(GIT_DIR, "CrossPad_STM32_r20");

// Trace defaults (overridable later via user config at call sites).
export const STM_ELF_DEFAULT = path.join(CROSSPAD_STM_ROOT, "build", "Debug", "CrossPad_STM32_r20.elf");
export const TRACE_DIR_DEFAULT = path.join(CROSSPAD_STM_ROOT, "traces");

// ─── STM32 build / flash ─────────────────────────────────────────────────
// CMake project name (artifact basename) and the CMakePresets.json preset
// names. binaryDir is build/<preset> per the preset's `binaryDir` template.
export const STM_PROJECT_NAME = "CrossPad_STM32_r20";
// Flash base address — STM32G0 internal flash origin (matches the *.ld linker
// script ORIGIN and the STM32_Programmer_CLI invocations in CLAUDE.md).
export const STM_FLASH_ADDR = "0x08000000";

export type StmPreset = "Debug" | "Release";

/** Build directory for a preset: <repo>/build/<preset>. */
export function stmBuildDir(preset: StmPreset): string {
  return path.join(CROSSPAD_STM_ROOT, "build", preset);
}

/** Artifact path for a preset, e.g. build/Debug/CrossPad_STM32_r20.elf. */
export function stmArtifact(preset: StmPreset, ext: "elf" | "bin" | "hex"): string {
  return path.join(stmBuildDir(preset), `${STM_PROJECT_NAME}.${ext}`);
}


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
export const BIN_EXE = path.join(CROSSPAD_PC_ROOT, "bin", `CrossPad${EXE_EXT}`);

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
  "stm32-r20": CROSSPAD_STM_ROOT,
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

function readSubmodulePathsFromGitmodules(parentRoot: string): Record<string, string> {
  const gitmodules = path.join(parentRoot, ".gitmodules");
  if (!fs.existsSync(gitmodules)) return {};
  const out: Record<string, string> = {};
  try {
    const content = fs.readFileSync(gitmodules, "utf-8");
    const blocks = content.split(/\[submodule\s+"([^"]+)"\]/);
    for (let i = 1; i < blocks.length; i += 2) {
      const name = blocks[i];
      const body = blocks[i + 1] ?? "";
      const pathMatch = body.match(/^\s*path\s*=\s*(.+)$/m);
      if (pathMatch) out[name] = pathMatch[1].trim();
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Resolve the crosspad-core path. Checks:
 * 1. Standalone repo ($CROSSPAD_CORE_ROOT or $GIT_DIR/crosspad-core)
 * 2. Submodule inside any parent repo (path resolved from .gitmodules)
 * 3. Common conventional fallback paths.
 * Returns null if not found anywhere.
 */
export function resolveCrosspadCore(): string | null {
  if (cachedCrosspadCorePath !== undefined) return cachedCrosspadCorePath;

  const candidates: string[] = [CROSSPAD_CORE_ROOT];

  for (const parentRoot of [CROSSPAD_IDF_ROOT, CROSSPAD_PC_ROOT, CROSSPAD_ARDUINO_ROOT]) {
    const subs = readSubmodulePathsFromGitmodules(parentRoot);
    // Match by exact name first, then by path basename (handles
    // [submodule "components/crosspad-core"] in platform-idf).
    const direct = subs["crosspad-core"];
    if (direct) {
      candidates.push(path.join(parentRoot, direct));
      continue;
    }
    for (const [, p] of Object.entries(subs)) {
      if (path.basename(p) === "crosspad-core") {
        candidates.push(path.join(parentRoot, p));
      }
    }
  }

  // Conventional fallbacks
  candidates.push(
    path.join(CROSSPAD_IDF_ROOT, "components", "crosspad-core"),
    path.join(CROSSPAD_PC_ROOT, "lib", "crosspad-core"),
    path.join(CROSSPAD_PC_ROOT, "crosspad-core"),
    path.join(CROSSPAD_ARDUINO_ROOT, "lib", "crosspad-core"),
  );

  for (const p of candidates) {
    if (fs.existsSync(path.join(p, "include", "crosspad"))) {
      cachedCrosspadCorePath = p;
      return p;
    }
  }

  cachedCrosspadCorePath = null;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// VENDORED SHARED-LIB DISCOVERY — crosspad-core / crosspad-gui are vendored
// as separate, unlinked submodule checkouts in each platform repo (see
// reference/repos.md "triple checkout" warning). Callers that need to WRITE
// to one of these (e.g. crosspad_commit) must know ALL copies exist rather
// than silently picking one — picking wrong silently reintroduces the exact
// "edited the wrong checkout" trap this ecosystem has already hit.
// ═══════════════════════════════════════════════════════════════════════

export interface VendoredCopy {
  /** Which platform repo embeds this copy, e.g. "platform-idf". */
  parentRepo: string;
  /** Absolute path to the vendored submodule checkout. */
  path: string;
}

/**
 * Find every on-disk checkout of a vendored shared library ("crosspad-core"
 * or "crosspad-gui") across all known platform repos, via each repo's
 * .gitmodules. Does NOT include a standalone $CROSSPAD_*_ROOT checkout —
 * callers should check that separately (it's the unambiguous case).
 */
export function findVendoredCopies(name: "crosspad-core" | "crosspad-gui"): VendoredCopy[] {
  const found: VendoredCopy[] = [];
  const parents: Array<[string, string]> = [
    ["platform-idf", CROSSPAD_IDF_ROOT],
    ["crosspad-pc", CROSSPAD_PC_ROOT],
    ["ESP32-S3", CROSSPAD_ARDUINO_ROOT],
  ];

  for (const [label, parentRoot] of parents) {
    const subs = readSubmodulePathsFromGitmodules(parentRoot);
    let subPath = subs[name] ?? null;
    if (!subPath) {
      for (const [, p] of Object.entries(subs)) {
        if (path.basename(p) === name) {
          subPath = p;
          break;
        }
      }
    }
    if (!subPath) continue;

    const full = path.join(parentRoot, subPath);
    if (fs.existsSync(path.join(full, ".git"))) {
      found.push({ parentRepo: label, path: full });
    }
  }

  return found;
}
