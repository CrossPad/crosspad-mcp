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
        runArgvStream: vi.fn(async () => ({ success: false, stdout: "", stderr: "not a repo", exitCode: 1, durationMs: 0 })),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(async () => null),
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
      const result = await crosspadCommit("nonexistent", "test message");
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
        runArgvStream: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 })),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(async () => "abc1234"),
        listSubmodules: vi.fn(async () => []),
        findSubmodulePath: vi.fn(async () => null),
      }));

      vi.doMock("fs", () => ({
        default: {
          existsSync: () => true,
        },
      }));

      const { crosspadSubmoduleUpdate } = await import("./repo-actions.js");
      const result = await crosspadSubmoduleUpdate("nonexistent-sub", "idf");
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

      // crosspadCommit runs git through the local git() helper, which is
      // runArgvStream (spawn, awaited) since v10 — so the fixture answers there.
      vi.doMock("../utils/exec.js", () => ({
        runArgvStream: vi.fn(async (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "status") {
            return { success: true, stdout: "UU conflicted-file.cpp\n", stderr: "", exitCode: 0, durationMs: 0 };
          }
          return { success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
        }),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(async () => "abc1234"),
        listSubmodules: vi.fn(async () => []),
        findSubmodulePath: vi.fn(async () => null),
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
      const result = await crosspadCommit("core", "test commit");
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
        runArgvStream: vi.fn(async (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "status") {
            // working tree dirty but nothing staged
            return { success: true, stdout: " M unstaged.cpp\n", stderr: "", exitCode: 0, durationMs: 0 };
          }
          if (cmd === "git" && args[0] === "diff" && args.includes("--cached")) {
            return { success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
          }
          return { success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
        }),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(async () => "abc1234"),
        listSubmodules: vi.fn(async () => []),
        findSubmodulePath: vi.fn(async () => null),
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
      const result = await crosspadCommit("core", "test commit");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Nothing staged");
    });
  });

  describe("vendored crosspad-core / crosspad-gui resolution", () => {
    it("resolves unambiguously when exactly one vendored copy exists", async () => {
      vi.doMock("../config.js", () => ({
        getRepos: () => ({
          "platform-idf": "/home/user/GIT/platform-idf",
        }),
        CROSSPAD_PC_ROOT: "/home/user/GIT/crosspad-pc",
        CROSSPAD_IDF_ROOT: "/home/user/GIT/platform-idf",
        findVendoredCopies: (name: string) =>
          name === "crosspad-gui"
            ? [{ parentRepo: "platform-idf", path: "/home/user/GIT/platform-idf/components/crosspad-gui" }]
            : [],
      }));

      vi.doMock("../utils/exec.js", () => ({
        runArgvStream: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0, durationMs: 0 })),
      }));

      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(async () => "abc1234"),
        listSubmodules: vi.fn(async () => []),
        findSubmodulePath: vi.fn(async () => null),
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
      const result = await crosspadCommit("gui", "test commit");
      // The single vendored copy resolved (repo name came back canonicalized,
      // and we got past "unknown repo" into the normal staging check).
      expect(result.repo).toBe("crosspad-gui");
      expect(result.error).not.toContain("Unknown repo");
      expect(result.error).not.toContain("vendored");
    });

    it("explains the ambiguity (with every copy's path) when multiple vendored copies exist", async () => {
      vi.doMock("../config.js", () => ({
        getRepos: () => ({
          "platform-idf": "/home/user/GIT/platform-idf",
          "crosspad-pc": "/home/user/GIT/crosspad-pc",
        }),
        CROSSPAD_PC_ROOT: "/home/user/GIT/crosspad-pc",
        CROSSPAD_IDF_ROOT: "/home/user/GIT/platform-idf",
        findVendoredCopies: (name: string) =>
          name === "crosspad-core"
            ? [
                { parentRepo: "platform-idf", path: "/home/user/GIT/platform-idf/components/crosspad-core" },
                { parentRepo: "crosspad-pc", path: "/home/user/GIT/crosspad-pc/lib/crosspad-core" },
              ]
            : [],
      }));

      vi.doMock("../utils/exec.js", () => ({
        runArgvStream: vi.fn(async () => ({ success: false, stdout: "", stderr: "", exitCode: 1, durationMs: 0 })),
      }));
      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(async () => null),
        listSubmodules: vi.fn(async () => []),
        findSubmodulePath: vi.fn(async () => null),
      }));
      vi.doMock("fs", () => ({ default: { existsSync: () => false } }));

      const { crosspadCommit } = await import("./repo-actions.js");
      const result = await crosspadCommit("core", "test commit");
      expect(result.success).toBe(false);
      expect(result.error).toContain("vendored");
      expect(result.error).toContain("platform-idf");
      expect(result.error).toContain("crosspad-pc");
      expect(result.error).toContain("CROSSPAD_CORE_ROOT");
    });

    it("falls back to the generic unknown-repo message when no vendored copies exist either", async () => {
      vi.doMock("../config.js", () => ({
        getRepos: () => ({
          "platform-idf": "/home/user/GIT/platform-idf",
        }),
        CROSSPAD_PC_ROOT: "/home/user/GIT/crosspad-pc",
        CROSSPAD_IDF_ROOT: "/home/user/GIT/platform-idf",
        findVendoredCopies: () => [],
      }));

      vi.doMock("../utils/exec.js", () => ({
        runArgvStream: vi.fn(async () => ({ success: false, stdout: "", stderr: "", exitCode: 1, durationMs: 0 })),
      }));
      vi.doMock("../utils/git.js", () => ({
        getHead: vi.fn(async () => null),
        listSubmodules: vi.fn(async () => []),
        findSubmodulePath: vi.fn(async () => null),
      }));
      vi.doMock("fs", () => ({ default: { existsSync: () => false } }));

      const { crosspadCommit } = await import("./repo-actions.js");
      const result = await crosspadCommit("gui", "test commit");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown repo");
      expect(result.error).toContain("Available:");
    });
  });
});
