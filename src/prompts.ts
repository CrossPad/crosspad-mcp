// User-selectable workflows (slash commands in most clients).
//
// Each one is a short numbered plan that names the tools to call and, after
// every step, the state check that proves it worked — because on this hardware
// "the command returned OK" is not evidence: `OK` is not the ack of *your*
// command under traffic, and the board re-enumerates on reset. Spec §3.4.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface PromptSpec {
  name: string;
  title: string;
  description: string;
  argsSchema?: Record<string, z.ZodType<string | undefined>>;
  /** Build the plan text from the (optional) arguments. */
  plan: (args: Record<string, string | undefined>) => string;
}

const Optional = z.string().optional();

/** Every prompt this server offers, in listing order. */
export const PROMPTS: PromptSpec[] = [
  {
    name: "flash-and-smoke",
    title: "Flash and prove it booted",
    description:
      "Build (optional), flash over OTA and confirm the board came back with a complete boot.",
    argsSchema: { firmware: Optional, device: Optional },
    plan: ({ firmware, device }) => `Flash the CrossPad and prove it booted.

1. \`crosspad_devices\` — confirm exactly one board and note its id${device ? ` (expected: ${device})` : ""}.
   If two boards answer, every later call must pass \`device\`.
2. \`crosspad_flash\` with \`target: "esp"\`, \`transport: "ota"\`, \`wait_boot: true\`${
      firmware ? `, \`firmware: "${firmware}"\`` : ""
    }.
   It returns a preflight first and asks for confirmation: read the summary out
   loud (firmware version, board revision, port role) before re-issuing the
   identical call with \`confirm_token\`. A revision-mismatch warning is a reason
   to stop, not a formality.
3. Poll \`crosspad_task\` with \`action: "status"\` until the job leaves \`working\`.
   The result carries \`boot\`: \`complete: true\` with an empty \`missing\` list is
   the pass. \`bootloops > 0\` means it is restarting in a loop — stop and read
   the console log.
4. \`crosspad_snapshot\` — the launcher should list its apps again.

If step 3 reports fatals, run the \`diagnose\` prompt instead of flashing again.`,
  },
  {
    name: "jam",
    title: "Play something and check it came out",
    description:
      "Start the Sampler, load a kit, play a pattern, record it back and confirm the hits are audible.",
    argsSchema: { kit: Optional, pads: Optional },
    plan: ({ kit, pads }) => `Play the CrossPad and verify what came out of it.

1. \`crosspad_snapshot\` with \`target: "device"\` — note the running app and the
   encoder refs. This is your before-picture.
2. \`crosspad_cdc\` \`{verb: "app", action: "start", name: "Sampler"}\`.
   Then \`crosspad_cdc\` \`{verb: "kit", action: "list"}\` and load one with
   \`{verb: "kit", action: "load", kit_id: ${kit ?? "<id>"}, wait: true}\`.
   Loading is asynchronous — \`wait: true\` is what makes the reply mean "landed".
3. \`crosspad_cdc\` \`{verb: "pad", action: "stats", reset: true}\` to zero the counters.
4. Start recording: \`crosspad_capture\` \`{action: "start", seconds: 6, preset: "headphone"}\`.
   The headphone preset records the DAC→ADC loop; the mics would pick up the room.
5. Play: \`crosspad_stimulus\` \`{action: "start", pads: [${pads ?? "0, 4, 8, 12"}], pattern: [...], humanize_ms: 8}\`
   — compose a pattern with real timings rather than a metronome.
6. \`crosspad_capture\` \`{action: "stop"}\`, then \`crosspad_analyze\`
   \`{kind: "onset", wav: <path>, expected: <the pattern's t_ms list>}\`.
7. Report three things: how many hits landed (\`pad_stats.played\` vs what you
   sent), how many onsets the recording actually contains, and the latency
   spread. \`silent: true\` on the capture means the mixer was parked — resume the
   audio tasks and record again rather than reporting silence as a failed play.`,
  },
  {
    name: "diagnose",
    title: "Explain a crash",
    description:
      "Turn a panic on the console into decoded source lines, memory state and a likely cause.",
    argsSchema: { device: Optional, log_file: Optional },
    plan: ({ device, log_file }) => `Explain what crashed on the CrossPad.

1. ${
      log_file
        ? `Use the captured log: \`${log_file}\`.`
        : `\`crosspad_console\` \`{action: "open"${device ? `, device: "${device}"` : ""}}\`, then
   \`{action: "snapshot", handle: <con_N>}\`. Non-zero \`reboots\` or a non-empty
   \`fatals\` is what you are chasing.`
    }
