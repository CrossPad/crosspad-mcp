// src/tools/apps.ts — crosspad_apps: the v10 front door for the five v9
// crosspad_apps_* tools. One `action` field replaces five tool schemas; the
// work still happens in app-manager.ts, which is the only place that knows how
// each platform repo lays out app_manager.py.
//
// Why this is not routed through `idf.py app-*`, which platform-idf's CLAUDE.md
// names as the supported entry point: idf_ext.py's app-list/install/remove/
// update/sync callbacks are two lines each — they import AppManager and call
// exactly the method this tool already calls. Going through idf.py would buy
// nothing behavioural and would cost a sourced ESP-IDF export environment
// (idf.py is not on PATH without `. export.sh`), on a tool that also has to
// serve crosspad-pc and ESP32-S3, where no idf.py exists at all. The track
// policy, the "never run over local work" guard and the backups all live inside
// AppManager, not in the CLI wrapper, so they apply either way.
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { decide } from "../policy/policy.js";
import { requireConfirmation, CONFIRMATION_OUTPUT } from "../policy/confirm.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { jsonResponse, toolError, type ToolResult, ErrorSchema } from "../tool-result.js";
import type { OnLine } from "../utils/exec.js";
import {
  appGuard,
  crosspadAppInstall,
  crosspadAppList,
  crosspadAppRemove,
  crosspadAppSync,
  crosspadAppUpdate,
  getAvailablePlatforms,
  type AppActionResult,
  type AppGuardVerdict,
  type AppListResult,
  type PlatformInfo,
} from "./app-manager.js";

export const TOOL_NAME = "crosspad_apps";

// App names and git refs end up as arguments to git and to a generated Python
// literal, so they stay on a strict character set rather than being escaped.
const AppName = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, "App name must be alphanumeric (with _ or -)");
const GitRef = z.string().min(1).max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, "Invalid git ref — letters/digits/._/- only")
  .refine((s) => !s.startsWith("-"), "Ref cannot start with '-'")
  .refine((s) => !s.includes(".."), "Ref cannot contain '..'");
const Platform = z.enum(["idf", "pc", "arduino"]).default("idf")
  .describe("Platform repo: idf=platform-idf (default), pc=crosspad-pc, arduino=ESP32-S3");

// Advertised shape — the SDK cannot publish a JSON schema for a top-level
// union, so clients see the flat superset and AppsInput does the validating.
export const AppsInputShape = {
  action: z.enum(["list", "install", "remove", "update", "sync"])
    .describe("list reads the registry (no Python needed); install/remove/update/sync mutate a checkout"),
  confirm_token: z.string().optional()
    .describe("Echo the token from a confirmation_required reply to proceed"),
  platform: Platform,
  show_all: z.boolean().optional().describe("list: include apps incompatible with every detected platform"),
  app_name: AppName.optional().describe("install/remove/update: app ID from the registry, e.g. 'sampler'"),
  ref: GitRef.optional().describe("install: git ref to check out (default 'main')"),
  force: z.boolean().optional().describe("install: install even if the registry marks the app incompatible"),
  update_all: z.boolean().optional().describe("update: update every installed app instead of one named app"),
};

const ConfirmToken = z.string().optional();

export const AppsInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    platform: Platform.optional(),
    show_all: z.boolean().optional(),
    confirm_token: ConfirmToken,
  }),
  z.object({
    action: z.literal("install"),
    platform: Platform,
    app_name: AppName,
    ref: GitRef.optional(),
    force: z.boolean().optional(),
    confirm_token: ConfirmToken,
  }),
  z.object({
    action: z.literal("remove"),
    platform: Platform,
    app_name: AppName,
    confirm_token: ConfirmToken,
  }),
  z.object({
    action: z.literal("update"),
    platform: Platform,
    app_name: AppName.optional(),
    update_all: z.boolean().optional(),
    confirm_token: ConfirmToken,
  }),
  z.object({
    action: z.literal("sync"),
    platform: Platform,
    confirm_token: ConfirmToken,
  }),
]);
export type AppsArgs = z.infer<typeof AppsInput>;

