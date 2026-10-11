# Tool cheat-sheet — grouped by task

Only the `core` toolset is on when the server starts. The live list is
`crosspad_toolsets action=list`; `crosspad_toolsets action=enable toolset=<name>`
adds a toolset (at start: `--toolsets a,b`, `--toolsets all` or
`CROSSPAD_TOOLSETS`). Every tool with its hardware tag (`[PC]`, `[PC sim]`,
`[ESP HW]`, `[STM HW]`) and every resource:
https://crosspad.app/docs/reference/mcp-tools/. Don't trust a tool count
written anywhere — ask the server.

All tools return `{ success, ...data, error? }`; failures also set `isError: true`.
Read-only tools (status/search/list) skip client confirmation prompts.
Mutate-host tools (commit, submodule_update, apps_install/remove/update, clean
builds) are marked destructive, so the client asks before running them.
Danger-tier calls (flash, bootloader/DFU requests, SWD writes) answer
`resultType="confirmation_required"` with a token valid for 120 s: pass that token
and summary to `crosspad_confirm` right away (the client shows its own permission
prompt). `--read-only` removes every writing tool. `crosspad_flash` and
`crosspad_hil_run` return a `task_<n>` handle (`crosspad_task
action=status|wait|cancel|list`); builds and tests stream progress and return
inline.

