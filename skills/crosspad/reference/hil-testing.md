# HIL testing — hardware-in-the-loop on the real CrossPad

The DUT is fully drivable over USB — flash, reset, press pads, load kits,
start apps, reroute audio, measure — no physical presence needed. All scripts
live in **platform-idf `tools/`** and exit 0 = PASS / 1 = FAIL / 2 = no device.

## USB topology (read this first — it costs an hour when guessed)

The host sees **two USB devices**, and they behave differently:

| Device | VID:PID | Carries | Gotchas |
|--------|---------|---------|---------|
| STM bridge "CrossPad MIDI+Serial" | `0483:5740` | ESP **console** (VCP), MIDI relay (`hw:3`) | Opening the VCP **pulses ESP reset** (bridge emulates esptool DTR/RTS). SysEx *requests* arrive through it, but **replies never come back this way**. |
| ESP native "Crosspad" | `303a:3456` | CDC control channel, MIDI (`hw:4`), UAC2 in audio mode | Disappears during reset. SysEx **replies come out only here**. |

- **ttyACM numbers shuffle on every re-enumeration** — always re-detect by
  VID:PID, never hardcode `ttyACM0`.
- **USB audio mode has NO ESP CDC** (the S3 runs out of IN endpoints —
  MIDI+UAC2 use them all). While recording, the only control channel is
  SysEx `0x1D` on the ESP's own MIDI port.
- Two processes on one ttyACM = "serial lost" → reopen → reset loop
  (`lsof /dev/ttyACMx` when in doubt). `npm test` in crosspad-mcp can also
  yank the DUT's serial ports — don't run it during a sensitive measurement.

## Standard workflow

```bash
crosspad_flash target=esp transport=ota            # or uart
crosspad-hil run smoke                             # ~10 s: boot markers, no E-lines, no boot loop
```

`smoke` is the gate after **every** flash. Its required markers are literal
log strings — update them when firmware log text changes (no compile-time
link). Exit code **0** passed, **1** firmware failed, **2** bench problem (no
board, port busy, missing extra). `--json` prints what the daemon hands the
MCP. The old `tools/hil_*.py` scripts are deprecated shims over this CLI.
The CLI is a pip package; in this workspace it is the editable install at
`~/GIT/crosspad-hil/.venv/bin/crosspad-hil`.

## Scenario map

| `crosspad-hil run …` | What it proves |
|---|---|
| `smoke` | boot health after a flash |
| `app_churn` | open/close every app; per-app internal-heap slope + crash watch |
| `back_churn` | `--depth` levels into every app, power-click back out; crash/launcher/heap |
| `kit_churn` | kit swaps while pads fire; `--rapid` spins the selector (coalescing path) |
| `fs_transfer` | CDC file round-trip (CRC + framing); `--assets <img>` reflashes the assets partition. Needs ~5 kB internal RAM on the board: with BLE up it exits 2 saying `BLE_STOP` first |
| `usb_mode_cycle` | CDC+MIDI <-> MIDI+UAC2 re-enumeration, heap, faults |
| `ble_midi` | BLE MIDI both ways from this PC's radio, both roles |
| `audio_loopback` | multitone out through UAC2, PCB loopback back; band power, glitches, dropouts |
| `sampler_record` / `speaker_acoustic` / `velocity` / `rt_glitch` | the sampler heard through UAC2 or the mics; velocity curve; clicks under load |
| `midi_stress` / `midi_bench` / `speedtest` | MIDI loss, throughput/latency on both ports, pad-rate ceiling |
| `stability` | overnight soak: resets, fatals, stalls, heap drift; `--stim-midi` |
| `led_state` / `waveform_cache` | LED model dump; does every pad get its waveform |
| `release_gate` | the whole chain in one report (smoke → … → stability), `--quick` for a CI-length dry run, `--keep-going` overnight |

Long runs (gate, soaks) from an agent: start them detached
(`setsid nohup … &`), never inside a tool call with a timeout, and kill by PID
— a `pkill -f` whose pattern appears in its own command line kills the shell
that issued it.

Results land in `hil_logs/` (gitignored).

