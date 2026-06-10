import { describe, it, expect } from "vitest";
import { parseDeviceState } from "./trace-device.js";

describe("parseDeviceState", () => {
  it("parses a device_state JSON line", () => {
    const out = JSON.stringify({ type: "device_state", regs: { RCC_CR: 256 }, decoded: { SLEEPDEEP: false, interpretation: "run/sleep" }, accessible: true });
    const r = parseDeviceState(out);
    expect(r.success).toBe(true);
    expect(r.decoded?.interpretation).toBe("run/sleep");
    expect(r.accessible).toBe(true);
  });
  it("ignores stderr log noise and finds the JSON", () => {
    const out = "connecting...\nconnected\n" + JSON.stringify({ type: "device_state", regs: {}, decoded: {}, accessible: true });
    expect(parseDeviceState(out).success).toBe(true);
  });
  it("returns success=false on non-JSON output", () => {
    const r = parseDeviceState("Traceback: could not connect");
    expect(r.success).toBe(false);
    expect(r.error).toContain("could not connect");
  });
});
