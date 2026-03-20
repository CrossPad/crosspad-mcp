export interface ScaffoldParams {
  name: string; // PascalCase, e.g. "Metronome"
  display_name?: string;
  has_pad_logic?: boolean;
  icon?: string;
}

export interface ScaffoldResult {
  files: Record<string, string>;
  cmake_patch: {
    file: string;
    after_pattern: string;
    content: string;
  };
}

export function crosspadScaffoldApp(params: ScaffoldParams): ScaffoldResult {
  const {
    name,
    display_name = name,
    has_pad_logic = false,
    icon = "CrossPad_Logo_110w.png",
  } = params;

  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  const dir = `src/apps/${lower}`;

  const files: Record<string, string> = {};

  // --- CMakeLists.txt ---
  const sources = [`\${CMAKE_CURRENT_SOURCE_DIR}/${name}App.cpp`];
  if (has_pad_logic) {
    sources.push(`\${CMAKE_CURRENT_SOURCE_DIR}/${name}PadLogic.cpp`);
  }

  files[`${dir}/CMakeLists.txt`] = `# ${display_name} app sources
set(${upper}_APP_SOURCES
    ${sources.join("\n    ")}
    PARENT_SCOPE
)
`;

  // --- App header ---
  files[`${dir}/${name}App.hpp`] = `#pragma once

#include "lvgl.h"

class App;

lv_obj_t* ${name}_create(lv_obj_t* parent, App* app);
void ${name}_destroy(lv_obj_t* app_obj);
`;

  // --- App implementation ---
  let appCpp = `/**
 * @file ${name}App.cpp
 * @brief ${display_name} app — LVGL GUI
 */

#include "${name}App.hpp"
#include "pc_stubs/PcApp.hpp"
#include "pc_stubs/pc_platform.h"

#include <crosspad/app/AppRegistry.hpp>
#include <crosspad/pad/PadManager.hpp>
#include "crosspad-gui/components/app_lifecycle.h"
#include "crosspad-gui/platform/IGuiPlatform.h"
#include "crosspad_app.hpp"

#include "lvgl.h"

#include <cstdio>
`;

  if (has_pad_logic) {
    appCpp += `#include "${name}PadLogic.hpp"
#include <memory>

static std::shared_ptr<${name}PadLogic> s_padLogic;
`;
  }

  appCpp += `
static App* s_app = nullptr;

/* ── App create / destroy ────────────────────────────────────────────── */

lv_obj_t* ${name}_create(lv_obj_t* parent, App* a)
{
    s_app = a;
    lv_obj_t* cont = lv_obj_create(parent);
    lv_obj_set_size(cont, lv_pct(100), lv_pct(100));
    lv_obj_set_style_bg_color(cont, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(cont, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(cont, 4, 0);
    lv_obj_set_flex_flow(cont, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(cont, 2, 0);
    lv_obj_remove_flag(cont, LV_OBJ_FLAG_SCROLLABLE);

    /* ── Title bar with close button ─────────────────────────── */
    lv_obj_t* titleBar = lv_obj_create(cont);
    lv_obj_set_size(titleBar, lv_pct(100), 24);
    lv_obj_set_style_bg_opa(titleBar, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(titleBar, 0, 0);
    lv_obj_set_style_pad_all(titleBar, 0, 0);
    lv_obj_remove_flag(titleBar, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t* titleLabel = lv_label_create(titleBar);
    lv_label_set_text(titleLabel, "${display_name}");
    lv_obj_set_style_text_color(titleLabel, lv_color_white(), 0);
    lv_obj_set_style_text_font(titleLabel, &lv_font_montserrat_14, 0);
    lv_obj_align(titleLabel, LV_ALIGN_LEFT_MID, 4, 0);

    lv_obj_t* closeBtn = lv_button_create(titleBar);
    lv_obj_set_size(closeBtn, 28, 20);
    lv_obj_align(closeBtn, LV_ALIGN_RIGHT_MID, -2, 0);
    lv_obj_set_style_bg_color(closeBtn, lv_color_hex(0x662222), 0);
    lv_obj_set_style_bg_color(closeBtn, lv_color_hex(0xAA3333), LV_STATE_PRESSED);
    lv_obj_set_style_radius(closeBtn, 4, 0);
    lv_obj_set_style_shadow_width(closeBtn, 0, 0);
    lv_obj_t* closeLbl = lv_label_create(closeBtn);
    lv_label_set_text(closeLbl, "X");
    lv_obj_set_style_text_font(closeLbl, &lv_font_montserrat_12, 0);
    lv_obj_center(closeLbl);
    lv_obj_add_event_cb(closeBtn, [](lv_event_t*) {
        if (s_app) crosspad_gui::app_request_close(s_app);
    }, LV_EVENT_CLICKED, nullptr);
`;

  if (has_pad_logic) {
    appCpp += `
    /* ── Register pad logic ──────────────────────────────────── */
    s_padLogic = std::make_shared<${name}PadLogic>();
    crosspad::getPadManager().registerPadLogic("${name}", s_padLogic);

    if (a) {
        a->setOnShow([](lv_obj_t*) {
            crosspad::getPadManager().setActivePadLogic("${name}");
            crosspad_app_update_pad_icon();
        });
        a->setOnHide([](lv_obj_t*) {
            crosspad::getPadManager().setActivePadLogic("");
            crosspad_app_update_pad_icon();
        });
    }
`;
  }

  appCpp += `
    /* ── TODO: Add your UI here ──────────────────────────────── */

    printf("[${name}] App created\\n");
    return cont;
}

void ${name}_destroy(lv_obj_t* app_obj)
{
`;

  if (has_pad_logic) {
    appCpp += `    crosspad::getPadManager().setActivePadLogic("");
    crosspad::getPadManager().unregisterPadLogic("${name}");
    crosspad_app_update_pad_icon();
    s_padLogic.reset();
`;
  }

  appCpp += `    s_app = nullptr;
    lv_obj_delete_async(app_obj);
    printf("[${name}] App destroyed\\n");
}

/* ── App registration ────────────────────────────────────────────────── */

void _register_${name}_app() {
    static char icon_path[256];
    snprintf(icon_path, sizeof(icon_path), "%s${icon}",
             crosspad_gui::getGuiPlatform().assetPathPrefix());

    static const crosspad::AppEntry entry = {
        "${name}", icon_path, ${name}_create, ${name}_destroy,
        nullptr, nullptr, nullptr, nullptr, 0
    };
    crosspad::AppRegistry::getInstance().registerApp(entry);
}
`;

  files[`${dir}/${name}App.cpp`] = appCpp;

  // --- Pad logic (optional) ---
  if (has_pad_logic) {
    files[`${dir}/${name}PadLogic.hpp`] = `#pragma once

#include <crosspad/pad/IPadLogicHandler.hpp>

class ${name}PadLogic : public crosspad::IPadLogicHandler {
public:
    void onPadPressed(uint8_t padIndex, uint8_t velocity) override;
    void onPadReleased(uint8_t padIndex) override;
};
`;

    files[`${dir}/${name}PadLogic.cpp`] = `#include "${name}PadLogic.hpp"
#include <cstdio>

void ${name}PadLogic::onPadPressed(uint8_t padIndex, uint8_t velocity)
{
    printf("[${name}PadLogic] Pad %d pressed (vel=%d)\\n", padIndex, velocity);
    // TODO: Implement pad press logic
}

void ${name}PadLogic::onPadReleased(uint8_t padIndex)
{
    printf("[${name}PadLogic] Pad %d released\\n", padIndex);
    // TODO: Implement pad release logic
}
`;
  }

  // --- CMake patch instructions ---
  const cmakePatch = {
    file: "CMakeLists.txt",
    after_pattern: "add_subdirectory(src/apps/",
    content: `add_subdirectory(${dir})\nlist(APPEND MAIN_SOURCES \${${upper}_APP_SOURCES})`,
  };

  return { files, cmake_patch: cmakePatch };
}
