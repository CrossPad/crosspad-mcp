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
| **CrossPad_STM32_r20** | (STM repo) | STM32G0B1 single-board firmware. Real-time variable tracing over SWD lives in the **`swd-tracer`** skill, not here. |

## How they relate

- **crosspad-core** defines interfaces; **crosspad-pc**, **platform-idf**, and
  **ESP32-S3** are concrete platforms implementing them. Same app logic, three targets.
- **Apps** are reusable behaviors (instruments, sequencers, utilities) pulled from
  the **crosspad-apps** registry into a platform repo as submodules.
- The **PC simulator** is the fast iteration loop — build/run/screenshot/input on
  the host before flashing real hardware.

## Inspecting state

- `crosspad_repo_status` — git status across every detected repo at once.
- `crosspad_repo_diff` — submodule drift in crosspad-pc / platform-idf.
- `crosspad://workspace` resource — JSON snapshot of repos, branches, dirty counts, sim status.
