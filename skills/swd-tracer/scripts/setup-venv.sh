#!/usr/bin/env bash
# Create the pyOCD virtualenv the SWD tracer daemon runs in.
#
# The system Python is usually PEP-668 "externally managed" (Debian/Ubuntu), so
# pyocd/pyelftools cannot be pip-installed globally — a venv is required. The
# tracer's user config key `pyocd_python` must point at this venv's python.
set -euo pipefail

VENV="${CROSSPAD_TRACE_VENV:-$HOME/.local/share/crosspad-mcp/venv}"

echo "[setup-venv] target venv: $VENV"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
# pyocd 0.44+ for the SWD backend; pyelftools for DWARF symbol resolution.
"$VENV/bin/pip" install --quiet "pyocd>=0.44" pyelftools

echo "[setup-venv] installed:"
"$VENV/bin/python" - <<'PY'
import pyocd, elftools
print("  pyocd     ", pyocd.__version__)
print("  pyelftools", getattr(elftools, "__version__", "?"))
PY
echo "[setup-venv] DONE. Set the tracer config:"
echo "  crosspad_trace action=config_set key=pyocd_python value=$VENV/bin/python"
