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

export function getSubmodulePin(
  repoPath: string,
  submodule: string
): string | null {
  const result = runCommand(
    `git submodule status ${submodule}`,
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