2. \`crosspad_diagnose_crash\` — it decodes the backtrace against the ELF of the
   build that is actually flashed, and returns the reset reason, the panic
   registers, the decoded frames, the heap after the restart and the surrounding
   console lines as a link.
3. Read the frames from the bottom up: the deepest CrossPad frame (not the LVGL
   or FreeRTOS ones above it) is where to look first.
4. Say plainly whether the reset was a fault (PANIC/WDT/BROWNOUT) or an ordinary
   restart — \`TG0WDT_SYS_RST\` and friends are reboots, not faults.
5. If the log shows the reboot happening as the console was opened, that reset
   is yours: opening the bridge VCP resets the ESP. Discount it.`,
  },
  {
    name: "audio-capture",
    title: "Record the device through its own USB",
    description:
      "Switch to the USB-audio profile, route the loop, record and restore the default profile.",
    argsSchema: { seconds: Optional, preset: Optional },
    plan: ({ seconds, preset }) => `Record the CrossPad through its own UAC2 endpoint.

1. \`crosspad_usb_mode\` \`{action: "get"}\` — note the profile so you can put it back.
2. \`crosspad_capture\` \`{action: "start", seconds: ${seconds ?? 5}, preset: "${preset ?? "headphone"}"}\`.
   The tool enters the audio profile, resumes the RT mixer and picks the route
   itself. Two things it is protecting you from: in the audio profile there is no
   CDC endpoint at all, and the mixer is parked on entry, so a capture taken
   without resuming it is silent.
3. Drive whatever you want to hear (\`crosspad_stimulus\`, or play the pads by hand).
4. \`crosspad_capture\` \`{action: "stop"}\` → the WAV comes back as a link with
   \`peak_dbfs\`, \`rms_dbfs\`, \`overruns\` and \`silent\`.
5. \`crosspad_analyze\` with the kind that answers your question: \`onset\` for hits,
   \`click\` for glitches, \`psd\` for spectral content, \`silence\` to prove a path is dead.
6. \`crosspad_usb_mode\` \`{action: "set", mode: "default"}\` — do this even if a step
   failed, otherwise the CDC control path stays gone.`,
  },
  {
    name: "kit-churn-live",
    title: "Swap kits while the pads keep firing",
    description:
      "Run the kit-swap soak that plays during every swap, and read its report honestly.",
    argsSchema: { rounds: Optional, rapid: Optional },
    plan: ({ rounds, rapid }) => `Stress kit loading the way a performance does.

1. \`crosspad_hil_run\` \`{scenario: "kit_churn", params: {rounds: ${rounds ?? 20}${
      rapid ? `, rapid: ${rapid}` : ""
    }}}\` → a task handle.
2. Poll \`crosspad_task\` until it finishes; the progress messages name the round
   and the kit.
3. The point of this scenario is that pads fire *during* the swap. Before calling
   a green run a pass, check the per-round hit counts: a run where nothing played
   inside the swap window proves nothing, and the scenario fails itself for that
   reason.
4. \`rapid\` fires requests faster than a load completes, so every request after
   the first meets a busy loader. The assertion is that the burst settles on the
   *last* kit asked for — not that every request was honoured.
5. If it fails, the artifacts include the console log; look for
   \`hil_control: KIT_LOAD n queued|started\` to see what the device actually received.`,
  },
  {
    name: "pr-ready",
    title: "Get a change ready to push",
    description: "Test, review the working tree and submodule pins, then commit.",
    argsSchema: { message: Optional },
    plan: ({ message }) => `Get this change ready to hand over.

1. \`crosspad_test_run\` — the PC test suite. A failure here ends the workflow.
2. \`crosspad_repo_status\` — every repo's branch, dirty files and submodule sync
   state in one call. Anything dirty that you did not touch is worth asking about
   before committing over it.
3. \`crosspad_repo_diff\` — check whether crosspad-core / crosspad-gui pins moved.
   A moved pin that you did not intend is the usual cause of "it builds here".
4. If the change touches firmware, flash it and run the \`flash-and-smoke\` prompt:
   a green PC suite says nothing about the board.
5. \`crosspad_commit\`${message ? ` with message: "${message}"` : ""} — it refuses on
   conflicts and never pushes. Pushing stays a human decision.`,
  },
];

/** Register every prompt. Returns the names registered, in order. */
export function registerPrompts(server: McpServer): string[] {
  const names: string[] = [];
  for (const spec of PROMPTS) {
    server.registerPrompt(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        ...(spec.argsSchema ? { argsSchema: spec.argsSchema } : {}),
      },
      (args: Record<string, string | undefined>) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: spec.plan(args ?? {}) },
          },
        ],
      }),
    );
    names.push(spec.name);
  }
  return names;
}
