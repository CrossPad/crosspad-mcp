import { describe, it, expect } from "vitest";
import { buildUiUrl, originIsLoopback } from "./trace-webui.js";

describe("buildUiUrl", () => {
  it("builds a localhost URL for a port", () => {
    expect(buildUiUrl(7373)).toBe("http://localhost:7373/");
  });
});

describe("originIsLoopback", () => {
  it("allows requests with no Origin header (non-browser clients)", () => {
    expect(originIsLoopback({})).toBe(true);
  });
  it("allows loopback origins", () => {
    expect(originIsLoopback({ origin: "http://localhost:7373" })).toBe(true);
    expect(originIsLoopback({ origin: "http://127.0.0.1:5000" })).toBe(true);
  });
  it("rejects cross-site origins", () => {
    expect(originIsLoopback({ origin: "https://evil.example.com" })).toBe(false);
    expect(originIsLoopback({ origin: "http://192.168.1.50" })).toBe(false);
  });
  it("rejects a malformed origin", () => {
    expect(originIsLoopback({ origin: "not a url" })).toBe(false);
  });
});
