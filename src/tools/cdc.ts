// src/tools/cdc.ts — crosspad_cdc: typed CDC verbs (verbs.py through cdc.verb) plus a
// raw escape hatch (cdc.transact). System verbs BOOTLOADER_REQUEST / STM_DFU are
// danger tier: they only run after requireConfirmation().
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { ReplySchema } from "../hil/schemas.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { requireConfirmation } from "../policy/confirm.js";
import { jsonResponse, toolError, type ToolResult } from "../tool-result.js";

export const TOOL_NAME = "crosspad_cdc";

const DeviceArg = z.string().min(1).optional().describe("Device id (dev_xxxx) or port; omit when exactly one CrossPad is connected");
const ConfirmToken = z.string().optional().describe("Token from a previous confirmation_required result (danger verbs only)");
const PadIdx = z.number().int().min(0).max(15);
const Vel = z.number().int().min(0).max(127);
const AppName = z.string().min(1).max(31).regex(/^[A-Za-z0-9_-]+$/);
const RawCmd = z.string().min(1).max(200).regex(/^[\x20-\x7e]+$/, "cmd must be one printable ASCII line");

// Advertised shape (the SDK cannot publish a JSON schema for a top-level union);
// CdcInput below is what actually validates.
export const CdcInputShape = {
  verb: z.enum(["app", "kit", "pad", "enc", "led", "mem", "audio", "ble", "system", "raw"]).describe("Verb family; `raw` sends one literal CDC line"),
  action: z.string().optional().describe("Action inside the family (see the description); not used by raw"),
  device: DeviceArg,
  confirm_token: ConfirmToken,
  name: AppName.optional().describe("app start: app name as listed by action=list"),
  wait_s: z.number().min(0).max(120).optional().describe("app start / kit load: how long to wait for the device to confirm"),
  kit_id: z.number().int().min(0).optional().describe("kit load: kit id from action=list"),
  idx: PadIdx.optional().describe("pad press/release/pressure/info: pad index 0..15"),
  vel: Vel.optional().describe("pad press / ble send: velocity 0..127"),
  val: z.number().int().min(0).max(255).optional().describe("pad pressure: 0..255"),
  reset: z.boolean().optional().describe("pad stats: reset counters after reading"),
  delta: z.number().int().min(-64).max(64).optional().describe("enc rotate: detents, may be negative"),
  ms: z.number().int().min(1).max(60_000).optional().describe("enc press: hold time; ble scan: duration"),
  on: z.boolean().optional().describe("audio tasks: resume (true) or park (false) the RT mixer"),
  mode: z.number().int().min(0).max(1).optional().describe("ble start: 0=server 1=host"),
  addr: z.string().optional().describe("ble connect: peer address AA:BB:CC:DD:EE:FF"),
  note: Vel.optional().describe("ble send: MIDI note"),
  semis: z.number().int().min(-64).max(64).optional().describe("ble txoff: send transpose in semitones (not persisted)"),
  cmd: RawCmd.optional().describe("raw: exact CDC command line, e.g. 'KIT_STATUS'"),
  expect: z.string().max(40).optional().describe("raw: reply prefix to wait for (default: from the verb catalog)"),
  timeout_ms: z.number().int().min(50).max(60_000).optional().describe("raw: reply timeout"),
};

