import { describe, it, expect } from "vitest";
import {
  DeviceSchema, SnapshotSchema, ReplySchema, ReadResultSchema, ExpectResultSchema,
  BootResultSchema, TaskStatusSchema, DoctorCheckSchema, ScenarioInfoSchema,
} from "./schemas.js";

describe("hil schemas mirror the crosspad_hil contract dicts", () => {
  it("DeviceSchema accepts Device.to_dict() with null ports and extra keys", () => {
    const d = DeviceSchema.parse({
      id: "dev_3f2a", serial: "A1B2C3", usb_mode: "default", board_rev: null,
      ports: {
        cdc: { path: "/dev/ttyACM0", vid: 0x303a, pid: 0x3456, serial: "A1B2C3", product: "Crosspad", location: "1-3.2" },
        console: { path: "/dev/ttyACM1", vid: 0x0483, pid: 0x5740, serial: null, product: "CrossPad MIDI+Serial", location: "1-3.1" },
        esp_midi: { name: "Crosspad MIDI", rtmidi_out: 2, rtmidi_in: 2, alsa_hw: "hw:4,0,0", rawmidi: null },
        stm_midi: null, uac2: null, bootloader: null,
      },
      firmware: { version: "1.2.3" },
    });
    expect(d.id).toBe("dev_3f2a");
    expect(d.ports.cdc?.path).toBe("/dev/ttyACM0");
    expect(d.ports.uac2).toBeNull();
    expect((d as Record<string, unknown>).firmware).toEqual({ version: "1.2.3" });
  });

  it("DeviceSchema rejects an unknown usb_mode", () => {
    expect(() => DeviceSchema.parse({ id: "dev_1", serial: null, usb_mode: "dfu", ports: {}, board_rev: null })).toThrow();
  });

  it("SnapshotSchema accepts a snapshot with null sections", () => {
    const s = SnapshotSchema.parse({
      snapshot_id: "snap_41", device: "dev_3f2a", usb_mode: "default",
      apps: { running: "Sampler", available: ["Sampler"] }, ui: null, kit: { current: 3, name: "DRUMS", loading: false, pending: -1 },
      leds: null, pads: null, mem: null, ble: null, console: null, ts: 1756100000.5, changed: ["kit"],
    });
    expect(s.changed).toEqual(["kit"]);
    expect(s.ui).toBeNull();
  });

  it("ReplySchema accepts a CDC reply with and without parsed", () => {
    expect(ReplySchema.parse({ line: "OK", parsed: { kind: "ok" }, rtt_ms: 1.2, extra_lines: [] }).parsed).toEqual({ kind: "ok" });
    expect(ReplySchema.parse({ line: "WEIRD", parsed: null, rtt_ms: 1.2, extra_lines: ["x"] }).extra_lines).toEqual(["x"]);
  });

  it("ReadResultSchema accepts [seq, line] tuples", () => {
    const r = ReadResultSchema.parse({ lines: [[1, "I (10) boot"], [2, "I (11) main"]], next_seq: 3, lines_lost: 0 });
    expect(r.lines[1]).toEqual([2, "I (11) main"]);
  });

  it("ExpectResultSchema accepts a miss (all null)", () => {
    const r = ExpectResultSchema.parse({ hit: null, rejected: null, seq: null, context: [], elapsed_s: 30.0 });
    expect(r.hit).toBeNull();
  });

  it("BootResultSchema accepts the smoke result", () => {
    const b = BootResultSchema.parse({ complete: true, missing: [], fatal: [], errors: [{ seq: 5, line: "E (1) x" }], bootloops: 0, seconds: 12.3 });
    expect(b.complete).toBe(true);
  });

  it("TaskStatusSchema accepts working/completed/failed/cancelled", () => {
    expect(TaskStatusSchema.parse({ task: "task_1", status: "working", progress: 2, total: 10, message: "round 2/10" }).status).toBe("working");
    expect(TaskStatusSchema.parse({ task: "task_1", status: "completed", result: { passed: true } }).result).toEqual({ passed: true });
    expect(TaskStatusSchema.parse({ task: "task_1", status: "failed", error: { code: "TIMEOUT", message: "x" } }).error?.code).toBe("TIMEOUT");
    expect(() => TaskStatusSchema.parse({ task: "task_1", status: "running" })).toThrow();
  });

  it("DoctorCheckSchema and ScenarioInfoSchema", () => {
    expect(DoctorCheckSchema.parse({ name: "venv", ok: false, detail: "no crosspad_hil", fix: "pip install crosspad-hil[all]" }).ok).toBe(false);
    const s = ScenarioInfoSchema.parse({ name: "kit_churn", description: "swap kits while pads fire", params: [{ name: "rounds", type: "int", default: 20, help: "rounds" }] });
    expect(s.params[0].name).toBe("rounds");
  });
});