**Version check.** `crosspad_confirm`, `crosspad_hil_triage` and the three
`crosspad_bench_*` tools exist on master only; the published npm
`crosspad-mcp-server@latest` (10.3.0) has none of them. On 10.3.0, confirm a
danger-tier call by re-issuing the identical call with `confirm_token="<token>"`
(the result's `hint` says so), use the `crosspad-hil bench` CLI for the lease, and
skip triage — or run a build of master (`reference/install.md` → "Developing
crosspad-mcp itself"). The start-up line on stderr names the version.

## core — always on
| Tool | Use |
|------|-----|
| `crosspad_devices` | Connected CrossPads from the crosspad-hil daemon: device id, USB mode, every port role (needs Python + crosspad-hil) |
| `crosspad_doctor` | Environment checks (crosspad-hil, ESP-IDF, repos, build dirs, ports, permissions), each with a fix |
| `crosspad_snapshot` | One-call state (`target: device\|sim`): apps, UI focus, kit, LEDs, pads, memory, BLE |
| `crosspad_build` | `platform: pc\|idf\|stm`; `mode: incremental\|clean\|fullclean` (IDF only)`\|reconfigure` (PC/STM); `build_type` (PC/STM); `board: v1\|v2` (IDF) |
| `crosspad_flash` | `target: esp` (`transport: ota\|uart`) or `target: stm` (`method: swd\|dfu`); `device`, `dry_run`, `wait_boot`, `delta_base`; needs confirmation |
| `crosspad_repo_status` | git status across all detected repos |
| `crosspad_toolsets` / `crosspad_task` / `crosspad_confirm` | Toolsets, long-running tasks, confirmations (above) |

### Shared bench — claim before touching the board
| Tool | Use |
|------|-----|
| `crosspad_bench_claim` | `holder` (your session name), `purpose`, `ttl_min?` → `granted`, or the holder + ETA + your queue `position` |
| `crosspad_bench_release` | `firmware_left` (what is on the board now) → next in queue gets it |
| `crosspad_bench_status` | Holder, queue, firmware left on the board, history |

Board-touching tools refuse with `BENCH_BUSY` while another session holds the
board. CLI and scripts: `crosspad-hil bench claim|release|status --holder NAME`
(or `CROSSPAD_BENCH_HOLDER`). Not in npm 10.3.0 — see "Version check" above.

## sim — PC simulator
| Tool | Use |
|------|-----|
| `crosspad_run` | Launch built simulator → PID + TCP readiness |
| `crosspad_kill` | Stop running simulator |
| `crosspad_check` | Health check: stale exe, new sources, drift |
| `crosspad_screenshot` | PNG saved under `<crosspad-pc>/screenshots/`; `return_inline=true` only when you must see it (~50–150k tokens) |
| `crosspad_input` | Input events (`action`: pad_press/release, encoder_*, click, key) |
| `crosspad_stats` | Runtime state: pads, capabilities, heap, apps |
| `crosspad_settings_get` / `crosspad_settings_set` | Read/write settings |
| `crosspad_test_run` | Build + run Catch2 suite (`filter`, `list_only`; `labels: ["gui"]` for the GUI harness) |
| `crosspad_log` | Capture logs (`target: pc\|idf`) |

## device — the board over USB (crosspad-hil daemon)
| Tool | Use |
|------|-----|
| `crosspad_cdc` | Typed CDC verbs (app, kit, pad, encoder, LED, memory, audio, BLE, system) or a raw command |
| `crosspad_console` | STM bridge console: open, read, expect, reset, snapshot, close |
| `crosspad_ui` | Drive the device UI by snapshot refs |
| `crosspad_midi` | `target: sim` + `type` (note_on/off, cc, program_change), or `target: device` + `action` (note, sysex, echo_rtt, query_route). Lives in `device` even for the sim |
| `crosspad_usb_mode` | Read/switch USB profile (default = MIDI + CDC, audio = MIDI + UAC2 — no CDC) |
| `crosspad_audio_route` | Codec inputs/outputs, volume, mute over SysEx |
| `crosspad_diagnose_crash` | Reset reason, registers, backtrace decoded against the flashed ELF, heap |

## hil — scenarios and measurements
| Tool | Use |
|------|-----|
| `crosspad_hil_run` | List/run crosspad-hil scenarios as a task (see `reference/hil-testing.md`) |
| `crosspad_hil_triage` | Advisory classification of a finished report (sends it to an external API; needs a key; master only) |
| `crosspad_capture` / `crosspad_analyze` | Record through the board's UAC2 endpoint / offline WAV verdicts |
| `crosspad_stimulus` | Play the pads at a rate or timed pattern |
| `crosspad_ble` | This computer's Bluetooth against the board's BLE MIDI |

## trace
`crosspad_trace` — real-time SWD variable trace (STM32); see the `swd-tracer` skill.

## code — search (no hardware)
| Tool | Use |
|------|-----|
| `crosspad_docs_search` | Search docs, BSP guides and skill pages by section |
| `crosspad_architecture` | Interfaces, implementations and capabilities in one call |
| `crosspad_symbol` | clangd: references, implementations, hover, call hierarchy, definition, outline |
| `crosspad_search_symbols` | Find class/function/macro/enum/typedef defs |
| `crosspad_list_interfaces` | List crosspad-core interfaces |
| `crosspad_interface_implementations` | Find implementations of an interface |
| `crosspad_capabilities` | Capability flags + per-platform sets |
| `crosspad_list_apps_source` | Apps registered via `REGISTER_APP()` |

## git — repo mutations
| Tool | Use |
|------|-----|
| `crosspad_repo_diff` | Submodule drift (crosspad-pc / platform-idf) |
| `crosspad_submodule_update` | Update submodule to `origin/<branch>` + stage (discards unpushed submodule commits) |
| `crosspad_commit` | Commit staged changes (refuses on conflicts; never pushes) |

## apps — package manager
| Tool | Use |
|------|-----|
| `crosspad_apps` | All of the below in one tool (`action`) |
| `crosspad_apps_list` | Apps from registry + where installed |
| `crosspad_apps_install` | Install app as submodule (`platform`, `app_name`, `ref`, `force`) |
| `crosspad_apps_remove` | Remove installed app submodule |
| `crosspad_apps_update` | Update one (`app_name`) or all (`update_all`) |
| `crosspad_apps_sync` | Rebuild manifest from disk |

## Resources (loadable without a tool call, whatever toolsets are on)
| URI | Use |
|-----|-----|
| `crosspad://workspace` | Detected repos, branches, HEADs, dirty counts, sim status |
| `crosspad://idf/status` | Board revision, build dirs, age of each built binary |
| `crosspad://devices`, `crosspad://device/{id}/state` | Devices / one fresh device snapshot |
| `crosspad://cdc`, `crosspad://sysex`, `crosspad://hil/catalog` | CDC verb, SysEx and HIL scenario catalogs |
| `crosspad://apps/registry/<platform>` | Raw `app-registry.json` per platform |
| `crosspad://apps/installed/<platform>` | Raw installed `apps.json` per platform |
| `crosspad://apps/registered/idf` | Apps the firmware will register, including installed components |
| `crosspad://symbols/{repo}/{symbol}` | Resolve one symbol in `<repo>` (or `all`) |

The rest (`trace`, `events`, `settings/schema`, `features`, console log,
`skill://`) are on the site's MCP reference.

> v8 note: platform/transport is an arg, not part of the tool name
> (e.g. `crosspad_build platform=pc`, not `crosspad_build_pc`).
