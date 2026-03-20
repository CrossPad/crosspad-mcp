import fs from "fs";
import path from "path";
import { CROSSPAD_PC_ROOT, BUILD_DIR, BIN_EXE, REPOS } from "../config.js";
import { runCommand } from "../utils/exec.js";
import { getHead, getSubmodulePin } from "../utils/git.js";

export interface BuildCheckResult {
  needs_reconfigure: boolean;
  needs_rebuild: boolean;
  exe_exists: boolean;
  exe_age_seconds: number | null;
  reasons: string[];
  submodule_changes: Record<string, { pinned: string | null; current: string | null; changed: boolean }>;
  new_source_files: string[];
}

/**
 * Detect whether cmake reconfigure or rebuild is needed.
 * Checks:
 * - Does build/ dir exist?
 * - Does bin/main.exe exist?
 * - Are there new .cpp/.hpp files not in CMakeCache?
 * - Did crosspad-core or crosspad-gui HEAD change vs pinned?
 * - Are there uncommitted changes in source?
 */
export function crosspadBuildCheck(): BuildCheckResult {
  const reasons: string[] = [];
  let needsReconfigure = false;
  let needsRebuild = false;

  // Check build dir
  const buildExists = fs.existsSync(BUILD_DIR);
  if (!buildExists) {
    needsReconfigure = true;
    reasons.push("build/ directory does not exist — need full configure");
  }

  // Check exe
  const exeExists = fs.existsSync(BIN_EXE);
  let exeAgeSeconds: number | null = null;
  if (exeExists) {
    const stat = fs.statSync(BIN_EXE);
    exeAgeSeconds = (Date.now() - stat.mtimeMs) / 1000;
  } else {
    needsRebuild = true;
    reasons.push("bin/main.exe not found — need build");
  }

  // Check for source files newer than exe
  if (exeExists) {
    const exeMtime = fs.statSync(BIN_EXE).mtimeMs;
    const srcDirs = [
      path.join(CROSSPAD_PC_ROOT, "src"),
      path.join(CROSSPAD_PC_ROOT, "crosspad-core", "src"),
      path.join(CROSSPAD_PC_ROOT, "crosspad-core", "include"),
      path.join(CROSSPAD_PC_ROOT, "crosspad-gui", "src"),
      path.join(CROSSPAD_PC_ROOT, "crosspad-gui", "include"),
    ];

    let newerCount = 0;
    for (const dir of srcDirs) {
      if (!fs.existsSync(dir)) continue;
      newerCount += countFilesNewerThan(dir, exeMtime, [".cpp", ".hpp", ".h", ".c"]);
      if (newerCount > 0) break; // One is enough
    }
    if (newerCount > 0) {
      needsRebuild = true;
      reasons.push("Source files are newer than bin/main.exe");
    }
  }

  // Check for new source files not tracked by CMake (GLOB_RECURSE freshness)
  const newSourceFiles: string[] = [];
  if (buildExists) {
    const cacheFile = path.join(BUILD_DIR, "build.ninja");
    if (fs.existsSync(cacheFile)) {
      const ninjaContent = fs.readFileSync(cacheFile, "utf-8");
      // Find .cpp files in src/apps that aren't in build.ninja
      const appsDir = path.join(CROSSPAD_PC_ROOT, "src", "apps");
      if (fs.existsSync(appsDir)) {
        const cppFiles = findFiles(appsDir, [".cpp"]);
        for (const f of cppFiles) {
          const relative = path.relative(CROSSPAD_PC_ROOT, f).replace(/\\/g, "/");
          if (!ninjaContent.includes(relative) && !ninjaContent.includes(path.basename(f))) {
            newSourceFiles.push(relative);
          }
        }
      }
    }
  }

  if (newSourceFiles.length > 0) {
    needsReconfigure = true;
    reasons.push(`${newSourceFiles.length} source file(s) not in build system — need reconfigure`);
  }

  // Submodule changes (dev-mode aware)
  const submoduleChanges: Record<string, { pinned: string | null; current: string | null; changed: boolean }> = {};
  for (const sub of ["crosspad-core", "crosspad-gui"]) {
    const pinned = getSubmodulePin(CROSSPAD_PC_ROOT, sub);
    const subPath = path.join(CROSSPAD_PC_ROOT, sub);
    let current: string | null = null;

    if (fs.existsSync(subPath)) {
      // In dev-mode (junction), get HEAD of the junction target
      const result = runCommand("git rev-parse HEAD", subPath);
      current = result.success ? result.stdout.trim() : null;
    }

    const changed = pinned !== null && current !== null && !current.startsWith(pinned.slice(0, 7));
    submoduleChanges[sub] = { pinned, current, changed };

    if (changed) {
      needsRebuild = true;
      reasons.push(`${sub} HEAD differs from pinned commit`);
    }

    // Check for dirty files in submodule
    if (fs.existsSync(subPath)) {
      const dirty = runCommand("git status --porcelain", subPath);
      if (dirty.success && dirty.stdout.trim().length > 0) {
        const dirtyCount = dirty.stdout.trim().split("\n").length;
        needsRebuild = true;
        reasons.push(`${sub} has ${dirtyCount} dirty file(s)`);
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push("Build appears up to date");
  }

  return {
    needs_reconfigure: needsReconfigure,
    needs_rebuild: needsRebuild || needsReconfigure,
    exe_exists: exeExists,
    exe_age_seconds: exeAgeSeconds !== null ? Math.round(exeAgeSeconds) : null,
    reasons,
    submodule_changes: submoduleChanges,
    new_source_files: newSourceFiles,
  };
}

function countFilesNewerThan(dir: string, thresholdMs: number, extensions: string[]): number {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += countFilesNewerThan(fullPath, thresholdMs, extensions);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > thresholdMs) count++;
      }
      if (count > 0) return count; // Early exit
    }
  } catch {
    // Ignore permission errors etc.
  }
  return count;
}

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFiles(fullPath, extensions));
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore
  }
  return results;
}
