/**
 * TCP client for communicating with the CrossPad simulator's remote control server.
 * Protocol: newline-delimited JSON over TCP on localhost:19840.
 */

import { Socket } from "net";

const REMOTE_PORT = 19840;
const REMOTE_HOST = "127.0.0.1";
const CONNECT_TIMEOUT = 3000;
const RESPONSE_TIMEOUT = 15000;

export interface RemoteResponse {
  ok: boolean;
  [key: string]: unknown;
}

/**
 * Send a JSON command to the running simulator and return the response.
 * Opens a fresh TCP connection per call (simple, stateless).
 */
export function sendRemoteCommand(command: Record<string, unknown>): Promise<RemoteResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = "";
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
      }
    };

    // Connect timeout
    socket.setTimeout(CONNECT_TIMEOUT);

    socket.on("connect", () => {
      // Extend timeout for response
      socket.setTimeout(RESPONSE_TIMEOUT);

      // Send command as newline-delimited JSON
      const msg = JSON.stringify(command) + "\n";
      socket.write(msg);
    });

    socket.on("data", (data) => {
      buffer += data.toString();

      // Look for newline-delimited response
      const nlIdx = buffer.indexOf("\n");
      if (nlIdx >= 0) {
        const line = buffer.slice(0, nlIdx);
        resolved = true;
        socket.destroy();
        try {
          resolve(JSON.parse(line) as RemoteResponse);
        } catch {
          resolve({ ok: false, error: "invalid JSON response", raw: line });
        }
      }
    });

    socket.on("timeout", () => {
      cleanup();
      reject(new Error("Connection/response timeout — is the simulator running?"));
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === "ECONNREFUSED") {
        reject(new Error("Connection refused — simulator is not running or remote control is disabled. Start with crosspad_run first."));
      } else {
        reject(new Error(`TCP error: ${err.message}`));
      }
    });

    socket.on("close", () => {
      if (!resolved) {
        resolved = true;
        if (buffer.length > 0) {
          try {
            resolve(JSON.parse(buffer) as RemoteResponse);
          } catch {
            resolve({ ok: false, error: "incomplete response", raw: buffer });
          }
        } else {
          reject(new Error("Connection closed without response"));
        }
      }
    });

    socket.connect(REMOTE_PORT, REMOTE_HOST);
  });
}

/**
 * Check if the simulator's remote control server is reachable.
 */
export async function isSimulatorRunning(): Promise<boolean> {
  try {
    const resp = await sendRemoteCommand({ cmd: "ping" });
    return resp.ok === true;
  } catch {
    return false;
  }
}
