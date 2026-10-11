# Role: MCP / firmware user

You build and drive CrossPad firmware (mostly the PC simulator) and manage apps.
You are not editing the crosspad-mcp server itself.

First-time setup of the toolchain, the simulator and the board is on the site:
https://crosspad.app/docs/start-here/ (simulator:
https://crosspad.app/docs/start-here/pc-simulator/). Only `core` is on at
start — enable the toolset a tool lives in first, e.g.
`crosspad_toolsets action=enable toolset=sim` (`reference/tools.md`).

## Typical loop (PC simulator) — toolset `sim` (+ `crosspad_build` from `core`)

```
crosspad_check  platform=pc      # stale exe? new sources? submodule drift?
crosspad_build  platform=pc      # mode: incremental | clean | reconfigure; build_type for Debug/Release
crosspad_run    platform=pc      # launch sim, returns PID + TCP readiness probe
... interact (below) ...
crosspad_kill   platform=pc      # stop it when done
```

## Driving the running simulator

| Want | Tool |
|------|------|
| See the screen | `crosspad_screenshot` (file path; `return_inline` for base64 — ~50–150k tokens, only when you must look) |
| Press pads / encoder / keys | `crosspad_input` (`action`: pad_press/release, encoder_*, click, key) |
| Send MIDI | `crosspad_midi target=sim` (`type`: note_on/off, cc, program_change) — toolset `device` |
| Inspect runtime state | `crosspad_stats` (pads, capabilities, heap, apps) |
| Read/write settings | `crosspad_settings_get` / `crosspad_settings_set` |

## Flashing hardware

```
crosspad_devices                       # connected CrossPads, USB mode, port roles
crosspad_build platform=idf            # ESP-IDF firmware for the connected board's revision (board=v1|v2 to choose)
crosspad_flash target=esp transport=ota  # board already runs CrossPad firmware; returns a confirmation token
crosspad_console action=open            # board console → con_N, then action=read (toolset device); opening never reboots the board
crosspad_log   target=idf              # raw serial capture (toolset sim; reset_to_boot for a boot log)
```

OTA is the normal path; `transport=uart` is the fallback for a blank or
bricked board. On a shared bench, `crosspad_bench_claim` first
(`reference/hil-testing.md`). Human walkthroughs:
https://crosspad.app/docs/how-to/ota-update/ and
https://crosspad.app/docs/how-to/flash-uart/.

## Managing apps (crosspad-apps registry) — toolset `apps`

| Want | Tool |
|------|------|
| List apps + where installed | `crosspad_apps_list` |
| Install an app (as submodule) | `crosspad_apps_install` (`platform`, `app_name`, `ref`, `force`) |
| Remove an app | `crosspad_apps_remove` |
| Update one / all apps | `crosspad_apps_update` (`app_name` or `update_all`) |
| Rebuild manifest from disk | `crosspad_apps_sync` |

Use these instead of manual `git submodule` operations. After an install or
remove, rebuild with `crosspad_build platform=idf` (it fullcleans by itself
when it sees new app directories). The same flow by hand:
https://crosspad.app/docs/how-to/install-apps/.

## If something breaks

See `reference/faq.md` (repo not detected, sim won't start, build deps, …) and
https://crosspad.app/docs/troubleshooting/.
