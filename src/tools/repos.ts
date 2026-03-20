import fs from "fs";
import path from "path";
import { REPOS, CROSSPAD_PC_ROOT } from "../config.js";
import { getRepoStatus, getSubmodulePin, getHead, RepoStatus } from "../utils/git.js";

export interface SubmoduleSync {
  pinned: string | null;
  local_head: string | null;
  in_sync: boolean;
}

export interface ReposStatusResult {
  repos: RepoStatus[];
  crosspad_pc_mode: "dev-mode" | "submodule-mode" | "unknown";
  submodule_sync: Record<string, SubmoduleSync>;
}

function detectMode(): "dev-mode" | "submodule-mode" | "unknown" {
  const corePath = path.join(CROSSPAD_PC_ROOT, "crosspad-core");
  try {
    const stat = fs.lstatSync(corePath);
    // Windows junctions report as symlinks in Node.js
    if (stat.isSymbolicLink()) return "dev-mode";
    // Check for .git file (submodule) or .git dir
    const gitPath = path.join(corePath, ".git");
    if (fs.existsSync(gitPath)) return "submodule-mode";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function crosspadReposStatus(): ReposStatusResult {
  const repos: RepoStatus[] = [];

  for (const [name, repoPath] of Object.entries(REPOS)) {
    try {
      if (fs.existsSync(repoPath)) {
        repos.push(getRepoStatus(name, repoPath));
      } else {
        repos.push({
          name,
          path: repoPath,
          branch: "",
          head: "",
          dirtyFiles: [`(repo not found at ${repoPath})`],
        });
      }
    } catch (err: any) {
      repos.push({
        name,
        path: repoPath,
        branch: "",
        head: "",
        dirtyFiles: [`(error: ${err.message})`],
      });
    }
  }

  const mode = detectMode();

  // Submodule sync info
  const submoduleSync: Record<string, SubmoduleSync> = {};
  for (const sub of ["crosspad-core", "crosspad-gui"]) {
    const pinned = getSubmodulePin(CROSSPAD_PC_ROOT, sub);
    const localHead = REPOS[sub] ? getHead(REPOS[sub]) : null;
    submoduleSync[sub] = {
      pinned,
      local_head: localHead,
      in_sync: pinned !== null && localHead !== null && localHead.startsWith(pinned),
    };
  }

  return { repos, crosspad_pc_mode: mode, submodule_sync: submoduleSync };
}
