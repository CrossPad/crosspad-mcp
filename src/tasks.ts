// src/tasks.ts — one job registry for every long operation (build, flash,
// hil_run, capture, stimulus, submodule_update). Reachable through the SDK
// tasks capability when the client has it, and through `crosspad_task`
// otherwise — identical handle, identical states (spec §3.5). Results are
// retained 1 h after the terminal state. Daemon-side tasks are mirrored by a
// local job that polls `task.status` every 500 ms and forwards `task.cancel`.
import { HilError, DAEMON_DIED, TIMEOUT } from "./hil/daemon.js";
import { TaskStatusSchema } from "./hil/schemas.js";

export type JobState = "working" | "completed" | "failed" | "cancelled";

export interface JobStatus {
  task: string;
  kind: string;
  status: JobState;
  progress?: number;
  total?: number;
  message?: string;
  result?: unknown;
  error?: { code: string; message: string };
  startedAt: number;
  finishedAt?: number;
  /** For mirrored jobs: the daemon's own task handle (e.g. "task_9"). */
  daemonTask?: string;
}

export type ProgressFn = (p: number, total: number | undefined, msg: string) => void;
export type JobRun = (signal: AbortSignal, progress: ProgressFn) => Promise<unknown>;

export interface DaemonLike {
  request<T = unknown>(op: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
}

interface Job {
  status: JobStatus;
  controller: AbortController;
  waiters: Array<() => void>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  /** Mirror-only: extra work on cancel (forward to the daemon). */
  onCancel?: () => void;
}

export const RETENTION_MS = 3_600_000;
export const POLL_INTERVAL_MS = 500;
/** Consecutive failed `task.status` polls tolerated before the mirror gives up. */
export const POLL_RETRIES = 3;
/** How long a mirrored task may run before the mirror stops watching it.
 *  Longer than the longest scenario anyone runs (`stability --duration-hours 8`)
 *  by a wide margin — this is the backstop for a daemon task that will never
 *  reach a terminal state, not a policy on how long work may take. */
export const DAEMON_TASK_DEADLINE_MS = 24 * 3_600_000;

export interface PumpOpts {
  /** Give up (and cancel the daemon side) after this long. */
  deadlineMs?: number;
  /** Consecutive transient poll failures tolerated. */
  retries?: number;
}

/** A poll that failed because the daemon was busy or restarting says nothing
 *  about the task it was asked about. Anything else — an unknown handle, a
 *  reply that does not parse — is about the task, and is not worth retrying. */
function isTransientPollFailure(e: unknown): boolean {
  return e instanceof HilError && (e.code === TIMEOUT || e.code === DAEMON_DIED);
}

/**
 * Poll one daemon-side task ("task_N" from ota.flash / scenario.run) to its
 * terminal state, forwarding progress. Abort forwards `task.cancel` once and
 * keeps polling so the daemon's own `cancelled` state is the one observed.
 * Factored out of JobRegistry.mirror() so flash can compose it with a boot
 * wait inside a single job — there is exactly one poll loop in this code base.
 */
export function pumpDaemonTask(
  daemon: DaemonLike,
  daemonTask: string,
  signal: AbortSignal,
  progress: ProgressFn,
  pollMs: number = POLL_INTERVAL_MS,
  opts: PumpOpts = {},
): Promise<unknown> {
  const retries = opts.retries ?? POLL_RETRIES;
  const deadline = Date.now() + (opts.deadlineMs ?? DAEMON_TASK_DEADLINE_MS);
  return new Promise<unknown>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelSent = false;
    let failures = 0;
    const forwardCancel = (): void => {
      if (cancelSent) return;
      cancelSent = true;
      daemon.request("task.cancel", { task: daemonTask }).catch(() => {});
    };
    // Whenever this side stops watching, the daemon side has to be told. The
    // local job goes terminal the moment this promise rejects, JobRegistry
    // .cancel() answers false from then on, and an 8-hour `stability` run would
    // otherwise keep driving the board with no handle left that could stop it.
    const giveUp = (e: unknown): void => { forwardCancel(); reject(e); };
    const poll = async (): Promise<void> => {
      let st;
      try {
        st = TaskStatusSchema.parse(await daemon.request("task.status", { task: daemonTask }));
        failures = 0;
      } catch (e) {
        // A 30 s TIMEOUT on `task.status` under a pad storm means the daemon
        // was busy, not that the task is gone. Only a run of them is evidence.
        if (isTransientPollFailure(e) && ++failures <= retries) {
          timer = setTimeout(() => { void poll(); }, pollMs);
          return;
        }
        giveUp(e);
        return;
      }
      if (typeof st.progress === "number") {
        progress(st.progress, typeof st.total === "number" ? st.total : undefined, st.message ?? "");
      }
      if (st.status === "completed") { resolve(st.result); return; }
      if (st.status === "failed") {
        reject(new HilError(
          st.error?.code ?? "TASK_FAILED",
          st.error?.message ?? `daemon task ${daemonTask} failed`,
          st.error?.hint ?? undefined,
        ));
        return;
      }
      if (st.status === "cancelled") { reject(new HilError("CANCELLED", `daemon task ${daemonTask} cancelled`)); return; }
      if (Date.now() >= deadline) {
        giveUp(new HilError(
          TIMEOUT,
          `daemon task ${daemonTask} is still working after ${Math.round((Date.now() - (deadline - (opts.deadlineMs ?? DAEMON_TASK_DEADLINE_MS))) / 1000)} s`,
          "the daemon side has been cancelled; check `crosspad_doctor` and the daemon log",
          { task: daemonTask },
        ));
        return;
      }
      timer = setTimeout(() => { void poll(); }, pollMs);
    };
    signal.addEventListener("abort", () => {
      forwardCancel();
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      void poll();
    }, { once: true });
    void poll();
  });
}

