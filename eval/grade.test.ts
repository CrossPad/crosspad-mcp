import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gradeTranscript,
  loadTasks,
  main,
  shellCommandOf,
  formatResults,
  SHELL_TOOLS,
  type EvalTask,
  type ToolCallRecord,
} from "./grade.js";
import { TOOLSETS } from "../src/toolsets.js";

const ALL_TOOLS = new Set(Object.values(TOOLSETS).flat());

const task: EvalTask = {
  id: "repo-status-not-git-status",
  prompt: "What is dirty across the CrossPad repos right now?",
  expected_tools: ["crosspad_repo_status"],
  forbidden_shell_patterns: ["\\bgit\\s+status\\b", "\\bgit\\s+-C\\b"],
};

describe("gradeTranscript", () => {
  it("passes when the expected tool was called and no shell rule was broken", () => {
    const t: ToolCallRecord[] = [{ tool: "crosspad_repo_status", input: {} }];
    const r = gradeTranscript(t, task);
    expect(r.passed).toBe(true);
    expect(r.missing_tools).toEqual([]);
    expect(r.forbidden_hits).toEqual([]);
    expect(r.used_tools).toEqual(["crosspad_repo_status"]);
    expect(r.id).toBe(task.id);
  });

  it("fails when the model shelled out instead", () => {
    const t: ToolCallRecord[] = [{ tool: "Bash", input: { command: "cd ~/GIT/platform-idf && git status --porcelain" } }];
    const r = gradeTranscript(t, task);
    expect(r.passed).toBe(false);
    expect(r.missing_tools).toEqual(["crosspad_repo_status"]);
    expect(r.forbidden_hits).toEqual([
      { pattern: "\\bgit\\s+status\\b", tool: "Bash", command: "cd ~/GIT/platform-idf && git status --porcelain" },
    ]);
    expect(r.shell_calls).toBe(1);
  });

  it("fails on a forbidden shell call even when the tool was also used", () => {
    const t: ToolCallRecord[] = [
      { tool: "crosspad_repo_status", input: {} },
      { tool: "Bash", input: { command: "git status" } },
    ];
    const r = gradeTranscript(t, task);
    expect(r.passed).toBe(false);
    expect(r.missing_tools).toEqual([]);
    expect(r.forbidden_hits.length).toBe(1);
  });

  it("allows unrelated shell calls", () => {
    const t: ToolCallRecord[] = [
      { tool: "crosspad_repo_status", input: {} },
      { tool: "Bash", input: { command: "ls ~/GIT" } },
    ];
    const r = gradeTranscript(t, task).passed;
    expect(t.length).toBe(2);
    expect(r).toBe(true);
  });

  it("matches case-insensitively and reports each distinct pattern once per call", () => {
    const t: ToolCallRecord[] = [{ tool: "Bash", input: { command: "GIT STATUS && git -C /x status" } }];
    const r = gradeTranscript(t, task);
    expect(r.forbidden_hits.map((h) => h.pattern).sort()).toEqual(["\\bgit\\s+-C\\b", "\\bgit\\s+status\\b"]);
  });

  it("deduplicates repeated tool calls in used_tools", () => {
    const t: ToolCallRecord[] = [
      { tool: "crosspad_repo_status", input: {} },
      { tool: "crosspad_repo_status", input: {} },
    ];
    expect(gradeTranscript(t, task).used_tools).toEqual(["crosspad_repo_status"]);
  });
});

describe("shellCommandOf", () => {
  it("reads command / cmd / script from any known shell tool", () => {
    expect(shellCommandOf({ tool: "Bash", input: { command: "ls" } })).toBe("ls");
    expect(shellCommandOf({ tool: "shell", input: { cmd: "ls" } })).toBe("ls");
    expect(shellCommandOf({ tool: "run_shell_command", input: { script: "ls" } })).toBe("ls");
    expect(shellCommandOf({ tool: "crosspad_repo_status", input: { command: "ls" } })).toBeNull();
    expect(shellCommandOf({ tool: "Bash" })).toBeNull();
    expect(SHELL_TOOLS.has("Bash")).toBe(true);
  });
});

describe("eval/tasks.json", () => {
  const tasks = loadTasks();

  it("has exactly 10 tasks with unique ids", () => {
    expect(tasks.length).toBe(10);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(10);
  });

  it("every task names a real prompt, at least one expected tool and one forbidden pattern", () => {
    for (const t of tasks) {
      expect(t.prompt.length, t.id).toBeGreaterThan(20);
      expect(t.expected_tools.length, t.id).toBeGreaterThan(0);
      expect(t.forbidden_shell_patterns.length, t.id).toBeGreaterThan(0);
    }
  });

  it("every expected tool exists in a toolset", () => {
    for (const t of tasks) {
      for (const tool of t.expected_tools) {
        expect(ALL_TOOLS.has(tool), `${t.id} expects unknown tool ${tool}`).toBe(true);
      }
    }
  });

  it("every forbidden pattern compiles as a regex", () => {
    for (const t of tasks) {
      for (const p of t.forbidden_shell_patterns) {
        expect(() => new RegExp(p, "i"), `${t.id}: ${p}`).not.toThrow();
      }
    }
  });

  it("a transcript that calls only the expected tools passes every task", () => {
    for (const t of tasks) {
      const transcript = t.expected_tools.map((tool) => ({ tool, input: {} }));
      expect(gradeTranscript(transcript, t).passed, t.id).toBe(true);
    }
  });
});

describe("main", () => {
  it("grades a transcript file given without --tasks (the first file is not eaten)", () => {
    const file = path.join(os.tmpdir(), `crosspad-eval-${process.pid}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        runs: [
          { task: "repo-status-not-git-status", calls: [{ tool: "crosspad_repo_status", input: {} }] },
          { task: "symbols-not-grep", calls: [{ tool: "Bash", input: { command: "grep -rn PadLedController ~/GIT" } }] },
        ],
      }),
    );
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(s); return true; }) as never);
    try {
      expect(main([file])).toBe(1);
    } finally {
      spy.mockRestore();
      fs.rmSync(file, { force: true });
    }
    expect(out.join("")).toContain("PASS repo-status-not-git-status");
    expect(out.join("")).toContain("FAIL symbols-not-grep");
    expect(out.join("")).toContain("1/2 passed");
  });
});

describe("formatResults", () => {
  it("renders one line per task with PASS/FAIL", () => {
    const out = formatResults([
      gradeTranscript([{ tool: "crosspad_repo_status" }], task),
      gradeTranscript([{ tool: "Bash", input: { command: "git status" } }], task),
    ]);
    expect(out).toContain("PASS repo-status-not-git-status");
    expect(out).toContain("FAIL repo-status-not-git-status");
    expect(out).toContain("1/2 passed");
  });
});
