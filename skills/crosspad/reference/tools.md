# Tool cheat-sheet — grouped by task

28 tools. All return `{ success, ...data, error? }`; failures also set `isError: true`.
Read-only tools (status/search/list) skip client confirmation prompts; destructive
ones (commit, flash, clean build, apps_install) trigger one.

## Build & flash
| Tool | Use |
|------|-----|
| `crosspad_build` | Build `platform: pc\|idf` (`mode`, `build_type` for PC) |
| `crosspad_run` | Launch built simulator (`platform: pc`) → PID + TCP readiness |
| `crosspad_kill` | Stop running simulator (`platform: pc`) |
| `crosspad_check` | Health check (`platform: pc`): stale exe, new sources, drift |
| `crosspad_flash` | Flash firmware (`transport: uart\|ota`, `port?`, `firmware_path?`) |
| `crosspad_log` | Capture logs (`target: pc\|idf`) |
| `crosspad_devices` | List USB serial devices, flag CrossPads |
| `crosspad_trace` | Real-time SWD variable trace (STM32) — see the `swd-tracer` skill |

## Tests
| Tool | Use |
|------|-----|
| `crosspad_test_run` | Build + run Catch2 suite (`filter`, `list_only`) |

## Simulator interaction
| Tool | Use |
|------|-----|
| `crosspad_screenshot` | PNG screenshot (`return_inline` for base64) |
| `crosspad_input` | Input events (`action`: pad_press/release, encoder_*, click, key) |
| `crosspad_midi` | MIDI events (`type`: note_on/off, cc, program_change) |
| `crosspad_stats` | Runtime state: pads, capabilities, heap, apps |
| `crosspad_settings_get` / `crosspad_settings_set` | Read/write settings |

## Git / repos
| Tool | Use |
|------|-----|
| `crosspad_repo_status` | git status across all detected repos |
| `crosspad_repo_diff` | Submodule drift (crosspad-pc / platform-idf) |
| `crosspad_submodule_update` | Update submodule to `origin/<branch>` + stage |
| `crosspad_commit` | Commit staged changes (refuses on conflicts; never pushes) |

## Code search & scaffolding
| Tool | Use |
|------|-----|
| `crosspad_search_symbols` | Find class/function/macro/enum/typedef defs |
| `crosspad_list_interfaces` | List crosspad-core interfaces |
| `crosspad_interface_implementations` | Find implementations of an interface |
| `crosspad_capabilities` | Capability flags + per-platform sets |
| `crosspad_list_apps_source` | Apps registered via `REGISTER_APP()` |

## App package manager
| Tool | Use |
|------|-----|
| `crosspad_apps_list` | Apps from registry + where installed |
| `crosspad_apps_install` | Install app as submodule (`platform`, `app_name`, `ref`, `force`) |
| `crosspad_apps_remove` | Remove installed app submodule |
| `crosspad_apps_update` | Update one (`app_name`) or all (`update_all`) |
| `crosspad_apps_sync` | Rebuild manifest from disk |

## Resources (loadable without a tool call)
| URI | Use |
|-----|-----|
| `crosspad://workspace` | Detected repos, branches, HEADs, dirty counts, sim status |
| `crosspad://apps/registry/<platform>` | Raw `app-registry.json` per platform |
| `crosspad://apps/installed/<platform>` | Raw installed `apps.json` per platform |
| `crosspad://symbols/{repo}/{symbol}` | Resolve one symbol in `<repo>` (or `all`) |

> v8 note: platform/transport is an arg, not part of the tool name
> (e.g. `crosspad_build platform=pc`, not `crosspad_build_pc`).
