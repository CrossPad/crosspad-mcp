import { describe, it, expect, vi, beforeEach } from "vitest";

describe("device discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  describe("findCrosspadPort", () => {
    it("returns specified port directly when provided", async () => {
      // Mock listDevices to not be called
      vi.doMock("../config.js", () => ({
        IS_WINDOWS: false,
        IS_MAC: false,
      }));

      const { findCrosspadPort } = await import("./device.js");
      const result = findCrosspadPort("/dev/ttyACM0");
      expect(result.port).toBe("/dev/ttyACM0");
      expect(result.error).toBeUndefined();
    });

    it("returns error when no devices found and no port specified", async () => {
      vi.doMock("../config.js", () => ({
        IS_WINDOWS: false,
        IS_MAC: false,
      }));

      // Mock child_process to simulate no pyserial
      vi.doMock("child_process", () => ({
        execSync: vi.fn(() => { throw new Error("no pyserial"); }),
      }));

      // Mock fs for Linux sysfs fallback with no tty devices
      vi.doMock("fs", () => ({
        default: {
          existsSync: () => false,
          readdirSync: () => [],
          readFileSync: vi.fn(),
          realpathSync: vi.fn(),
          lstatSync: vi.fn(),
        },
        existsSync: () => false,
        readdirSync: () => [],
      }));

      const { findCrosspadPort } = await import("./device.js");
      const result = findCrosspadPort();
      expect(result.port).toBe("");
      expect(result.error).toContain("No CrossPad device found");
    });
  });

  describe("listDevices result structure", () => {
    it("returns DeviceListResult with correct shape", async () => {
      vi.doMock("../config.js", () => ({
        IS_WINDOWS: false,
        IS_MAC: false,
      }));

      // Mock everything to return empty
      vi.doMock("child_process", () => ({
        execSync: vi.fn(() => { throw new Error("no python"); }),
      }));
      vi.doMock("fs", () => ({
        default: {
          existsSync: () => false,
          readdirSync: () => [],
          readFileSync: vi.fn(),
          realpathSync: vi.fn(),
          lstatSync: vi.fn(),
        },
      }));

      const { listDevices } = await import("./device.js");
      const result = listDevices();
      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("devices");
      expect(result).toHaveProperty("all_ports");
      expect(Array.isArray(result.devices)).toBe(true);
      expect(Array.isArray(result.all_ports)).toBe(true);
    });
  });
});
