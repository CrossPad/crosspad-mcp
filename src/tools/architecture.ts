import fs from "fs";
import path from "path";
import { getRepos, resolveCrosspadCore } from "../config.js";
import { runCommand } from "../utils/exec.js";

// --- crosspad_interfaces ---

export interface InterfaceInfo {
  name: string;
  file: string;
}

export interface ImplementationInfo {
  className: string;
  file: string;
  platform: string;
}

function findInterfaces(): InterfaceInfo[] {
  const corePath = resolveCrosspadCore();
  if (!corePath) return [];

  const coreInclude = path.join(corePath, "include", "crosspad");
  const results: InterfaceInfo[] = [];

  function scan(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.startsWith("I") && entry.name.endsWith(".hpp")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        const match = content.match(/class\s+(I[A-Z]\w+)\b/);
        if (match) {
          results.push({
            name: match[1],
            file: fullPath.replace(/\\/g, "/"),
          });
        }
      }
    }
  }

  scan(coreInclude);
  return results;
}

function findImplementations(interfaceName: string): ImplementationInfo[] {
  const results: ImplementationInfo[] = [];
  const pattern = `class\\s+\\w+.*:\\s*(public\\s+)?.*${interfaceName}`;
  const repos = getRepos();

  const platformMap: Record<string, string> = {
    "crosspad-core": "shared",
    "crosspad-gui": "gui",
    "crosspad-pc": "PC",
    "ESP32-S3": "arduino",
    "platform-idf": "idf",
  };

  for (const [name, repoPath] of Object.entries(repos)) {
    const result = runCommand(
      `git grep --recurse-submodules -n -E "${pattern}" -- "*.hpp" "*.cpp" "*.h"`,
      repoPath
    );

    if (!result.success && result.stdout.length === 0) continue;

    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;

      const filePart = line.slice(0, colonIdx);
      const codePart = line.slice(colonIdx + 1);

      const lineNumMatch = codePart.match(/^(\d+):(.*)/);
      const code = lineNumMatch ? lineNumMatch[2] : codePart;

      const classMatch = code.match(/class\s+(\w+)/);
      if (classMatch) {
        results.push({
          className: classMatch[1],
          file: path.join(repoPath, filePart).replace(/\\/g, "/"),
          platform: platformMap[name] ?? name,
        });
      }
    }
  }

  return results;
}

interface CapabilityInfo {
  flags: string[];
  platforms: Record<string, string[]>;
}

function queryCapabilities(): CapabilityInfo {
  const corePath = resolveCrosspadCore();
  const flags: string[] = [];

  if (corePath) {
    const capsFile = path.join(corePath, "include", "crosspad", "platform", "PlatformCapabilities.hpp");
    if (fs.existsSync(capsFile)) {
      const content = fs.readFileSync(capsFile, "utf-8");
      const enumMatch = content.match(/enum\s+class\s+Capability[^{]*\{([^}]+)\}/s);
      if (enumMatch) {
        for (const line of enumMatch[1].split("\n")) {
          const flagMatch = line.match(/\b(\w+)\s*=/);
          if (flagMatch && flagMatch[1] !== "None" && flagMatch[1] !== "All") {
            flags.push(flagMatch[1]);
          }
        }
      }
    }
  }

  const repos = getRepos();
  const platformMap: Record<string, string> = {
    "crosspad-pc": "PC",
    "ESP32-S3": "arduino",
    "platform-idf": "idf",
  };

  const platforms: Record<string, string[]> = {};

  for (const [name, repoPath] of Object.entries(repos)) {
    if (!platformMap[name]) continue;

    const result = runCommand(
      `git grep -h "addPlatformCapability\\|setPlatformCapabilities" -- "*.cpp" "*.hpp" "*.h"`,
      repoPath
    );

    if (!result.success && result.stdout.length === 0) continue;

    const caps: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const matches = line.match(/Capability::(\w+)/g);
      if (matches) {
        for (const m of matches) {
          const cap = m.replace("Capability::", "");
          if (!caps.includes(cap)) caps.push(cap);
        }
      }
    }
    if (caps.length > 0) {
      platforms[platformMap[name]] = caps;
    }
  }

  return { flags, platforms };
}

export function crosspadInterfaces(
  query: string
): Record<string, unknown> {
  const parts = query.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();

  if (command === "list") {
    return { interfaces: findInterfaces() };
  }

  if (command === "implementations" && parts[1]) {
    const interfaceName = parts[1];
    const interfaces = findInterfaces();
    const defined = interfaces.find((i) => i.name === interfaceName);
    return {
      interface: interfaceName,
      defined_in: defined?.file ?? "not found",
      implementations: findImplementations(interfaceName),
    };
  }

  if (command === "capabilities") {
    const caps = queryCapabilities();
    return { flags: caps.flags, platforms: caps.platforms };
  }

  return {
    error: `Unknown query: "${query}". Use "list", "implementations <InterfaceName>", or "capabilities".`,
  };
}

// --- crosspad_apps ---

export interface AppInfo {
  name: string;
  registration_file: string;
  platform: string;
}

export function crosspadApps(
  platform: "pc" | "idf" | "arduino" | "all"
): AppInfo[] {
  const results: AppInfo[] = [];
  const repos = getRepos();

  const targets: [string, string, string[]][] = [];
  // [platformLabel, repoPath, searchDirs]

  if (platform === "pc" || platform === "all") {
    if (repos["crosspad-pc"]) {
      targets.push(["PC", repos["crosspad-pc"], []]);
    }
  }
  if (platform === "arduino" || platform === "all") {
    if (repos["ESP32-S3"]) {
      targets.push(["arduino", repos["ESP32-S3"], []]);
    }
  }
  if (platform === "idf" || platform === "all") {
    if (repos["platform-idf"]) {
      targets.push(["idf", repos["platform-idf"], []]);
    }
  }

  for (const [platName, repoPath] of targets) {
    // Search for REGISTER_APP and _register_*_app patterns
    const result = runCommand(
      `git grep --recurse-submodules -n -E "REGISTER_APP\\(|void _register_\\w+_app\\(\\)" -- "*.cpp"`,
      repoPath
    );

    if (!result.success && result.stdout.length === 0) continue;

    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;

      const colonIdx = line.indexOf(":");
      if (colonIdx < 0) continue;
      const filePart = line.slice(0, colonIdx);
      const rest = line.slice(colonIdx + 1);

      // REGISTER_APP(Name, ...)
      let match = rest.match(/REGISTER_APP\((\w+)/);
      if (match) {
        results.push({
          name: match[1],
          registration_file: filePart,
          platform: platName,
        });
        continue;
      }

      // void _register_Name_app()
      match = rest.match(/_register_(\w+)_app\(/);
      if (match) {
        results.push({
          name: match[1],
          registration_file: filePart,
          platform: platName,
        });
      }
    }
  }

  // Deduplicate by name+platform
  const seen = new Set<string>();
  return results.filter((app) => {
    const key = `${app.platform}:${app.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
