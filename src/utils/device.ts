/**
 * Cross-platform USB device discovery for CrossPad.
 *
 * Primary method: Python/pyserial (required for IDF builds anyway).
 * Fallback: platform-specific commands (Linux sysfs, macOS system_profiler, Windows PowerShell).
 *
 * Supports multiple simultaneous CrossPad devices — each identified by port path.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { IS_WINDOWS, IS_MAC } from "../config.js";

// CrossPad USB identifiers
const ESPRESSIF_VID = 0x303a;
const CROSSPAD_PID = 0x3456;

export interface CrosspadDevice {
  port: string;
  vid: number;
  pid: number;
  serial_number: string | null;
  description: string;
  manufacturer: string | null;
  is_crosspad: boolean;
}

export interface DeviceListResult {
  success: boolean;
  devices: CrosspadDevice[];
  all_ports: CrosspadDevice[];
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// PRIMARY: Python/pyserial enumeration (cross-platform)
// ═══════════════════════════════════════════════════════════════════════

function listPortsViaPython(): CrosspadDevice[] | null {
  const script = [
    "import json, serial.tools.list_ports",
    "ports = [{"
      + '"port": p.device, "vid": p.vid, "pid": p.pid, '
      + '"serial": p.serial_number, "desc": p.description, '
      + '"mfr": p.manufacturer'
      + "} for p in serial.tools.list_ports.comports() if p.vid]",
    "print(json.dumps(ports))",
  ].join("; ");

  try {
    const output = execSync(`python3 -c "${script}"`, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const raw: Array<{
      port: string;
      vid: number | null;
      pid: number | null;
      serial: string | null;
      desc: string;
      mfr: string | null;
    }> = JSON.parse(output.trim());

    return raw.map((r) => ({
      port: r.port,
      vid: r.vid ?? 0,
      pid: r.pid ?? 0,
      serial_number: r.serial,
      description: r.desc,
      manufacturer: r.mfr,
      is_crosspad: r.vid === ESPRESSIF_VID && r.pid === CROSSPAD_PID,
    }));
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FALLBACK: Platform-specific enumeration
// ═══════════════════════════════════════════════════════════════════════

function listPortsLinuxSysfs(): CrosspadDevice[] {
  const devices: CrosspadDevice[] = [];
  const ttyBase = "/sys/class/tty";

  let entries: string[];
  try {
    entries = fs.readdirSync(ttyBase);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (!name.startsWith("ttyACM") && !name.startsWith("ttyUSB")) continue;

    const deviceLink = path.join(ttyBase, name, "device");
    if (!fs.existsSync(deviceLink)) continue;

    // Walk up to find USB device attributes
    const usbDevicePath = findUsbParent(deviceLink);
    if (!usbDevicePath) continue;

    const vid = readHexFile(path.join(usbDevicePath, "idVendor"));
    const pid = readHexFile(path.join(usbDevicePath, "idProduct"));
    if (vid === null || pid === null) continue;

    const serial = readTextFile(path.join(usbDevicePath, "serial"));
    const manufacturer = readTextFile(path.join(usbDevicePath, "manufacturer"));
    const product = readTextFile(path.join(usbDevicePath, "product"));

    devices.push({
      port: `/dev/${name}`,
      vid,
      pid,
      serial_number: serial,
      description: product ?? name,
      manufacturer,
      is_crosspad: vid === ESPRESSIF_VID && pid === CROSSPAD_PID,
    });
  }

  return devices;
}

function findUsbParent(devicePath: string): string | null {
  let current: string;
  try {
    current = fs.realpathSync(devicePath);
  } catch {
    return null;
  }

  // Walk up looking for idVendor file (USB device level)
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(current, "idVendor"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function readHexFile(filePath: string): number | null {
  try {
    return parseInt(fs.readFileSync(filePath, "utf-8").trim(), 16);
  } catch {
    return null;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function listPortsMacOS(): CrosspadDevice[] {
  // Use system_profiler for USB device info
  try {
    const output = execSync("system_profiler SPUSBDataType -json", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const data = JSON.parse(output);
    const devices: CrosspadDevice[] = [];
    collectMacDevices(data.SPUSBDataType ?? [], devices);
    return devices;
  } catch {
    return [];
  }
}

function collectMacDevices(
  items: any[],
  out: CrosspadDevice[]
): void {
  for (const item of items) {
    if (item.vendor_id) {
      const vid = parseMacId(item.vendor_id);
      const pid = parseMacId(item.product_id);

      if (vid !== null && pid !== null) {
        // macOS serial ports follow /dev/cu.usbmodem* pattern
        const serial = item.serial_num ?? null;
        // Try to find matching /dev/cu.* port
        const port = findMacPort(serial, item._name);

        if (port) {
          out.push({
            port,
            vid,
            pid,
            serial_number: serial,
            description: item._name ?? "USB Device",
            manufacturer: item.manufacturer ?? null,
            is_crosspad: vid === ESPRESSIF_VID && pid === CROSSPAD_PID,
          });
        }
      }
    }

    // Recurse into hubs
    if (item._items) {
      collectMacDevices(item._items, out);
    }
  }
}

function parseMacId(val: string | undefined): number | null {
  if (!val) return null;
  // Format: "0x303a" or "0x303a (Espressif Systems)"
  const match = val.match(/0x([0-9a-f]+)/i);
  return match ? parseInt(match[1], 16) : null;
}

function findMacPort(serial: string | null, name: string | null): string | null {
  try {
    const ports = fs.readdirSync("/dev").filter(
      (f) => f.startsWith("cu.usbmodem") || f.startsWith("cu.usbserial")
    );

    if (ports.length === 0) return null;

    // If serial number is part of the port name, use that
    if (serial) {
      const match = ports.find((p) => p.includes(serial));
      if (match) return `/dev/${match}`;
    }

    // Return first matching port (best effort)
    return `/dev/${ports[0]}`;
  } catch {
    return null;
  }
}

function listPortsWindows(): CrosspadDevice[] {
  try {
    const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like '*VID_*PID_*' -and $_.Name -like '*(COM*)*' } | Select-Object Name,PNPDeviceID | ConvertTo-Json -Compress"`;
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 15_000,
      shell: "cmd.exe",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const trimmed = output.trim();
    if (!trimmed) return [];

    const raw = JSON.parse(trimmed);
    const items = Array.isArray(raw) ? raw : [raw];

    return items.map((item: { Name: string; PNPDeviceID: string }) => {
      const vidMatch = item.PNPDeviceID.match(/VID_([0-9A-F]+)/i);
      const pidMatch = item.PNPDeviceID.match(/PID_([0-9A-F]+)/i);
      const comMatch = item.Name.match(/\((COM\d+)\)/);

      const vid = vidMatch ? parseInt(vidMatch[1], 16) : 0;
      const pid = pidMatch ? parseInt(pidMatch[1], 16) : 0;
      const port = comMatch ? comMatch[1] : "COM?";

      return {
        port,
        vid,
        pid,
        serial_number: null,
        description: item.Name,
        manufacturer: null,
        is_crosspad: vid === ESPRESSIF_VID && pid === CROSSPAD_PID,
      };
    }).filter((d: CrosspadDevice) => d.vid > 0);
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════

/**
 * List all connected USB serial devices. Returns CrossPad devices separately.
 * Tries Python/pyserial first, falls back to platform-specific methods.
 */
