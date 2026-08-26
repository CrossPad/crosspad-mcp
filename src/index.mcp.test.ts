// MCP-API roundtrip tests — exercise registered tools through real
// Client→Server protocol calls (structured output validation included).
// Catches output-schema/result-shape drift that pure unit tests miss.

import { vi } from "vitest";

// v10: index.ts reads policy + toolsets at import time. Pin both so this suite
// sees every tool regardless of the developer's own ~/.config policy file.
vi.hoisted(() => {
  process.env.CROSSPAD_MCP_POLICY_FILE = "/nonexistent/crosspad-mcp/policy.json";
  process.env.CROSSPAD_TOOLSETS = "all";
  delete process.env.CROSSPAD_MCP_POLICY;
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

// Mock the build implementations BEFORE importing index.ts so the registered
// handlers route through these stubs. Mock factories run hoisted by vitest.
vi.mock("./tools/build.js", () => ({
  crosspadBuild: vi.fn(),
  crosspadRun: vi.fn(),
  crosspadKill: vi.fn(),
}));
vi.mock("./tools/idf-build.js", () => ({
  crosspadIdfBuild: vi.fn(),
}));
vi.mock("./tools/build-check.js", () => ({
  crosspadBuildCheck: vi.fn(),
}));

// §12: mock the tracer doctor (always-green probe), the session (no real daemon
// spawn) and the persistent dashboard (controllable hasClients) so the `start`
// auto-open / `stop` keep-server-up behaviors can be asserted without hardware.
const doctorOk = { ok: true, issues: [] as any[], probe: { found: true } };
vi.mock("./tools/trace-doctor.js", () => ({
  runDoctor: vi.fn(async () => doctorOk),
  realProbe: vi.fn(() => ({}) as any),
}));

// Shared dashboard spy state — the fake getDashboard() returns this object.
const fakeDashboard = {
  ensureStarted: vi.fn(async () => "http://localhost:7373/"),
  hasClients: vi.fn(() => false),
  bind: vi.fn(),
  unbind: vi.fn(),
  port: 7373,
};
vi.mock("./tools/trace-webui.js", () => ({
  getDashboard: vi.fn(() => fakeDashboard),
  openInBrowser: vi.fn(() => true),
  buildUiUrl: (p: number) => `http://localhost:${p}/`,
}));

// Fake TraceSession: produces a first "sample" frame so `start` reports running,
// no daemon spawned. getActiveSession/setActiveSession kept real-ish. The class
// lives INSIDE the (hoisted) factory to avoid a TDZ on the hoisted reference.
let mockActiveSession: any = null;
vi.mock("./tools/trace-session.js", () => {
  class FakeTraceSession {
    buffer = { count: () => 0, signalNames: () => this._signals };
    deviceState = "connecting";
    startedAt = 0;
    filePath = "/tmp/trace-fake.cptrace";
    _signals: string[];
    constructor(opts: any) { this._signals = opts.signals; }
    start() { /* no daemon */ }
    async waitForFirstFrame() { this.deviceState = "running"; return { type: "sample", t: 0, values: {} }; }
    isRunning() { return true; }
    // The MCP `stop` handler defers teardown to onStopped (fires when the daemon
    // truly exits). Model a daemon that exits promptly on stop so the test sees
    // the deferred unbind/clear happen.
    _stoppedCbs: (() => void)[] = [];
    onStopped(cb: () => void) { this._stoppedCbs.push(cb); }
    stop() { const cbs = this._stoppedCbs; this._stoppedCbs = []; for (const cb of cbs) cb(); }
    stderrTail() { return ""; }
  }
  return {
    TraceSession: FakeTraceSession,
    getActiveSession: vi.fn(() => mockActiveSession),
    setActiveSession: vi.fn((s: any) => { mockActiveSession = s; }),
  };
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { crosspadBuild, crosspadKill, crosspadRun } from "./tools/build.js";
import { crosspadIdfBuild } from "./tools/idf-build.js";
import { crosspadBuildCheck } from "./tools/build-check.js";
import type { AddressInfo } from "net";
import {
  server, setTraceBrowserOpener,
  bearerMatches, resolveHttpToken, httpAllowedHosts, startHttpServer,
} from "./index.js";
import { _setConfigPathForTest } from "./utils/userConfig.js";

const mockedPcBuild = vi.mocked(crosspadBuild);
const mockedIdfBuild = vi.mocked(crosspadIdfBuild);
const mockedKill = vi.mocked(crosspadKill);
const mockedRun = vi.mocked(crosspadRun);
const mockedBuildCheck = vi.mocked(crosspadBuildCheck);

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe("crosspad_build via MCP API", () => {
  it("validates PC build success result against outputSchema", async () => {
    mockedPcBuild.mockResolvedValueOnce({
      success: true,
      duration_seconds: 12.3,
      errors: [],
      warnings_count: 2,
      output_path: "/tmp/CrossPad",
    });

    const result = await client.callTool({
      name: "crosspad_build",
      arguments: { platform: "pc", mode: "incremental", build_type: "Debug" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      success: true,
      warnings_count: 2,
      output_path: "/tmp/CrossPad",
    });
  });

  it("validates IDF build success result against outputSchema (regression: warnings[]/tail/no output_path)", async () => {
    mockedIdfBuild.mockResolvedValueOnce({
      success: true,
      duration_seconds: 45.1,
      errors: [],
      warnings: ["w1", "w2"],
      tail: ["last", "lines"],
      auto_reconfigured: false,
    });

    // Before the schema fix this throws:
    //   Output validation error: warnings_count expected number, received undefined
    //   output_path expected string, received undefined
    const result = await client.callTool({
      name: "crosspad_build",
      arguments: { platform: "idf", mode: "incremental" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      success: true,
      warnings: ["w1", "w2"],
      tail: ["last", "lines"],
    });
  });

  it("validates error envelope from invalid mode/platform combo", async () => {
    // PC + fullclean is rejected before dispatch — only {success:false,error}.
    const result = await client.callTool({
      name: "crosspad_build",
      arguments: { platform: "pc", mode: "fullclean" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: expect.stringContaining("fullclean"),
    });
  });

  it("validates IDF build failure (errors[] populated, no output_path)", async () => {
    mockedIdfBuild.mockResolvedValueOnce({
      success: false,
      duration_seconds: 3.0,
      errors: ["compile error: foo.c:1:1"],
      warnings: [],
      tail: ["ninja: build stopped"],
    });

    const result = await client.callTool({
      name: "crosspad_build",
      arguments: { platform: "idf", mode: "clean" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      errors: ["compile error: foo.c:1:1"],
    });
  });
});

describe("crosspad_check via MCP API", () => {
  it("wrapper injects success=true and exe_path so structuredContent passes outputSchema (regression)", async () => {
    // Handler intentionally returns NEITHER `success` NOR `exe_path` — those
    // are wrapper responsibilities. Before the fix this round-trip threw:
    //   Output validation error: success expected boolean, received undefined
    //   exe_path expected string, received undefined
    mockedBuildCheck.mockReturnValueOnce({
      needs_reconfigure: false,
      needs_rebuild: false,
      exe_exists: true,
      exe_age_seconds: 42,
      reasons: ["Build appears up to date"],
      submodule_changes: {},
      new_source_files: [],
    });

    const r = await client.callTool({
      name: "crosspad_check",
      arguments: { platform: "pc" },
    });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      success: true,
      needs_rebuild: false,
      exe_exists: true,
      reasons: ["Build appears up to date"],
    });
    // exe_path must be a non-empty string injected by the wrapper
    const sc = r.structuredContent as Record<string, unknown>;
    expect(typeof sc.exe_path).toBe("string");
    expect((sc.exe_path as string).length).toBeGreaterThan(0);
  });
});

describe("crosspad_trace via MCP API", () => {
  it("is registered and returns idle status when no trace is active", async () => {
    const r = await client.callTool({
      name: "crosspad_trace",
      arguments: { action: "status" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      success: true,
      device_state: "idle",
      sample_count: 0,
    });
  });
});

describe("crosspad_trace danger actions are confirmed (S2)", () => {
  it("write returns a confirmation and pokes nothing", async () => {
    const r = await client.callTool({
      name: "crosspad_trace",
      arguments: { action: "write", writes: ["@0x50000414:u16=0xFFFF"] },
    });
    const sc = r.structuredContent as any;
    expect(sc.success).toBe(false);
    expect(sc.resultType).toBe("confirmation_required");
    expect(sc.confirmation.summary).toContain("0x50000414");
    expect(sc.confirmation.token).toMatch(/^cfm_/);
  });

  it("call is confirmed even with confirm:true — that flag acknowledges the halt, it is not an approval", async () => {
    const r = await client.callTool({
      name: "crosspad_trace",
      arguments: { action: "call", func: "HAL_NVIC_SystemReset", confirm: true },
    });
    const sc = r.structuredContent as any;
    expect(sc.resultType).toBe("confirmation_required");
    expect(sc.confirmation.summary).toContain("HAL_NVIC_SystemReset");
  });

  it("a read action still runs without a token", async () => {
    const r = await client.callTool({ name: "crosspad_trace", arguments: { action: "status" } });
    expect((r.structuredContent as any).success).toBe(true);
  });

  it("advertises itself as destructive — it contains write and call", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "crosspad_trace")!;
    expect(t.annotations?.destructiveHint).toBe(true);
    expect(t.annotations?.readOnlyHint).toBe(false);
  });
});

describe("--http is loopback + bearer only (S1, spec §3.6/§4.3)", () => {
  it("takes CROSSPAD_MCP_TOKEN, and generates one when it is absent", () => {
    expect(resolveHttpToken({ CROSSPAD_MCP_TOKEN: "abc" })).toEqual({ token: "abc", generated: false });
    const generated = resolveHttpToken({});
    expect(generated.generated).toBe(true);
    expect(generated.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it("accepts only the exact bearer token", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches("bearer  s3cret", "s3cret")).toBe(true);
    expect(bearerMatches(undefined, "s3cret")).toBe(false);
    expect(bearerMatches("Bearer s3cre", "s3cret")).toBe(false);
    expect(bearerMatches("Bearer s3cretx", "s3cret")).toBe(false);
    expect(bearerMatches("Basic s3cret", "s3cret")).toBe(false);
    expect(bearerMatches("s3cret", "s3cret")).toBe(false);
  });

  it("allows only this port's loopback names as Host", () => {
    expect(httpAllowedHosts(8080)).toEqual(["127.0.0.1:8080", "localhost:8080", "[::1]:8080"]);
  });

  it("binds 127.0.0.1 and never reaches the transport unauthenticated", async () => {
    const seen: string[] = [];
    const srv = await startHttpServer(0, "s3cret", async (req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("reached");
    });
    try {
      const addr = srv.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      const url = `http://127.0.0.1:${addr.port}/mcp`;

      const anon = await fetch(url, { method: "POST" });
      expect(anon.status).toBe(401);
      expect(anon.headers.get("www-authenticate")).toContain("Bearer");

      const wrong = await fetch(url, { method: "POST", headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);
      expect(seen).toEqual([]);

      const good = await fetch(url, { method: "POST", headers: { authorization: "Bearer s3cret" } });
      expect(good.status).toBe(200);
      expect(seen).toEqual(["/mcp"]);
      // No CORS grant: a page on another origin must not be able to use this.
      expect(good.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("crosspad_trace §12 persistent dashboard + auto-open", () => {
  const fakeOpener = vi.fn((_url: string) => true);

  beforeEach(() => {
    mockActiveSession = null;
    fakeDashboard.ensureStarted.mockClear();
    fakeDashboard.hasClients.mockReset();
    fakeDashboard.bind.mockClear();
    fakeDashboard.unbind.mockClear();
    fakeOpener.mockClear();
    setTraceBrowserOpener(fakeOpener);
    // Isolate from the real ~/.config/crosspad-mcp/config.json so `ui_open`
    // resolution is deterministic (empty config → env/default control the mode).
    _setConfigPathForTest("/tmp/cp-mcp-test-no-such-config.json");
    delete process.env.CROSSPAD_TRACE_UI_OPEN;
  });
  afterEach(() => {
    _setConfigPathForTest(null);
    delete process.env.CROSSPAD_TRACE_UI_OPEN;
  });

  it("start (default ui_open=vscode) does NOT pop the system browser immediately — it binds and replies with the link (the agent presents it; a 30s watchdog is the fallback)", async () => {
    fakeDashboard.hasClients.mockReturnValue(false);
    const r = await client.callTool({
      name: "crosspad_trace",
      arguments: { action: "start", signals: ["s_vbat_mv"] },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ success: true, device_state: "running", ui_url: "http://localhost:7373/" });
    expect(fakeDashboard.ensureStarted).toHaveBeenCalled();
    expect(fakeOpener).not.toHaveBeenCalled();   // vscode mode: no immediate pop
    expect(fakeDashboard.bind).toHaveBeenCalledTimes(1);
  });

  it("start with ui_open=browser opens the system browser immediately when no client is connected", async () => {
    process.env.CROSSPAD_TRACE_UI_OPEN = "browser";
    fakeDashboard.hasClients.mockReturnValue(false);
    const r = await client.callTool({
      name: "crosspad_trace",
      arguments: { action: "start", signals: ["s_vbat_mv"] },
    });
    expect(r.isError).toBeFalsy();
    expect(fakeOpener).toHaveBeenCalledWith("http://localhost:7373/");
    expect(fakeDashboard.bind).toHaveBeenCalledTimes(1);
  });

  it("start does NOT auto-open when a client is already connected (tab already open), even in browser mode", async () => {
    process.env.CROSSPAD_TRACE_UI_OPEN = "browser";
    fakeDashboard.hasClients.mockReturnValue(true);
    const r = await client.callTool({
      name: "crosspad_trace",
      arguments: { action: "start", signals: ["s_vbat_mv"] },
    });
    expect(r.isError).toBeFalsy();
    expect(fakeOpener).not.toHaveBeenCalled();
    expect(fakeDashboard.bind).toHaveBeenCalledTimes(1);
  });

  it("stop unbinds the dashboard (server stays up) — never shuts it down", async () => {
    fakeDashboard.hasClients.mockReturnValue(true);
    // start a (fake) trace so there's an active session to stop.
    await client.callTool({ name: "crosspad_trace", arguments: { action: "start", signals: ["s_vbat_mv"] } });
    fakeDashboard.unbind.mockClear();
    const r = await client.callTool({ name: "crosspad_trace", arguments: { action: "stop" } });
    expect(r.isError).toBeFalsy();
    // unbind (idle, server keeps listening) — there is no shutdown call at all.
    expect(fakeDashboard.unbind).toHaveBeenCalledTimes(1);
    expect((fakeDashboard as any).shutdown).toBeUndefined();
  });

  it("ui ensures the persistent server is up even with no active trace (idle dashboard)", async () => {
    mockActiveSession = null;
    const r = await client.callTool({ name: "crosspad_trace", arguments: { action: "ui" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ success: true, ui_url: "http://localhost:7373/" });
    expect(fakeDashboard.ensureStarted).toHaveBeenCalled();
  });
});

describe("crosspad_kill via MCP API", () => {
  it("validates idle path (was_running=false)", async () => {
    mockedKill.mockResolvedValueOnce({
      success: true,
      killed_pids: [],
      was_running: false,
    });
    const r = await client.callTool({
      name: "crosspad_kill",
      arguments: { platform: "pc" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      success: true,
      killed_pids: [],
      was_running: false,
    });
  });

  it("validates successful kill (graceful SIGTERM)", async () => {
    mockedKill.mockResolvedValueOnce({
      success: true,
      killed_pids: [111, 222],
      was_running: true,
    });
    const r = await client.callTool({
      name: "crosspad_kill",
      arguments: { platform: "pc" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      success: true,
      killed_pids: [111, 222],
      was_running: true,
    });
  });

  it("validates failure path with diagnostic error string (regression: error must round-trip through outputSchema)", async () => {
    mockedKill.mockResolvedValueOnce({
      success: false,
      killed_pids: [],
      was_running: true,
      error: "Simulator still alive after SIGTERM+SIGKILL, pids=42, tcp_alive=true, failures=[SIGTERM pid=42 EPERM; SIGKILL pid=42 EPERM].",
    });
    const r = await client.callTool({
      name: "crosspad_kill",
      arguments: { platform: "pc" },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      success: false,
      killed_pids: [],
      was_running: true,
      error: expect.stringContaining("EPERM"),
    });
  });
});

describe("crosspad_run via MCP API", () => {
  it("links the captured log on a successful launch", async () => {
    mockedRun.mockResolvedValueOnce({
      pid: 4242,
      exe_path: "/x/bin/CrossPad",
      responsive: true,
      log_path: "/x/hil_logs/sim_20260826_101112.log",
    });
    const r = await client.callTool({
      name: "crosspad_run",
      arguments: { platform: "pc" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ success: true, pid: 4242, log_path: "/x/hil_logs/sim_20260826_101112.log" });
    const link = (r.content as { type: string; uri?: string }[]).find((c) => c.type === "resource_link");
    expect(link).toMatchObject({ uri: "file:///x/hil_logs/sim_20260826_101112.log", mimeType: "text/plain" });
  });

  it("says why a launch failed instead of only that the probe did — REGRESSION: a crashed sim reported nothing but a dead port", async () => {
    mockedRun.mockResolvedValueOnce({
      pid: 4243,
      exe_path: "/x/bin/CrossPad",
      responsive: false,
      log_path: "/x/hil_logs/sim_20260826_101113.log",
      log_tail: ["loading kits...", "error while loading shared libraries: libSDL2-2.0.so.0"],
      error: "Simulator process 4243 exited before the control port answered.",
    });
    const r = await client.callTool({
      name: "crosspad_run",
      arguments: { platform: "pc" },
    });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({
      success: false,
      responsive: false,
      log_path: "/x/hil_logs/sim_20260826_101113.log",
    });
    expect((r.structuredContent as { log_tail: string[] }).log_tail.at(-1)).toMatch(/libSDL2/);
    expect((r.structuredContent as { error: string }).error).toMatch(/exited before the control port answered/);
    expect((r.content as { type: string }[]).some((c) => c.type === "resource_link")).toBe(true);
  });
});

// The sim tools' declared schemas (spec §3.8). These are what the model sees,
// so they are asserted through tools/list rather than by reading the source.
describe("sim toolset input schemas", () => {
  async function schemaOf(name: string): Promise<any> {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    expect(tool, `${name} is not registered`).toBeTruthy();
    return tool!.inputSchema as any;
  }

  it("crosspad_settings_get publishes exactly what its handler accepts", async () => {
    const cat = (await schemaOf("crosspad_settings_get")).properties.category;
    // No frozen enum. settingsCategories() is derived through an
    // mtime-invalidated cache and changes while the process runs, so an enum
    // captured at registration rejected valid categories at the protocol edge —
    // where the handler's own "Known: ..." message is never reached.
    expect(cat.enum).toBeUndefined();
    expect(cat.type).toBe("string");
    for (const c of ["all", "display", "keypad", "vibration", "wireless", "audio", "system"]) {
      expect(cat.description, `missing '${c}'`).toContain(c);
    }
  });

  it("an unknown category reaches the handler, which answers with the list it knows", async () => {
    const r = await client.callTool({ name: "crosspad_settings_get", arguments: { category: "no_such_group" } });
    expect(String((r.structuredContent as any).error)).toContain("Unknown settings category 'no_such_group'");
  });

  it("crosspad_settings_set takes a boolean as well as a number", async () => {
    const value = (await schemaOf("crosspad_settings_set")).properties.value;
    const types = (value.anyOf ?? [value]).map((v: any) => v.type);
    expect(types).toContain("number");
    expect(types).toContain("boolean");
  });

  it("crosspad_test_run can select the gui labels", async () => {
    const labels = (await schemaOf("crosspad_test_run")).properties.labels;
    expect(labels.type).toBe("array");
    expect(labels.items.enum).toEqual(["gui", "flaky"]);
  });

  it("crosspad_screenshot can ask for the LCD only", async () => {
    expect((await schemaOf("crosspad_screenshot")).properties.region.enum).toEqual(["full", "lcd"]);
  });
});
