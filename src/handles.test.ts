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
