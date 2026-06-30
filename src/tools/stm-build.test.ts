import { describe, it, expect } from "vitest";
import { stmPresetFor } from "./stm-build.js";
import { stmBuildDir, stmArtifact, STM_PROJECT_NAME } from "../config.js";

describe("stm-build", () => {
  describe("stmPresetFor", () => {
    it("maps Debug to the Debug preset", () => {
      expect(stmPresetFor("Debug")).toBe("Debug");
    });
    it("maps Release to the Release preset", () => {
      expect(stmPresetFor("Release")).toBe("Release");
    });
    it("collapses RelWithDebInfo to Release (no such preset in CMakePresets)", () => {
      expect(stmPresetFor("RelWithDebInfo")).toBe("Release");
    });
    it("defaults unknown build types to Debug", () => {
      expect(stmPresetFor("nonsense")).toBe("Debug");
    });
  });

  describe("config path helpers", () => {
    it("build dir is <repo>/build/<preset>", () => {
      expect(stmBuildDir("Debug").endsWith("/build/Debug")).toBe(true);
      expect(stmBuildDir("Release").endsWith("/build/Release")).toBe(true);
    });
    it("artifact path is build/<preset>/<project>.<ext>", () => {
      const elf = stmArtifact("Debug", "elf");
      expect(elf.endsWith(`/build/Debug/${STM_PROJECT_NAME}.elf`)).toBe(true);
      expect(stmArtifact("Release", "bin").endsWith(`/build/Release/${STM_PROJECT_NAME}.bin`)).toBe(true);
    });
  });
});
