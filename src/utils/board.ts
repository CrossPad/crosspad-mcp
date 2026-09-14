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

/** tools/crosspad_board.py decides; this only asks it. `device` (a crosspad-hil id) asks about that board alone. */
export function resolveBoard(board?: string, device?: string): Promise<BoardDecision> {
  const argv = [path.join(CROSSPAD_IDF_ROOT, "tools", "crosspad_board.py"), "--json"];
  if (board) argv.push("--board", board);
  if (device) argv.push("--device", device);
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
