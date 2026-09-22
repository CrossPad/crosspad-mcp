// src/tools/hil-triage.ts — crosspad_hil_triage: an advisory second opinion on
// a finished HIL report, from TypeSafe's System One model (Jev).
//
// The verdict of a scenario is its exit code (0 pass, 1 firmware, 2 bench) and
// nothing here changes it. What this adds is a calibrated classification of
// the free-text part — summary, error, console tail — against the bench's
// known failure signatures, so the reader of a report gets "bench, p=0.9"
// instead of guessing from a traceback. The model returns typed answers with
// probabilities, never prose, which is the point: there is no text to misread.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../tool-context.js";
import { CROSSPAD_HIL_ROOT as HIL_ROOT } from "../config.js";
import { jsonResponse, errorResult, type ToolResult, ErrorSchema } from "../tool-result.js";
import { decide } from "../policy/policy.js";

const TOOL = "crosspad_hil_triage";
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const API_KEY_ENV = "TYPESAFE_API_KEY";
const DEFAULT_MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_AFTER_MS = 1_500;
const MAX_DATA_CHARS = 6_000;
const MAX_LINE_CHARS = 300;
const TRACEBACK_HEAD = 6;
const TRACEBACK_TAIL = 8;

export const CAUSES = ["passed_clean", "firmware_regression", "bench_environment", "known_baseline", "inconclusive"] as const;
export type Cause = (typeof CAUSES)[number];

const InputShape = {
  report: z
    .string()
    .optional()
    .describe("Path to a scenario's report.json, or to its work directory. Relative paths resolve against the crosspad-hil checkout"),
  task: z
    .string()
    .regex(/^task_\d+$/)
    .optional()
    .describe("A finished crosspad_hil_run task handle; its report artifact is triaged. Either report or task is required"),
  console_lines: z
    .number()
    .int()
    .min(0)
    .max(400)
    .default(60)
    .describe("How many lines from the end of console.log to include as evidence"),
  model: z.string().default(DEFAULT_MODEL).describe("TypeSafe model alias"),
};
const InputSchema = z.object(InputShape);

const ChoiceAnswer = z.looseObject({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});
const NoulAnswer = z.looseObject({ type: z.literal("noul"), noul: z.number() });

