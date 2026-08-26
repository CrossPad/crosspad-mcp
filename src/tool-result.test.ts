import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorSchema, errorResult } from "./tool-result.js";
import { HilError } from "./hil/daemon.js";

describe("ErrorSchema", () => {
  it("accepts the details a HilError carries, which a closed schema rejected", () => {
    // A path-allowlist refusal came back as "structured content does not match
    // the tool's output schema" rather than as the refusal, because every tool
    // declared {code, message, hint} while errorResult attaches details.
    const err = new HilError("PATH_NOT_ALLOWED", "outside the allowed roots",
      "set CROSSPAD_MCP_ALLOWED_PATHS", { path: "/etc/passwd", roots: ["/home/x/GIT"] });
    const built = (errorResult(err).structuredContent as { error: unknown }).error;

    expect(ErrorSchema.safeParse(built).success).toBe(true);
    const closed = z.object({
      code: z.string(), message: z.string(), hint: z.string().optional(),
    }).strict();
    expect(closed.safeParse(built).success).toBe(false);
  });

  it("still requires a code and a message", () => {
    expect(ErrorSchema.safeParse({ message: "no code" }).success).toBe(false);
    expect(ErrorSchema.safeParse({ code: "X", message: "m" }).success).toBe(true);
  });
});
