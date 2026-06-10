// src/tools/trace-doctor.ts
import fs from "fs";
import { runCommand } from "../utils/exec.js";
import { resolveConfigValue, loadUserConfig } from "../utils/userConfig.js";
import { STM_ELF_DEFAULT } from "../config.js";

export type Severity = "blocking" | "warning" | "info";

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
}

export interface DoctorResult {
  ok: boolean; // false if any blocking issue
  issues: DoctorIssue[];
  probe?: { serial?: string; chipid?: string };
}

export function runDoctor(p: DoctorProbe): DoctorResult {
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
  if (!probe.found) {
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

  if (p.configKeysSet().length === 0) {
    issues.push({
      id: "config_defaults",
      severity: "info",
      detail: "No user-config keys set — all paths are on built-in/env defaults.",
      suggested_fix: "After resolving the above, persist resolved paths with crosspad_trace action=config_set.",
    });
  }

  const ok = !issues.some((i) => i.severity === "blocking");
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
  };
}
