import { describe, it, expect, vi } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn((_cmd: string, _argv: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
    cb(null, JSON.stringify({ rev: "v2", source: "device", build_dir: "build_v2", sdkconfig: "sdkconfig.v2" }))),
}));

import { execFile } from "child_process";
import { resolveBoard } from "./board.js";

const argvOf = (call: number) => vi.mocked(execFile).mock.calls[call][1] as unknown as string[];

describe("resolveBoard", () => {
  it("passes --board and --device through to the resolver", async () => {
    const d = await resolveBoard(undefined, "dev_31ea");
    expect(d.build_dir).toBe("build_v2");
    expect(argvOf(0)).toEqual(expect.arrayContaining(["--json", "--device", "dev_31ea"]));
    expect(argvOf(0)).not.toContain("--board");
    await resolveBoard("v1");
    expect(argvOf(1)).toEqual(expect.arrayContaining(["--board", "v1"]));
    expect(argvOf(1)).not.toContain("--device");
  });
});
