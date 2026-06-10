// src/tools/trace-doctor.test.ts
import { describe, it, expect } from "vitest";
import { runDoctor, type DoctorProbe, realProbe } from "./trace-doctor.js";

function probe(over: Partial<DoctorProbe>): DoctorProbe {
  return {
    pyocdInstalled: () => true,
    elfPath: () => "/fw/build/Debug/CrossPad_STM32_r20.elf",
    elfExists: () => true,
    stlinkProbe: () => ({ found: true, serial: "ABC", chipid: "0x467" }),
    udevRulesPresent: () => true,
    configKeysSet: () => ["stm_elf_path"],
    ...over,
  };
}

describe("runDoctor", () => {
  it("reports no issues when everything is present", () => {
    const r = runDoctor(probe({}));
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("flags missing pyocd as blocking with a pip fix", () => {
    const r = runDoctor(probe({ pyocdInstalled: () => false }));
    const i = r.issues.find((x) => x.id === "pyocd_missing");
    expect(i?.severity).toBe("blocking");
    expect(i?.suggested_fix).toContain("pip install pyocd");
    expect(r.ok).toBe(false);
  });

  it("flags missing ELF as blocking", () => {
    const r = runDoctor(probe({ elfExists: () => false }));
    expect(r.issues.find((x) => x.id === "elf_missing")?.severity).toBe("blocking");
  });

  it("flags missing probe as blocking", () => {
    const r = runDoctor(probe({ stlinkProbe: () => ({ found: false }) }));
    expect(r.issues.find((x) => x.id === "probe_missing")?.severity).toBe("blocking");
  });

  it("flags missing udev rules as warning (not blocking)", () => {
    const r = runDoctor(probe({ udevRulesPresent: () => false }));
    const i = r.issues.find((x) => x.id === "udev_missing");
    expect(i?.severity).toBe("warning");
    expect(i?.suggested_fix).toContain("udevadm");
    expect(r.ok).toBe(true); // warnings don't block
  });

  it("reports config keys still on defaults as info", () => {
    const r = runDoctor(probe({ configKeysSet: () => [] }));
    expect(r.issues.find((x) => x.id === "config_defaults")?.severity).toBe("info");
  });
});

describe("realProbe", () => {
  it("constructs a probe with all methods callable", () => {
    const p = realProbe();
    expect(typeof p.pyocdInstalled).toBe("function");
    expect(typeof p.elfPath()).toBe("string");
    // stlinkProbe must not throw even if st-info is absent
    expect(() => p.stlinkProbe()).not.toThrow();
  });
});
