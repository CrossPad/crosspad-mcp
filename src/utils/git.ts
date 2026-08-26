import fs from "fs";
import path from "path";
import { runCommandStream, type ExecResult } from "./exec.js";
import { mapLimit, DEFAULT_CONCURRENCY } from "./async.js";

/** Options every git helper takes: cancellation from `extra.signal`, and a timeout. */
export interface GitOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const noop = () => {};

/**
 * Run one git command without blocking the event loop.
 *
 * v10 rule (spec §3.7): nothing on the request path may use execSync — a
 * synchronous git in a repo with a cold cache stalls every other in-flight
 * request, and it cannot be cancelled. runCommandStream spawns, so it can be
 * both awaited and aborted.
 */
export function git(cmd: string, cwd: string, opts: GitOpts = {}): Promise<ExecResult> {
  return runCommandStream(cmd, cwd, noop, opts.timeoutMs ?? 60_000, opts.signal);
}

export interface RepoStatus {
  name: string;
  path: string;
  branch: string;
  head: string;
  dirtyFiles: string[];
}

export async function getRepoStatus(name: string, repoPath: string, opts: GitOpts = {}): Promise<RepoStatus> {
  // Three independent reads of the same repo — issue them together.
  const [branch, log, status] = await Promise.all([
    git("git branch --show-current", repoPath, opts),
    git("git log --oneline -1", repoPath, opts),
    git("git status --porcelain", repoPath, opts),
  ]);

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

/** Status of many repos at once, at most `limit` gits in flight. */
export function getRepoStatuses(
  repos: Record<string, string>,
  opts: GitOpts & { limit?: number } = {},
): Promise<RepoStatus[]> {
  const entries = Object.entries(repos);
  return mapLimit(entries, opts.limit ?? DEFAULT_CONCURRENCY, ([name, p]) => getRepoStatus(name, p, opts), opts.signal);
}

/**
 * Get the pinned commit hash of a submodule.
 *
 * `submodule` may be either a canonical name (e.g. "crosspad-core") or a
 * relative path (e.g. "lib/crosspad-core"). Names are resolved via .gitmodules.
 */
export async function getSubmodulePin(
  repoPath: string,
  submodule: string,
  opts: GitOpts = {},
): Promise<string | null> {
  // Resolve name → path if needed
  let subPath = submodule;
  const subs = await listSubmodules(repoPath, opts);
  if (!subs[submodule] && Object.values(subs).includes(submodule)) {
    // already a path, keep as-is
  } else {
    const resolved = await findSubmodulePath(repoPath, submodule, opts);
    if (resolved) subPath = resolved;
  }

  const result = await git(`git submodule status "${subPath}"`, repoPath, opts);
  if (!result.success) return null;
  // Output format: " abc1234 submodule-name (desc)" or "+abc1234 ..."
  const match = result.stdout.match(/[+ -]?([0-9a-f]+)/);
  return match ? match[1] : null;
}

export async function getHead(repoPath: string, opts: GitOpts = {}): Promise<string | null> {
  const result = await git("git rev-parse HEAD", repoPath, opts);
  return result.success ? result.stdout.trim() : null;
}

/**
 * Parse `.gitmodules` and return map of submodule name → path within parent.
 * Returns empty map if no submodules or `.gitmodules` missing.
 *
 * Cached per repoPath since `.gitmodules` rarely changes during server lifetime.
 * The cache stores the promise, so N concurrent callers (mapLimit fans out)
 * share one `git config` run instead of racing to start their own.
 */
const submoduleMapCache: Map<string, Promise<Record<string, string>>> = new Map();

/** @internal exported for testing — drop the .gitmodules cache. */
export function _resetSubmoduleCache(): void {
  submoduleMapCache.clear();
}

export function listSubmodules(repoPath: string, opts: GitOpts = {}): Promise<Record<string, string>> {
  const cached = submoduleMapCache.get(repoPath);
  if (cached) return cached;

  const pending = (async () => {
    const gitmodules = path.join(repoPath, ".gitmodules");
    if (!fs.existsSync(gitmodules)) return {};

    // git config returns lines like: submodule.<name>.path <relative-path>
    const result = await git(
      `git config -f .gitmodules --get-regexp "^submodule\\..*\\.path$"`,
      repoPath,
      opts,
    );
    const map: Record<string, string> = {};
    if (result.success) {
      for (const line of result.stdout.split("\n")) {
        const m = line.match(/^submodule\.(.+)\.path\s+(.+)$/);
        if (m) map[m[1]] = m[2].trim();
      }
    }
    return map;
  })();

  // A failed lookup must not be remembered as "this repo has no submodules".
  submoduleMapCache.set(repoPath, pending);
  pending.catch(() => submoduleMapCache.delete(repoPath));
  return pending;
}

/** Resolve a submodule's path within a parent repo by canonical name. Null if not present. */
export async function findSubmodulePath(
  repoPath: string,
  submoduleName: string,
  opts: GitOpts = {},
): Promise<string | null> {
  const subs = await listSubmodules(repoPath, opts);
  if (subs[submoduleName]) return subs[submoduleName];

  // Fallback: search by basename match (e.g. "crosspad-core" matching "lib/crosspad-core")
  for (const [, p] of Object.entries(subs)) {
    if (path.basename(p) === submoduleName) return p;
  }
  return null;
}
