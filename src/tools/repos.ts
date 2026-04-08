import fs from "fs";
import path from "path";
import { getRepos, CROSSPAD_PC_ROOT, CROSSPAD_IDF_ROOT } from "../config.js";
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

function detectMode(rootPath: string): "dev-mode" | "submodule-mode" | "unknown" {
  const corePath = path.join(rootPath, "crosspad-core");
  try {
    const stat = fs.lstatSync(corePath);
    if (stat.isSymbolicLink()) return "dev-mode";
    const gitPath = path.join(corePath, ".git");
    if (fs.existsSync(gitPath)) return "submodule-mode";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function crosspadReposStatus(): ReposStatusResult {
  const repos: RepoStatus[] = [];
  const discovered = getRepos();

  for (const [name, repoPath] of Object.entries(discovered)) {
    try {
      repos.push(getRepoStatus(name, repoPath));
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

  const mode = fs.existsSync(CROSSPAD_PC_ROOT)
    ? detectMode(CROSSPAD_PC_ROOT)
    : "unknown";

  // Submodule sync info — check both crosspad-pc and platform-idf
  const submoduleSync: Record<string, SubmoduleSync> = {};

  const parentRepos = [
    { name: "crosspad-pc", root: CROSSPAD_PC_ROOT },
    { name: "platform-idf", root: CROSSPAD_IDF_ROOT },
  ];

  for (const parent of parentRepos) {
    if (!fs.existsSync(parent.root)) continue;

    for (const sub of ["crosspad-core", "crosspad-gui"]) {
      const subPath = path.join(parent.root, sub.includes("/") ? sub : `components/${sub}`);
      // crosspad-pc has crosspad-core at root, platform-idf has it in components/
      const actualSubPath = fs.existsSync(path.join(parent.root, sub))
        ? sub
        : `components/${sub}`;

      const pinned = getSubmodulePin(parent.root, actualSubPath);
      if (pinned === null) continue; // not a submodule in this repo

      let localHead: string | null = null;
      const fullSubPath = path.join(parent.root, actualSubPath);
      if (fs.existsSync(fullSubPath)) {
        localHead = getHead(fullSubPath);
      }

      const key = `${parent.name}/${sub}`;
      submoduleSync[key] = {
        pinned,
        local_head: localHead,
        in_sync: pinned !== null && localHead !== null && localHead.startsWith(pinned.slice(0, 7)),
      };
    }
  }

  return { repos, crosspad_pc_mode: mode, submodule_sync: submoduleSync };
}
