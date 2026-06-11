# CrossPad r20 firmware — handy trace signals

Resolved from the Debug ELF DWARF. Names accept array/struct/expansion syntax
(`name`, `name[i]`, `name[i][j]`, `name.member`, `name[*]`, `name[a:b]`). Use
`crosspad_trace action=symbols query=<substr>` to discover more.

## Inputs (reg_map.c, `s_inputs[47]`, uint8)
| Spec | Meaning |
|---|---|
| `s_inputs[0]` | encoder detent index |
| `s_inputs[1]` | pads 8–15 bitmap (PADS_HI) |
| `s_inputs[2]` | pads 0–7 bitmap (PADS_LO) |
| `s_inputs[3..18]` | per-pad pressure 0..127 (pad 0 = `[3]`) |
| `s_inputs[44]` | buttons bitmap (0x2C) |
| `s_inputs[*]` | whole input block (expands to 47 scalars) |

## Power / ADC (power.c)
| Spec | Meaning |
|---|---|
| `s_adc_raw` | raw ADC DMA buffer, **15** uint16 channels (`ADC_BUF_SIZE`). `s_adc_raw[*]` plots all |
| `s_vbat_mv` | battery mV |
| `s_vbus_stm_mv` | VBUS (STM side) mV |
| `s_vbus_esp_mv` | VBUS (ESP side) mV |
| `s_temp_c` | die temp °C |

> NOTE: `s_adc_raw` is `[15]`, not 32 — indices ≥ 15 are rejected as out-of-bounds
> (the tracer bounds-checks against the DWARF array length).

## Built-in demo signals (trace_demo.c — RTT-style, for a quick self-test)
Cortex-M0+ has **no ITM/SWO**, so "printf over SWD" here is a RAM ring polled
non-intrusively. Flash the firmware, then watch:

| Spec | Meaning |
|---|---|
| `g_trace_demo.tick` | monotonic main-loop counter |
| `g_trace_demo.demo_sine` | fixed-point sine, [-1000,+1000] |
| `g_trace_demo.demo_triangle` | fixed-point triangle, [-1000,+1000] |
| `g_trace_demo.loop_hz` | estimated main-loop rate |
| `g_trace_log_wr` | text-ring write count (watch it climb = logging active) |

`g_trace_demo.demo_sine` is the ideal "does the whole pipeline work?" signal —
it should draw a clean sine in the UI.
