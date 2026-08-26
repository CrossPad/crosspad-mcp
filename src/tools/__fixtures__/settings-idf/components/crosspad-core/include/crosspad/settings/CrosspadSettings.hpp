#pragma once

// Test fixture: a miniature CrosspadSettings.hpp, shaped like the real one.
// It exists so settingsCategories() can be pinned to a derived list that no
// hardcoded fallback happens to equal — `stm` and `masterFx` are groups the
// fallback does not contain, and `LCDbrightness` is a loose scalar that must
// not become a category of its own.

#include "crosspad/settings/KeypadSettings.hpp"
#include "crosspad/settings/WirelessSettings.hpp"

namespace crosspad {

static constexpr int CROSSPAD_MAX_PADS = 16;

class CrosspadSettings {
public:
    static CrosspadSettings* getInstance();

    KeypadSettings keypad;
    VibrationSettings vibration;
    WirelessSettings wireless;
    AudioSettings audio;
    Stm32Settings stm;
    MasterFxSettings masterFx;

    uint8_t LCDbrightness = 80;
    bool AudioEngineEnabled = true;
    int Kit = 0;
};

} // namespace crosspad
