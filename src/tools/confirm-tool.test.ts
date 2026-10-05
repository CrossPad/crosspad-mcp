import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { requireConfirmation, resetPending, resetSpentTokens, CONFIRM_TTL_S, CONFIRMATION_OUTPUT } from "../policy/confirm.js";
import { registerConfirmTool, TOOL_NAME } from "./confirm-tool.js";
import { JobRegistry } from "../tasks.js";
import { HandleRegistry } from "../handles.js";
import type { ToolContext } from "../tool-context.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LAB = { mode: "lab", rules: [] } as const;

function ctx(): ToolContext {
  return { daemon: () => { throw new Error("no daemon"); }, policy: LAB as any,
           jobs: new JobRegistry(), handles: new HandleRegistry() };
}

/** A danger-tier tool in the shape of crosspad_flash: gate, then act. */
function registerDanger(server: McpServer, ran: Array<Record<string, unknown>>): RegisteredTool {
  return server.registerTool("crosspad_fake_flash", {
    description: "fake",
    inputSchema: { file: z.string(), confirm_token: z.string().optional() },
    outputSchema: { success: z.boolean(), flashed: z.string().optional(), ...CONFIRMATION_OUTPUT },
  }, async (args: any, extra: any) => {
    const c = await requireConfirmation(server, extra, "crosspad_fake_flash", args,
      `Flash ${args.file} to dev_1ede`, "dev_1ede");
    if (c.status === "token") return c.result as any;
    if (c.status === "declined") return { content: [], structuredContent: { success: false } } as any;
    ran.push({ ...args });
    const sc = { success: true, flashed: args.file };
    return { content: [{ type: "text", text: JSON.stringify(sc) }], structuredContent: sc } as any;
  });
}

function setup(caps: Record<string, unknown> = {}, elicit?: (...a: any[]) => Promise<any>) {
  const fs = fakeServer();
  fs.clientCapabilities = caps;
  if (elicit) (fs.server.server as any).elicitInput = elicit;
  const ran: Array<Record<string, unknown>> = [];
  const danger = registerDanger(fs.server, ran);
  registerConfirmTool(fs.server, ctx(), (n) => (n === "crosspad_fake_flash" ? danger : undefined));
  return { fs, ran };
}

beforeEach(() => { resetPending(); resetSpentTokens(); });
afterEach(() => { vi.useRealTimers(); delete process.env.CROSSPAD_MCP_ELICIT_MIN_MS; });

