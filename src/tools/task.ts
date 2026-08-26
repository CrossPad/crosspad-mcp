// src/tools/task.ts — crosspad_task {action: status|wait|cancel|list}: the
// fallback for clients without the tasks capability (spec §3.1/§3.5). Same
// registry, same handles, same states as the SDK task path.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "../tool-context.js";
import { jsonResponse, errorResult, type ToolResult } from "../tool-result.js";
import { decide } from "../policy/policy.js";
import { requireConfirmation } from "../policy/confirm.js";

const TOOL = "crosspad_task";

const TaskId = z.string().regex(/^task_\d+$/, "task handle looks like task_<n>").describe("Task handle returned by a long-running tool (task_<n>)");

// What is advertised. The MCP SDK only publishes a JSON schema for a top-level
// *object* schema (`normalizeObjectSchema` returns undefined for a union), so a
// bare discriminatedUnion here would list `crosspad_task` with no parameters at
// all. The shape is advertised; the union below still does the real validation.
const InputShape = {
  action: z.enum(["status", "wait", "cancel", "list"]).describe("status: one task; wait: block until it finishes; cancel: stop it; list: every task this session"),
  task: TaskId.optional().describe("Task handle (task_<n>). Required for status, wait and cancel; ignored by list"),
  timeout_ms: z.number().int().min(0).max(600_000).default(30_000).describe("wait only: how long to block before returning the current status (max 600000)"),
};

// What is enforced: `task` is mandatory for status/wait/cancel and rejected for list.
const InputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), task: TaskId }),
  z.object({
    action: z.literal("wait"),
    task: TaskId,
    timeout_ms: z.number().int().min(0).max(600_000).default(30_000),
  }),
  z.object({ action: z.literal("cancel"), task: TaskId }),
  z.object({ action: z.literal("list") }),
]);

const JobStatusOut = z.object({
  task: z.string(),
  kind: z.string(),
  status: z.enum(["working", "completed", "failed", "cancelled"]),
  progress: z.number().optional(),
  total: z.number().optional(),
  message: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  daemonTask: z.string().optional(),
});

const OutputSchema = z.object({
  success: z.boolean(),
  task: JobStatusOut.optional(),
  tasks: z.array(JobStatusOut).optional(),
  cancelled: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() }).optional(),
});

export function registerTaskTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL,
    {
      description: "Poll, wait on, cancel or list long-running crosspad tasks (build, flash, hil_run, capture, stimulus, submodule_update). Task handles are task_<n>; results are kept 1 h after completion. Use this when your client does not support the MCP tasks capability.",
      inputSchema: InputShape,
      outputSchema: OutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, extra): Promise<ToolResult> => {
      const argRec = args as unknown as Record<string, unknown>;
      const parsed = InputSchema.safeParse(argRec);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: { code: "INVALID_ARGS", message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "), hint: "status/wait/cancel need task=task_<n>; list takes no arguments" },
        });
      }
      const input = parsed.data;
      const decision = decide(ctx.policy, TOOL, argRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "POLICY_HIDDEN", message: `${TOOL} is hidden by the current policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(
          server,
          extra as RequestHandlerExtra<ServerRequest, ServerNotification>,
          TOOL,
          argRec,
          `${TOOL} ${input.action}${input.action === "list" ? "" : " " + input.task}`,
        );
        if (c.status === "token") return c.result as ToolResult;
        if (c.status === "declined") {
          return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: "confirmation declined" } });
        }
      }
      try {
        switch (input.action) {
          case "status":
            return jsonResponse({ success: true, task: ctx.jobs.status(input.task) });
          case "wait":
            return jsonResponse({ success: true, task: await ctx.jobs.wait(input.task, input.timeout_ms) });
          case "cancel": {
            const cancelled = ctx.jobs.cancel(input.task);
            return jsonResponse({ success: true, cancelled, task: ctx.jobs.status(input.task) });
          }
          case "list":
            return jsonResponse({ success: true, tasks: ctx.jobs.list() });
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
