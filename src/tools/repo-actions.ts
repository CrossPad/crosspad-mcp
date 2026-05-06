/**
 * Mutable repo operations: submodule update and commit.
 *
 * These are intentionally separate from repos.ts (read-only status)
 * to make the mutation surface explicit.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { getRepos, CROSSPAD_PC_ROOT, CROSSPAD_IDF_ROOT } from "../config.js";
import { runCommand } from "../utils/exec.js";
import { spawnSync } from "child_process";

/**
 * Run git in argv mode (no shell). Use for any git invocation that takes
 * user-controlled args (refs, paths). Returns ExecResult-shaped object so
 * call sites stay uniform.
 */
function git(args: string[], cwd: string, timeoutMs = 30_000) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: timeoutMs });
  return {
    success: r.status === 0,
    stdout: (r.stdout ?? "").replace(/\r\n/g, "\n"),
    stderr: (r.stderr ?? "").replace(/\r\n/g, "\n"),
    exitCode: r.status ?? 1,
  };
}
import { getHead, listSubmodules, findSubmodulePath } from "../utils/git.js";

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

export interface SubmoduleUpdateResult {
  success: boolean;
  submodule: string;
  repo: string;
  old_sha: string | null;
  new_sha: string | null;
  commits_pulled: number;
  changed_files: string[];
  staged: boolean;
  error?: string;
}

