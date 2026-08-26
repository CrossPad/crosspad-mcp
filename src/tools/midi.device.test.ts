import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer, fakeExtra } from "../testing/fake-server.js";
import { registerMidiTool, toMidiOp, TOOL_NAME } from "./midi.js";
import type { ToolContext } from "../tool-context.js";
import type { Policy } from "../policy/policy.js";
import { jobs } from "../tasks.js";
import { handles } from "../handles.js";

const STRICT: Policy = { mode: "strict", rules: [] };

function ctxFor(daemon: ReturnType<typeof fakeDaemon>): ToolContext {
  return { daemon: () => daemon, policy: STRICT, jobs, handles };
}

describe("toMidiOp", () => {
  it("maps note on/off to midi.note with the daemon's arg names", () => {
    expect(toMidiOp({ target: "device", action: "note", on: true, note: 40, vel: 110, channel: 2, role: "esp" } as never))
      .toEqual({ op: "midi.note", args: { role: "esp", on: true, note: 40, vel: 110, channel: 2 } });
    expect(toMidiOp({ target: "device", action: "note", on: false, note: 40 } as never))
      .toEqual({ op: "midi.note", args: { on: false, note: 40 } });
  });

  it("maps sysex to midi.sysex, keeping the hex string verbatim", () => {
    expect(toMidiOp({ target: "device", action: "sysex", frame: "F0 7D 1D 10 F7", role: "stm" } as never))
      .toEqual({ op: "midi.sysex", args: { role: "stm", frame: "F0 7D 1D 10 F7" } });
  });

  it("maps echo_rtt and query_route without a role", () => {
    expect(toMidiOp({ target: "device", action: "echo_rtt", n: 50 } as never))
      .toEqual({ op: "midi.echo_rtt", args: { n: 50 } });
    expect(toMidiOp({ target: "device", action: "query_route" } as never))
      .toEqual({ op: "midi.query_route", args: {} });
  });
});

describe("crosspad_midi target=device", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); });

  it("sends a note over the daemon and reports what it sent", async () => {
    const d = fakeDaemon({ "midi.note": () => ({ ok: true }) });
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "device", action: "note", on: true, note: 36, vel: 100, device: "dev_3f2a" },
      fakeExtra(),
    );
    expect(d.calls[0].op).toBe("midi.note");
    expect(d.calls[0].args).toEqual({ device: "dev_3f2a", on: true, note: 36, vel: 100 });
    expect(r.structuredContent).toMatchObject({ success: true, target: "device", action: "note", device: "dev_3f2a" });
  });

  it("passes the role through to the daemon", async () => {
    const d = fakeDaemon({ "midi.sysex": () => ({ sent: 5 }) });
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "device", action: "sysex", frame: "F0 7D 1B 02 F7", role: "stm" },
      fakeExtra(),
    );
    expect(d.calls[0].args).toEqual({ role: "stm", frame: "F0 7D 1B 02 F7" });
    expect(r.structuredContent.result).toEqual({ sent: 5 });
  });

  it("rejects a frame that is not F0 … F7 before touching the daemon", async () => {
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    // Rejected by the declared schema, before the handler runs — the SDK
    // validates input first, so the daemon cannot be reached either way.
    await expect(
      fs.tools.get(TOOL_NAME)!.cb({ target: "device", action: "sysex", frame: "90 40 7F" }, fakeExtra()),
    ).rejects.toThrow(/F0/);
    expect(d.calls).toHaveLength(0);
  });

  it("surfaces a daemon error as the v10 error envelope", async () => {
    const { HilError } = await import("../hil/daemon.js");
    const d = fakeDaemon({ "midi.query_route": () => { throw new HilError("TIMEOUT", "no query reply within 1.0 s", "is the firmware built with audio_route_control?"); } });
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "device", action: "query_route" }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error).toMatchObject({ code: "TIMEOUT", hint: "is the firmware built with audio_route_control?" });
  });

  it("reports echo_rtt statistics unchanged", async () => {
    const d = fakeDaemon({ "midi.echo_rtt": () => ({ sent: 20, received: 20, lost: 0, rtt_ms: { p50: 4.1, p90: 7.2, max: 11.0 } }) });
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "device", action: "echo_rtt", n: 20 }, fakeExtra());
    expect(r.structuredContent.result).toMatchObject({ sent: 20, lost: 0 });
  });
});

describe("crosspad_midi target=sim", () => {
  let fs: ReturnType<typeof fakeServer>;
  beforeEach(() => { fs = fakeServer(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("cc is still refused with an actionable message and never reaches the daemon", async () => {
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "sim", type: "cc", channel: 0, cc_num: 7, value: 100 },
      fakeExtra(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.structuredContent.error)).toMatch(/not yet supported by the PC simulator/i);
    expect(String(r.structuredContent.error)).toMatch(/note_on\/note_off/);
    expect(d.calls).toHaveLength(0);
  });

  it("program_change is refused the same way", async () => {
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "sim", type: "program_change", channel: 0, program: 3 },
      fakeExtra(),
    );
    expect(r.isError).toBe(true);
    expect(String(r.structuredContent.error)).toMatch(/midi_program_change/);
  });

  it("note_on still goes through crosspadMidiSend, not the daemon", async () => {
    const remote = await import("../utils/remote-client.js");
    vi.spyOn(remote, "isSimulatorRunning").mockResolvedValue(true);
    const send = vi.spyOn(remote, "sendRemoteCommand").mockResolvedValue({ ok: true } as never);
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb(
      { target: "sim", type: "note_on", channel: 0, note: 60 },
      fakeExtra(),
    );
    expect(send).toHaveBeenCalledWith({ cmd: "midi_note_on", channel: 0, note: 60, velocity: 127 });
    expect(r.structuredContent).toMatchObject({ success: true, target: "sim", type: "note_on" });
    expect(d.calls).toHaveLength(0);
  });

  it("a missing note is refused before the sim is contacted", async () => {
    const d = fakeDaemon({});
    registerMidiTool(fs.server, ctxFor(d));
    const r = await fs.tools.get(TOOL_NAME)!.cb({ target: "sim", type: "note_on", channel: 0 }, fakeExtra());
    expect(r.isError).toBe(true);
    expect(String(r.structuredContent.error)).toContain("'note' is required");
  });
});
