import { describe, expect, it } from "vitest";
import { registerBleTool, registerDiagnoseCrashTool, registerStimulusTool } from "./stimulus.js";
import { registerAnalyzeTool, registerCaptureTool, withWavLink } from "./capture.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import { loadPolicy } from "../policy/policy.js";
import type { ToolContext } from "../tool-context.js";

type Register = (s: never, c: ToolContext) => unknown;

function mk(register: Register, name: string, responses: Record<string, unknown | (() => unknown)>) {
  const fs = fakeServer();
  const daemon = fakeDaemon(responses);
  const ctx: ToolContext = {
    daemon: () => daemon as never,
    policy: loadPolicy({ file: "/nonexistent/policy.json", env: {} }),
    jobs: new JobRegistry(),
    handles: new HandleRegistry(),
  };
  register(fs.server as never, ctx);
  const call = (args: unknown) =>
    (fs.tools.get(name)!.cb as (a: unknown, e: unknown) => Promise<{ structuredContent: Record<string, unknown>; content: unknown[] }>)(
      args,
      fakeExtra(),
    );
  return { fs, daemon, ctx, call };
}

describe("crosspad_stimulus", () => {
  it("starts a pattern and registers the handle", async () => {
    const t = mk(registerStimulusTool as Register, "crosspad_stimulus", {
      "stim.start": () => ({ handle: "stim_1", plan: { hits: 3, throttled: false } }),
    });
    const res = await t.call({
      action: "start",
      pattern: [{ t_ms: 0, pad: 0 }, { t_ms: 250, pad: 4 }, { t_ms: 500, pad: 8, vel: 100 }],
      humanize_ms: 8,
    });
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.handle).toBe("stim_1");
    expect(t.ctx.handles.get("stim_1")?.kind).toBe("stimulus");
    expect((t.daemon.calls[0].args as { pattern: unknown[] }).pattern).toHaveLength(3);
  });

  it("refuses a start with nothing to play, instead of sending an empty run", async () => {
    const t = mk(registerStimulusTool as Register, "crosspad_stimulus", {});
    const res = await t.call({ action: "start", rate_hz: 8 });
    expect(res.structuredContent.success).toBe(false);
    expect(String((res.structuredContent.error as { hint: string }).hint)).toContain("pattern");
    expect(t.daemon.calls).toHaveLength(0);
  });

  it("passes the loss accounting through untouched", async () => {
    // The whole point of status is that transport loss and engine loss are
    // separate numbers and neither is rounded away.
    const t = mk(registerStimulusTool as Register, "crosspad_stimulus", {
      "stim.status": () => ({ sent: 30, pad_stats: { press: 28, played: 27 }, cdc_drops: 2 }),
    });
    const res = await t.call({ action: "status", handle: "stim_1" });
    expect(res.structuredContent.status).toMatchObject({ sent: 30, cdc_drops: 2 });
  });

  it("drops the handle on stop", async () => {
    const t = mk(registerStimulusTool as Register, "crosspad_stimulus", {
      "stim.start": () => ({ handle: "stim_1" }),
      "stim.stop": () => ({ sent: 10 }),
    });
    await t.call({ action: "start", pads: [0], rate_hz: 4 });
    await t.call({ action: "stop", handle: "stim_1" });
    expect(t.ctx.handles.get("stim_1")).toBeUndefined();
  });
});

describe("crosspad_capture", () => {
  it("defaults to resuming the mixer and the loopback preset", async () => {
    // Both defaults exist because getting them wrong yields a silent take.
    const t = mk(registerCaptureTool as Register, "crosspad_capture", {
      "capture.start": () => ({ handle: "cap_1", preset: "headphone" }),
    });
    await t.call({ action: "start", seconds: 3 });
    expect(t.daemon.calls[0].args).toMatchObject({ preset: "headphone", resume_audio_tasks: true });
  });

  it("returns the WAV as a link rather than inlining audio", async () => {
    const t = mk(registerCaptureTool as Register, "crosspad_capture", {
      "capture.start": () => ({ handle: "cap_1" }),
      "capture.stop": () => ({ wav: "/tmp/take.wav", seconds: 3, peak_dbfs: -5.2, silent: false }),
    });
    await t.call({ action: "start", seconds: 3 });
    const res = await t.call({ action: "stop", handle: "cap_1" });
    const link = (res.content as { type: string; uri?: string }[]).find((c) => c.type === "resource_link");
    expect(link?.uri).toBe("file:///tmp/take.wav");
    expect(res.structuredContent.peak_dbfs).toBe(-5.2);
  });

  it("keeps a silent take as data, not an error", async () => {
    // A silent recording is a finding about the routing, not a tool failure.
    const t = mk(registerCaptureTool as Register, "crosspad_capture", {
      "capture.start": () => ({ handle: "cap_1" }),
      "capture.stop": () => ({ wav: "/tmp/quiet.wav", silent: true, peak_dbfs: -95 }),
    });
    await t.call({ action: "start" });
    const res = await t.call({ action: "stop", handle: "cap_1" });
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.silent).toBe(true);
  });
});