## Remote control surface (firmware side, `main/hil_control.{h,cpp}`)

**CDC (default mode only):** `APP_LIST`, `APP_START <name>`, `APP_STOP`,
`APP_DESTROY` (tears down *without* rebuilding the launcher — exercises the
in-app back path; `APP_STOP` masks teardown bugs), `ENC_STATE`, `KIT_LIST`,
`KIT_LOAD <id>`, `PAD_PRESS <idx> [vel]`, `PAD_RELEASE`, `PAD_PRESSURE`,
`PAD_STATS` / `PAD_STATS_RESET` (accepted vs played vs freeslots — localizes
where hits are lost), `LVGL_STATS` (refresh/render/flush-wait and pixel counts since the last read — bracket a UI action with two calls), `AUDIO_TASKS 0|1`, `AUDIO_*` (routing, see below),
`AUDIO_LEVEL`, `APP_VERSIONS`, `STM_DFU` (drop STM into DFU → fully remote
STM update via `crosspad_flash target=stm method=dfu`).

**SysEx `0x1D`** (works in audio mode too; send to either port, listen on
ESP MIDI): `01` ADC input (0=DIFF 1=LINE1 2=LINE2), `02` USB-mic source codec,
`03` DAC out (1/2/3=ALL), `04` volume, `05` mute, `06` audio-tasks override (resume the RT mixer only when the pads are the source — with the host streaming it shares the I2S TX with the UAC bridge and the return comes back 1.8 % flat),
`07`/`08` pad press/release (full physical-pad path: pad logic + sample + LED),
`09` ECHO, `10` query → 9-byte state reply. Or use the `crosspad_audio_route`
MCP tool. Plain MIDI NoteOn does **not** trigger pad logic (LED only) — use
SysEx `07`/`08` for that.

## Traps (each one cost a real debugging session)

- **Order matters:** `KIT_LOAD` *before* `APP_START Sampler`, or the
  kit-selector overlay swallows it.
- **Audio routing is sticky between tests** and resets to defaults on reboot.
  The PCB loopback rides on **LINE1 of both codecs**; setting DAC1→LINE1 kills
  it (capture −120 dBFS). Restore: `F0 7D 1D 03 01 03 F7`. Tools must re-apply
  routing after device re-entry.
- **Every ADC input except codec0 LINE2 is an electrical DAC loopback** — it
  will "hear" a working speaker even with the amplifier physically off.
  codec0 LINE2 = the built-in mics. Acoustic claims need `--adc-input 2` plus
  an `--amp-off` negative control (~13 dB ON/OFF delta on the mics).
- **Amp gate cache:** ESP writes `REG_CTL_AUDIO_EN` only on decision *change*;
  if the STM (or you, over SWD) moves the pin behind ESP's back, the cache is
  stale and no write ever comes. After forcing `AMP_EN` low in a test, restore
  it, or every later run measures a dead amp for the wrong reason.
  `AUDIO_LEVEL` over CDC shows the gate's input and decision.
- **"The channel is not enabled" from I2S with timeout 0** actually means "the
  binary semaphore is held by another reader" (two readers on one I2S RX),
  not a disabled channel.
- **A log flood can kill the pad path itself:** ESP console shares the STM
  UART with the MIDI relay; error spam (e.g. FAT `no free file descriptors`,
  `max_files=20` in `bsp_sdmmc.c`) drops relay bytes, desyncs the SysEx
  parser, and pads stay dead **until reboot**. Corollary: throughput runs are
  poisoned after the first failure — measure each configuration from a fresh
  boot.
- **A clean carrier at MCLK/N on a codec output, data-independent** = a
  powered-down DAC stage leaking clock (ES8388 `DACPOWER` bits[7:6]), not a
  clock/VMID problem. Check power-down bits first.
- **Opening the STM VCP resets the ESP** (by design). The STM watchdog knows
  about externally-triggered resets (20 s boot window since STM ee87925) —
  if you see a 20.2 s reset cadence anyway, you're on old STM firmware.
- **SWD "Get IDCODE error" with VTref present** → suspect the ST-Link/SWD
  connector (it can hold NRST), replug it before blaming firmware.
