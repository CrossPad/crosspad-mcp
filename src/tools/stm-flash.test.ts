import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { stmFlashArgv, resolveProgrammer } from "./stm-flash.js";
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
    it("dfu: USB1 program + start at flash origin", () => {
      const argv = stmFlashArgv("dfu", "/tmp/fw.bin");
      expect(argv).toEqual([
        "-c", "port=USB1",
        "-w", "/tmp/fw.bin", STM_FLASH_ADDR,
        "-s", STM_FLASH_ADDR,
      ]);
    });
    it("never wraps the firmware path in a shell — it is a bare argv element", () => {
      const argv = stmFlashArgv("swd", "/path with spaces/fw.bin");
      expect(argv).toContain("/path with spaces/fw.bin");
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
