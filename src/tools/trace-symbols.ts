// src/tools/trace-symbols.ts
import path from "path";
import { fileURLToPath } from "url";
import { runArgvStream } from "../utils/exec.js";
import { resolveConfigValue } from "../utils/userConfig.js";
import { STM_ELF_DEFAULT } from "../config.js";

export interface TraceSymbol { name: string; address: number; encoding: string; size: number; }
export interface SymbolsResult { success: boolean; symbols: TraceSymbol[]; error?: string; }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** tracer/swd_tracer.py — resolved relative to the dist/ or src/ tree → repo root /tracer. */
export function daemonPath(): string {
  // dist/tools/trace-symbols.js → ../../tracer ; src/tools/*.ts → ../../tracer
  return path.resolve(__dirname, "..", "..", "tracer", "swd_tracer.py");
}
export function resolvedPython(): string {
  return resolveConfigValue("pyocd_python", "CROSSPAD_TRACE_PYTHON", process.env.CROSSPAD_TRACE_PYTHON, "python3");
}
export function resolvedElf(): string {
  return resolveConfigValue("stm_elf_path", "CROSSPAD_STM_ELF", process.env.CROSSPAD_STM_ELF, STM_ELF_DEFAULT);
}

/** Pure: extract the symbols JSON from mixed daemon output. */
export function parseSymbolsOutput(out: string): SymbolsResult {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith("{") && l.includes('"symbols"')) {
      try {
        const obj = JSON.parse(l);
        if (Array.isArray(obj.symbols)) return { success: true, symbols: obj.symbols };
      } catch { /* keep scanning */ }
    }
  }
  return { success: false, symbols: [], error: out.split("\n").filter(Boolean).slice(-3).join(" | ") || "no output" };
}

export async function listSymbols(query?: string, elf?: string, signal?: AbortSignal): Promise<SymbolsResult> {
  const argv = ["symbols", "--elf", elf ?? resolvedElf()];
  if (query) argv.push("--query", query);
  let out = "";
  await runArgvStream(resolvedPython(), [daemonPath(), ...argv], process.cwd(),
    (s, line) => { if (s === "stdout") out += line + "\n"; }, 30_000, signal);
  return parseSymbolsOutput(out);
}
