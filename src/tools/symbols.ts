import fs from "fs";
import { getRepos } from "../config.js";
import { runCommand } from "../utils/exec.js";

export interface SymbolResult {
  symbol: string;
  kind: "class" | "function" | "macro" | "enum" | "typedef";
  file: string;
  line: number;
  context: string;
  surrounding?: string[];
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
/** @internal exported for testing */
export function buildPattern(query: string, kind: string): string {
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
  maxResults: number = 50,
  contextLines: number = 0,
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

  const clampedContext = Math.min(Math.max(contextLines, 0), 10);
  const useContext = clampedContext > 0;

  for (const [repoName, repoPath] of targetRepos) {
    if (!fs.existsSync(repoPath)) continue;

    const contextFlag = useContext ? `-C ${clampedContext}` : "";
    const grepCmd = `git grep --recurse-submodules -n ${contextFlag} -E "${escapeForShell(pattern)}" -- "*.hpp" "*.h" "*.cpp" "*.c"`;
    const result = runCommand(grepCmd, repoPath, 30_000);

    if (!result.success && result.stdout.length === 0) continue;

    if (useContext) {
      // Context mode: output has `--` separators between groups
      const blocks = result.stdout.split(/^--$/m);
      for (const block of blocks) {
        const blockLines = block.split("\n").filter((l) => l.trim());
        if (blockLines.length === 0) continue;

        // Find the matching line (has line number, not `-` context separator)
        let matchFile = "";
        let matchLine = 0;
        let matchContent = "";
        const surrounding: string[] = [];

        for (const bline of blockLines) {
          // Match line format: file:123:content (colon separator for match)
          const matchResult = bline.match(/^([^:]+):(\d+):(.*)$/);
          // Context line format: file-123-content (dash separator)
          const contextResult = bline.match(/^([^-]+)-(\d+)-(.*)$/);

          if (matchResult && !matchFile) {
            matchFile = matchResult[1];
            matchLine = parseInt(matchResult[2], 10);
            matchContent = matchResult[3].trim();
          }

          if (matchResult || contextResult) {
            const content = matchResult ? matchResult[3] : contextResult![3];
            surrounding.push(content);
          }
        }

        if (!matchFile || !matchContent) continue;

        // Apply same filters as non-context mode
        if (/^\s*(class|struct)\s+\w+\s*;/.test(matchContent)) continue;
        if (/^\s*#include/.test(matchContent)) continue;
        if (/^\s*(\/\/|\/\*|\*)/.test(matchContent)) continue;

        const detectedKind = classifyDefinition(matchContent);
        if (!detectedKind) continue;
        if (kind !== "all" && detectedKind !== kind) continue;

        const symbolName = extractSymbolName(matchContent, detectedKind);
        if (!symbolName) continue;
        if (!symbolName.toLowerCase().includes(query.toLowerCase())) continue;

        const key = `${symbolName}:${matchFile}`;
        if (results.some((r) => `${r.symbol}:${r.file.split("/").pop()}` === key)) continue;

        results.push({
          symbol: symbolName,
          kind: detectedKind,
          file: `${repoPath}/${matchFile}`.replace(/\\/g, "/"),
          line: matchLine,
          context: matchContent.slice(0, 150),
          surrounding,
          repo: repoName,
        });

        if (results.length >= maxResults) break;
      }
    } else {
      // Standard mode (no context)
      for (const line of result.stdout.split("\n")) {
        if (!line.trim()) continue;

        const match = line.match(/^([^:]+):(\d+):(.*)$/);
        if (!match) continue;

        const [, file, lineStr, content] = match;
        const lineNum = parseInt(lineStr, 10);
        const trimmedContent = content.trim();

        if (/^\s*(class|struct)\s+\w+\s*;/.test(trimmedContent)) continue;
        if (/^\s*#include/.test(trimmedContent)) continue;
        if (/^\s*(\/\/|\/\*|\*)/.test(trimmedContent)) continue;

        const detectedKind = classifyDefinition(trimmedContent);
        if (!detectedKind) continue;
        if (kind !== "all" && detectedKind !== kind) continue;

        const symbolName = extractSymbolName(trimmedContent, detectedKind);
        if (!symbolName) continue;
        if (!symbolName.toLowerCase().includes(query.toLowerCase())) continue;

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

/** @internal exported for testing */
export function escapeForShell(s: string): string {
  // Only escape shell metacharacters, NOT backslashes (needed for regex \s \w etc.)
  return s.replace(/["`$]/g, "\\$&");
}

/** @internal exported for testing */
export function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @internal exported for testing */
export function classifyDefinition(line: string): SymbolResult["kind"] | null {
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

/** @internal exported for testing */
export function extractSymbolName(line: string, kind: SymbolResult["kind"]): string | null {
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
