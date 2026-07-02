# CrossPad repos — what lives where

The crosspad-mcp server discovers these dynamically from `CROSSPAD_*_ROOT`
(see `reference/install.md`). Only repos present on disk show up in tool results.

| Repo | Env var | What it is |
|------|---------|-----------|
| **crosspad-pc** | `CROSSPAD_PC_ROOT` | Desktop **simulator** — runs the firmware logic on the host (CMake/Ninja + vcpkg). Build with `crosspad_build platform=pc`, launch with `crosspad_run`. |
| **platform-idf** | `CROSSPAD_IDF_ROOT` | **ESP-IDF** firmware for the ESP32-S3 sidekick. Build with `crosspad_build platform=idf`, flash with `crosspad_flash transport=uart\|ota`. |
| **ESP32-S3** | `CROSSPAD_ARDUINO_ROOT` | Arduino-framework variant of the ESP32-S3 firmware. |
| **crosspad-core** | `CROSSPAD_CORE_ROOT` | Shared, platform-independent logic + **interfaces** (the contract PC/IDF/Arduino implement). Browse with `crosspad_list_interfaces` / `crosspad_interface_implementations`. |
| **crosspad-gui** | `CROSSPAD_GUI_ROOT` | Display/UI layer. |
| **crosspad-apps** | (registry) | App package **registry**. Apps install into a platform repo as git submodules via `crosspad_apps_*` tools. |
| **CrossPad_STM32_r20** | `CROSSPAD_STM_ROOT` | STM32G0B1 single-board firmware — the co-processor side (pad scan, charger, boot latches). Build with `crosspad_build platform=stm`, flash with `crosspad_flash target=stm method=swd\|dfu`, symbol search covers it too. Real-time RAM variable tracing over SWD lives in the separate **`swd-tracer`** skill. |

## How they relate

- **crosspad-core** defines interfaces; **crosspad-pc**, **platform-idf**, and
  **ESP32-S3** are concrete platforms implementing them. Same app logic, three targets.
- **Apps** are reusable behaviors (instruments, sequencers, utilities) pulled from
  the **crosspad-apps** registry into a platform repo as submodules.
- The **PC simulator** is the fast iteration loop — build/run/screenshot/input on
  the host before flashing real hardware.
- **CrossPad_STM32_r20** and the ESP32-S3 side (platform-idf / ESP32-S3) are
  two separate MCUs talking over I2C1 (STM = slave `0x42`) + LPUART1, each
  with its own repo. A symptom can plausibly belong to either side (e.g. a
  wake-time LCD backlight glitch was first mis-diagnosed and fixed as an
  ESP-side issue — the actual cause was STM's backlight PWM timing). Don't
  assume ownership from whichever repo you happen to be looking at; check
  both sides' `CLAUDE.md` if unsure which owns a given symptom.

## ⚠ crosspad-core (and crosspad-gui) are vendored in *three separate,
unlinked checkouts*

`crosspad-core` is a git submodule checked out independently in
`platform-idf/components/crosspad-core`, `ESP32-S3/lib/crosspad-core`, and
`crosspad-pc/lib/crosspad-core`. **Editing one does not change the others.**
This has cost real debugging time in this project's history: hours lost
editing `ESP32-S3/lib/crosspad-core` while flashing IDF builds — the changes
never reached the device, because `crosspad_build platform=idf` compiles
`platform-idf/components/crosspad-core`, not the ESP32-S3 copy. Same trap
applies to `crosspad-gui`, and to `crosspad-pc` specifically: its gui/core
submodule checkouts can drift onto an older pinned commit on a divergent
branch, so a brand-new crosspad-gui screen may simply not build/render there
until someone does a deliberate integration pass — that's expected, not a
bug to chase; verify new GUI work on IDF hardware instead when it happens.

**Rule:** before editing crosspad-core/crosspad-gui, confirm which checkout
the thing you're about to build actually compiles (`crosspad_build`'s
target tells you: `platform=idf` → `platform-idf/components/...`,
`platform=pc` → `crosspad-pc/lib/...`; ESP32-S3's own Arduino build uses its
own `lib/...` copy). If a change "doesn't take effect after flashing/running,"
this is the first thing to check — grep the change in the copy the build
actually compiles before assuming anything else is wrong.

## Inspecting state

- `crosspad_repo_status` — git status across every detected repo at once.
- `crosspad_repo_diff` — submodule drift in crosspad-pc / platform-idf.
- `crosspad://workspace` resource — JSON snapshot of repos, branches, dirty counts, sim status.