export interface CommitResult {
  success: boolean;
  repo: string;
  commit_hash: string | null;
  message: string;
  files_committed: string[];
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// REPO RESOLUTION
// ═══════════════════════════════════════════════════════════════════════

interface RepoInfo {
  name: string;
  root: string;
}

const REPO_ALIASES: Record<string, string> = {
  idf: "platform-idf",
  pc: "crosspad-pc",
  arduino: "ESP32-S3",
  core: "crosspad-core",
  gui: "crosspad-gui",
};

function resolveRepo(repo: string): RepoInfo | null {
  const repos = getRepos();
  const canonical = REPO_ALIASES[repo] ?? repo;

  if (repos[canonical]) {
    return { name: canonical, root: repos[canonical] };
  }

  return null;
}

function getAvailableRepoNames(): string[] {
  return Object.keys(getRepos());
}

// ═══════════════════════════════════════════════════════════════════════
// SUBMODULE PATH RESOLUTION — dynamic via .gitmodules
// ═══════════════════════════════════════════════════════════════════════

function getSubmodulePath(repoRoot: string, submodule: string): string | null {
  return findSubmodulePath(repoRoot, submodule);
}

// ═══════════════════════════════════════════════════════════════════════
// SUBMODULE UPDATE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Update a submodule in a parent repo to the latest commit on its tracking branch.
 *
 * Workflow:
 * 1. cd into submodule
 * 2. git fetch origin
 * 3. git checkout origin/<branch> (default: main)
 * 4. cd back to parent, git add <submodule>
 * 5. Report old→new SHA, commits pulled, files changed
 */
export function crosspadSubmoduleUpdate(
  submodule: string,
  repo: string,
  branch: string = "main",
): SubmoduleUpdateResult {
  const resolvedRepo = resolveRepo(repo);
  if (!resolvedRepo) {
    return {
      success: false,
      submodule,
      repo,
      old_sha: null,
      new_sha: null,
      commits_pulled: 0,
      changed_files: [],
      staged: false,
      error: `Unknown repo "${repo}". Available: ${getAvailableRepoNames().join(", ")}`,
    };
  }

  const subPath = getSubmodulePath(resolvedRepo.root, submodule);
  if (!subPath) {
    const knownSubs = Object.keys(listSubmodules(resolvedRepo.root));
    return {
      success: false,
      submodule,
      repo: resolvedRepo.name,
      old_sha: null,
      new_sha: null,
      commits_pulled: 0,
      changed_files: [],
      staged: false,
      error: `Submodule "${submodule}" not found in ${resolvedRepo.name}. Known: ${knownSubs.join(", ")}`,
    };
  }

  const fullSubPath = path.join(resolvedRepo.root, subPath);
  if (!fs.existsSync(fullSubPath)) {
    return {
      success: false,
      submodule,
      repo: resolvedRepo.name,
      old_sha: null,
      new_sha: null,
      commits_pulled: 0,
      changed_files: [],
      staged: false,
      error: `Submodule directory not found: ${fullSubPath}`,
    };
  }

  // Get current SHA
  const oldSha = getHead(fullSubPath);

  // Fetch latest
  const fetchResult = git(["fetch", "origin"], fullSubPath, 30_000);
  if (!fetchResult.success) {
    return {
      success: false,
      submodule,
      repo: resolvedRepo.name,
      old_sha: oldSha,
      new_sha: null,
      commits_pulled: 0,
      changed_files: [],
      staged: false,
      error: `git fetch failed: ${fetchResult.stderr}`,
    };
  }

  // Checkout target — argv mode keeps `branch` out of any shell.
  const checkoutResult = git(["checkout", `origin/${branch}`], fullSubPath, 15_000);
  if (!checkoutResult.success) {
    return {
      success: false,
      submodule,
      repo: resolvedRepo.name,
      old_sha: oldSha,
      new_sha: null,
      commits_pulled: 0,
      changed_files: [],
      staged: false,
      error: `git checkout origin/${branch} failed: ${checkoutResult.stderr}`,
    };
  }

  // Get new SHA
  const newSha = getHead(fullSubPath);

  // Count commits between old and new
  let commitsPulled = 0;
  let changedFiles: string[] = [];

  if (oldSha && newSha && oldSha !== newSha) {
    const range = `${oldSha}..${newSha}`;
    const countResult = git(["rev-list", "--count", range], fullSubPath);
    if (countResult.success) {
      commitsPulled = parseInt(countResult.stdout.trim(), 10) || 0;
    }

    const diffResult = git(["diff", "--name-only", range], fullSubPath);
    if (diffResult.success) {
      changedFiles = diffResult.stdout
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
    }
  }

  // Stage the submodule update in parent repo
  const addResult = git(["add", "--", subPath], resolvedRepo.root, 10_000);

  return {
    success: true,
    submodule,
    repo: resolvedRepo.name,
    old_sha: oldSha,
    new_sha: newSha,
    commits_pulled: commitsPulled,
    changed_files: changedFiles,
    staged: addResult.success,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// COMMIT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Commit changes in a specific repo.
 *
 * Safety:
 * - Refuses if working tree has merge conflicts
 * - If files specified, stages only those files
 * - If no files specified, commits whatever is currently staged
 * - Never pushes to remote
 */
export function crosspadCommit(
  repo: string,
  message: string,
  files?: string[],
): CommitResult {
  const resolvedRepo = resolveRepo(repo);
  if (!resolvedRepo) {
    return {
      success: false,
      repo,
      commit_hash: null,
      message,
      files_committed: [],
      error: `Unknown repo "${repo}". Available: ${getAvailableRepoNames().join(", ")}`,
    };
  }

  // Check for merge conflicts
  const statusResult = git(["status", "--porcelain"], resolvedRepo.root);
  if (statusResult.success) {
    const conflicted = statusResult.stdout
      .split("\n")
      .filter((l) => l.startsWith("UU") || l.startsWith("AA") || l.startsWith("DD"));
    if (conflicted.length > 0) {
      return {
        success: false,
        repo: resolvedRepo.name,
        commit_hash: null,
        message,
        files_committed: [],
        error: `Merge conflicts detected:\n${conflicted.join("\n")}\nResolve conflicts before committing.`,
      };
    }
  }

  // Use a private 0700 scratch dir for pathspec + commit-message tempfiles.
  // Default umask leaves files in os.tmpdir() world-readable on multi-user
  // hosts; mkdtemp creates a 0700 dir, and we write files with mode 0600.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-"));
  const cleanup = () => {
    try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  try {
    // Stage specific files if provided — use --pathspec-from-file to avoid
    // shell-quoting issues (paths with spaces, quotes, backslashes).
    if (files && files.length > 0) {
      const pathspecFile = path.join(scratchDir, "pathspec");
      fs.writeFileSync(pathspecFile, files.join("\n"), { encoding: "utf-8", mode: 0o600 });
      const addResult = git(
        ["add", `--pathspec-from-file=${pathspecFile}`],
        resolvedRepo.root,
        10_000,
      );
      if (!addResult.success) {
        return {
          success: false,
          repo: resolvedRepo.name,
          commit_hash: null,
          message,
          files_committed: [],
          error: `git add failed: ${addResult.stderr}`,
        };
      }
    }

    // Check something is staged
    const diffResult = git(["diff", "--cached", "--name-only"], resolvedRepo.root);
    const stagedFiles = diffResult.success
      ? diffResult.stdout.trim().split("\n").filter((l) => l.length > 0)
      : [];

    if (stagedFiles.length === 0) {
      return {
        success: false,
        repo: resolvedRepo.name,
        commit_hash: null,
        message,
        files_committed: [],
        error: "Nothing staged to commit. Stage files first or specify files parameter.",
      };
    }

    // Commit via tempfile to avoid shell-quoting issues (newlines, quotes,
    // backticks) on both bash and Windows cmd.
    const msgFile = path.join(scratchDir, "commit.msg");
    fs.writeFileSync(msgFile, message, { encoding: "utf-8", mode: 0o600 });
    const commitResult = git(
      ["commit", "-F", msgFile],
      resolvedRepo.root,
      30_000,
    );

    if (!commitResult.success) {
      return {
        success: false,
        repo: resolvedRepo.name,
        commit_hash: null,
        message,
        files_committed: stagedFiles,
        error: `git commit failed: ${commitResult.stderr || commitResult.stdout}`,
      };
    }

    // Get the new commit hash
    const hashResult = git(["rev-parse", "HEAD"], resolvedRepo.root);
    const commitHash = hashResult.success ? hashResult.stdout.trim() : null;

    return {
      success: true,
      repo: resolvedRepo.name,
      commit_hash: commitHash,
      message,
      files_committed: stagedFiles,
    };
  } finally {
    cleanup();
  }
}
