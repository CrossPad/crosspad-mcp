#!/usr/bin/env bash
# CrossPad assisted setup — registers the crosspad-mcp server with Claude and
# helps set repo env vars. Idempotent: safe to re-run. Prompts before changes;
# pass --yes to accept defaults non-interactively.
set -uo pipefail

YES=0
[ "${1:-}" = "--yes" ] && YES=1

ask() { # $1 = prompt, $2 = default; echoes the answer
  local ans
  if [ "$YES" = "1" ]; then echo "$2"; return; fi
  read -r -p "$1 [$2]: " ans
  echo "${ans:-$2}"
}

echo "== CrossPad setup =="

# 1. Node check (hard requirement)
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node is required (>= 18). Install it (e.g. via nvm) and re-run." >&2
  exit 1
fi

# 2. claude CLI check
if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found. Install Claude Code, then re-run — or add the server"
  echo "manually via a .mcp.json (see reference/install.md)."
  exit 1
fi

# 3. Already registered?
if claude mcp list 2>/dev/null | grep -qi crosspad; then
  echo "crosspad MCP server already registered. Nothing to do."
  echo "(Re-add with different env? Remove first: claude mcp remove crosspad)"
  exit 0
fi

# 4. Collect repo paths (only pass env for ones the user confirms exist)
GIT_DIR="${CROSSPAD_GIT_DIR:-$HOME/GIT}"
PC_ROOT="$(ask 'crosspad-pc repo path'  "$GIT_DIR/crosspad-pc")"
IDF_ROOT="$(ask 'platform-idf repo path' "$GIT_DIR/platform-idf")"

ENV_ARGS=()
[ -d "$PC_ROOT" ]  && ENV_ARGS+=(--env "CROSSPAD_PC_ROOT=$PC_ROOT")
[ -d "$IDF_ROOT" ] && ENV_ARGS+=(--env "CROSSPAD_IDF_ROOT=$IDF_ROOT")

# 5. Register
echo "Registering crosspad MCP server..."
claude mcp add crosspad "${ENV_ARGS[@]}" -- npx -y crosspad-mcp-server

echo "== done =="
echo "Restart Claude Code, then run scripts/doctor.sh to verify."
