import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { TOOLSETS, ToolsetManager } from "../toolsets.js";
import { registerToolsetsTool } from "./toolsets-tool.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";

function ctxWith(policy: Policy): ToolContext {
  // Only `policy` is read by this tool; the rest are never touched here.
  return { policy, daemon: () => { throw new Error("no daemon in test"); }, jobs: {} as never, handles: {} as never };
}

async function setup(policy: Policy) {
  const server = new McpServer({ name: "t", version: "0" });
  const manager = new ToolsetManager(server, policy);
  for (const [toolset, names] of Object.entries(TOOLSETS)) {
    for (const name of names) {
      if (name === "crosspad_toolsets") continue;
      const tool = server.registerTool(name, { description: name, inputSchema: { x: z.string().optional() } },
        async () => ({ content: [{ type: "text", text: name }] }));
      manager.register(name, tool, toolset);
    }
  }
  manager.register("crosspad_toolsets", registerToolsetsTool(server, ctxWith(policy), manager), "core");
  manager.enable("core");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "crosspad_toolsets", arguments: args });
    return { r, sc: r.structuredContent as Record<string, any> };
  };
  return { server, client, manager, call };
}

describe("crosspad_toolsets", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup({ mode: "strict", rules: [] }); });
  afterEach(async () => { await s.client.close(); await s.server.close(); });

  it("list reports every toolset with enabled flag and tool names", async () => {
    const { sc } = await s.call({ action: "list" });
    expect(sc.success).toBe(true);
    expect(sc.policy_mode).toBe("strict");
    expect(sc.enabled).toEqual(["core"]);
    const core = sc.toolsets.find((t: any) => t.name === "core");
    expect(core.enabled).toBe(true);
    expect(core.tools).toEqual(TOOLSETS.core);
    expect(sc.toolsets.map((t: any) => t.name)).toEqual(Object.keys(TOOLSETS));
  });

  it("enable adds tools and they become callable", async () => {
    const { sc } = await s.call({ action: "enable", toolset: "git" });
    expect(sc.success).toBe(true);
    expect(sc.added).toEqual(["crosspad_commit", "crosspad_repo_diff", "crosspad_submodule_update"]);
    expect(sc.enabled).toEqual(["core", "git"]);
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("crosspad_commit");
    const r = await s.client.callTool({ name: "crosspad_commit", arguments: {} });
    expect((r.content as any)[0].text).toBe("crosspad_commit");
  });

  it("disable removes tools; disabling core / unknown names is a BAD_ARGS error", async () => {
    await s.call({ action: "enable", toolset: "sim" });
    const { sc } = await s.call({ action: "disable", toolset: "sim" });
    expect(sc.removed).toEqual([...TOOLSETS.sim].sort());
    const core = await s.call({ action: "disable", toolset: "core" });
    expect(core.r.isError).toBe(true);
    expect(core.sc.error.code).toBe("BAD_ARGS");
    const bogus = await s.call({ action: "enable", toolset: "bogus" });
    expect(bogus.r.isError).toBe(true);
    expect(bogus.sc.error.code).toBe("BAD_ARGS");
    expect(bogus.sc.error.hint).toContain("core, device, hil, sim, code, git, apps, trace");
  });

  it("enable/disable/describe without toolset is BAD_ARGS", async () => {
    const { r, sc } = await s.call({ action: "enable" });
    expect(r.isError).toBe(true);
    expect(sc.error.code).toBe("BAD_ARGS");
  });

  it("describe lists tier per tool", async () => {
    const { sc } = await s.call({ action: "describe", toolset: "core" });
    expect(sc.toolset.name).toBe("core");
    expect(sc.toolset.tools.find((t: any) => t.name === "crosspad_flash").tier).toBe("danger");
    expect(sc.toolset.tools.find((t: any) => t.name === "crosspad_devices").tier).toBe("read");
  });

  it("readonly: enable reports what stayed hidden", async () => {
    await s.client.close(); await s.server.close();
    s = await setup({ mode: "readonly", rules: [] });
    const { sc } = await s.call({ action: "enable", toolset: "git" });
    expect(sc.added).toEqual(["crosspad_repo_diff"]);
    expect(sc.hidden_by_policy).toEqual(["crosspad_commit", "crosspad_submodule_update"]);
    expect(sc.policy_mode).toBe("readonly");
  });
});