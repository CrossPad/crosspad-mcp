// src/hil/select.ts — the TS half of devices.py discover()+select(). The daemon
// re-resolves `device` on every op, so this module never caches: it exists so a
// tool can name the device it is about to act on, refuse the wrong port role,
// and produce the same NO_DEVICE / AMBIGUOUS_DEVICE errors the daemon would.
import { HilError } from "./daemon.js";
import { DeviceSchema, type Device } from "./schemas.js";

export interface DaemonRequester {
  request<T = unknown>(
    op: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>;
}

/** devices.list {} → parsed Device rows, in daemon order. */
export async function listHilDevices(daemon: DaemonRequester, signal?: AbortSignal): Promise<Device[]> {
  const raw = await daemon.request<{ devices: unknown[] }>("devices.list", {}, signal ? { signal } : undefined);
  return (raw.devices ?? []).map((d) => DeviceSchema.parse(d));
}

/** True when the device has an ESP-side port (cdc or bootloader) — devices.py select(). */
export function espSide(d: Device): boolean {
  return !!d.ports.cdc || !!d.ports.bootloader;
}

/** Every serial port this device owns, tagged with its role. */
export function portPaths(d: Device): Array<{ role: "cdc" | "console" | "bootloader"; path: string }> {
  const out: Array<{ role: "cdc" | "console" | "bootloader"; path: string }> = [];
  if (d.ports.cdc) out.push({ role: "cdc", path: d.ports.cdc.path });
  if (d.ports.console) out.push({ role: "console", path: d.ports.console.path });
  if (d.ports.bootloader) out.push({ role: "bootloader", path: d.ports.bootloader.path });
  return out;
}

/** Which role a path plays on this device, or null when it is not one of its ports. */
export function roleOfPort(d: Device, path: string): "cdc" | "console" | "bootloader" | null {
  return portPaths(d).find((p) => p.path === path)?.role ?? null;
}

/**
 * devices.py select(): no argument → the single device with an ESP side;
 * an argument → the device with that id, or the device owning that port path.
 */
export function pickDevice(devices: Device[], device?: string): Device {
  const candidates = devices.map((d) => d.id);
  if (device === undefined || device === "") {
    const withEsp = devices.filter(espSide);
    if (withEsp.length === 1) return withEsp[0];
    if (withEsp.length === 0) {
      throw new HilError(
        "NO_DEVICE",
        "no CrossPad found; is it in bootloader/DFU?",
        "Check the cable, then run crosspad_devices — a device seen only as an STM32 bridge console has no ESP side to talk to.",
        { candidates },
      );
    }
    throw new HilError(
      "AMBIGUOUS_DEVICE",
      `${withEsp.length} CrossPads are connected; say which one.`,
      `pass device=<id> (one of ${withEsp.map((d) => d.id).join(", ")})`,
      { candidates: withEsp.map((d) => d.id) },
    );
  }
  const byId = devices.find((d) => d.id === device);
  if (byId) return byId;
  const byPort = devices.find((d) => roleOfPort(d, device) !== null);
  if (byPort) return byPort;
  throw new HilError(
    "NO_DEVICE",
    `no CrossPad matches "${device}"`,
    "pass a device id from crosspad_devices, or one of its port paths",
    { candidates },
  );
}
