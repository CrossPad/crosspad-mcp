import { describe, it, expect, vi, beforeEach } from "vitest";

describe("midi module", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe("crosspadMidiSend validation", () => {
    it("rejects invalid MIDI channel", async () => {
      // Mock simulator as running
      vi.doMock("../utils/remote-client.js", () => ({
        isSimulatorRunning: vi.fn(async () => true),
        sendRemoteCommand: vi.fn(async () => ({ ok: true })),
      }));

      const { crosspadMidiSend } = await import("./midi.js");

      const result = await crosspadMidiSend({
        type: "note_on",
        channel: 16, // invalid
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("channel");
    });

    it("rejects note out of range", async () => {
      vi.doMock("../utils/remote-client.js", () => ({
        isSimulatorRunning: vi.fn(async () => true),
        sendRemoteCommand: vi.fn(async () => ({ ok: true })),
      }));

      const { crosspadMidiSend } = await import("./midi.js");

      const result = await crosspadMidiSend({
        type: "note_on",
        channel: 0,
        note: 128, // invalid
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Note");
    });

    it("rejects cc with not-yet-supported error (fail-fast before sim)", async () => {
      vi.doMock("../utils/remote-client.js", () => ({
        isSimulatorRunning: vi.fn(async () => true),
        sendRemoteCommand: vi.fn(async () => ({ ok: true })),
      }));

      const { crosspadMidiSend } = await import("./midi.js");

      const result = await crosspadMidiSend({
        type: "cc",
        channel: 0,
        cc_num: 7,
        value: 64,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not yet supported");
    });

    it("returns error when simulator is not running", async () => {
      vi.doMock("../utils/remote-client.js", () => ({
        isSimulatorRunning: vi.fn(async () => false),
        sendRemoteCommand: vi.fn(),
      }));

      const { crosspadMidiSend } = await import("./midi.js");

      const result = await crosspadMidiSend({
        type: "note_on",
        channel: 0,
        note: 60,
        velocity: 127,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not running");
    });

    it("sends note_on with correct parameters", async () => {
      const mockSend = vi.fn(async () => ({ ok: true }));

      vi.doMock("../utils/remote-client.js", () => ({
        isSimulatorRunning: vi.fn(async () => true),
        sendRemoteCommand: mockSend,
      }));

      const { crosspadMidiSend } = await import("./midi.js");

      const result = await crosspadMidiSend({
        type: "note_on",
        channel: 5,
        note: 60,
        velocity: 100,
      });

      expect(result.success).toBe(true);
      expect(result.type).toBe("note_on");
      expect(result.channel).toBe(5);
      expect(result.details.note).toBe(60);
      expect(result.details.velocity).toBe(100);

      expect(mockSend).toHaveBeenCalledWith({
        cmd: "midi_note_on",
        channel: 5,
        note: 60,
        velocity: 100,
      });
    });

    it("fails fast for program_change (PC sim has no midi_program_change handler)", async () => {
      const mockSend = vi.fn(async () => ({ ok: true }));

      vi.doMock("../utils/remote-client.js", () => ({
        isSimulatorRunning: vi.fn(async () => true),
        sendRemoteCommand: mockSend,
      }));

      const { crosspadMidiSend } = await import("./midi.js");

      const result = await crosspadMidiSend({
        type: "program_change",
        channel: 0,
        program: 42,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not yet supported");
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("fails fast for cc (PC sim has no midi_cc handler)", async () => {
      const mockSend = vi.fn(async () => ({ ok: true }));

      vi.doMock("../utils/remote-client.js", () => ({
        isSimulatorRunning: vi.fn(async () => true),
        sendRemoteCommand: mockSend,
      }));

      const { crosspadMidiSend } = await import("./midi.js");

      const result = await crosspadMidiSend({
        type: "cc",
        channel: 0,
        cc_num: 7,
        value: 64,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not yet supported");
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("sends note_off with correct wire command (regression: cmd=midi_note_off, not cmd=midi)", async () => {
      const mockSend = vi.fn(async () => ({ ok: true }));

      vi.doMock("../utils/remote-client.js", () => ({
        isSimulatorRunning: vi.fn(async () => true),
        sendRemoteCommand: mockSend,
      }));

      const { crosspadMidiSend } = await import("./midi.js");

      const result = await crosspadMidiSend({
        type: "note_off",
        channel: 3,
        note: 60,
      });

      expect(result.success).toBe(true);
      expect(mockSend).toHaveBeenCalledWith({
        cmd: "midi_note_off",
        channel: 3,
        note: 60,
        velocity: 0,
      });
    });
  });
});
