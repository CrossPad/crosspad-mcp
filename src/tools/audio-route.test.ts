import { describe, it, expect } from "vitest";
import { buildSetFrames, decodeState } from "./audio-route.js";

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

  describe("decodeState", () => {
    it("decodes the hardware-verified reply", () => {
      // F0 7D 1D 10 00 00 00 03 03 40 40 00 00 F7 (state bytes only)
      const state = decodeState([0, 0, 0, 3, 3, 0x40, 0x40, 0, 0]);
      expect(state).toEqual({
        mic_src: 0,
        adc_input: ["diff", "diff"],
        dac_output: ["all", "all"],
        volume: [64, 64],
        mute: [false, false],
      });
    });

    it("decodes a loop-path state", () => {
      const state = decodeState([1, 0, 1, 3, 1, 100, 90, 0, 1]);
      expect(state).toEqual({
        mic_src: 1,
        adc_input: ["diff", "line1"],
        dac_output: ["all", "line1"],
        volume: [100, 90],
        mute: [false, true],
      });
    });
  });
});
