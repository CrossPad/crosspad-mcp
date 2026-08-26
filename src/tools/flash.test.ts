import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerFlashTool, TOOL_NAME, setFlashProbeForTest, type FlashProbe } from "./flash.js";
import { JobRegistry } from "../tasks.js";
import { HandleRegistry } from "../handles.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STRICT: Policy = { mode: "strict", rules: [] };

const port = (path: string, vid = 0x303a, pid = 0x3456) => ({ path, vid, pid, serial: null, product: null, location: "1-1.2" });
const DEV = {
  id: "dev_3f2a", serial: "AABB", usb_mode: "default", board_rev: "v2",
  ports: { cdc: port("/dev/ttyACM0"), console: port("/dev/ttyACM1", 0x0483, 0x5740), esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
};

function goodProbe(over: Partial<FlashProbe> = {}): FlashProbe {
  return {
    async exists() { return true; },
    async mtimeMs() { return 9_000; },
    async binVersion() { return "v20-3f2a"; },
    async newestSource() { return { path: "/idf/main/main.cpp", mtimeMs: 1_000 }; },
    async buildBoardRev() { return "v2"; },
    ...over,
  };
}

function ctxFor(daemon: ReturnType<typeof fakeDaemon>): ToolContext & { jobs: JobRegistry; handles: HandleRegistry } {
  return { daemon: () => daemon, policy: STRICT, jobs: new JobRegistry(), handles: new HandleRegistry() };
}

describe("crosspad_flash", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); setFlashProbeForTest(goodProbe()); });

  it("without a token it returns the confirmation AND the preflight, and writes nothing", async () => {
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.resultType).toBe("confirmation_required");
    expect(sc.confirmation.token).toMatch(/^cfm_/);
    expect(sc.preflight).toMatchObject({ ok: true, device: "dev_3f2a", firmware_version: "v20-3f2a", board_rev_match: true });
    expect(d.calls.map((c) => c.op)).toEqual(["devices.list"]);
  });

  it("a blocked preflight refuses before the confirmation and still returns the preflight", async () => {
    setFlashProbeForTest(goodProbe({ async buildBoardRev() { return "v1"; } }));
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(r.isError).toBe(true);
    expect(sc.error.code).toBe("PREFLIGHT_BLOCKED");
    expect(sc.preflight.blockers.map((b: { code: string }) => b.code)).toEqual(["BOARD_REV_MISMATCH"]);
    expect(sc.resultType).toBeUndefined();
  });

  it("dry_run returns the preflight without minting a token", async () => {
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota", dry_run: true }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc).toMatchObject({ success: true, dry_run: true });
    expect(sc.preflight.ok).toBe(true);
    expect(sc.confirmation).toBeUndefined();
    expect(sc.task).toBeUndefined();
  });

  it("the console port is refused by name and role, and force cannot clear it", async () => {
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "uart", port: "/dev/ttyACM1", force: true, dry_run: true },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.preflight.ok).toBe(false);
    expect(sc.preflight.blockers[0].code).toBe("PORT_ROLE");
    expect(sc.preflight.blockers[0].message).toContain("console");
  });

  it("an approved OTA starts ota.flash, polls it as a job and returns the handle", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEV] }),
      "ota.flash": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "completed", result: { bytes: 1_200_000, seconds: 9.4, kbps: 128, version: "v20-3f2a", mode: "full" } }),
    });
    registerFlashTool(fs.server, ctxFor(d));
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;

    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "ota", confirm_token: token, wait_seconds: 5 },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.success).toBe(true);
    expect(sc.task).toMatch(/^task_\d+$/);
    expect(sc.status.status).toBe("completed");
    expect(sc.status.result.flash).toMatchObject({ bytes: 1_200_000, version: "v20-3f2a" });
    expect(sc.status.result.boot).toBeNull();
    const ota = d.calls.find((c) => c.op === "ota.flash")!;
    expect(ota.args).toMatchObject({ device: "dev_3f2a", wait_boot: false });
    expect(String(ota.args.firmware)).toContain("CrossPad.bin");
  });

  it("wait_boot opens a console, waits, closes it, and returns the BootResult", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEV] }),
      "ota.flash": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "completed", result: { bytes: 10, seconds: 1, kbps: 10, version: "v20", mode: "full" } }),
      "console.open": () => ({ handle: "con_1", port: "/dev/ttyACM1", log_path: "/tmp/console.log" }),
      "console.wait_boot": () => ({ complete: true, missing: [], fatal: [], errors: [], bootloops: 0, seconds: 11.2 }),
      "console.close": () => ({ ok: true }),
    });
    const ctx = ctxFor(d);
    registerFlashTool(fs.server, ctx);
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota", wait_boot: true }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "ota", wait_boot: true, confirm_token: token, wait_seconds: 5 },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status.result.boot).toMatchObject({ complete: true, bootloops: 0, seconds: 11.2 });
    expect(d.calls.map((c) => c.op)).toContain("console.close");
    expect(ctx.handles.list().filter((h) => h.kind === "console")).toHaveLength(0);
  });

  it("wait_seconds=0 returns the handle immediately without a terminal status", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEV] }),
      "ota.flash": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "working", progress: 1, total: 100, message: "1%" }),
    });
    const ctx = ctxFor(d);
    registerFlashTool(fs.server, ctx);
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota", confirm_token: token }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.task).toMatch(/^task_\d+$/);
    expect(sc.status).toBeUndefined();
    expect(sc.hint).toContain("crosspad_task");
    expect(ctx.jobs.status(sc.task).status).toBe("working");
    ctx.jobs.cancel(sc.task);
  });

  it("a failed daemon flash surfaces the code on the job, with the preflight still present", async () => {
    const d = fakeDaemon({
      "devices.list": () => ({ devices: [DEV] }),
      "ota.flash": () => ({ task: "task_9" }),
      "task.status": () => ({ task: "task_9", status: "failed", error: { code: "FLASH_FAILED", message: "OTA_ERROR at 40%" } }),
    });
    registerFlashTool(fs.server, ctxFor(d));
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "ota" }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "ota", confirm_token: token, wait_seconds: 5 },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status.status).toBe("failed");
    expect(sc.status.error.code).toBe("FLASH_FAILED");
    expect(sc.preflight.ok).toBe(true);
  });

  it("UART runs the idf.py argv path as a job and never calls ota.flash", async () => {
    const idf = await import("./idf-flash.js");
    vi.spyOn(idf, "crosspadIdfFlash").mockResolvedValue({
      success: true, method: "uart", port: "/dev/ttyACM0", duration_seconds: 31.2, output_tail: ["Hash of data verified."],
    });
    const d = fakeDaemon({ "devices.list": () => ({ devices: [DEV] }) });
    registerFlashTool(fs.server, ctxFor(d));
    const first = await fs.tools.get(TOOL_NAME)!.cb({ target: "esp", transport: "uart" }, fakeExtra());
    const token = (first.structuredContent as Record<string, any>).confirmation.token as string;
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "esp", transport: "uart", confirm_token: token, wait_seconds: 5 },
      fakeExtra(),
    );
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.status.status).toBe("completed");
    expect(sc.status.result.flash).toMatchObject({ method: "uart", port: "/dev/ttyACM0" });
    expect(d.calls.some((c) => c.op === "ota.flash")).toBe(false);
    expect(idf.crosspadIdfFlash).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("target=stm needs a method and never resolves an ESP device", async () => {
    const d = fakeDaemon({});
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "stm", dry_run: true }, fakeExtra());
    expect(r.isError).toBe(true);
    expect((r.structuredContent as Record<string, any>).error.code).toBe("BAD_ARGS");
    expect(d.calls).toHaveLength(0);
  });

  it("target=stm dry_run reports an STM-shaped preflight", async () => {
    const d = fakeDaemon({});
    registerFlashTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "stm", method: "swd", dry_run: true }, fakeExtra());
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.preflight).toMatchObject({ target: "stm", transport: "swd", device: null, ok: true });
    expect(d.calls).toHaveLength(0);
  });
});
