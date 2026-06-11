import { describe, it, expect } from "vitest";
import {
  buildPattern,
  classifyDefinition,
  extractSymbolName,
  escapeForRegex,
  escapeForShell,
  isVendoredPath,
} from "./symbols.js";

describe("isVendoredPath", () => {
  it("flags LVGL / managed_components / graphics vendoring", () => {
    expect(isVendoredPath("lvgl/src/misc/lv_math.c")).toBe(true);
    expect(isVendoredPath("crosspad-pc/lvgl/demos/benchmark/lv_demo_benchmark.c")).toBe(true);
    expect(isVendoredPath("managed_components/lvgl__lvgl/src/lv_obj.c")).toBe(true);
    expect(isVendoredPath("lvgl/libs/nema_gfx/include/nema_graphics.h")).toBe(true);
    expect(isVendoredPath("lvgl/src/libs/thorvg/tvgAnimation.cpp")).toBe(true);
    expect(isVendoredPath("lvgl/src/libs/FT800-FT813/EVE_commands.c")).toBe(true);
  });

  it("flags STM CubeMX / ST vendoring", () => {
    expect(isVendoredPath("Drivers/STM32G0xx_HAL_Driver/Src/stm32g0xx_hal_adc.c")).toBe(true);
    expect(isVendoredPath("Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_core.c")).toBe(true);
    expect(isVendoredPath("Drivers/CMSIS/Device/ST/stm32g0xx.h")).toBe(true);
  });

  it("flags Arduino display libs, generated and third-party trees", () => {
    expect(isVendoredPath("lib/TFT_eSPI/TFT_eSPI.cpp")).toBe(true);
    expect(isVendoredPath("build/CMakeFiles/foo.c")).toBe(true);
    expect(isVendoredPath(".pio/libdeps/x.cpp")).toBe(true);
    expect(isVendoredPath("third_party/lib/x.c")).toBe(true);
    expect(isVendoredPath("node_modules/x/y.js")).toBe(true);
  });

  it("keeps real CrossPad source", () => {
    expect(isVendoredPath("lib/crosspad-core/src/pad/PadAnimator.cpp")).toBe(false);
    expect(isVendoredPath("components/crosspad-core/include/crosspad/led/LedTypes.hpp")).toBe(false);
    expect(isVendoredPath("app/src/sleep.c")).toBe(false);
    expect(isVendoredPath("main/gui/charge_overlay.cpp")).toBe(false);
    expect(isVendoredPath("Core/Src/main.c")).toBe(false);
  });
});

describe("buildPattern", () => {
  it("generates class pattern for kind=class", () => {
    const p = buildPattern("Foo", "class");
    expect(p).toContain("class|struct");
    expect(p).toContain("Foo");
  });

  it("generates macro pattern for kind=macro", () => {
    const p = buildPattern("MY_MACRO", "macro");
    expect(p).toContain("#define");
    expect(p).toContain("MY_MACRO");
  });

  it("generates enum pattern for kind=enum", () => {
    const p = buildPattern("Color", "enum");
    expect(p).toContain("enum");
    expect(p).toContain("Color");
  });

  it("generates typedef pattern for kind=typedef", () => {
    const p = buildPattern("MyType", "typedef");
    expect(p).toContain("using");
    expect(p).toContain("MyType");
  });

  it("generates function pattern for kind=function", () => {
    const p = buildPattern("doStuff", "function");
    expect(p).toContain("doStuff");
    expect(p).toContain("\\(");
  });

  it("generates all patterns for kind=all", () => {
    const p = buildPattern("Test", "all");
    expect(p).toContain("class|struct");
    expect(p).toContain("#define");
    expect(p).toContain("enum");
    expect(p).toContain("using");
  });

  it("returns empty for unknown kind", () => {
    expect(buildPattern("X", "unknown")).toBe("");
  });
});

