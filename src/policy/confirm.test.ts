import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  mintToken, verifyToken, consumeToken, resetSpentTokens, canonicalJson,
  requireConfirmation, enforce, confirmationDeclined, policyDenied, CONFIRM_TTL_S,
} from "./confirm.js";
import type { Policy } from "./policy.js";

const T0 = 1_700_000_000_000;
const ARGS = { target: "esp", transport: "ota", device: "dev_3f2a", delta: { base_fw: "old.bin" } };

function fakeServer(caps: Record<string, unknown> | undefined, elicit?: (p: unknown) => Promise<unknown>) {
  const elicitInput = vi.fn(elicit ?? (async () => ({ action: "decline" })));
  const server = { server: { getClientCapabilities: () => caps, elicitInput } } as unknown as McpServer;
  return { server, elicitInput };
}
const extra = {} as never;

beforeEach(() => resetSpentTokens());

describe("canonicalJson", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }))
      .toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe("token round-trip", () => {
  it("verifies the token it minted", () => {
    const tok = mintToken("crosspad_flash", ARGS, null, T0);
    expect(tok).toMatch(/^cfm_\d+_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(verifyToken(tok, "crosspad_flash", ARGS, null, T0 + 1000)).toBe(true);
  });
  it("ignores key order and a confirm_token inside args", () => {
    const tok = mintToken("crosspad_flash", ARGS, null, T0);
    const reordered = { delta: { base_fw: "old.bin" }, device: "dev_3f2a", transport: "ota", target: "esp", confirm_token: tok };
    expect(verifyToken(tok, "crosspad_flash", reordered, null, T0 + 1000)).toBe(true);
  });
  it("rejects tampered args, another tool, and a forged hex", () => {
    const tok = mintToken("crosspad_flash", ARGS, null, T0);
    expect(verifyToken(tok, "crosspad_flash", { ...ARGS, transport: "uart" }, null, T0 + 1000)).toBe(false);
    expect(verifyToken(tok, "crosspad_flash", { ...ARGS, delta: { base_fw: "new.bin" } }, null, T0 + 1000)).toBe(false);
    expect(verifyToken(tok, "crosspad_cdc", ARGS, null, T0 + 1000)).toBe(false);
    const forged = tok.slice(0, -1) + (tok.endsWith("0") ? "1" : "0");
    expect(verifyToken(forged, "crosspad_flash", ARGS, null, T0 + 1000)).toBe(false);
    expect(verifyToken("garbage", "crosspad_flash", ARGS, null, T0)).toBe(false);
    expect(verifyToken("cfm_notanumber_00", "crosspad_flash", ARGS, null, T0)).toBe(false);
  });
  it("expires after CONFIRM_TTL_S and rejects tokens from the future", () => {
    const tok = mintToken("crosspad_flash", ARGS, null, T0);
    expect(verifyToken(tok, "crosspad_flash", ARGS, null, T0 + CONFIRM_TTL_S * 1000)).toBe(true);
    expect(verifyToken(tok, "crosspad_flash", ARGS, null, T0 + CONFIRM_TTL_S * 1000 + 1)).toBe(false);
    expect(verifyToken(tok, "crosspad_flash", ARGS, null, T0 - 1)).toBe(false);
  });
});

describe("the token binds the resolved device (spec §4.2)", () => {
  it("a token approved against one board does not approve the same call on another", () => {
    const tok = mintToken("crosspad_flash", ARGS, "dev_a1", T0);
    expect(verifyToken(tok, "crosspad_flash", ARGS, "dev_a1", T0 + 1000)).toBe(true);
    // The implicit single-board selection landed on a different board in the
    // meantime — the arguments are byte-identical, the target is not.
    expect(verifyToken(tok, "crosspad_flash", ARGS, "dev_b7", T0 + 1000)).toBe(false);
    expect(verifyToken(tok, "crosspad_flash", ARGS, null, T0 + 1000)).toBe(false);
  });
});

describe("a confirmation approves exactly one call", () => {
  it("consumeToken spends the token: ok once, replayed after", () => {
    const tok = mintToken("crosspad_flash", ARGS, "dev_a1", T0);
    expect(consumeToken(tok, "crosspad_flash", ARGS, "dev_a1", T0 + 1)).toBe("ok");
    expect(consumeToken(tok, "crosspad_flash", ARGS, "dev_a1", T0 + 2)).toBe("replayed");
    expect(consumeToken(tok, "crosspad_flash", ARGS, "dev_a1", T0 + 3)).toBe("replayed");
  });

  it("a wrong token is invalid, not replayed, and never gets spent", () => {
    expect(consumeToken("cfm_1_0000000000000000_" + "0".repeat(64), "crosspad_flash", ARGS, null, T0)).toBe("invalid");
  });

  it("requireConfirmation approves a token once and asks again for the replay", async () => {
    const { server } = fakeServer({});
    const first = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "flash");
    if (first.status !== "token") throw new Error("expected a token result");
    const tok = (first.result.structuredContent as { confirmation: { token: string } }).confirmation.token;
    const withToken = { ...ARGS, confirm_token: tok };

    expect((await requireConfirmation(server, extra, "crosspad_flash", withToken, "flash")).status).toBe("approved");

    const replay = await requireConfirmation(server, extra, "crosspad_flash", withToken, "flash");
    expect(replay.status).toBe("token");
    if (replay.status !== "token") return;
    const sc = replay.result.structuredContent as { confirmation: { token: string }; hint: string };
    expect(sc.hint).toContain("already spent");
    // …and the fresh token it hands back is a different one.
    expect(sc.confirmation.token).not.toBe(tok);
  });

  it("a replay re-asks the human when the client can elicit", async () => {
    const { server, elicitInput } = fakeServer({ elicitation: {} }, async () => ({ action: "accept", content: { approve: true } }));
    const tok = mintToken("crosspad_flash", ARGS);
    const withToken = { ...ARGS, confirm_token: tok };
    expect((await requireConfirmation(server, extra, "crosspad_flash", withToken, "x")).status).toBe("approved");
    expect(elicitInput).not.toHaveBeenCalled();
    expect((await requireConfirmation(server, extra, "crosspad_flash", withToken, "x")).status).toBe("approved");
    expect(elicitInput).toHaveBeenCalledTimes(1);
  });
});