// `result` is deliberately an open record rather than a spread of the
// app-manager payload: a closed output schema plus a sub-result that grows a
// field is a validation failure at the client, and the sub-result is not this
// tool's to freeze.
export const O_Apps = {
  ...CONFIRMATION_OUTPUT,
  success: z.boolean(),
  action: z.string().optional(),
  platform: z.string().optional(),
  app_name: z.string().optional(),
  /** The app-manager payload verbatim: apps/counts for list, output for the rest. */
  result: z.record(z.string(), z.unknown()).optional(),
  /** What the caller must still do for the change to reach the firmware. */
  next: z.string().optional(),
  ts: z.number().optional(),
  error: ErrorSchema.optional(),
};

/** Actions that rewrite a submodule and so need the local-work guard. */
const MUTATING_ACTIONS = new Set(["install", "remove", "update"]);

/**
 * Everything this tool reaches the outside world with, injectable so the
 * dispatch can be tested without spawning Python or touching a git checkout.
 */
export interface AppsDeps {
  list: (showAll: boolean) => AppListResult;
  install: (app: string, platform: string, ref: string, force: boolean, onLine?: OnLine, signal?: AbortSignal) => Promise<AppActionResult>;
  remove: (app: string, platform: string, onLine?: OnLine, signal?: AbortSignal) => Promise<AppActionResult>;
  update: (platform: string, app: string | undefined, updateAll: boolean, onLine?: OnLine, signal?: AbortSignal) => Promise<AppActionResult>;
  sync: (platform: string, onLine?: OnLine, signal?: AbortSignal) => Promise<AppActionResult>;
  guard: (info: PlatformInfo, app: string, signal?: AbortSignal) => Promise<AppGuardVerdict | null>;
  platforms: () => PlatformInfo[];
}

export const defaultDeps: AppsDeps = {
  list: crosspadAppList,
  install: crosspadAppInstall,
  remove: crosspadAppRemove,
  update: crosspadAppUpdate,
  sync: crosspadAppSync,
  guard: appGuard,
  platforms: getAvailablePlatforms,
};

type Payload = Record<string, unknown>;

function fail(action: string, platform: string | undefined, code: string, message: string, hint?: string): Payload {
  const error: Record<string, unknown> = { code, message };
  if (hint !== undefined) error.hint = hint;
  return { success: false, action, ...(platform ? { platform } : {}), error, ts: Date.now() };
}

/**
 * Refuse an install/remove/update that would run over work the developer has
 * not pushed anywhere. The underlying app-manager checks this too; doing it
 * here as well is what turns "the Python printed something" into a typed
 * error the model can act on, and it costs two git reads.
 */
async function refuseIfLocalWork(
  deps: AppsDeps,
  action: string,
  platform: string,
  appName: string,
  signal?: AbortSignal,
): Promise<Payload | null> {
  const info = deps.platforms().find((p) => p.label === platform);
  if (!info) return null; // the app-manager call reports the unknown platform
  const verdict = await deps.guard(info, appName, signal);
  if (!verdict || verdict.safe) return null;
  return {
    success: false,
    action,
    platform,
    app_name: appName,
    result: { detail: verdict.detail, reason: verdict.reason },
    error: {
      code: "LOCAL_WORK",
      message: `${appName} has local work that ${action} would run over (${verdict.reason}).`,
      hint:
        `Commit or stash it, or run \`idf.py app-${action} --app ${appName} --force\`, ` +
        `which snapshots to .crosspad/backups/ before proceeding.`,
    },
    ts: Date.now(),
  };
}

/**
 * Which apps `update_all` would actually rewrite on this platform. The manifest
 * reader lives inside app-manager, so the registry listing is the only view of
 * it this tool has; when that listing is unavailable there is no way to know
 * what is about to be overwritten, and answering "nothing" is how update_all
 * came to be unguarded in the first place.
 */
