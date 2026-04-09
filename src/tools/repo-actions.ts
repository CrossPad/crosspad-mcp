/**
 * Mutable repo operations: submodule update and commit.
 *
 * These are intentionally separate from repos.ts (read-only status)
 * to make the mutation surface explicit.
 */

import fs from "fs";
import path from "path";
import { getRepos, CROSSPAD_PC_ROOT, CROSSPAD_IDF_ROOT } from "../config.js";
import { runCommand } from "../utils/exec.js";
import { getHead } from "../utils/git.js";

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

  // Try partial match
  for (const [name, repoPath] of Object.entries(repos)) {
    if (name.toLowerCase().includes(repo.toLowerCase())) {
      return { name, root: repoPath };
    }
  }

  return null;
}

function getAvailableRepoNames(): string[] {
  return Object.keys(getRepos());
}

// ═══════════════════════════════════════════════════════════════════════
// SUBMODULE PATHS — where each submodule lives inside parent repos
// ═══════════════════════════════════════════════════════════════════════

const SUBMODULE_PATHS: Record<string, Record<string, string>> = {
  "platform-idf": {
    "crosspad-core": "components/crosspad-core",
    "crosspad-gui": "components/crosspad-gui",
    "crosspad-instructions": "components/crosspad-instructions",
    "crosspad-sampler": "components/crosspad-sampler",
  },
  "crosspad-pc": {
    "crosspad-core": "crosspad-core",
    "crosspad-gui": "crosspad-gui",
  },
  "ESP32-S3": {
    "crosspad-core": "lib/crosspad-core",
    "crosspad-gui": "lib/crosspad-gui",
  },
};

function getSubmodulePath(repoName: string, submodule: string): string | null {
  return SUBMODULE_PATHS[repoName]?.[submodule] ?? null;
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

  const subPath = getSubmodulePath(resolvedRepo.name, submodule);
  if (!subPath) {
    const knownSubs = Object.keys(SUBMODULE_PATHS[resolvedRepo.name] ?? {});
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
  const fetchResult = runCommand("git fetch origin", fullSubPath, 30_000);
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

  // Checkout target
  const checkoutResult = runCommand(`git checkout origin/${branch}`, fullSubPath, 15_000);
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
    const countResult = runCommand(`git rev-list --count ${oldSha}..${newSha}`, fullSubPath);
    if (countResult.success) {
      commitsPulled = parseInt(countResult.stdout.trim(), 10) || 0;
    }

    const diffResult = runCommand(`git diff --name-only ${oldSha}..${newSha}`, fullSubPath);
    if (diffResult.success) {
      changedFiles = diffResult.stdout
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
    }
  }

  // Stage the submodule update in parent repo
  const addResult = runCommand(`git add ${subPath}`, resolvedRepo.root, 10_000);

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
  const statusResult = runCommand("git status --porcelain", resolvedRepo.root);
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

  // Stage specific files if provided
  if (files && files.length > 0) {
    const fileList = files.map((f) => `"${f}"`).join(" ");
    const addResult = runCommand(`git add ${fileList}`, resolvedRepo.root, 10_000);
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
  const diffResult = runCommand("git diff --cached --name-only", resolvedRepo.root);
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

  // Commit — escape message for shell safety
  const escapedMessage = message.replace(/'/g, "'\\''");
  const commitResult = runCommand(`git commit -m '${escapedMessage}'`, resolvedRepo.root, 30_000);

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
  const hashResult = runCommand("git rev-parse HEAD", resolvedRepo.root);
  const commitHash = hashResult.success ? hashResult.stdout.trim() : null;

  return {
    success: true,
    repo: resolvedRepo.name,
    commit_hash: commitHash,
    message,
    files_committed: stagedFiles,
  };
}
