import { realpathSync } from "fs";
import { fileURLToPath } from "url";

/**
 * Is this module the program node was started with?
 *
 * Compared by real path: npx, `npm i -g` and every MCP client that runs the
 * `crosspad-mcp-server` bin start node through a symlink in node_modules/.bin,
 * so argv[1] is the link while import.meta.url is the file it points to. A
 * plain string comparison said "not the entry point" there, main() never ran,
 * and the server printed its banner and exited without ever answering.
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