export class JobRegistry {
  private jobs = new Map<string, Job>();
  private seq = 1;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(opts: { retentionMs?: number; now?: () => number } = {}) {
    this.retentionMs = opts.retentionMs ?? RETENTION_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Start `run` immediately; returns "task_N". */
  create(kind: string, run: JobRun): string {
    const id = `task_${this.seq++}`;
    const controller = new AbortController();
    const job: Job = {
      status: { task: id, kind, status: "working", startedAt: this.now() },
      controller,
      waiters: [],
    };
    this.jobs.set(id, job);
    const progress: ProgressFn = (p, total, msg) => {
      if (job.status.status !== "working") return;
      job.status.progress = p;
      if (total !== undefined) job.status.total = total;
      job.status.message = msg;
    };
    // Start `run` synchronously: a cancel() issued in the same tick as create()
    // must find the run's abort listener already attached — addEventListener on
    // an already-aborted signal never fires.
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(run(controller.signal, progress));
    } catch (e) {
      started = Promise.reject(e);
    }
    started
      .then(
        (result) => {
          if (controller.signal.aborted) this.finish(job, "cancelled");
          else { job.status.result = result; this.finish(job, "completed"); }
        },
        (e: unknown) => {
          if (controller.signal.aborted) this.finish(job, "cancelled");
          else {
            job.status.error = e instanceof HilError
              ? { code: e.code, message: e.message }
              : { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) };
            this.finish(job, "failed");
          }
        },
      );
    return id;
  }

  /** Mirror a daemon task ("task_N" from scenario.run / ota.flash) as a local job. */
  mirror(daemon: DaemonLike, daemonTask: string, kind: string, pollIntervalMs: number = POLL_INTERVAL_MS, opts: PumpOpts = {}): string {
    const id = this.create(kind, (signal, progress) => pumpDaemonTask(daemon, daemonTask, signal, progress, pollIntervalMs, opts));
    const job = this.jobs.get(id)!;
    job.status.daemonTask = daemonTask;
    return id;
  }

  status(id: string): JobStatus {
    const job = this.jobs.get(id);
    if (!job) {
      throw new HilError("HANDLE_EXPIRED", `unknown task ${id}`, "task results are kept 1 h after completion; use crosspad_task action=list", { task: id });
    }
    return { ...job.status };
  }

  /** Resolve when the job reaches a terminal state, or after timeoutMs with
   *  whatever the status is then (the caller checks `.status`). */
  wait(id: string, timeoutMs: number): Promise<JobStatus> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new HilError("HANDLE_EXPIRED", `unknown task ${id}`, "task results are kept 1 h after completion; use crosspad_task action=list", { task: id }));
    if (job.status.status !== "working") return Promise.resolve({ ...job.status });
    return new Promise<JobStatus>((resolve) => {
      const timer = setTimeout(() => {
        const i = job.waiters.indexOf(done);
        if (i >= 0) job.waiters.splice(i, 1);
        resolve({ ...job.status });
      }, timeoutMs);
      const done = (): void => { clearTimeout(timer); resolve({ ...job.status }); };
      job.waiters.push(done);
    });
  }

  /** Abort a working job. false when unknown or already terminal. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status.status !== "working") return false;
    job.controller.abort();
    return true;
  }

  list(): JobStatus[] {
    return [...this.jobs.values()].map((j) => ({ ...j.status }));
  }

  private finish(job: Job, state: JobState): void {
    if (job.status.status !== "working") return;
    job.status.status = state;
    job.status.finishedAt = this.now();
    const waiters = job.waiters;
    job.waiters = [];
    for (const w of waiters) w();
    job.retentionTimer = setTimeout(() => { this.jobs.delete(job.status.task); }, this.retentionMs);
    if (typeof job.retentionTimer === "object" && "unref" in job.retentionTimer) job.retentionTimer.unref();
  }
}

export const jobs = new JobRegistry();
