import { describe, expect, it } from "vitest";
import { PROMPTS, registerPrompts } from "./prompts.js";

type Registered = { name: string; config: { title?: string; description?: string; argsSchema?: unknown }; cb: (a: Record<string, string | undefined>) => { messages: { role: string; content: { type: string; text: string } }[] } };

function fakeServer() {
  const registered: Registered[] = [];
  const server = {
    registerPrompt(name: string, config: Registered["config"], cb: Registered["cb"]) {
      registered.push({ name, config, cb });
      return { name };
    },
  };
  return { server: server as never, registered };
}

describe("prompts", () => {
  it("registers every prompt in listing order", () => {
    const { server, registered } = fakeServer();
    const names = registerPrompts(server);
    expect(names).toEqual(PROMPTS.map((p) => p.name));
    expect(registered.map((r) => r.name)).toEqual(names);
  });

  it("gives every prompt a title and a description", () => {
    for (const p of PROMPTS) {
      expect(p.title.length).toBeGreaterThan(3);
      expect(p.description.length).toBeGreaterThan(20);
    }
  });

  it("returns a single user message of plan text", () => {
    const { server, registered } = fakeServer();
    registerPrompts(server);
    for (const r of registered) {
      const out = r.cb({});
      expect(out.messages).toHaveLength(1);
      expect(out.messages[0].role).toBe("user");
      expect(out.messages[0].content.type).toBe("text");
      expect(out.messages[0].content.text.length).toBeGreaterThan(80);
    }
  });

  it("names real tools, not invented ones", () => {
    // A plan that tells the model to call a tool this server does not expose is
    // worse than no plan: the model reports a missing tool instead of working.
    const known = new Set([
      "crosspad_devices", "crosspad_doctor", "crosspad_snapshot", "crosspad_build", "crosspad_flash",
      "crosspad_repo_status", "crosspad_repo_diff", "crosspad_toolsets", "crosspad_task", "crosspad_cdc",
      "crosspad_console", "crosspad_ui", "crosspad_midi", "crosspad_usb_mode", "crosspad_audio_route",
      "crosspad_capture", "crosspad_analyze", "crosspad_stimulus", "crosspad_ble", "crosspad_hil_run",
      "crosspad_diagnose_crash", "crosspad_test_run", "crosspad_commit",
    ]);
    for (const p of PROMPTS) {
      const text = p.plan({});
      for (const m of text.matchAll(/`(crosspad_[a-z_]+)`/g)) {
        expect(known, `${p.name} mentions ${m[1]}`).toContain(m[1]);
      }
    }
  });

  it("substitutes arguments into the plan", () => {
    const jam = PROMPTS.find((p) => p.name === "jam")!;
    expect(jam.plan({ kit: "7", pads: "1, 2" })).toContain("kit_id: 7");
    expect(jam.plan({ kit: "7", pads: "1, 2" })).toContain("[1, 2]");
    // and stays usable with nothing supplied
    expect(jam.plan({})).toContain("kit_id: <id>");
  });

  it("keeps the hardware traps in the plans that need them", () => {
    const byName = Object.fromEntries(PROMPTS.map((p) => [p.name, p.plan({})]));
    // These are the traps that cost real debugging sessions; a plan that omits
    // them walks the model straight into one.
    // the plans are wrapped prose, so match across line breaks
    expect(byName["audio-capture"]).toMatch(/no\s+CDC\s+endpoint/i);
    expect(byName["audio-capture"]).toMatch(/parked|resum/i);
    expect(byName["diagnose"]).toMatch(/opening\s+the\s+bridge\s+VCP\s+resets/i);
    expect(byName["jam"]).toMatch(/wait: true/);
    expect(byName["kit-churn-live"]).toMatch(/inside\s+the\s+swap\s+window/i);
  });
});