describe("crosspad_confirm", () => {
  it("is destructive, so the client asks the person itself", () => {
    const { fs } = setup();
    const ann = fs.tools.get(TOOL_NAME)!.config.annotations;
    expect(ann).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(fs.tools.get(TOOL_NAME)!.config.description).toMatch(/do NOT ask the user in chat/);
  });

  it("without elicitation: confirmation_required, then crosspad_confirm runs the call once", async () => {
    const { fs, ran } = setup();
    const r = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "a.bin" }, fakeExtra());
    const sc = r.structuredContent as any;
    expect(sc.resultType).toBe("confirmation_required");
    expect(sc.confirmation.summary).toBe("Flash a.bin to dev_1ede");
    expect(sc.hint).toMatch(/crosspad_confirm/);
    expect(sc.elicitation).toMatchObject({ declared: false });
    expect(ran).toEqual([]);

    const ok = await fs.tools.get(TOOL_NAME)!.cb(
      { token: sc.confirmation.token, summary: sc.confirmation.summary }, fakeExtra());
    expect(ok.structuredContent).toMatchObject({ success: true, flashed: "a.bin" });
    expect(ran).toHaveLength(1);

    const again = await fs.tools.get(TOOL_NAME)!.cb(
      { token: sc.confirmation.token, summary: sc.confirmation.summary }, fakeExtra());
    expect((again.structuredContent as any).error.code).toBe("UNKNOWN_TOKEN");
    expect(ran).toHaveLength(1);
  });

  it("an expired token runs nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { fs, ran } = setup();
    const r = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "a.bin" }, fakeExtra());
    vi.setSystemTime(Date.now() + (CONFIRM_TTL_S + 1) * 1000);
    const late = await fs.tools.get(TOOL_NAME)!.cb(
      { token: (r.structuredContent as any).confirmation.token, summary: "Flash a.bin to dev_1ede" },
      fakeExtra());
    expect((late.structuredContent as any).error.code).toBe("UNKNOWN_TOKEN");
    expect(ran).toEqual([]);
  });

  it("a forged or never-issued token runs nothing", async () => {
    const { fs, ran } = setup();
    const forged = `cfm_${Date.now()}_${"0".repeat(16)}_${"a".repeat(64)}`;
    const r = await fs.tools.get(TOOL_NAME)!.cb({ token: forged, summary: "x" }, fakeExtra());
    expect((r.structuredContent as any).error.code).toBe("UNKNOWN_TOKEN");
    expect(ran).toEqual([]);
  });

  it("the token does not approve different arguments", async () => {
    const { fs, ran } = setup();
    const r = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "a.bin" }, fakeExtra());
    const token = (r.structuredContent as any).confirmation.token;
    const other = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "evil.bin", confirm_token: token }, fakeExtra());
    expect((other.structuredContent as any).resultType).toBe("confirmation_required");
    expect(ran).toEqual([]);
  });

  it("Claude Code: elicitation declared, declined unseen in no time -> the token path, with why", async () => {
    const { fs, ran } = setup({ elicitation: {} }, async () => ({ action: "decline" }));
    const r = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "a.bin" }, fakeExtra());
    const sc = r.structuredContent as any;
    expect(sc.resultType).toBe("confirmation_required");
    expect(sc.elicitation).toMatchObject({ declared: true, action: "decline" });
    expect(sc.elicitation.why_token).toMatch(/nobody saw the form/);
    await fs.tools.get(TOOL_NAME)!.cb(
      { token: sc.confirmation.token, summary: sc.confirmation.summary }, fakeExtra());
    expect(ran).toHaveLength(1);
  });

  it("the prompt shows the summary: one that does not match runs nothing and spends nothing", async () => {
    const { fs, ran } = setup();
    const r = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "a.bin" }, fakeExtra());
    const sc = r.structuredContent as any;
    const wrong = await fs.tools.get(TOOL_NAME)!.cb(
      { token: sc.confirmation.token, summary: "Read the battery voltage" }, fakeExtra());
    expect((wrong.structuredContent as any).error.code).toBe("SUMMARY_MISMATCH");
    expect(ran).toEqual([]);
    const right = await fs.tools.get(TOOL_NAME)!.cb(
      { token: sc.confirmation.token, summary: sc.confirmation.summary }, fakeExtra());
    expect(right.structuredContent).toMatchObject({ success: true });
  });

  it("CROSSPAD_MCP_CONFIRM=form keeps an instant decline a decline", async () => {
    process.env.CROSSPAD_MCP_CONFIRM = "form";
    try {
      const { fs, ran } = setup({ elicitation: {} }, async () => ({ action: "decline" }));
      const r = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "a.bin" }, fakeExtra());
      expect((r.structuredContent as any).resultType).toBeUndefined();
      expect(ran).toEqual([]);
    } finally {
      delete process.env.CROSSPAD_MCP_CONFIRM;
    }
  });

  it("a person who declines the form (Codex) still declines", async () => {
    process.env.CROSSPAD_MCP_ELICIT_MIN_MS = "0";
    const { fs, ran } = setup({ elicitation: {} }, async () => ({ action: "decline" }));
    const r = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "a.bin" }, fakeExtra());
    expect((r.structuredContent as any).success).toBe(false);
    expect((r.structuredContent as any).resultType).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it("a person who approves the form (Codex) runs it directly", async () => {
    const { fs, ran } = setup({ elicitation: {} },
      async () => ({ action: "accept", content: { approve: true } }));
    const r = await fs.tools.get("crosspad_fake_flash")!.cb({ file: "a.bin" }, fakeExtra());
    expect(r.structuredContent).toMatchObject({ success: true, flashed: "a.bin" });
    expect(ran).toHaveLength(1);
  });
});
