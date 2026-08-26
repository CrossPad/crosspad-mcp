import { describe, it, expect, beforeEach } from "vitest";
import { fakeDaemon } from "../testing/fake-daemon.js";
import { fakeServer } from "../testing/fake-server.js";
import {
  registerKnowledgeResources,
  KnowledgeCache,
  knowledgeCache,
  KNOWLEDGE_TTL_MS,
  KNOWLEDGE_RESOURCES,
} from "./knowledge.js";
import { HandleRegistry } from "../handles.js";
import { JobRegistry } from "../tasks.js";
import { ToolsetManager } from "../toolsets.js";
import { registerAll } from "../registry.js";
import type { ToolContext } from "../tool-context.js";

const CDC_YAML = {
  verbs: {
    KIT_LOAD: { args: ["id"], reply: "KITSTATUS:", end: null, profile: "default" },
    ENC_GROUP: { args: [], reply: "ENCGROUP:", end: null, profile: "default" },
  },
};
const SYSEX_YAML = {
  manufacturer: 0x7d,
  usb_mode: { id: 0x1b, default: 0x01, audio: 0x02 },
  host_denylist: [[0x19, 0x01]],
};
const SCENARIOS = {
  scenarios: [
    { name: "smoke", description: "boot and check markers", params: [{ name: "timeout", type: "int", default: 25, help: "seconds" }] },
    { name: "kit_churn", description: "swap kits while pads fire", params: [{ name: "rounds", type: "int", default: 20, help: "rounds" }] },
  ],
};

function mk(handlers: Record<string, (a: Record<string, unknown>) => unknown>) {
  const daemon = fakeDaemon(handlers);
  const ctx: ToolContext = {
    daemon: () => daemon,
    policy: { mode: "lab", rules: [] },
    jobs: new JobRegistry(),
    handles: new HandleRegistry(),
  };
  const fs = fakeServer();
  registerKnowledgeResources(fs.server, ctx);
  return { daemon, res: fs.resources, ctx, fs };
}

beforeEach(() => {
  knowledgeCache.clear();
});

describe("knowledge resources", () => {
  it("registers the three long-ttl URIs", () => {
    const { res } = mk({});
    expect(res.get("crosspad-cdc-catalog")!.uriOrTemplate).toBe("crosspad://cdc");
    expect(res.get("crosspad-sysex-catalog")!.uriOrTemplate).toBe("crosspad://sysex");
    expect(res.get("crosspad-hil-catalog")!.uriOrTemplate).toBe("crosspad://hil/catalog");
    expect(res.get("crosspad-cdc-catalog")!.config._meta["crosspad/ttl_ms"]).toBe(KNOWLEDGE_TTL_MS);
    expect(KNOWLEDGE_RESOURCES.map((r) => r.name)).toEqual([
      "crosspad-cdc-catalog",
      "crosspad-sysex-catalog",
      "crosspad-hil-catalog",
    ]);
  });

  it("crosspad://cdc reads knowledge.get {name: cdc}", async () => {
    const { res, daemon } = mk({ "knowledge.get": () => CDC_YAML });
    const out = await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    expect(daemon.calls[0]).toEqual({ op: "knowledge.get", args: { name: "cdc" } });
    expect(out.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(out.contents[0].text).verbs.KIT_LOAD.reply).toBe("KITSTATUS:");
  });

  it("crosspad://sysex reads knowledge.get {name: sysex}", async () => {
    const { res, daemon } = mk({ "knowledge.get": () => SYSEX_YAML });
    const out = await res.get("crosspad-sysex-catalog")!.cb(new URL("crosspad://sysex"));
    expect(daemon.calls[0]).toEqual({ op: "knowledge.get", args: { name: "sysex" } });
    expect(JSON.parse(out.contents[0].text).host_denylist).toEqual([[0x19, 0x01]]);
  });

  it("serves the second read from cache without touching the daemon", async () => {
    const { res, daemon } = mk({ "knowledge.get": () => CDC_YAML });
    await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    expect(daemon.calls.length).toBe(1);
  });

  it("crosspad://hil/catalog reads scenario.list and validates params", async () => {
    const { res, daemon } = mk({ "scenario.list": () => SCENARIOS });
    const out = await res.get("crosspad-hil-catalog")!.cb(new URL("crosspad://hil/catalog"));
    expect(daemon.calls[0]).toEqual({ op: "scenario.list", args: {} });
    const parsed = JSON.parse(out.contents[0].text);
    expect(parsed.scenarios.map((s: { name: string }) => s.name)).toEqual(["smoke", "kit_churn"]);
    expect(parsed.scenarios[1].params[0].name).toBe("rounds");
    expect(parsed.ttl_ms).toBe(KNOWLEDGE_TTL_MS);
    expect(typeof parsed.generated_at).toBe("number");
  });

  it("reports a daemon error as a payload and does not cache it", async () => {
    let calls = 0;
    const { res, daemon } = mk({
      "knowledge.get": () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("unknown knowledge file"), { code: "BAD_ARGS", hint: "one of: cdc, sysex, markers" });
        return CDC_YAML;
      },
    });
    const bad = await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    const payload = JSON.parse(bad.contents[0].text);
    expect(payload.error.code).toBe("BAD_ARGS");
    expect(payload.error.hint).toBe("one of: cdc, sysex, markers");
    const good = await res.get("crosspad-cdc-catalog")!.cb(new URL("crosspad://cdc"));
    expect(JSON.parse(good.contents[0].text).verbs).toBeDefined();
    expect(daemon.calls.length).toBe(2);
  });

  it("registerAll wires the knowledge resources", () => {
    const fs = fakeServer();
    const ctx: ToolContext = {
      daemon: () => fakeDaemon({}),
      policy: { mode: "lab", rules: [] },
      jobs: new JobRegistry(),
      handles: new HandleRegistry(),
    };
    const manager = new ToolsetManager(fs.server, ctx.policy);
    registerAll(fs.server, ctx, manager);
    expect(fs.resources.has("crosspad-cdc-catalog")).toBe(true);
    expect(fs.resources.has("crosspad-sysex-catalog")).toBe(true);
    expect(fs.resources.has("crosspad-hil-catalog")).toBe(true);
  });
});

describe("KnowledgeCache", () => {
  it("expires entries after ttlMs", () => {
    let now = 1_000;
    const c = new KnowledgeCache(500, () => now);
    c.set("k", { a: 1 });
    expect(c.get("k")).toEqual({ a: 1 });
    now = 1_499;
    expect(c.get("k")).toEqual({ a: 1 });
    now = 1_501;
    expect(c.get("k")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("clear() drops everything", () => {
    const c = new KnowledgeCache(1000, () => 0);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.size).toBe(2);
    c.clear();
    expect(c.size).toBe(0);
  });
});
