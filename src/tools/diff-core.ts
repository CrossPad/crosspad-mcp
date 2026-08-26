import fs from "fs";
import path from "path";
import { CROSSPAD_PC_ROOT, CROSSPAD_IDF_ROOT } from "../config.js";
import { git, getSubmodulePin, findSubmodulePath, type GitOpts } from "../utils/git.js";

export interface DiffEntry {
  status: string; // A, M, D, R
  file: string;
}

export interface SubmoduleDiff {
  name: string;
  pinned_commit: string | null;
  current_commit: string | null;
  is_dev_mode: boolean;
  ahead_count: number;
  behind_count: number;
  changed_files: DiffEntry[];
  uncommitted_changes: string[];
  commit_log: string[];
}

export interface DiffCoreResult {
  parent_repo: string;
  submodules: SubmoduleDiff[];
}

/**
 * Show what changed in crosspad-core and/or crosspad-gui relative to the
 * pinned submodule commit. Essential for dev-mode workflows where you're
 * editing shared repos but haven't committed/pinned yet.
 *
 * Submodule paths are resolved dynamically from .gitmodules (handles both
 * `crosspad-core` and `lib/crosspad-core` layouts).
 */
export async function crosspadDiffCore(
  submodule: "crosspad-core" | "crosspad-gui" | "both" = "both",
  parent: "crosspad-pc" | "platform-idf" = "crosspad-pc",
  opts: GitOpts = {},
): Promise<DiffCoreResult> {
  const parentRoot = parent === "platform-idf" ? CROSSPAD_IDF_ROOT : CROSSPAD_PC_ROOT;

  const targets = submodule === "both"
    ? ["crosspad-core", "crosspad-gui"]
    : [submodule];

  const submodules: SubmoduleDiff[] = [];

  for (const sub of targets) {
    const relPath = await findSubmodulePath(parentRoot, sub, opts);
    const subPath = relPath ? path.join(parentRoot, relPath) : path.join(parentRoot, sub);
    const isDevMode = isJunction(subPath);
    const pinnedCommit = await getSubmodulePin(parentRoot, sub, opts);

    // Get current HEAD
    const headResult = await git("git rev-parse HEAD", subPath, opts);
    const currentCommit = headResult.success ? headResult.stdout.trim() : null;

    let aheadCount = 0;
    let behindCount = 0;
    let changedFiles: DiffEntry[] = [];
    let commitLog: string[] = [];

    if (pinnedCommit && currentCommit && pinnedCommit !== currentCommit) {
      // Count commits ahead/behind
      const countResult = await git(
        `git rev-list --count --left-right ${pinnedCommit}...HEAD`,
        subPath,
        opts,
      );
      if (countResult.success) {
        const parts = countResult.stdout.trim().split(/\s+/);
        behindCount = parseInt(parts[0] || "0", 10);
        aheadCount = parseInt(parts[1] || "0", 10);
      }

      // Get diff stat (files changed between pinned and HEAD)
      const diffResult = await git(
        `git diff --name-status ${pinnedCommit}...HEAD`,
        subPath,
        opts,
      );
      if (diffResult.success) {
        changedFiles = diffResult.stdout
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((line) => {
            const parts = line.split("\t");
            return { status: parts[0], file: parts.slice(1).join("\t") };
          });
      }

      // Get commit log between pinned and HEAD
      const logResult = await git(
        `git log --oneline ${pinnedCommit}..HEAD`,
        subPath,
        opts,
      );
      if (logResult.success) {
        commitLog = logResult.stdout
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .slice(0, 20); // Cap at 20
      }
    }

    // Uncommitted changes (working tree)
    const statusResult = await git("git status --porcelain", subPath, opts);
    const uncommittedChanges = statusResult.success
      ? statusResult.stdout
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
      : [];

    submodules.push({
      name: sub,
      pinned_commit: pinnedCommit,
      current_commit: currentCommit,
      is_dev_mode: isDevMode,
      ahead_count: aheadCount,
      behind_count: behindCount,
      changed_files: changedFiles,
      uncommitted_changes: uncommittedChanges,
      commit_log: commitLog,
    });
  }

  return { parent_repo: parent, submodules };
}

function isJunction(p: string): boolean {
  try {
    const stat = fs.lstatSync(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}
