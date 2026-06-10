import { describe, it, expect } from "vitest";
import { parseDeviceState } from "./trace-device.js";

describe("parseDeviceState", () => {
  it("parses a valid device_state JSON line", () => {
    const out = JSON.stringify({ type: "device_state", regs: { RCC_CR: 256 }, decoded: { SLEEPDEEP: false, interpretation: "run/sleep" }, accessible: true });
    const r = parseDeviceState(out);
    expect(r.success).toBe(true);
    expect(r.decoded?.interpretation).toBe("run/sleep");
    expect(r.regs?.RCC_CR).toBe(256);
  });
  it("ignores stderr noise and finds the JSON line", () => {
    const out = "connecting...\n" + JSON.stringify({ type: "device_state", regs: {}, decoded: {}, accessible: true });
    expect(parseDeviceState(out).success).toBe(true);
  });
  it("returns success=false on non-JSON output", () => {
    const r = parseDeviceState("Traceback: some error");
    expect(r.success).toBe(false);
    expect(r.error).toContain("error");
  });
});
