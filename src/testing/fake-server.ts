// src/testing/fake-server.ts — captures registerTool/registerResource calls so a
// tool module can be exercised without an MCP transport.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
  listChanged: number;
  /** what server.server.getClientCapabilities() returns; default {} (no elicitation) */
  clientCapabilities: Record<string, unknown>;
}

export function fakeServer(): FakeServerHandle {
  const tools = new Map<string, FakeTool>();
  const resources = new Map<string, FakeResource>();
  const handle: FakeServerHandle = {
    server: undefined as unknown as McpServer,
    tools,
    resources,
    listChanged: 0,
    clientCapabilities: {},
  };
  const server: any = {
    registerTool(name: string, config: any, cb: any) {
      const t: FakeTool = { config, cb, enabled: true };
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
