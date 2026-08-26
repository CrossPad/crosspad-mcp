import { describe, it, expect } from "vitest";
import { buildSetFrames, hexFrame, stateFromQuery, crosspadAudioRouteSet, crosspadAudioRouteQuery } from "./audio-route.js";

describe("audio-route module", () => {
  describe("buildSetFrames", () => {
    it("builds a full frame set in subcommand order", () => {
      const { frames, error } = buildSetFrames({
        codec: 1,
        adc_input: "line1",
        mic_src: 1,
        dac_output: "all",
        volume: 90,
        mute: false,
      });
      expect(error).toBeUndefined();
      expect(frames).toEqual([
        [0xf0, 0x7d, 0x1d, 0x01, 1, 1, 0xf7],
        [0xf0, 0x7d, 0x1d, 0x02, 1, 0xf7],
        [0xf0, 0x7d, 0x1d, 0x03, 1, 3, 0xf7],
        [0xf0, 0x7d, 0x1d, 0x04, 1, 90, 0xf7],
        [0xf0, 0x7d, 0x1d, 0x05, 1, 0, 0xf7],
      ]);
    });

    it("mic_src alone needs no codec", () => {
      const { frames, error } = buildSetFrames({ mic_src: 0 });
      expect(error).toBeUndefined();
      expect(frames).toEqual([[0xf0, 0x7d, 0x1d, 0x02, 0, 0xf7]]);
    });

    it("rejects per-codec fields without codec", () => {
      const { error } = buildSetFrames({ adc_input: "diff" });
      expect(error).toContain("codec");
    });

    it("rejects out-of-range volume", () => {
      const { error } = buildSetFrames({ codec: 0, volume: 101 });
      expect(error).toContain("volume");
    });

    it("rejects an empty set", () => {
      const { error } = buildSetFrames({ codec: 0 });
      expect(error).toContain("Nothing to set");
    });
  });

  describe("hexFrame", () => {
    it("renders a frame as uppercase space-separated bytes", () => {
      expect(hexFrame([0xf0, 0x7d, 0x1d, 0x01, 1, 2, 0xf7])).toBe("F0 7D 1D 01 01 02 F7");
    });
  });

  describe("stateFromQuery", () => {
    it("decodes the hardware-verified reply of midi.query_route", () => {
      expect(stateFromQuery({ mic_src: 0, adc: [2, 0], out: [3, 3], vol: [80, 80], mute: [0, 0] })).toEqual({
        mic_src: 0,
        adc_input: ["line2", "diff"],
        dac_output: ["all", "all"],
        volume: [80, 80],
        mute: [false, false],
      });
    });

    it("decodes the DAC\u2192ADC loop state", () => {
      expect(stateFromQuery({ mic_src: 1, adc: [1, 1], out: [1, 2], vol: [100, 65], mute: [0, 1] })).toEqual({
        mic_src: 1,
        adc_input: ["line1", "line1"],
        dac_output: ["line1", "line2"],
        volume: [100, 65],
        mute: [false, true],
      });
    });

    it("falls back to safe names on an out-of-range code rather than throwing", () => {
      expect(stateFromQuery({ mic_src: 0, adc: [9, 9], out: [9, 9], vol: [0, 0], mute: [true, false] })).toEqual({
        mic_src: 0,
        adc_input: ["diff", "diff"],
        dac_output: ["all", "all"],
        volume: [0, 0],
        mute: [true, false],
      });
    });
  });

  describe("crosspadAudioRouteSet over the daemon", () => {
    const DEV = {
      id: "dev_3f2a", serial: "AABB", usb_mode: "default", board_rev: "v2",
      ports: {
        cdc: { path: "/dev/ttyACM0", vid: 0x303a, pid: 0x3456, serial: null, product: null, location: "1-1.2" },
        console: null,
        esp_midi: { name: "Crosspad", rtmidi_out: 1, rtmidi_in: 1, alsa_hw: "hw:4,0,0", rawmidi: null },
        stm_midi: null, uac2: null, bootloader: null,
      },
    };

    it("sends one midi.sysex per frame and reports them as hex", async () => {
      const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
      const daemon = {
        async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
          calls.push({ op, args });
          return (op === "devices.list" ? { devices: [DEV] } : { sent: 7 }) as unknown as T;
        },
      };
      const r = await crosspadAudioRouteSet(daemon, undefined, { codec: 1, adc_input: "line1", volume: 90 });
      expect(r.success).toBe(true);
      expect(r.sent).toEqual(["F0 7D 1D 01 01 01 F7", "F0 7D 1D 04 01 5A F7"]);
      expect(r.port).toBe("hw:4,0,0");
      expect(calls.map((c) => c.op)).toEqual(["devices.list", "midi.sysex", "midi.sysex"]);
      expect(calls[1].args).toEqual({ device: "dev_3f2a", frame: "F0 7D 1D 01 01 01 F7" });
    });

    it("refuses an invalid set before contacting the daemon", async () => {
      const daemon = { async request<T>(): Promise<T> { throw new Error("must not be called"); } };
      const r = await crosspadAudioRouteSet(daemon, undefined, { adc_input: "diff" });
      expect(r.success).toBe(false);
      expect(r.error).toContain("codec");
    });

    it("reports which frames made it out when a later one fails", async () => {
      const { HilError } = await import("../hil/daemon.js");
      let n = 0;
      const daemon = {
        async request<T>(op: string): Promise<T> {
          if (op === "devices.list") return { devices: [DEV] } as unknown as T;
          if (n++ === 1) throw new HilError("PORT_BUSY", "MIDI out busy");
          return { sent: 7 } as unknown as T;
        },
      };
      const r = await crosspadAudioRouteSet(daemon, undefined, { codec: 0, adc_input: "line2", volume: 50 });
      expect(r.success).toBe(false);
      expect(r.sent).toEqual(["F0 7D 1D 01 00 02 F7"]);
      expect(r.error).toContain("PORT_BUSY");
    });
  });

  describe("crosspadAudioRouteQuery over the daemon", () => {
    const DEV = {
      id: "dev_3f2a", serial: "AABB", usb_mode: "default", board_rev: null,
      ports: {
        cdc: { path: "/dev/ttyACM0", vid: 0x303a, pid: 0x3456, serial: null, product: null, location: "1-1.2" },
        console: null,
        esp_midi: { name: "Crosspad", rtmidi_out: 1, rtmidi_in: 1, alsa_hw: null, rawmidi: null },
        stm_midi: null, uac2: null, bootloader: null,
      },
    };

    it("returns the v9 state shape from midi.query_route", async () => {
      const daemon = {
        async request<T>(op: string): Promise<T> {
          if (op === "devices.list") return { devices: [DEV] } as unknown as T;
          return { mic_src: 1, adc: [1, 1], out: [1, 1], vol: [100, 100], mute: [0, 0] } as unknown as T;
        },
      };
      const r = await crosspadAudioRouteQuery(daemon, "dev_3f2a");
      expect(r).toEqual({
        success: true,
        port: "Crosspad",
        state: { mic_src: 1, adc_input: ["line1", "line1"], dac_output: ["line1", "line1"], volume: [100, 100], mute: [false, false] },
      });
    });

    it("a daemon TIMEOUT becomes a readable error string, not a throw", async () => {
      const { HilError } = await import("../hil/daemon.js");
      const daemon = {
        async request<T>(op: string): Promise<T> {
          if (op === "devices.list") return { devices: [DEV] } as unknown as T;
          throw new HilError("TIMEOUT", "no query reply within 1.0 s", "is the firmware built with audio_route_control?");
        },
      };
      const r = await crosspadAudioRouteQuery(daemon, undefined);
      expect(r.success).toBe(false);
      expect(r.error).toContain("TIMEOUT");
      expect(r.error).toContain("audio_route_control");
    });
  });
});