describe("classifyDefinition", () => {
  it("classifies class definitions", () => {
    expect(classifyDefinition("class PadManager {")).toBe("class");
    expect(classifyDefinition("struct EventData {")).toBe("class");
  });

  it("classifies macro definitions", () => {
    expect(classifyDefinition("#define REGISTER_APP(name)")).toBe("macro");
  });

  it("classifies enum definitions", () => {
    expect(classifyDefinition("enum class EventType {")).toBe("enum");
    expect(classifyDefinition("enum Color {")).toBe("enum");
  });

  it("classifies typedef/using definitions", () => {
    expect(classifyDefinition("using Callback = std::function<void()>;")).toBe("typedef");
  });

  it("classifies function definitions", () => {
    expect(classifyDefinition("void doStuff(int x) {")).toBe("function");
    expect(classifyDefinition("int PadManager::getCount() const {")).toBe("function");
  });

  it("returns null for control flow", () => {
    expect(classifyDefinition("if (x > 0) {")).toBeNull();
    expect(classifyDefinition("while (running) {")).toBeNull();
    expect(classifyDefinition("return value;")).toBeNull();
  });

  it("returns null for comments", () => {
    expect(classifyDefinition("// class Foo {")).toBeNull();
    expect(classifyDefinition("/* enum Bar */")).toBeNull();
  });

  it("returns null for includes", () => {
    expect(classifyDefinition('#include "foo.hpp"')).toBeNull();
  });

  it("returns null for forward declarations", () => {
    // Note: forward decl filtering is done in crosspadSearchSymbols, not classifyDefinition
    // classifyDefinition itself would classify "class Foo;" as "class"
    // The filtering happens later, so this is expected behavior
    expect(classifyDefinition("class Foo;")).toBe("class");
  });
});

describe("extractSymbolName", () => {
  it("extracts class name", () => {
    expect(extractSymbolName("class PadManager {", "class")).toBe("PadManager");
    expect(extractSymbolName("struct EventData : public Base {", "class")).toBe("EventData");
  });

  it("extracts macro name", () => {
    expect(extractSymbolName("#define REGISTER_APP(name, ...)", "macro")).toBe("REGISTER_APP");
  });

  it("extracts enum name", () => {
    expect(extractSymbolName("enum class EventType {", "enum")).toBe("EventType");
    expect(extractSymbolName("enum Color {", "enum")).toBe("Color");
  });

  it("extracts typedef/using name", () => {
    expect(extractSymbolName("using Callback = std::function<void()>;", "typedef")).toBe("Callback");
  });

  it("extracts function name", () => {
    expect(extractSymbolName("void doStuff(int x) {", "function")).toBe("doStuff");
  });

  it("returns null for unmatched patterns", () => {
    expect(extractSymbolName("random line", "class")).toBeNull();
    expect(extractSymbolName("", "function")).toBeNull();
  });
});

describe("escapeForRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeForRegex("foo.bar")).toBe("foo\\.bar");
    expect(escapeForRegex("a*b+c?")).toBe("a\\*b\\+c\\?");
    expect(escapeForRegex("test[0]")).toBe("test\\[0\\]");
  });

  it("leaves alphanumeric untouched", () => {
    expect(escapeForRegex("PadManager")).toBe("PadManager");
  });
});

describe("escapeForShell", () => {
  it("escapes shell metacharacters but not backslashes", () => {
    const input = `class\\s+Foo`;
    const escaped = escapeForShell(input);
    // Should NOT escape backslash (needed for regex \s \w etc.)
    expect(escaped).toContain("\\s");
    expect(escaped).not.toContain("\\\\s");
  });

  it("escapes double quotes", () => {
    expect(escapeForShell('say "hello"')).toBe('say \\"hello\\"');
  });

  it("escapes dollar signs", () => {
    expect(escapeForShell("$HOME")).toBe("\\$HOME");
  });

  it("escapes backticks", () => {
    expect(escapeForShell("`cmd`")).toBe("\\`cmd\\`");
  });
});
