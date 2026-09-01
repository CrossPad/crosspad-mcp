import { describe, it, expect } from "vitest";
import { espPreflight, stmPreflight, applyForce, normalizeRev, type FlashProbe } from "./flash.js";
import { HilError } from "../hil/daemon.js";

const port = (path: string, vid = 0x303a, pid = 0x3456) => ({ path, vid, pid, serial: null, product: null, location: "1-1.2" });

const DEV_V2 = {
  id: "dev_3f2a", serial: "AABB", usb_mode: "default" as const, board_rev: "v2",
  ports: { cdc: port("/dev/ttyACM0"), console: port("/dev/ttyACM1", 0x0483, 0x5740), esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
};
const DEV_BOOTLOADER = {
  id: "dev_3f2a", serial: "AABB", usb_mode: "bootloader" as const, board_rev: "v2",
  ports: { cdc: null, console: null, esp_midi: null, stm_midi: null, uac2: null, bootloader: port("/dev/ttyACM0", 0x303a, 0x1001) },
};

/** Probe over an in-memory file table. mtimes are ms since epoch. */
function probeFor(
  files: Record<string, number>,
  opts: { version?: string | null; newest?: { path: string; mtimeMs: number } | null; rev?: string | null;
          stmDesc?: { version: string; proto: number; pcb: number } | null } = {},
): FlashProbe {
  return {
    async exists(p) { return p in files; },
    async mtimeMs(p) { return files[p] ?? null; },
    async binVersion() { return opts.version ?? null; },
    async stmDescriptor() { return opts.stmDesc ?? null; },
    async newestSource() { return opts.newest ?? null; },
    async buildBoardRev() { return opts.rev ?? null; },
  };
}

const FW = "/idf/build/CrossPad.bin";
const BUILD = "/idf/build";

describe("normalizeRev", () => {
  it("folds every spelling the two sides use", () => {
    expect(normalizeRev("v2")).toBe("v2");
    expect(normalizeRev("V2")).toBe("v2");
    expect(normalizeRev("2.0")).toBe("v2");
    expect(normalizeRev("rev1")).toBe("v1");
    expect(normalizeRev("1.9")).toBe("v1");
    expect(normalizeRev(null)).toBeNull();
    expect(normalizeRev("v3")).toBeNull();
  });
});

describe("espPreflight", () => {
  it("passes on a fresh matching build and reports every field", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20-3f2a", newest: { path: "/idf/main/main.cpp", mtimeMs: 1000 }, rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.ok).toBe(true);
    expect(pf.blockers).toEqual([]);
    expect(pf).toMatchObject({
      target: "esp", device: "dev_3f2a", usb_mode: "default", transport: "ota",
      firmware_path: FW, firmware_exists: true, firmware_version: "v20-3f2a",
      stale: false, build_board_rev: "v2", device_board_rev: "v2", board_rev_match: true,
      bootloader_pid: false, port: "/dev/ttyACM0", port_role: "cdc",
    });
  });

  it("flags a firmware older than the newest source as stale, but does not block", async () => {
    const probe = probeFor({ [FW]: 1000, [BUILD]: 1000 }, { version: "v20-old", newest: { path: "/idf/components/bsp/crosspad/bsp_imu.cpp", mtimeMs: 5000 }, rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.stale).toBe(true);
    expect(pf.newest_source_path).toContain("bsp_imu.cpp");
    expect(pf.blockers).toEqual([]);
    expect(pf.warnings.join(" ")).toMatch(/older than/);
    expect(pf.ok).toBe(true);
  });

  it("blocks a missing firmware", async () => {
    const probe = probeFor({ [BUILD]: 1 }, { rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.ok).toBe(false);
    expect(pf.blockers.map((b) => b.code)).toEqual(["NO_FIRMWARE"]);
    expect(pf.blockers[0].message).toContain("crosspad_build platform=idf");
  });

  it("blocks a missing build directory", async () => {
    const probe = probeFor({}, {});
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "uart", firmware_path: FW, build_dir: BUILD });
    expect(pf.blockers.map((b) => b.code)).toContain("NO_BUILD_DIR");
  });

  it("refuses the STM console port and names its role", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "uart", port: "/dev/ttyACM1", firmware_path: FW, build_dir: BUILD });
    expect(pf.ok).toBe(false);
    const blocker = pf.blockers.find((b) => b.code === "PORT_ROLE")!;
    expect(blocker.message).toContain("/dev/ttyACM1");
    expect(blocker.message).toContain("console");
    expect(blocker.message).toContain("/dev/ttyACM0");
    expect(pf.port_role).toBe("console");
  });

  it("blocks a board-revision mismatch and says which is which", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v1" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.board_rev_match).toBe(false);
    const blocker = pf.blockers.find((b) => b.code === "BOARD_REV_MISMATCH")!;
    expect(blocker.message).toMatch(/v1/);
    expect(blocker.message).toMatch(/v2/);
  });

  it("warns rather than blocks when either revision is unknown", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: null });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD });
    expect(pf.board_rev_match).toBeNull();
    expect(pf.blockers).toEqual([]);
    expect(pf.warnings.join(" ")).toMatch(/revision/i);
  });

  it("reports a bootloader-PID port and does not warn about download mode", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = await espPreflight(probe, DEV_BOOTLOADER as never, { transport: "uart", firmware_path: FW, build_dir: BUILD });
    expect(pf.bootloader_pid).toBe(true);
    expect(pf.port_role).toBe("bootloader");
    expect(pf.warnings.join(" ")).not.toMatch(/download mode/i);
  });

  it("warns that UART needs download mode when no bootloader port is present", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = await espPreflight(probe, DEV_V2 as never, { transport: "uart", firmware_path: FW, build_dir: BUILD });
    expect(pf.warnings.join(" ")).toMatch(/download mode/i);
  });

  it("carries a device-resolution failure into the preflight instead of throwing", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = await espPreflight(probe, null, { transport: "ota", firmware_path: FW, build_dir: BUILD },
      new HilError("NO_DEVICE", "no CrossPad found; is it in bootloader/DFU?", "check the cable"));
    expect(pf.device).toBeNull();
    expect(pf.blockers.map((b) => b.code)).toContain("NO_DEVICE");
    expect(pf.firmware_exists).toBe(true);
  });
});

