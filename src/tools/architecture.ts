import fs from "fs";
import path from "path";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRepos, resolveCrosspadCore } from "../config.js";
import { git, type GitOpts } from "../utils/git.js";
import { mapLimit, DEFAULT_CONCURRENCY } from "../utils/async.js";
import type { ToolContext } from "../tool-context.js";
import { annotationsFor, tierOf } from "../policy/tiers.js";
import { errorResult, jsonResponse, type ToolResult } from "../tool-result.js";

// --- crosspad_interfaces ---

export interface InterfaceInfo {
  name: string;
  file: string;
}

export interface ImplementationInfo {
  className: string;
  file: string;
  platform: string;
}

function findInterfaces(): InterfaceInfo[] {
  const corePath = resolveCrosspadCore();
  if (!corePath) return [];

  const coreInclude = path.join(corePath, "include", "crosspad");
  const results: InterfaceInfo[] = [];

  function scan(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.startsWith("I") && entry.name.endsWith(".hpp")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        const match = content.match(/class\s+(I[A-Z]\w+)\b/);
        if (match) {
          results.push({
            name: match[1],
            file: fullPath.replace(/\\/g, "/"),
          });
        }
      }
    }
  }

  scan(coreInclude);
  return results;
}

async function findImplementations(interfaceName: string, opts: GitOpts): Promise<ImplementationInfo[]> {
  const results: ImplementationInfo[] = [];
  // Use explicit char classes — POSIX ERE in some git builds doesn't
  // honour \w/\s inside character classes. Word boundary at the end of
  // interfaceName so e.g. "IPad" doesn't match "IPadding".
  const W = "[A-Za-z0-9_]";
  const WS = "[ \\t]";
  const escIface = interfaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `class${WS}+${W}+.*:${WS}*(public${WS}+)?.*${escIface}([^A-Za-z0-9_]|$)`;
  const repos = getRepos();

  const platformMap: Record<string, string> = {
    "crosspad-core": "shared",
    "crosspad-gui": "gui",
    "crosspad-pc": "PC",
    "ESP32-S3": "arduino",
    "platform-idf": "idf",
  };

  const grepped = await mapLimit(
    Object.entries(repos),
    DEFAULT_CONCURRENCY,
    async ([name, repoPath]) => ({
      name,
      repoPath,
      result: await git(`git grep --recurse-submodules -n -E "${pattern}" -- "*.hpp" "*.cpp" "*.h"`, repoPath, opts),
    }),
    opts.signal,
  );

  for (const { name, repoPath, result } of grepped) {
    if (!result.success && result.stdout.length === 0) continue;

    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;

      const filePart = line.slice(0, colonIdx);
      const codePart = line.slice(colonIdx + 1);

      const lineNumMatch = codePart.match(/^(\d+):(.*)/);
      const code = lineNumMatch ? lineNumMatch[2] : codePart;

      const classMatch = code.match(/class\s+(\w+)/);
      if (classMatch) {
        results.push({
          className: classMatch[1],
          file: path.join(repoPath, filePart).replace(/\\/g, "/"),
          platform: platformMap[name] ?? name,
        });
      }
    }
  }

  return results;
}

interface CapabilityInfo {
  flags: string[];
  platforms: Record<string, string[]>;
}

async function queryCapabilities(opts: GitOpts): Promise<CapabilityInfo> {
  const corePath = resolveCrosspadCore();
  const flags: string[] = [];

  if (corePath) {
    const capsFile = path.join(corePath, "include", "crosspad", "platform", "PlatformCapabilities.hpp");
    if (fs.existsSync(capsFile)) {
      const content = fs.readFileSync(capsFile, "utf-8");
      const enumMatch = content.match(/enum\s+class\s+Capability[^{]*\{([^}]+)\}/s);
      if (enumMatch) {
        for (const line of enumMatch[1].split("\n")) {
          const flagMatch = line.match(/\b(\w+)\s*=/);
          if (flagMatch && flagMatch[1] !== "None" && flagMatch[1] !== "All") {
            flags.push(flagMatch[1]);
          }
        }
      }
    }
  }

  const repos = getRepos();
  const platformMap: Record<string, string> = {
    "crosspad-pc": "PC",
    "ESP32-S3": "arduino",
    "platform-idf": "idf",
  };

  const platforms: Record<string, string[]> = {};

  // Use -F (fixed strings) with multiple -e patterns to avoid regex
  // dialect issues across git builds.
  const capGrepped = await mapLimit(
    Object.entries(repos).filter(([name]) => platformMap[name]),
    DEFAULT_CONCURRENCY,
    async ([name, repoPath]) => ({
      name,
      result: await git(
        `git grep -h -F -e "addPlatformCapability" -e "setPlatformCapabilities" -- "*.cpp" "*.hpp" "*.h"`,
        repoPath,
        opts,
      ),
    }),
    opts.signal,
  );

  for (const { name, result } of capGrepped) {
    if (!result.success && result.stdout.length === 0) continue;

    const caps: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const matches = line.match(/Capability::(\w+)/g);
      if (matches) {
        for (const m of matches) {
          const cap = m.replace("Capability::", "");
          if (!caps.includes(cap)) caps.push(cap);
        }
      }
    }
    if (caps.length > 0) {
      platforms[platformMap[name]] = caps;
    }
  }

  return { flags, platforms };
}

