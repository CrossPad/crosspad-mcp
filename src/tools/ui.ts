// src/tools/ui.ts — crosspad_ui: drive the screen by ref (Playwright-style).
// focus(ref) = ENC_GROUP + ENC_FOCUS → rotate by the index delta; press/rotate/
// back/start_app/stop_app are one verb each; every action ends with a fresh
// snapshot (refs are re-minted there) unless return_snapshot=false.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { HilError } from "../hil/daemon.js";
import { SnapshotSchema } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { CONFIRMATION_OUTPUT, requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError, type ToolResult, ErrorSchema } from "../tool-result.js";
import { takeDeviceSnapshot } from "./snapshot.js";

export const TOOL_NAME = "crosspad_ui";
/** hil_control.cpp ENC_PRESS default: 80 ms (verbs.enc_press ms=80). */
const DEFAULT_PRESS_MS = 80;
/** verbs.app_start default wait_s. */
const DEFAULT_START_WAIT_S = 3;

const IncludeKeys = z.enum(["apps", "ui", "kit", "leds", "pads", "mem", "ble", "console"]);

const Common = {
  device: z.string().min(1).optional().describe("Device id or port; omit when exactly one CrossPad is connected"),
  return_snapshot: z.boolean().optional().describe("Take a fresh crosspad_snapshot after the action (default true)"),
  include: z.array(IncludeKeys).optional().describe("Snapshot sections (default all)"),
};

// Advertised shape (the SDK cannot publish a JSON schema for a top-level union).
export const UiInputShape = {
  action: z.enum(["focus", "press", "rotate", "back", "start_app", "stop_app"]).describe("focus ref=e<i>; press [ms]; rotate delta; back; start_app name; stop_app"),
  ref: z.string().optional().describe("focus: a ref from a snapshot's ui.group, e.g. e2"),
  ms: z.number().int().min(1).max(5000).optional().describe(`press: encoder button hold (default ${DEFAULT_PRESS_MS})`),
  delta: z.number().int().min(-64).max(64).optional().describe("rotate: detents, non-zero, may be negative"),
  name: z.string().optional().describe("start_app: app name as listed by crosspad_cdc verb=app action=list"),
  wait_s: z.number().min(0).max(30).optional().describe(`start_app: wait for the device to confirm (default ${DEFAULT_START_WAIT_S})`),
  ...Common,
};

export const UiInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("focus"), ref: z.string().regex(/^e\d+$/, "ref looks like e<i> from a snapshot's ui.group"), ...Common }),
  z.object({ action: z.literal("press"), ms: z.number().int().min(1).max(5000).optional(), ...Common }),
  z.object({ action: z.literal("rotate"), delta: z.number().int().min(-64).max(64).refine((d) => d !== 0, "delta must be non-zero"), ...Common }),
  z.object({ action: z.literal("back"), ...Common }),
  z.object({ action: z.literal("start_app"), name: z.string().min(1).max(31).regex(/^[A-Za-z0-9_-]+$/), wait_s: z.number().min(0).max(30).optional(), ...Common }),
  z.object({ action: z.literal("stop_app"), ...Common }),
]);
export type UiArgs = z.infer<typeof UiInput>;

export const O_Ui = {
  ...CONFIRMATION_OUTPUT,
  success: z.boolean(),
  action: z.string().optional(),
  device: z.string().optional(),
  delta: z.number().int().optional(),
  from_index: z.number().int().optional(),
  to_index: z.number().int().optional(),
  result: z.unknown().optional(),
  snapshot: SnapshotSchema.optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: ErrorSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

/** TS port of snapshot.ref_to_delta(): index(ref) − focus_index; unknown ref → BAD_ARGS. */
export function refToDelta(group: Array<{ ref: string; index: number }>, focusIndex: number, ref: string): number {
  const entry = group.find((g) => g.ref === ref);
  if (!entry) {
    throw new HilError("BAD_ARGS", `ref ${ref} is not in the current encoder group (${group.length} entries)`, "take crosspad_snapshot and use a ref from ui.group — refs are re-minted after every UI action");
  }
  return entry.index - focusIndex;
}

export function registerUiTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] Drive the device UI by snapshot refs. focus ref=e<i> moves the encoder focus to that group entry (ENC_GROUP + ENC_FOCUS → ENC_ROTATE by the delta); press = encoder click; rotate delta; back = the app's own Back (APP_SELF_CLOSE); start_app name; stop_app (APP_STOP, rebuilds the launcher). Every action returns a fresh snapshot by default — use its ui.group refs for the next step, old refs are invalid.",
      inputSchema: UiInputShape,
      outputSchema: O_Ui,
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "press" })),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const parsed = UiInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            hint: "focus needs ref=e<i> from a snapshot's ui.group; rotate needs a non-zero delta; start_app needs name",
          },
        });
      }
      const args = parsed.data;
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(
          server,
          extra as RequestHandlerExtra<ServerRequest, ServerNotification>,
          TOOL_NAME,
          argsRec,
          `crosspad_ui ${args.action} on ${args.device ?? "the only CrossPad"}`,
        );
        if (c.status === "token") return c.result as ToolResult;
        if (c.status === "declined") return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: "declined by the user" } });
      }
      const daemon = ctx.daemon();
      const signal = extra.signal;
      const verb = async <T = unknown>(name: string, vargs: Record<string, unknown>, timeoutMs = 15_000): Promise<T> => {
        const opArgs: Record<string, unknown> = {};
        if (args.device !== undefined) opArgs.device = args.device;
        opArgs.verb = name;
        opArgs.args = vargs;
        return daemon.request<T>("cdc.verb", opArgs, { signal, timeoutMs });
      };

      try {
        const out: Record<string, unknown> = { success: true, action: args.action, device: args.device };
        if (args.action === "focus") {
          const g = await verb<{ group: Array<{ ref: string; index: number; ptr: string; label: string }> }>("enc_group", {});
          const f = await verb<{ index: number; label: string; ptr: string }>("enc_focus", {});
          const delta = refToDelta(g.group, f.index, args.ref);
          out.from_index = f.index;
          out.to_index = f.index + delta;
          out.delta = delta;
          if (delta !== 0) out.result = await verb("enc_rotate", { delta });
        } else if (args.action === "press") {
          out.result = await verb("enc_press", { ms: args.ms ?? DEFAULT_PRESS_MS });
        } else if (args.action === "rotate") {
          out.delta = args.delta;
          out.result = await verb("enc_rotate", { delta: args.delta });
        } else if (args.action === "back") {
          out.result = await verb("app_self_close", {});
        } else if (args.action === "start_app") {
          const wait_s = args.wait_s ?? DEFAULT_START_WAIT_S;
          out.result = await verb("app_start", { name: args.name, wait_s }, wait_s * 1000 + 10_000);
        } else {
          out.result = await verb("app_stop", {});
        }
        if (args.return_snapshot !== false) {
          out.snapshot = await takeDeviceSnapshot(ctx, args.device, args.include, undefined, signal);
        }
        out.ts = Date.now();
        return jsonResponse(out);
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
