import fs from "fs";
import path from "path";
import { getRepos, CROSSPAD_PC_ROOT, CROSSPAD_IDF_ROOT } from "../config.js";
import { getRepoStatuses, getSubmodulePin, getHead, listSubmodules, findSubmodulePath, type GitOpts, RepoStatus } from "../utils/git.js";
import { mapLimit, DEFAULT_CONCURRENCY } from "../utils/async.js";

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

async function detectMode(rootPath: string, opts: GitOpts): Promise<"dev-mode" | "submodule-mode" | "unknown"> {
  const subs = await listSubmodules(rootPath, opts);
  const corePathRel = subs["crosspad-core"];
  if (!corePathRel) return "unknown";
  const corePath = path.join(rootPath, corePathRel);
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

export async function crosspadReposStatus(opts: GitOpts = {}): Promise<ReposStatusResult> {
  const discovered = getRepos();

  // Every repo is walked concurrently (DEFAULT_CONCURRENCY gits in flight), so
  // a 6-repo workspace costs one repo's latency, not six. A repo that is not a
  // git checkout reports its own error rather than sinking the whole call.
  const names = Object.keys(discovered);
  const repos: RepoStatus[] = await mapLimit(
    names,
    DEFAULT_CONCURRENCY,
    async (name) => {
      const repoPath = discovered[name];
      try {
        const [status] = await getRepoStatuses({ [name]: repoPath }, { ...opts, limit: 1 });
        return status;
      } catch (err: any) {
        return { name, path: repoPath, branch: "", head: "", dirtyFiles: [`(error: ${err.message})`] };
      }
    },
    opts.signal,
  );

  const mode = fs.existsSync(CROSSPAD_PC_ROOT)
    ? await detectMode(CROSSPAD_PC_ROOT, opts)
    : "unknown";

  // Submodule sync info — check both crosspad-pc and platform-idf
  const submoduleSync: Record<string, SubmoduleSync> = {};

  const parentRepos = [
    { name: "crosspad-pc", root: CROSSPAD_PC_ROOT },
    { name: "platform-idf", root: CROSSPAD_IDF_ROOT },
  ];

  const pairs: Array<{ parent: string; root: string; sub: string }> = [];
  for (const parent of parentRepos) {
    if (!fs.existsSync(parent.root)) continue;
    for (const sub of ["crosspad-core", "crosspad-gui"]) {
      pairs.push({ parent: parent.name, root: parent.root, sub });
    }
  }

  const syncs = await mapLimit(
    pairs,
    DEFAULT_CONCURRENCY,
    async ({ parent, root, sub }) => {
      // findSubmodulePath handles both "<name>" and "<dir>/<name>" entries
      // in .gitmodules (e.g. platform-idf uses "components/crosspad-core").
      const relPath = await findSubmodulePath(root, sub, opts);
      if (!relPath) return null; // not a submodule in this parent

      const pinned = await getSubmodulePin(root, sub, opts);
      if (pinned === null) return null;

      let localHead: string | null = null;
      const fullSubPath = path.join(root, relPath);
      if (fs.existsSync(fullSubPath)) {
        localHead = await getHead(fullSubPath, opts);
      }

      return {
        key: `${parent}/${sub}`,
        value: {
          pinned,
          local_head: localHead,
          in_sync: pinned !== null && localHead !== null && localHead.startsWith(pinned.slice(0, 7)),
        },
      };
    },
    opts.signal,
  );

  for (const entry of syncs) {
    if (entry) submoduleSync[entry.key] = entry.value;
  }

  return { repos, crosspad_pc_mode: mode, submodule_sync: submoduleSync };
}
