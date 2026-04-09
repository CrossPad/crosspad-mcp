import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";

// We need to test getRepos, resolveCrosspadCore, and findIdfPath.
// These depend on fs.existsSync and are cached, so we need fresh imports per test.

describe("config module", () => {
  const HOME = os.homedir();
  const GIT_DIR = path.join(HOME, "GIT");

  // Reset modules between tests to clear caches
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe("getRepos", () => {
    it("returns only repos that exist on disk", async () => {
      const existingPaths = new Set([
        path.join(GIT_DIR, "crosspad-pc"),
        path.join(GIT_DIR, "platform-idf"),
      ]);

      vi.doMock("fs", () => ({
        default: {
          existsSync: (p: string) => existingPaths.has(p),
          readFileSync: vi.fn(),
          readdirSync: vi.fn(() => []),
          lstatSync: vi.fn(),
          rmSync: vi.fn(),
        },
        existsSync: (p: string) => existingPaths.has(p),
      }));

      const { getRepos } = await import("./config.js");
      const repos = getRepos();

      expect(repos).toHaveProperty("crosspad-pc");
      expect(repos).toHaveProperty("platform-idf");
      expect(repos).not.toHaveProperty("crosspad-core");
      expect(repos).not.toHaveProperty("ESP32-S3");
    });

    it("returns empty object when no repos exist", async () => {
      vi.doMock("fs", () => ({
        default: {
          existsSync: () => false,
          readFileSync: vi.fn(),
          readdirSync: vi.fn(() => []),
          lstatSync: vi.fn(),
          rmSync: vi.fn(),
        },
        existsSync: () => false,
      }));

      const { getRepos } = await import("./config.js");
      const repos = getRepos();
      expect(Object.keys(repos)).toHaveLength(0);
    });

    it("caches results on second call", async () => {
      const existsSpy = vi.fn().mockReturnValue(true);
      vi.doMock("fs", () => ({
        default: {
          existsSync: existsSpy,
          readFileSync: vi.fn(),
          readdirSync: vi.fn(() => []),
          lstatSync: vi.fn(),
          rmSync: vi.fn(),
        },
        existsSync: existsSpy,
      }));

      const { getRepos } = await import("./config.js");
      getRepos();
      const callCount = existsSpy.mock.calls.length;
      getRepos(); // should use cache
      expect(existsSpy.mock.calls.length).toBe(callCount);
    });
  });

  describe("resolveCrosspadCore", () => {
    it("finds crosspad-core as standalone repo", async () => {
      const standalonePath = path.join(GIT_DIR, "crosspad-core");
      const includeDir = path.join(standalonePath, "include", "crosspad");

      vi.doMock("fs", () => ({
        default: {
          existsSync: (p: string) => p === includeDir || p === standalonePath,
          readFileSync: vi.fn(),
          readdirSync: vi.fn(() => []),
          lstatSync: vi.fn(),
          rmSync: vi.fn(),
        },
        existsSync: (p: string) => p === includeDir || p === standalonePath,
      }));

      const { resolveCrosspadCore } = await import("./config.js");
      expect(resolveCrosspadCore()).toBe(standalonePath);
    });

    it("falls back to IDF submodule", async () => {
      const idfRoot = path.join(GIT_DIR, "platform-idf");
      const submodulePath = path.join(idfRoot, "components", "crosspad-core");
      const includeDir = path.join(submodulePath, "include", "crosspad");

      vi.doMock("fs", () => ({
        default: {
          existsSync: (p: string) => p === includeDir,
          readFileSync: vi.fn(),
          readdirSync: vi.fn(() => []),
          lstatSync: vi.fn(),
          rmSync: vi.fn(),
        },
        existsSync: (p: string) => p === includeDir,
      }));

      const { resolveCrosspadCore } = await import("./config.js");
      expect(resolveCrosspadCore()).toBe(submodulePath);
    });

    it("returns null when not found anywhere", async () => {
      vi.doMock("fs", () => ({
        default: {
          existsSync: () => false,
          readFileSync: vi.fn(),
          readdirSync: vi.fn(() => []),
          lstatSync: vi.fn(),
          rmSync: vi.fn(),
        },
        existsSync: () => false,
      }));

      const { resolveCrosspadCore } = await import("./config.js");
      expect(resolveCrosspadCore()).toBeNull();
    });
  });

  describe("exported constants", () => {
    it("BIN_EXE has correct extension for platform", async () => {
      const { BIN_EXE, IS_WINDOWS } = await import("./config.js");
      if (IS_WINDOWS) {
        expect(BIN_EXE).toMatch(/\.exe$/);
      } else {
        expect(BIN_EXE).not.toMatch(/\.exe$/);
      }
    });

    it("CROSSPAD_IDF_ROOT defaults to ~/GIT/platform-idf", async () => {
      // Only if env var not set
      if (!process.env.CROSSPAD_IDF_ROOT) {
        const { CROSSPAD_IDF_ROOT } = await import("./config.js");
        expect(CROSSPAD_IDF_ROOT).toBe(path.join(HOME, "GIT", "platform-idf"));
      }
    });

    it("CROSSPAD_PC_ROOT defaults to ~/GIT/crosspad-pc", async () => {
      if (!process.env.CROSSPAD_PC_ROOT) {
        const { CROSSPAD_PC_ROOT } = await import("./config.js");
        expect(CROSSPAD_PC_ROOT).toBe(path.join(HOME, "GIT", "crosspad-pc"));
      }
    });
  });
});
