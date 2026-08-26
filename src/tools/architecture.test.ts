// The merge is a front door, not a reimplementation: what these tests care
// about is that each action reaches the right v9 code path and that a bad
// action comes back as an error instead of an empty success.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const coreDir = fs.mkdtempSync(path.join(os.tmpdir(), "crosspad-arch-"));
const includeDir = path.join(coreDir, "include", "crosspad", "platform");
fs.mkdirSync(includeDir, { recursive: true });
fs.writeFileSync(path.join(includeDir, "IClock.hpp"), "class IClock {\npublic:\n  virtual ~IClock() = default;\n};\n");
fs.writeFileSync(
  path.join(includeDir, "PlatformCapabilities.hpp"),
  "enum class Capability {\n  None = 0,\n  Midi = 1,\n  AudioOut = 2,\n};\n",
);

// getRepos() and resolveCrosspadCore() cache at first call and scan the real
// machine; a fixture on disk is the only way to assert on their output.
vi.mock(import("../config.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getRepos: () => ({}),
  resolveCrosspadCore: () => coreDir,
}));

const { registerArchitectureTool, runArchitecture, ArchitectureInput } = await import("./architecture.js");
const { fakeServer, fakeExtra } = await import("../testing/fake-server.js");

afterAll(() => fs.rmSync(coreDir, { recursive: true, force: true }));

describe("runArchitecture dispatch", () => {
  it("action=interfaces lists the crosspad-core interfaces", async () => {
    const out = await runArchitecture({ action: "interfaces" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.interfaces).toEqual([expect.objectContaining({ name: "IClock" })]);
  });

  it("action=implementations reports where the interface is declared", async () => {
    const out = await runArchitecture({ action: "implementations", interface_name: "IClock" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.interface).toBe("IClock");
    expect(String(out.result.defined_in)).toContain("IClock.hpp");
    expect(out.result.implementations).toEqual([]);
  });

  it("action=capabilities reads the Capability enum, skipping None/All", async () => {
    const out = await runArchitecture({ action: "capabilities" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.flags).toEqual(["Midi", "AudioOut"]);
    expect(out.result.platforms).toEqual({});
  });

  it("an unknown action is an error, not an empty result", async () => {
    const out = await runArchitecture({ action: "interface" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain("unknown action");
    expect(out.message).toContain("implementations");
  });

  it("action=implementations without interface_name says which field is missing", async () => {
    const out = await runArchitecture({ action: "implementations" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain("interface_name");
  });
});

describe("ArchitectureInput", () => {
  it("accepts the three actions and rejects anything else", () => {
    expect(ArchitectureInput.safeParse({ action: "interfaces" }).success).toBe(true);
    expect(ArchitectureInput.safeParse({ action: "capabilities" }).success).toBe(true);
    expect(ArchitectureInput.safeParse({ action: "implementations", interface_name: "IClock" }).success).toBe(true);
    expect(ArchitectureInput.safeParse({ action: "interface" }).success).toBe(false);
  });

  it("rejects an interface name that is not I + PascalCase", () => {
    expect(ArchitectureInput.safeParse({ action: "implementations", interface_name: "Clock" }).success).toBe(false);
    expect(ArchitectureInput.safeParse({ action: "implementations", interface_name: "iClock" }).success).toBe(false);
  });
});

describe("crosspad_architecture tool", () => {
  function mk() {
    const fake = fakeServer();
    registerArchitectureTool(fake.server, {} as never);
    const tool = fake.tools.get("crosspad_architecture")!;
    return { tool, call: (args: unknown) => tool.cb(args, fakeExtra()) };
  }

  it("registers as read-only", () => {
    expect(mk().tool.config.annotations.readOnlyHint).toBe(true);
  });

  it("returns the payload under `result` rather than spread into the envelope", async () => {
    const res = await mk().call({ action: "interfaces" });
    expect(res.structuredContent.success).toBe(true);
    expect(res.structuredContent.action).toBe("interfaces");
    expect((res.structuredContent.result as Record<string, unknown>).interfaces).toHaveLength(1);
    expect(res.structuredContent.interfaces).toBeUndefined();
  });

  it("an action outside the enum never reaches the handler", async () => {
    // The SDK validates input against the declared schema before the handler
    // runs, so this is rejected at the protocol edge — asserting the handler's
    // own INVALID_ARGS branch here would be asserting an unreachable path.
    await expect(mk().call({ action: "nope" })).rejects.toThrow();
  });

  it("implementations without interface_name is INVALID_ARGS", async () => {
    const res = await mk().call({ action: "implementations" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent.error as { message: string }).message).toContain("interface_name");
  });
});