export const CdcInput = z.discriminatedUnion("verb", [
  z.object({
    verb: z.literal("app"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["list", "start", "stop", "destroy", "self_close", "versions"]),
    name: AppName.optional(),
    wait_s: z.number().min(0).max(30).optional(),
  }),
  z.object({
    verb: z.literal("kit"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["list", "status", "load"]),
    kit_id: z.number().int().min(0).optional(),
    wait_s: z.number().min(0).max(120).optional(),
  }),
  z.object({
    verb: z.literal("pad"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["press", "release", "pressure", "stats", "notes", "info"]),
    idx: PadIdx.optional(), vel: Vel.optional(), val: z.number().int().min(0).max(255).optional(),
    reset: z.boolean().optional(),
  }),
  z.object({
    verb: z.literal("enc"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["rotate", "press", "group", "focus", "state", "ui_state"]),
    delta: z.number().int().min(-64).max(64).optional(), ms: z.number().int().min(1).max(5000).optional(),
  }),
  z.object({ verb: z.literal("led"), device: DeviceArg, confirm_token: ConfirmToken, action: z.enum(["state"]) }),
  z.object({ verb: z.literal("mem"), device: DeviceArg, confirm_token: ConfirmToken, action: z.enum(["info", "blocks"]) }),
  z.object({
    verb: z.literal("audio"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["level", "tasks", "smpl_peak"]),
    on: z.boolean().optional(),
  }),
  z.object({
    verb: z.literal("ble"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["status", "start", "stop", "scan", "devices", "connect", "disconnect", "send", "txoff"]),
    mode: z.number().int().min(0).max(1).optional(),
    ms: z.number().int().min(100).max(60_000).optional(),
    addr: z.string().regex(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/).optional(),
    note: Vel.optional(), vel: Vel.optional(),
    semis: z.number().int().min(-64).max(64).optional(),
  }),
  z.object({
    verb: z.literal("system"), device: DeviceArg, confirm_token: ConfirmToken,
    action: z.enum(["cdc_stats", "bootloader_request", "stm_dfu"]),
  }),
  z.object({
    verb: z.literal("raw"), device: DeviceArg, confirm_token: ConfirmToken,
    cmd: RawCmd,
    expect: z.string().max(40).optional(),
    timeout_ms: z.number().int().min(50).max(60_000).optional(),
  }),
]);
export type CdcArgs = z.infer<typeof CdcInput>;

export const O_Cdc = {
  success: z.boolean(),
  device: z.string().optional(),
  verb: z.string().optional(),
  result: z.unknown().optional(),
  line: z.string().optional(),
  parsed: z.record(z.string(), z.unknown()).nullable().optional(),
  rtt_ms: z.number().optional(),
  extra_lines: z.array(z.string()).optional(),
  ts: z.number().optional(),
  resultType: z.string().optional(),
  confirmation: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
};

const DANGER_ACTIONS = new Set(["bootloader_request", "stm_dfu"]);

export function isDangerVerb(args: Record<string, unknown>): boolean {
  return args.verb === "system" && typeof args.action === "string" && DANGER_ACTIONS.has(args.action);
}