/** What the API sends back; loose so a new field on their side is not a failure here. */
export const TriageAnswersSchema = z.looseObject({
  cause: ChoiceAnswer,
  exit_code_consistent: NoulAnswer,
  board_reset: NoulAnswer,
});
const ResponseSchema = z.looseObject({
  model: z.string(),
  answers: TriageAnswersSchema,
  usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

const O_HilTriage = {
  success: z.boolean(),
  advisory: z.literal(true).optional(),
  report: z.string().optional(),
  scenario: z.string().optional(),
  exit_code: z.number().optional(),
  verdict: z.string().optional(),
  cause: z.enum(CAUSES).optional(),
  cause_probabilities: z.record(z.string(), z.number()).optional(),
  cause_confidence: z.number().optional(),
  exit_code_consistent: z.number().optional(),
  board_reset: z.number().optional(),
  model: z.string().optional(),
  usage: z.looseObject({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  ts: z.number().optional(),
  error: ErrorSchema.optional(),
};

/**
 * The bench's known failure signatures, as facts the model judges against.
 * Each one cost a session on this bench (platform-idf CLAUDE.md, "Driving the
 * Bench"); the model cannot know them from a log alone.
 */
export const KNOWN_SIGNATURES: readonly string[] = [
  "SerialException 'could not open port /dev/ttyACMx' or 'No such file or directory' right after a reset: the ESP re-enumerated and the port moved; a bench timing problem, not the firmware.",
  "NO_DEVICE '/dev/ttyACMx did not appear within N s' after the board was reset: bench, the board came back on another port.",
  "PORT_BUSY: another process on this machine holds the CDC port; bench.",
  "Every CDC verb answers 'no reply' and the board looks dead while the STM bridge VCP is present: the board is in the MIDI+UAC2 USB profile, which has no CDC endpoint; bench (profile), not firmware.",
  "kit_churn 'silent after the burst': present in the crosspad_v20 baseline, a known behaviour, not a regression.",
  "Board reboots every ~19.5 s, CDC enumerates but never answers: an image built for the other PCB revision (v1 on v2 or vice versa); bench (wrong image).",
  "KIT_LIST times out right after boot: the boot scan holds the kit vector; a retry succeeds, not a hang.",
  "All audio scenarios fail at once on good hardware: the persisted capture preset is a DAC-to-ADC bus that rails codec 1; bench, 'bench.py ready' restores MICS.",
  "'BOOT LOOP: device reset N extra time(s)', 'Guru Meditation', 'Task watchdog got triggered', abort(), a core dump or a panic backtrace in the console: the firmware itself reset the board; firmware.",
  "STM watchdog reset signature in RESET_LOG with no ESP panic before it: the STM32 co-processor reset the ESP; firmware (STM side).",
  "A scenario that passed with no stimulus in its window proves nothing; kit_churn fails itself for that reason.",
];

interface ReportDoc {
  scenario?: string;
  passed?: boolean;
  summary?: string;
  exit_code?: number;
  data?: Record<string, unknown>;
  params?: Record<string, unknown>;
  workdir?: string;
  seconds?: number;
  artifacts?: Array<{ path?: string; role?: string }>;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** Keep the frames that name the failure: the first few and the last few. */
function trimTraceback(tb: string): string {
  const lines = tb.split("\n");
  if (lines.length <= TRACEBACK_HEAD + TRACEBACK_TAIL) return tb;
  return [...lines.slice(0, TRACEBACK_HEAD), `… ${lines.length - TRACEBACK_HEAD - TRACEBACK_TAIL} lines …`, ...lines.slice(-TRACEBACK_TAIL)].join("\n");
}

function tailLines(file: string, n: number): string[] {
  if (n === 0 || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).map(clip);
}

/** Resolve `report` (file or directory) to the report.json path. */
export function resolveReportPath(report: string): string {
  const abs = path.isAbsolute(report) ? report : path.resolve(HIL_ROOT, report);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return path.join(abs, "report.json");
  return abs;
}

/** The evidence the model sees. Exported so a test can pin what leaves the machine. */
export function buildState(doc: ReportDoc, reportPath: string, consoleLines: number): Record<string, unknown> {
  const data: Record<string, unknown> = { ...(doc.data ?? {}) };
  const error = data.error as Record<string, unknown> | undefined;
  delete data.error;
  if (error && typeof error.traceback === "string") error.traceback = trimTraceback(error.traceback);
  let dataText = JSON.stringify(data);
  if (dataText.length > MAX_DATA_CHARS) dataText = `${dataText.slice(0, MAX_DATA_CHARS)}…(truncated)`;

  const workdir = doc.workdir
    ? path.isAbsolute(doc.workdir) ? doc.workdir : path.resolve(HIL_ROOT, doc.workdir)
    : path.dirname(reportPath);
  const consoleTail = tailLines(path.join(workdir, "console.log"), consoleLines);

  return {
    scenario: doc.scenario ?? null,
    exit_code: doc.exit_code ?? null,
    exit_code_meaning: { "0": "passed", "1": "the firmware failed the scenario", "2": "the bench or environment was wrong, the firmware was not judged" },
    passed: doc.passed ?? null,
    summary: doc.summary ?? null,
    seconds: doc.seconds ?? null,
    params: doc.params ?? null,
    error: error ?? null,
    data: dataText,
    console_tail: consoleTail,
    known_bench_signatures: KNOWN_SIGNATURES,
  };
}

/** The questions, fixed: a tool with a stable contract, not a prompt box. */
export function buildQuestions(): Record<string, unknown> {
  return {
    cause: {
      type: "choice",
      instructions: {
        question:
          "What caused this hardware-in-the-loop scenario to end the way it did? Judge from `summary`, `error`, `data` and `console_tail`, using `known_bench_signatures` as established facts about this bench. `exit_code` is the tool's own attribution; it can be wrong when a scenario crashed on a bench problem.",
      },
      criteria: {
        passed_clean: "The scenario passed, its checks ran against real stimulus, and the console shows no error, panic or unrequested reset.",
        firmware_regression: "The firmware under test misbehaved: a failed check on device state, a panic, watchdog, bootloop, wrong reply, missing boot marker, leak or timing violation attributable to the board's software.",
        bench_environment: "The host side or the bench was wrong: port moved or busy, wrong USB profile, no device, wrong image for the PCB revision, missing host package, persisted capture preset, no kit loaded. The firmware was not actually exercised or judged.",
        known_baseline: "The observed behaviour matches a documented known signature that is already present in the baseline and is not a regression.",
        inconclusive: "The report does not carry enough evidence to tell; passed runs with no stimulus, empty logs, or a summary that names no failure.",
      },
    },
    exit_code_consistent: {
      type: "noul",
      instructions:
        "Does the attribution implied by `exit_code` (see `exit_code_meaning`) agree with the evidence in `summary`, `error` and `console_tail`?",
      criteria: {
        true: "The exit code's attribution (pass / firmware / bench) is what the evidence shows.",
        false: "The evidence points elsewhere, e.g. exit 1 for a crash that was really a bench problem, or exit 0 with errors in the console.",
      },
    },
    board_reset: {
      type: "noul",
      instructions:
        "Did the board reset unexpectedly during the run — a panic, watchdog, bootloop, brownout or extra boot marker that the scenario did not ask for?",
      criteria: {
        true: "The console or data shows an unrequested reset of the ESP32 or the STM32.",
        false: "No unrequested reset; scenario-driven resets (a console open with reset, a flash) do not count.",
      },
    },
  };
}

async function callTypeSafe(
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await fetch(TYPESAFE_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
  let res = await attempt();
  if (res.status === 429 || res.status === 529) {
    await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
    res = await attempt();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TypeSafe HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export function registerHilTriageTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL,
    {
      title: "Triage a HIL report (advisory, via TypeSafe)",
      description:
        "Advisory second opinion on a finished HIL report: classifies the cause as firmware_regression / bench_environment / known_baseline / inconclusive with a probability distribution, and says whether the exit code's attribution agrees with the evidence and whether the board reset unexpectedly. The exit code stays the verdict; this only reads the free text a human would otherwise interpret. Takes the report.json path or a finished crosspad_hil_run task. " +
        "Sends the report's summary, error, data and the console tail to api.typesafe.ai (needs TYPESAFE_API_KEY in the server's environment). Nothing on the board or the host is touched.",
      inputSchema: InputShape,
      outputSchema: O_HilTriage,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (rawArgs: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<ToolResult> => {
      const parsed = InputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: { code: "INVALID_ARGS", message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") },
        });
      }
      const args = parsed.data;
      if (decide(ctx.policy, TOOL, args as unknown as Record<string, unknown>) === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL} is hidden by policy` } });
      }

      const apiKey = process.env[API_KEY_ENV];
      if (!apiKey) {
        return jsonResponse({
          success: false,
          error: { code: "NO_API_KEY", message: `${API_KEY_ENV} is not set in the MCP server's environment`, hint: "export it where the server is started (.mcp.json env, or the shell)" },
        });
      }

      let reportPath: string;
      if (args.report) {
        reportPath = resolveReportPath(args.report);
      } else if (args.task) {
        let status;
        try {
          status = ctx.jobs.status(args.task);
        } catch (e) {
          return errorResult(e);
        }
        if (status.status !== "completed" && status.status !== "failed") {
          return jsonResponse({ success: false, error: { code: "TASK_NOT_FINISHED", message: `${args.task} is ${status.status}`, hint: "wait for it with crosspad_task first" } });
        }
        const artifacts = (status.result as ReportDoc | undefined)?.artifacts ?? [];
        const rep = artifacts.find((a) => a.role === "report")?.path;
        if (!rep) {
          return jsonResponse({ success: false, error: { code: "NO_REPORT", message: `${args.task} carries no report artifact` } });
        }
        reportPath = resolveReportPath(rep);
      } else {
        return jsonResponse({ success: false, error: { code: "INVALID_ARGS", message: "report or task is required" } });
      }

      if (!fs.existsSync(reportPath)) {
        return jsonResponse({ success: false, error: { code: "NOT_FOUND", message: `no report at ${reportPath}` } });
      }
      let doc: ReportDoc;
      try {
        doc = JSON.parse(fs.readFileSync(reportPath, "utf8")) as ReportDoc;
      } catch (e) {
        return jsonResponse({ success: false, error: { code: "BAD_REPORT", message: `${reportPath}: ${(e as Error).message}` } });
      }

      try {
        const raw = await callTypeSafe(
          { state: buildState(doc, reportPath, args.console_lines), model: args.model, questions: buildQuestions() },
          apiKey,
          extra.signal,
        );
        const res = ResponseSchema.safeParse(raw);
        if (!res.success) {
          return jsonResponse({ success: false, error: { code: "BAD_RESPONSE", message: `TypeSafe reply did not match: ${res.error.issues.map((i) => i.path.join(".")).join(", ")}` } });
        }
        const a = res.data.answers;
        const cause = (CAUSES as readonly string[]).includes(a.cause.choice) ? (a.cause.choice as Cause) : "inconclusive";
        return jsonResponse({
          success: true,
          advisory: true,
          report: reportPath,
          scenario: doc.scenario,
          exit_code: doc.exit_code,
          verdict: doc.exit_code === 0 ? "PASS" : doc.exit_code === 2 ? "ENV" : "FAIL",
          cause,
          cause_probabilities: a.cause.probabilities,
          cause_confidence: a.cause.confidence,
          exit_code_consistent: a.exit_code_consistent.noul,
          board_reset: a.board_reset.noul,
          model: res.data.model,
          ...(res.data.usage ? { usage: res.data.usage } : {}),
          ts: Date.now(),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
