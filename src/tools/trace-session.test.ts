import { describe, it, expect, vi } from "vitest";
import { parseFrame, TraceSession } from "./trace-session.js";

describe("parseFrame", () => {
  it("parses a sample frame", () => {
    const f = parseFrame('{"type":"sample","t":1.5,"values":{"a":7}}');
    expect(f).toEqual({ type: "sample", t: 1.5, values: { a: 7 } });
  });
  it("parses a status frame", () => {
    const f = parseFrame('{"type":"status","device_state":"stop_suspected","t":2}');
    expect(f).toMatchObject({ type: "status", device_state: "stop_suspected" });
  });
  it("parses a signals frame", () => {
    const f = parseFrame('{"type":"signals","signals":[{"name":"a","address":1,"size":4,"encoding":"int"}],"unresolved":["x"]}');
    expect(f).toMatchObject({ type: "signals" });
    expect((f as any).signals[0].name).toBe("a");
    expect((f as any).unresolved).toEqual(["x"]);
  });
  it("defaults unresolved to [] when absent on a signals frame", () => {
    const f = parseFrame('{"type":"signals","signals":[]}');
    expect(f).toMatchObject({ type: "signals", signals: [], unresolved: [] });
  });
  it("returns null for non-JSON / log lines", () => {
    expect(parseFrame("connecting probe...")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });
  it("returns null for JSON without a known type", () => {
    expect(parseFrame('{"foo":1}')).toBeNull();
  });
});

describe("TraceSession signals-frame reconciliation", () => {
  // Drive ingest() directly (no daemon) by feeding NDJSON frames as if from stdout.
  function feed(s: TraceSession, line: string): void {
    (s as any).ingest(line + "\n");
  }

  it("reconciles the buffer signal set on a signals frame", () => {
    const s = new TraceSession({ signals: ["a", "b"], rateHz: 0 });
    expect(s.buffer.signalNames()).toEqual(["a", "b"]);
    feed(s, '{"type":"signals","signals":[{"name":"a","address":1,"size":4,"encoding":"int"},{"name":"c","address":2,"size":4,"encoding":"int"}],"unresolved":[]}');
    // "b" dropped, "c" added, "a" kept.
    expect(s.buffer.signalNames().sort()).toEqual(["a", "c"]);
  });

  it("forwards the signals frame to onFrame subscribers", () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    const seen: any[] = [];
    s.onFrame((f) => seen.push(f));
    feed(s, '{"type":"signals","signals":[{"name":"a","address":1,"size":4,"encoding":"int"}],"unresolved":["bad"]}');
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe("signals");
    expect(seen[0].unresolved).toEqual(["bad"]);
  });
});

