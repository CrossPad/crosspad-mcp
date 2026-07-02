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
PC_ROOT="$(ask 'crosspad-pc repo path'      "$GIT_DIR/crosspad-pc")"
IDF_ROOT="$(ask 'platform-idf repo path'    "$GIT_DIR/platform-idf")"
ARDUINO_ROOT="$(ask 'ESP32-S3 repo path'    "$GIT_DIR/ESP32-S3")"
STM_ROOT="$(ask 'CrossPad_STM32_r20 repo path' "$GIT_DIR/CrossPad_STM32_r20")"

ENV_ARGS=()
[ -d "$PC_ROOT" ]      && ENV_ARGS+=(--env "CROSSPAD_PC_ROOT=$PC_ROOT")
[ -d "$IDF_ROOT" ]     && ENV_ARGS+=(--env "CROSSPAD_IDF_ROOT=$IDF_ROOT")
[ -d "$ARDUINO_ROOT" ] && ENV_ARGS+=(--env "CROSSPAD_ARDUINO_ROOT=$ARDUINO_ROOT")
[ -d "$STM_ROOT" ]     && ENV_ARGS+=(--env "CROSSPAD_STM_ROOT=$STM_ROOT")

# 5. Resolve a launch target that isn't bare npx — npx has been observed to
# crash Claude Code's MCP client on real dev machines in this ecosystem
# (stdio pollution). Prefer a local dev checkout if this script is running
# from inside one; otherwise install/use a stable global copy.
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_REPO_ROOT="$(cd "$SKILL_DIR/../.." 2>/dev/null && pwd || true)"
if [ -n "$DEV_REPO_ROOT" ] && [ -f "$DEV_REPO_ROOT/package.json" ] \
   && grep -q '"crosspad-mcp-server"' "$DEV_REPO_ROOT/package.json" 2>/dev/null \
   && [ -f "$DEV_REPO_ROOT/dist/index.js" ]; then
  NODE_TARGET="$DEV_REPO_ROOT/dist/index.js"
  echo "Using local dev build: $NODE_TARGET"
else
  STABLE_DIR="$HOME/.local/crosspad-mcp"
  NODE_TARGET="$STABLE_DIR/node_modules/crosspad-mcp-server/dist/index.js"
  if [ ! -f "$NODE_TARGET" ]; then
    echo "Installing a stable local copy to $STABLE_DIR ..."
    npm i --prefix "$STABLE_DIR" crosspad-mcp-server@latest \
      || { echo "ERROR: npm install failed" >&2; exit 1; }
  fi
fi

# 6. Register
echo "Registering crosspad MCP server (via node, not npx)..."
claude mcp add crosspad "${ENV_ARGS[@]}" -- node "$NODE_TARGET"

# 7. Offer to fix other repos' .mcp.json if any use the crash-prone npx pattern
echo
echo "Checking other CrossPad repos' .mcp.json for the same npx issue..."
bash "$SKILL_DIR/scripts/fix-mcp-json.sh" || true
FIX_ANS="$(ask 'Rewrite any repos found above to the safe pattern now?' 'y')"
if [ "$FIX_ANS" = "y" ] || [ "$FIX_ANS" = "Y" ]; then
  bash "$SKILL_DIR/scripts/fix-mcp-json.sh" --fix
fi

echo "== done =="
echo "Restart Claude Code, then run scripts/doctor.sh to verify."
