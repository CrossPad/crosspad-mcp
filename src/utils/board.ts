import { execFile } from "child_process";
import path from "path";
import { CROSSPAD_IDF_ROOT } from "../config.js";

export interface BoardDecision {
  rev: "v1" | "v2" | null;
  source: string;
  device: string | null;
  pcb: number | null;
  fw_rev: string | null;
  build_dir: string | null;
  sdkconfig: string | null;
  mismatch: boolean;
}

const RESOLVE_TIMEOUT_MS = 45_000;

/** tools/crosspad_board.py decides; this only asks it. */
export function resolveBoard(board?: string): Promise<BoardDecision> {
  const argv = [path.join(CROSSPAD_IDF_ROOT, "tools", "crosspad_board.py"), "--json"];
  if (board) argv.push("--board", board);
  return new Promise((resolve, reject) => {
    execFile("python3", argv, { cwd: CROSSPAD_IDF_ROOT, timeout: RESOLVE_TIMEOUT_MS }, (e, stdout) => {
      try {
        resolve(JSON.parse(stdout) as BoardDecision);
      } catch {
        reject(new Error(`crosspad_board.py gave no decision: ${e?.message ?? stdout}`));
      }
    });
  });
}

export function idfArgs(d: BoardDecision): string[] {
  return ["-B", d.build_dir!, `-DSDKCONFIG=${d.sdkconfig}`];
}