export async function crosspadInterfaces(
  query: string,
  opts: GitOpts = {},
): Promise<Record<string, unknown>> {
  const parts = query.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();

  if (command === "list") {
    return { interfaces: findInterfaces() };
  }

  if (command === "implementations" && parts[1]) {
    const interfaceName = parts[1];
    const interfaces = findInterfaces();
    const defined = interfaces.find((i) => i.name === interfaceName);
    return {
      interface: interfaceName,
      defined_in: defined?.file ?? "not found",
      implementations: await findImplementations(interfaceName, opts),
    };
  }

  if (command === "capabilities") {
    const caps = await queryCapabilities(opts);
    return { flags: caps.flags, platforms: caps.platforms };
  }

  return {
    error: `Unknown query: "${query}". Use "list", "implementations <InterfaceName>", or "capabilities".`,
  };
}

// --- crosspad_architecture (v10 front door) ---
//
// One tool where v9 had three. `crosspad_list_interfaces`,
// `crosspad_interface_implementations` and `crosspad_capabilities` answered
// three questions about the same thing — the crosspad-core abstraction layer —
// and cost three tool schemas of context to do it. This is a new front door on
// the same `crosspadInterfaces()` implementation, not a second one: the v9
// names stay registered so existing call sites keep working.

export const ARCHITECTURE_TOOL = "crosspad_architecture";

/** Interface names are `I` + PascalCase in crosspad-core; anything else is a typo. */
const InterfaceName = z
  .string()
  .min(1)
  .regex(/^I[A-Z][A-Za-z0-9_]*$/, "Interface name must start with 'I' followed by an uppercase letter (e.g. 'IDisplay').")
  .describe("Interface name — MUST start with 'I' and use the exact crosspad-core casing (e.g. 'IDisplay', 'IPadLogicHandler'). Not 'Display', not 'iDisplay'.");

// Advertised shape (the SDK cannot publish a JSON schema for a top-level
// union); ArchitectureInput below is what actually validates.
export const ArchitectureInputShape = {
  action: z
    .enum(["interfaces", "implementations", "capabilities"])
    .describe("interfaces = list crosspad-core interfaces; implementations = find classes implementing one; capabilities = platform capability flags"),
  interface_name: InterfaceName.optional().describe("Required by action=implementations; ignored otherwise"),
};

export const ArchitectureInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("interfaces") }),
  z.object({ action: z.literal("implementations"), interface_name: InterfaceName }),
  z.object({ action: z.literal("capabilities") }),
]);
export type ArchitectureArgs = z.infer<typeof ArchitectureInput>;

export const O_Architecture = {
  success: z.boolean(),
  action: z.string().optional(),
  // The per-action payload lives here rather than being spread across this
  // schema: three actions with three different shapes cannot all be declared
  // in one closed record without the outputSchema rejecting whichever ran.
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
};

export type ArchitectureOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Dispatch an action onto the v9 implementation. Takes a loose `action` on
 * purpose: a client that predates the enum can reach this without the zod
 * layer, and an unknown action must come back as an error rather than as
 * `undefined`.
 */
