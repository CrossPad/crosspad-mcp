// src/tools/crosspad_confirm — run the action a confirmation_required result
// stands for, by its token.
//
// Why a tool of its own: Claude Code declares MCP elicitation and answers every
// form with "decline" at once, without showing it, so a danger-tier call could
// never be approved there. A tool marked destructive goes through the client's
// own permission prompt instead -- the person approves crosspad_confirm, and the
// prompt shows the token's summary. One token, one call, 120 s, bound to the
// exact arguments it was issued for.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { takePending } from "../policy/confirm.js";
import { jsonResponse, type ToolResult } from "../tool-result.js";

export const TOOL_NAME = "crosspad_confirm";

export type ToolLookup = (name: string) => RegisteredTool | undefined;

function refused(code: string, message: string, hint: string): ToolResult {
  return jsonResponse({ success: false, error: { code, message, hint } });
}

export function registerConfirmTool(server: McpServer, ctx: ToolContext,
                                    lookup: ToolLookup): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      title: "Confirm a CrossPad danger-tier action",
      description:
        "Run the action a crosspad_* tool answered with resultType=\"confirmation_required\" " +
        "(a flash, an SWD write, a bootloader request…), by its confirmation token. Call it right " +
        "away with that token -- do NOT ask the user in chat first: this tool is marked destructive, " +
        "so the client shows its own permission prompt, and approving that prompt is the " +
        "confirmation. The token is good once, for 120 s, for exactly the arguments it was issued " +
        "for; it returns the action's own result.",
      inputSchema: {
        token: z.string().regex(/^cfm_\d+_[0-9a-f]{16}_[0-9a-f]{64}$/)
          .describe("confirmation.token from the confirmation_required result"),
      },
      annotations: {
        title: "Confirm a CrossPad danger-tier action",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args, extra): Promise<ToolResult> => {
      if (decide(ctx.policy, TOOL_NAME, args as Record<string, unknown>) === "hidden") {
        return refused("HIDDEN", `${TOOL_NAME} is hidden by policy`, "read-only server");
      }
      const action = takePending(args.token);
      if (action === null) {
        return refused("UNKNOWN_TOKEN",
          "no pending action for this token: it expired (120 s), was already used, or was never issued",
          "re-issue the original call to get a fresh confirmation");
      }
      const tool = lookup(action.tool);
      if (tool === undefined) {
        return refused("TOOL_UNAVAILABLE", `${action.tool} is not available on this server`,
          "it may be hidden by policy");
      }
      console.error(`crosspad-mcp: ${TOOL_NAME} runs ${action.tool} ${JSON.stringify(action.args)}`);
      const handler = tool.handler as unknown as (
        a: Record<string, unknown>, e: unknown) => Promise<ToolResult>;
      return handler({ ...action.args, confirm_token: args.token }, extra);
    },
  );
}
