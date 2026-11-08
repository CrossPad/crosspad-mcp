#!/usr/bin/env node
// Starts crosspad-mcp-server for the Claude Code plugin.
//
// The plugin is this repository as GitHub serves it: no dist/, no
// node_modules. So the server comes from npm, at the version in
// .claude-plugin/plugin.json, installed once under ~/.local/crosspad-mcp
// (CROSSPAD_MCP_PREFIX overrides it) -- the place the manual install in the
// docs uses too. npm writes to stderr only: stdout is the MCP channel, and
// anything else on it closes the connection (why `npx` fails on some hosts).
//
// Before the server starts, this fills in what a fresh install does not set:
//   CROSSPAD_IDF_ROOT    the project Claude was opened in, when it is a
//                        platform-idf checkout (a fork anywhere on disk), else
//                        `idf_root` from ~/.config/crosspad-mcp/config.json
//   IDF_PATH             `idf_path` from that file
//   CROSSPAD_HIL_PYTHON  <idf_root>/.venv's python, where the installer puts
//                        crosspad-hil, when `hil_python` is not set -- only
//                        for the checkout in the config file, never one taken
//                        from the opened project (its .venv could be anything)
// A variable already in the environment always wins.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "crosspad-mcp-server";
const WIN = process.platform === "win32";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function log(msg) {
  process.stderr.write(`crosspad-mcp plugin: ${msg}\n`);
}

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const want = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"))?.version;
const prefix = process.env.CROSSPAD_MCP_PREFIX || path.join(os.homedir(), ".local", "crosspad-mcp");
const serverDir = path.join(prefix, "node_modules", PACKAGE);
const installedVersion = () => readJson(path.join(serverDir, "package.json"))?.version ?? null;

if (want && installedVersion() !== want) {
  log(`installing ${PACKAGE}@${want} into ${prefix}`);
  fs.mkdirSync(prefix, { recursive: true });
  // npm's own script next to this node, run without a shell from the prefix:
  // a shell would find an npm.cmd in the opened project first on Windows.
  const nodeDir = path.dirname(process.execPath);
  const npmCli = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((p) => fs.existsSync(p));
  const npmArgs = ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", `${PACKAGE}@${want}`];
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, ...npmArgs], { cwd: prefix, stdio: ["ignore", 2, 2] })
    : spawnSync("npm", npmArgs, { cwd: prefix, stdio: ["ignore", 2, 2] });
  if (r.status !== 0) {
    if (!installedVersion()) {
      log(`npm could not install ${PACKAGE}@${want} (is Node.js with npm installed and the network up?)`);
      process.exit(1);
    }
    log(`npm failed; starting the installed ${installedVersion()} instead`);
  }
}

const isPlatformIdf = (dir) =>
  typeof dir === "string" &&
  dir.length > 0 &&
  fs.existsSync(path.join(dir, "tools", "crosspad_board.py")) &&
  fs.existsSync(path.join(dir, "main"));

const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const cfg = readJson(path.join(configBase, "crosspad-mcp", "config.json")) ?? {};
const env = { ...process.env };

if (!env.CROSSPAD_IDF_ROOT) {
  if (isPlatformIdf(env.CLAUDE_PROJECT_DIR)) env.CROSSPAD_IDF_ROOT = env.CLAUDE_PROJECT_DIR;
  else if (isPlatformIdf(cfg.idf_root)) env.CROSSPAD_IDF_ROOT = cfg.idf_root;
}
if (!env.IDF_PATH && typeof cfg.idf_path === "string" && cfg.idf_path) env.IDF_PATH = cfg.idf_path;
if (!env.CROSSPAD_HIL_PYTHON && !cfg.hil_python && isPlatformIdf(cfg.idf_root)) {
  const py = WIN
    ? path.join(cfg.idf_root, ".venv", "Scripts", "python.exe")
    : path.join(cfg.idf_root, ".venv", "bin", "python");
  if (fs.existsSync(py)) env.CROSSPAD_HIL_PYTHON = py;
}

const child = spawn(process.execPath, [path.join(serverDir, "dist", "index.js"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => child.kill(sig));
}
child.on("error", (err) => {
  log(`could not start the server: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