function pick(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/** Pure: tool args → daemon cdc.verb {verb, args} or cdc.transact args. */
export function toVerbCall(args: CdcArgs): { verb: string; args: Record<string, unknown> } | { raw: { cmd: string; expect?: string; timeout_s?: number } } {
  const a = args as unknown as Record<string, unknown>;
  switch (args.verb) {
    case "raw": {
      const raw: { cmd: string; expect?: string; timeout_s?: number } = { cmd: args.cmd };
      if (args.expect !== undefined) raw.expect = args.expect;
      if (args.timeout_ms !== undefined) raw.timeout_s = args.timeout_ms / 1000;
      return { raw };
    }
    case "app":
      return { verb: `app_${args.action}`, args: args.action === "start" ? pick(a, ["name", "wait_s"]) : {} };
    case "kit":
      return { verb: `kit_${args.action}`, args: args.action === "load" ? pick(a, ["kit_id", "wait_s"]) : {} };
    case "pad": {
      const keys: Record<string, string[]> = { press: ["idx", "vel"], release: ["idx"], pressure: ["idx", "val"], stats: ["reset"], notes: [], info: ["idx"] };
      return { verb: `pad_${args.action}`, args: pick(a, keys[args.action]) };
    }
    case "enc": {
      if (args.action === "ui_state") return { verb: "ui_state", args: {} };
      const keys: Record<string, string[]> = { rotate: ["delta"], press: ["ms"], group: [], focus: [], state: [] };
      return { verb: `enc_${args.action}`, args: pick(a, keys[args.action]) };
    }
    case "led":
      return { verb: "led_state", args: {} };
    case "mem":
      return { verb: args.action === "info" ? "mem" : "mem_blocks", args: {} };
    case "audio":
      if (args.action === "smpl_peak") return { verb: "smpl_peak", args: {} };
      return { verb: `audio_${args.action}`, args: args.action === "tasks" ? pick(a, ["on"]) : {} };
    case "ble": {
      const keys: Record<string, string[]> = { status: [], start: ["mode"], stop: [], scan: ["ms"], devices: [], connect: ["addr"], disconnect: [], send: ["note", "vel"], txoff: ["semis"] };
      return { verb: `ble_${args.action}`, args: pick(a, keys[args.action]) };
    }
    case "system":
      return { verb: args.action, args: {} };
  }
}

function summarize(args: CdcArgs): string {
  if (args.verb === "raw") return `send raw CDC '${args.cmd}' to ${args.device ?? "the only CrossPad"}`;
  if (args.verb === "system" && args.action === "bootloader_request") return `BOOTLOADER_REQUEST on ${args.device ?? "the only CrossPad"}: the ESP reboots into download mode and stops running firmware until flashed`;
  if (args.verb === "system" && args.action === "stm_dfu") return `STM_DFU on ${args.device ?? "the only CrossPad"}: the STM32 bridge enters DFU — the USB console, CDC and MIDI vanish until STM firmware is flashed`;
  return `${args.verb} ${(args as { action?: string }).action ?? ""} on ${args.device ?? "the only CrossPad"}`;
}

export function registerCdcTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      description:
        "[ESP HW] Typed CDC control verbs (main/hil_control.cpp) through the crosspad-hil daemon. verb=app {list|start name|stop|destroy|self_close|versions}, kit {list|status|load kit_id}, pad {press idx vel|release idx|pressure idx val|stats [reset]|notes|info idx}, enc {rotate delta|press [ms]|group|focus|state|ui_state}, led state, mem {info|blocks}, audio {level|tasks on|smpl_peak}, ble {status|start mode|stop|scan ms|devices|connect addr|disconnect|send note vel|txoff semis}, system {cdc_stats|bootloader_request|stm_dfu}, raw {cmd, expect?, timeout_ms?}. Typed verbs return parsed objects; raw returns line + best-effort parsed. bootloader_request / stm_dfu are danger tier and need confirmation. For UI driving prefer crosspad_ui (it re-snapshots). USB profile switches go through crosspad_usb_mode, not raw USB_AUDIO.",
      inputSchema: CdcInputShape,
      outputSchema: O_Cdc,
      annotations: annotationsFor(tierOf(TOOL_NAME, { verb: "pad", action: "press" })),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const parsed = CdcInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            hint: "Each verb family accepts its own actions; `raw` takes a single printable ASCII line in `cmd`.",
          },
        });
      }
      const args = parsed.data;
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse({ success: false, error: { code: "HIDDEN", message: `${TOOL_NAME} ${args.verb} is hidden by policy` } });
      }
      if (decision === "confirm") {
        const c = await requireConfirmation(
          server,
          extra as RequestHandlerExtra<ServerRequest, ServerNotification>,
          TOOL_NAME,
          argsRec,
          summarize(args),
        );
        if (c.status === "token") return c.result as ToolResult;
        if (c.status === "declined") return jsonResponse({ success: false, error: { code: "CANCELLED_BY_USER", message: "declined by the user" } });
      }
      const call = toVerbCall(args);
      try {
        if ("raw" in call) {
          const opArgs: Record<string, unknown> = { ...call.raw };
          if (args.device !== undefined) opArgs.device = args.device;
          const reply = ReplySchema.parse(await ctx.daemon().request("cdc.transact", opArgs, { signal: extra.signal, timeoutMs: (call.raw.timeout_s ?? 2) * 1000 + 5000 }));
          return jsonResponse({ success: true, device: args.device, line: reply.line, parsed: reply.parsed, rtt_ms: reply.rtt_ms, extra_lines: reply.extra_lines, ts: Date.now() });
        }
        const opArgs: Record<string, unknown> = {};
        if (args.device !== undefined) opArgs.device = args.device;
        opArgs.verb = call.verb;
        opArgs.args = call.args;
        const waitS = typeof (call.args as { wait_s?: number }).wait_s === "number" ? (call.args as { wait_s: number }).wait_s : 15;
        const result = await ctx.daemon().request<unknown>("cdc.verb", opArgs, { signal: extra.signal, timeoutMs: waitS * 1000 + 10_000 });
        return jsonResponse({ success: true, device: args.device, verb: call.verb, result, ts: Date.now() });
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
