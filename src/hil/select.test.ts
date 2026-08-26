import { describe, it, expect } from "vitest";
import { HilError } from "./daemon.js";
import { listHilDevices, pickDevice, espSide, portPaths, roleOfPort } from "./select.js";

function port(path: string, vid = 0x303a, pid = 0x3456) {
  return { path, vid, pid, serial: null, product: null, location: "1-1.2" };
}

const ESP = {
  id: "dev_3f2a",
  serial: "AABB",
  usb_mode: "default" as const,
  ports: { cdc: port("/dev/ttyACM0"), console: port("/dev/ttyACM1", 0x0483, 0x5740), esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
  board_rev: "v2",
};
const CONSOLE_ONLY = {
  id: "dev_9911",
  serial: "CCDD",
  usb_mode: "unknown" as const,
  ports: { cdc: null, console: port("/dev/ttyACM3", 0x0483, 0x5740), esp_midi: null, stm_midi: null, uac2: null, bootloader: null },
  board_rev: null,
};

describe("listHilDevices", () => {
  it("calls devices.list and parses every row", async () => {
    const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
    const daemon = {
      async request<T>(op: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ op, args });
        return { devices: [ESP, CONSOLE_ONLY] } as unknown as T;
      },
    };
    const rows = await listHilDevices(daemon);
    expect(calls).toEqual([{ op: "devices.list", args: {} }]);
    expect(rows.map((d) => d.id)).toEqual(["dev_3f2a", "dev_9911"]);
    expect(rows[0].board_rev).toBe("v2");
  });
});

describe("pickDevice", () => {
  it("with no argument picks the only device that has an ESP side", () => {
    expect(pickDevice([ESP, CONSOLE_ONLY]).id).toBe("dev_3f2a");
  });

  it("raises NO_DEVICE when nothing has an ESP side", () => {
    try {
      pickDevice([CONSOLE_ONLY]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(HilError);
      expect((e as HilError).code).toBe("NO_DEVICE");
      expect((e as HilError).message).toMatch(/bootloader/i);
    }
  });

  it("raises AMBIGUOUS_DEVICE with the candidate ids", () => {
    const second = { ...ESP, id: "dev_7c01" };
    try {
      pickDevice([ESP, second]);
      expect.unreachable("should have thrown");
    } catch (e) {
      const h = e as HilError;
      expect(h.code).toBe("AMBIGUOUS_DEVICE");
      expect(h.hint).toContain("device=");
      expect(h.details.candidates).toEqual(["dev_3f2a", "dev_7c01"]);
    }
  });

  it("matches by id and by any port path", () => {
    expect(pickDevice([ESP, CONSOLE_ONLY], "dev_9911").id).toBe("dev_9911");
    expect(pickDevice([ESP, CONSOLE_ONLY], "/dev/ttyACM3").id).toBe("dev_9911");
    expect(pickDevice([ESP, CONSOLE_ONLY], "/dev/ttyACM1").id).toBe("dev_3f2a");
  });

  it("an unknown id is NO_DEVICE and lists what is there", () => {
    try {
      pickDevice([ESP], "dev_beef");
      expect.unreachable("should have thrown");
    } catch (e) {
      const h = e as HilError;
      expect(h.code).toBe("NO_DEVICE");
      expect(h.details.candidates).toEqual(["dev_3f2a"]);
    }
  });
});

describe("port roles", () => {
  it("espSide is true only when a cdc or bootloader port exists", () => {
    expect(espSide(ESP)).toBe(true);
    expect(espSide(CONSOLE_ONLY)).toBe(false);
  });

  it("portPaths lists cdc, console and bootloader with their roles", () => {
    expect(portPaths(ESP)).toEqual([
      { role: "cdc", path: "/dev/ttyACM0" },
      { role: "console", path: "/dev/ttyACM1" },
    ]);
  });

  it("roleOfPort names the role of a path, or null", () => {
    expect(roleOfPort(ESP, "/dev/ttyACM1")).toBe("console");
    expect(roleOfPort(ESP, "/dev/ttyACM0")).toBe("cdc");
    expect(roleOfPort(ESP, "/dev/ttyUSB9")).toBeNull();
  });
});
