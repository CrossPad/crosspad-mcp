import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { findPortOwnerPids } from "./port-owner.js";

const linuxIt = process.platform === "linux" ? it : it.skip;

describe("findPortOwnerPids", () => {
  let child: ChildProcess | undefined;
  afterEach(() => { child?.kill(); child = undefined; });

  /** A process of its own that listens on an ephemeral port and prints it. */
  function listener(): Promise<number> {
    child = spawn(process.execPath, [
      "-e",
      "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port));setInterval(()=>{},1e6)",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    return new Promise((resolve) => child!.stdout!.once("data", (d) => resolve(parseInt(String(d), 10))));
  }

  linuxIt("finds the process that listens, and only that one", async () => {
    const port = await listener();
    expect(findPortOwnerPids(port)).toEqual([child!.pid]);
  });

  linuxIt("finds nobody on a port nothing listens on", async () => {
    const port = await listener();
    child!.kill();
    await new Promise((r) => child!.once("exit", r));
    expect(findPortOwnerPids(port)).toEqual([]);
  });
});
