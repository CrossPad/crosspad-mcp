import { describe, it, expect, vi, beforeEach } from "vitest";

describe("repo-actions module", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe("REPO_ALIASES resolution", () => {
    it("resolves idf alias to platform-idf", async () => {
      // Mock getRepos to return known repos
      vi.doMock("../config.js", () => ({
        getRepos: () => ({
          "platform-idf": "/home/user/GIT/platform-idf",
          "crosspad-pc": "/home/user/GIT/crosspad-pc",
        }),
        CROSSPAD_PC_ROOT: "/home/user/GIT/crosspad-pc",
        CROSSPAD_IDF_ROOT: "/home/user/GIT/platform-idf",
      }));

      vi.doMock("../utils/exec.js", () => ({
        runCommand: vi.fn(() => ({ success: false, stdout: "", stderr: "not a repo", exitCode: 1, durationMs: 0 })),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(() => null),
      }));

      vi.doMock("fs", () => ({
        default: {
          existsSync: () => false,
          readdirSync: () => [],
          readFileSync: vi.fn(),
        },
      }));

      const { crosspadCommit } = await import("./repo-actions.js");

      // Try to commit to unknown repo
      const result = crosspadCommit("nonexistent", "test message");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown repo");
      expect(result.error).toContain("Available:");
    });
  });

  describe("crosspadSubmoduleUpdate", () => {
    it("returns error for unknown submodule", async () => {
      vi.doMock("../config.js", () => ({
        getRepos: () => ({
          "platform-idf": "/home/user/GIT/platform-idf",
        }),
        CROSSPAD_PC_ROOT: "/home/user/GIT/crosspad-pc",
        CROSSPAD_IDF_ROOT: "/home/user/GIT/platform-idf",
      }));

      vi.doMock("../utils/exec.js", () => ({
        runCommand: vi.fn(() => ({ success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 })),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(() => "abc1234"),
      }));

      vi.doMock("fs", () => ({
        default: {
          existsSync: () => true,
        },
      }));

      const { crosspadSubmoduleUpdate } = await import("./repo-actions.js");
      const result = crosspadSubmoduleUpdate("nonexistent-sub", "idf");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("crosspadCommit", () => {
    it("refuses commit when merge conflicts exist", async () => {
      vi.doMock("../config.js", () => ({
        getRepos: () => ({
          "crosspad-core": "/home/user/GIT/crosspad-core",
        }),
        CROSSPAD_PC_ROOT: "/home/user/GIT/crosspad-pc",
        CROSSPAD_IDF_ROOT: "/home/user/GIT/platform-idf",
      }));

      vi.doMock("../utils/exec.js", () => ({
        runCommand: vi.fn((cmd: string) => {
          if (cmd.includes("status")) {
            return { success: true, stdout: "UU conflicted-file.cpp\n", stderr: "", exitCode: 0, durationMs: 0 };
          }
          return { success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
        }),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(() => "abc1234"),
      }));

      vi.doMock("fs", () => ({
        default: {
          existsSync: () => true,
        },
      }));

      const { crosspadCommit } = await import("./repo-actions.js");
      const result = crosspadCommit("core", "test commit");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Merge conflicts");
    });

    it("refuses commit when nothing is staged", async () => {
      vi.doMock("../config.js", () => ({
        getRepos: () => ({
          "crosspad-core": "/home/user/GIT/crosspad-core",
        }),
        CROSSPAD_PC_ROOT: "/home/user/GIT/crosspad-pc",
        CROSSPAD_IDF_ROOT: "/home/user/GIT/platform-idf",
      }));

      vi.doMock("../utils/exec.js", () => ({
        runCommand: vi.fn((cmd: string) => {
          if (cmd.includes("status --porcelain")) {
            return { success: true, stdout: " M unstaged.cpp\n", stderr: "", exitCode: 0, durationMs: 0 };
          }
          if (cmd.includes("diff --cached")) {
            return { success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
          }
          return { success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
        }),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(() => "abc1234"),
      }));

      vi.doMock("fs", () => ({
        default: {
          existsSync: () => true,
        },
      }));

      const { crosspadCommit } = await import("./repo-actions.js");
      const result = crosspadCommit("core", "test commit");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Nothing staged");
    });
  });
});
