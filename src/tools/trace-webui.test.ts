import { describe, it, expect } from "vitest";
import { buildUiUrl } from "./trace-webui.js";

describe("buildUiUrl", () => {
  it("builds a localhost URL for a port", () => {
    expect(buildUiUrl(7373)).toBe("http://localhost:7373/");
  });
});