function installedAppNames(deps: AppsDeps, platform: string): { apps: string[] } | { error: Payload } {
  const listed = deps.list(true);
  if (!listed.success) {
    return {
      error: fail(
        "update", platform, "GUARD_UNAVAILABLE",
        "Cannot tell which apps update_all would rewrite: the crosspad-apps registry could not be loaded.",
        "Ensure the 'gh' CLI is authenticated, or update one app at a time with `app_name` — that path checks git directly and needs no registry.",
      ),
    };
  }
  return { apps: listed.apps.filter((a) => a.installed_in.some((i) => i.platform === platform)).map((a) => a.id) };
}

/** An AppActionResult flattened into this tool's envelope. */
function fromAction(r: AppActionResult): Payload {
  const payload: Payload = {
    success: r.success,
    action: r.action,
    platform: r.platform,
    result: { output: r.output },
    ts: Date.now(),
  };
  if (r.app_name !== undefined) payload.app_name = r.app_name;
  if (r.next !== undefined) payload.next = r.next;
  if (!r.success) payload.error = { code: "APP_MANAGER", message: r.error ?? r.output ?? "app manager failed" };
  return payload;
}

/** Pure-ish dispatch: one action in, one envelope out. */
export async function runApps(
  args: AppsArgs,
  deps: AppsDeps = defaultDeps,
  onLine?: OnLine,
  signal?: AbortSignal,
): Promise<Payload> {
  const platform = (args as { platform?: string }).platform ?? "idf";
  const appName = (args as { app_name?: string }).app_name;

  if (MUTATING_ACTIONS.has(args.action) && appName) {
    const refusal = await refuseIfLocalWork(deps, args.action, platform, appName, signal);
    if (refusal) return refusal;
  }

  switch (args.action) {
    case "list": {
      const r = deps.list(args.show_all ?? false);
      const payload: Payload = {
        success: r.success,
        action: "list",
        result: { apps: r.apps, installed_count: r.installed_count, total_count: r.total_count },
        ts: Date.now(),
      };
      if (!r.success) {
        payload.error = {
          code: "NO_REGISTRY",
          message: r.error ?? "could not load the crosspad-apps registry",
          hint: "Ensure the 'gh' CLI is installed and authenticated, then retry.",
        };
      }
      return payload;
    }
    case "install":
      return fromAction(await deps.install(args.app_name, platform, args.ref ?? "main", args.force ?? false, onLine, signal));
    case "remove":
      return fromAction(await deps.remove(args.app_name, platform, onLine, signal));
    case "update": {
      const updateAll = args.update_all ?? false;
      // Both or neither is ambiguous in a way the Python cannot resolve, so it
      // is rejected here rather than guessed at.
      if (!args.app_name && !updateAll) {
        return fail("update", platform, "INVALID_ARGS", "Set `app_name` to update one app, or `update_all: true` to update every installed app.");
      }
      if (args.app_name && updateAll) {
        return fail("update", platform, "INVALID_ARGS", "`app_name` and `update_all: true` are mutually exclusive — pick one.");
      }
      if (updateAll) {
        // The guard above only runs for a named app, which left the one variant
        // that rewrites *every* submodule as the only unguarded path — the exact
        // opposite of what the tool description promises.
        const listed = installedAppNames(deps, platform);
        if ("error" in listed) return listed.error;
        for (const name of listed.apps) {
          const refusal = await refuseIfLocalWork(deps, "update", platform, name, signal);
          if (refusal) return refusal;
        }
      }
      return fromAction(await deps.update(platform, args.app_name, updateAll, onLine, signal));
    }
    case "sync":
      return fromAction(await deps.sync(platform, onLine, signal));
    default: {
      const unknown = (args as { action?: unknown }).action;
      return fail(String(unknown ?? ""), platform, "UNKNOWN_ACTION", `Unknown action "${String(unknown)}"; expected list, install, remove, update or sync.`);
    }
  }
}

