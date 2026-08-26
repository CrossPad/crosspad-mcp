// Static introspection of the CrossPad sources, served as resources.
//
// These answer questions the model would otherwise guess at: which event types
// exist, what a settings field is called in NVS, which feature flags deviate
// from their defaults, which apps are actually registered on a platform. They
// are parsed from the headers rather than duplicated here, so they cannot drift
// from the firmware — and each read is mtime-checked, so an edit shows up
// without restarting the server. Spec §3.3.
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../tool-context.js";
import { CROSSPAD_IDF_ROOT } from "../config.js";

/** A cached parse keyed on the mtimes of the files it came from. */
interface CacheEntry<T> {
  stamp: string;
  value: T;
}
const cache = new Map<string, CacheEntry<unknown>>();

function stampOf(files: string[]): string {
  return files
    .map((f) => {
      try {
        return `${f}:${fs.statSync(f).mtimeMs}`;
      } catch {
        return `${f}:-`;
      }
    })
    .join("|");
}

/** Parse once per distinct set of file mtimes. */
export function cached<T>(key: string, files: string[], build: () => T): T {
  const stamp = stampOf(files);
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.value as T;
  const value = build();
  cache.set(key, { stamp, value });
  return value;
}

/** Drop every cached parse (tests). */
export function clearIntrospectionCache(): void {
  cache.clear();
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

// ── enums ────────────────────────────────────────────────────────────────────

export interface EnumEntry {
  name: string;
  value: number;
  comment?: string;
}

/**
 * Parse a C++ `enum class` body: bare entries count up from 0, an explicit
 * `= N` resets the counter, `Max` and `COUNT` sentinels are dropped, and a
 * trailing `///<` comment becomes the description.
 */
export function parseEnumClass(source: string, name: string): EnumEntry[] {
  const open = source.search(new RegExp(`enum\\s+class\\s+${name}\\b[^{]*\\{`));
  if (open < 0) return [];
  const start = source.indexOf("{", open) + 1;
  const end = source.indexOf("}", start);
  if (end < 0) return [];

  // Line by line, comment stripped first: a `///<` comment can itself contain a
  // comma ("(wavIdx, note)"), so splitting the raw text on commas loses entries.
  // Several entries may still share one line, hence the inner split.
  const out: EnumEntry[] = [];
  let next = 0;
  for (const rawLine of source.slice(start, end).split("\n")) {
    const docMatch = /\/\/\/<?[ \t]*(.*)$/.exec(rawLine);
    const doc = docMatch ? docMatch[1].trim() : "";
    const code = rawLine
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/, "")
      .trim();
    // A comment on its own line describes the entry above it.
    if (!code && doc && out.length > 0 && !out[out.length - 1].comment) {
      out[out.length - 1].comment = doc;
      continue;
    }
    let added = false;
    for (const piece of code.split(",")) {
      const m = /^([A-Za-z_]\w*)\s*(?:=\s*(.+))?$/.exec(piece.trim());
      if (!m) continue;
      const [, entry, explicit] = m;
      if (entry === "Max" || entry === "COUNT" || entry === "Count") continue;
      const value = explicit !== undefined ? Number(explicit.trim()) : next;
      if (!Number.isFinite(value)) continue;
      next = value + 1;
      out.push({ name: entry, value });
      added = true;
    }
    // The trailing comment belongs to the last entry on this line.
    if (added && doc) out[out.length - 1].comment = doc;
  }
  return out;
}

// ── registered apps ──────────────────────────────────────────────────────────

export interface RegisteredApp {
  name: string;
  icon: string | null;
  priority: number | null;
  padLogic: string | null;
  source: string;
}

/**
 * Find REGISTER_APP / REGISTER_APP_PL / REGISTER_LVGL_APP_PAD registrations.
 *
 * The generator that builds app_registry_init.cpp scans the same way, so this
 * sees what the firmware will actually register — including the `_PL` variants
 * and apps that live in installed components, both of which the v9
 * `list_apps_source` grep missed.
 */
