import { describe, it, expect, vi } from "vitest";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerAll, loadV10Registrars, loadV10Modules, V10_MODULES, type ToolRegistrar } from "./registry.js";
import { ToolsetManager, TOOLSETS } from "./toolsets.js";
import type { ToolContext } from "./tool-context.js";

const policy = { mode: "strict" as const, rules: [] };
const ctx: ToolContext = { policy, daemon: () => { throw new Error("none"); }, jobs: {} as never, handles: {} as never };

function stub(server: McpServer, name: string): RegisteredTool {
  return server.registerTool(
    name,
    { description: name, inputSchema: { x: z.string().optional() } },
    async () => ({ content: [{ type: "text", text: name }] }),
  );
}

describe("registerAll", () => {
  it("registers the built-in v10 tools and files legacy tools into their toolsets; unknown legacy names go nowhere", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const manager = new ToolsetManager(server, policy);
    const legacy = new Map<string, RegisteredTool>();
    for (const name of ["crosspad_build", "crosspad_commit", "crosspad_log", "crosspad_obsolete"]) {
      legacy.set(name, stub(server, name));
    }
    registerAll(server, ctx, manager, legacy);
    manager.enable("core");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["crosspad_build", "crosspad_toolsets", "crosspad_task"]);
    manager.enable("git"); manager.enable("sim");
    const after = (await client.listTools()).tools.map((t) => t.name);
    expect(after).toEqual(["crosspad_build", "crosspad_commit", "crosspad_log", "crosspad_toolsets", "crosspad_task"]);
    expect(after).not.toContain("crosspad_obsolete");
    expect(Object.keys(TOOLSETS)).toContain("hil");
    await client.close(); await server.close();
  });

  it("a v10 tool replaces the v9 tool of the same name instead of colliding with it", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const manager = new ToolsetManager(server, policy);
    const legacy = new Map<string, RegisteredTool>([["crosspad_devices", stub(server, "crosspad_devices")]]);
    const extras: ToolRegistrar[] = [
      {
        name: "crosspad_devices",
        toolset: "core",
        register: (s) =>
          s.registerTool("crosspad_devices", { description: "v10" }, async () => ({
            content: [{ type: "text", text: "v10" }],
          })),
      },
    ];
    expect(() => registerAll(server, ctx, manager, legacy, { tools: extras })).not.toThrow();
    manager.enable("core");
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const r = await client.callTool({ name: "crosspad_devices", arguments: {} });
    expect((r.content as Array<{ text: string }>)[0].text).toBe("v10");
    await client.close(); await server.close();
  });

  it("extras are registered in TOOLSETS order, not call order", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    const manager = new ToolsetManager(server, policy);
    const order: string[] = [];
    const extras: ToolRegistrar[] = ["crosspad_ui", "crosspad_snapshot", "crosspad_cdc", "crosspad_devices"].map((name) => ({
      name,
      toolset: name === "crosspad_devices" || name === "crosspad_snapshot" ? "core" : "device",
      register: (s: McpServer) => { order.push(name); return stub(s, name); },
    }));
    registerAll(server, ctx, manager, undefined, { tools: extras });
    expect(order).toEqual(["crosspad_devices", "crosspad_snapshot", "crosspad_cdc", "crosspad_ui"]);
    await server.close();
  });
});

describe("loadV10Registrars", () => {
  it("skips a module that does not exist yet, silently", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const found = await loadV10Registrars([
      { name: "crosspad_nope", toolset: "core", module: "./tools/definitely-not-written.js", export: "registerNopeTool" },
    ]);
    expect(found).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns and skips a module that exists but has no registrar export", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const found = await loadV10Registrars([
      { name: "crosspad_task", toolset: "core", module: "./tools/task.js", export: "registerNoSuchTool" },
    ]);
    expect(found).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("registerNoSuchTool"));
    warn.mockRestore();
  });

  it("every declared module maps onto a name the toolset table knows", () => {
    for (const spec of V10_MODULES) {
      expect(TOOLSETS[spec.toolset]).toContain(spec.name);
    }
  });

  it("loadV10Modules reports both tools and resources without throwing on absent files", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const mods = await loadV10Modules();
    expect(Array.isArray(mods.tools)).toBe(true);
    expect(Array.isArray(mods.resources)).toBe(true);
    expect(mods.tools.length).toBeLessThanOrEqual(V10_MODULES.length);
    warn.mockRestore();
  });

  it("resolves the modules that are present", async () => {
    const found = await loadV10Registrars([
      { name: "crosspad_task", toolset: "core", module: "./tools/task.js", export: "registerTaskTool" },
    ]);
    expect(found.map((f) => f.name)).toEqual(["crosspad_task"]);
    expect(typeof found[0].register).toBe("function");
  });
});
