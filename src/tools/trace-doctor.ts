// src/tools/trace-doctor.ts
import fs from "fs";
import { runCommand } from "../utils/exec.js";
import { resolveConfigValue, loadUserConfig } from "../utils/userConfig.js";
import { STM_ELF_DEFAULT } from "../config.js";

// "error" is a synonym for "blocking" (PROTOCOL §11.7 spells the probe-presence
// issue as severity:"error"); both stop `start`. `ok` treats them identically.
export type Severity = "blocking" | "error" | "warning" | "info";

export interface DoctorIssue {
  id: string;
  severity: Severity;
  detail: string;
  suggested_fix: string;
}

export interface DoctorProbe {
  pyocdInstalled: () => boolean;
  elfPath: () => string;
  elfExists: () => boolean;
  stlinkProbe: () => { found: boolean; serial?: string; chipid?: string };
  udevRulesPresent: () => boolean;
  /** Which user-config keys are explicitly set (not on fallback). */
  configKeysSet: () => string[];
  /** §11.7 real probe-presence detection. Runs `pyocd list` (preferred, via the
   *  daemon python) or `st-info --probe` with a short timeout. `present` =
   *  at least one probe enumerated; `toolAvailable` distinguishes "no probe on
   *  USB" from "neither pyocd nor st-info installed" (the latter must NOT be a
   *  false "no probe"). */
  probeList?: () => Promise<{ present: boolean; toolAvailable: boolean }>;
}

export interface DoctorResult {
  ok: boolean; // false if any blocking issue
  issues: DoctorIssue[];
  probe?: { serial?: string; chipid?: string };
}

export async function runDoctor(p: DoctorProbe): Promise<DoctorResult> {
  const issues: DoctorIssue[] = [];

  if (!p.pyocdInstalled()) {
    issues.push({
      id: "pyocd_missing",
      severity: "blocking",
      detail: "pyocd Python package not importable — required to talk to the ST-Link.",
      suggested_fix: "Run: pip install pyocd pyelftools  (use the interpreter set in config key 'pyocd_python').",
    });
  }

  if (!p.elfExists()) {
    issues.push({
      id: "elf_missing",
      severity: "blocking",
      detail: `Firmware ELF not found at ${p.elfPath()} — symbol resolution needs it.`,
      suggested_fix: "Build a Debug firmware (cmake --build build/Debug) or set config key 'stm_elf_path' to the real ELF.",
    });
  }

  const probe = p.stlinkProbe();
  // st-info's negative is authoritative ONLY when the §11.7 probeList check
  // (`pyocd list` — the actual trace mechanism) isn't wired. stlinkProbe()
  // returns found:false when st-info is merely *not installed*, which must not
  // block tracing if pyocd can still enumerate the probe. When probeList is
  // present it owns probe presence (below), so skip this redundant block.
  if (!probe.found && !p.probeList) {
    issues.push({
      id: "probe_missing",
      severity: "blocking",
      detail: "No ST-Link probe detected (st-info --probe found nothing).",
      suggested_fix: "Connect the ST-Link, check the SWD cable and target power.",
    });
  }

  if (!p.udevRulesPresent()) {
    issues.push({
      id: "udev_missing",
      severity: "warning",
      detail: "No ST-Link udev rules found in /etc/udev/rules.d — pyOCD/libusb may be denied access without root.",
      suggested_fix:
        "Install ST-Link udev rules: write /etc/udev/rules.d/49-stlinkv2.rules (SUBSYSTEMS=='usb', ATTRS{idVendor}=='0483', ATTRS{idProduct}=='3748', MODE='0666'), then: sudo udevadm control --reload-rules && sudo udevadm trigger. (st-info succeeding only proves the current user already has access.)",
    });
  }

  // §11.7 real probe-presence check (distinct from the st-info `probe_missing`
  // above and from the udev warning). Blocks `start` so a vanished/replug-needed
  // ST-Link surfaces a clear, actionable error instead of a daemon connect hang.
  // "tool missing" (neither pyocd nor st-info installed) is a non-fatal note, not
  // a false "no probe".
  if (p.probeList) {
    const r = await p.probeList();
    if (!r.toolAvailable) {
      issues.push({
        id: "probe_list_tool_missing",
        severity: "info",
        detail: "Could not run a probe-presence check — neither `pyocd list` nor `st-info` is available.",
        suggested_fix: "Install pyocd (pip install pyocd) or stlink-tools (st-info) to enable USB probe detection.",
      });
    } else if (!r.present) {
      issues.push({
        id: "no_probe_detected",
        severity: "error",
        detail: "No ST-Link detected on USB (replug the probe).",
        suggested_fix: "Reconnect the ST-Link USB cable; verify with `pyocd list` / `lsusb`.",
      });
    }
  }

  if (p.configKeysSet().length === 0) {
    issues.push({
      id: "config_defaults",
      severity: "info",
      detail: "No user-config keys set — all paths are on built-in/env defaults.",
      suggested_fix: "After resolving the above, persist resolved paths with crosspad_trace action=config_set.",
    });
  }

  const ok = !issues.some((i) => i.severity === "blocking" || i.severity === "error");
  return { ok, issues, probe: probe.found ? { serial: probe.serial, chipid: probe.chipid } : undefined };
}