describe("TraceSession add/remove post-reconcile promise (§4)", () => {
  function feed(s: TraceSession, line: string): void {
    (s as any).ingest(line + "\n");
  }
  // addSignals/removeSignals need a stdin to write to; stub a minimal proc so
  // we can drive the reconcile path without spawning the daemon.
  function stubProc(s: TraceSession): { written: string[] } {
    const written: string[] = [];
    (s as any).proc = { stdin: { write: (chunk: string) => { written.push(chunk); return true; } } };
    return { written };
  }

  it("resolves addSignals with the reconciled set on the next signals frame", async () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    const sink = stubProc(s);
    // Spec is a whole array; the daemon expands it — the resolved set reflects
    // the expanded element names, NOT the pre-reconcile guess.
    const p = s.addSignals(["vec"]);
    expect(sink.written[0]).toContain('"cmd":"add"');
    // Simulate the daemon's post-expansion signals frame.
    feed(s, '{"type":"signals","signals":[{"name":"a","address":1,"size":4,"encoding":"int"},{"name":"vec[0]","address":8,"size":2,"encoding":"uint"},{"name":"vec[1]","address":10,"size":2,"encoding":"uint"}],"unresolved":[]}');
    const names = await p;
    expect(names.sort()).toEqual(["a", "vec[0]", "vec[1]"]);
  });

  it("resolves removeSignals with the reconciled set on the next signals frame", async () => {
    const s = new TraceSession({ signals: ["a", "b"], rateHz: 0 });
    stubProc(s);
    const p = s.removeSignals(["b"]);
    feed(s, '{"type":"signals","signals":[{"name":"a","address":1,"size":4,"encoding":"int"}],"unresolved":[]}');
    expect(await p).toEqual(["a"]);
  });

  it("fires pending resolvers FIFO across two signals frames", async () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    stubProc(s);
    const p1 = s.addSignals(["b"]);
    const p2 = s.addSignals(["c"]);
    feed(s, '{"type":"signals","signals":[{"name":"a","address":1,"size":4,"encoding":"int"},{"name":"b","address":2,"size":4,"encoding":"int"}],"unresolved":[]}');
    feed(s, '{"type":"signals","signals":[{"name":"a","address":1,"size":4,"encoding":"int"},{"name":"b","address":2,"size":4,"encoding":"int"},{"name":"c","address":3,"size":4,"encoding":"int"}],"unresolved":[]}');
    expect((await p1).sort()).toEqual(["a", "b"]);
    expect((await p2).sort()).toEqual(["a", "b", "c"]);
  });

  it("falls back to the current signal set on timeout (no signals frame)", async () => {
    vi.useFakeTimers();
    try {
      const s = new TraceSession({ signals: ["a", "b"], rateHz: 0 });
      stubProc(s);
      const p = s.addSignals(["never"]);  // no daemon frame will arrive
      await vi.advanceTimersByTimeAsync(2000);
      // Buffer is unchanged (no reconcile happened) → current names.
      expect((await p).sort()).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── §11.5 / §11.6 robustness ─────────────────────────────────────────────

/** Minimal ChildProcess stand-in: a kill spy + an `exit`/`error` emitter and
 *  a stdin/stderr we can drive. `kill` records the signal; tests then optionally
 *  fire the `exit` handler to simulate the process actually dying. */
function fakeProc() {
  const handlers: Record<string, (...a: any[]) => void> = {};
  const stdinWrites: string[] = [];
  const kill = vi.fn((_sig?: string) => true);
  const proc: any = {
    kill,
    stdin: { write: (c: string) => { stdinWrites.push(c); return true; } },
    stderr: { on: (_e: string, _cb: (b: Buffer) => void) => { /* attached in injectProc */ } },
    stdout: { on: () => { /* */ } },
    on: (ev: string, cb: (...a: any[]) => void) => { handlers[ev] = cb; },
  };
  return { proc, kill, stdinWrites, fireExit: (code: number | null) => handlers.exit?.(code) };
}

/** Inject a fake proc into a session WITHOUT spawning the daemon, wiring its
 *  exit handler + stderr ingest exactly like start() does. */
function injectProc(s: TraceSession, f: ReturnType<typeof fakeProc>): void {
  (s as any).proc = f.proc;
  (s as any).deviceState = "connecting";
  // Mirror start()'s exit/stderr wiring so onExit/ingestStderr run.
  f.proc.on("exit", (code: number | null) => (s as any).onExit(code));
  f.proc.stderr.on = (ev: string, cb: (b: Buffer) => void) => {
    if (ev === "data") (f.proc as any)._stderrCb = cb;
  };
  // Re-register the stderr data callback path used by feedStderr.
  (f.proc as any)._stderrCb = (b: Buffer) => (s as any).ingestStderr(b.toString());
}

function feedStderr(f: ReturnType<typeof fakeProc>, text: string): void {
  (f.proc as any)._stderrCb(Buffer.from(text));
}

describe("TraceSession.stop() guaranteed teardown (§11.5)", () => {
  it("escalates to SIGKILL when the process ignores SIGTERM (wedged libusb)", () => {
    vi.useFakeTimers();
    try {
      const s = new TraceSession({ signals: ["a"], rateHz: 0 });
      const f = fakeProc();
      injectProc(s, f);
      s.stop();
      // {cmd:stop} was written immediately.
      expect(f.stdinWrites.some((w) => w.includes('"cmd":"stop"'))).toBe(true);
      expect(f.kill).not.toHaveBeenCalled();
      // SIGTERM at ~1.5 s.
      vi.advanceTimersByTime(1500);
      expect(f.kill).toHaveBeenCalledWith("SIGTERM");
      // Process STILL alive (never fired exit) → SIGKILL fallback ~3 s later.
      vi.advanceTimersByTime(3000);
      expect(f.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT fire SIGKILL when the process exits cleanly after SIGTERM", () => {
    vi.useFakeTimers();
    try {
      const s = new TraceSession({ signals: ["a"], rateHz: 0 });
      const f = fakeProc();
      injectProc(s, f);
      s.stop();
      vi.advanceTimersByTime(1500);
      expect(f.kill).toHaveBeenCalledWith("SIGTERM");
      // Process dies → exit clears the pending SIGKILL timer.
      f.fireExit(0);
      vi.advanceTimersByTime(5000);
      expect(f.kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent and safe when proc is already null", () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    expect(() => s.stop()).not.toThrow();   // proc null from the start
    const f = fakeProc();
    injectProc(s, f);
    s.stop();
    s.stop();   // second call must not start a second escalation
    // Only one {cmd:stop} write despite two stop() calls.
    expect(f.stdinWrites.filter((w) => w.includes('"cmd":"stop"')).length).toBe(1);
  });

  // §12.1: the web UI is owned by the persistent Dashboard singleton now — the
  // session must NOT carry a webui field nor touch any server in stop().
  it("does not own the web server (no webui field; stop() is daemon-only)", () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    expect((s as any).webui).toBeUndefined();
    expect((s as any).uiUrl).toBeUndefined();
    expect((s as any).startUi).toBeUndefined();
    const f = fakeProc();
    injectProc(s, f);
    // stop() only escalates the daemon — it never references a web server.
    expect(() => s.stop()).not.toThrow();
    expect(f.stdinWrites.some((w) => w.includes('"cmd":"stop"'))).toBe(true);
  });
});

describe("TraceSession.stderrTail() ring (§11.6)", () => {
  it("accumulates stderr lines and caps at the ring size", () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    const f = fakeProc();
    injectProc(s, f);
    feedStderr(f, "line1\nline2\n");
    expect(s.stderrTail()).toContain("line1");
    expect(s.stderrTail(1)).toBe("line2");
    // Push well past the 30-line ring; only the last 30 survive.
    let blob = "";
    for (let i = 0; i < 50; i++) blob += `L${i}\n`;
    feedStderr(f, blob);
    const tail = s.stderrTail();
    expect(tail.split("\n").length).toBe(30);
    expect(tail).toContain("L49");
    expect(tail).not.toContain("line1");
  });
});

describe("TraceSession.waitForFirstFrame() (§11.6)", () => {
  function feed(s: TraceSession, line: string): void { (s as any).ingest(line + "\n"); }

  it("resolves with the first pushed frame", async () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    const f = fakeProc();
    injectProc(s, f);
    const p = s.waitForFirstFrame(3000);
    feed(s, '{"type":"sample","t":1,"values":{"a":7}}');
    const frame = await p;
    expect(frame?.type).toBe("sample");
  });

  it("resolves null on timeout when no frame arrives", async () => {
    vi.useFakeTimers();
    try {
      const s = new TraceSession({ signals: ["a"], rateHz: 0 });
      const f = fakeProc();
      injectProc(s, f);
      const p = s.waitForFirstFrame(3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves the error frame so start() can detect a failed connect", async () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    const f = fakeProc();
    injectProc(s, f);
    const p = s.waitForFirstFrame(3000);
    feed(s, '{"type":"error","error":"no debug probe detected (replug ST-Link)"}');
    const frame = await p;
    expect(frame).toMatchObject({ type: "error", error: expect.stringContaining("no debug probe") });
  });
});

describe("TraceSession non-zero exit diagnostics (§11.6)", () => {
  it("sets device_state to an error string from stderr when exiting non-zero with no error frame", () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    const f = fakeProc();
    injectProc(s, f);
    feedStderr(f, "pyocd: could not open ST-Link\n");
    f.fireExit(2);   // non-zero, no error frame ingested
    expect(s.deviceState).toMatch(/^error: /);
    expect(s.deviceState).toContain("could not open ST-Link");
  });

  it("falls back to 'daemon exited code N' when stderr is empty", () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    const f = fakeProc();
    injectProc(s, f);
    f.fireExit(3);
    expect(s.deviceState).toBe("error: daemon exited code 3");
  });

  it("a clean exit (code 0) becomes 'exited', not an error", () => {
    const s = new TraceSession({ signals: ["a"], rateHz: 0 });
    const f = fakeProc();
    injectProc(s, f);
    f.fireExit(0);
    expect(s.deviceState).toBe("exited");
  });
});
