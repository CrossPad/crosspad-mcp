// MCP-API roundtrip tests — exercise registered tools through real
// Client→Server protocol calls (structured output validation included).
// Catches output-schema/result-shape drift that pure unit tests miss.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

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

import { crosspadBuild, crosspadKill } from "./tools/build.js";
import { crosspadIdfBuild } from "./tools/idf-build.js";
import { crosspadBuildCheck } from "./tools/build-check.js";
import { server, setTraceBrowserOpener } from "./index.js";

const mockedPcBuild = vi.mocked(crosspadBuild);
const mockedIdfBuild = vi.mocked(crosspadIdfBuild);
const mockedKill = vi.mocked(crosspadKill);
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
  });

  it("start auto-opens the browser when NO client is connected, then binds", async () => {
    fakeDashboard.hasClients.mockReturnValue(false);
    const r = await client.callTool({
      name: "crosspad_trace",
      arguments: { action: "start", signals: ["s_vbat_mv"] },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ success: true, device_state: "running", ui_url: "http://localhost:7373/" });
    expect(fakeDashboard.ensureStarted).toHaveBeenCalled();
    expect(fakeOpener).toHaveBeenCalledWith("http://localhost:7373/");
    expect(fakeDashboard.bind).toHaveBeenCalledTimes(1);
  });

  it("start does NOT auto-open when a client is already connected (tab already open)", async () => {
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
