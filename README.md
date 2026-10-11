# crosspad-mcp

[![npm](https://img.shields.io/npm/v/crosspad-mcp-server)](https://www.npmjs.com/package/crosspad-mcp-server) [![M8ven Live Monitored](https://m8ven.ai/badge/mcp/crosspad-crosspad-mcp-11gso3)](https://m8ven.ai/mcp/crosspad-crosspad-mcp-11gso3) [![CI](https://github.com/CrossPad/crosspad-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/CrossPad/crosspad-mcp/actions/workflows/ci.yml) [![node](https://img.shields.io/node/v/crosspad-mcp-server)](package.json) [![license: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](#license)

An [MCP](https://modelcontextprotocol.io) server that lets Claude Code (or any MCP client) develop for the [CrossPad](https://github.com/CrossPad) pad controller: build and flash the ESP32-S3 and STM32 firmware, drive the PC simulator, run hardware-in-the-loop tests, decode crashes, trace STM32 variables over SWD and manage apps from the registry. Tools come in toolsets; only `core` is on at start, and flashing, DFU and SWD writes ask for confirmation first.

## Install

Needs Node.js 18 or newer. Launch the server with `node`, never through `npx` (npx breaks the stdio channel):

```bash
npm i --prefix ~/.local/crosspad-mcp crosspad-mcp-server@latest
claude mcp add -s user crosspad -- node ~/.local/crosspad-mcp/node_modules/crosspad-mcp-server/dist/index.js
```

Restart Claude Code and ask *"is my CrossPad connected, and is the toolchain set up?"* — that runs `crosspad_doctor`. For the bundled skills, symlink them from a clone; the `crosspad` plugin adds them too, but also a second server entry — see [Skills, and the plugin's second server](skills/crosspad/reference/install.md#skills-and-the-plugins-second-server).

## Configuration

Repos are looked up under `~/GIT/` (`CROSSPAD_GIT_DIR`); point elsewhere with `--env CROSSPAD_IDF_ROOT=…`, `CROSSPAD_PC_ROOT`, `IDF_PATH` or `CROSSPAD_HIL_PYTHON` on the `claude mcp add` line. `--toolsets device,hil` (or `all`) starts with more toolsets; `--read-only` hides every tool that writes. All variables: [docs/USAGE.md](docs/USAGE.md#configuration).

## Documentation

- CrossPad SDK docs: https://crosspad.app/docs/ — [Start here](https://crosspad.app/docs/start-here/), [MCP tools](https://crosspad.app/docs/reference/mcp-tools/), [Test on hardware (HIL)](https://crosspad.app/docs/how-to/hil-testing/), [Troubleshooting: MCP](https://crosspad.app/docs/troubleshooting/#mcp)
- [docs/USAGE.md](docs/USAGE.md) — example prompts, every tool, toolset, resource and prompt, configuration, HTTP transport, the v9 → v10 migration
- Agents: the [`crosspad` skill](skills/crosspad/SKILL.md) (ecosystem map, per-role guides, FAQ), [`swd-tracer`](skills/swd-tracer/SKILL.md), [`before-after`](skills/before-after/SKILL.md) · [CHANGELOG](CHANGELOG.md)

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Part of the [CrossPad](https://github.com/CrossPad) project. Releases up to 10.3.0 were published under MIT.
