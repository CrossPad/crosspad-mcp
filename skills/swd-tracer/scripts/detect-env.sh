#!/usr/bin/env bash
# Detect the tracer environment and print a readiness report + suggested config.
# Read-only: writes nothing. Run this first to see what (if anything) is missing.
set -uo pipefail

VENV="${CROSSPAD_TRACE_VENV:-$HOME/.local/share/crosspad-mcp/venv}"
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/crosspad-mcp/config.json"

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
miss() { printf '  \033[31mMISS\033[0m %s\n' "$1"; }

echo "== SWD tracer environment =="

# 1. pyOCD venv
if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import pyocd, elftools" 2>/dev/null; then
  ok "pyOCD venv: $VENV/bin/python ($("$VENV/bin/python" -c 'import pyocd;print(pyocd.__version__)' 2>/dev/null))"
else
  miss "pyOCD venv at $VENV — run scripts/setup-venv.sh"
fi

# 2. user config
if [ -f "$CFG" ]; then
  ok "config: $CFG"
  sed 's/^/      /' "$CFG"
else
  miss "config $CFG — set keys via crosspad_trace action=config_set (stm_elf_path, pyocd_python)"
fi

# 3. Debug ELF (look in common spots if not configured)
ELF="${CROSSPAD_STM_ELF:-}"
if [ -z "$ELF" ]; then
  ELF=$(ls "${CROSSPAD_STM_ROOT:-$HOME/GIT/CrossPad_STM32_r20}"/build/Debug/*.elf 2>/dev/null | head -1)
fi
if [ -n "$ELF" ] && [ -f "$ELF" ]; then
  if "${VENV}/bin/python" - "$ELF" <<'PY' 2>/dev/null
import sys
from elftools.elf.elffile import ELFFile
sys.exit(0 if ELFFile(open(sys.argv[1],'rb')).has_dwarf_info() else 1)
PY
  then ok "Debug ELF with DWARF: $ELF"
  else miss "ELF $ELF has no DWARF — build the Debug preset with -g"
  fi
else
  miss "Debug ELF not found — build it (cmake --preset Debug && cmake --build build/Debug)"
fi

# 4. ST-Link on USB
if lsusb 2>/dev/null | grep -qiE '0483:(3744|3748|374b|374d|374e|374f|3753)'; then
  ok "ST-Link present on USB"
else
  miss "ST-Link NOT on USB — plug it in (or replug if it vanished after a wedged session)"
fi

# 5. udev rules
if ls /etc/udev/rules.d/*stlink* >/dev/null 2>&1; then
  ok "ST-Link udev rules present"
else
  miss "no ST-Link udev rules — run scripts/install-udev-rules.sh (needs sudo)"
fi

echo "== done =="