export async function runArchitecture(
  args: { action: string; interface_name?: string },
  opts: GitOpts = {},
): Promise<ArchitectureOutcome> {
  switch (args.action) {
    case "interfaces":
      return { ok: true, result: await crosspadInterfaces("list", opts) };
    case "implementations": {
      if (!args.interface_name) {
        return { ok: false, message: "action=implementations needs interface_name (e.g. 'IPadLogicHandler')" };
      }
      return { ok: true, result: await crosspadInterfaces(`implementations ${args.interface_name}`, opts) };
    }
    case "capabilities":
      return { ok: true, result: await crosspadInterfaces("capabilities", opts) };
    default:
      return {
        ok: false,
        message: `unknown action "${args.action}"; expected one of: interfaces, implementations, capabilities`,
      };
  }
}

export function registerArchitectureTool(server: McpServer, _ctx: ToolContext): RegisteredTool {
  return server.registerTool(
    ARCHITECTURE_TOOL,
    {
      title: "Inspect the CrossPad abstraction layer",
      description:
        "The crosspad-core abstraction layer, three ways. action=interfaces lists the I*-prefixed interfaces in crosspad-core/include/crosspad/. action=implementations finds every class implementing one, across all repos, with the platform it belongs to (run action=interfaces first if you do not know the exact name). action=capabilities lists the Capability enum flags and which ones each platform sets. Replaces crosspad_list_interfaces / crosspad_interface_implementations / crosspad_capabilities, which still work. For symbols that are not interfaces, use crosspad_search_symbols.",
      inputSchema: ArchitectureInputShape,
      outputSchema: O_Architecture,
      annotations: annotationsFor(tierOf(ARCHITECTURE_TOOL, {})),
    },
    async (rawArgs, extra): Promise<ToolResult> => {
      const parsed = ArchitectureInput.safeParse(rawArgs);
      if (!parsed.success) {
        return jsonResponse({
          success: false,
          error: {
            code: "INVALID_ARGS",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
            hint: "action is one of interfaces | implementations | capabilities; implementations also needs interface_name.",
          },
        });
      }
      try {
        const outcome = await runArchitecture(parsed.data, { signal: extra?.signal });
        if (!outcome.ok) {
          return jsonResponse({ success: false, action: parsed.data.action, error: { code: "INVALID_ARGS", message: outcome.message } });
        }
        return jsonResponse({ success: true, action: parsed.data.action, result: outcome.result });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

// --- crosspad_apps ---

export interface AppInfo {
  name: string;
  registration_file: string;
  platform: string;
}

export async function crosspadApps(
  platform: "pc" | "idf" | "arduino" | "all",
  opts: GitOpts = {},
): Promise<AppInfo[]> {
  const results: AppInfo[] = [];
  const repos = getRepos();

  const targets: [string, string, string[]][] = [];
  // [platformLabel, repoPath, searchDirs]

  if (platform === "pc" || platform === "all") {
    if (repos["crosspad-pc"]) {
      targets.push(["PC", repos["crosspad-pc"], []]);
    }
  }
  if (platform === "arduino" || platform === "all") {
    if (repos["ESP32-S3"]) {
      targets.push(["arduino", repos["ESP32-S3"], []]);
    }
  }
  if (platform === "idf" || platform === "all") {
    if (repos["platform-idf"]) {
      targets.push(["idf", repos["platform-idf"], []]);
    }
  }

  // Search for REGISTER_APP and _register_*_app patterns.
  // Use [A-Za-z0-9_] instead of \w for portability across git/POSIX builds.
  const appGrepped = await mapLimit(
    targets,
    DEFAULT_CONCURRENCY,
    async ([platName, repoPath]) => ({
      platName,
      result: await git(
        `git grep --recurse-submodules -n -E "REGISTER_APP\\(|void _register_[A-Za-z0-9_]+_app\\(\\)" -- "*.cpp"`,
        repoPath,
        opts,
      ),
    }),
    opts.signal,
  );

  for (const { platName, result } of appGrepped) {
    if (!result.success && result.stdout.length === 0) continue;

    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;

      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const filePart = line.slice(0, colonIdx);
      const rest = line.slice(colonIdx + 1);

      // REGISTER_APP(Name, ...)
      let match = rest.match(/REGISTER_APP\((\w+)/);
      if (match) {
        results.push({
          name: match[1],
          registration_file: filePart,
          platform: platName,
        });
        continue;
      }

      // void _register_Name_app()
      match = rest.match(/_register_(\w+)_app\(/);
      if (match) {
        results.push({
          name: match[1],
          registration_file: filePart,
          platform: platName,
        });
      }
    }
  }

  // Deduplicate by name+platform
  const seen = new Set<string>();
  return results.filter((app) => {
    const key = `${app.platform}:${app.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
