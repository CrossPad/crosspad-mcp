// crosspad_toolsets — the meta-tool that turns toolsets on and off at runtime
// (spec §3.1). Read tier: it only changes what the server advertises; the
// manager refuses to enable tools the policy hides.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResponse, errorResult } from "../response.js";
import { ErrorSchema } from "../tool-result.js";
import { annotationsFor } from "../policy/tiers.js";
import { enforce } from "../policy/confirm.js";
import { TOOLSETS, TOOLSET_DESCRIPTIONS, type ToolsetManager } from "../toolsets.js";
import type { ToolContext } from "../tool-context.js";

const TOOL = "crosspad_toolsets";
const KNOWN = Object.keys(TOOLSETS).join(", ");

const O_Toolsets = {
  success: z.boolean(),
  policy_mode: z.string(),
  enabled: z.array(z.string()),
  toolsets: z
    .array(z.object({ name: z.string(), description: z.string(), enabled: z.boolean(), tools: z.array(z.string()) }))
    .optional(),
  toolset: z
    .object({
      name: z.string(),
      description: z.string(),
      enabled: z.boolean(),
      tools: z.array(z.object({ name: z.string(), tier: z.string(), enabled: z.boolean(), hidden: z.boolean() })),
    })
    .optional(),
  added: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  hidden_by_policy: z.array(z.string()).optional(),
  error: ErrorSchema.optional(),
};

export function registerToolsetsTool(server: McpServer, ctx: ToolContext, manager: ToolsetManager): RegisteredTool {
  return server.registerTool(
    TOOL,
    {
      description:
        "Manage which crosspad_* toolsets are visible. Only `core` is on at start. " +
        `Toolsets: ${KNOWN}. action=list shows all with enabled state; enable/disable take toolset=<name> ` +
        "(core cannot be disabled); describe lists each tool with its safety tier. " +
        "Enabling emits tools/list_changed — re-list tools afterwards. Tools hidden by a readonly policy never appear.",
      inputSchema: {
        action: z.enum(["list", "enable", "disable", "describe"]).describe("What to do"),
        toolset: z.string().optional().describe(`Toolset name for enable/disable/describe: ${KNOWN}`),
      },
      outputSchema: O_Toolsets,
      annotations: annotationsFor("read"),
    },
    async ({ action, toolset }, extra) => {
      const args: Record<string, unknown> = { action, toolset };
      const blocked = await enforce(server, extra, ctx.policy, TOOL, args, `${TOOL} ${action} ${toolset ?? ""}`.trim());
      if (blocked) return blocked;

      const base = { success: true, policy_mode: ctx.policy.mode };

      if (action === "list") {
        return jsonResponse({
          ...base,
          enabled: manager.enabled(),
          toolsets: Object.keys(TOOLSETS).map((name) => ({
            name,
            description: TOOLSET_DESCRIPTIONS[name] ?? "",
            enabled: manager.enabled().includes(name),
            tools: TOOLSETS[name],
          })),
        });
      }

      const state = { policy_mode: ctx.policy.mode, enabled: manager.enabled() };
      if (!toolset) {
        return errorResult("BAD_ARGS", `action=${action} needs toolset=<name>`, `known toolsets: ${KNOWN}`, state);
      }
      if (!(toolset in TOOLSETS)) {
        return errorResult("BAD_ARGS", `unknown toolset "${toolset}"`, `known toolsets: ${KNOWN}`, state);
      }

      if (action === "describe") {
        return jsonResponse({ ...base, enabled: manager.enabled(), toolset: manager.describe(toolset) });
      }

      if (action === "enable") {
        const added = manager.enable(toolset);
        const hidden = manager.hiddenTools().filter((n) => TOOLSETS[toolset].includes(n));
        return jsonResponse({ ...base, enabled: manager.enabled(), added, hidden_by_policy: hidden });
      }

      // disable
      if (toolset === "core") {
        return errorResult(
          "BAD_ARGS",
          "the core toolset cannot be disabled",
          "disable any other toolset, or restart the server with a narrower --toolsets",
          state,
        );
      }
      const removed = manager.disable(toolset);
      return jsonResponse({ ...base, enabled: manager.enabled(), removed });
    },
  );
}
