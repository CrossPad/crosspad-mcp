import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { registerHilRunTool, scenarioIsDanger } from "./hil-run.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import { loadPolicy, type Policy } from "../policy/policy.js";
import type { ToolContext } from "../tool-context.js";

function mk(responses: Record<string, unknown | (() => unknown)>, policy?: Policy) {
  const fs = fakeServer();
  const daemon = fakeDaemon(responses);
  const ctx: ToolContext = {
    daemon: () => daemon as never,
    policy: policy ?? loadPolicy({ file: "/nonexistent/policy.json", env: {} }),
    jobs: new JobRegistry(),
    handles: new HandleRegistry(),
  };
  const tool = registerHilRunTool(fs.server, ctx);
  const call = (args: unknown) =>
    (fs.tools.get("crosspad_hil_run")!.cb as (a: unknown, e: unknown) => Promise<{ structuredContent: Record<string, unknown> }>)(
      args,
      fakeExtra(),
    );
  return { fs, daemon, ctx, tool, call };
}

describe("crosspad_hil_run", () => {
  it("lists the scenario catalog", async () => {
    const t = mk({
      "scenario.list": () => ({
        scenarios: [
          { name: "smoke", description: "boot smoke", params: [{ name: "timeout", type: "int", default: 25 }] },
        ],
      }),
    });
    const res = await t.call({ action: "list" });
    expect(res.structuredContent.success).toBe(true);
    expect((res.structuredContent.scenarios as { name: string }[])[0].name).toBe("smoke");
  });

  it("starts a run and hands back a pollable task handle", async () => {
    const t = mk({
      "scenario.run": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "working" }),
    });
    const res = await t.call({ action: "run", scenario: "kit_churn", params: { rounds: 3 } });
    expect(res.structuredContent.success).toBe(true);
    expect(String(res.structuredContent.task)).toMatch(/^task_\d+$/);
    // the daemon got the scenario and its params verbatim
    expect(t.daemon.calls[0]).toMatchObject({
      op: "scenario.run",
      args: { name: "kit_churn", params: { rounds: 3 } },
    });
    // and the handle is registered so crosspad_task can find it
    expect(t.ctx.handles.get(String(res.structuredContent.task))?.kind).toBe("task");
  });

  it("rejects a run with no scenario name instead of guessing one", async () => {
    const t = mk({});
    const res = await t.call({ action: "run" });
    expect(res.structuredContent.success).toBe(false);
    expect(String((res.structuredContent.error as { code: string }).code)).toBe("INVALID_ARGS");
  });

  it("surfaces a daemon failure as an error envelope, not a throw", async () => {
    const t = mk({
      "scenario.run": () => {
        throw Object.assign(new Error("no such scenario"), { code: "BAD_ARGS" });
      },
    });
    const res = await t.call({ action: "run", scenario: "nope" });
    expect(res.structuredContent.success).toBe(false);
  });

  describe("tiering", () => {
    it("treats an ordinary scenario as stimulus — the suite has to be runnable", () => {
      expect(scenarioIsDanger("kit_churn", { rounds: 20 })).toBe(false);
      expect(scenarioIsDanger("usb_mode_cycle", {})).toBe(false);
      expect(scenarioIsDanger("smoke", undefined)).toBe(false);
    });

    it("treats a run that writes firmware as danger", () => {
      expect(scenarioIsDanger("smoke", { flash: "build/CrossPad.bin" })).toBe(true);
    });
  });
});

// The catalog row the daemon sends is richer than the row this tool used to
// declare, and nothing parsed it — so a fake that returns exactly the declared
// keys is the one shape of reply that could never expose the mismatch.
describe("crosspad_hil_run catalog contract", () => {
  const FULL_ROW = {
    name: "kit_churn",
    description: "swap kits while the pads keep firing",
    params: [{ name: "rounds", type: "int", default: 20, help: "how many swaps" }],
    // §3.3: the catalog carries these too.
    runtime_s: 180,
    ports: ["cdc", "console"],
    exit_codes: { 0: "pass", 2: "no stimulus in the swap window" },
  };

  it("passes the spec's runtime / ports / exit_codes through instead of dropping them", async () => {
    const t = mk({ "scenario.list": () => ({ scenarios: [FULL_ROW] }) });
    const res = await t.call({ action: "list" });
    expect(res.structuredContent.success).toBe(true);
    expect((res.structuredContent.scenarios as Record<string, unknown>[])[0]).toMatchObject({
      name: "kit_churn",
      runtime_s: 180,
      ports: ["cdc", "console"],
    });
  });

  it("declares a row schema the client will accept those fields under", async () => {
    const t = mk({ "scenario.list": () => ({ scenarios: [FULL_ROW] }) });
    const res = await t.call({ action: "list" });
    const published = z.toJSONSchema(normalizeObjectSchema(t.fs.tools.get("crosspad_hil_run")!.config.outputSchema)!);
    const validate = await new AjvJsonSchemaValidator().getValidator(published as Record<string, unknown>);
    expect((await validate(res.structuredContent)).valid).toBe(true);
  });
});

// The policy engine has three answers and this tool used to act on one of them,
// and only for scenarios it had already decided were dangerous.
describe("crosspad_hil_run policy", () => {
  const confirmAll: Policy = { mode: "strict", rules: [{ tool: "crosspad_hil_run", confirm: true }] };

  it("honours a confirm rule on an ordinary run, not just on a flashing one", async () => {
    const t = mk({ "scenario.run": () => ({ task: "task_9" }) }, confirmAll);
    const res = await t.call({ action: "run", scenario: "smoke" });
    expect(res.structuredContent.resultType).toBe("confirmation_required");
    // Nothing was started.
    expect(t.daemon.calls).toEqual([]);
  });

  it("proceeds once the minted token comes back", async () => {
    const t = mk({ "scenario.run": () => ({ task: "task_9" }), "task.status": () => ({ status: "working" }) }, confirmAll);
    const first = await t.call({ action: "run", scenario: "smoke" });
    const token = (first.structuredContent.confirmation as { token: string }).token;
    const res = await t.call({ action: "run", scenario: "smoke", confirm_token: token });
    expect(res.structuredContent.success).toBe(true);
    expect(t.daemon.calls[0]).toMatchObject({ op: "scenario.run" });
  });

  it("refuses outright when policy hides the tool", async () => {
    const t = mk({ "scenario.list": () => ({ scenarios: [] }) }, { mode: "readonly", rules: [] });
    const res = await t.call({ action: "list" });
    expect(res.structuredContent.success).toBe(false);
    expect((res.structuredContent.error as { code: string }).code).toBe("HIDDEN");
    expect(t.daemon.calls).toEqual([]);
  });
});

describe("crosspad_hil_run annotations", () => {
  it("advertises the worst call it can make — a run with params.flash writes firmware", () => {
    const t = mk({});
    expect(t.fs.tools.get("crosspad_hil_run")!.config.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("says in the description which variant that is", () => {
    const t = mk({});
    expect(String(t.fs.tools.get("crosspad_hil_run")!.config.description)).toContain("params.flash");
  });
});