export function parseRegisteredApps(source: string, file: string): RegisteredApp[] {
  const out: RegisteredApp[] = [];
  const re = /REGISTER_(APP_PL|LVGL_APP_PAD|APP)\s*\(/g;
  for (const m of source.matchAll(re)) {
    const kind = m[1];
    // Walk to the matching ")": a lambda argument brings its own parentheses,
    // and a lazy regex would stop inside it.
    const open = m.index! + m[0].length;
    let depth = 1;
    let i = open;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    if (depth !== 0) continue;
    const args = splitArgs(source.slice(open, i - 1));
    if (args.length < 3) continue;
    const rawIcon = args[2] ?? "";
    const icon = rawIcon === "nullptr" ? null : rawIcon.replace(/^"|"$/g, "");
    const priority = args.length >= 9 ? Number(args[8]) : NaN;
    const rawLogic = kind === "APP" ? "" : (args[9] ?? "");
    const padLogic =
      rawLogic === "" || rawLogic === "nullptr" ? null : rawLogic.replace(/^"|"$/g, "");
    out.push({
      name: args[0],
      icon,
      priority: Number.isFinite(priority) ? priority : null,
      padLogic,
      source: file,
    });
  }
  return out;
}

/** Split a macro argument list on top-level commas (lambdas contain their own). */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function walkSources(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "build" || e.name.startsWith("build_") || e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkSources(full, out, depth + 1);
    else if (/\.(cpp|cc|c|hpp|h)$/.test(e.name)) out.push(full);
  }
  return out;
}

// ── settings schema ──────────────────────────────────────────────────────────

export interface SettingsField {
  group: string;
  field: string;
  type: string;
  comment?: string;
}

