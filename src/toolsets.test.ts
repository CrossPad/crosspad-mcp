import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { TOOLSETS, ToolsetManager, initialToolsets, hasReadOnlyFlag, toolsetOf } from "./toolsets.js";
import type { Policy } from "./policy/policy.js";

const STRICT: Policy = { mode: "strict", rules: [] };
const READONLY: Policy = { mode: "readonly", rules: [] };

// Register one stub tool per name of every toolset, in TOOLSETS order.
function stubAll(server: McpServer, manager: ToolsetManager): void {
  for (const [toolset, names] of Object.entries(TOOLSETS)) {
    for (const name of names) {
      const tool = server.registerTool(
        name,
        { description: `stub ${name}`, inputSchema: { action: z.string().optional() } },
        async () => ({ content: [{ type: "text", text: name }] }),
      );
      manager.register(name, tool, toolset);
    }
  }
}

async function connect(server: McpServer) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const listNames = async () => (await client.listTools()).tools.map((t) => t.name);
  return { client, listNames };
}

describe("TOOLSETS", () => {
  it("has the spec §3.1 keys in order and core has 8 tools", () => {
    expect(Object.keys(TOOLSETS)).toEqual(["core", "device", "hil", "sim", "code", "git", "apps", "trace"]);
    expect(TOOLSETS.core).toEqual([
      "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_build", "crosspad_flash",
      "crosspad_repo_status", "crosspad_toolsets", "crosspad_task",
    ]);
    expect(TOOLSETS.hil).toEqual([]);
    expect(toolsetOf("crosspad_commit")).toBe("git");
    expect(toolsetOf("crosspad_log")).toBe("sim");
    expect(toolsetOf("nope")).toBeUndefined();
  });
});

describe("ToolsetManager", () => {
  let server: McpServer;
  let client: Client | null = null;
  beforeEach(() => { server = new McpServer({ name: "t", version: "0" }); });
  afterEach(async () => { await client?.close(); client = null; await server.close(); });

  it("only core is visible after enabling core", async () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    m.enable("core");
    const c = await connect(server); client = c.client;
    expect(await c.listNames()).toEqual(TOOLSETS.core);
    expect(m.enabled()).toEqual(["core"]);
  });

  it("nothing is visible before any enable", async () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    const c = await connect(server); client = c.client;
    expect(await c.listNames()).toEqual([]);
  });

  it("enable adds the toolset's tools and emits tools/list_changed", async () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    m.enable("core");
    const c = await connect(server); client = c.client;
    const spy = vi.spyOn(server, "sendToolListChanged");
    const added = m.enable("git");
    expect(added).toEqual(["crosspad_commit", "crosspad_repo_diff", "crosspad_submodule_update"]);
    expect(spy).toHaveBeenCalled();
    expect(await c.listNames()).toEqual([...TOOLSETS.core, ...TOOLSETS.git]);
    expect(m.enabled()).toEqual(["core", "git"]);
    // idempotent: enabling again adds nothing
    expect(m.enable("git")).toEqual([]);
  });

  it("disable removes the tools; core cannot be disabled", async () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    m.enable("core"); m.enable("sim");
    const c = await connect(server); client = c.client;
    const removed = m.disable("sim");
    expect(removed).toEqual([...TOOLSETS.sim].sort());
    expect(await c.listNames()).toEqual(TOOLSETS.core);
    expect(() => m.disable("core")).toThrow(/core/);
    expect(() => m.enable("nope")).toThrow(/unknown toolset/);
  });

  it("readonly never enables non-read tools, in any toolset", async () => {
    const m = new ToolsetManager(server, READONLY);
    stubAll(server, m);
    m.enable("core");
    m.enable("git");
    m.enable("sim");
    const c = await connect(server); client = c.client;
    const names = await c.listNames();
    expect(names).toEqual([
      "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_repo_status", "crosspad_toolsets", "crosspad_task",
      "crosspad_check", "crosspad_screenshot", "crosspad_stats", "crosspad_settings_get",
      "crosspad_repo_diff",
    ]);
    expect(m.visible("crosspad_flash")).toBe(false);
    expect(m.visible("crosspad_devices")).toBe(true);
    expect(m.hiddenTools()).toContain("crosspad_flash");
    expect(m.hiddenTools()).toContain("crosspad_commit");
    // calling a hidden tool is an error, not a silent no-op. (The SDK 1.29
    // client surfaces "tool not found" as isError rather than rejecting.)
    const denied = await c.client.callTool({ name: "crosspad_flash", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain("not found");
  });

  it("order is deterministic across two servers", async () => {
    const s2 = new McpServer({ name: "t2", version: "0" });
    const m1 = new ToolsetManager(server, STRICT);
    const m2 = new ToolsetManager(s2, STRICT);
    stubAll(server, m1); stubAll(s2, m2);
    for (const ts of ["core", "apps", "device"]) { m1.enable(ts); m2.enable(ts); }
    const c1 = await connect(server); client = c1.client;
    const c2 = await connect(s2);
    expect(await c1.listNames()).toEqual(await c2.listNames());
    expect(await c1.listNames()).toEqual([...TOOLSETS.core, ...TOOLSETS.device, ...TOOLSETS.apps]);
    await c2.client.close(); await s2.close();
  });

  it("describe reports tier + state per tool", () => {
    const m = new ToolsetManager(server, STRICT);
    stubAll(server, m);
    m.enable("core");
    const d = m.describe("core");
    expect(d.name).toBe("core");
    expect(d.enabled).toBe(true);
    expect(d.tools.find((t) => t.name === "crosspad_flash")).toEqual({ name: "crosspad_flash", tier: "danger", enabled: true, hidden: false });
    expect(m.describe("git").enabled).toBe(false);
  });
});

describe("startup flags", () => {
  it("core always; env and --toolsets add; 'all' expands; unknown ignored", () => {
    expect(initialToolsets([], {})).toEqual(["core"]);
    expect(initialToolsets(["--toolsets", "git,sim"], {})).toEqual(["core", "sim", "git"]);
    expect(initialToolsets(["--toolsets=apps"], { CROSSPAD_TOOLSETS: "trace, device" })).toEqual(["core", "device", "apps", "trace"]);
    expect(initialToolsets(["--toolsets", "all"], {})).toEqual(Object.keys(TOOLSETS));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(initialToolsets(["--toolsets", "bogus,core"], {})).toEqual(["core"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bogus"));
  });
  it("--read-only", () => {
    expect(hasReadOnlyFlag(["--http", "3000"])).toBe(false);
    expect(hasReadOnlyFlag(["--read-only"])).toBe(true);
  });
});