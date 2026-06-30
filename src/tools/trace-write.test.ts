import { describe, it, expect } from "vitest";
import { buildWriteArgv, buildCallArgv, writeStdinCmd, callStdinCmd, parseResultFrame } from "./trace-write.js";

describe("trace-write helpers", () => {
  it("builds write subcommand argv joining specs with ';'", () => {
    expect(buildWriteArgv("/a.elf", ["@0x20000000=1", "s_x=2"]))
      .toEqual(["write", "--elf", "/a.elf", "--writes", "@0x20000000=1;s_x=2"]);
  });
  it("builds call argv with confirm flag and ret-type", () => {
    expect(buildCallArgv("/a.elf", "foo", [3, 0xff], true, "i32", 2))
      .toEqual(["call", "--elf", "/a.elf", "--func", "foo", "--args", "3,255",
                "--confirm", "--ret-type", "i32", "--timeout", "2"]);
  });
  it("omits --confirm when not confirmed", () => {
    expect(buildCallArgv("/a.elf", "foo", [], false, "u32", 2))
      .not.toContain("--confirm");
  });
  it("emits a single-line write stdin cmd", () => {
    const s = writeStdinCmd(7, ["@0x20000000=1"]);
    expect(s).not.toContain("\n");
    expect(JSON.parse(s)).toEqual({ cmd: "write", id: 7, writes: ["@0x20000000=1"] });
  });
  it("matches a result frame by id", () => {
    const line = JSON.stringify({ type: "write_result", id: 7, ok: true, results: [] });
    expect(parseResultFrame(line, 7)).toEqual({ match: true, frame: JSON.parse(line) });
    expect(parseResultFrame(line, 9).match).toBe(false);
    expect(parseResultFrame("{not json", 7).match).toBe(false);
  });
});