describe("requireConfirmation — token path (no elicitation capability)", () => {
  it("returns a confirmation_required result and performs nothing", async () => {
    const { server, elicitInput } = fakeServer({});
    const r = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "Flash esp over OTA on dev_3f2a");
    expect(r.status).toBe("token");
    if (r.status !== "token") return;
    expect(elicitInput).not.toHaveBeenCalled();
    expect(r.result.isError).toBeUndefined();
    const sc = r.result.structuredContent as { resultType: string; confirmation: { token: string; expires_in_s: number; summary: string } };
    expect(sc.resultType).toBe("confirmation_required");
    expect(sc.confirmation.expires_in_s).toBe(120);
    expect(sc.confirmation.summary).toBe("Flash esp over OTA on dev_3f2a");
    expect(sc.confirmation.token).toMatch(/^cfm_/);
    expect(JSON.parse((r.result.content[0] as { text: string }).text).resultType).toBe("confirmation_required");
    // the token it handed out approves the identical call
    const again = await requireConfirmation(server, extra, "crosspad_flash", { ...ARGS, confirm_token: sc.confirmation.token }, "x");
    expect(again.status).toBe("approved");
  });
  it("a valid confirm_token short-circuits even when elicitation is available", async () => {
    const { server, elicitInput } = fakeServer({ elicitation: {} });
    const tok = mintToken("crosspad_flash", ARGS);
    const r = await requireConfirmation(server, extra, "crosspad_flash", { ...ARGS, confirm_token: tok }, "x");
    expect(r.status).toBe("approved");
    expect(elicitInput).not.toHaveBeenCalled();
  });
  it("an invalid confirm_token falls back to a fresh token result", async () => {
    const { server } = fakeServer(undefined);
    const r = await requireConfirmation(server, extra, "crosspad_flash", { ...ARGS, confirm_token: "cfm_1_00" }, "x");
    expect(r.status).toBe("token");
  });
});

describe("requireConfirmation — elicitation path", () => {
  it("accept with approve=true → approved", async () => {
    const { server, elicitInput } = fakeServer({ elicitation: {} }, async () => ({ action: "accept", content: { approve: true } }));
    const r = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "Flash esp over OTA on dev_3f2a");
    expect(r.status).toBe("approved");
    expect(elicitInput).toHaveBeenCalledTimes(1);
    const params = elicitInput.mock.calls[0][0] as { message: string; requestedSchema: { properties: Record<string, unknown>; required: string[] } };
    expect(params.message).toContain("Flash esp over OTA on dev_3f2a");
    expect(params.requestedSchema.required).toEqual(["approve"]);
  });
  it("decline / cancel / accept without approve → declined", async () => {
    for (const res of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { approve: false } }, { action: "accept" }]) {
      const { server } = fakeServer({ elicitation: {} }, async () => res);
      const r = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "x");
      expect(r.status).toBe("declined");
    }
  });
  it("an elicitInput failure falls back to the token path", async () => {
    const { server } = fakeServer({ elicitation: {} }, async () => { throw new Error("client went away"); });
    const r = await requireConfirmation(server, extra, "crosspad_flash", ARGS, "x");
    expect(r.status).toBe("token");
  });
});

describe("enforce", () => {
  const strict: Policy = { mode: "strict", rules: [] };
  const readonly: Policy = { mode: "readonly", rules: [] };
  it("allow → null", async () => {
    const { server } = fakeServer({});
    expect(await enforce(server, extra, strict, "crosspad_devices", {}, "list devices")).toBeNull();
  });
  it("hidden → POLICY_DENIED error", async () => {
    const { server } = fakeServer({});
    const r = await enforce(server, extra, readonly, "crosspad_ui", { action: "press" }, "press");
    expect(r?.isError).toBe(true);
    expect((r?.structuredContent as { error: { code: string } }).error.code).toBe("POLICY_DENIED");
  });
  it("confirm without token → confirmation_required; declined → CANCELLED_BY_USER", async () => {
    const { server } = fakeServer({});
    const r = await enforce(server, extra, strict, "crosspad_flash", ARGS, "flash");
    expect((r?.structuredContent as { resultType: string }).resultType).toBe("confirmation_required");
    const declined = fakeServer({ elicitation: {} }, async () => ({ action: "decline" }));
    const d = await enforce(declined.server, extra, strict, "crosspad_flash", ARGS, "flash");
    expect(d?.isError).toBe(true);
    expect((d?.structuredContent as { error: { code: string } }).error.code).toBe("CANCELLED_BY_USER");
  });
  it("helpers carry code + hint", () => {
    expect((confirmationDeclined("crosspad_flash").structuredContent as { error: { code: string } }).error.code).toBe("CANCELLED_BY_USER");
    expect((policyDenied("crosspad_flash", "readonly").structuredContent as { error: { hint: string } }).error.hint).toContain("readonly");
  });
});
