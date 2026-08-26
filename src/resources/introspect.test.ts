import { describe, expect, it, beforeEach } from "vitest";
import {
  cached,
  clearIntrospectionCache,
  parseEnumClass,
  parseRegisteredApps,
  parseSettings,
} from "./introspect.js";

beforeEach(() => clearIntrospectionCache());

describe("parseEnumClass", () => {
  // Verbatim shape of crosspad-core/include/crosspad/event/EventTypes.hpp.
  const SRC = `
enum class EventType : int32_t {
    // Audio-related events
    NoteOn,
    NoteOff,

    // Pad input events
    PadPressed,
    PadReleased,

    Max
};

enum class EventSource : uint8_t {
    PadManager,         ///< Physical pad presses (via STM32 SYSEX)
    MidiInput,          ///< External MIDI devices (USB, UART, BLE)
    Cli,                ///< Command line interface / serial console

    Max
};
`;

  it("numbers entries from zero and keeps source order", () => {
    expect(parseEnumClass(SRC, "EventType")).toEqual([
      { name: "NoteOn", value: 0 },
      { name: "NoteOff", value: 1 },
      { name: "PadPressed", value: 2 },
      { name: "PadReleased", value: 3 },
    ]);
  });

  it("drops the Max sentinel — it is not an event", () => {
    expect(parseEnumClass(SRC, "EventType").map((e) => e.name)).not.toContain("Max");
  });

  it("keeps the doc comment as the description", () => {
    const sources = parseEnumClass(SRC, "EventSource");
    expect(sources[0]).toEqual({
      name: "PadManager",
      value: 0,
      comment: "Physical pad presses (via STM32 SYSEX)",
    });
  });

  it("honours an explicit value and counts on from it", () => {
    const src = "enum class E : int { A = 4, B, C = 10, D };";
    expect(parseEnumClass(src, "E")).toEqual([
      { name: "A", value: 4 },
      { name: "B", value: 5 },
      { name: "C", value: 10 },
      { name: "D", value: 11 },
    ]);
  });

  it("returns nothing for an enum that is not there", () => {
    expect(parseEnumClass(SRC, "NoSuchEnum")).toEqual([]);
  });
});

describe("parseRegisteredApps", () => {
  it("reads REGISTER_APP_PL including the pad-logic name", () => {
    const src = `
REGISTER_APP_PL(MyApp, nullptr, "play.png",
                lv_CreateMyApp, lv_MyApp_destroy,
                nullptr, nullptr, nullptr, 0, "MyApp")
`;
    expect(parseRegisteredApps(src, "main/app/my_app/my_app.cpp")).toEqual([
      { name: "MyApp", icon: "play.png", priority: 0, padLogic: "MyApp", source: "main/app/my_app/my_app.cpp" },
    ]);
  });

  it("reads plain REGISTER_APP and leaves padLogic null", () => {
    const src = `REGISTER_APP(Update, nullptr, "update.png", lv_CreateUpdate, lv_Update_destroy, nullptr, nullptr, nullptr, 5)`;
    const [app] = parseRegisteredApps(src, "x.cpp");
    expect(app.name).toBe("Update");
    expect(app.padLogic).toBeNull();
    expect(app.priority).toBe(5);
  });

  it("survives a lambda argument, whose commas are not argument separators", () => {
    const src = `REGISTER_APP(Demo, [](App* a){ foo(1, 2); }, "d.png", c, d, nullptr, nullptr, nullptr, 0)`;
    const [app] = parseRegisteredApps(src, "x.cpp");
    expect(app.name).toBe("Demo");
    expect(app.icon).toBe("d.png");
  });

  it("reports a nullptr icon as no icon rather than the string 'nullptr'", () => {
    const src = `REGISTER_APP(NoIcon, nullptr, nullptr, c, d, nullptr, nullptr, nullptr, 0)`;
    expect(parseRegisteredApps(src, "x.cpp")[0].icon).toBeNull();
  });
});

describe("parseSettings", () => {
  it("pairs each field with the struct it lives in", () => {
    const src = `
struct DisplaySettings {
    uint8_t lcdBrightness = 80;   ///< 0-100
    bool    invert = false;
};

struct WirelessSettings {
    uint8_t bleMidiMode = 1;
};
`;
    const fields = parseSettings(src);
    expect(fields).toContainEqual({
      group: "DisplaySettings",
      field: "lcdBrightness",
      type: "uint8_t",
      comment: "0-100",
    });
    expect(fields).toContainEqual({ group: "WirelessSettings", field: "bleMidiMode", type: "uint8_t" });
  });
});

describe("cached", () => {
  it("re-parses when a file's mtime changes, not on every read", () => {
    let built = 0;
    const build = () => { built++; return built; };
    // A path that does not exist still has a stable stamp, so the second call
    // is a cache hit.
    cached("k", ["/nonexistent/a"], build);
    cached("k", ["/nonexistent/a"], build);
    expect(built).toBe(1);
    // A different file list is a different stamp.
    cached("k", ["/nonexistent/b"], build);
    expect(built).toBe(2);
  });
});
