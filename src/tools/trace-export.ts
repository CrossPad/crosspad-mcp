import fs from "fs";
import { TraceBuffer } from "./trace-buffer.js";

/** Render the buffer as CSV. Uses the documented samples() accessor on TraceBuffer. */
export function bufferToCsv(buf: TraceBuffer, signals: string[]): string {
  const rows: string[] = [signals.length ? `t,${signals.join(",")}` : "t"];
  for (const s of buf.samples()) {
    const cells = signals.map((sig) => (sig in s.values ? String(s.values[sig]) : ""));
    rows.push([String(s.t), ...cells].join(","));
  }
  return rows.join("\n");
}

export function writeCsv(path: string, buf: TraceBuffer, signals: string[]): void {
  fs.writeFileSync(path, bufferToCsv(buf, signals));
}