function resolvedElfPath(): string {
  return resolveConfigValue("stm_elf_path", "CROSSPAD_STM_ELF", process.env.CROSSPAD_STM_ELF, STM_ELF_DEFAULT);
}
function resolvedPython(): string {
  return resolveConfigValue("pyocd_python", "CROSSPAD_TRACE_PYTHON", process.env.CROSSPAD_TRACE_PYTHON, "python3");
}

/**
 * Production wiring: reads the actual filesystem, runs st-info, and imports
 * pyocd to validate the environment. Safe to call even when tools are absent.
 */
export function realProbe(): DoctorProbe {
  return {
    pyocdInstalled: () => {
      const r = runCommand(`${resolvedPython()} -c "import pyocd, elftools"`, process.cwd(), 10_000);
      return r.success;
    },
    elfPath: resolvedElfPath,
    elfExists: () => {
      try { return fs.existsSync(resolvedElfPath()); } catch { return false; }
    },
    stlinkProbe: () => {
      const r = runCommand("st-info --probe", process.cwd(), 10_000);
      if (!r.success || !/Found \d+ stlink/i.test(r.stdout)) return { found: false };
      const serial = r.stdout.match(/serial:\s*([0-9A-Fa-f]+)/)?.[1];
      const chipid = r.stdout.match(/chipid:\s*(0x[0-9A-Fa-f]+)/)?.[1];
      return { found: true, serial, chipid };
    },
    udevRulesPresent: () => {
      try {
        return fs.readdirSync("/etc/udev/rules.d").some((f) => /stlink|49-stlinkv/i.test(f));
      } catch { return false; }
    },
    configKeysSet: () => Object.keys(loadUserConfig()),
    // §11.7: enumerate USB probes. Prefer `pyocd list` (same python the daemon
    // uses, so it sees exactly what the trace will); fall back to `st-info
    // --probe`. Short timeouts — a wedged/absent probe must fail fast, not hang.
    probeList: async () => {
      // `<python> -m pyocd list` prints one row per probe; "No available debug
      // probes" (or an empty table) when none are connected.
      const py = runCommand(`${resolvedPython()} -m pyocd list`, process.cwd(), 8_000);
      if (py.success) {
        const present = /\b0\d{6,}|STLink|ST-LINK|\bstlink\b/i.test(py.stdout) && !/no available debug probes/i.test(py.stdout);
        // pyocd prints a header row even with 0 probes; treat an explicit
        // "No available debug probes" OR a body with no probe-id rows as empty.
        const hasRow = py.stdout.split("\n").some((l) => /^\s*\d+\s/.test(l));
        return { present: present || hasRow, toolAvailable: true };
      }
      // pyocd absent/failed → try st-info.
      const st = runCommand("st-info --probe", process.cwd(), 8_000);
      if (st.success || st.stdout.length > 0) {
        const present = /Found [1-9]\d* stlink/i.test(st.stdout);
        // st-info ran (even "Found 0 stlink programmers" is a successful run).
        const toolAvailable = /Found \d+ stlink/i.test(st.stdout) || st.success;
        return { present, toolAvailable };
      }
      // Neither tool produced usable output → tool missing, not "no probe".
      return { present: false, toolAvailable: false };
    },
  };
}
