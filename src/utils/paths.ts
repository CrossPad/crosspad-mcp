// src/utils/paths.ts — the path allowlist (spec §4.3).
//
// Every path a caller hands the server — a firmware to flash, a WAV to write, a
// console log to decode, an ELF to symbolize — is resolved (symlinks and all)
// and must land inside a directory this machine actually uses for CrossPad
// work. The rule is containment, not shape: `/etc/passwd` is not a console log
// because it does not live anywhere a console log could, and no amount of
// naming it `log_file` makes it one.
//
// Deliberately not an extension or filename check: the caller picks the
// parameter name, so only the location can be trusted.
import fs from "fs";
import os from "os";
import path from "path";
import { HilError } from "../hil/daemon.js";
import { IS_WINDOWS, REPOS } from "../config.js";

export const ALLOWED_PATHS_ENV = "CROSSPAD_MCP_ALLOWED_PATHS";
export const PATH_NOT_ALLOWED = "PATH_NOT_ALLOWED";

/** Scratch directories under $TMPDIR carry this prefix and nothing else does. */
const TMP_PREFIX = "crosspad-";

/** Work directories the server writes into, relative to wherever it was started. */
const CWD_ROOTS = ["hil_logs", "recordings"];

/**
 * `fs.realpathSync` for a path that may not exist yet — `out` names a file the
 * capture is about to create. Resolve as much of the chain as exists and keep
 * the rest verbatim, following a dangling symlink by hand: a link inside an
 * allowed root pointing at /etc is the one case a plain "parent exists, good
 * enough" check would wave through.
 */
export function realpathLoose(p: string, depth = 0): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    /* not there yet, or a link with no target */
  }
  if (depth < 16) {
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) {
        return realpathLoose(path.resolve(path.dirname(abs), fs.readlinkSync(abs)), depth + 1);
      }
    } catch {
      /* not a symlink either — it simply does not exist */
    }
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  return path.join(realpathLoose(parent, depth), path.basename(abs));
}

function sameOrInside(child: string, root: string): boolean {
  const a = IS_WINDOWS ? child.toLowerCase() : child;
  const b = IS_WINDOWS ? root.toLowerCase() : root;
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** The fixed roots: every configured repo, plus the server's own work dirs. */
export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [
    ...Object.values(REPOS),
    ...CWD_ROOTS.map((d) => path.resolve(process.cwd(), d)),
    ...(env[ALLOWED_PATHS_ENV] ?? "")
      .split(path.delimiter)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => path.resolve(s)),
  ].map((r) => realpathLoose(r));
  return [...new Set(roots)];
}

/** $TMPDIR/crosspad-* — a family of roots, so it is matched rather than listed. */
function underTmpScratch(resolved: string, env: NodeJS.ProcessEnv): boolean {
  const tmp = realpathLoose(env.TMPDIR || env.TMP || os.tmpdir());
  if (!sameOrInside(resolved, tmp) || resolved === tmp) return false;
  const first = path.relative(tmp, resolved).split(path.sep)[0];
  return first.startsWith(TMP_PREFIX) && first.length > TMP_PREFIX.length;
}

/** What the rejection tells the caller — the roots, named. */
export function describeAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const tmp = env.TMPDIR || env.TMP || os.tmpdir();
  return [...allowedRoots(env), path.join(tmp, `${TMP_PREFIX}*`)];
}

export function isAllowedPath(p: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = realpathLoose(p);
  if (underTmpScratch(resolved, env)) return true;
  return allowedRoots(env).some((root) => sameOrInside(resolved, root));
}

/**
 * Gate one path-valued tool argument. Returns the resolved path so a caller can
 * use it; throws a typed HilError naming the roots and the escape hatch when it
 * lands outside. `undefined` passes through untouched — an argument that was
 * never given cannot point anywhere.
 */
export function assertAllowedPath(
  param: string,
  given: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (given === undefined || given === null || given === "") return undefined;
  if (typeof given !== "string") {
    throw new HilError(PATH_NOT_ALLOWED, `${param} must be a path string.`);
  }
  const resolved = realpathLoose(given);
  if (isAllowedPath(given, env)) return resolved;
  const roots = describeAllowedRoots(env);
  throw new HilError(
    PATH_NOT_ALLOWED,
    `${param}="${given}" resolves to ${resolved}, which is outside every allowed root.`,
    `Allowed roots: ${roots.join(", ")}. Add another with ${ALLOWED_PATHS_ENV} (${path.delimiter}-separated) and restart the server.`,
    { param, given, resolved, allowed_roots: roots },
  );
}
