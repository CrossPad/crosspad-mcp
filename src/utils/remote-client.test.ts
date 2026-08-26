import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "net";
import {
  sendRemoteCommand,
  isSimulatorRunning,
  closeSimConnection,
  isReadCommand,
} from "./remote-client.js";

// A stand-in for the simulator's TCP control server: newline-delimited JSON in,
// newline-delimited JSON out, and a record of everything it was asked to do.
// The sim itself is never needed — these are protocol defects, not sim defects.
class FakeSim {
  readonly received: Record<string, unknown>[] = [];
  readonly sockets: net.Socket[] = [];
  /** Return true to drop a command on the floor (the "sim is busy" case). */
  swallow: (cmd: string) => boolean = () => false;
  /** Milliseconds to wait before answering. */
  latencyMs = 0;

  constructor(private server: net.Server, readonly port: number) {}

  static async start(): Promise<FakeSim> {
    let self: FakeSim;
    const server = net.createServer((socket) => {
      self.sockets.push(socket);
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const cmd = JSON.parse(line) as Record<string, unknown>;
          self.received.push(cmd);
          if (self.swallow(String(cmd.cmd))) continue;
          const reply = JSON.stringify({ ok: true, echo: cmd.cmd, seq: self.received.length }) + "\n";
          if (self.latencyMs > 0) setTimeout(() => socket.write(reply), self.latencyMs);
          else socket.write(reply);
        }
      });
      socket.on("error", () => { /* the client tearing down mid-request */ });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    self = new FakeSim(server, (server.address() as net.AddressInfo).port);
    return self;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const s of this.sockets) s.destroy();
      this.server.close(() => resolve());
    });
  }
}

let sim: FakeSim;

beforeEach(async () => {
  sim = await FakeSim.start();
  process.env.CROSSPAD_REMOTE_PORT = String(sim.port);
  process.env.CROSSPAD_REMOTE_HOST = "127.0.0.1";
});

afterEach(async () => {
  closeSimConnection();
  await sim.close();
  delete process.env.CROSSPAD_REMOTE_PORT;
  delete process.env.CROSSPAD_REMOTE_HOST;
});

describe("isReadCommand", () => {
  it("knows the read commands", () => {
    for (const cmd of ["ping", "stats", "settings_get", "screenshot", "audio_level"]) {
      expect(isReadCommand(cmd)).toBe(true);
    }
  });

  it("treats every side-effecting command as non-retryable", () => {
    for (const cmd of ["pad_press", "pad_release", "encoder_rotate", "click", "key", "settings_set", "midi_note_on"]) {
      expect(isReadCommand(cmd)).toBe(false);
    }
  });

  it("defaults an unknown command to non-retryable", () => {
    // A command this table has not heard of might well have a side effect.
    expect(isReadCommand("some_future_command")).toBe(false);
  });
});

describe("one socket, one request at a time", () => {
  it("reuses a single connection across calls", async () => {
    await sendRemoteCommand({ cmd: "stats" });
    await sendRemoteCommand({ cmd: "stats" });
    await sendRemoteCommand({ cmd: "settings_get", category: "all" });
    expect(sim.sockets).toHaveLength(1);
  });

  it("reconnects after the connection is dropped", async () => {
    await sendRemoteCommand({ cmd: "stats" });
    closeSimConnection();
    await sendRemoteCommand({ cmd: "stats" });
    expect(sim.sockets).toHaveLength(2);
  });

  it("never has two requests in flight — REGRESSION: the sim's shared s_responseReady mixes up replies", async () => {
    sim.latencyMs = 25;
    let inFlight = 0;
    let maxInFlight = 0;
    sim.swallow = () => {
      // Count how many commands the sim is holding at once; the reply lands
      // one latency later, so the window overlaps if the client pipelines.
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => { inFlight--; }, 25);
      return false;
    };

    await Promise.all([
      sendRemoteCommand({ cmd: "stats" }),
      sendRemoteCommand({ cmd: "settings_get" }),
      sendRemoteCommand({ cmd: "audio_level" }),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it("hands each caller its own reply, in order", async () => {
    sim.latencyMs = 10;
    const replies = await Promise.all([
      sendRemoteCommand({ cmd: "stats" }),
      sendRemoteCommand({ cmd: "settings_get" }),
      sendRemoteCommand({ cmd: "audio_level" }),
    ]);
    expect(replies.map((r) => r.echo)).toEqual(["stats", "settings_get", "audio_level"]);
    expect(replies.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("keeps serving later requests after one fails", async () => {
    sim.swallow = (cmd) => cmd === "pad_press";
    await expect(sendRemoteCommand({ cmd: "pad_press", pad: 3 }, { timeoutMs: 60 })).rejects.toThrow(/timeout/i);
    const after = await sendRemoteCommand({ cmd: "stats" });
    expect(after.ok).toBe(true);
  });
});

describe("retry is for reads only", () => {
  it("does NOT re-send a timed-out pad_press — REGRESSION: v9 played three presses", async () => {
    sim.swallow = (cmd) => cmd === "pad_press";
    await expect(sendRemoteCommand({ cmd: "pad_press", pad: 3 }, { timeoutMs: 60 })).rejects.toThrow(/timeout/i);
    expect(sim.received.filter((c) => c.cmd === "pad_press")).toHaveLength(1);
  });

  it("does not re-send settings_set either", async () => {
    sim.swallow = (cmd) => cmd === "settings_set";
    await expect(sendRemoteCommand({ cmd: "settings_set", key: "kit", value: 3 }, { timeoutMs: 60 })).rejects.toThrow(/timeout/i);
    expect(sim.received.filter((c) => c.cmd === "settings_set")).toHaveLength(1);
  });

  it("retries a read that timed out", async () => {
    sim.swallow = (cmd) => cmd === "stats";
    await expect(sendRemoteCommand({ cmd: "stats" }, { timeoutMs: 40 })).rejects.toThrow(/timeout/i);
    expect(sim.received.filter((c) => c.cmd === "stats").length).toBeGreaterThan(1);
  });

  it("honours an explicit retry override", async () => {
    sim.swallow = (cmd) => cmd === "stats";
    await expect(sendRemoteCommand({ cmd: "stats" }, { timeoutMs: 40, retry: false })).rejects.toThrow(/timeout/i);
    expect(sim.received.filter((c) => c.cmd === "stats")).toHaveLength(1);
  });
});

describe("isSimulatorRunning", () => {
  it("is true when the control port answers a ping", async () => {
    expect(await isSimulatorRunning()).toBe(true);
  });

  it("is false — and quick — when nothing is listening", async () => {
    await sim.close();
    expect(await isSimulatorRunning()).toBe(false);
  });

  it("does not turn a probe into a retry ladder", async () => {
    sim.swallow = (cmd) => cmd === "ping";
    expect(await isSimulatorRunning()).toBe(false);
    expect(sim.received.filter((c) => c.cmd === "ping")).toHaveLength(1);
  }, 10000);
});
