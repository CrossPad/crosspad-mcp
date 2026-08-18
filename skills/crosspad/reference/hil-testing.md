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
crosspad_flash target=esp transport=ota      # or uart
python3 tools/hil_smoke.py                   # 30 s: boot markers, no E-lines, no boot loop
```

`hil_smoke.py` is the gate after **every** flash. Its REQUIRED_MARKERS are
literal log strings — update the list when firmware log text changes (there is
no compile-time link).

## Tool map

| Script | What it proves |
|--------|----------------|
| `hil_smoke.py` | Boot health after flash (`--flash` to OTA first, `--json` for CI) |
| `hil_stability.py` | Long soak: resets + reason + 300-line pre-reset context, heap trend from PerfMon heartbeat (silence >90 s = STALL), optional `--stim-midi` |
| `hil_audio_loopback.py` | USB audio end-to-end: multitone out → PCB loopback → capture; band power, glitches, dropouts. `--capture-path loop` = codec1 LINE1 (near-unity; keep amp ≤0.15, it compresses above 0.2 FS) |
| `hil_midi_stress.py` / `hil_midi_bench.py` | SysEx burst loss + dual-path (ESP vs STM bridge) throughput/latency via ECHO `0x1D/0x09` |
| `hil_velocity.py` | Velocity reaches the sample engine |
| `hil_speedtest.py` | Pad-trigger throughput vs loss, using PAD_STATS counters |
| `hil_rt_glitch.py` | RT mixer + sampler under pad load — click/glitch measurement |
| `hil_led_state.py` | Pad-LED model dump — diagnosing dark pads |
| `hil_speaker_acoustic.py` | Acoustic proof via built-in mics (`--adc-input 2`), incl. `--amp-off` negative control |
| `glitch_capture.py` / `glitch_analyze.py` | Raw capture + 2nd-difference glitch analysis; domain-bisection workhorse |

Results land in `hil_logs/` (gitignored).

## Remote control surface (firmware side, `main/hil_control.{h,cpp}`)

**CDC (default mode only):** `APP_LIST`, `APP_START <name>`, `APP_STOP`,
`APP_DESTROY` (tears down *without* rebuilding the launcher — exercises the
in-app back path; `APP_STOP` masks teardown bugs), `ENC_STATE`, `KIT_LIST`,
`KIT_LOAD <id>`, `PAD_PRESS <idx> [vel]`, `PAD_RELEASE`, `PAD_PRESSURE`,
`PAD_STATS` / `PAD_STATS_RESET` (accepted vs played vs freeslots — localizes
where hits are lost), `AUDIO_TASKS 0|1`, `AUDIO_*` (routing, see below),
`AUDIO_LEVEL`, `APP_VERSIONS`, `STM_DFU` (drop STM into DFU → fully remote
STM update via `crosspad_flash target=stm method=dfu`).

**SysEx `0x1D`** (works in audio mode too; send to either port, listen on
ESP MIDI): `01` ADC input (0=DIFF 1=LINE1 2=LINE2), `02` USB-mic source codec,
`03` DAC out (1/2/3=ALL), `04` volume, `05` mute, `06` audio-tasks override,
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
