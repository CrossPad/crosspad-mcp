// src/hil/console-logs.ts — which log file backs crosspad://device/{id}/console/log.
// Kept separate from HandleRegistry (whose meta is {kind, device} only) and kept
// after close(): the daemon keeps the file, so the resource must keep serving it.
export interface ConsoleLogEntry {
  handle: string;
  device: string;
  logPath: string;
  port: string;
}

export class ConsoleLogIndex {
  private readonly byHandleMap = new Map<string, ConsoleLogEntry>();
  private readonly byDeviceMap = new Map<string, ConsoleLogEntry>();

  set(e: ConsoleLogEntry): void {
    this.byHandleMap.set(e.handle, e);
    this.byDeviceMap.set(e.device, e);
  }

  byHandle(handle: string): ConsoleLogEntry | undefined {
    return this.byHandleMap.get(handle);
  }

  /** The most recently opened console for a device (survives close). */
  byDevice(device: string): ConsoleLogEntry | undefined {
    return this.byDeviceMap.get(device);
  }

  dropHandle(handle: string): void {
    this.byHandleMap.delete(handle);
  }

  list(): ConsoleLogEntry[] {
    return [...this.byDeviceMap.values()];
  }
}

export const consoleLogs = new ConsoleLogIndex();