describe("applyForce", () => {
  it("downgrades every blocker except PORT_ROLE", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v1" });
    const pf = applyForce(await espPreflight(probe, DEV_V2 as never, { transport: "ota", firmware_path: FW, build_dir: BUILD }), true);
    expect(pf.ok).toBe(true);
    expect(pf.warnings.join(" ")).toMatch(/forced past/i);
  });

  it("never clears PORT_ROLE", async () => {
    const probe = probeFor({ [FW]: 2000, [BUILD]: 2000 }, { version: "v20", newest: null, rev: "v2" });
    const pf = applyForce(await espPreflight(probe, DEV_V2 as never, { transport: "uart", port: "/dev/ttyACM1", firmware_path: FW, build_dir: BUILD }), true);
    expect(pf.ok).toBe(false);
    expect(pf.blockers.map((b) => b.code)).toEqual(["PORT_ROLE"]);
  });
});

describe("stmPreflight", () => {
  it("checks the STM binary and marks the ESP-only fields null", async () => {
    const bin = "/stm/build/Debug/CrossPad_STM32_r20.bin";
    const pf = await stmPreflight(probeFor({ [bin]: 4000 }), { method: "swd", firmware_path: bin });
    expect(pf).toMatchObject({ target: "stm", firmware_exists: true, device: null, usb_mode: null, board_rev_match: null });
    expect(pf.ok).toBe(true);
    expect(pf.notes.join(" ")).toMatch(/ST-Link|STM32_Programmer_CLI/);
  });

  it("blocks a missing STM binary", async () => {
    const pf = await stmPreflight(probeFor({}), { method: "dfu" });
    expect(pf.ok).toBe(false);
    expect(pf.blockers.map((b) => b.code)).toEqual(["NO_FIRMWARE"]);
  });

  it("reports the version and board revision from the image's own descriptor", async () => {
    const bin = "/stm/build/Debug/CrossPad_STM32_r20.bin";
    const pf = await stmPreflight(
      probeFor({ [bin]: 4000 }, { stmDesc: { version: "1.4", proto: 0x000f, pcb: 20 } }),
      { method: "swd", firmware_path: bin },
    );
    expect(pf.firmware_version).toBe("1.4");
    expect(pf.build_board_rev).toBe("r20");
    expect(pf.notes.join(" ")).toMatch(/protocol 0x000f/);
    expect(pf.ok).toBe(true);
  });

  it("warns when the binary carries no CPFW descriptor", async () => {
    const bin = "/stm/build/Debug/not_a_crosspad_image.bin";
    const pf = await stmPreflight(probeFor({ [bin]: 4000 }, { stmDesc: null }),
                                  { method: "swd", firmware_path: bin });
    expect(pf.firmware_version).toBeNull();
    expect(pf.warnings.join(" ")).toMatch(/No CPFW descriptor/);
    expect(pf.ok).toBe(true);
  });
});
