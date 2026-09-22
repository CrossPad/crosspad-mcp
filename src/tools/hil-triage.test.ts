import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerHilTriageTool, buildState, buildQuestions, KNOWN_SIGNATURES, TYPESAFE_ENDPOINT, API_KEY_ENV } from "./hil-triage.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import { loadPolicy } from "../policy/policy.js";
import type { ToolContext } from "../tool-context.js";

const ANSWERS = {
  model: "jev-1.13.0",
  answers: {
    cause: { type: "choice", choice: "bench_environment", probabilities: { firmware_regression: 0.05, bench_environment: 0.9, known_baseline: 0.02, inconclusive: 0.03 }, confidence: 0.85 },
    exit_code_consistent: { type: "noul", noul: 0.1 },
    board_reset: { type: "noul", noul: 0.2 },
  },
  usage: { input_tokens: 500, output_tokens: 40 },
};

function writeReport(dir: string, doc: Record<string, unknown>, consoleLog?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "report.json");
  fs.writeFileSync(p, JSON.stringify(doc));
  if (consoleLog !== undefined) fs.writeFileSync(path.join(dir, "console.log"), consoleLog);
  return p;
}

function mk() {
  const fs_ = fakeServer();
  const ctx: ToolContext = {
    daemon: () => fakeDaemon({}) as never,
    policy: loadPolicy({ file: "/nonexistent/policy.json", env: {} }),
    jobs: new JobRegistry(),
    handles: new HandleRegistry(),
  };
  registerHilTriageTool(fs_.server, ctx);
  const call = (args: unknown) =>
    (fs_.tools.get("crosspad_hil_triage")!.cb as (a: unknown, e: unknown) => Promise<{ structuredContent: Record<string, unknown> }>)(args, fakeExtra());
  return { ctx, call };
}

describe("crosspad_hil_triage", () => {
  let tmp: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hil-triage-"));
    process.env[API_KEY_ENV] = "test-key";
    fetchMock = vi.fn(async () => new Response(JSON.stringify(ANSWERS), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env[API_KEY_ENV];
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses without an API key instead of calling out", async () => {
    delete process.env[API_KEY_ENV];
    const rep = writeReport(path.join(tmp, "smoke_1"), { scenario: "smoke", exit_code: 0, passed: true, summary: "PASS", data: {} });
    const res = await mk().call({ report: rep });
    expect(res.structuredContent.success).toBe(false);
    expect((res.structuredContent.error as { code: string }).code).toBe("NO_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the report as state with the fixed questions and returns typed answers", async () => {
    const rep = writeReport(
      path.join(tmp, "app_churn_1"),
      {
        scenario: "app_churn",
        exit_code: 1,
        passed: false,
        summary: "crashed: SerialException(2, \"could not open port /dev/ttyACM1\")",
        data: { error: { code: "INTERNAL", message: "SerialException", traceback: Array.from({ length: 40 }, (_, i) => `frame ${i}`).join("\n") }, rounds: 2 },
        workdir: path.join(tmp, "app_churn_1"),
      },
      "boot\nI (123) main: ready\n",
    );
    const res = await mk().call({ report: rep });
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.advisory).toBe(true);
    expect(res.structuredContent.verdict).toBe("FAIL");
    expect(res.structuredContent.cause).toBe("bench_environment");
    expect(res.structuredContent.cause_confidence).toBe(0.85);
    expect(res.structuredContent.exit_code_consistent).toBe(0.1);
    expect(res.structuredContent.board_reset).toBe(0.2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TYPESAFE_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body)) as { state: Record<string, unknown>; model: string; questions: Record<string, unknown> };
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions).sort()).toEqual(["board_reset", "cause", "exit_code_consistent"]);
    expect(body.state.scenario).toBe("app_churn");
    expect(body.state.console_tail).toEqual(["boot", "I (123) main: ready"]);
    expect(body.state.known_bench_signatures).toEqual(KNOWN_SIGNATURES);
    // the traceback is trimmed to its ends, the error is lifted out of data
    const err = body.state.error as { traceback: string };
    expect(err.traceback).toContain("frame 0");
    expect(err.traceback).toContain("frame 39");
    expect(err.traceback).toContain("… 26 lines …");
    expect(String(body.state.data)).not.toContain("traceback");
  });

  it("takes a directory as the report argument", async () => {
    const dir = path.join(tmp, "smoke_2");
    writeReport(dir, { scenario: "smoke", exit_code: 2, passed: false, summary: "environment: NO_DEVICE", data: {} });
    const res = await mk().call({ report: dir });
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.verdict).toBe("ENV");
    expect(res.structuredContent.report).toBe(path.join(dir, "report.json"));
  });

  it("finds the report through a finished task's artifact", async () => {
    const dir = path.join(tmp, "smoke_3");
    const rep = writeReport(dir, { scenario: "smoke", exit_code: 0, passed: true, summary: "PASS", data: {} });
    const t = mk();
    const task = t.ctx.jobs.create("hil:smoke", async () => ({ passed: true, exit_code: 0, artifacts: [{ path: rep, role: "report" }] }));
    await t.ctx.jobs.wait(task, 1000);
    const res = await t.call({ task });
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.scenario).toBe("smoke");
  });

  it("does not triage a task that is still running", async () => {
    const t = mk();
    let release!: () => void;
    const task = t.ctx.jobs.create("hil:smoke", () => new Promise<unknown>((r) => { release = () => r({}); }));
    const res = await t.call({ task });
    expect((res.structuredContent.error as { code: string }).code).toBe("TASK_NOT_FINISHED");
    release();
  });

  it("reports an HTTP failure as an error envelope", async () => {
    fetchMock.mockImplementation(async () => new Response("bad key", { status: 401 }));
    const rep = writeReport(path.join(tmp, "smoke_4"), { scenario: "smoke", exit_code: 0, passed: true, summary: "PASS", data: {} });
    const res = await mk().call({ report: rep });
    expect(res.structuredContent.success).toBe(false);
    expect((res.structuredContent.error as { message: string }).message).toContain("401");
  });

  it("rejects a reply that lacks the answers it asked for", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ model: "jev", answers: {} }), { status: 200 }));
    const rep = writeReport(path.join(tmp, "smoke_5"), { scenario: "smoke", exit_code: 0, passed: true, summary: "PASS", data: {} });
    const res = await mk().call({ report: rep });
    expect((res.structuredContent.error as { code: string }).code).toBe("BAD_RESPONSE");
  });

  it("needs a report or a task", async () => {
    const res = await mk().call({});
    expect((res.structuredContent.error as { code: string }).code).toBe("INVALID_ARGS");
  });

  it("pins the question ids to the answers the tool reads", () => {
    const q = buildQuestions();
    expect(Object.keys(q).sort()).toEqual(["board_reset", "cause", "exit_code_consistent"]);
    const cause = q.cause as { criteria: Record<string, string> };
    expect(Object.keys(cause.criteria).sort()).toEqual(["bench_environment", "firmware_regression", "inconclusive", "known_baseline", "passed_clean"]);
  });

  it("caps oversized data and drops a missing console quietly", () => {
    const state = buildState({ scenario: "x", data: { blob: "y".repeat(10_000) } }, path.join(tmp, "nowhere", "report.json"), 20);
    expect(String(state.data).length).toBeLessThan(6_100);
    expect(state.console_tail).toEqual([]);
  });
});
