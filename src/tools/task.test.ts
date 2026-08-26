import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTaskTool } from "./task.js";
import { JobRegistry } from "../tasks.js";
import { HandleRegistry } from "../handles.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";

async function harness(policy: Policy = { mode: "strict", rules: [] }) {
  const server = new McpServer({ name: "t", version: "0" });
  const jobs = new JobRegistry();
  const ctx: ToolContext = {
    daemon: () => { throw new Error("no daemon in this test"); },
    policy,
    jobs,
    handles: new HandleRegistry(),
  };
  const tool = registerTaskTool(server, ctx);
  const client = new Client({ name: "c", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "crosspad_task", arguments: args });
    return { r, sc: r.structuredContent as Record<string, unknown> };
  };
  return { server, client, jobs, ctx, tool, call };
}

describe("crosspad_task", () => {
  it("is registered with read-only annotations and a discriminated action schema", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "crosspad_task")!;
    expect(t).toBeDefined();
    expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(JSON.stringify(t.inputSchema)).toContain('"status"');
    expect(JSON.stringify(t.inputSchema)).toContain('"wait"');
    expect(JSON.stringify(t.inputSchema)).toContain('"cancel"');
    expect(JSON.stringify(t.inputSchema)).toContain('"list"');
  });

  it("status → the job status", async () => {
    const { jobs, call } = await harness();
    const id = jobs.create("build", async (_s, p) => { p(3, 10, "[3/10]"); return new Promise(() => {}); });
    await new Promise((r) => setTimeout(r, 1));
    const { sc } = await call({ action: "status", task: id });
    expect(sc.success).toBe(true);
    expect(sc.task).toMatchObject({ task: id, kind: "build", status: "working", progress: 3, total: 10, message: "[3/10]" });
  });

  it("wait → completed result; timeout returns working", async () => {
    const { jobs, call } = await harness();
    const fast = jobs.create("flash", async () => ({ bytes: 100 }));
    const { sc } = await call({ action: "wait", task: fast, timeout_ms: 1000 });
    expect(sc.task).toMatchObject({ status: "completed", result: { bytes: 100 } });
    const slow = jobs.create("capture", async () => new Promise(() => {}));
    const { sc: sc2 } = await call({ action: "wait", task: slow, timeout_ms: 10 });
    expect(sc2.task).toMatchObject({ status: "working" });
  });

  it("cancel → aborts; second cancel reports cancelled=false", async () => {
    const { jobs, call } = await harness();
    const id = jobs.create("stimulus", (signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("stop")))));
    const { sc } = await call({ action: "cancel", task: id });
    expect(sc.success).toBe(true);
    expect(sc.cancelled).toBe(true);
    expect(await jobs.wait(id, 1000)).toMatchObject({ status: "cancelled" });
    const { sc: sc2 } = await call({ action: "cancel", task: id });
    expect(sc2.cancelled).toBe(false);
  });

  it("list → every job", async () => {
    const { jobs, call } = await harness();
    jobs.create("a", async () => 1);
    jobs.create("b", async () => 2);
    const { sc } = await call({ action: "list" });
    expect((sc.tasks as Array<{ task: string }>).map((t) => t.task)).toEqual(["task_1", "task_2"]);
  });

  it("unknown task → isError with HANDLE_EXPIRED envelope", async () => {
    const { call } = await harness();
    const { r, sc } = await call({ action: "status", task: "task_404" });
    expect(r.isError).toBe(true);
    expect(sc.success).toBe(false);
    expect(sc.error).toMatchObject({ code: "HANDLE_EXPIRED" });
    expect((sc.error as { hint: string }).hint).toContain("1 h");
  });

  it("advertises task and timeout_ms alongside the actions", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const schema = JSON.stringify(tools.find((x) => x.name === "crosspad_task")!.inputSchema);
    expect(schema).toContain('"task"');
    expect(schema).toContain('"timeout_ms"');
    expect(schema).toContain('"action"');
  });

  it("status without a task → INVALID_ARGS, not a crash", async () => {
    const { r, sc } = await (await harness()).call({ action: "status" });
    expect(r.isError).toBe(true);
    expect(sc.error).toMatchObject({ code: "INVALID_ARGS" });
  });

  it("stays visible under readonly policy (read tier)", async () => {
    const { client } = await harness({ mode: "readonly", rules: [] });
    const { tools } = await client.listTools();
    expect(tools.some((x) => x.name === "crosspad_task")).toBe(true);
  });
});
