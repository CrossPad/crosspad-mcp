import fs from "fs";
import { getRepos } from "../config.js";
import { runCommand } from "../utils/exec.js";

export interface SymbolResult {
  symbol: string;
  kind: "class" | "function" | "macro" | "enum" | "typedef";
  file: string;
  line: number;
  context: string;
  repo: string;
}

export interface SymbolSearchResult {
  query: string;
  kind_filter: string;
  results: SymbolResult[];
  total_matches: number;
  truncated: boolean;
}

/**
 * Build a regex pattern that matches definition lines containing the query.
 * Each kind has a specific pattern that only matches declarations/definitions.
 */
function buildPattern(query: string, kind: string): string {
  const q = query; // Already escaped by caller
  const patterns: string[] = [];

  if (kind === "class" || kind === "all") {
    // class/struct definition: class Foo { or class Foo : public Bar {
    patterns.push(`(class|struct)\\s+\\w*${q}\\w*\\s*[:{]`);
    patterns.push(`(class|struct)\\s+\\w*${q}\\w*\\s*$`); // multi-line def
  }
  if (kind === "macro" || kind === "all") {
    patterns.push(`#define\\s+\\w*${q}\\w*`);
  }
  if (kind === "enum" || kind === "all") {
    patterns.push(`enum\\s+(class\\s+)?\\w*${q}\\w*`);
  }
  if (kind === "typedef" || kind === "all") {
    patterns.push(`using\\s+\\w*${q}\\w*\\s*=`);
    patterns.push(`typedef\\s+.*\\b\\w*${q}\\w*\\s*;`);
  }
  if (kind === "function" || kind === "all") {
    // Function definition: type name( or void name(  — exclude calls by requiring return type or line start
    patterns.push(`^\\w[\\w:\\s*&<>]+\\b\\w*${q}\\w*\\s*\\(`);
  }

  return patterns.join("|");
}

/**
 * Search for symbol definitions (classes, functions, macros, enums) across CrossPad repos.
 * Only matches definition lines, not usages.
 */
export function crosspadSearchSymbols(
  query: string,
  kind: string = "all",
  repos: string[] = ["all"],
  maxResults: number = 50
): SymbolSearchResult {
  const results: SymbolResult[] = [];

  const allRepos = getRepos();
  const targetRepos = repos.includes("all")
    ? Object.entries(allRepos)
    : Object.entries(allRepos).filter(([name]) => repos.includes(name));

  const pattern = buildPattern(escapeForRegex(query), kind);
  if (!pattern) {
    return { query, kind_filter: kind, results: [], total_matches: 0, truncated: false };
  }

  for (const [repoName, repoPath] of targetRepos) {
    if (!fs.existsSync(repoPath)) continue;

    const grepCmd = `git grep --recurse-submodules -n -E "${escapeForShell(pattern)}" -- "*.hpp" "*.h" "*.cpp" "*.c"`;
    const result = runCommand(grepCmd, repoPath, 30_000);

    if (!result.success && result.stdout.length === 0) continue;

    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;

      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) continue;

      const [, file, lineStr, content] = match;
      const lineNum = parseInt(lineStr, 10);
      const trimmedContent = content.trim();

      // Skip forward declarations (class Foo;)
      if (/^\s*(class|struct)\s+\w+\s*;/.test(trimmedContent)) continue;
      // Skip includes
      if (/^\s*#include/.test(trimmedContent)) continue;
      // Skip comments
      if (/^\s*(\/\/|\/\*|\*)/.test(trimmedContent)) continue;

      const detectedKind = classifyDefinition(trimmedContent);
      if (!detectedKind) continue;
      if (kind !== "all" && detectedKind !== kind) continue;

      const symbolName = extractSymbolName(trimmedContent, detectedKind);
      if (!symbolName) continue;

      // Symbol name must contain query
      if (!symbolName.toLowerCase().includes(query.toLowerCase())) continue;

      // Deduplicate by symbol+file
      const key = `${symbolName}:${file}`;
      if (results.some((r) => `${r.symbol}:${r.file.split("/").pop()}` === key)) continue;

      results.push({
        symbol: symbolName,
        kind: detectedKind,
        file: `${repoPath}/${file}`.replace(/\\/g, "/"),
        line: lineNum,
        context: trimmedContent.slice(0, 150),
        repo: repoName,
      });

      if (results.length >= maxResults) break;
    }

    if (results.length >= maxResults) break;
  }

  return {
    query,
    kind_filter: kind,
    results: results.slice(0, maxResults),
    total_matches: results.length,
    truncated: results.length >= maxResults,
  };
}

function escapeForShell(s: string): string {
  // Only escape shell metacharacters, NOT backslashes (needed for regex \s \w etc.)
  return s.replace(/["`$]/g, "\\$&");
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyDefinition(line: string): SymbolResult["kind"] | null {
  if (/^\s*#define\s+/.test(line)) return "macro";
  if (/^\s*enum\s+/.test(line)) return "enum";
  if (/^\s*(typedef|using)\s+/.test(line)) return "typedef";
  if (/^\s*(class|struct)\s+\w+/.test(line)) return "class";
  // Function: starts with type qualifier, has word( pattern
  if (/^[\w:][\w:\s*&<>,]*\b\w+\s*\(/.test(line) &&
      !/^\s*(if|while|for|switch|return|delete|new|throw|sizeof)\b/.test(line)) {
    return "function";
  }
  return null;
}

function extractSymbolName(line: string, kind: SymbolResult["kind"]): string | null {
  switch (kind) {
    case "class": {
      const m = line.match(/(?:class|struct)\s+(\w+)/);
      return m ? m[1] : null;
    }
    case "macro": {
      const m = line.match(/#define\s+(\w+)/);
      return m ? m[1] : null;
    }
    case "enum": {
      const m = line.match(/enum\s+(?:class\s+)?(\w+)/);
      return m ? m[1] : null;
    }
    case "typedef": {
      const m = line.match(/using\s+(\w+)\s*=/) || line.match(/typedef\s+.*\b(\w+)\s*;/);
      return m ? m[1] : null;
    }
    case "function": {
      // Last word before opening paren: returnType funcName(
      const m = line.match(/\b(\w+)\s*\(/);
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}
