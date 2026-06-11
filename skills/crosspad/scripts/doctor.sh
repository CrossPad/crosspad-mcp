#!/usr/bin/env bash
# CrossPad environment doctor — read-only. Reports which repos/env/server/registry
# are present and what to do about gaps. Writes nothing.
set -uo pipefail

GIT_DIR="${CROSSPAD_GIT_DIR:-$HOME/GIT}"

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
miss() { printf '  \033[31mMISS\033[0m %s\n' "$1"; }
info() { printf '  \033[33m..\033[0m   %s\n' "$1"; }

echo "== CrossPad environment =="

# 1. Node
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version)"
  NODE_MAJ="${NODE_V#v}"; NODE_MAJ="${NODE_MAJ%%.*}"
  if [ "${NODE_MAJ:-0}" -ge 18 ]; then ok "Node $NODE_V (>= 18)"
  else miss "Node $NODE_V is < 18 — use Node 18+ (e.g. nvm use 22)"; fi
else
  miss "node not found — install Node >= 18"
fi

# 2. Repos (only those present matter)
repo_check() { # $1 = env var name, $2 = default subdir, $3 = label
  local val="${!1:-$GIT_DIR/$2}"
  if { [ -d "$val/.git" ] || [ -d "$val" ]; } && [ -n "$(ls -A "$val" 2>/dev/null)" ]; then
    ok "$3: $val"
  else
    info "$3 not at $val — set \$$1 if it lives elsewhere"
  fi
}
repo_check CROSSPAD_PC_ROOT      crosspad-pc   "crosspad-pc (PC sim)"
repo_check CROSSPAD_IDF_ROOT     platform-idf  "platform-idf (ESP-IDF)"
repo_check CROSSPAD_ARDUINO_ROOT ESP32-S3      "ESP32-S3 (Arduino)"
repo_check CROSSPAD_CORE_ROOT    crosspad-core "crosspad-core"
repo_check CROSSPAD_GUI_ROOT     crosspad-gui  "crosspad-gui"

# 3. Toolchains (best-effort, informational)
command -v cmake  >/dev/null 2>&1 && ok "cmake present" || info "cmake not found (needed for PC build)"
command -v idf.py >/dev/null 2>&1 && ok "idf.py present" || info "idf.py not on PATH (source ESP-IDF export.sh for firmware build)"
[ -n "${IDF_PATH:-}" ] && ok "IDF_PATH=$IDF_PATH" || info "IDF_PATH unset (auto-detect tries ~/esp/esp-idf)"
[ -n "${VCPKG_ROOT:-}" ] && ok "VCPKG_ROOT=$VCPKG_ROOT" || info "VCPKG_ROOT unset (PC build deps; default ~/vcpkg)"

# 4. crosspad-mcp server: is it registered with Claude?
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -qi crosspad; then
    ok "crosspad MCP server registered with Claude"
  else
    miss "crosspad MCP server not registered — run scripts/setup.sh or: claude mcp add crosspad -- npx -y crosspad-mcp-server"
  fi
else
  info "claude CLI not found — can't check MCP registration"
fi

# 5. Local server build (only relevant when run from inside the repo)
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../.." 2>/dev/null && pwd)"
if [ -f "$REPO_ROOT/package.json" ] && grep -q '"crosspad-mcp-server"' "$REPO_ROOT/package.json" 2>/dev/null; then
  if [ -f "$REPO_ROOT/dist/index.js" ]; then ok "server built: $REPO_ROOT/dist/index.js"
  else miss "server not built — run 'npm run build' in $REPO_ROOT"; fi
fi

echo "== done =="
echo "Next: read reference/install.md (setup) or reference/role-*.md (your role). For trace: swd-tracer skill."
