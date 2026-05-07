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
        listSubmodules: vi.fn(() => []),
        findSubmodulePath: vi.fn(() => null),
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
        runCommand: vi.fn(() => ({ success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 })),
      }));

      // crosspadCommit uses spawnSync directly (via the local git() helper),
      // not runCommand — so we must mock child_process for the status check.
      vi.doMock("child_process", () => ({
        spawnSync: vi.fn((cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "status") {
            return { stdout: "UU conflicted-file.cpp\n", stderr: "", status: 0, signal: null, error: undefined, pid: 1, output: [] };
          }
          return { stdout: "", stderr: "", status: 0, signal: null, error: undefined, pid: 1, output: [] };
        }),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(() => "abc1234"),
        listSubmodules: vi.fn(() => []),
        findSubmodulePath: vi.fn(() => null),
      }));

      vi.doMock("fs", () => ({
        default: {
          existsSync: () => true,
          mkdtempSync: vi.fn(() => "/tmp/crosspad-mock"),
          writeFileSync: vi.fn(),
          rmSync: vi.fn(),
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
        runCommand: vi.fn(() => ({ success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 })),
      }));

      vi.doMock("child_process", () => ({
        spawnSync: vi.fn((cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "status") {
            // working tree dirty but nothing staged
            return { stdout: " M unstaged.cpp\n", stderr: "", status: 0, signal: null, error: undefined, pid: 1, output: [] };
          }
          if (cmd === "git" && args[0] === "diff" && args.includes("--cached")) {
            return { stdout: "", stderr: "", status: 0, signal: null, error: undefined, pid: 1, output: [] };
          }
          return { stdout: "", stderr: "", status: 0, signal: null, error: undefined, pid: 1, output: [] };
        }),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(() => "abc1234"),
        listSubmodules: vi.fn(() => []),
        findSubmodulePath: vi.fn(() => null),
      }));

      vi.doMock("fs", () => ({
        default: {
          existsSync: () => true,
          mkdtempSync: vi.fn(() => "/tmp/crosspad-mock"),
          writeFileSync: vi.fn(),
          rmSync: vi.fn(),
        },
      }));

      const { crosspadCommit } = await import("./repo-actions.js");
      const result = crosspadCommit("core", "test commit");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Nothing staged");
    });
  });
});
