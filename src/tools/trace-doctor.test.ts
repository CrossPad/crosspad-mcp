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
    // §11.7: default to a probe being present + tool available.
    probeList: async () => ({ present: true, toolAvailable: true }),
    ...over,
  };
}

describe("runDoctor", () => {
  it("reports no issues when everything is present", async () => {
    const r = await runDoctor(probe({}));
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("flags missing pyocd as blocking with a pip fix", async () => {
    const r = await runDoctor(probe({ pyocdInstalled: () => false }));
    const i = r.issues.find((x) => x.id === "pyocd_missing");
    expect(i?.severity).toBe("blocking");
    expect(i?.suggested_fix).toContain("pip install pyocd");
    expect(r.ok).toBe(false);
  });

  it("flags missing ELF as blocking", async () => {
    const r = await runDoctor(probe({ elfExists: () => false }));
    expect(r.issues.find((x) => x.id === "elf_missing")?.severity).toBe("blocking");
  });

  it("flags missing probe as blocking when no probeList check is wired", async () => {
    const r = await runDoctor(probe({ stlinkProbe: () => ({ found: false }), probeList: undefined }));
    expect(r.issues.find((x) => x.id === "probe_missing")?.severity).toBe("blocking");
    expect(r.ok).toBe(false);
  });

  it("does NOT block on st-info absence when pyocd probeList sees the probe", async () => {
    // §11.7: st-info found:false can simply mean st-info isn't installed; the
    // authoritative probeList (pyocd list) owns presence. No false probe_missing.
    const r = await runDoctor(probe({
      stlinkProbe: () => ({ found: false }),
      probeList: async () => ({ present: true, toolAvailable: true }),
    }));
    expect(r.issues.find((x) => x.id === "probe_missing")).toBeUndefined();
    expect(r.issues.find((x) => x.id === "no_probe_detected")).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("flags missing udev rules as warning (not blocking)", async () => {
    const r = await runDoctor(probe({ udevRulesPresent: () => false }));
    const i = r.issues.find((x) => x.id === "udev_missing");
    expect(i?.severity).toBe("warning");
    expect(i?.suggested_fix).toContain("udevadm");
    expect(r.ok).toBe(true); // warnings don't block
  });

  it("reports config keys still on defaults as info", async () => {
    const r = await runDoctor(probe({ configKeysSet: () => [] }));
    expect(r.issues.find((x) => x.id === "config_defaults")?.severity).toBe("info");
  });
});

describe("runDoctor probe-presence (§11.7)", () => {
  it("raises a blocking no_probe_detected when the probe list is empty", async () => {
    const r = await runDoctor(probe({ probeList: async () => ({ present: false, toolAvailable: true }) }));
    const i = r.issues.find((x) => x.id === "no_probe_detected");
    expect(i).toBeDefined();
    expect(i?.severity).toBe("error");
    expect(i?.detail).toContain("No ST-Link detected");
    expect(i?.suggested_fix).toContain("pyocd list");
    expect(r.ok).toBe(false); // "error" blocks just like "blocking"
  });

  it("does NOT flag no_probe_detected when a probe is listed", async () => {
    const r = await runDoctor(probe({ probeList: async () => ({ present: true, toolAvailable: true }) }));
    expect(r.issues.find((x) => x.id === "no_probe_detected")).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("treats a missing detection tool as a non-fatal info note, not a false 'no probe'", async () => {
    const r = await runDoctor(probe({ probeList: async () => ({ present: false, toolAvailable: false }) }));
    expect(r.issues.find((x) => x.id === "no_probe_detected")).toBeUndefined();
    const note = r.issues.find((x) => x.id === "probe_list_tool_missing");
    expect(note?.severity).toBe("info");
    expect(r.ok).toBe(true); // info doesn't block
  });

  it("skips the presence check entirely when no probeList is wired (back-compat)", async () => {
    const r = await runDoctor(probe({ probeList: undefined }));
    expect(r.issues.find((x) => x.id === "no_probe_detected")).toBeUndefined();
    expect(r.issues.find((x) => x.id === "probe_list_tool_missing")).toBeUndefined();
  });
});

describe("realProbe", () => {
  it("constructs a probe with all methods callable", async () => {
    const p = realProbe();
    expect(typeof p.pyocdInstalled).toBe("function");
    expect(typeof p.elfPath()).toBe("string");
    // stlinkProbe must not throw even if st-info is absent
    expect(() => p.stlinkProbe()).not.toThrow();
    // §11.7: probeList is wired and must resolve (never throw) even with no
    // pyocd/st-info installed — it reports {toolAvailable:false} instead.
    expect(typeof p.probeList).toBe("function");
    await expect(p.probeList!()).resolves.toMatchObject({
      present: expect.any(Boolean),
      toolAvailable: expect.any(Boolean),
    });
  });
});
