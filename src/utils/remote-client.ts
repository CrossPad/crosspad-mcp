/**
 * TCP client for communicating with the CrossPad simulator's remote control server.
 * Protocol: newline-delimited JSON over TCP on localhost:19840.
 *
 * Two rules here are not style choices, they are defects this file exists to
 * not repeat (spec §3.8):
 *
 *  • One socket, one request at a time. The simulator parks every non-ping
 *    command on a single process-wide `s_responseReady` flag, so two requests
 *    in flight can each be handed the other's reply — and opening a second
 *    socket does not help, because the flag is shared by all of them.
 *  • Only reads are retried. v9 retried whatever timed out, so one slow
 *    `pad_press` became three presses the sim actually played.
 */

import { Socket } from "net";
import { z } from "zod";

/**
 * Minimal contract enforced on every TCP simulator response.
 * Body must be a JSON object with `ok` boolean. Anything else (array, scalar,
 * missing `ok`) is treated as a malformed response — caller gets a synthetic
 * `{ok:false, error:"..."}` so downstream code can rely on the shape.
 */
const RemoteEnvelopeSchema = z.object({ ok: z.boolean() }).passthrough();

function parseRemoteResponse(raw: string): RemoteResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON response", raw };
  }
  const result = RemoteEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: "malformed response (expected object with `ok` boolean)", raw };
  }
  return result.data as RemoteResponse;
}

// Read at connect time rather than at import time so a test can point the
// client at a fake server it started after loading the module.
function remotePort(): number {
  const raw = process.env.CROSSPAD_REMOTE_PORT;
  if (!raw) return 19840;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 19840;
}
function remoteHost(): string {
  return process.env.CROSSPAD_REMOTE_HOST || "127.0.0.1";
}

const CONNECT_TIMEOUT = 3000;
const RESPONSE_TIMEOUT = 15000;
const PROBE_TIMEOUT = 2000;

export interface RemoteResponse {
  ok: boolean;
  [key: string]: unknown;
}

export interface SendOptions {
  /** Response timeout in ms. Default 15 s — a kit load parks the LVGL thread. */
  timeoutMs?: number;
  /** Force the retry decision. Defaults to "only if the command is a read". */
  retry?: boolean;
}

/**
 * Commands that only read simulator state, and so may be sent again after a
 * timeout. Every other command — and every command this list has not heard of
 * — is sent exactly once, because a lost reply is cheaper than a duplicated
 * pad hit, encoder step or settings write.
 */
const READ_COMMANDS = new Set([
  "ping",
  "stats",
  "settings_get",
  "screenshot",
  "audio_level",
  "citest_status",
]);

/** Whether `cmd` may be re-sent when the first attempt times out. */
export function isReadCommand(cmd: unknown): boolean {
  return typeof cmd === "string" && READ_COMMANDS.has(cmd);
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── the one connection ──────────────────────────────────────────────────────

interface Waiter {
  resolve: (r: RemoteResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  socket: Socket;
  buffer: string;
  waiter: Waiter | null;
}

let conn: Conn | null = null;

/**
 * Tear a connection down and fail whatever was waiting on it.
 *
 * The connection is named explicitly rather than assumed to be the current
 * one: a socket that closes late belongs to a launch that is already over, and
 * dropping "whatever is current" would take out its replacement.
 */
function dropConnection(reason: Error, target: Conn | null = conn): void {
  if (!target) return;
  if (conn === target) conn = null;
  target.socket.removeAllListeners();
  target.socket.destroy();
  const waiter = target.waiter;
  if (waiter) {
    target.waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(reason);
  }
}

/** Close the socket (simulator killed, tests). The next send reconnects. */
export function closeSimConnection(): void {
  dropConnection(new Error("Connection closed"));
}

function connect(): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const c: Conn = { socket, buffer: "", waiter: null };
    let settled = false;

    socket.setTimeout(CONNECT_TIMEOUT);

    socket.on("connect", () => {
      // The connect timeout must not double as a response timeout: each
      // request carries its own, and a socket idle between requests is
      // normal.
      socket.setTimeout(0);
      settled = true;
      conn = c;
      resolve(c);
    });

    socket.on("data", (data) => {
      c.buffer += data.toString();
      // Replies are newline-delimited and, because only one request is ever in
      // flight, the first complete line is this request's reply.
      const nlIdx = c.buffer.indexOf("\n");
      if (nlIdx < 0) return;
      const line = c.buffer.slice(0, nlIdx);
      c.buffer = c.buffer.slice(nlIdx + 1);
      const waiter = c.waiter;
      if (!waiter) return;
      c.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(parseRemoteResponse(line));
    });

    socket.on("timeout", () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("Connection/response timeout — is the simulator running?"));
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      const e =
        err.code === "ECONNREFUSED"
          ? new Error("Connection refused — simulator is not running or remote control is disabled. Start with crosspad_run first.")
          : new Error(`TCP error: ${err.message}`);
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(e);
        return;
      }
      dropConnection(e, c);
    });

    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Connection closed without response"));
        return;
      }
      dropConnection(new Error("Connection closed without response"), c);
    });

    socket.connect(remotePort(), remoteHost());
  });
}

function exchange(c: Conn, command: Record<string, unknown>, timeoutMs: number): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // A late reply would land on the *next* request's read, so a timed-out
      // socket is thrown away rather than reused.
      dropConnection(new Error("Connection/response timeout — is the simulator running?"), c);
    }, timeoutMs);
    c.waiter = { resolve, reject, timer };
    c.socket.write(JSON.stringify(command) + "\n", (err) => {
      if (!err) return;
      dropConnection(new Error(`TCP error: ${err.message}`), c);
    });
  });
}

async function sendOnce(command: Record<string, unknown>, timeoutMs: number): Promise<RemoteResponse> {
  const c = conn ?? (await connect());
  return exchange(c, command, timeoutMs);
}

// Requests are serialized through this chain — see the header note about
// `s_responseReady`. A rejected request must not poison the queue, hence the
// swallow on both settle paths.
let gate: Promise<unknown> = Promise.resolve();

/**
 * Send a JSON command to the running simulator and return the response.
 * Requests never overlap; a read that times out is retried, a command with a
 * side effect is not.
 */
export function sendRemoteCommand(
  command: Record<string, unknown>,
  options: SendOptions = {},
): Promise<RemoteResponse> {
  const run = gate.then(
    () => sendSerialized(command, options),
    () => sendSerialized(command, options),
  );
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function sendSerialized(command: Record<string, unknown>, options: SendOptions): Promise<RemoteResponse> {
  const timeoutMs = options.timeoutMs ?? RESPONSE_TIMEOUT;
  const attempts = (options.retry ?? isReadCommand(command.cmd)) ? MAX_RETRIES : 1;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await sendOnce(command, timeoutMs);
    } catch (err: any) {
      lastError = err;
      // Connection refused means the simulator is not there — a second try
      // will find the same nothing.
      if (err.message?.includes("Connection refused")) throw err;
      if (attempt < attempts) await delay(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError!;
}

/**
 * Check if the simulator's remote control server is reachable. One short
 * attempt: callers poll this in a loop, so a retry ladder here would only make
 * "not up yet" take a minute to answer.
 */
export async function isSimulatorRunning(): Promise<boolean> {
  try {
    const resp = await sendRemoteCommand({ cmd: "ping" }, { timeoutMs: PROBE_TIMEOUT, retry: false });
    return resp.ok === true;
  } catch {
    return false;
  }
}
