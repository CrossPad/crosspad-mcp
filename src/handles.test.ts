import { describe, it, expect } from "vitest";
import { HandleRegistry, handles } from "./handles.js";

describe("HandleRegistry", () => {
  it("registers, gets, touches, drops", () => {
    let t = 1000;
    const r = new HandleRegistry(() => t);
    r.register("con_1", { kind: "console", device: "dev_3f2a" });
    expect(r.get("con_1")).toEqual({ kind: "console", device: "dev_3f2a", createdAt: 1000, lastTouch: 1000 });
    t = 2000;
    r.touch("con_1");
    expect(r.get("con_1")?.lastTouch).toBe(2000);
    expect(r.get("con_1")?.createdAt).toBe(1000);
    r.drop("con_1");
    expect(r.get("con_1")).toBeUndefined();
  });

  it("touch/drop of an unknown handle are no-ops", () => {
    const r = new HandleRegistry();
    expect(() => r.touch("nope")).not.toThrow();
    expect(() => r.drop("nope")).not.toThrow();
  });

  it("re-registering replaces meta", () => {
    const r = new HandleRegistry(() => 5);
    r.register("snap_1", { kind: "snapshot", device: "dev_1" });
    r.register("snap_1", { kind: "snapshot", device: "dev_2" });
    expect(r.get("snap_1")?.device).toBe("dev_2");
    expect(r.list()).toHaveLength(1);
  });

  it("list() is sorted by handle and carries the handle", () => {
    const r = new HandleRegistry(() => 1);
    r.register("task_2", { kind: "task" });
    r.register("cdc_1", { kind: "cdc", device: "dev_1" });
    r.register("con_1", { kind: "console", device: "dev_1" });
    expect(r.list().map((h) => h.handle)).toEqual(["cdc_1", "con_1", "task_2"]);
    expect(r.list()[0]).toMatchObject({ handle: "cdc_1", kind: "cdc", device: "dev_1" });
  });

  it("exports a shared instance", () => {
    expect(handles).toBeInstanceOf(HandleRegistry);
  });
});

// Spec §3.7's expiry table. Without it every handle this server ever minted
// stayed in the registry for the life of the process.
describe("HandleRegistry expiry (spec §3.7)", () => {
  const MIN = 60_000;

  it("con_* ages out 30 min after the last touch, not after it was opened", () => {
    let t = 0;
    const r = new HandleRegistry(() => t);
    r.register("con_1", { kind: "console", device: "dev_1" });
    t = 29 * MIN;
    r.touch("con_1");
    t = 55 * MIN; // 55 min old, but only 26 min idle
    expect(r.get("con_1")).toBeDefined();
    t = 59 * MIN + 1;
    expect(r.get("con_1")).toBeUndefined();
  });

  it("cap_* and stim_* are capped at 15 min of wall time however busy they were", () => {
    let t = 0;
    const r = new HandleRegistry(() => t);
    r.register("cap_1", { kind: "capture" });
    r.register("stim_1", { kind: "stimulus" });
    t = 14 * MIN;
    r.touch("cap_1");
    r.touch("stim_1");
    t = 15 * MIN;
    expect(r.get("cap_1")).toBeUndefined();
    expect(r.get("stim_1")).toBeUndefined();
  });

  it("task_* survives an hour and then goes", () => {
    let t = 0;
    const r = new HandleRegistry(() => t);
    r.register("task_1", { kind: "task" });
    t = 59 * MIN;
    expect(r.get("task_1")).toBeDefined();
    t = 61 * MIN;
    expect(r.get("task_1")).toBeUndefined();
  });

  it("keeps only the last 20 snap_* handles", () => {
    const r = new HandleRegistry(() => 1);
    for (let i = 0; i < 25; i++) r.register(`snap_${i}`, { kind: "snapshot", device: "dev_1" });
    expect(r.list().filter((h) => h.kind === "snapshot")).toHaveLength(20);
    expect(r.get("snap_4")).toBeUndefined();
    expect(r.get("snap_24")).toBeDefined();
  });

  it("evicting snapshots does not touch handles of another kind", () => {
    const r = new HandleRegistry(() => 1);
    r.register("con_1", { kind: "console" });
    for (let i = 0; i < 25; i++) r.register(`snap_${i}`, { kind: "snapshot" });
    expect(r.get("con_1")).toBeDefined();
  });

  it("an expired handle reports HANDLE_EXPIRED with a way out; an invented one is unknown", () => {
    let t = 0;
    const r = new HandleRegistry(() => t);
    r.register("cap_1", { kind: "capture" });
    t = 20 * MIN;
    const gone = r.lookup("cap_1");
    expect(gone.status).toBe("expired");
    expect(gone.status === "expired" && gone.reason).toBe("max_age");
    expect(gone.status === "expired" && gone.hint).toContain("stop");
    expect(r.lookup("cap_nonsense").status).toBe("unknown");
  });

  it("an expired handle disappears from list()", () => {
    let t = 0;
    const r = new HandleRegistry(() => t);
    r.register("stim_1", { kind: "stimulus" });
    r.register("ble_1", { kind: "ble" });
    t = 20 * MIN;
    expect(r.list().map((h) => h.handle)).toEqual(["ble_1"]);
  });

  it("re-registering an expired id makes it live again", () => {
    let t = 0;
    const r = new HandleRegistry(() => t);
    r.register("cap_1", { kind: "capture" });
    t = 20 * MIN;
    expect(r.lookup("cap_1").status).toBe("expired");
    r.register("cap_1", { kind: "capture" });
    expect(r.lookup("cap_1").status).toBe("live");
  });
});
