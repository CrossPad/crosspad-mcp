---
name: crosspad-game-port
description: Port a free game to CrossPad, or write a small one for it, as a firmware kit of its own -- an app repo (crosspad-<game>) with a pad map, encoder and power controls, a frame on the 320x240 panel, sound through core's audio module, and Quit back to the other firmware slot -- built and played in the crosspad-pc simulator first, then built for the board. Use it whenever someone asks to "port <game> to CrossPad", "add a game", "make <Pong/Tetris/...> for the pads", "another game like DOOM", or to turn an open-source game into a CrossPad firmware kit. Covers picking a game (licence, size, controls), the repo layout, the C/C++ boundary, the frame/input/audio plumbing, the kit and package, the simulator test loop, the board build, and the traps the DOOM port hit.
---

# Porting a game to CrossPad

A game on CrossPad is a **firmware kit with one app**: the Firmware app's
Library installs its package into the slot that is not running and restarts
into it; the game's own Quit switches back. DOOM is the worked example --
read it before starting, everything below was learnt there:

| What | Where |
|---|---|
| The app | `CrossPad/crosspad-doom` (`src/DoomApp.cpp`, `port/`, `third_party/`, `crosspad_pc.cmake`, `CMakeLists.txt`, `linker.lf`) |
| Simulator: kits, slots, library | `crosspad-pc` `src/fw/`, `config/fw_kits/`, `scripts/make_fw_package.py`, CLAUDE.md "Firmware kits" |
| Board: kit profile, single-app boot | `platform-idf` `config/profiles/doom.json`, `CMakeLists.txt` (profile keys), `main/gui/gui.cpp`, `main/app/CMakeLists.txt` |

`scripts/sim_drive.py` next to this file drives an isolated simulator
(launch, screenshots, pads, encoder, power, audio level, slots).

## 0. Ground rules

- **Portability**: the app talks to crosspad-core / crosspad-gui only
  (`IPadLogicHandler`, `PadManager`, `IAudioModule`/`IAudioNode`, `IClock`,
  `IGuiPlatform`, `IFwViewService`, LVGL). FreeRTOS is shared by every
  platform; anything ESP-IDF-only sits behind `#if defined(ESP_PLATFORM) &&
  !defined(ARDUINO)` with a plain fallback (the sampler's `SamplerRtos.cpp`
  is the precedent).
- **Licence first.** Code GPL-2.0-or-later or more permissive (the CrossPad
  parts are GPL-3.0-or-later); data either free (shareware episodes,
  CC-BY/CC0, homebrew) or fetched by the user onto the card, never
  committed. Write the licence of every third-party part into the README.
- **Fresh repo**, upstream vendored at a pinned commit in `third_party/`,
  every change to it marked `/* crosspad: ... */` with the reason. Platform
  files of the upstream (SDL, X11, Allegro, DOS) are left out, not patched.
- **Nothing on the board's own API** from the game. No `printf` floods on the
  audio thread, no allocation there.
- **Work in worktrees**, never in the user's main checkouts; other sessions
  run simulators and the bench (see 6).

## 1. Choose (or scope) the game

Good fits: 320x240 or less (or scales to it), C/C++, no threads of its own or
easy to put on one task, input that maps onto 16 pads + an encoder + a power
click, a few MB of RAM at most. For a game written from scratch (Pong,
Piano Tiles, Tetris...) keep it in one app with a plain-C++ model that a host
test could drive, and the LVGL/pads/audio around it.

