// src/tools/hil_run.ts — crosspad_hil_run: the hardware-in-the-loop scenarios
// (smoke, app_churn, kit_churn, led_state, usb_mode_cycle, …) as MCP tasks.
//
// These are the test suite: there are no unit tests for the firmware, so a
// scenario run against a real board is what "tested" means here. They take
// minutes, so they run as jobs and the report comes back with its artifacts as
// links rather than inlined. Spec §3.1 (toolset `hil`), §3.2.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResponse, errorResult, type ToolResult } from "../tool-result.js";
import { decide } from "../policy/policy.js";
import { requireConfirmation, CONFIRMATION_OUTPUT } from "../policy/confirm.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";

const TOOL = "crosspad_hil_run";

const InputShape = {
  action: z
    .enum(["list", "run"])
    .default("run")
    .describe("list: the scenario catalog with each one's parameters; run: start one as a task"),
  scenario: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "scenario names are lower_snake_case")
    .optional()
    .describe("Scenario name, e.g. smoke, app_churn, kit_churn, stability, ble_midi. action=list gives the full catalog. Required for run"),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Scenario parameters; action=list reports the names, types and defaults each one takes"),
  device: z.string().optional().describe("Device id (dev_xxxx); implicit when one board is attached"),
};

const InputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.literal("run"),
    scenario: z.string().regex(/^[a-z][a-z0-9_]*$/),
    params: z.record(z.string(), z.unknown()).optional(),
    device: z.string().optional(),
  }),
]);

const O_HilRun = {
  ...CONFIRMATION_OUTPUT,
  success: z.boolean(),
  action: z.string().optional(),
  scenarios: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        params: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .optional(),
  scenario: z.string().optional(),
  device: z.string().optional(),
  task: z.string().optional(),
  poll: z.string().optional(),
  ts: z.number().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
};

/** Scenarios that write firmware; everything else only stimulates the board. */
export function scenarioIsDanger(scenario: string, params: Record<string, unknown> | undefined): boolean {
  // Only flashing is irreversible. usb_mode_cycle and kit_churn hammer the
  // device but leave it as they found it, and gating those behind confirmation
  // would make the routine test suite unusable.
  return Boolean(params && params.flash);
}

export function registerHilRunTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL,
    {
      title: "Run a hardware-in-the-loop scenario",
      description:
        "[ESP HW] Run a HIL scenario on a real board as a task (these ARE the test suite — there are no firmware unit tests). action=list returns the catalog with each scenario's parameters; action=run starts one and returns a task handle to poll with crosspad_task. The report comes back with its console log and report.json as links. Scenarios: smoke (boot markers), app_churn (open/close every app, heap per app), kit_churn (swap kits while pads keep firing), led_state, usb_mode_cycle, midi_bench, midi_stress, velocity, speedtest, rt_glitch, stability (multi-hour soak), audio_loopback, speaker_acoustic, sampler_record, ble_midi. Call action=list rather than trusting this sentence — it is the catalog the daemon actually has. A run that passes with no stimulus in the window proves nothing — kit_churn fails itself for that reason.",
      inputSchema: InputShape,
      outputSchema: O_HilRun,
      annotations: annotationsFor(tierOf(TOOL, { action: "run" })),
    },
    async (
      rawArgs: unknown,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ): Promise<ToolResult> => {
      const parsed = InputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            hint: 'action="run" needs a scenario name; action="list" takes nothing else',
          },
        });
      }
      const args = parsed.data;
      const signal = extra.signal;
      const daemon = ctx.daemon();

      try {
        if (args.action === "list") {
          const r = await daemon.request<{ scenarios: unknown[] }>("scenario.list", {}, { signal });
          return jsonResponse({
            success: true,
            action: "list",
            scenarios: r.scenarios as O_ScenarioRow[],
            ts: Date.now(),
          });
        }

        const params = args.params ?? {};
        if (scenarioIsDanger(args.scenario, params)) {
          const decision = decide(ctx.policy, TOOL, { ...args, params });
          if (decision === "confirm") {
            const outcome = await requireConfirmation(
              server,
              extra,
              TOOL,
              rawArgs as Record<string, unknown>,
              `Run HIL scenario "${args.scenario}" with flash enabled — this overwrites the running firmware.`,
            );
            if (outcome.status === "token") {
              return jsonResponse(outcome.result.structuredContent as Record<string, unknown>);
            }
            if (outcome.status === "declined") {
              return jsonResponse({
                success: false,
                error: { code: "CANCELLED", message: "declined by the user" },
              });
            }
          }
        }

        const started = await daemon.request<{ task: string }>(
          "scenario.run",
          { name: args.scenario, params, ...(args.device ? { device: args.device } : {}) },
          { signal, timeoutMs: 30_000 },
        );
        // Mirror the daemon's task as one of ours so crosspad_task, progress and
        // cancellation all work through a single handle.
        const task = ctx.jobs.mirror(daemon, started.task, `hil:${args.scenario}`);
        ctx.handles.register(task, { kind: "task", device: args.device });
        return jsonResponse({
          success: true,
          action: "run",
          scenario: args.scenario,
          ...(args.device ? { device: args.device } : {}),
          task,
          poll: `crosspad_task {action:"status", task:"${task}"}`,
          ts: Date.now(),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

interface O_ScenarioRow {
  name: string;
  description?: string;
  params?: Record<string, unknown>[];
}
