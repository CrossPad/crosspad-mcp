#!/usr/bin/env bash
# CrossPad .mcp.json doctor + fixer.
#
# Known issue in this ecosystem: `.mcp.json` configs using
#   { "command": "npx", "args": ["-y", "crosspad-mcp-server"] }
# have been observed to crash Claude Code's MCP client outright
# (`MCP error -32000: Connection closed`) on some machines — npx's own
# startup output pollutes the stdio JSON-RPC channel. This script scans
# known CrossPad repos under $CROSSPAD_GIT_DIR (default ~/GIT) for that
# pattern and rewrites it to launch a stable local install directly via
# `node`, which does not have this problem.
#
# Read-only by default (reports what it would change). Pass --fix to apply.
# Safe to re-run: repos already on the safe pattern are left untouched, and
# every rewritten file is backed up first (.mcp.json.bak-<timestamp>).
set -uo pipefail

GIT_DIR="${CROSSPAD_GIT_DIR:-$HOME/GIT}"
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

# Known CrossPad repos that carry their own project-scoped .mcp.json.
REPOS=(crosspad-pc platform-idf ESP32-S3 crosspad-apps CrossPad_STM32_r20 crosspad-mcp)

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mNPX\033[0m  %s\n' "$1"; }
info() { printf '  \033[33m..\033[0m   %s\n' "$1"; }

# ── Resolve a stable node launch target ─────────────────────────────────
# Prefer a local crosspad-mcp dev checkout (this script's own repo, if
# running from inside one and it's built) so local changes are picked up
# immediately; otherwise use/create a stable global install independent of
# any git checkout.
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_REPO_ROOT="$(cd "$SKILL_DIR/../.." 2>/dev/null && pwd || true)"
NODE_TARGET=""
if [ -n "$DEV_REPO_ROOT" ] && [ -f "$DEV_REPO_ROOT/package.json" ] \
   && grep -q '"crosspad-mcp-server"' "$DEV_REPO_ROOT/package.json" 2>/dev/null \
   && [ -f "$DEV_REPO_ROOT/dist/index.js" ]; then
  NODE_TARGET="$DEV_REPO_ROOT/dist/index.js"
  info "Using local dev build: $NODE_TARGET"
else
  STABLE_DIR="$HOME/.local/crosspad-mcp"
  STABLE_ENTRY="$STABLE_DIR/node_modules/crosspad-mcp-server/dist/index.js"
  if [ ! -f "$STABLE_ENTRY" ]; then
    if [ "$FIX" = "1" ]; then
      info "No stable install found — installing to $STABLE_DIR"
      npm i --prefix "$STABLE_DIR" crosspad-mcp-server@latest >/dev/null 2>&1 \
        || { echo "ERROR: npm install failed" >&2; exit 1; }
    else
      info "No stable install at $STABLE_ENTRY yet — would install on --fix"
    fi
  fi
  NODE_TARGET="$STABLE_ENTRY"
fi

echo "== .mcp.json scan (GIT_DIR=$GIT_DIR) =="

CHANGED=0
for repo in "${REPOS[@]}"; do
  f="$GIT_DIR/$repo/.mcp.json"
  [ -f "$f" ] || { info "$repo: no .mcp.json"; continue; }

  # Does the crosspad server entry use npx? (simple grep first, cheap)
  if ! grep -q '"crosspad"' "$f" 2>/dev/null; then
    info "$repo: .mcp.json has no 'crosspad' server entry"
    continue
  fi
  if ! grep -q '"npx"' "$f" 2>/dev/null; then
    ok "$repo: already on a non-npx command"
    continue
  fi

  bad "$repo: .mcp.json uses npx (known crash pattern) — $f"
  if [ "$FIX" != "1" ]; then
    continue
  fi

  ts="$(date +%s)"
  cp "$f" "$f.bak-$ts"
  python3 - "$f" "$NODE_TARGET" <<'PYEOF'
import json, sys
path, node_target = sys.argv[1], sys.argv[2]
with open(path) as fh:
    data = json.load(fh)
srv = data.get("mcpServers", {}).get("crosspad")
if srv is None:
    sys.exit(0)
srv["command"] = "node"
srv["args"] = [node_target]
with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PYEOF
  ok "$repo: rewritten to use node directly (backup: $f.bak-$ts)"
  CHANGED=$((CHANGED + 1))
done

echo "== done =="
if [ "$FIX" = "1" ]; then
  echo "$CHANGED repo(s) fixed. Restart Claude Code sessions in those repos to pick it up."
else
  echo "Read-only scan. Re-run with --fix to apply the rewrite (backups are made automatically)."
fi
