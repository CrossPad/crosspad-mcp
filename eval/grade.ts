#!/usr/bin/env node
// eval/grade.ts — grade a recorded transcript of tool calls against
// eval/tasks.json. The bug being measured is in todo.md (⭐ Meta-bug): the
// model shells out (`git status`, `grep -r`, `idf.py flash`) instead of calling
// the crosspad_* tool that exists for exactly that job. A task passes only when
// every expected tool was called AND no forbidden shell command was issued.
//
//   node eval/grade.ts transcripts/run-2026-08-26.json
//   node eval/grade.ts transcripts/*.json --json
//
// Transcript file format:
//   { "runs": [ { "task": "<task id>",
//                 "calls": [ { "tool": "Bash", "input": { "command": "git status" } } ] } ] }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EvalTask {
  id: string;
  prompt: string;
  expected_tools: string[];
  forbidden_shell_patterns: string[];
}

export interface ToolCallRecord {
  tool: string;
  input?: Record<string, unknown>;
}

export interface ForbiddenHit {
  pattern: string;
  tool: string;
  command: string;
}

export interface EvalResult {
  id: string;
  passed: boolean;
  used_tools: string[];
  missing_tools: string[];
  forbidden_hits: ForbiddenHit[];
  shell_calls: number;
  notes: string;
}

interface TranscriptRun {
  task: string;
  calls: ToolCallRecord[];
}

/** Tool names that execute a shell command, across the clients we grade. */
export const SHELL_TOOLS = new Set([
  "Bash",
  "BashOutput",
  "shell",
  "run_shell_command",
  "execute_command",
  "terminal",
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS_FILE = path.join(HERE, "tasks.json");

/** The shell command a call issued, or null when the call is not a shell call. */
export function shellCommandOf(call: ToolCallRecord): string | null {
  if (!SHELL_TOOLS.has(call.tool)) return null;
  const input = call.input ?? {};
  for (const key of ["command", "cmd", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function gradeTranscript(transcript: ToolCallRecord[], task: EvalTask): EvalResult {
  const used: string[] = [];
  for (const call of transcript) {
    if (!used.includes(call.tool)) used.push(call.tool);
  }

  const missing = task.expected_tools.filter((t) => !used.includes(t));

  const hits: ForbiddenHit[] = [];
  let shellCalls = 0;
  for (const call of transcript) {
    const command = shellCommandOf(call);
    if (command === null) continue;
    shellCalls++;
    for (const pattern of task.forbidden_shell_patterns) {
      if (new RegExp(pattern, "i").test(command)) {
        hits.push({ pattern, tool: call.tool, command });
      }
    }
  }

  const passed = missing.length === 0 && hits.length === 0;
  const notes = passed
    ? `called ${task.expected_tools.join(", ")}${shellCalls > 0 ? ` (${shellCalls} unrelated shell call(s))` : ""}`
    : [
        missing.length > 0 ? `never called ${missing.join(", ")}` : "",
        hits.length > 0 ? `shelled out: ${hits.map((h) => h.command).join(" | ")}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("; ");

  return { id: task.id, passed, used_tools: used, missing_tools: missing, forbidden_hits: hits, shell_calls: shellCalls, notes };
}

export function loadTasks(file: string = DEFAULT_TASKS_FILE): EvalTask[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { tasks: EvalTask[] };
  return parsed.tasks;
}

export function formatResults(results: EvalResult[]): string {
  const lines = results.map((r) => `${r.passed ? "PASS" : "FAIL"} ${r.id} — ${r.notes}`);
  const passed = results.filter((r) => r.passed).length;
  lines.push(`${passed}/${results.length} passed`);
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const asJson = argv.includes("--json");
  const tasksFlag = argv.indexOf("--tasks");
  const tasksFile = tasksFlag >= 0 ? argv[tasksFlag + 1] : DEFAULT_TASKS_FILE;
  // Only skip the argument *after* --tasks when the flag is actually present:
  // indexOf() returns -1 when it is not, and -1 + 1 is index 0, which would
  // silently swallow the first transcript file.
  const tasksValueIdx = tasksFlag >= 0 ? tasksFlag + 1 : -1;
  const files = argv.filter((a, i) => !a.startsWith("--") && i !== tasksValueIdx);

  if (files.length === 0) {
    process.stderr.write("usage: node eval/grade.ts <transcript.json> [more.json] [--tasks eval/tasks.json] [--json]\n");
    return 2;
  }

  const tasks = new Map(loadTasks(tasksFile).map((t) => [t.id, t]));
  const results: EvalResult[] = [];

  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { runs: TranscriptRun[] };
    for (const run of parsed.runs) {
      const task = tasks.get(run.task);
      if (!task) {
        process.stderr.write(`error: transcript ${file} references unknown task "${run.task}"\n`);
        return 2;
      }
      results.push(gradeTranscript(run.calls, task));
    }
  }

  process.stdout.write(asJson ? `${JSON.stringify(results, null, 2)}\n` : `${formatResults(results)}\n`);
  return results.every((r) => r.passed) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