Decide before coding: the pad map (draw it, see 3), what the encoder does in
a menu and in play, what power does (open/close the game's menu), and where
data lives on the card (`crosspad/<game>/`).

## 2. Repo layout (`crosspad-<game>`)

```
crosspad-app.json      id, name, version, "kits": ["<kit>"], platforms, requires core/gui >=2.0.0,<3.0.0
CMakeLists.txt         ESP-IDF component: sources only for the kits in crosspad-app.json "kits"
crosspad_pc.cmake      simulator: a static library for the C side, appended to CROSSPAD_PC_APP_LIBS
linker.lf              (board, when needed) big zero-initialised globals to PSRAM
src/<Game>App.cpp      the app (C++): LVGL, pads, encoder, power, audio node, Quit
port/                  C glue the third-party code calls, and the C API it asks of the app
third_party/<upstream> pinned upstream, patches marked crosspad:
assets/<game>.png      48x48 launcher icon
data/                  only free data
README.md              controls, data on the card, layout, licences
```

- The simulator compiles `src/*.cpp` itself (flat unless the app's
  CMakeLists.txt says GLOB_RECURSE) and includes `crosspad_pc.cmake`; C files
  are built only there. Give the C library `-w` and its own defines.
- A **C boundary**: third-party C sees only `port/crosspad_<game>_host.h`
  (plain C types). Never pass a C `boolean`/enum-sized type or a struct of
  the game's into C++ -- doomgeneric's `boolean` is an enum in C and an
  unsigned int in C++.
- `CMakeLists.txt` keeps `REQUIRES` the same whatever the kit (ESP-IDF reads
  them in an early pass that does not know it) and only empties `SRCS` for
  other kits; `WHOLE_ARCHIVE` (it keeps `_register_<App>_app()`) only when
  there are sources. Copy DOOM's.

## 3. The app (copy DoomApp.cpp's shape)

- `REGISTER_APP_PL(<App>, nullptr, crosspad_gui::resolveAppIcon("<game>.png"),
  create, destroy, nullptr, nullptr, nullptr, 0, "<PadLogicName>")`. Register
  the pad logic once in create; the framework activates it.
- **Game loop** on a FreeRTOS task of its own when the game blocks or runs
  its own loop (DOOM); an `lv_timer` is enough for a small game whose step is
  short. A task: stack in PSRAM on the board
  (`xTaskCreatePinnedToCoreWithCaps(..., MALLOC_CAP_SPIRAM)`, never writes
  flash), plain `xTaskCreate` elsewhere (stack in *words* there, *bytes* on
  ESP-IDF). Sleep with `vTaskDelay`, never busy-wait: the simulator's
  FreeRTOS runs one task at a time.
- **Frame**: game renders into its own buffer; convert to RGB565 into a
  triple buffer (atomic index + dirty bit, no lock); an `lv_timer` (~15 ms)
  copies the newest into the buffer of one `lv_image` (`LV_COLOR_FORMAT_RGB565`,
  `lv_image_dsc_t` you own) and invalidates it. Big buffers with `std::malloc`
  (PSRAM on the board), never `lv_malloc` (LVGL's heap is 1 MB on the PC).
  Stretch to the height the app gets (`lv_obj_get_content_height(parent)`,
  up to 240): a kit without a top bar gets all 240 (236 in the simulator's
  bezel).
- **Pads**: `IPadLogicHandler` -- index 0 = bottom left ("PAD 1"), 15 = top
  right ("PAD 16"). Press/release into a FreeRTOS queue the game task drains.
  Colour the pads by role in `onActivate` and on press/release
  (`pm.setPadColor`); black is "off". Implement every pure virtual
  (`onPadPressure` too).
- **Encoder**: an `lv_group` with one focusable object kept in edit mode
  (`lv_group_set_editing(g, true)`, re-asserted in the frame timer -- a long
  press drops it); `LV_EVENT_KEY | LV_EVENT_PREPROCESS`: `LV_KEY_LEFT`/`RIGHT`
  for turns (wheel up = LEFT), `LV_KEY_ENTER` for the click. Make a *tap*
  (down now, up ~60 ms later) so a game reading key state per tick sees it.
  Restore the previous group with `lv_indev_restore_group()` on destroy.
- **Power click**: `crosspad_gui::ui_back_push(fn, nullptr)` in create (it
  runs before the encoder's edit-mode step of `powerBack()`), remove it in
  destroy. Power = the game's menu / pause.
- **Quit**: on the LVGL thread, `crosspad_gui::fwViewService()
  .flowSwitchAndRestart(false)` -- the platform sets the service at boot.
  When it returns false (no other firmware) say so on screen and keep
  playing. From a game task: post to the GUI (`getGuiPlatform().postToGui`)
  and wait on a semaphore for a refusal.
- **Errors** (`I_Error`-like, missing data): a message on the panel and power
  = back to the other firmware; never `exit()` -- it ends the whole firmware.
- **No keyboard**: anything asking for text gets a sensible default (DOOM's
  save names are the map's).
- **Data**: `crosspad_gui::getGuiPlatform().storagePath("/crosspad/<game>")`
  is the card directory on every platform. Config and saves go there too.

## 4. Sound

One `crosspad::IAudioNode` (generator) per app, added once with
`crosspad::getAudioModule().addNode(&node)`. `mix(out, frames)` runs on the
audio thread: no locks you would wait long on, no allocation, no logging.
Game side -> audio thread through a lock-free SPSC command ring (start / stop
/ params with a generation counter per channel); "is it playing" from an
atomic the audio thread sets. Sample rate from `onPrepare`. Music engines
that need their own timing (DOOM's OPL) render inside `mix()` and run their
callbacks there; their mutex is a `std::mutex` (the audio thread is no
FreeRTOS task on every platform). For a melody game, a small synth of your
own in the node (square/triangle + envelope) is enough and portable.

## 5. The kit and the package

Simulator (`crosspad-pc`):

1. `src/apps/crosspad-<game>` as a submodule (`.gitmodules` url
   `https://github.com/CrossPad/crosspad-<game>.git`). Before the GitHub repo
   exists: develop in `~/GIT/crosspad-<game>`, `git -c protocol.file.allow=always
   submodule add ~/GIT/crosspad-<game> src/apps/crosspad-<game>`, then set the
   url in `.gitmodules` to the GitHub one (do not create or push GitHub repos
   without the user's go-ahead).
2. `config/fw_kits/<kit>.json`: `kit`, `display_name`, `version`,
   `"apps": ["crosspad-<game>"]`, `"standalone": "<App>"` (the REGISTER name),
   `"top_bar": false`, `description`; icon `config/fw_kits/icons/<kit>.png`
   64x64 (`python3 scripts/fw_icon.py check`).
3. `config/fw_kits/full.json` `exclude`: add `crosspad-<game>`.
4. Build: `cmake -B build-<kit> -G Ninja -DCMAKE_BUILD_TYPE=Debug
   -DCROSSPAD_FW_KIT=<kit> -DBUILD_TESTING=OFF && cmake --build build-<kit>`
   -> `bin/CrossPad-<kit>`; the full sim is `cmake -B build ... -DBUILD_TESTING=OFF`.
5. Package: `python3 scripts/make_fw_package.py bin/CrossPad-<kit> --card <card>`.

Board (`platform-idf`, on the 2.x branch the user names):
`config/profiles/<kit>.json` (`name`, `display_name`, `icon`
`icons/<kit>.png`, `description` <= 160 chars, `platform: esp-idf`,
`standalone`, `top_bar: false`, `sample_engine: false` unless it plays kits,
`apps: {"<id>": {"track": "pinned", "commit": "<sha>"}}`), the submodule in
`components/crosspad-<game>`, then `python3 -m pytest -q
tools/tests/test_ci_matrix.py` and `idf.py -B build_<kit> -DSDKCONFIG=sdkconfig.v2
-DCROSSPAD_FW_KIT=<kit> build` (see CLAUDE.md for the export.sh and the
`GIT_CONFIG_*` workaround). The ESP toolchain refuses implicit declarations
(-w does not help): every header the upstream got through SDL must be added.
A `dram0_0_seg overflowed` means big globals: `linker.lf` with
`[mapping:crosspad_<game>]` (underscores, no hyphen) `* (extram_bss)` under
`if SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY = y:`.

## 6. Test loop (simulator)

Never touch the user's simulator or profile: another session may own port
19840 and `~/.crosspad`. `scripts/sim_drive.py` uses its own profile and
port (`CROSSPAD_PROFILE_DIR`, `CROSSPAD_REMOTE_PORT`, `CROSSPAD_NO_MIDI=1`):

```bash
D=<this skill>/scripts/sim_drive.py
export SIM_DIR=<scratch dir> SIM_PORT=19851 SIM_PC=<crosspad-pc worktree>
python3 $D setup --card-data <path to data files>   # profile, card, data under crosspad/<game>/
python3 $D launch bin/CrossPad-<kit>                 # waits for the control port
python3 $D shot <name> [--full]                      # PNG in $SIM_DIR/shots/
python3 $D pad 5 [--hold 0.3]  |  enc -1  |  click  |  power
python3 $D level                                     # audio peak, to prove sound
python3 $D slots                                     # boot slot and both slots' state
python3 $D kill                                      # this simulator only
```

Look at every screenshot you take (Read the PNG). Prove, in this order:
the game renders full-panel; every pad/encoder/power action does what the
README says; sound (`level` > 0 while it should play); the full kit's
Library shows the package (icon, text) -> **Install and run** -> the game's
slot boots straight into it -> Quit -> back in the full kit's launcher. A
level/score/melody feature is proven by playing through it, not by reading
the code.

Traps:
- `pkill -f <pattern>` matches your own shell when the pattern is in its
  command line (exit 144): use `sim_drive.py kill`, or anchor (`^/path`).
- The simulator's process is named `Scheduler`; find it by its exe path.
- A switch ends the process: a control request sent then may get no answer.
- Dialog buttons move with their text: take a screenshot before clicking.
- `cmake --build` of a kit dir writes `bin/`: two kits never share a name.

## 7. Done

- README: controls (pad table by printed label), data on the card, layout,
  licences, what is not done.
- Commits in the app repo and the simulator (and platform-idf if built);
  push and PRs only when the user asked.
- Report: what works with the evidence (screenshots, levels, slots), what
  was not tried (the board unless built, flashed and played), and every
  place this skill was wrong or missing something -- the next port reads it.