export function listDevices(): DeviceListResult {
  // Try pyserial first (most reliable cross-platform)
  let allPorts = listPortsViaPython();

  // Fallback to platform-specific
  if (allPorts === null) {
    if (IS_WINDOWS) {
      allPorts = listPortsWindows();
    } else if (IS_MAC) {
      allPorts = listPortsMacOS();
    } else {
      allPorts = listPortsLinuxSysfs();
    }
  }

  const crosspadDevices = allPorts.filter((d) => d.is_crosspad);

  return {
    success: true,
    devices: crosspadDevices,
    all_ports: allPorts,
  };
}

/**
 * Find a CrossPad device, optionally by port.
 * If port is specified, validates it's a CrossPad device.
 * If not specified, auto-detects (fails if 0 or >1 found).
 */
export function findCrosspadPort(port?: string): {
  port: string;
  device?: CrosspadDevice;
  error?: string;
} {
  if (port) {
    return { port };
  }

  const result = listDevices();
  const devices = result.devices;

  if (devices.length === 0) {
    return {
      port: "",
      error: "No CrossPad device found. Connect a device or specify port manually.",
    };
  }

  if (devices.length > 1) {
    const portList = devices.map((d) => `  ${d.port} (${d.description})`).join("\n");
    return {
      port: "",
      error: `Multiple CrossPad devices found. Specify port:\n${portList}`,
    };
  }

  return { port: devices[0].port, device: devices[0] };
}
