// src/tool-context.ts — everything a tool module needs, passed explicitly
// (no module-level globals inside tools — spec §3.7).
import type { HilDaemon } from "./hil/daemon.js";
import type { Policy } from "./policy/policy.js";
import type { JobRegistry } from "./tasks.js";
import type { HandleRegistry } from "./handles.js";

export interface ToolContext {
  daemon: () => HilDaemon;
  policy: Policy;
  jobs: JobRegistry;
  handles: HandleRegistry;
}
