# Role: MCP / firmware user

You build and drive CrossPad firmware (mostly the PC simulator) and manage apps.
You are not editing the crosspad-mcp server itself.

## Typical loop (PC simulator)

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
| See the screen | `crosspad_screenshot` (file path; `return_inline` for base64) |
| Press pads / encoder / keys | `crosspad_input` (`action`: pad_press/release, encoder_*, click, key) |
| Send MIDI | `crosspad_midi` (`type`: note_on/off, cc, program_change) |
| Inspect runtime state | `crosspad_stats` (pads, capabilities, heap, apps) |
| Read/write settings | `crosspad_settings_get` / `crosspad_settings_set` |

## Flashing hardware

```
crosspad_build platform=idf            # build ESP-IDF firmware
crosspad_flash transport=uart          # or transport=ota with firmware_path
crosspad_log   target=idf              # read serial logs
crosspad_devices                       # list USB serial devices, flag CrossPads
```

## Managing apps (crosspad-apps registry)

| Want | Tool |
|------|------|
| List apps + where installed | `crosspad_apps_list` |
| Install an app (as submodule) | `crosspad_apps_install` (`platform`, `app_name`, `ref`, `force`) |
| Remove an app | `crosspad_apps_remove` |
| Update one / all apps | `crosspad_apps_update` (`app_name` or `update_all`) |
| Rebuild manifest from disk | `crosspad_apps_sync` |

Use these instead of manual `git submodule` operations.

## If something breaks

See `reference/faq.md` (repo not detected, sim won't start, build deps, …).