describe("withWavLink", () => {
  it("leaves a result alone when there is no file", () => {
    const base = { content: [{ type: "text" as const, text: "{}" }], structuredContent: {} };
    expect(withWavLink(base, undefined).content).toHaveLength(1);
    expect(withWavLink(base, "").content).toHaveLength(1);
  });
});

describe("crosspad_analyze", () => {
  it("passes the kind, the file and what was expected", async () => {
    const t = mk(registerAnalyzeTool as Register, "crosspad_analyze", {
      "analyze.wav": () => ({ expected: 3, matched: 3, missed: [], latency_ms: { p50: 12 } }),
    });
    const res = await t.call({ kind: "onset", wav: "hil_logs/a.wav", expected: [0, 250, 500] });
    expect(t.daemon.calls[0]).toMatchObject({
      op: "analyze.wav",
      args: { kind: "onset", wav: "hil_logs/a.wav", expected: [0, 250, 500] },
    });
    expect((res.structuredContent.verdict as { matched: number }).matched).toBe(3);
  });
});

describe("crosspad_diagnose_crash", () => {
  it("links the console context instead of inlining hundreds of lines", async () => {
    const t = mk(registerDiagnoseCrashTool as Register, "crosspad_diagnose_crash", {
      "diagnose.crash": () => ({
        found: true,
        reset_reason: { code: "0xc", name: "RTC_SW_CPU_RST" },
        panic: { core: 0, cause: "StoreProhibited" },
        backtrace: [{ addr: "0x4201438b", func: "kit_selector_pre_launch", file: "main/gui/gui.cpp", line: 89 }],
        context: "/tmp/context.log",
      }),
    });
    const res = await t.call({ log_file: "hil_logs/panic.log" });
    expect(res.structuredContent.success).toBe(true);
    expect((res.structuredContent.backtrace as { file: string }[])[0].file).toBe("main/gui/gui.cpp");
    const link = (res.content as { type: string; uri?: string }[]).find((c) => c.type === "resource_link");
    expect(link?.uri).toBe("file:///tmp/context.log");
  });

  it("reports a missing toolchain as an error the caller can act on", async () => {
    const t = mk(registerDiagnoseCrashTool as Register, "crosspad_diagnose_crash", {
      "diagnose.crash": () => {
        throw Object.assign(new Error("xtensa-esp32s3-elf-addr2line not found"), { code: "ENV" });
      },
    });
    const res = await t.call({ log_file: "hil_logs/panic.log" });
    expect(res.structuredContent.success).toBe(false);
  });
});

describe("crosspad_ble", () => {
  it("forwards each action to its daemon op", async () => {
    const t = mk(registerBleTool as Register, "crosspad_ble", {
      "ble.scan": () => ({ count: 1, peripherals: [{ address: "aa:bb", name: "CrossPad" }] }),
    });
    const res = await t.call({ action: "scan", timeout_s: 5 });
    expect(t.daemon.calls[0]).toMatchObject({ op: "ble.scan", args: { timeout_s: 5 } });
    expect(res.structuredContent.count).toBe(1);
  });

  it("surfaces a missing radio dependency rather than pretending it scanned", async () => {
    const t = mk(registerBleTool as Register, "crosspad_ble", {
      "ble.scan": () => {
        throw Object.assign(new Error("bleak is not installed"), { code: "NOT_SUPPORTED" });
      },
    });
    const res = await t.call({ action: "scan" });
    expect(res.structuredContent.success).toBe(false);
  });
});

// A daemon that answers without a handle is exactly the case a fake with the
// declared keys cannot produce — and `String(r.handle)` turned it into the
// usable-looking string "undefined", handed to the model as something to stop
// the run with.
describe("a start reply with no handle", () => {
  it("crosspad_stimulus fails loudly instead of registering \"undefined\"", async () => {
    const t = mk(registerStimulusTool as Register, "crosspad_stimulus", {
      "stim.start": () => ({ plan: { hits: 3 } }),
    });
    const res = await t.call({ action: "start", pads: [0, 4], rate_hz: 8, seconds: 2 });
    expect(res.structuredContent.success).toBe(false);
    expect((res.structuredContent.error as { code: string }).code).toBe("BAD_DAEMON_REPLY");
    expect(t.ctx.handles.get("undefined")).toBeUndefined();
    expect(t.ctx.handles.list()).toEqual([]);
  });

  it("crosspad_capture fails loudly instead of registering \"undefined\"", async () => {
    const t = mk(registerCaptureTool as Register, "crosspad_capture", {
      "capture.start": () => ({ preset: "headphone", running: true }),
    });
    const res = await t.call({ action: "start", seconds: 5 });
    expect(res.structuredContent.success).toBe(false);
    expect((res.structuredContent.error as { code: string }).code).toBe("BAD_DAEMON_REPLY");
    expect(t.ctx.handles.get("undefined")).toBeUndefined();
    expect(t.ctx.handles.list()).toEqual([]);
  });
});