/** Parse the nested structs of CrosspadSettings.hpp into group/field rows. */
export function parseSettings(source: string): SettingsField[] {
  const out: SettingsField[] = [];
  // Groups are `struct X {` in the per-group headers and `class CrosspadSettings {`
  // in the aggregate one; brace counting finds the end, since a nested struct or
  // an initialiser would fool a "first closing brace" rule.
  const groupRe = /(?:struct|class)\s+(\w+)[^;{]*\{/g;
  for (const m of source.matchAll(groupRe)) {
    const group = m[1];
    let depth = 1;
    let i = m.index! + m[0].length;
    const bodyStart = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    for (const rawLine of source.slice(bodyStart, i - 1).split("\n")) {
      const docMatch = /\/\/\/?<?[ \t]*(.*)$/.exec(rawLine);
      const comment = docMatch ? docMatch[1].trim() : "";
      const line = rawLine.replace(/\/\/.*$/, "").trim();
      const f = /^((?:const\s+|static\s+|mutable\s+)*[A-Za-z_][\w:<>, ]*?)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*(?:=[^;]*)?;$/.exec(line);
      if (!f) continue;
      const [, rawType, field, array] = f;
      const type = rawType.trim();
      if (/^(return|struct|class|public|private|protected|using|typedef|friend|enum)$/.test(type)) continue;
      out.push({
        group,
        field,
        type: array ? `${type}${array}` : type,
        ...(comment ? { comment } : {}),
      });
    }
  }
  return out;
}

// ── resource registration ────────────────────────────────────────────────────

const CORE = "components/crosspad-core/include/crosspad";

function json(uri: string, value: unknown) {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Register the static-introspection resources. Anything whose source files are
 * absent still registers and reports `available: false` with the path it looked
 * at — a resource that vanishes is harder to debug than one that explains
 * itself.
 */
export function registerIntrospectionResources(server: McpServer, _ctx: ToolContext): string[] {
  // One root: the resources report `available: false` with the path they looked
  // at when it is not a checkout, rather than disappearing from the listing.
  const idf: string | null = fs.existsSync(path.join(CROSSPAD_IDF_ROOT, "main")) ? CROSSPAD_IDF_ROOT : null;
  const registered: string[] = [];

  const add = (uri: string, name: string, description: string, read: () => unknown) => {
    server.registerResource(name, uri, { description, mimeType: "application/json" }, async () => json(uri, read()));
    registered.push(uri);
  };

  add("crosspad://events", "crosspad-events", "EventType and EventSource enums from crosspad-core", () => {
    const file = idf ? path.join(idf, CORE, "event/EventTypes.hpp") : null;
    const src = file ? readIfPresent(file) : null;
    if (!src) return { available: false, looked_at: file, hint: "set CROSSPAD_IDF_ROOT" };
    return cached(`events:${file}`, [file!], () => ({
      available: true,
      source: file,
      event_types: parseEnumClass(src, "EventType"),
      event_sources: parseEnumClass(src, "EventSource"),
    }));
  });

  add("crosspad://settings/schema", "crosspad-settings-schema", "CrosspadSettings fields by group", () => {
    const dir = idf ? path.join(idf, CORE, "settings") : null;
    if (!dir || !fs.existsSync(dir)) {
      return { available: false, looked_at: dir, hint: "set CROSSPAD_IDF_ROOT" };
    }
    // The aggregate class names the groups but the fields live in the per-group
    // headers next to it, so read the whole directory.
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".hpp") || f.endsWith(".h"))
      .map((f) => path.join(dir, f))
      .sort();
    return cached(`settings:${dir}`, files, () => {
      const fields: SettingsField[] = [];
      for (const f of files) {
        const src = readIfPresent(f);
        if (src) fields.push(...parseSettings(src));
      }
      return { available: true, source: dir, files: files.map((f) => path.basename(f)), fields };
    });
  });

  add("crosspad://features", "crosspad-features", "Feature-flag catalog and the values this checkout deviates on", () => {
    const schemaFile = idf ? path.join(idf, CORE, "config/features.schema.json") : null;
    const configFile = idf ? path.join(idf, "crosspad.config.json") : null;
    const schemaRaw = schemaFile ? readIfPresent(schemaFile) : null;
    if (!schemaRaw) return { available: false, looked_at: schemaFile, hint: "set CROSSPAD_IDF_ROOT" };
    return cached(`features:${schemaFile}`, [schemaFile!, configFile ?? ""], () => {
      let schema: unknown = null;
      try {
        schema = JSON.parse(schemaRaw);
      } catch (e) {
        return { available: false, source: schemaFile, error: `unparsable: ${(e as Error).message}` };
      }
      let chosen: unknown = null;
      const cfgRaw = configFile ? readIfPresent(configFile) : null;
      if (cfgRaw) {
        try {
          chosen = (JSON.parse(cfgRaw) as { features?: unknown }).features ?? null;
        } catch { /* a broken local config must not hide the catalog */ }
      }
      return { available: true, source: schemaFile, schema, chosen, chosen_source: configFile };
    });
  });

  add("crosspad://apps/registered/idf", "crosspad-apps-registered", "Apps the firmware will register (REGISTER_APP and _PL, including installed components)", () => {
    if (!idf) return { available: false, hint: "set CROSSPAD_IDF_ROOT" };
    const roots = [path.join(idf, "main", "app"), path.join(idf, "components")];
    const files = roots.flatMap((r) => walkSources(r)).filter((f) => /crosspad-|main\/app/.test(f));
    return cached(`apps:${idf}`, files, () => {
      const apps: RegisteredApp[] = [];
      for (const f of files) {
        const src = readIfPresent(f);
        // AppRegistrar.hpp *defines* REGISTER_APP; its parameter names would
        // otherwise show up as apps called "appName".
        if (!src || !src.includes("REGISTER_") || /#\s*define\s+REGISTER_APP/.test(src)) continue;
        apps.push(...parseRegisteredApps(src, path.relative(idf, f)));
      }
      apps.sort((a, b) => a.name.localeCompare(b.name));
      return { available: true, count: apps.length, apps, max_apps: 16 };
    });
  });

  add("crosspad://idf/status", "crosspad-idf-status", "Board revision, build dirs and how old the built binary is", () => {
    if (!idf) return { available: false, hint: "set CROSSPAD_IDF_ROOT" };
    const builds = ["build", "build_v1", "build_v2"]
      .map((d) => {
        const bin = path.join(idf, d, "CrossPad.bin");
        let stat: fs.Stats | null = null;
        try {
          stat = fs.statSync(bin);
        } catch { /* not built */ }
        let rev: string | null = null;
        const cfg = readIfPresent(path.join(idf, d, "config", "sdkconfig.json"));
        if (cfg) {
          try {
            rev = (JSON.parse(cfg) as Record<string, unknown>).BSP_BOARD_REV_STR as string ?? null;
          } catch { /* leave null */ }
        }
        return stat ? { dir: d, bin, bytes: stat.size, mtime_ms: stat.mtimeMs, board_rev: rev } : null;
      })
      .filter((b) => b !== null);
    return { available: true, root: idf, builds };
  });

  return registered;
}
