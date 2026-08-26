import { describe, it, expect } from "vitest";
import { z } from "zod";
import { fakeServer, fakeExtra, SchemaViolation } from "./fake-server.js";

/** Register one tool on a fresh fake and hand back its (wrapped) callback. */
function register(config: Record<string, unknown>, cb: (args: any, extra: any) => Promise<any>) {
  const h = fakeServer();
  h.server.registerTool("crosspad_probe" as never, config as never, cb as never);
  return h.tools.get("crosspad_probe")!.cb;
}

const textOf = (data: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

describe("fakeServer input validation", () => {
  it("hands the callback the parsed args, so declared defaults are applied", async () => {
    let seen: unknown;
    const cb = register(
      { inputSchema: { limit: z.number().int().default(30), name: z.string().optional() } },
      async (args) => { seen = args; return textOf({ success: true }); },
    );
    await cb({}, fakeExtra());
    expect(seen).toEqual({ limit: 30 });
  });

  it("refuses input the schema rejects, before the callback runs", async () => {
    let ran = false;
    const cb = register(
      { inputSchema: { action: z.enum(["a", "b"]) } },
      async () => { ran = true; return textOf({ success: true }); },
    );
    await expect(cb({ action: "nope" }, fakeExtra())).rejects.toThrow(/Input validation error/);
    expect(ran).toBe(false);
  });
});

describe("fakeServer output validation", () => {
  const outputSchema = { success: z.boolean(), count: z.number().int().optional() };

  it("accepts a result that matches the declared schema", async () => {
    const cb = register({ outputSchema }, async () => textOf({ success: true, count: 2 }));
    await expect(cb({}, fakeExtra())).resolves.toMatchObject({ structuredContent: { count: 2 } });
  });

  it("rejects a field of the wrong type", async () => {
    const cb = register({ outputSchema }, async () => textOf({ success: true, count: "two" }));
    await expect(cb({}, fakeExtra())).rejects.toThrow(/Output validation error/);
  });

  it("rejects a key the schema never declared", async () => {
    // The wire schema is additionalProperties:false, so this is what a real
    // client does with it — the reason the fake cannot just call zod and stop.
    const cb = register({ outputSchema }, async () => textOf({ success: true, kount: 2 }));
    await expect(cb({}, fakeExtra())).rejects.toThrow(SchemaViolation);
    await expect(cb({}, fakeExtra())).rejects.toThrow(/undeclared key\(s\) kount/);
  });

  it("rejects a declared outputSchema answered without structuredContent", async () => {
    const cb = register({ outputSchema }, async () => ({ content: [{ type: "text", text: "{}" }] }));
    await expect(cb({}, fakeExtra())).rejects.toThrow(/no structuredContent/);
  });

  it("skips validation for an isError result, as the SDK does", async () => {
    const cb = register({ outputSchema }, async () => ({ ...textOf({ success: false, error: "boom" }), isError: true }));
    await expect(cb({}, fakeExtra())).resolves.toMatchObject({ isError: true });
  });

  it("allows undeclared keys when the schema itself is open", async () => {
    // `z.looseObject` advertises additionalProperties:true; rejecting extras
    // there would be the fake inventing a rule the wire does not have.
    const cb = register(
      { outputSchema: z.looseObject({ success: z.boolean() }) },
      async () => textOf({ success: true, whatever: 1 }),
    );
    await expect(cb({}, fakeExtra())).resolves.toMatchObject({ structuredContent: { whatever: 1 } });
  });

  it("leaves a tool with no schemas alone", async () => {
    const cb = register({}, async () => textOf({ anything: 1 }));
    await expect(cb({ whatever: true }, fakeExtra())).resolves.toMatchObject({ structuredContent: { anything: 1 } });
  });
});
