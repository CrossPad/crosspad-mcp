import { describe, expect, it } from "vitest";
import { registerHilRunTool, scenarioIsDanger } from "./hil-run.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import { loadPolicy } from "../policy/policy.js";
import type { ToolContext } from "../tool-context.js";

function mk(responses: Record<string, unknown | (() => unknown)>) {
  const fs = fakeServer();
  const daemon = fakeDaemon(responses);
  const ctx: ToolContext = {
    daemon: () => daemon as never,
    policy: loadPolicy({ file: "/nonexistent/policy.json", env: {} }),
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
