/**
 * MCP tool: read/write CrossPad settings via the running simulator.
 */

import fs from "fs";
import path from "path";
import { sendRemoteCommand, isSimulatorRunning } from "../utils/remote-client.js";
import { cached, parseSettings } from "../resources/introspect.js";
import { CROSSPAD_IDF_ROOT } from "../config.js";
import { z } from "zod";

const SettingsSetResponseSchema = z.object({
  ok: z.literal(true),
  key: z.string(),
  value: z.number(),
});

/** What a setting can hold. Booleans travel as 0/1 — the wire format is int-only. */
export type SettingsValue = number | boolean;

export interface SettingsGetResult {
  success: boolean;
  category?: string;
  settings?: Record<string, unknown>;
  error?: string;
}

export interface SettingsSetResult {
  success: boolean;
  key?: string;
  value?: SettingsValue;
  error?: string;
}

// ── categories ──────────────────────────────────────────────────────────────

const SETTINGS_HEADER = path.join(
  CROSSPAD_IDF_ROOT,
  "components/crosspad-core/include/crosspad/settings/CrosspadSettings.hpp",
);

/**
 * The two buckets the simulator splits CrosspadSettings' loose scalars into.
 * They are named here rather than derived because they are not fields: the
 * class has `LCDbrightness`, `Kit`, `AudioEngineEnabled` and friends sitting
 * directly on it, and `settings_get` groups them under these names.
 */
const FLAT_CATEGORIES = ["display", "system"];

/** Used when the crosspad-core checkout is not where CROSSPAD_IDF_ROOT points. */
const FALLBACK_GROUPS = ["keypad", "vibration", "wireless", "audio"];

/**
 * The categories `settings_get` accepts, one per settings group that
 * CrosspadSettings actually declares.
 *
 * v9 hardcoded this list and it drifted from the header within a release. The
 * groups now come from the same parse that backs `crosspad://settings/schema`,
 * so a group added to the firmware is a category here without anyone editing
 * this file.
 */
export function settingsCategories(): string[] {
  const groups = cached(`settings-categories:${SETTINGS_HEADER}`, [SETTINGS_HEADER], () => {
    let src: string;
    try {
      src = fs.readFileSync(SETTINGS_HEADER, "utf-8");
    } catch {
      return FALLBACK_GROUPS;
    }
    // A member whose type is itself a settings struct is a group; a `uint8_t`
    // or `bool` on the class is one of the loose scalars handled above.
    const members = parseSettings(src)
      .filter((f) => f.group === "CrosspadSettings" && /Settings\b/.test(f.type))
      .map((f) => f.field.toLowerCase());
    return members.length > 0 ? members : FALLBACK_GROUPS;
  });

  return ["all", ...[...new Set([...groups, ...FLAT_CATEGORIES])].sort()];
}

/**
 * Read settings from the running simulator.
 * @param category  "all" or one of `settingsCategories()`
 */
export async function crosspadSettingsGet(
  category: string = "all"
): Promise<SettingsGetResult> {
  const known = settingsCategories();
  if (!known.includes(category)) {
    return { success: false, error: `Unknown settings category '${category}'. Known: ${known.join(", ")}.` };
  }

  const running = await isSimulatorRunning();
  if (!running) {
    return { success: false, error: "Simulator is not running. Use crosspad_run to start it." };
  }

  try {
    const resp = await sendRemoteCommand({ cmd: "settings_get", category });
    if (!resp.ok) {
      return { success: false, error: (resp.error as string) || "settings_get failed" };
    }
    // Remove 'ok' field, pass the rest as settings
    const { ok, ...settings } = resp;
    if (Object.keys(settings).length === 0) {
      // The simulator answers an unfamiliar category with a bare `{"ok":true}`
      // rather than an error, which reads as "this group is empty".
      return {
        success: false,
        category,
        error: `The simulator returned no fields for category '${category}' — it is declared in CrosspadSettings but settings_get does not expose it yet.`,
      };
    }
    return { success: true, category, settings };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Write a single setting on the running simulator.
 * @param key    Dotted key name (e.g. "lcd_brightness", "keypad.eco_mode", "vibration.enable")
 * @param value  Number, or boolean for the `bool` fields of the schema
 */
export async function crosspadSettingsSet(
  key: string,
  value: SettingsValue
): Promise<SettingsSetResult> {
  const running = await isSimulatorRunning();
  if (!running) {
    return { success: false, error: "Simulator is not running. Use crosspad_run to start it." };
  }

  try {
    // The simulator parses the value with std::stoi, so a boolean has to leave
    // here as 0 or 1; the caller still gets its own value back.
    const wire = typeof value === "boolean" ? (value ? 1 : 0) : value;
    const resp = await sendRemoteCommand({ cmd: "settings_set", key, value: wire });
    if (!resp.ok) {
      return { success: false, error: (resp.error as string) || "settings_set failed" };
    }
    const parsed = SettingsSetResponseSchema.safeParse(resp);
    if (!parsed.success) {
      return { success: false, error: `Simulator returned malformed settings_set response: ${parsed.error.message}` };
    }
    return {
      success: true,
      key: parsed.data.key,
      value: typeof value === "boolean" ? parsed.data.value !== 0 : parsed.data.value,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
