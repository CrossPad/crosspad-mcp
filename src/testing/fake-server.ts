// src/testing/fake-server.ts — captures registerTool/registerResource calls so a
// tool module can be exercised without an MCP transport.
//
// The captured callback is wrapped in the same validation the real SDK applies
// around a tool call. Without it a unit test is only ever asking "did my
// function return what I told it to return", which is a question that cannot
// fail: a tool could declare an output schema and answer something else
// entirely, and only a live client would notice.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

export interface FakeTool {
  config: any;
  cb: (args: any, extra: any) => Promise<any>;
  enabled: boolean;
}

export interface FakeResource {
  name: string;
  uriOrTemplate: any;
  config: any;
  cb: (...a: any[]) => Promise<any>;
}

export interface FakeServerHandle {
  server: McpServer;
  tools: Map<string, FakeTool>;
  resources: Map<string, FakeResource>;
  prompts: Map<string, { name: string; config: unknown; cb: unknown }>;
  listChanged: number;
  /** what server.server.getClientCapabilities() returns; default {} (no elicitation) */
  clientCapabilities: Record<string, unknown>;
}

/** Thrown by the fake when a tool call does not match its declared schemas. */
export class SchemaViolation extends Error {}

/** Whether the JSON Schema this tool advertises forbids undeclared keys. Asked
 *  of the emitted schema rather than assumed, so a deliberately open output
 *  (`z.looseObject`) is not rejected for being what it says it is. */
function isClosed(obj: unknown): boolean {
  try {
    const js = toJsonSchemaCompat(obj as never, { strictUnions: true, pipeStrategy: "output" }) as { additionalProperties?: unknown };
    return js.additionalProperties === false;
  } catch {
    return false;
  }
}

function describe(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Wrap a tool callback in the SDK's own call-time validation.
 *
 * Input is parsed through `inputSchema` and the *parsed* value is handed to the
 * callback, exactly as `McpServer` does — which is also where `.default()`
 * values come from, so a test that omits an optional argument sees what the
 * real client would produce rather than `undefined`.
 *
 * Output is parsed through `outputSchema`, skipped for `isError` results
 * because the SDK skips those too.
 */
function validating(name: string, config: any, cb: any) {
  const inputObj = config?.inputSchema ? normalizeObjectSchema(config.inputSchema) : undefined;
  const outputObj = config?.outputSchema ? normalizeObjectSchema(config.outputSchema) : undefined;
  const closedOutput = outputObj !== undefined && isClosed(outputObj);
  return async (args: any, extra: any): Promise<any> => {
    let parsedArgs = args;
    if (inputObj) {
      const r = (inputObj as any).safeParse(args ?? {});
      if (!r.success) throw new SchemaViolation(`Input validation error for ${name}: ${describe(r.error.issues)}`);
      parsedArgs = r.data;
    }
    const result = await cb(parsedArgs, extra);
    if (!outputObj || !result || !("content" in result) || result.isError) return result;
    if (!result.structuredContent) {
      throw new SchemaViolation(`Output validation error for ${name}: declares an outputSchema but returned no structuredContent`);
    }
    const r = (outputObj as any).safeParse(result.structuredContent);
    if (!r.success) throw new SchemaViolation(`Output validation error for ${name}: ${describe(r.error.issues)}`);
    // zod strips what it does not know, but the schema advertised to clients
    // says `additionalProperties: false` — so an undeclared key is a real
    // rejection on the wire even though the parse above accepted it.
    if (!closedOutput) return result;
    const declared = new Set(Object.keys((outputObj as any).shape ?? {}));
    const extraKeys = Object.keys(result.structuredContent).filter((k) => !declared.has(k));
    if (extraKeys.length > 0) {
      throw new SchemaViolation(`Output validation error for ${name}: undeclared key(s) ${extraKeys.join(", ")} — the output schema is closed (additionalProperties: false)`);
    }
    return result;
  };
}

export function fakeServer(): FakeServerHandle {
  const tools = new Map<string, FakeTool>();
  const prompts = new Map<string, { name: string; config: unknown; cb: unknown }>();
  const resources = new Map<string, FakeResource>();
  const handle: FakeServerHandle = {
    server: undefined as unknown as McpServer,
    tools,
    resources,
    prompts,
    listChanged: 0,
    clientCapabilities: {},
  };
  const server: any = {
    registerTool(name: string, config: any, cb: any) {
      const t: FakeTool = { config, cb: validating(name, config, cb), enabled: true };
      tools.set(name, t);
      return {
        enable: () => { t.enabled = true; },
        disable: () => { t.enabled = false; },
        remove: () => { tools.delete(name); },
        update: () => {},
        enabled: true,
      };
    },
    registerResource(name: string, uriOrTemplate: any, config: any, cb: any) {
      resources.set(name, { name, uriOrTemplate, config, cb });
      return { enable() {}, disable() {}, remove() {}, update() {} };
    },
    registerPrompt(name: string, config: any, cb: any) {
      prompts.set(name, { name, config, cb });
      return { enable() {}, disable() {}, remove() {}, update() {} };
    },
    sendToolListChanged() { handle.listChanged++; },
    server: {
      getClientCapabilities: () => handle.clientCapabilities,
      elicitInput: async () => ({ action: "decline" }),
      sendLoggingMessage: async () => {},
    },
  };
  handle.server = server as McpServer;
  return handle;
}

/** Minimal RequestHandlerExtra for calling a tool callback directly. */
export function fakeExtra(): any {
  return {
    signal: new AbortController().signal,
    _meta: {},
    sendNotification: async () => {},
    sendRequest: async () => ({}),
    requestId: 1,
  };
}