/** What a confirmation prompt says this call would do. */
function summarizeApps(args: AppsArgs): string {
  const platform = (args as { platform?: string }).platform ?? "idf";
  const app = (args as { app_name?: string }).app_name;
  switch (args.action) {
    case "list": return "Read the crosspad-apps registry.";
    case "sync": return `Rebuild ${platform}'s app manifest from what is on disk.`;
    case "update":
      return (args as { update_all?: boolean }).update_all
        ? `Update every app installed on ${platform} — this rewrites each submodule.`
        : `Update the ${app} submodule on ${platform}.`;
    default: return `${args.action} the ${app} submodule on ${platform}.`;
  }
}

/** Mirror the app manager's stdout onto the client's logging channel. */
function streamLogger(server: McpServer): OnLine {
  return (stream, line) => {
    if (!line.trim()) return;
    server.server
      .sendLoggingMessage({ level: stream === "stderr" ? "warning" : "info", logger: TOOL_NAME, data: line })
      .catch(() => {});
  };
}

export function registerAppsTool(server: McpServer, ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    TOOL_NAME,
    {
      title: "CrossPad app package manager",
      description:
        "Manage CrossPad apps from the crosspad-apps registry (git submodules under components/). " +
        "action=list reads app-registry.json + apps.json across every detected repo and needs no Python; " +
        "action=install {app_name, ref?, force?}, action=remove {app_name}, action=update {app_name | update_all}, " +
        "action=sync rebuild the manifest from disk — all four delegate to <repo>/{tools|scripts}/app_manager.py and need the 'gh' CLI authenticated. " +
        "`platform` selects the repo (idf default, pc, arduino). install/remove/update refuse to run over an app checkout with uncommitted or unpushed work — update_all included, which checks every installed app before it starts. " +
        "Different from crosspad_list_apps_source, which scans REGISTER_APP() in source code. " +
        "SAFETY: annotations are static per tool, so this one is advertised at its worst case. Only install/remove/update/sync rewrite a checkout; action=list just reads app-registry.json and apps.json and changes nothing.",
      inputSchema: AppsInputShape,
      outputSchema: O_Apps,
      // Deliberately the worst action this tool has, not a representative one:
      // the tier is per-call, one annotation has to cover every call, and an
      // under-stated hint is the dangerous direction to be wrong in. The
      // description says which action is actually read-only.
      annotations: annotationsFor(tierOf(TOOL_NAME, { action: "install" })),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const parsed = AppsInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse(fail(
          String((rawArgs as { action?: unknown } | undefined)?.action ?? ""),
          undefined,
          "INVALID_ARGS",
          parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
          "install/remove need app_name; update needs app_name or update_all.",
        ));
      }
      const args = parsed.data;
      const argsRec = args as unknown as Record<string, unknown>;
      const decision = decide(ctx.policy, TOOL_NAME, argsRec);
      if (decision === "hidden") {
        return jsonResponse(fail(args.action, undefined, "HIDDEN", `${TOOL_NAME} ${args.action} is hidden by policy`));
      }
      // The engine's third answer. Falling through on it meant a rule that put
      // `confirm` on this tool installed or removed a submodule anyway.
      if (decision === "confirm") {
        const outcome = await requireConfirmation(server, extra, TOOL_NAME, argsRec, summarizeApps(args));
        if (outcome.status === "token") {
          return jsonResponse(outcome.result.structuredContent as Record<string, unknown>);
        }
        if (outcome.status === "declined") {
          return jsonResponse(fail(
            args.action,
            (args as { platform?: string }).platform,
            "CANCELLED_BY_USER",
            `${TOOL_NAME} was declined by the user.`,
            "Do not retry automatically; ask before issuing this call again.",
          ));
        }
      }
      try {
        return jsonResponse(await runApps(args, defaultDeps, streamLogger(server), extra.signal));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
