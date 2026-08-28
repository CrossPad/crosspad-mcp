import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { stmFlashArgv, resolveProgrammer, prepareDfuSplit, DFU_HEAD_SIZE } from "./stm-flash.js";
import { _setConfigPathForTest } from "../utils/userConfig.js";
import { STM_FLASH_ADDR } from "../config.js";

describe("stm-flash", () => {
  describe("stmFlashArgv", () => {
    it("swd: ST-Link program + verify + reset to flash origin", () => {
      const argv = stmFlashArgv("swd", "/tmp/fw.bin");
      expect(argv).toEqual([
        "-c", "port=SWD", "freq=4000",
        "-w", "/tmp/fw.bin", STM_FLASH_ADDR,
        "-rst", "--start", STM_FLASH_ADDR,
      ]);
    });
    it("dfu without split: USB1 program + start at flash origin", () => {
      const argv = stmFlashArgv("dfu", "/tmp/fw.bin");
      expect(argv).toEqual([
        "-c", "port=USB1",
        "-w", "/tmp/fw.bin", STM_FLASH_ADDR,
        "-s", STM_FLASH_ADDR,
      ]);
    });
    it("dfu with split: erase page 0, tail first, head last, then start", () => {
      const argv = stmFlashArgv("dfu", "/tmp/fw.bin", { head: "/tmp/fw.bin.dfu_head", tail: "/tmp/fw.bin.dfu_tail" });
      expect(argv).toEqual([
        "-c", "port=USB1",
        "-e", "[0 0]",
        "-w", "/tmp/fw.bin.dfu_tail", "0x08000800",
        "-w", "/tmp/fw.bin.dfu_head", STM_FLASH_ADDR,
        "-s", STM_FLASH_ADDR,
      ]);
    });
    it("never wraps the firmware path in a shell — it is a bare argv element", () => {
      const argv = stmFlashArgv("swd", "/path with spaces/fw.bin");
      expect(argv).toContain("/path with spaces/fw.bin");
    });
  });

  describe("prepareDfuSplit", () => {
    let tmpDir: string;
    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("splits at the first flash page and preserves the byte stream", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfu-split-test-"));
      const bin = path.join(tmpDir, "fw.bin");
      const data = Buffer.alloc(DFU_HEAD_SIZE + 100);
      for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
      fs.writeFileSync(bin, data);
      const split = prepareDfuSplit(bin);
      expect(split).not.toBeNull();
      const head = fs.readFileSync(split!.head);
      const tail = fs.readFileSync(split!.tail);
      expect(head.length).toBe(DFU_HEAD_SIZE);
      expect(tail.length).toBe(100);
      expect(Buffer.concat([head, tail]).equals(data)).toBe(true);
    });

    it("returns null for a bin that fits one page", () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfu-split-test-"));
      const bin = path.join(tmpDir, "fw.bin");
      fs.writeFileSync(bin, Buffer.alloc(DFU_HEAD_SIZE));
      expect(prepareDfuSplit(bin)).toBeNull();
    });
  });

  describe("resolveProgrammer", () => {
    const savedEnv = process.env.STM32_PROG;
    let tmpDir: string;
    let cfgPath: string;
    let fakeCli: string;

    afterEach(() => {
      _setConfigPathForTest(null);
      if (savedEnv === undefined) delete process.env.STM32_PROG;
      else process.env.STM32_PROG = savedEnv;
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function setup(): void {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stm-flash-test-"));
      cfgPath = path.join(tmpDir, "config.json");
      fakeCli = path.join(tmpDir, "STM32_Programmer_CLI");
      fs.writeFileSync(fakeCli, "#!/bin/sh\n");
    }

    it("prefers the config value when the file exists", () => {
      setup();
      fs.writeFileSync(cfgPath, JSON.stringify({ stm_programmer_cli: fakeCli }));
      _setConfigPathForTest(cfgPath);
      delete process.env.STM32_PROG;
      expect(resolveProgrammer()).toBe(fakeCli);
    });

    it("ignores a config value that points at a missing file, falls back to env", () => {
      setup();
      fs.writeFileSync(cfgPath, JSON.stringify({ stm_programmer_cli: path.join(tmpDir, "gone") }));
      _setConfigPathForTest(cfgPath);
      process.env.STM32_PROG = fakeCli;
      expect(resolveProgrammer()).toBe(fakeCli);
    });

    it("uses $STM32_PROG when no config value is set", () => {
      setup();
      fs.writeFileSync(cfgPath, JSON.stringify({}));
      _setConfigPathForTest(cfgPath);
      process.env.STM32_PROG = fakeCli;
      expect(resolveProgrammer()).toBe(fakeCli);
    });
  });
});
