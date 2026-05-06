import fs from "fs";
import path from "path";
import { runCommand } from "./exec.js";

export interface RepoStatus {
  name: string;
  path: string;
  branch: string;
  head: string;
  dirtyFiles: string[];
}

export function getRepoStatus(name: string, repoPath: string): RepoStatus {
  const branch = runCommand("git branch --show-current", repoPath);
  const log = runCommand("git log --oneline -1", repoPath);
  const status = runCommand("git status --porcelain", repoPath);

  return {
    name,
    path: repoPath,
    branch: branch.stdout.trim(),
    head: log.stdout.trim(),
    dirtyFiles: status.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0),
  };
}

/**
 * Get the pinned commit hash of a submodule.
 *
 * `submodule` may be either a canonical name (e.g. "crosspad-core") or a
 * relative path (e.g. "lib/crosspad-core"). Names are resolved via .gitmodules.
 */
export function getSubmodulePin(
  repoPath: string,
  submodule: string
): string | null {
  // Resolve name → path if needed
  let subPath = submodule;
  const subs = listSubmodules(repoPath);
  if (!subs[submodule] && Object.values(subs).includes(submodule)) {
    // already a path, keep as-is
  } else {
    const resolved = findSubmodulePath(repoPath, submodule);
    if (resolved) subPath = resolved;
  }

  const result = runCommand(
    `git submodule status "${subPath}"`,
    repoPath
  );
  if (!result.success) return null;
  // Output format: " abc1234 submodule-name (desc)" or "+abc1234 ..."
  const match = result.stdout.match(/[+ -]?([0-9a-f]+)/);
  return match ? match[1] : null;
}

export function getHead(repoPath: string): string | null {
  const result = runCommand("git rev-parse HEAD", repoPath);
  return result.success ? result.stdout.trim() : null;
}

/**
 * Parse `.gitmodules` and return map of submodule name → path within parent.
 * Returns empty map if no submodules or `.gitmodules` missing.
 *
 * Cached per repoPath since `.gitmodules` rarely changes during server lifetime.
 */
const submoduleMapCache: Map<string, Record<string, string>> = new Map();

export function listSubmodules(repoPath: string): Record<string, string> {
  const cached = submoduleMapCache.get(repoPath);
  if (cached) return cached;

  const gitmodules = path.join(repoPath, ".gitmodules");
  if (!fs.existsSync(gitmodules)) {
    submoduleMapCache.set(repoPath, {});
    return {};
  }

  // git config returns lines like: submodule.<name>.path <relative-path>
  const result = runCommand(
    `git config -f .gitmodules --get-regexp "^submodule\\..*\\.path$"`,
    repoPath
  );
  const map: Record<string, string> = {};
  if (result.success) {
    for (const line of result.stdout.split("\n")) {
      const m = line.match(/^submodule\.(.+)\.path\s+(.+)$/);
      if (m) map[m[1]] = m[2].trim();
    }
  }

  submoduleMapCache.set(repoPath, map);
  return map;
}

/** Resolve a submodule's path within a parent repo by canonical name. Null if not present. */
export function findSubmodulePath(repoPath: string, submoduleName: string): string | null {
  const subs = listSubmodules(repoPath);
  if (subs[submoduleName]) return subs[submoduleName];

  // Fallback: search by basename match (e.g. "crosspad-core" matching "lib/crosspad-core")
  for (const [, p] of Object.entries(subs)) {
    if (path.basename(p) === submoduleName) return p;
  }
  return null;
}
