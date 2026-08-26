# crosspad-hil P0 core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `crosspad-hil` Python package — the single owner of every way a host talks to a CrossPad (serial CDC, STM console, USB MIDI/SysEx, USB mode, OTA) with every hardware trap encoded once and unit-tested without hardware.

**Architecture:** A new repo `CrossPad/crosspad-hil` with a layered library: `serial_open`/`locks` (hygiene) → `devices` (discovery + selection) → `parsers` → `console`/`cdc` (sessions) → `verbs`/`midi`/`usbmode`/`ota` (typed operations) → `snapshot` (one-call device state with UI refs). Every I/O object takes an injectable factory so tests run on `FakeSerial`/fake MIDI. Plan B (scenarios, CLI, daemon) builds on these modules; crosspad-mcp v10 (plan C) consumes the daemon.

**Tech Stack:** Python ≥ 3.10, pyserial, python-rtmidi, pydantic ≥ 2, PyYAML; extras `audio` (sounddevice, numpy, scipy), `ble` (bleak); pytest, ruff; GitHub Actions (ubuntu + windows, py3.10/3.12).

**Spec:** `crosspad-mcp/docs/superpowers/specs/2026-08-25-crosspad-hil-and-mcp-v10-design.md` (§2 architecture, §2.3 device model, §2.4 hygiene invariants, §7 testing, §8 phase P0). **Contract:** the "interface contract" section below is authoritative for every name and signature; tasks argue from it.

## Global Constraints

- Repo path `/home/matixan/GIT/crosspad-hil`, package `crosspad_hil`, PyPI name `crosspad-hil`, version `1.0.0`, MIT.
- Python ≥ 3.10; runtime deps only `pyserial`, `python-rtmidi`, `pydantic>=2`, `PyYAML`; audio/BLE deps only in extras and imported lazily.
- No test may require hardware; every I/O class accepts an injectable factory (`serial_factory`, `Backends`, `out_factory`/`in_factory`, `discover_fn`).
- Hygiene invariants (spec §2.4) are tests, not comments: STM VCP opened with DTR/RTS deasserted; reset only via `reset_pulse`/`Console.reset`; `F0 7D 19 01 F7` refused; `0x1B` only on the ESP MIDI role; `OK` never treated as the ack of a specific verb.
- Errors are `HilError(code, message, hint, **details)`; codes are the constants in `errors.py` — never bare strings.
- ruff clean at line length 100; type hints on every public function; no module-level mutable state except the knowledge cache and the scenario registry.
- Commit after every task with a Conventional Commit message.

---
# Plan A — chunk A1: repo scaffold, errors, fakes, knowledge

Repo: `/home/matixan/GIT/crosspad-hil` (new; `git init` in Task 1 Step 0). Package `crosspad_hil`. Every path below is absolute or relative to that repo root. Names follow `contract.md` verbatim.

Origin material ported here (cite kept in code comments):
- `platform-idf/tools/hil_smoke.py` — `REQUIRED_MARKERS`, `OPTIONAL_MARKERS`, `ERROR_ALLOWLIST`, `FATAL_PATTERNS`, `BOOT_MARKERS`
- `platform-idf/tools/hil_stability.py` — `REQUIRED_MARKERS` (6), `FATAL_PATTERNS`, `RST_REASON_RE`, `HEAP_FREE_RE`, `BOOT_WINDOW_S = 45`
- `platform-idf/tools/hil_kit_churn.py` — `FATAL_RE` (union), `KIT_REQ_RE`, `CDC_DROP_RE`
- `platform-idf/main/hil_control.cpp`, `main/audio_route_control.cpp`, `main/ota_cdc.cpp`, `main/usb_config_manager.cpp`, `main/main.cpp` (`BOOTLOADER_REQUEST`) — the CDC verbs and reply prefixes
- `platform-idf/tools/hil_sampler_record.py`, `main/audio_route_control.cpp` — SysEx ids and sub-ids

---

### Task 1: Repo scaffold, `HilError`, test fakes

**Files:**
- Create: `pyproject.toml`
- Create: `crosspad_hil/__init__.py`
- Create: `crosspad_hil/errors.py`
- Create: `.github/workflows/ci.yml`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `README.md`
- Create: `tests/__init__.py` (empty)
- Create: `tests/fakes.py`
- Create: `tests/conftest.py`
- Test: `tests/test_errors.py`
- Test: `tests/test_fakes.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `crosspad_hil.__version__: str = "1.0.0"`
  - `crosspad_hil.errors.HilError(code: str, message: str, hint: str | None = None, **details: Any)` with attributes `code`, `message`, `hint`, `details` and `to_dict() -> dict` returning exactly `{"code", "message", "hint", "details"}`; `str(err)` is `f"{code}: {message}"`.
  - Code constants in `crosspad_hil.errors`: `NO_DEVICE, AMBIGUOUS_DEVICE, PORT_BUSY, NO_CDC_IN_AUDIO_MODE, TIMEOUT, UNKNOWN_VERB, DENIED_SYSEX, BAD_SYSEX, HANDLE_EXPIRED, BAD_ARGS, FLASH_FAILED, ENV, CANCELLED, NOT_SUPPORTED` (each a `str` equal to its own name) and `ALL_CODES: tuple[str, ...]`.
  - `tests.fakes.FakeSerial(script: Sequence[tuple[str, str | list[str]]] = (), *, timeout: float = 0.2)` — pyserial-shaped: attributes `port`, `baudrate`, `timeout`, `is_open`, `dtr`, `rts` (properties; every assignment appended to `control_history: list[tuple[str, bool]]`), `written: list[str]` (decoded commands without trailing newline), `in_waiting`; methods `open()`, `close()`, `write(b) -> int`, `readline() -> bytes`, `read(n=1) -> bytes`, `flush()`, `reset_input_buffer()`, `feed(lines: Iterable[str])`. Unknown commands are **echoed back** (device behaviour: `hil_control_handle_cdc` returns false → main loop echoes). Scripted replies are enqueued each with `"\r\n"`. `readline()` returns `b""` after sleeping `timeout` when the queue is empty.
  - `tests.fakes.FakeMidiOut()` — `get_ports() -> list[str]` (`ports` attr settable), `open_port(i)`, `close_port()`, `send_message(msg: Sequence[int])`, `sent: list[list[int]]`, `is_port_open() -> bool`.
  - `tests.fakes.FakeMidiIn()` — `get_ports()`, `open_port(i)`, `close_port()`, `ignore_types(sysex=False, timing=True, active_sense=True)`, `get_message() -> tuple[list[int], float] | None`, `feed(frames: Iterable[Sequence[int]])`.
  - Fixtures in `tests/conftest.py`: `fake_serial` (factory: `fake_serial(script=(), timeout=0.01) -> FakeSerial`), `fake_midi` (`-> tuple[FakeMidiOut, FakeMidiIn]`), `knowledge` (`-> dict` with keys `markers`, `sysex`, `cdc` — loads lazily via `crosspad_hil.knowledge.load`, so it works only after Task 2), `fake_backends` (lazy import of `crosspad_hil.devices` — usable only after Plan A chunk 2 delivers `devices.py`; requesting it before that skips the test with `pytest.skip`).

- [ ] **Step 0: Create the repository**

```bash
mkdir -p /home/matixan/GIT/crosspad-hil && cd /home/matixan/GIT/crosspad-hil && git init -b main
mkdir -p crosspad_hil/knowledge tests/fixtures/transcripts .github/workflows
python3 -m venv .venv && . .venv/bin/activate && pip install -U pip
```

- [ ] **Step 1: Write the failing tests**

`tests/test_errors.py`:
```python
"""HilError shape — the daemon serialises it verbatim, so the dict keys are a contract."""
from __future__ import annotations

import pytest

from crosspad_hil import __version__
from crosspad_hil import errors
from crosspad_hil.errors import ALL_CODES, HilError


def test_version_is_1_0_0() -> None:
    assert __version__ == "1.0.0"


def test_to_dict_has_exactly_four_keys() -> None:
    err = HilError(errors.TIMEOUT, "no reply to KIT_STATUS", hint="is the device in UAC2 mode?",
                   port="/dev/ttyACM0", timeout_s=2.0)
    d = err.to_dict()
    assert set(d) == {"code", "message", "hint", "details"}
    assert d["code"] == "TIMEOUT"
    assert d["message"] == "no reply to KIT_STATUS"
    assert d["hint"] == "is the device in UAC2 mode?"
    assert d["details"] == {"port": "/dev/ttyACM0", "timeout_s": 2.0}


def test_hint_defaults_to_none_and_details_to_empty() -> None:
    err = HilError(errors.NO_DEVICE, "no CrossPad found")
    assert err.hint is None
    assert err.details == {}
    assert err.to_dict() == {"code": "NO_DEVICE", "message": "no CrossPad found",
                             "hint": None, "details": {}}


def test_str_is_code_colon_message() -> None:
    assert str(HilError(errors.BAD_ARGS, "pad must be 0..15")) == "BAD_ARGS: pad must be 0..15"


def test_is_an_exception() -> None:
    with pytest.raises(HilError) as ei:
        raise HilError(errors.CANCELLED, "stopped")
    assert ei.value.code == "CANCELLED"


@pytest.mark.parametrize("code", [
    "NO_DEVICE", "AMBIGUOUS_DEVICE", "PORT_BUSY", "NO_CDC_IN_AUDIO_MODE", "TIMEOUT",
    "UNKNOWN_VERB", "DENIED_SYSEX", "BAD_SYSEX", "HANDLE_EXPIRED", "BAD_ARGS",
    "FLASH_FAILED", "ENV", "CANCELLED", "NOT_SUPPORTED",
])
def test_every_code_constant_exists_and_equals_its_name(code: str) -> None:
    assert getattr(errors, code) == code
    assert code in ALL_CODES


def test_all_codes_has_fourteen_entries() -> None:
    assert len(ALL_CODES) == 14
    assert len(set(ALL_CODES)) == 14


def test_unknown_code_is_rejected() -> None:
    with pytest.raises(ValueError):
        HilError("NOT_A_CODE", "x")
```

`tests/test_fakes.py`:
```python
"""The fakes are the test suite's hardware; their behaviour must match the real device."""
from __future__ import annotations

from tests.fakes import FakeMidiIn, FakeMidiOut, FakeSerial


def test_scripted_reply_is_returned_with_crlf() -> None:
    ser = FakeSerial([("KIT_STATUS", "KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS")],
                     timeout=0.01)
    ser.open()
    ser.write(b"KIT_STATUS\n")
    assert ser.readline() == b"KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS\r\n"
    assert ser.readline() == b""


def test_multi_line_reply_comes_out_in_order() -> None:
    ser = FakeSerial([("ENC_GROUP", ["ENCGROUP: count=2", "  [0] 0x3fc9a000 Sampler",
                                     "  [1] 0x3fc9a100 Settings"])], timeout=0.01)
    ser.open()
    ser.write(b"ENC_GROUP\n")
    assert ser.readline() == b"ENCGROUP: count=2\r\n"
    assert ser.readline() == b"  [0] 0x3fc9a000 Sampler\r\n"
    assert ser.readline() == b"  [1] 0x3fc9a100 Settings\r\n"


def test_unknown_command_is_echoed_back_like_the_device() -> None:
    # hil_control_handle_cdc() returns false for unknown verbs and main.cpp echoes the line
    ser = FakeSerial(timeout=0.01)
    ser.open()
    ser.write(b"FROBNICATE 1\n")
    assert ser.readline() == b"FROBNICATE 1\r\n"


def test_written_records_decoded_commands_without_newline() -> None:
    ser = FakeSerial([("PAD_PRESS 3 100", "OK")], timeout=0.01)
    ser.open()
    ser.write(b"PAD_PRESS 3 100\n")
    ser.write(b"PAD_RELEASE 3\r\n")
    assert ser.written == ["PAD_PRESS 3 100", "PAD_RELEASE 3"]


def test_feed_pushes_unsolicited_lines() -> None:
    ser = FakeSerial(timeout=0.01)
    ser.open()
    ser.feed(["ESP-ROM:esp32s3-20210327", "I (123) main: All systems operational"])
    assert ser.readline() == b"ESP-ROM:esp32s3-20210327\r\n"
    assert ser.readline() == b"I (123) main: All systems operational\r\n"


def test_control_history_records_every_dtr_rts_assignment() -> None:
    ser = FakeSerial()
    ser.dtr = False
    ser.rts = True
    ser.rts = False
    assert ser.control_history == [("dtr", False), ("rts", True), ("rts", False)]
    assert ser.dtr is False and ser.rts is False


def test_pyserial_shaped_open_close() -> None:
    ser = FakeSerial()
    assert ser.is_open is False
    ser.port = "/dev/ttyACM9"
    ser.baudrate = 115200
    ser.timeout = 0.2
    ser.open()
    assert ser.is_open is True
    ser.close()
    assert ser.is_open is False


def test_read_n_bytes_and_in_waiting() -> None:
    ser = FakeSerial([("MEM", "MEM: int_free=1")], timeout=0.01)
    ser.open()
    ser.write(b"MEM\n")
    assert ser.in_waiting == len(b"MEM: int_free=1\r\n")
    assert ser.read(4) == b"MEM:"
    assert ser.readline() == b" int_free=1\r\n"


def test_fake_midi_out_records_messages() -> None:
    out = FakeMidiOut()
    out.ports = ["Crosspad MIDI 1", "CrossPad MIDI+Serial 2"]
    assert out.get_ports() == ["Crosspad MIDI 1", "CrossPad MIDI+Serial 2"]
    out.open_port(0)
    assert out.is_port_open()
    out.send_message([0xF0, 0x7D, 0x1B, 0x01, 0xF7])
    assert out.sent == [[0xF0, 0x7D, 0x1B, 0x01, 0xF7]]
    out.close_port()
    assert not out.is_port_open()


def test_fake_midi_in_returns_fed_frames_then_none() -> None:
    inp = FakeMidiIn()
    inp.ignore_types(sysex=False)
    inp.feed([[0xF0, 0x7D, 0x1D, 0x09, 0x00, 0xF7]])
    msg = inp.get_message()
    assert msg is not None
    assert msg[0] == [0xF0, 0x7D, 0x1D, 0x09, 0x00, 0xF7]
    assert inp.get_message() is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && python -m pytest -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil'` (collection error) — pytest is not installed yet either; `pip install pytest` first if the command itself is missing, then observe the ModuleNotFoundError.

- [ ] **Step 3: Write the scaffold**

`pyproject.toml`:
```toml
[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "crosspad-hil"
version = "1.0.0"
description = "Talk to a CrossPad: discovery, console, CDC verbs, MIDI SysEx, USB mode, OTA, HIL scenarios, CLI and NDJSON daemon"
readme = "README.md"
license = { file = "LICENSE" }
requires-python = ">=3.10"
authors = [{ name = "CrossPad contributors" }]
classifiers = [
    "Programming Language :: Python :: 3",
    "License :: OSI Approved :: MIT License",
    "Operating System :: OS Independent",
    "Topic :: Software Development :: Embedded Systems",
]
dependencies = [
    "pyserial>=3.5",
    "python-rtmidi>=1.5",
    "pydantic>=2",
    "pyyaml>=6",
]

[project.optional-dependencies]
audio = ["sounddevice>=0.4", "numpy>=1.24", "scipy>=1.10"]
ble = ["bleak>=0.21"]
all = ["crosspad-hil[audio,ble]"]
dev = ["pytest>=8", "ruff>=0.5"]

[project.scripts]
crosspad-hil = "crosspad_hil.cli:main"

[project.urls]
Homepage = "https://github.com/CrossPad/crosspad-hil"

[tool.setuptools.packages.find]
include = ["crosspad_hil*"]

[tool.setuptools.package-data]
crosspad_hil = ["knowledge/*.yaml"]

[tool.ruff]
line-length = 100
target-version = "py310"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B"]

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-q"
```

`crosspad_hil/__init__.py`:
```python
"""crosspad-hil: one source of truth for talking to a CrossPad."""

__version__ = "1.0.0"

__all__ = ["__version__"]
```

`crosspad_hil/errors.py`:
```python
"""HilError — every failure carries a code, a message and a hint (what to call next)."""
from __future__ import annotations

from typing import Any

NO_DEVICE = "NO_DEVICE"
AMBIGUOUS_DEVICE = "AMBIGUOUS_DEVICE"
PORT_BUSY = "PORT_BUSY"
NO_CDC_IN_AUDIO_MODE = "NO_CDC_IN_AUDIO_MODE"
TIMEOUT = "TIMEOUT"
UNKNOWN_VERB = "UNKNOWN_VERB"
DENIED_SYSEX = "DENIED_SYSEX"
BAD_SYSEX = "BAD_SYSEX"
HANDLE_EXPIRED = "HANDLE_EXPIRED"
BAD_ARGS = "BAD_ARGS"
FLASH_FAILED = "FLASH_FAILED"
ENV = "ENV"
CANCELLED = "CANCELLED"
NOT_SUPPORTED = "NOT_SUPPORTED"

ALL_CODES: tuple[str, ...] = (
    NO_DEVICE,
    AMBIGUOUS_DEVICE,
    PORT_BUSY,
    NO_CDC_IN_AUDIO_MODE,
    TIMEOUT,
    UNKNOWN_VERB,
    DENIED_SYSEX,
    BAD_SYSEX,
    HANDLE_EXPIRED,
    BAD_ARGS,
    FLASH_FAILED,
    ENV,
    CANCELLED,
    NOT_SUPPORTED,
)


class HilError(Exception):
    """Structured error. ``to_dict()`` is what the daemon puts on the wire."""

    code: str
    message: str
    hint: str | None
    details: dict[str, Any]

    def __init__(self, code: str, message: str, hint: str | None = None, **details: Any) -> None:
        if code not in ALL_CODES:
            raise ValueError(f"unknown HilError code {code!r}; must be one of {ALL_CODES}")
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.hint = hint
        self.details = dict(details)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "hint": self.hint,
            "details": dict(self.details),
        }

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"
```

`.gitignore`:
```
__pycache__/
*.py[cod]
.venv/
venv/
build/
dist/
*.egg-info/
.pytest_cache/
.ruff_cache/
hil_logs/
recordings/
*.wav
.coverage
```

`LICENSE`:
```
MIT License

Copyright (c) 2026 CrossPad contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`README.md`:
```markdown
# crosspad-hil

Python library, CLI and NDJSON daemon for talking to a CrossPad (ESP32-S3 pad
controller): device discovery, STM32-bridge console with boot/fatal parsers,
CDC verbs, MIDI SysEx, USB profile switching, OTA flashing and the
hardware-in-the-loop scenario suite.

Every hardware trap (DTR/RTS reboots the ESP, `OK` is not your ack, CDC
vanishes in UAC2 mode, `F0 7D 19 01 F7` hangs the STM bridge) is encoded once
here and inherited by the CLI, the scenarios and crosspad-mcp.

```bash
pip install crosspad-hil[all]
crosspad-hil devices
crosspad-hil run smoke --json
```

Design: `crosspad-mcp/docs/superpowers/specs/2026-08-25-crosspad-hil-and-mcp-v10-design.md`.

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
ruff check . && pytest
```

Tests need no hardware: `tests/fakes.py` provides `FakeSerial`, `FakeMidiOut`
and `FakeMidiIn`.
```

`.github/workflows/ci.yml`:
```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        python: ["3.10", "3.12"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
      - name: Install
        run: python -m pip install -U pip && python -m pip install -e ".[dev]"
      - name: Lint
        run: ruff check .
      - name: Test
        run: python -m pytest
```

`tests/__init__.py`: empty file.

`tests/fakes.py`:
```python
"""Hardware stand-ins for the test suite.

FakeSerial mimics the two pyserial ports a CrossPad exposes (ESP CDC 0x303A:0x3456 and the
STM32 bridge VCP 0x0483:0x5740) closely enough for every module above serial_open.py:
scripted command→reply lines, unsolicited console lines via feed(), and a full record of
DTR/RTS assignments so hygiene tests can assert "never asserted DTR".
"""
from __future__ import annotations

import time
from collections import deque
from collections.abc import Iterable, Sequence


class FakeSerial:
    """pyserial-shaped fake. Constructible with no arguments (serial_open sets attributes
    then calls open(), exactly like ``serial.Serial()``)."""

    def __init__(
        self,
        script: Sequence[tuple[str, str | list[str]]] = (),
        *,
        timeout: float = 0.2,
    ) -> None:
        self._script: dict[str, list[str]] = {}
        for cmd, reply in script:
            self._script[cmd] = [reply] if isinstance(reply, str) else list(reply)
        self.port: str | None = None
        self.baudrate: int = 115200
        self.timeout: float | None = timeout
        self.is_open: bool = False
        self.written: list[str] = []
        self.control_history: list[tuple[str, bool]] = []
        self._dtr: bool = False
        self._rts: bool = False
        self._rx: deque[bytes] = deque()
        self._partial: bytes = b""

    # ── control lines ───────────────────────────────────────────────
    @property
    def dtr(self) -> bool:
        return self._dtr

    @dtr.setter
    def dtr(self, value: bool) -> None:
        self._dtr = bool(value)
        self.control_history.append(("dtr", bool(value)))

    @property
    def rts(self) -> bool:
        return self._rts

    @rts.setter
    def rts(self, value: bool) -> None:
        self._rts = bool(value)
        self.control_history.append(("rts", bool(value)))

    # ── lifecycle ───────────────────────────────────────────────────
    def open(self) -> None:
        self.is_open = True

    def close(self) -> None:
        self.is_open = False

    def flush(self) -> None:
        return None

    def reset_input_buffer(self) -> None:
        self._rx.clear()
        self._partial = b""

    # ── host → device ───────────────────────────────────────────────
    def write(self, data: bytes) -> int:
        text = data.decode("utf-8", errors="replace")
        for raw in text.split("\n"):
            cmd = raw.rstrip("\r")
            if not cmd:
                continue
            self.written.append(cmd)
            replies = self._script.get(cmd)
            if replies is None:
                # Device behaviour: hil_control_handle_cdc() returned false → echo.
                self._rx.append((cmd + "\r\n").encode())
            else:
                for line in replies:
                    self._rx.append((line + "\r\n").encode())
        return len(data)

    def feed(self, lines: Iterable[str]) -> None:
        """Push unsolicited lines (console traffic, async replies)."""
        for line in lines:
            self._rx.append((line + "\r\n").encode())

    # ── device → host ───────────────────────────────────────────────
    @property
    def in_waiting(self) -> int:
        return len(self._partial) + sum(len(b) for b in self._rx)

    def _wait_for_data(self) -> bool:
        if self._partial or self._rx:
            return True
        if self.timeout:
            time.sleep(self.timeout)
        return bool(self._partial or self._rx)

    def readline(self) -> bytes:
        if not self._wait_for_data():
            return b""
        if self._partial:
            buf = self._partial
            self._partial = b""
            nl = buf.find(b"\n")
            if nl >= 0:
                self._partial = buf[nl + 1:]
                return buf[: nl + 1]
            return buf + (self._rx.popleft() if self._rx else b"")
        return self._rx.popleft()

    def read(self, size: int = 1) -> bytes:
        if not self._wait_for_data():
            return b""
        buf = self._partial
        self._partial = b""
        while len(buf) < size and self._rx:
            buf += self._rx.popleft()
        out, self._partial = buf[:size], buf[size:]
        return out


class FakeMidiOut:
    """rtmidi.MidiOut stand-in: records every message sent."""

    def __init__(self) -> None:
        self.ports: list[str] = []
        self.sent: list[list[int]] = []
        self._open: int | None = None

    def get_ports(self) -> list[str]:
        return list(self.ports)

    def open_port(self, index: int) -> None:
        self._open = index

    def close_port(self) -> None:
        self._open = None

    def is_port_open(self) -> bool:
        return self._open is not None

    def send_message(self, message: Sequence[int]) -> None:
        self.sent.append([int(b) for b in message])


class FakeMidiIn:
    """rtmidi.MidiIn stand-in: get_message() yields what feed() queued."""

    def __init__(self) -> None:
        self.ports: list[str] = []
        self.sysex_ignored: bool = True
        self._open: int | None = None
        self._queue: deque[list[int]] = deque()

    def get_ports(self) -> list[str]:
        return list(self.ports)

    def open_port(self, index: int) -> None:
        self._open = index

    def close_port(self) -> None:
        self._open = None

    def is_port_open(self) -> bool:
        return self._open is not None

    def ignore_types(
        self, sysex: bool = True, timing: bool = True, active_sense: bool = True
    ) -> None:
        self.sysex_ignored = sysex

    def feed(self, frames: Iterable[Sequence[int]]) -> None:
        for frame in frames:
            self._queue.append([int(b) for b in frame])

    def get_message(self) -> tuple[list[int], float] | None:
        if not self._queue:
            return None
        return self._queue.popleft(), 0.0
```

`tests/conftest.py`:
```python
"""Shared fixtures. Nothing here touches hardware."""
from __future__ import annotations

from collections.abc import Callable, Sequence

import pytest

from tests.fakes import FakeMidiIn, FakeMidiOut, FakeSerial


@pytest.fixture
def fake_serial() -> Callable[..., FakeSerial]:
    def make(
        script: Sequence[tuple[str, str | list[str]]] = (), timeout: float = 0.01
    ) -> FakeSerial:
        return FakeSerial(script, timeout=timeout)

    return make


@pytest.fixture
def fake_midi() -> tuple[FakeMidiOut, FakeMidiIn]:
    return FakeMidiOut(), FakeMidiIn()


@pytest.fixture
def knowledge() -> dict:
    from crosspad_hil.knowledge import load

    return {"markers": load("markers"), "sysex": load("sysex"), "cdc": load("cdc")}


@pytest.fixture
def fake_backends():
    """Backends with one CrossPad in default mode (ESP CDC + STM VCP + ESP MIDI + STM MIDI).
    Needs crosspad_hil.devices (Plan A chunk 2); skips until it exists."""
    try:
        from crosspad_hil.devices import (
            AudioCardInfo,
            Backends,
            MidiPortInfo,
            SerialPortInfo,
        )
    except ImportError:
        pytest.skip("crosspad_hil.devices not implemented yet")

    serial_ports = [
        SerialPortInfo(path="/dev/ttyACM0", vid=0x303A, pid=0x3456, serial="AABBCC",
                       product="Crosspad", location="1-2.3:1.0"),
        SerialPortInfo(path="/dev/ttyACM1", vid=0x0483, pid=0x5740, serial="STM001",
                       product="CrossPad MIDI+Serial", location="1-2.4:1.2"),
    ]
    midi_ports = [
        MidiPortInfo(name="Crosspad MIDI 1", rtmidi_out=0, rtmidi_in=0, alsa_hw="hw:4,0,0",
                     rawmidi="/dev/snd/midiC4D0"),
        MidiPortInfo(name="CrossPad MIDI+Serial 2", rtmidi_out=1, rtmidi_in=1,
                     alsa_hw="hw:5,0,0", rawmidi="/dev/snd/midiC5D0"),
    ]
    audio_cards: list[AudioCardInfo] = []
    return Backends(
        list_serial=lambda: list(serial_ports),
        list_midi=lambda: list(midi_ports),
        list_audio=lambda: list(audio_cards),
    )
```

Install the package in editable mode so `crosspad_hil` imports:

```bash
cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && pip install -e ".[dev]"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && ruff check . && python -m pytest -q`
Expected: `ruff` prints `All checks passed!`; pytest reports **31 passed** (`test_errors.py`: 7 plain tests + 14 parametrised = 21; `test_fakes.py`: 10).

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add pyproject.toml crosspad_hil/__init__.py crosspad_hil/errors.py .github/workflows/ci.yml .gitignore LICENSE README.md tests/__init__.py tests/fakes.py tests/conftest.py tests/test_errors.py tests/test_fakes.py
git commit -m "feat: scaffold crosspad-hil with HilError and hardware fakes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `knowledge/` — markers, SysEx catalog, CDC grammar

**Files:**
- Create: `crosspad_hil/knowledge/__init__.py`
- Create: `crosspad_hil/knowledge/markers.yaml`
- Create: `crosspad_hil/knowledge/sysex.yaml`
- Create: `crosspad_hil/knowledge/cdc.yaml`
- Test: `tests/test_knowledge.py`

**Interfaces:**
- Consumes: `crosspad_hil.errors.HilError`, `ENV` (Task 1).
- Produces:
  - `crosspad_hil.knowledge.load(name: str) -> dict` — reads `crosspad_hil/knowledge/<name>.yaml` through `importlib.resources.files`, parsed with `yaml.safe_load`, cached with `functools.lru_cache`; **returns a `copy.deepcopy` of the cached dict** so no caller can mutate the shared copy (contract says "cached"; the deep copy is this chunk's choice to honour "no global mutable state"). Unknown name → `HilError(ENV, "unknown knowledge file …", available=[…])`.
  - `crosspad_hil.knowledge.KNOWLEDGE_NAMES: tuple[str, ...] = ("markers", "sysex", "cdc")`.
  - `markers.yaml` keys (exact): `boot_markers`, `required`, `required_stability`, `optional`, `error_line`, `error_allow`, `fatal_patterns`, `reset_reason`, `heap_block` (`start`, `line`, `end`), `kit_request`, `cdc_drops`, `reboot`, `boot_timeout_s`.
  - `sysex.yaml` keys (exact): `manufacturer`, `usb_mode` (`id`, `default`, `audio`), `audio_route` (`id`, `subs` with `adc_input, mic_src, dac_output, volume, mute, audio_tasks, pad_press, pad_release, echo, query`), `bootloader` (`id`, `esp`), `host_denylist`.
  - `cdc.yaml`: top-level `verbs: {VERB: {args: list[str], reply: str|null, end: str|null, profile: "default"}}`. `args` entries are `"name:type"` or `"name:type?"` for optional (types `int`, `str`). `reply` is the prefix string (e.g. `"KITSTATUS:"`), `"OK"` for OK/ERR verbs, `"multi"` for multi-line verbs, or `null` for verbs that produce no reply because the device reboots / re-enumerates (`BOOTLOADER_REQUEST`, `USB_AUDIO`, `USB_DEFAULT`). Contract lists `prefix|"OK"|"multi"`; `null` is this chunk's addition for the three no-reply verbs. For `reply: multi`, the prefix to match the first line lives in `prefix` (`ENC_GROUP → "ENCGROUP:"`, `APP_VERSIONS → "APPVER:"`, `MEM_BLOCKS → "MEMBLK:"`). `OTA_BEGIN`/`OTA_DELTA` use `reply: "OTA_"` (matches `OTA_READY`, `OTA_WAIT`, `OTA_ERROR`).

- [ ] **Step 1: Write the failing test**

`tests/test_knowledge.py`:
```python
"""knowledge/*.yaml is firmware-coupled data; these tests pin its shape."""
from __future__ import annotations

import re

import pytest

from crosspad_hil import errors
from crosspad_hil.errors import HilError
from crosspad_hil.knowledge import KNOWLEDGE_NAMES, load

# From platform-idf/tools/hil_smoke.py REQUIRED_MARKERS.
SEVEN = [
    "Platform fully initialized",
    "STM32 ident:",
    "Crosspad initialization complete",
    "All systems operational",
    "LVGL setup done successfully",
    "App registry initialized",
    "LoadMainScreen completed successfully",
]


def test_names() -> None:
    assert KNOWLEDGE_NAMES == ("markers", "sysex", "cdc")


def test_unknown_name_is_env_error() -> None:
    with pytest.raises(HilError) as ei:
        load("nope")
    assert ei.value.code == errors.ENV
    assert ei.value.details["available"] == ["markers", "sysex", "cdc"]


def test_load_is_cached_but_returns_independent_copies() -> None:
    a = load("markers")
    a["required"].append("MUTATED")
    b = load("markers")
    assert "MUTATED" not in b["required"]


# ── markers.yaml ───────────────────────────────────────────────────────

def test_seven_required_markers_in_order() -> None:
    assert load("markers")["required"] == SEVEN


def test_stability_required_is_the_seven_minus_stm32_ident() -> None:
    m = load("markers")
    assert m["required_stability"] == [x for x in SEVEN if x != "STM32 ident:"]
    assert len(m["required_stability"]) == 6


def test_boot_markers_and_reboot() -> None:
    m = load("markers")
    assert m["boot_markers"] == ["ESP-ROM:", "main_task: Started on CPU0"]
    assert m["reboot"] == "ESP-ROM:esp32s3"
    assert m["boot_timeout_s"] == 45


def test_optional_markers() -> None:
    assert load("markers")["optional"] == [
        "SD Card mounted successfully", "ES8388 [1] started", "DRV2605 found",
    ]


def test_fatal_patterns_compile_and_hit_known_lines() -> None:
    pats = [re.compile(p) for p in load("markers")["fatal_patterns"]]
    assert len(pats) >= 7
    samples = [
        "Guru Meditation Error: Core  1 panic'ed (LoadProhibited).",
        "abort() was called at PC 0x4037a8c1 on core 0",
        "assert failed: xQueueGenericSend queue.c:832",
        "CORRUPT HEAP: Bad head at 0x3fc9e4f0.",
        "Stack smashing protect failure!",
        "E (12345) task_wdt: Task watchdog got triggered.",
        "Interrupt wdt timeout on CPU1",
        "rst:0xc (RTC_SW_CPU_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)",
    ]
    for s in samples[:-1]:
        assert any(p.search(s) for p in pats), s
    # A software reset is not fatal; a PANIC/WDT/BROWNOUT reset reason is.
    assert not any(p.search(samples[-1]) for p in pats)
    assert any(p.search("rst:0x7 (TG0WDT_SYS_RST),boot:0x8") for p in pats)
    assert any(p.search("rst:0xf (BROWNOUT_RST),boot:0x8") for p in pats)


def test_error_line_and_allowlist() -> None:
    m = load("markers")
    rx = re.compile(m["error_line"])
    assert rx.match("E (1234) sdmmc: file not found")
    assert not rx.match("W (1234) sdmmc: file not found")
    assert m["error_allow"] == ["file not found"]


def test_reset_reason_two_groups() -> None:
    rx = re.compile(load("markers")["reset_reason"])
    mt = rx.search("rst:0x7 (TG0WDT_SYS_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)")
    assert mt is not None
    assert mt.groups() == ("0x7", "TG0WDT_SYS_RST")


def test_heap_block() -> None:
    hb = load("markers")["heap_block"]
    assert hb["start"] == "Heap Statistics"
    assert hb["end"] == "Total tasks:"
    mt = re.compile(hb["line"]).search("I (91234) PerfMon:   Free: 187432 bytes")
    assert mt is not None and mt.group(1) == "187432"


def test_kit_request_and_cdc_drops() -> None:
    m = load("markers")
    kr = re.compile(m["kit_request"]).search("I (5) hil_control: KIT_LOAD 3 queued")
    assert kr is not None and kr.groups() == ("3", "queued")
    cd = re.compile(m["cdc_drops"]).search("W (9) main: CDC: 12 commands dropped (app_queue full)")
    assert cd is not None and cd.group(1) == "12"


# ── sysex.yaml ─────────────────────────────────────────────────────────

def test_sysex_ids() -> None:
    s = load("sysex")
    assert s["manufacturer"] == 0x7D
    assert s["usb_mode"] == {"id": 0x1B, "default": 0x01, "audio": 0x02}
    assert s["audio_route"]["id"] == 0x1D
    assert s["audio_route"]["subs"] == {
        "adc_input": 0x01, "mic_src": 0x02, "dac_output": 0x03, "volume": 0x04,
        "mute": 0x05, "audio_tasks": 0x06, "pad_press": 0x07, "pad_release": 0x08,
        "echo": 0x09, "query": 0x10,
    }
    assert s["bootloader"] == {"id": 0x19, "esp": 0x00}


def test_host_denylist_contains_stm_bootloader_request() -> None:
    assert [0x19, 0x01] in load("sysex")["host_denylist"]


# ── cdc.yaml ───────────────────────────────────────────────────────────

EXPECTED_VERBS = {
    "APP_LIST", "APP_VERSIONS", "APP_START", "APP_STOP", "APP_DESTROY", "APP_SELF_CLOSE",
    "KIT_LIST", "KIT_STATUS", "KIT_LOAD",
    "PAD_PRESS", "PAD_RELEASE", "PAD_PRESSURE", "PAD_STATS", "PAD_STATS_RESET", "PAD_NOTES",
    "PAD_INFO",
    "ENC_ROTATE", "ENC_PRESS", "ENC_FOCUS", "ENC_GROUP", "ENC_STATE", "UI_STATE",
    "LED_STATE", "MEM", "MEM_BLOCKS", "CDC_STATS",
    "AUDIO_LEVEL", "AUDIO_STATUS", "AUDIO_ADC", "AUDIO_MIC_SRC", "AUDIO_OUT", "AUDIO_VOL",
    "AUDIO_MUTE", "AUDIO_TASKS",
    "SMPL_PEAK", "SMPL_PREVIEW",
    "BLE_STATUS", "BLE_DEVICES", "BLE_START", "BLE_STOP", "BLE_SCAN", "BLE_CONNECT",
    "BLE_DISCONNECT", "BLE_TXOFF", "BLE_SEND",
    "OTA_BEGIN", "OTA_DELTA", "USB_AUDIO", "USB_DEFAULT", "BOOTLOADER_REQUEST", "STM_DFU",
}


def test_every_hil_control_verb_is_present() -> None:
    assert set(load("cdc")["verbs"]) == EXPECTED_VERBS


def test_every_verb_has_args_reply_end_profile() -> None:
    for name, v in load("cdc")["verbs"].items():
        assert set(v) >= {"args", "reply", "end", "profile"}, name
        assert isinstance(v["args"], list), name
        for a in v["args"]:
            assert re.fullmatch(r"[a-z_]+:(int|str)\??", a), (name, a)
        assert v["profile"] == "default", name
        assert v["reply"] is None or isinstance(v["reply"], str), name
        if v["reply"] == "multi":
            assert v["prefix"].endswith(":"), name


def test_multi_verbs() -> None:
    v = load("cdc")["verbs"]
    assert v["ENC_GROUP"] == {"args": [], "reply": "multi", "prefix": "ENCGROUP:", "end": None,
                              "profile": "default"}
    assert v["APP_VERSIONS"]["end"] == "APPVER: end"
    assert v["APP_VERSIONS"]["prefix"] == "APPVER:"
    assert v["MEM_BLOCKS"]["end"] == "MEMBIG:"
    assert v["MEM_BLOCKS"]["prefix"] == "MEMBLK:"


def test_reply_prefixes_from_hil_control_cpp() -> None:
    v = load("cdc")["verbs"]
    assert v["KIT_STATUS"]["reply"] == "KITSTATUS:"
    assert v["APP_LIST"]["reply"] == "APPS:"
    assert v["KIT_LIST"]["reply"] == "KITS:"
    assert v["PAD_STATS"]["reply"] == "PADSTATS:"
    assert v["PAD_NOTES"]["reply"] == "PADNOTES:"
    assert v["PAD_INFO"]["reply"] == "PADINFO:"
    assert v["ENC_FOCUS"]["reply"] == "ENCFOCUS:"
    assert v["ENC_STATE"]["reply"] == "ENC:"
    assert v["UI_STATE"]["reply"] == "UI:"
    assert v["LED_STATE"]["reply"] == "LEDS:"
    assert v["MEM"]["reply"] == "MEM:"
    assert v["CDC_STATS"]["reply"] == "CDCSTATS:"
    assert v["AUDIO_LEVEL"]["reply"] == "AUDIOLVL:"
    assert v["AUDIO_STATUS"]["reply"] == "AUDIO:"
    assert v["SMPL_PEAK"]["reply"] == "SMPLPEAK:"
    assert v["BLE_STATUS"]["reply"] == "BLE:"
    assert v["BLE_DEVICES"]["reply"] == "BLEDEV:"
    assert v["OTA_BEGIN"]["reply"] == "OTA_"
    for ok_verb in ("PAD_PRESS", "KIT_LOAD", "APP_START", "ENC_ROTATE", "BLE_SEND", "STM_DFU",
                    "AUDIO_TASKS", "SMPL_PREVIEW"):
        assert v[ok_verb]["reply"] == "OK", ok_verb
    for silent in ("BOOTLOADER_REQUEST", "USB_AUDIO", "USB_DEFAULT"):
        assert v[silent]["reply"] is None, silent


def test_arg_specs_match_the_sscanf_formats() -> None:
    v = load("cdc")["verbs"]
    assert v["PAD_PRESS"]["args"] == ["idx:int", "vel:int?"]
    assert v["PAD_PRESSURE"]["args"] == ["idx:int", "val:int"]
    assert v["KIT_LOAD"]["args"] == ["kit_id:int"]
    assert v["APP_START"]["args"] == ["name:str"]
    assert v["ENC_PRESS"]["args"] == ["ms:int?"]
    assert v["BLE_SCAN"]["args"] == ["ms:int?"]
    assert v["BLE_START"]["args"] == ["mode:int?"]
    assert v["AUDIO_ADC"]["args"] == ["codec:int", "input:str"]
    assert v["OTA_BEGIN"]["args"] == ["size:int", "version:str"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && python -m pytest tests/test_knowledge.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.knowledge'`.

- [ ] **Step 3: Write the knowledge package**

`crosspad_hil/knowledge/__init__.py`:
```python
"""Firmware-coupled knowledge: boot markers, fatal patterns, SysEx catalog, CDC grammar.

The YAML files version with the firmware, not with the MCP server. ``load()`` is the only
accessor; it hands out deep copies of a cached parse so nobody can mutate shared state.
"""
from __future__ import annotations

import copy
from functools import lru_cache
from importlib import resources
from typing import Any

import yaml

from crosspad_hil.errors import ENV, HilError

KNOWLEDGE_NAMES: tuple[str, ...] = ("markers", "sysex", "cdc")


@lru_cache(maxsize=None)
def _load_cached(name: str) -> dict[str, Any]:
    path = resources.files("crosspad_hil.knowledge").joinpath(f"{name}.yaml")
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    if not isinstance(data, dict):
        raise HilError(ENV, f"knowledge file {name}.yaml did not parse to a mapping",
                       name=name)
    return data


def load(name: str) -> dict[str, Any]:
    """Return a fresh copy of ``crosspad_hil/knowledge/<name>.yaml``."""
    if name not in KNOWLEDGE_NAMES:
        raise HilError(
            ENV,
            f"unknown knowledge file {name!r}",
            hint=f"one of {', '.join(KNOWLEDGE_NAMES)}",
            available=list(KNOWLEDGE_NAMES),
        )
    return copy.deepcopy(_load_cached(name))


__all__ = ["KNOWLEDGE_NAMES", "load"]
```

`crosspad_hil/knowledge/markers.yaml`:
```yaml
# Console knowledge for the ESP32-S3 boot log as seen on the STM32 bridge VCP.
# Ported from platform-idf/tools/hil_smoke.py, hil_stability.py, hil_kit_churn.py.

# Proof that a boot actually started (hil_smoke.BOOT_MARKERS). The ROM banner is
# often missed because the host is still opening the port; "main_task: Started on
# CPU0" arrives a little later and always arrives. More than one occurrence of
# any of them within a capture = the board booted again = boot loop.
boot_markers:
  - "ESP-ROM:"
  - "main_task: Started on CPU0"

# Markers that MUST appear in a healthy boot, substring match (hil_smoke.REQUIRED_MARKERS).
required:
  - "Platform fully initialized"            # CrosspadPlatform up
  - "STM32 ident:"                          # STM co-processor answered on I2C
  - "Crosspad initialization complete"      # main hardware init done
  - "All systems operational"               # app_main happy path
  - "LVGL setup done successfully"          # display task alive
  - "App registry initialized"              # GUI bootstrap
  - "LoadMainScreen completed successfully" # launcher visible

# hil_stability.REQUIRED_MARKERS: the same list minus "STM32 ident:" (an ESP
# reset in a soak does not re-ident the STM).
required_stability:
  - "Platform fully initialized"
  - "Crosspad initialization complete"
  - "All systems operational"
  - "LVGL setup done successfully"
  - "App registry initialized"
  - "LoadMainScreen completed successfully"

# Should appear; missing ones are reported but do not fail (hil_smoke.OPTIONAL_MARKERS).
optional:
  - "SD Card mounted successfully"
  - "ES8388 [1] started"                    # second codec (dual-codec boards)
  - "DRV2605 found"

# An ESP-IDF E-level line (hil_smoke: re.match(r"^E \(\d+\)", line)).
error_line: '^E \(\d+\)'

# E-level lines containing any of these substrings are tolerated (ERROR_ALLOWLIST).
error_allow:
  - "file not found"                        # missing STARTUP.wav is cosmetic

# Any hit fails immediately. Union of hil_smoke.FATAL_PATTERNS,
# hil_stability.FATAL_PATTERNS and hil_kit_churn.FATAL_RE, each a Python regex.
fatal_patterns:
  - 'Guru Meditation'
  - 'abort\(\) was called'
  - 'assert failed'
  - 'CORRUPT HEAP'
  - 'Stack smashing'
  - 'LoadProhibited'
  - 'StoreProhibited'
  - 'InstrFetchProhibited'
  - 'IllegalInstruction'
  - 'Stack canary watchpoint'
  - 'task_wdt'
  - 'Task watchdog'
  - 'Interrupt wdt timeout'
  - 'rst:0x[0-9a-f]+ \(([A-Z_]*(PANIC|WDT|BROWNOUT))'

# hil_stability.RST_REASON_RE — group 1 = code, group 2 = name.
reset_reason: 'rst:(0x[0-9a-fA-F]+)\s*\(([^)]+)\)'

# PerfMon block (hil_stability): starts at "Heap Statistics", one "Free:" line
# per heap slot (group 1 = free bytes), ends at "Total tasks:".
heap_block:
  start: "Heap Statistics"
  line: 'PerfMon:\s+Free:\s+(\d+) bytes'
  end: "Total tasks:"

# hil_kit_churn.KIT_REQ_RE — what the device says it received (group 1 = kit id,
# group 2 = queued|started).
kit_request: 'hil_control: KIT_LOAD (\d+) (queued|started)'

# hil_kit_churn.CDC_DROP_RE — main.cpp idle-tick report of app_queue overflow.
cdc_drops: 'CDC: (\d+) commands dropped'

# The ROM banner substring that marks a reboot (hil_stability.RESET_MARKER + chip).
reboot: "ESP-ROM:esp32s3"

# hil_stability.BOOT_WINDOW_S.
boot_timeout_s: 45
```

`crosspad_hil/knowledge/sysex.yaml`:
```yaml
# CrossPad SysEx catalog. Frame: F0 <manufacturer> <id> [sub] [args...] F7.
# Sources: platform-idf/main/audio_route_control.cpp (AUDIO_ROUTE_SUB_*),
# tools/hil_sampler_record.py (MANU/CMD_*), tools/requestBootloader.py (0x7D 0x19 0x00),
# tools/hil_audio_loopback.py (F0 7D 1B 02 F7 / F0 7D 1B 01 F7).

manufacturer: 0x7D

# USB profile switch. Goes to the ESP MIDI port only; the STM bridge drops it.
# 0x02 = MIDI+UAC2 (no CDC), anything else = default; the library sends 0x01.
usb_mode:
  id: 0x1B
  default: 0x01
  audio: 0x02

# Audio routing / HIL control, both USB profiles. Query (0x10) answers with a
# 14-byte frame on the ESP MIDI port; echo (0x09) carries a 28-bit sequence
# number, 7 bits per byte, MSB first.
audio_route:
  id: 0x1D
  subs:
    adc_input: 0x01     # codec, input (0=DIFF 1=LINE1 2=LINE2)
    mic_src: 0x02       # codec whose ADC the USB host records
    dac_output: 0x03    # codec, output (1=LINE1 2=LINE2 3=ALL)
    volume: 0x04        # codec, 0..100
    mute: 0x05          # codec, 0|1
    audio_tasks: 0x06   # 0 = suspend RT mixer, 1 = resume (UAC2 mode parks it)
    pad_press: 0x07     # pad, velocity
    pad_release: 0x08   # pad
    echo: 0x09          # seq (4 x 7-bit)
    query: 0x10         # no args

# Bootloader request. esp = 0x00 puts the ESP32-S3 into ROM download mode.
bootloader:
  id: 0x19
  esp: 0x00

# (id, sub) pairs a host must never send. 0x19 0x01 is the STM bootloader
# request: from a USB host it hangs uartLoop on the bridge.
host_denylist:
  - [0x19, 0x01]
```

`crosspad_hil/knowledge/cdc.yaml`:
```yaml
# CDC text verbs on the ESP native USB CDC (0x303A:0x3456), default profile only.
# Authoritative source: platform-idf/main/hil_control.cpp (hil_control_handle_cdc),
# main/audio_route_control.cpp (audio_route_control_handle_cdc), main/ota_cdc.cpp,
# main/usb_config_manager.cpp, main/main.cpp (check_usb_bootloader_request).
#
# args:    "name:type" (int|str); a trailing "?" marks an optional argument.
# reply:   the prefix of the reply line ("KITSTATUS:"), "OK" for verbs that answer
#          OK/ERR, "multi" for multi-line replies (first-line prefix in `prefix`),
#          or null when the device produces no reply because it reboots/re-enumerates.
# end:     for multi replies, the line prefix that terminates the reply; null means
#          "read until 200 ms idle".
# profile: USB profile the verb exists in. Everything here is default-profile only.
#
# Traps the client must not rely on: unknown commands are echoed back; "OK" is
# never the ack of *your* command under traffic; the device matches by prefix in
# a fixed order (MEM_BLOCKS before MEM, PAD_STATS_RESET before PAD_STATS,
# "BLE_SCAN %d" before BLE_SCAN, "ENC_PRESS %d" before ENC_PRESS).

verbs:
  # ── apps ──────────────────────────────────────────────────────────
  APP_LIST:        {args: [], reply: "APPS:", end: null, profile: default}
  APP_VERSIONS:    {args: [], reply: multi, prefix: "APPVER:", end: "APPVER: end", profile: default}
  APP_START:       {args: ["name:str"], reply: "OK", end: null, profile: default}   # "%31s"; ERR unknown app
  APP_STOP:        {args: [], reply: "OK", end: null, profile: default}
  APP_DESTROY:     {args: [], reply: "OK", end: null, profile: default}
  APP_SELF_CLOSE:  {args: [], reply: "OK", end: null, profile: default}

  # ── kits ──────────────────────────────────────────────────────────
  KIT_LIST:        {args: [], reply: "KITS:", end: null, profile: default}
  KIT_STATUS:      {args: [], reply: "KITSTATUS:", end: null, profile: default}
  KIT_LOAD:        {args: ["kit_id:int"], reply: "OK", end: null, profile: default}  # ERR bad kit id

  # ── pads ──────────────────────────────────────────────────────────
  PAD_PRESS:       {args: ["idx:int", "vel:int?"], reply: "OK", end: null, profile: default}  # idx 0..15, vel 0..127 (default 127)
  PAD_RELEASE:     {args: ["idx:int"], reply: "OK", end: null, profile: default}
  PAD_PRESSURE:    {args: ["idx:int", "val:int"], reply: "OK", end: null, profile: default}   # val 0..255
  PAD_STATS:       {args: [], reply: "PADSTATS:", end: null, profile: default}
  PAD_STATS_RESET: {args: [], reply: "OK", end: null, profile: default}
  PAD_NOTES:       {args: [], reply: "PADNOTES:", end: null, profile: default}
  PAD_INFO:        {args: ["idx:int"], reply: "PADINFO:", end: null, profile: default}       # ERR no kit

  # ── encoder / UI ──────────────────────────────────────────────────
  ENC_ROTATE:      {args: ["delta:int"], reply: "OK", end: null, profile: default}   # clamped to ±16, 0 rejected
  ENC_PRESS:       {args: ["ms:int?"], reply: "OK", end: null, profile: default}     # default 80, max 5000
  ENC_FOCUS:       {args: [], reply: "ENCFOCUS:", end: null, profile: default}
  ENC_GROUP:       {args: [], reply: multi, prefix: "ENCGROUP:", end: null, profile: default}
  ENC_STATE:       {args: [], reply: "ENC:", end: null, profile: default}
  UI_STATE:        {args: [], reply: "UI:", end: null, profile: default}
  LED_STATE:       {args: [], reply: "LEDS:", end: null, profile: default}

  # ── memory / stats ────────────────────────────────────────────────
  MEM:             {args: [], reply: "MEM:", end: null, profile: default}
  MEM_BLOCKS:      {args: [], reply: multi, prefix: "MEMBLK:", end: "MEMBIG:", profile: default}
  CDC_STATS:       {args: [], reply: "CDCSTATS:", end: null, profile: default}

  # ── audio ─────────────────────────────────────────────────────────
  AUDIO_LEVEL:     {args: [], reply: "AUDIOLVL:", end: null, profile: default}
  AUDIO_STATUS:    {args: [], reply: "AUDIO:", end: null, profile: default}
  AUDIO_ADC:       {args: ["codec:int", "input:str"], reply: "OK", end: null, profile: default}   # DIFF|LINE1|LINE2
  AUDIO_MIC_SRC:   {args: ["codec:int"], reply: "OK", end: null, profile: default}
  AUDIO_OUT:       {args: ["codec:int", "output:str"], reply: "OK", end: null, profile: default}  # LINE1|LINE2|ALL
  AUDIO_VOL:       {args: ["codec:int", "vol:int"], reply: "OK", end: null, profile: default}     # 0..100
  AUDIO_MUTE:      {args: ["codec:int", "mute:int"], reply: "OK", end: null, profile: default}    # 0|1
  AUDIO_TASKS:     {args: ["on:int"], reply: "OK", end: null, profile: default}                   # 0 suspend, 1 resume

  # ── sampler ───────────────────────────────────────────────────────
  SMPL_PEAK:       {args: [], reply: "SMPLPEAK:", end: null, profile: default}
  SMPL_PREVIEW:    {args: ["path:str"], reply: "OK", end: null, profile: default}

  # ── BLE MIDI ──────────────────────────────────────────────────────
  BLE_STATUS:      {args: [], reply: "BLE:", end: null, profile: default}
  BLE_DEVICES:     {args: [], reply: "BLEDEV:", end: null, profile: default}
  BLE_START:       {args: ["mode:int?"], reply: "OK", end: null, profile: default}   # 0 host, 1 server; default = setting
  BLE_STOP:        {args: [], reply: "OK", end: null, profile: default}
  BLE_SCAN:        {args: ["ms:int?"], reply: "OK", end: null, profile: default}     # default 5000
  BLE_CONNECT:     {args: ["addr:str"], reply: "OK", end: null, profile: default}    # "%23s"
  BLE_DISCONNECT:  {args: [], reply: "OK", end: null, profile: default}
  BLE_TXOFF:       {args: ["semis:int"], reply: "OK", end: null, profile: default}   # -127..127
  BLE_SEND:        {args: ["note:int", "vel:int?"], reply: "OK", end: null, profile: default}  # note 0..127, vel default 100

  # ── OTA / USB profile / bootloaders ───────────────────────────────
  OTA_BEGIN:       {args: ["size:int", "version:str"], reply: "OTA_", end: null, profile: default}       # OTA_READY|OTA_WAIT|OTA_ERROR …
  OTA_DELTA:       {args: ["size:int", "version:str"], reply: "OTA_", end: null, profile: default}
  USB_AUDIO:       {args: [], reply: null, end: null, profile: default}   # re-enumerates as MIDI+UAC2; CDC disappears
  USB_DEFAULT:     {args: [], reply: null, end: null, profile: default}   # re-enumerates as MIDI+CDC
  BOOTLOADER_REQUEST: {args: [], reply: null, end: null, profile: default}   # ESP enters ROM download mode
  STM_DFU:         {args: [], reply: "OK", end: null, profile: default}      # OK, then the STM bridge disappears into DFU
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && ruff check . && python -m pytest -q`
Expected: `All checks passed!` and pytest **50 passed** (31 from Task 1 + 19 in `test_knowledge.py`).

Also confirm the YAML ships in a wheel (package-data):
Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && pip install build >/dev/null && python -m build --wheel -o /tmp/claude-1000/-home-matixan-GIT-platform-idf/acb4349c-c147-48fc-9860-48d7571f0846/scratchpad/whl >/dev/null && python -c "import zipfile,glob; z=zipfile.ZipFile(glob.glob('/tmp/claude-1000/-home-matixan-GIT-platform-idf/acb4349c-c147-48fc-9860-48d7571f0846/scratchpad/whl/*.whl')[0]); print([n for n in z.namelist() if n.endswith('.yaml')])"`
Expected: `['crosspad_hil/knowledge/cdc.yaml', 'crosspad_hil/knowledge/markers.yaml', 'crosspad_hil/knowledge/sysex.yaml']` (any order).

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/knowledge/__init__.py crosspad_hil/knowledge/markers.yaml crosspad_hil/knowledge/sysex.yaml crosspad_hil/knowledge/cdc.yaml tests/test_knowledge.py
git commit -m "feat(knowledge): boot markers, fatal patterns, SysEx catalog and CDC grammar from hil_control.cpp

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
### Task 3: Serial hygiene (`serial_open.py`) and cross-process port locks (`locks.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/serial_open.py`
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/locks.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_serial_open.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_locks.py`

**Interfaces:**
- Consumes: `crosspad_hil.errors.HilError(code, message, hint=None, **details)` and the constant `crosspad_hil.errors.PORT_BUSY` (Task 1); `tests.fakes.FakeSerial` with `dtr`/`rts` property setters that append `(attr, value)` tuples to `control_history` (Task 2).
- Produces (contract, verbatim):
  - `open_serial(path: str, *, baud: int = 115200, timeout: float = 0.2, reset: bool = False, serial_cls: type = serial.Serial) -> serial.Serial`
  - `reset_pulse(ser) -> None`
  - `class PortLock(port: str, purpose: str, lock_dir: Path | None = None)` with `acquire()`, `release()`, `__enter__`/`__exit__`, `@staticmethod holders(lock_dir: Path | None = None) -> list[dict]`.
  - Additional module-level helpers (contract is silent, chosen here): `locks.pid_alive(pid: int) -> bool` (monkeypatch target for tests), `locks.default_lock_dir() -> Path`, `locks.lock_file_name(port: str) -> str`.
- Decisions where the contract is silent: `open_serial` constructs the serial object with **no constructor arguments** and assigns `port`, `baudrate`, `timeout`, `dtr`, `rts` before calling `open()` — that is the only sequence pyserial honours for "deasserted before open" (ported from `hil_kit_churn.py` `Cdc.__init__` and `hil_stability.py` `open_port`). `reset_pulse` sleeps 0.1 s (from `hil_smoke.py` `reset_pulse`). A lock whose JSON cannot be parsed is treated as stale and reclaimed. A lock held by **this** process (same pid, any purpose) is still `PORT_BUSY` — two sessions on one port inside one process is exactly the bug the lock is for.

- [ ] **Step 1: Write the failing tests for `serial_open`**

Create `/home/matixan/GIT/crosspad-hil/tests/test_serial_open.py`:

```python
"""serial_open: DTR/RTS deasserted before open; reset_pulse always releases RTS."""
from __future__ import annotations

import pytest

from crosspad_hil import serial_open
from tests.fakes import FakeSerial


class OpenableFake(FakeSerial):
    """FakeSerial plus the attribute-then-open() protocol pyserial uses."""

    def __init__(self) -> None:
        super().__init__([])
        self.port: str | None = None
        self.baudrate: int | None = None
        self.opened_with: dict | None = None

    def open(self) -> None:
        self.opened_with = {"dtr": self.dtr, "rts": self.rts, "port": self.port}
        self.control_history.append(("open", True))
        self.is_open = True


def test_open_serial_deasserts_dtr_rts_before_open() -> None:
    ser = serial_open.open_serial("/dev/ttyFAKE0", serial_cls=OpenableFake)
    assert ser.opened_with == {"dtr": False, "rts": False, "port": "/dev/ttyFAKE0"}
    # both control lines were written BEFORE open(), nothing after
    hist = ser.control_history
    open_idx = hist.index(("open", True))
    assert ("dtr", False) in hist[:open_idx]
    assert ("rts", False) in hist[:open_idx]
    assert hist[open_idx + 1:] == []


def test_open_serial_applies_baud_and_timeout() -> None:
    ser = serial_open.open_serial("COM7", baud=921600, timeout=1.5, serial_cls=OpenableFake)
    assert ser.baudrate == 921600
    assert ser.timeout == 1.5
    assert ser.is_open


def test_open_serial_reset_pulses_after_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serial_open.time, "sleep", lambda s: None)
    ser = serial_open.open_serial("/dev/ttyFAKE0", reset=True, serial_cls=OpenableFake)
    hist = ser.control_history
    open_idx = hist.index(("open", True))
    # hil_smoke.py reset_pulse: DTR low, RTS high, 100 ms, RTS low
    assert hist[open_idx + 1:] == [("dtr", False), ("rts", True), ("rts", False)]


def test_reset_pulse_sequence_and_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr(serial_open.time, "sleep", slept.append)
    ser = FakeSerial([])
    ser.control_history.clear()
    serial_open.reset_pulse(ser)
    assert ser.control_history == [("dtr", False), ("rts", True), ("rts", False)]
    assert slept == [0.1]
    assert ser.rts is False


def test_reset_pulse_releases_rts_on_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_s: float) -> None:
        raise RuntimeError("interrupted mid-pulse")

    monkeypatch.setattr(serial_open.time, "sleep", boom)
    ser = FakeSerial([])
    ser.control_history.clear()
    with pytest.raises(RuntimeError):
        serial_open.reset_pulse(ser)
    assert ser.control_history[-1] == ("rts", False)
    assert ser.rts is False
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_serial_open.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.serial_open'` (or `ImportError: cannot import name 'serial_open'`).

- [ ] **Step 3: Write `serial_open.py`**

Create `/home/matixan/GIT/crosspad-hil/crosspad_hil/serial_open.py`:

```python
"""Opening serial ports without resetting or wedging the board.

Two traps, both measured on hardware:

* pyserial asserts DTR and RTS on ``open()``. The STM32 bridge emulates
  esptool's auto-reset, so an STM VCP opened the default way REBOOTS THE ESP
  (hil_stability.py, hil_kit_churn.py). The ESP's own native-USB CDC on
  Windows wedges when the host asserts DTR/RTS on open (hil_kit_churn.py Cdc).
  Both lines are therefore driven low BEFORE the port is opened, which is only
  possible with the attribute-then-open() form of the pyserial API.
* A reset is an explicit, deliberate pulse (hil_smoke.py reset_pulse), and the
  pulse always releases RTS again even if interrupted — a board held in reset
  by an exception is a board nobody can talk to.
"""
from __future__ import annotations

import time
from typing import Any

import serial


def reset_pulse(ser: Any) -> None:
    """esptool-style auto-reset: EN low via RTS, IO0 high via DTR.

    Ported verbatim from hil_smoke.py ``reset_pulse``; the ``finally`` is the
    hygiene invariant (spec §2.4): RTS is released no matter what.
    """
    ser.dtr = False
    ser.rts = True
    try:
        time.sleep(0.1)
    finally:
        ser.rts = False


def open_serial(
    path: str,
    *,
    baud: int = 115200,
    timeout: float = 0.2,
    reset: bool = False,
    serial_cls: type = serial.Serial,
) -> serial.Serial:
    """Open ``path`` with DTR/RTS deasserted before the port is opened.

    ``serial_cls`` is injectable so tests run on ``tests.fakes.FakeSerial``.
    With ``reset=True`` the board is reset with ``reset_pulse`` once the port
    is open (the caller wants the boot banner from the very first line).
    """
    # from hil_kit_churn.py Cdc.__init__ / hil_stability.py open_port
    ser = serial_cls()
    ser.port = path
    ser.baudrate = baud
    ser.timeout = timeout
    ser.dtr = False
    ser.rts = False
    ser.open()
    if reset:
        reset_pulse(ser)
    return ser
```

- [ ] **Step 4: Run the serial tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_serial_open.py -q`
Expected: `5 passed`.

- [ ] **Step 5: Write the failing tests for `locks`**

Create `/home/matixan/GIT/crosspad-hil/tests/test_locks.py`:

```python
"""PortLock: O_EXCL lock files with holder pid/purpose; stale locks reclaimed."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from crosspad_hil import locks
from crosspad_hil.errors import PORT_BUSY, HilError
from crosspad_hil.locks import PortLock


def _lock_path(lock_dir: Path, port: str) -> Path:
    return lock_dir / locks.lock_file_name(port)


def test_lock_file_name_is_sha1_prefix() -> None:
    name = locks.lock_file_name("/dev/ttyACM0")
    assert name.endswith(".lock")
    assert len(name) == 12 + len(".lock")
    assert name == locks.lock_file_name("/dev/ttyACM0")
    assert name != locks.lock_file_name("/dev/ttyACM1")


def test_acquire_writes_json_and_release_removes(tmp_path: Path) -> None:
    lock = PortLock("/dev/ttyACM0", "console", lock_dir=tmp_path)
    lock.acquire()
    p = _lock_path(tmp_path, "/dev/ttyACM0")
    data = json.loads(p.read_text())
    assert data["pid"] == os.getpid()
    assert data["purpose"] == "console"
    assert data["port"] == "/dev/ttyACM0"
    assert isinstance(data["ts"], float)
    lock.release()
    assert not p.exists()


def test_context_manager_releases_on_exception(tmp_path: Path) -> None:
    p = _lock_path(tmp_path, "COM3")
    with pytest.raises(ValueError):
        with PortLock("COM3", "cdc", lock_dir=tmp_path):
            assert p.exists()
            raise ValueError("inside")
    assert not p.exists()


def test_busy_lock_raises_port_busy_with_pid_and_purpose(tmp_path: Path) -> None:
    first = PortLock("/dev/ttyACM1", "console", lock_dir=tmp_path)
    first.acquire()
    try:
        second = PortLock("/dev/ttyACM1", "cdc", lock_dir=tmp_path)
        with pytest.raises(HilError) as ei:
            second.acquire()
        err = ei.value
        assert err.code == PORT_BUSY
        assert err.details["pid"] == os.getpid()
        assert err.details["purpose"] == "console"
        assert err.details["port"] == "/dev/ttyACM1"
        assert err.hint is not None and str(os.getpid()) in err.hint
        # the loser did not touch the winner's file
        assert json.loads(_lock_path(tmp_path, "/dev/ttyACM1").read_text())["purpose"] == "console"
    finally:
        first.release()


def test_stale_lock_is_reclaimed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = _lock_path(tmp_path, "/dev/ttyACM2")
    p.write_text(json.dumps({"pid": 999_999_999, "purpose": "console",
                             "port": "/dev/ttyACM2", "ts": 1.0}))
    monkeypatch.setattr(locks, "pid_alive", lambda pid: pid == os.getpid())
    lock = PortLock("/dev/ttyACM2", "cdc", lock_dir=tmp_path)
    lock.acquire()
    try:
        data = json.loads(p.read_text())
        assert data["pid"] == os.getpid()
        assert data["purpose"] == "cdc"
    finally:
        lock.release()


def test_corrupt_lock_is_reclaimed(tmp_path: Path) -> None:
    p = _lock_path(tmp_path, "/dev/ttyACM3")
    p.write_text("not json at all")
    with PortLock("/dev/ttyACM3", "console", lock_dir=tmp_path):
        assert json.loads(p.read_text())["pid"] == os.getpid()


def test_release_is_idempotent_and_does_not_steal(tmp_path: Path) -> None:
    lock = PortLock("/dev/ttyACM4", "console", lock_dir=tmp_path)
    lock.release()  # never acquired: no error
    p = _lock_path(tmp_path, "/dev/ttyACM4")
    p.write_text(json.dumps({"pid": os.getpid() + 1, "purpose": "x",
                             "port": "/dev/ttyACM4", "ts": 1.0}))
    lock.release()  # not ours: left alone
    assert p.exists()


def test_holders_lists_alive_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(locks, "pid_alive", lambda pid: pid == os.getpid())
    _lock_path(tmp_path, "/dev/dead").write_text(json.dumps(
        {"pid": 424242, "purpose": "console", "port": "/dev/dead", "ts": 2.0}))
    with PortLock("/dev/live", "cdc", lock_dir=tmp_path):
        rows = sorted(PortLock.holders(tmp_path), key=lambda r: r["port"])
    assert rows == [
        {"port": "/dev/dead", "pid": 424242, "purpose": "console", "alive": False},
        {"port": "/dev/live", "pid": os.getpid(), "purpose": "cdc", "alive": True},
    ]


def test_holders_empty_when_dir_missing(tmp_path: Path) -> None:
    assert PortLock.holders(tmp_path / "nope") == []


def test_pid_alive_self_and_impossible() -> None:
    assert locks.pid_alive(os.getpid()) is True
    assert locks.pid_alive(2_000_000_000) is False


def test_default_lock_dir_prefers_xdg(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    assert locks.default_lock_dir() == tmp_path / "crosspad-hil"
    monkeypatch.delenv("XDG_RUNTIME_DIR")
    d = locks.default_lock_dir()
    assert d.name.startswith("crosspad-hil-")
```

- [ ] **Step 6: Run the lock tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_locks.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.locks'`.

- [ ] **Step 7: Write `locks.py`**

Create `/home/matixan/GIT/crosspad-hil/crosspad_hil/locks.py`:

```python
"""Cross-process port locks (spec §2.4, §4.3).

One lock file per port under ``$XDG_RUNTIME_DIR/crosspad-hil`` (or a per-user
temp dir), created with ``O_CREAT|O_EXCL`` so two processes cannot both win.
The file holds ``{"pid", "purpose", "port", "ts"}`` so ``doctor`` and the
``PORT_BUSY`` error can say *who* has the port and *why*. A lock whose pid is
no longer alive is stale and reclaimed with a log line; no psutil needed.
"""
from __future__ import annotations

import getpass
import hashlib
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from crosspad_hil.errors import PORT_BUSY, HilError

_log = logging.getLogger("crosspad_hil.locks")

_RECLAIM_ATTEMPTS = 3


def default_lock_dir() -> Path:
    """``$XDG_RUNTIME_DIR/crosspad-hil`` when set, else ``<tmp>/crosspad-hil-<uid>``."""
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        return Path(xdg) / "crosspad-hil"
    uid: str
    if hasattr(os, "getuid"):
        uid = str(os.getuid())
    else:
        try:
            uid = getpass.getuser()
        except Exception:  # noqa: BLE001 - no user database, nothing better to key on
            uid = "user"
    return Path(tempfile.gettempdir()) / f"crosspad-hil-{uid}"


def lock_file_name(port: str) -> str:
    """``sha1(port)[:12] + ".lock"`` — a port path is not a safe file name."""
    return hashlib.sha1(port.encode("utf-8")).hexdigest()[:12] + ".lock"


def pid_alive(pid: int) -> bool:
    """True when ``pid`` names a running process. POSIX: ``kill(pid, 0)``;
    Windows: ``OpenProcess`` with query-limited rights."""
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if sys.platform == "win32":
        import ctypes

        process_query_limited_information = 0x1000
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    except OverflowError:
        return False
    return True


def _read_holder(path: Path) -> dict[str, Any] | None:
    """Parse a lock file; None when missing or corrupt."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("pid"), int):
        return None
    return data


class PortLock:
    """Exclusive, cross-process claim on one serial port path."""

    def __init__(self, port: str, purpose: str, lock_dir: Path | None = None) -> None:
        self.port = port
        self.purpose = purpose
        self.lock_dir = Path(lock_dir) if lock_dir is not None else default_lock_dir()
        self.path = self.lock_dir / lock_file_name(port)
        self._held = False

    # -- acquire / release -------------------------------------------------

    def acquire(self) -> None:
        """Create the lock file exclusively; reclaim a stale one; else PORT_BUSY."""
        if self._held:
            return
        self.lock_dir.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"pid": os.getpid(), "purpose": self.purpose, "port": self.port, "ts": time.time()}
        )
        for _attempt in range(_RECLAIM_ATTEMPTS):
            try:
                fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            except FileExistsError:
                holder = _read_holder(self.path)
                if holder is not None and pid_alive(int(holder["pid"])):
                    raise HilError(
                        PORT_BUSY,
                        f"{self.port} is held by pid {holder['pid']} "
                        f"({holder.get('purpose', '?')})",
                        hint=(
                            f"close that session, or if pid {holder['pid']} is not a "
                            f"crosspad-hil process delete {self.path}"
                        ),
                        pid=int(holder["pid"]),
                        purpose=str(holder.get("purpose", "")),
                        port=self.port,
                        lock_file=str(self.path),
                    ) from None
                # stale (dead pid) or corrupt: reclaim
                _log.warning(
                    "reclaiming stale lock %s (pid=%s purpose=%s)",
                    self.path,
                    None if holder is None else holder.get("pid"),
                    None if holder is None else holder.get("purpose"),
                )
                try:
                    self.path.unlink()
                except FileNotFoundError:
                    pass
                continue
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
            self._held = True
            return
        raise HilError(
            PORT_BUSY,
            f"{self.port}: lock file {self.path} keeps reappearing",
            hint="another process is racing for this port; retry",
            port=self.port,
            lock_file=str(self.path),
            pid=0,
            purpose="",
        )

    def release(self) -> None:
        """Remove the lock file if this process wrote it. Idempotent."""
        holder = _read_holder(self.path)
        if holder is None:
            self._held = False
            return
        if holder["pid"] != os.getpid():
            self._held = False
            return
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        self._held = False

    def __enter__(self) -> PortLock:
        self.acquire()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.release()

    # -- inspection --------------------------------------------------------

    @staticmethod
    def holders(lock_dir: Path | None = None) -> list[dict]:
        """Every lock file in ``lock_dir`` as ``{port, pid, purpose, alive}``."""
        directory = Path(lock_dir) if lock_dir is not None else default_lock_dir()
        if not directory.is_dir():
            return []
        rows: list[dict] = []
        for path in sorted(directory.glob("*.lock")):
            holder = _read_holder(path)
            if holder is None:
                continue
            pid = int(holder["pid"])
            rows.append(
                {
                    "port": str(holder.get("port", "")),
                    "pid": pid,
                    "purpose": str(holder.get("purpose", "")),
                    "alive": pid_alive(pid),
                }
            )
        return rows
```

- [ ] **Step 8: Run all Task 3 tests and ruff**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_serial_open.py tests/test_locks.py -q && ruff check crosspad_hil/serial_open.py crosspad_hil/locks.py tests/test_serial_open.py tests/test_locks.py`
Expected: `16 passed` and `All checks passed!`.

- [ ] **Step 9: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/serial_open.py crosspad_hil/locks.py tests/test_serial_open.py tests/test_locks.py
git commit -m "feat(hil): open serial ports with DTR/RTS deasserted and lock them per process"
```

---

### Task 4: Device discovery and selection (`devices.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/devices.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_devices.py`

**Interfaces:**
- Consumes: `crosspad_hil.errors.HilError`, constants `NO_DEVICE`, `AMBIGUOUS_DEVICE` (Task 1).
- Produces (contract, verbatim): `UsbMode`, `SerialPortInfo`, `MidiPortInfo`, `AudioCardInfo`, `Ports`, `Device` (+ `to_dict()`), `Backends`, `default_backends() -> Backends`, `discover(backends: Backends | None = None) -> list[Device]`, `select(devices: list[Device], device: str | None = None) -> Device`, `device_id_for(serial: str | None, fallback: str) -> str`; constants `ESP_VID=0x303A`, `ESP_CDC_PIDS={0x3456, 0x4001}`, `ESP_BOOT_PIDS={0x1001, 0x0009}`, `STM_VID=0x0483`, `STM_PID=0x5740`.
- Extra names (contract silent; other tasks may reuse them): predicates `is_esp_cdc(p: SerialPortInfo) -> bool`, `is_esp_bootloader(p) -> bool`, `is_stm_console(p) -> bool`, `is_esp_midi_name(name: str) -> bool`, `is_stm_midi_name(name: str) -> bool`, `is_uac2_name(name: str) -> bool`; pure Linux parsers `parse_amidi_list(text) -> list[tuple[str, str]]` (`[(hw:X,Y,Z, name)]`), `parse_asound_cards(text) -> list[tuple[int, str, str]]` (`[(card, id, longname)]`), `parse_arecord_list(text) -> list[tuple[int, str, str]]` (`[(card, alsa_id, human_name)]`), `rawmidi_node(hw: str) -> str` (`hw:3,0,0` → `/dev/snd/midiC3D0`); `location_key(location: str | None) -> str` and `common_prefix_len(a, b) -> int` for the pairing rule; `Ports.paths() -> dict[str, str]` (role → serial path, for `select()` and for the daemon's per-device lock).
- Decisions where the contract is silent:
  - An STM VCP counts as a CrossPad console when its `product` contains "crosspad" (case-insensitive, `hil_smoke.py` `candidate_ports`) **or** `product` is `None` (Windows often reports none). A `0x0483:0x5740` port whose product names something else is ignored.
  - `rtmidi_in`/`rtmidi_out` are matched independently: the OUT index is the index in `MidiOut().get_ports()` and the IN index the one in `MidiIn().get_ports()` (from `hil_sampler_record.py` `Midi.open`).
  - Pairing by location: the key is `location` with the interface suffix stripped at the first `:` (pyserial gives `1-3.2:1.0`); pairs are chosen greedily by longest common character prefix; a prefix of length 0 never pairs. Ports with `location=None` only pair in the single-pair case.
  - MIDI ports and UAC2 cards cannot be tied to a USB serial number by any backend, so they are attached **in enumeration order** to the devices that have an ESP side (i-th ESP MIDI port → i-th ESP device); when no device has an ESP side (audio mode — CDC gone) they attach to the single STM-only device; with several STM-only devices and no ESP side they stay unattached (mode `UNKNOWN`) — the error hint says so. If there is no serial port at all but an ESP MIDI port or UAC2 card exists, a Device is synthesized from it (id from the MIDI/card name) so `usbmode.set` can still reach the board.
  - `select()` with a path: the path must equal a value of `dev.ports.paths()`; a path that belongs to no device raises `NO_DEVICE` whose hint lists every known path with its role.
  - `Device.to_dict()` returns `{"id", "serial", "usb_mode": <str value>, "board_rev", "ports": {role: dataclass-dict | None}}`.

- [ ] **Step 1: Write the failing tests**

Create `/home/matixan/GIT/crosspad-hil/tests/test_devices.py`:

```python
"""devices: discovery from injected Backends, grouping, usb_mode inference, select()."""
from __future__ import annotations

import pytest

from crosspad_hil import devices
from crosspad_hil.devices import (
    AudioCardInfo,
    Backends,
    Device,
    MidiPortInfo,
    Ports,
    SerialPortInfo,
    UsbMode,
    device_id_for,
    discover,
    select,
)
from crosspad_hil.errors import AMBIGUOUS_DEVICE, NO_DEVICE, HilError

# ---------------------------------------------------------------- factories


def esp_cdc(path: str = "/dev/ttyACM0", serial: str | None = "A1B2C3",
            location: str | None = "1-3.1:1.0", pid: int = 0x3456) -> SerialPortInfo:
    return SerialPortInfo(path=path, vid=0x303A, pid=pid, serial=serial,
                          product="Crosspad", location=location)


def esp_boot(path: str = "/dev/ttyACM0", serial: str | None = "A1B2C3",
             location: str | None = "1-3.1:1.0") -> SerialPortInfo:
    return SerialPortInfo(path=path, vid=0x303A, pid=0x1001, serial=serial,
                          product="USB JTAG/serial debug unit", location=location)


def stm_vcp(path: str = "/dev/ttyACM1", serial: str | None = "STM001",
            location: str | None = "1-3.2:1.0",
            product: str | None = "CrossPad MIDI+Serial") -> SerialPortInfo:
    return SerialPortInfo(path=path, vid=0x0483, pid=0x5740, serial=serial,
                          product=product, location=location)


def esp_midi(name: str = "Crosspad MIDI 1", out: int | None = 1,
             inp: int | None = 1) -> MidiPortInfo:
    return MidiPortInfo(name=name, rtmidi_out=out, rtmidi_in=inp,
                        alsa_hw="hw:2,0,0", rawmidi="/dev/snd/midiC2D0")


def stm_midi(name: str = "CrossPad MIDI+Serial MIDI 1", out: int | None = 2,
             inp: int | None = 2) -> MidiPortInfo:
    return MidiPortInfo(name=name, rtmidi_out=out, rtmidi_in=inp,
                        alsa_hw="hw:3,0,0", rawmidi="/dev/snd/midiC3D0")


def uac2(name: str = "Crosspad Audio: USB Audio (hw:2,0)", index: int = 4) -> AudioCardInfo:
    return AudioCardInfo(name=name, sounddevice_index=index, alsa_id="Audio")


def backends(serial=(), midi=(), audio=()) -> Backends:
    return Backends(list_serial=lambda: list(serial),
                    list_midi=lambda: list(midi),
                    list_audio=lambda: list(audio))


# ---------------------------------------------------------------- ids


def test_device_id_for_is_stable_sha1_prefix() -> None:
    assert device_id_for("A1B2C3", "/dev/x") == device_id_for("A1B2C3", "/dev/y")
    assert device_id_for("A1B2C3", "/dev/x").startswith("dev_")
    assert len(device_id_for("A1B2C3", "/dev/x")) == 8
    assert device_id_for(None, "/dev/x") == device_id_for(None, "/dev/x")
    assert device_id_for(None, "/dev/x") != device_id_for(None, "/dev/y")


# ---------------------------------------------------------------- predicates


def test_name_predicates() -> None:
    assert devices.is_esp_midi_name("Crosspad MIDI 1")
    assert devices.is_esp_midi_name("CROSSPAD MIDI 1:Crosspad MIDI 1 MIDI 1 24:0")
    assert not devices.is_esp_midi_name("CrossPad MIDI+Serial MIDI 1")
    assert devices.is_stm_midi_name("CrossPad MIDI+Serial MIDI 1")
    assert not devices.is_stm_midi_name("Crosspad MIDI 1")
    assert devices.is_uac2_name("Crosspad Audio: USB Audio (hw:2,0)")
    assert not devices.is_uac2_name("HDA Intel PCH: ALC (hw:0,0)")


def test_serial_predicates_and_stm_product_rule() -> None:
    assert devices.is_esp_cdc(esp_cdc())
    assert devices.is_esp_cdc(esp_cdc(pid=0x4001))
    assert not devices.is_esp_cdc(esp_boot())
    assert devices.is_esp_bootloader(esp_boot())
    assert devices.is_esp_bootloader(SerialPortInfo("/dev/x", 0x303A, 0x0009, None, None, None))
    assert devices.is_stm_console(stm_vcp())
    assert devices.is_stm_console(stm_vcp(product=None))
    assert not devices.is_stm_console(stm_vcp(product="STM32 Virtual ComPort"))
    assert not devices.is_stm_console(SerialPortInfo("/dev/x", 0x1A86, 0x7523, None, None, None))


# ---------------------------------------------------------------- discover


def test_one_board_default_mode() -> None:
    devs = discover(backends(serial=[esp_cdc(), stm_vcp()],
                             midi=[esp_midi(), stm_midi()], audio=[]))
    assert len(devs) == 1
    d = devs[0]
    assert d.id == device_id_for("A1B2C3", "/dev/ttyACM0")
    assert d.serial == "A1B2C3"
    assert d.usb_mode is UsbMode.DEFAULT
    assert d.ports.cdc is not None and d.ports.cdc.path == "/dev/ttyACM0"
    assert d.ports.console is not None and d.ports.console.path == "/dev/ttyACM1"
    assert d.ports.esp_midi is not None and d.ports.esp_midi.rtmidi_out == 1
    assert d.ports.stm_midi is not None and d.ports.stm_midi.name.endswith("MIDI 1")
    assert d.ports.uac2 is None
    assert d.ports.bootloader is None
    assert d.board_rev is None


def test_one_board_audio_mode_has_no_cdc_but_uac2() -> None:
    devs = discover(backends(serial=[stm_vcp()], midi=[esp_midi(), stm_midi()],
                             audio=[uac2()]))
    assert len(devs) == 1
    d = devs[0]
    assert d.usb_mode is UsbMode.AUDIO
    assert d.ports.cdc is None
    assert d.ports.console is not None
    assert d.ports.uac2 is not None and d.ports.uac2.sounddevice_index == 4
    assert d.ports.esp_midi is not None
    assert d.id == device_id_for("STM001", "/dev/ttyACM1")


def test_one_board_bootloader() -> None:
    devs = discover(backends(serial=[esp_boot(), stm_vcp()]))
    assert len(devs) == 1
    d = devs[0]
    assert d.usb_mode is UsbMode.BOOTLOADER
    assert d.ports.bootloader is not None and d.ports.bootloader.path == "/dev/ttyACM0"
    assert d.ports.cdc is None
    assert d.ports.console is not None


def test_two_boards_paired_by_location_prefix() -> None:
    ports = [
        esp_cdc("/dev/ttyACM0", "AAAA", "1-3.1:1.0"),
        stm_vcp("/dev/ttyACM3", "STMB", "1-4.2:1.0"),
        esp_cdc("/dev/ttyACM2", "BBBB", "1-4.1:1.0"),
        stm_vcp("/dev/ttyACM1", "STMA", "1-3.2:1.0"),
    ]
    devs = discover(backends(serial=ports, midi=[esp_midi("Crosspad MIDI 1", 1, 1),
                                                  esp_midi("Crosspad MIDI 2", 2, 2)]))
    assert len(devs) == 2
    by_serial = {d.serial: d for d in devs}
    assert by_serial["AAAA"].ports.console.path == "/dev/ttyACM1"
    assert by_serial["BBBB"].ports.console.path == "/dev/ttyACM3"
    assert by_serial["AAAA"].ports.esp_midi.name == "Crosspad MIDI 1"
    assert by_serial["BBBB"].ports.esp_midi.name == "Crosspad MIDI 2"
    assert all(d.usb_mode is UsbMode.DEFAULT for d in devs)


def test_unpaired_stm_console_is_its_own_unknown_device() -> None:
    ports = [esp_cdc("/dev/ttyACM0", "AAAA", "1-3.1:1.0"),
             stm_vcp("/dev/ttyACM1", "STMA", "1-3.2:1.0"),
             stm_vcp("/dev/ttyACM5", "STMZ", "2-1.2:1.0")]
    devs = discover(backends(serial=ports))
    assert len(devs) == 2
    lonely = [d for d in devs if d.serial == "STMZ"][0]
    assert lonely.usb_mode is UsbMode.UNKNOWN
    assert lonely.ports.console.path == "/dev/ttyACM5"
    assert lonely.ports.cdc is None and lonely.ports.esp_midi is None
    paired = [d for d in devs if d.serial == "AAAA"][0]
    assert paired.ports.console.path == "/dev/ttyACM1"


def test_no_locations_two_of_each_stay_unpaired() -> None:
    ports = [esp_cdc("COM3", "AAAA", None), esp_cdc("COM5", "BBBB", None),
             stm_vcp("COM4", "STMA", None), stm_vcp("COM6", "STMB", None)]
    devs = discover(backends(serial=ports))
    assert len(devs) == 4
    assert sum(1 for d in devs if d.ports.cdc) == 2
    assert sum(1 for d in devs if d.ports.console and not d.ports.cdc) == 2


def test_nothing_connected() -> None:
    assert discover(backends()) == []


def test_midi_only_synthesizes_device() -> None:
    devs = discover(backends(midi=[esp_midi()]))
    assert len(devs) == 1
    assert devs[0].usb_mode is UsbMode.UNKNOWN
    assert devs[0].serial is None
    assert devs[0].ports.esp_midi is not None


def test_to_dict_shape() -> None:
    d = discover(backends(serial=[esp_cdc(), stm_vcp()], midi=[esp_midi()]))[0]
    dd = d.to_dict()
    assert dd["id"] == d.id
    assert dd["usb_mode"] == "default"
    assert dd["serial"] == "A1B2C3"
    assert dd["board_rev"] is None
    assert dd["ports"]["cdc"] == {"path": "/dev/ttyACM0", "vid": 0x303A, "pid": 0x3456,
                                  "serial": "A1B2C3", "product": "Crosspad",
                                  "location": "1-3.1:1.0"}
    assert dd["ports"]["uac2"] is None
    assert dd["ports"]["esp_midi"]["rtmidi_out"] == 1


def test_ports_paths() -> None:
    p = Ports(cdc=esp_cdc(), console=stm_vcp())
    assert p.paths() == {"cdc": "/dev/ttyACM0", "console": "/dev/ttyACM1"}
    assert Ports(bootloader=esp_boot("/dev/ttyACM9")).paths() == {"bootloader": "/dev/ttyACM9"}


# ---------------------------------------------------------------- select


def _two() -> list[Device]:
    return discover(backends(serial=[
        esp_cdc("/dev/ttyACM0", "AAAA", "1-3.1:1.0"), stm_vcp("/dev/ttyACM1", "STMA", "1-3.2:1.0"),
        esp_cdc("/dev/ttyACM2", "BBBB", "1-4.1:1.0"), stm_vcp("/dev/ttyACM3", "STMB", "1-4.2:1.0"),
    ]))


def test_select_implicit_single() -> None:
    devs = discover(backends(serial=[esp_cdc(), stm_vcp()]))
    assert select(devs) is devs[0]


def test_select_implicit_ignores_lonely_stm() -> None:
    devs = discover(backends(serial=[esp_cdc("/dev/ttyACM0", "AAAA", "1-3.1:1.0"),
                                     stm_vcp("/dev/ttyACM1", "STMA", "1-3.2:1.0"),
                                     stm_vcp("/dev/ttyACM5", "STMZ", "2-1.2:1.0")]))
    assert select(devs).serial == "AAAA"


def test_select_none_raises_no_device_with_hint() -> None:
    with pytest.raises(HilError) as ei:
        select([])
    assert ei.value.code == NO_DEVICE
    assert "bootloader/DFU" in ei.value.message


def test_select_audio_mode_board_counts_as_esp_side() -> None:
    devs = discover(backends(serial=[stm_vcp()], midi=[esp_midi()], audio=[uac2()]))
    assert select(devs).usb_mode is UsbMode.AUDIO


def test_select_ambiguous_lists_candidates() -> None:
    devs = _two()
    with pytest.raises(HilError) as ei:
        select(devs)
    err = ei.value
    assert err.code == AMBIGUOUS_DEVICE
    assert err.hint is not None and "device=" in err.hint
    ids = sorted(c["id"] for c in err.details["candidates"])
    assert ids == sorted(d.id for d in devs)
    assert all("ports" in c and "usb_mode" in c for c in err.details["candidates"])


def test_select_by_id() -> None:
    devs = _two()
    want = devs[1]
    assert select(devs, want.id) is want


def test_select_by_port_path_any_role() -> None:
    devs = _two()
    assert select(devs, "/dev/ttyACM3").serial == "BBBB"   # console path
    assert select(devs, "/dev/ttyACM0").serial == "AAAA"   # cdc path


def test_select_unknown_path_hint_names_roles() -> None:
    devs = _two()
    with pytest.raises(HilError) as ei:
        select(devs, "/dev/ttyUSB9")
    err = ei.value
    assert err.code == NO_DEVICE
    assert err.hint is not None
    assert "/dev/ttyACM1 (console)" in err.hint
    assert "/dev/ttyACM0 (cdc)" in err.hint
    assert err.details["device"] == "/dev/ttyUSB9"


# ---------------------------------------------------------------- Linux parsers


AMIDI_L = """Dir Device    Name
IO  hw:2,0,0  Crosspad MIDI 1
IO  hw:3,0,0  CrossPad MIDI+Serial MIDI 1
"""

ASOUND_CARDS = """ 0 [PCH            ]: HDA-Intel - HDA Intel PCH
                      HDA Intel PCH at 0xa1210000 irq 148
 2 [MIDI           ]: USB-Audio - Crosspad MIDI
                      TinyUSB Crosspad MIDI at usb-0000:00:14.0-3.1, full speed
 3 [MIDISerial     ]: USB-Audio - CrossPad MIDI+Serial
                      STMicroelectronics CrossPad MIDI+Serial at usb-0000:00:14.0-3.2, full speed
"""

ARECORD_L = """**** List of CAPTURE Hardware Devices ****
card 0: PCH [HDA Intel PCH], device 0: ALC236 Analog [ALC236 Analog]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: Audio [Crosspad Audio], device 0: USB Audio [USB Audio]
  Subdevices: 1/1
  Subdevice #0: subdevice #0
"""


def test_parse_amidi_list() -> None:
    assert devices.parse_amidi_list(AMIDI_L) == [
        ("hw:2,0,0", "Crosspad MIDI 1"),
        ("hw:3,0,0", "CrossPad MIDI+Serial MIDI 1"),
    ]
    assert devices.parse_amidi_list("") == []


def test_parse_asound_cards() -> None:
    assert devices.parse_asound_cards(ASOUND_CARDS) == [
        (0, "PCH", "HDA Intel PCH"),
        (2, "MIDI", "Crosspad MIDI"),
        (3, "MIDISerial", "CrossPad MIDI+Serial"),
    ]


def test_parse_arecord_list() -> None:
    assert devices.parse_arecord_list(ARECORD_L) == [
        (0, "PCH", "HDA Intel PCH"),
        (2, "Audio", "Crosspad Audio"),
    ]


def test_rawmidi_node() -> None:
    assert devices.rawmidi_node("hw:3,0,0") == "/dev/snd/midiC3D0"
    assert devices.rawmidi_node("hw:12,1") == "/dev/snd/midiC12D1"


def test_location_pairing_helpers() -> None:
    assert devices.location_key("1-3.2:1.0") == "1-3.2"
    assert devices.location_key(None) == ""
    assert devices.common_prefix_len("1-3.1", "1-3.2") == 4
    assert devices.common_prefix_len("1-3.1", "2-1.2") == 0


def test_enrich_midi_from_alsa_fills_hw_and_rawmidi() -> None:
    ports = [esp_midi(out=0, inp=0), stm_midi(out=1, inp=1)]
    for p in ports:
        p.alsa_hw = None
        p.rawmidi = None
    devices.enrich_midi_from_alsa(ports, AMIDI_L, ASOUND_CARDS)
    assert ports[0].alsa_hw == "hw:2,0,0" and ports[0].rawmidi == "/dev/snd/midiC2D0"
    assert ports[1].alsa_hw == "hw:3,0,0" and ports[1].rawmidi == "/dev/snd/midiC3D0"


def test_enrich_midi_from_asound_cards_without_amidi() -> None:
    ports = [stm_midi(out=1, inp=1)]
    ports[0].alsa_hw = None
    ports[0].rawmidi = None
    devices.enrich_midi_from_alsa(ports, "", ASOUND_CARDS)
    # hil_speedtest.py stm_midi_card: card number from /proc/asound/cards, device 0
    assert ports[0].rawmidi == "/dev/snd/midiC3D0"
    assert ports[0].alsa_hw == "hw:3,0,0"


def test_midi_ports_from_amidi_when_rtmidi_missing() -> None:
    ports = devices.midi_ports_from_amidi(AMIDI_L)
    assert [p.name for p in ports] == ["Crosspad MIDI 1", "CrossPad MIDI+Serial MIDI 1"]
    assert ports[0].rtmidi_out is None and ports[0].rtmidi_in is None
    assert ports[0].alsa_hw == "hw:2,0,0"


def test_audio_cards_from_arecord() -> None:
    cards = devices.audio_cards_from_arecord(ARECORD_L)
    assert cards == [AudioCardInfo(name="Crosspad Audio", sounddevice_index=None, alsa_id="Audio")]


def test_default_backends_without_optional_deps(monkeypatch: pytest.MonkeyPatch) -> None:
    # importing a module set to None in sys.modules raises ImportError
    monkeypatch.setitem(__import__("sys").modules, "rtmidi", None)
    monkeypatch.setitem(__import__("sys").modules, "sounddevice", None)
    monkeypatch.setattr(devices, "_run", lambda argv, timeout=5.0: "")
    monkeypatch.setattr(devices, "_read_text", lambda path: "")
    b = devices.default_backends()
    assert b.list_midi() == []
    assert b.list_audio() == []
    assert isinstance(b.list_serial(), list)


def test_default_backends_rtmidi_names(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    import types

    class _Out:
        def get_ports(self) -> list[str]:
            return ["Midi Through 14:0", "Crosspad MIDI 1 24:0", "CrossPad MIDI+Serial MIDI 1 28:0"]

    class _In:
        def get_ports(self) -> list[str]:
            return ["Crosspad MIDI 1 24:0", "CrossPad MIDI+Serial MIDI 1 28:0"]

    fake = types.ModuleType("rtmidi")
    fake.MidiOut = _Out  # type: ignore[attr-defined]
    fake.MidiIn = _In  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "rtmidi", fake)
    monkeypatch.setattr(devices, "_run", lambda argv, timeout=5.0: "")
    monkeypatch.setattr(devices, "_read_text", lambda path: "")
    ports = devices.default_backends().list_midi()
    assert [(p.name, p.rtmidi_out, p.rtmidi_in) for p in ports] == [
        ("Crosspad MIDI 1 24:0", 1, 0),
        ("CrossPad MIDI+Serial MIDI 1 28:0", 2, 1),
    ]


def test_default_backends_sounddevice(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    import types

    fake = types.ModuleType("sounddevice")
    fake.query_devices = lambda: [  # type: ignore[attr-defined]
        {"name": "HDA Intel PCH: ALC236 (hw:0,0)", "max_input_channels": 2},
        {"name": "Crosspad Audio: USB Audio (hw:2,0)", "max_input_channels": 0},
        {"name": "Crosspad Audio: USB Audio (hw:2,0)", "max_input_channels": 2},
    ]
    monkeypatch.setitem(sys.modules, "sounddevice", fake)
    monkeypatch.setattr(devices, "_run", lambda argv, timeout=5.0: ARECORD_L)
    cards = devices.default_backends().list_audio()
    assert cards == [AudioCardInfo(name="Crosspad Audio: USB Audio (hw:2,0)",
                                   sounddevice_index=2, alsa_id="Audio")]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_devices.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.devices'`.

- [ ] **Step 3: Write `devices.py`**

Create `/home/matixan/GIT/crosspad-hil/crosspad_hil/devices.py`:

```python
"""Discovery of CrossPad boards and the ports each one exposes (spec §2.3).

A CrossPad shows up on the host as several USB devices at once:

* ESP native-USB CDC ``0x303A:0x3456`` (or ``0x4001``) — the HIL command port.
  Gone in the MIDI+UAC2 profile.
* ESP ROM bootloader ``0x303A:0x1001`` / ``0x0009`` — after BOOTLOADER_REQUEST.
* STM32 bridge VCP ``0x0483:0x5740`` — the ESP console, survives ESP resets and
  USB mode switches (product string contains "crosspad").
* USB MIDI: ``Crosspad MIDI*`` (ESP, both profiles) and
  ``CrossPad MIDI+Serial`` (STM bridge).
* UAC2 ``Crosspad Audio`` — only in the audio profile.

One pass over three injectable backends (pyserial / rtmidi / sounddevice, with
ALSA text enrichment on Linux) merges those into ``Device`` records, infers the
USB mode, and ``select()`` applies the one-board-implicit rule.
"""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field, fields
from enum import Enum
from typing import Callable

from crosspad_hil.errors import AMBIGUOUS_DEVICE, NO_DEVICE, HilError

# ---------------------------------------------------------------- constants

ESP_VID = 0x303A                       # hil_smoke.py ESPRESSIF_VID
ESP_CDC_PIDS = {0x3456, 0x4001}        # requestBootloader.py ESPRESSIF_NORMAL_PIDS
ESP_BOOT_PIDS = {0x1001, 0x0009}       # requestBootloader.py ESPRESSIF_BOOTLOADER_PIDS
STM_VID = 0x0483                       # hil_smoke.py STM_BRIDGE_VID
STM_PID = 0x5740                       # hil_smoke.py STM_BRIDGE_PID

ESP_MIDI_NAME_MATCH = "crosspad"       # contains, case-insensitive, and not STM
STM_MIDI_NAME_MATCH = "MIDI+Serial"    # hil_audio_loopback.py STM_MIDI_NAME
UAC2_NAME_MATCH = "Crosspad Audio"     # hil_sampler_record.py AUDIO_DEV_MATCH

_SUBPROCESS_TIMEOUT_S = 5.0


# ---------------------------------------------------------------- model


class UsbMode(str, Enum):
    DEFAULT = "default"
    AUDIO = "audio"
    BOOTLOADER = "bootloader"
    UNKNOWN = "unknown"


@dataclass
class SerialPortInfo:
    path: str
    vid: int
    pid: int
    serial: str | None
    product: str | None
    location: str | None


@dataclass
class MidiPortInfo:
    name: str
    rtmidi_out: int | None
    rtmidi_in: int | None
    alsa_hw: str | None
    rawmidi: str | None


@dataclass
class AudioCardInfo:
    name: str
    sounddevice_index: int | None
    alsa_id: str | None


@dataclass
class Ports:
    cdc: SerialPortInfo | None = None
    console: SerialPortInfo | None = None
    esp_midi: MidiPortInfo | None = None
    stm_midi: MidiPortInfo | None = None
    uac2: AudioCardInfo | None = None
    bootloader: SerialPortInfo | None = None

    def paths(self) -> dict[str, str]:
        """Serial paths by role — the things a lock or a `select()` path can name."""
        out: dict[str, str] = {}
        for role in ("cdc", "console", "bootloader"):
            port = getattr(self, role)
            if port is not None:
                out[role] = port.path
        return out


@dataclass
class Device:
    id: str
    serial: str | None
    usb_mode: UsbMode
    ports: Ports
    board_rev: str | None = None

    def to_dict(self) -> dict:
        ports = {
            f.name: (None if getattr(self.ports, f.name) is None
                     else asdict(getattr(self.ports, f.name)))
            for f in fields(Ports)
        }
        return {
            "id": self.id,
            "serial": self.serial,
            "usb_mode": self.usb_mode.value,
            "board_rev": self.board_rev,
            "ports": ports,
        }

    def has_esp_side(self) -> bool:
        """True when the ESP is reachable: CDC, bootloader, UAC2 or its own MIDI port."""
        p = self.ports
        return any(x is not None for x in (p.cdc, p.bootloader, p.uac2, p.esp_midi))


@dataclass
class Backends:
    list_serial: Callable[[], list[SerialPortInfo]]
    list_midi: Callable[[], list[MidiPortInfo]]
    list_audio: Callable[[], list[AudioCardInfo]]


def device_id_for(serial: str | None, fallback: str) -> str:
    """``"dev_" + sha1(serial or fallback)[:4]`` — stable across re-enumeration."""
    key = serial if serial else fallback
    return "dev_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:4]


# ---------------------------------------------------------------- predicates


def is_esp_cdc(p: SerialPortInfo) -> bool:
    return p.vid == ESP_VID and p.pid in ESP_CDC_PIDS


def is_esp_bootloader(p: SerialPortInfo) -> bool:
    return p.vid == ESP_VID and p.pid in ESP_BOOT_PIDS


def is_stm_console(p: SerialPortInfo) -> bool:
    # hil_smoke.py candidate_ports: STM VCP whose product names a CrossPad.
    # A None product (Windows) is accepted; another product on ST's VID:PID is not.
    if p.vid != STM_VID or p.pid != STM_PID:
        return False
    return p.product is None or "crosspad" in p.product.lower()


def is_stm_midi_name(name: str) -> bool:
    return STM_MIDI_NAME_MATCH in name


def is_esp_midi_name(name: str) -> bool:
    return ESP_MIDI_NAME_MATCH in name.lower() and not is_stm_midi_name(name)


def is_uac2_name(name: str) -> bool:
    return UAC2_NAME_MATCH in name


# ---------------------------------------------------------------- Linux text parsers

# amidi -l:  "IO  hw:3,0,0  CrossPad MIDI+Serial MIDI 1"   (hil_midi_bench.py rawmidi_dev)
_AMIDI_RE = re.compile(r"^\s*[IO]+\s+(hw:\d+,\d+(?:,\d+)?)\s+(.*\S)\s*$")
# /proc/asound/cards:  " 3 [MIDISerial     ]: USB-Audio - CrossPad MIDI+Serial"
_ASOUND_CARD_RE = re.compile(r"^\s*(\d+)\s+\[([^\]]*?)\s*\]:\s*(?:[^-]*-\s*)?(.*\S)\s*$")
# arecord -l:  "card 2: Audio [Crosspad Audio], device 0: USB Audio [USB Audio]"
_ARECORD_RE = re.compile(r"^card (\d+): (\S+) \[([^\]]*)\], device \d+:")
_HW_RE = re.compile(r"hw:(\d+),(\d+)")


def parse_amidi_list(text: str) -> list[tuple[str, str]]:
    """``[(hw:X,Y,Z, name)]`` in listing order."""
    out: list[tuple[str, str]] = []
    for line in text.splitlines():
        m = _AMIDI_RE.match(line)
        if m:
            out.append((m.group(1), m.group(2)))
    return out


def parse_asound_cards(text: str) -> list[tuple[int, str, str]]:
    """``[(card_number, card_id, long_name)]`` from /proc/asound/cards
    (hil_speedtest.py stm_midi_card)."""
    out: list[tuple[int, str, str]] = []
    for line in text.splitlines():
        m = _ASOUND_CARD_RE.match(line)
        if m:
            out.append((int(m.group(1)), m.group(2), m.group(3)))
    return out


def parse_arecord_list(text: str) -> list[tuple[int, str, str]]:
    """``[(card_number, alsa_id, human_name)]`` from ``arecord -l``
    (hil_audio_loopback.py CARD_NAME / hil_usb_mode_cycle.py uac_present)."""
    out: list[tuple[int, str, str]] = []
    for line in text.splitlines():
        m = _ARECORD_RE.match(line)
        if m:
            out.append((int(m.group(1)), m.group(2), m.group(3)))
    return out


def rawmidi_node(hw: str) -> str:
    """``hw:3,0,0`` → ``/dev/snd/midiC3D0`` (hil_midi_bench.py rawmidi_dev)."""
    m = _HW_RE.search(hw)
    if not m:
        raise ValueError(f"not an ALSA hw spec: {hw!r}")
    return f"/dev/snd/midiC{m.group(1)}D{m.group(2)}"


def _midi_role(name: str) -> str | None:
    if is_stm_midi_name(name):
        return "stm"
    if is_esp_midi_name(name):
        return "esp"
    return None


def enrich_midi_from_alsa(ports: list[MidiPortInfo], amidi_text: str, cards_text: str) -> None:
    """Fill ``alsa_hw``/``rawmidi`` on rtmidi-found ports from ALSA listings.

    ``amidi -l`` gives the exact ``hw:`` spec; when amidi is absent the card
    number from /proc/asound/cards with device 0 is the fallback
    (hil_speedtest.py stm_midi_card).
    """
    by_role_hw: dict[str, list[str]] = {"esp": [], "stm": []}
    for hw, name in parse_amidi_list(amidi_text):
        role = _midi_role(name)
        if role:
            by_role_hw[role].append(hw)
    if not by_role_hw["esp"] and not by_role_hw["stm"]:
        for card, card_id, long_name in parse_asound_cards(cards_text):
            role = "stm" if card_id == "MIDISerial" else _midi_role(long_name)
            if role:
                by_role_hw[role].append(f"hw:{card},0,0")
    used: dict[str, int] = {"esp": 0, "stm": 0}
    for p in ports:
        if p.alsa_hw is not None:
            continue
        role = _midi_role(p.name)
        if role is None:
            continue
        candidates = by_role_hw[role]
        i = used[role]
        if i < len(candidates):
            p.alsa_hw = candidates[i]
            p.rawmidi = rawmidi_node(candidates[i])
            used[role] = i + 1


def midi_ports_from_amidi(amidi_text: str) -> list[MidiPortInfo]:
    """CrossPad MIDI ports from ``amidi -l`` alone (no rtmidi installed)."""
    out: list[MidiPortInfo] = []
    for hw, name in parse_amidi_list(amidi_text):
        if _midi_role(name) is None:
            continue
        out.append(MidiPortInfo(name=name, rtmidi_out=None, rtmidi_in=None,
                                alsa_hw=hw, rawmidi=rawmidi_node(hw)))
    return out


def audio_cards_from_arecord(arecord_text: str) -> list[AudioCardInfo]:
    """CrossPad UAC2 cards from ``arecord -l`` alone (no sounddevice installed)."""
    return [
        AudioCardInfo(name=human, sounddevice_index=None, alsa_id=alsa_id)
        for _card, alsa_id, human in parse_arecord_list(arecord_text)
        if is_uac2_name(human)
    ]


# ---------------------------------------------------------------- default backends


def _run(argv: list[str], timeout: float = _SUBPROCESS_TIMEOUT_S) -> str:
    """stdout of ``argv`` or "" when the tool is missing, fails or times out."""
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError, ValueError):
        return ""


def _read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def _pyserial_list() -> list[SerialPortInfo]:
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    out: list[SerialPortInfo] = []
    for p in list_ports.comports():
        out.append(SerialPortInfo(
            path=p.device,
            vid=p.vid if p.vid is not None else 0,
            pid=p.pid if p.pid is not None else 0,
            serial=p.serial_number,
            product=p.product,
            location=p.location,
        ))
    return out


def _rtmidi_list() -> list[MidiPortInfo]:
    amidi_text = _run(["amidi", "-l"]) if sys.platform.startswith("linux") else ""
    cards_text = _read_text("/proc/asound/cards") if sys.platform.startswith("linux") else ""
    try:
        import rtmidi
    except ImportError:
        return midi_ports_from_amidi(amidi_text) if amidi_text else []
    try:
        out_names = list(rtmidi.MidiOut().get_ports())
        in_names = list(rtmidi.MidiIn().get_ports())
    except Exception:  # noqa: BLE001 - a broken backend must not stop discovery
        return midi_ports_from_amidi(amidi_text) if amidi_text else []
    ports: list[MidiPortInfo] = []
    seen_in: set[int] = set()
    for oi, name in enumerate(out_names):
        if _midi_role(name) is None:
            continue
        # hil_sampler_record.py Midi.open: OUT and IN indices found independently
        ii = next((n for n, s in enumerate(in_names) if s == name and n not in seen_in), None)
        if ii is None:
            role = _midi_role(name)
            ii = next((n for n, s in enumerate(in_names)
                       if _midi_role(s) == role and n not in seen_in), None)
        if ii is not None:
            seen_in.add(ii)
        ports.append(MidiPortInfo(name=name, rtmidi_out=oi, rtmidi_in=ii,
                                  alsa_hw=None, rawmidi=None))
    for ii, name in enumerate(in_names):
        if ii in seen_in or _midi_role(name) is None:
            continue
        ports.append(MidiPortInfo(name=name, rtmidi_out=None, rtmidi_in=ii,
                                  alsa_hw=None, rawmidi=None))
    if amidi_text or cards_text:
        enrich_midi_from_alsa(ports, amidi_text, cards_text)
    return ports


def _sounddevice_list() -> list[AudioCardInfo]:
    arecord_text = _run(["arecord", "-l"]) if sys.platform.startswith("linux") else ""
    alsa_ids = [alsa_id for _c, alsa_id, human in parse_arecord_list(arecord_text)
                if is_uac2_name(human)]
    try:
        import sounddevice
    except ImportError:
        return audio_cards_from_arecord(arecord_text)
    try:
        infos = list(sounddevice.query_devices())
    except Exception:  # noqa: BLE001 - PortAudio can fail to init without a sound server
        return audio_cards_from_arecord(arecord_text)
    cards: list[AudioCardInfo] = []
    for idx, d in enumerate(infos):
        # hil_sampler_record.py find_capture: capture endpoint, at least stereo
        if not is_uac2_name(str(d["name"])) or int(d.get("max_input_channels", 0)) < 2:
            continue
        alsa_id = alsa_ids[len(cards)] if len(cards) < len(alsa_ids) else None
        cards.append(AudioCardInfo(name=str(d["name"]), sounddevice_index=idx, alsa_id=alsa_id))
    if not cards:
        return audio_cards_from_arecord(arecord_text)
    return cards


def default_backends() -> Backends:
    """pyserial + rtmidi + sounddevice, each optional, ALSA text enrichment on Linux."""
    return Backends(list_serial=_pyserial_list, list_midi=_rtmidi_list,
                    list_audio=_sounddevice_list)


# ---------------------------------------------------------------- grouping


def location_key(location: str | None) -> str:
    """USB topology without the interface suffix: ``1-3.2:1.0`` → ``1-3.2``."""
    if not location:
        return ""
    return location.split(":", 1)[0]


def common_prefix_len(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


@dataclass
class _Group:
    esp: SerialPortInfo | None = None       # cdc or bootloader port
    stm: SerialPortInfo | None = None
    esp_midi: MidiPortInfo | None = None
    stm_midi: MidiPortInfo | None = None
    uac2: AudioCardInfo | None = None
    fallback_key: str = field(default="")


def _pair(esp_ports: list[SerialPortInfo], stm_ports: list[SerialPortInfo]) -> list[_Group]:
    groups: list[_Group] = []
    if len(esp_ports) == 1 and len(stm_ports) == 1:
        return [_Group(esp=esp_ports[0], stm=stm_ports[0])]
    scored: list[tuple[int, int, int]] = []
    for ei, e in enumerate(esp_ports):
        for si, s in enumerate(stm_ports):
            ek, sk = location_key(e.location), location_key(s.location)
            if not ek or not sk:
                continue
            n = common_prefix_len(ek, sk)
            if n > 0:
                scored.append((n, ei, si))
    scored.sort(key=lambda t: (-t[0], t[1], t[2]))
    used_e: set[int] = set()
    used_s: set[int] = set()
    for _n, ei, si in scored:
        if ei in used_e or si in used_s:
            continue
        used_e.add(ei)
        used_s.add(si)
        groups.append(_Group(esp=esp_ports[ei], stm=stm_ports[si]))
    for ei, e in enumerate(esp_ports):
        if ei not in used_e:
            groups.append(_Group(esp=e))
    for si, s in enumerate(stm_ports):
        if si not in used_s:
            groups.append(_Group(stm=s))
    return groups


def _infer_mode(ports: Ports) -> UsbMode:
    if ports.bootloader is not None:
        return UsbMode.BOOTLOADER
    if ports.cdc is not None:
        return UsbMode.DEFAULT
    if ports.uac2 is not None:
        return UsbMode.AUDIO
    return UsbMode.UNKNOWN


def discover(backends: Backends | None = None) -> list[Device]:
    """One pass over the backends → ``Device`` records, ESP-side devices first."""
    b = backends if backends is not None else default_backends()
    serial_ports = b.list_serial()
    midi_ports = b.list_midi()
    audio_cards = b.list_audio()

    esp_serial = [p for p in serial_ports if is_esp_cdc(p) or is_esp_bootloader(p)]
    stm_serial = [p for p in serial_ports if is_stm_console(p)]
    esp_midis = [m for m in midi_ports if is_esp_midi_name(m.name)]
    stm_midis = [m for m in midi_ports if is_stm_midi_name(m.name)]
    uac2s = [a for a in audio_cards if is_uac2_name(a.name)]

    groups = _pair(esp_serial, stm_serial)
    esp_groups = [g for g in groups if g.esp is not None]
    stm_only = [g for g in groups if g.esp is None]

    # MIDI ports / UAC2 cards carry no USB serial: attach in enumeration order.
    if esp_groups:
        targets = esp_groups
    elif len(stm_only) == 1:
        targets = stm_only
    else:
        targets = []
    for g, m in zip(targets, esp_midis):
        g.esp_midi = m
    for g, a in zip(targets, uac2s):
        g.uac2 = a
    for g, m in zip([g for g in groups if g.stm is not None], stm_midis):
        g.stm_midi = m

    if not groups and (esp_midis or uac2s):
        # audio profile with the STM bridge absent (or Windows without the VCP driver)
        key = esp_midis[0].name if esp_midis else uac2s[0].name
        groups.append(_Group(esp_midi=esp_midis[0] if esp_midis else None,
                             uac2=uac2s[0] if uac2s else None, fallback_key=key))

    devices: list[Device] = []
    for g in groups:
        ports = Ports(
            cdc=g.esp if g.esp is not None and is_esp_cdc(g.esp) else None,
            bootloader=g.esp if g.esp is not None and is_esp_bootloader(g.esp) else None,
            console=g.stm,
            esp_midi=g.esp_midi,
            stm_midi=g.stm_midi,
            uac2=g.uac2,
        )
        if g.esp is not None:
            serial, fallback = g.esp.serial, g.esp.path
        elif g.stm is not None:
            serial, fallback = g.stm.serial, g.stm.path
        else:
            serial, fallback = None, g.fallback_key
        devices.append(Device(id=device_id_for(serial, fallback), serial=serial,
                              usb_mode=_infer_mode(ports), ports=ports))
    devices.sort(key=lambda d: (0 if d.has_esp_side() else 1))
    return devices


# ---------------------------------------------------------------- selection


def select(devices: list[Device], device: str | None = None) -> Device:
    """The one board, or the one named by id / port path; else NO_DEVICE / AMBIGUOUS_DEVICE."""
    if device is None:
        with_esp = [d for d in devices if d.has_esp_side()]
        if len(with_esp) == 1:
            return with_esp[0]
        if not with_esp:
            raise HilError(
                NO_DEVICE,
                "no CrossPad found; is it in bootloader/DFU?",
                hint=(
                    "check the cable, `crosspad-hil devices`, and udev permissions; "
                    + (f"{len(devices)} STM console(s) seen without an ESP side"
                       if devices else "nothing with VID 0x303A or 0x0483 enumerated")
                ),
                candidates=[d.to_dict() for d in devices],
            )
        raise HilError(
            AMBIGUOUS_DEVICE,
            f"{len(with_esp)} CrossPads connected; pick one",
            hint="pass device=<id> (or a port path): "
            + ", ".join(f"{d.id} [{d.usb_mode.value}]" for d in with_esp),
            candidates=[d.to_dict() for d in with_esp],
        )
    for d in devices:
        if d.id == device:
            return d
    for d in devices:
        if device in d.ports.paths().values():
            return d
    known = [f"{path} ({role})" for d in devices for role, path in d.ports.paths().items()]
    raise HilError(
        NO_DEVICE,
        f"no CrossPad matches {device!r}",
        hint=("known ports: " + ", ".join(known)) if known else "no CrossPad ports enumerated",
        device=device,
        candidates=[d.to_dict() for d in devices],
    )
```

- [ ] **Step 4: Run tests and ruff**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_devices.py -q && ruff check crosspad_hil/devices.py tests/test_devices.py`
Expected: `36 passed` and `All checks passed!`.

- [ ] **Step 5: Run the whole suite so far**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest -q`
Expected: all tests pass (Task 1–4), no hardware touched — `discover()` is only ever called with injected `Backends` and `default_backends()` only with monkeypatched `_run`/`_read_text`/`sys.modules`.

- [ ] **Step 6: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/devices.py tests/test_devices.py
git commit -m "feat(hil): discover CrossPads across CDC, STM VCP, MIDI and UAC2 and infer USB mode"
```
# Plan A — chunk A3: parsers (Task 5)

Repo: `/home/matixan/GIT/crosspad-hil`. Package `crosspad_hil`. All commands below run from that
directory. Python >= 3.10, pytest, ruff (line length 100). No hardware is touched by anything here —
`parsers.py` is pure functions plus one small stateful class, and every test feeds literal strings.

Origins that were ported (read them if a regex looks odd — the comment in the code names the source):

- `/home/matixan/GIT/platform-idf/tools/hil_smoke.py` — `REQUIRED_MARKERS`, `OPTIONAL_MARKERS`,
  `ERROR_ALLOWLIST`, `BOOT_MARKERS`, `evaluate()` boot-loop rule (`max(count) - 1`).
- `/home/matixan/GIT/platform-idf/tools/hil_stability.py` — `RST_REASON_RE`, `HEAP_FREE_RE`, heap block
  bracketing (`"Heap Statistics"` … `"Total tasks:"`), per-reset pending-marker set, fatal patterns.
- `/home/matixan/GIT/platform-idf/tools/hil_kit_churn.py` — `FATAL_RE` (the wider union), `KIT_REQ_RE`,
  `CDC_DROP_RE`, `"ESP-ROM:esp32s3"` reboot counting, `parse_kits`, `parse_status`, `SMPLPEAK` regex.
- `/home/matixan/GIT/platform-idf/main/hil_control.cpp` — every `snprintf` reply format (copied verbatim
  into comments next to each parser).
- `/home/matixan/GIT/platform-idf/components/bsp/crosspad/performance_monitor.c` — the PerfMon heap block
  prints three `Free:` lines (internal, DMA-capable, PSRAM) → heap slots 0, 1, 2.

---

### Task 5: parsers.py — ConsoleParser, parse_cdc_reply, parse_enc_group

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/parsers.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_parsers_console.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_parsers_cdc.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_parsers_enc.py`

**Interfaces:**
- Consumes: `crosspad_hil.knowledge.load(name: str) -> dict` (Task 2, contract §knowledge) — only when
  `ConsoleParser(knowledge=None)`; every test here passes an explicit dict so this task does not depend
  on `markers.yaml` being finished. The dict shape is exactly the `markers.yaml` key set from the
  contract: `boot_markers, required, required_stability, optional, error_line, error_allow,
  fatal_patterns, reset_reason, heap_block{start,line,end}, kit_request, cdc_drops, reboot,
  boot_timeout_s`.
- Produces (verbatim from the contract):
  ```python
  @dataclass
  class ConsoleEvent: kind: str; seq: int; line: str; data: dict
  class ConsoleParser:
      def __init__(self, knowledge: dict | None = None, required: list[str] | None = None) -> None
      def feed(self, seq: int, line: str) -> list[ConsoleEvent]
      def reset_boot_tracking(self) -> None
      def snapshot(self) -> dict
  def parse_cdc_reply(line: str) -> dict | None
  def parse_enc_group(lines: list[str]) -> list[dict]
  ```
  Event kinds and `data` keys: `boot_marker {marker}`, `boot_complete {missing: []}`, `reboot {count}`,
  `reset_reason {code, name}`, `error_line {}`, `fatal {pattern}`, `heap {slot, free}`,
  `kit {kit, state}`, `cdc_drops {dropped}`.
  `snapshot()` keys: `fatals [{seq,pattern,line}], reboots int, reset_reasons [str],
  errors [{seq,line}], markers_seen {marker: count}, boot_complete bool, missing_markers [str],
  bootloops int, heap {slot_index: free}, kit_requests [{kit,state,seq}], cdc_drops int`.
- Decisions where the contract is silent (all stated here so Console/verbs/snapshot chunks can rely
  on them):
  1. `reset_boot_tracking()` clears **boot-scoped** state only: `markers_seen`, the pending required
     set, `boot_complete`, the half-collected heap block, and re-arms reset-reason capture. Cumulative
     session counters (`fatals`, `errors`, `reboots`, `reset_reasons`, `heap`, `kit_requests`,
     `cdc_drops`) survive — a Console that wants a clean slate constructs a new parser.
  2. A line containing the `reboot` substring (`"ESP-ROM:esp32s3"`) increments `reboots`, emits
     `reboot {count}`, and — as in hil_stability — re-arms the pending required-marker set so a
     second `boot_complete` can fire for the second boot. `boot_marker` events are emitted only for
     `required` and `optional` markers; `boot_markers` (`"ESP-ROM:"`, `"main_task: Started on CPU0"`)
     are only counted in `markers_seen` for the boot-loop rule `bootloops = max(0, max(count) - 1)`.
  3. `reset_reason`: the first `rst:` line after each `"ESP-ROM:"` (or after construction /
     `reset_boot_tracking`, since the banner is regularly missed) is captured; later `rst:` lines
     before the next banner are ignored (hil_stability `last_reset_reason is None` rule).
     `reset_reasons` entries are `"<code> (<name>)"`, e.g. `"0x1 (POWERON)"`.
  4. `fatal`: the first matching pattern wins per line (`break` as in hil_stability), `data.pattern`
     is the regex source string. `error_line` is only emitted when no `error_allow` substring is in
     the line. A line can be both `reset_reason` and `fatal` (`rst:0x10 (RTCWDT_RTC_RST)`); note the
     ported `rst:` fatal regex uses `[A-Z_]*`, so names with a digit before `WDT`
     (`TG1WDT_SYS_RST`) are reset reasons but not fatals — kept exactly as the old scripts behave.
  5. `heap`: one `heap {slot, free}` event per `Free:` line **at block end** (`"Total tasks:"`), slot
     index = position inside the block (0 internal, 1 DMA, 2 PSRAM). A block that never closes is
     dropped when the next `"Heap Statistics"` starts. `snapshot()["heap"]` holds the latest value per
     slot.
  6. `cdc_drops`: the firmware value is cumulative (`main.cpp:621`), so the parser stores the latest
     value, not a sum (hil_kit_churn behaviour).
  7. `parse_cdc_reply` generic scalar rule for `key=value` replies (`MEM`, `PADSTATS`, `CDCSTATS`,
     `BLE`, `UI`, `ENC`): `-?\d+` → `int`; `"-"` → `None`; anything else stays `str`. `LEDS` extras:
     `bri`→`brightness`, `pwrN`→`pwr_count`, `pwr` parsed from hex → `int`, `anim`/`coalesce` → `bool`,
     `colors` → list of 16 `"RRGGBB"` strings. `MEMBLK.buckets[].le` is the firmware label string
     (`"64"`, `"1k"`, `"big"`); `MEMBIG.blocks[].addr` is an `int` parsed from the `%08x` hex.
     `APPVER.id`/`ref` `"-"` → `None`. Any body starting with `ERR` (e.g. `ENCGROUP: ERR lock`,
     `ENCFOCUS: ERR lock`) → `{"kind": "err", "message": <whole line>}`. `PADINFO` (not in the
     contract list, but a real reply) parses to `{"kind": "padinfo", ..., "slots": [...], "raw": line}`;
     `ENCGROUP: count=N` alone parses to `{"kind": "encgroup", "count": N}`.
  8. `parse_enc_group`: tolerant — the head line is optional, `"ENCGROUP: ERR lock"` yields `[]`,
     and any line matching `^\s*\[(\d+)\]\s+(\S+)\s?(.*)$` becomes an entry; `label` may be `""`.

---

- [ ] **Step 1: Write the failing console-event tests**

`/home/matixan/GIT/crosspad-hil/tests/test_parsers_console.py`:

```python
"""ConsoleParser: ESP-IDF console lines → typed events (ported hil_smoke / hil_stability rules)."""
from __future__ import annotations

import copy

import pytest

from crosspad_hil.parsers import ConsoleEvent, ConsoleParser

# Identical to knowledge/markers.yaml (contract §knowledge); kept inline so this file has no
# dependency on the knowledge task.
MARKERS: dict = {
    "boot_markers": ["ESP-ROM:", "main_task: Started on CPU0"],
    "required": [
        "Platform fully initialized",
        "STM32 ident:",
        "Crosspad initialization complete",
        "All systems operational",
        "LVGL setup done successfully",
        "App registry initialized",
        "LoadMainScreen completed successfully",
    ],
    "required_stability": [
        "Platform fully initialized",
        "Crosspad initialization complete",
        "All systems operational",
        "LVGL setup done successfully",
        "App registry initialized",
        "LoadMainScreen completed successfully",
    ],
    "optional": ["SD Card mounted successfully", "ES8388 [1] started", "DRV2605 found"],
    "error_line": r"^E \(\d+\)",
    "error_allow": ["file not found"],
    "fatal_patterns": [
        r"Guru Meditation",
        r"abort\(\) was called",
        r"assert failed",
        r"CORRUPT HEAP",
        r"Stack smashing",
        r"LoadProhibited",
        r"StoreProhibited",
        r"InstrFetchProhibited",
        r"IllegalInstruction",
        r"Stack canary watchpoint",
        r"task_wdt",
        r"Task watchdog",
        r"Interrupt wdt timeout",
        r"rst:0x[0-9a-f]+ \(([A-Z_]*(PANIC|WDT|BROWNOUT))",
    ],
    "reset_reason": r"rst:(0x[0-9a-fA-F]+)\s*\(([^)]+)\)",
    "heap_block": {
        "start": "Heap Statistics",
        "line": r"PerfMon:\s+Free:\s+(\d+) bytes",
        "end": "Total tasks:",
    },
    "kit_request": r"hil_control: KIT_LOAD (\d+) (queued|started)",
    "cdc_drops": r"CDC: (\d+) commands dropped",
    "reboot": "ESP-ROM:esp32s3",
    "boot_timeout_s": 45,
}

# A complete, healthy boot as the STM VCP bridge shows it.
GOOD_BOOT = [
    "ESP-ROM:esp32s3-20210327",
    "rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)",
    "I (525) main_task: Started on CPU0",
    "I (1234) CrosspadPlatform: Platform fully initialized",
    "I (1300) stm32_i2c: STM32 ident: proto=1.2 fw=1.4 pcb=20",
    "I (1500) bsp: SD Card mounted successfully",
    "I (2000) main: Crosspad initialization complete",
    "I (2100) main: All systems operational",
    "I (2500) display: LVGL setup done successfully",
    "I (2600) gui: App registry initialized",
    "I (2700) gui: LoadMainScreen completed successfully",
]


def feed_all(parser: ConsoleParser, lines: list[str], start: int = 0) -> list[ConsoleEvent]:
    out: list[ConsoleEvent] = []
    for i, line in enumerate(lines, start):
        out.extend(parser.feed(i, line))
    return out


def kinds(events: list[ConsoleEvent]) -> list[str]:
    return [e.kind for e in events]


def test_event_dataclass_shape() -> None:
    ev = ConsoleEvent(kind="fatal", seq=3, line="x", data={"pattern": "y"})
    assert (ev.kind, ev.seq, ev.line, ev.data) == ("fatal", 3, "x", {"pattern": "y"})


def test_good_boot_emits_markers_then_boot_complete() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    events = feed_all(p, GOOD_BOOT)
    markers = [e.data["marker"] for e in events if e.kind == "boot_marker"]
    assert markers == (
        MARKERS["required"][:2] + ["SD Card mounted successfully"] + MARKERS["required"][2:]
    )
    complete = [e for e in events if e.kind == "boot_complete"]
    assert len(complete) == 1
    assert complete[0].seq == 10
    assert complete[0].data == {"missing": []}
    snap = p.snapshot()
    assert snap["boot_complete"] is True
    assert snap["missing_markers"] == []
    assert snap["bootloops"] == 0
    assert snap["reboots"] == 1
    assert snap["reset_reasons"] == ["0x1 (POWERON)"]
    assert snap["errors"] == [] and snap["fatals"] == []
    assert snap["markers_seen"]["ESP-ROM:"] == 1
    assert snap["markers_seen"]["main_task: Started on CPU0"] == 1
    assert snap["markers_seen"]["LoadMainScreen completed successfully"] == 1


def test_incomplete_boot_reports_missing_in_required_order() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    lines = [ln for ln in GOOD_BOOT if "STM32 ident" not in ln and "App registry" not in ln]
    events = feed_all(p, lines)
    assert "boot_complete" not in kinds(events)
    snap = p.snapshot()
    assert snap["boot_complete"] is False
    assert snap["missing_markers"] == ["STM32 ident:", "App registry initialized"]


def test_required_override_uses_stability_set() -> None:
    p = ConsoleParser(knowledge=MARKERS, required=MARKERS["required_stability"])
    lines = [ln for ln in GOOD_BOOT if "STM32 ident" not in ln]
    events = feed_all(p, lines)
    assert "boot_complete" in kinds(events)
    assert p.snapshot()["missing_markers"] == []


def test_reboot_event_and_bootloop_count() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    events = feed_all(p, GOOD_BOOT + GOOD_BOOT + GOOD_BOOT[:3])
    reboots = [e for e in events if e.kind == "reboot"]
    assert [e.data["count"] for e in reboots] == [1, 2, 3]
    assert reboots[2].line == "ESP-ROM:esp32s3-20210327"
    snap = p.snapshot()
    assert snap["reboots"] == 3
    # hil_smoke.evaluate: boots = max(count per BOOT_MARKER); bootloops = boots - 1
    assert snap["bootloops"] == 2
    # the second boot completed again
    assert kinds(events).count("boot_complete") == 2


def test_reset_reason_first_after_banner_only() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    events = feed_all(
        p,
        [
            "rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)",  # banner missed: still accepted
            "rst:0x3 (RTC_SW_SYS_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)",  # ignored until next banner
            "ESP-ROM:esp32s3-20210327",
            "rst:0x10 (RTCWDT_RTC_RST),boot:0x8 (SPI_FAST_FLASH_BOOT)",
        ],
    )
    reasons = [e for e in events if e.kind == "reset_reason"]
    assert [e.data for e in reasons] == [
        {"code": "0x1", "name": "POWERON"},
        {"code": "0x10", "name": "RTCWDT_RTC_RST"},
    ]
    assert p.snapshot()["reset_reasons"] == ["0x1 (POWERON)", "0x10 (RTCWDT_RTC_RST)"]
    # a WDT reset reason is also a fatal (hil_kit_churn FATAL_RE). Note the ported regex's
    # [A-Z_]* cannot cross a digit, so TG1WDT_SYS_RST / TG0WDT_SYS_RST are *not* fatals —
    # that is the firmware scripts' behaviour and is kept as is.
    fatal = [e for e in events if e.kind == "fatal"]
    assert len(fatal) == 1 and fatal[0].seq == 3
    assert fatal[0].data["pattern"] == r"rst:0x[0-9a-f]+ \(([A-Z_]*(PANIC|WDT|BROWNOUT))"


@pytest.mark.parametrize(
    ("line", "pattern"),
    [
        (
            "Guru Meditation Error: Core  1 panic'ed (LoadProhibited). Exception was unhandled.",
            r"Guru Meditation",
        ),
        ("abort() was called at PC 0x4037a1b2 on core 0", r"abort\(\) was called"),
        ("assert failed: xQueueGenericSend queue.c:832 (pxQueue)", r"assert failed"),
        (
            "CORRUPT HEAP: Bad head at 0x3fcb1234. Expected 0xabba1234 got 0x00000000",
            r"CORRUPT HEAP",
        ),
        ("Stack smashing protect failure!", r"Stack smashing"),
        # matches both "task_wdt" and "Task watchdog": the first pattern in the list wins
        ("E (91234) task_wdt: Task watchdog got triggered.", r"task_wdt"),
        ("Interrupt wdt timeout on CPU1", r"Interrupt wdt timeout"),
        (
            "Debug exception reason: Stack canary watchpoint triggered (audio_rt)",
            r"Stack canary watchpoint",
        ),
    ],
)
def test_fatal_patterns_first_match_wins(line: str, pattern: str) -> None:
    p = ConsoleParser(knowledge=MARKERS)
    events = p.feed(7, line)
    fatal = [e for e in events if e.kind == "fatal"]
    assert len(fatal) == 1
    assert fatal[0].data == {"pattern": pattern}
    assert p.snapshot()["fatals"] == [{"seq": 7, "pattern": pattern, "line": line}]


def test_guru_meditation_line_is_one_fatal_not_two() -> None:
    # Matches both "Guru Meditation" and "LoadProhibited": hil_stability breaks on the first hit.
    p = ConsoleParser(knowledge=MARKERS)
    events = p.feed(1, "Guru Meditation Error: Core  1 panic'ed (LoadProhibited).")
    assert kinds(events) == ["fatal"]


@pytest.mark.parametrize(
    ("line", "is_error"),
    [
        ("E (3100) sdmmc_cmd: sdmmc_read_sectors_dma: returned 0x107", True),
        ("E (3000) audio: file not found: /sdcard/STARTUP.wav", False),  # ERROR_ALLOWLIST
        ("W (3200) main: CDC: 0 commands dropped (app_queue full)", False),
        ("I (3300) main: E (1) is not at line start", False),
    ],
)
def test_error_line_with_allowlist(line: str, is_error: bool) -> None:
    p = ConsoleParser(knowledge=MARKERS)
    events = p.feed(42, line)
    errs = [e for e in events if e.kind == "error_line"]
    assert (len(errs) == 1) is is_error
    if is_error:
        assert errs[0].data == {}
        assert p.snapshot()["errors"] == [{"seq": 42, "line": line}]
    else:
        assert p.snapshot()["errors"] == []


HEAP_BLOCK = [
    "I (10000) PerfMon: === Heap Statistics ===",
    "I (10000) PerfMon: Internal SRAM:",
    "I (10000) PerfMon:   Total:               398964 bytes",
    "I (10001) PerfMon:   Free:                76544 bytes",
    "I (10001) PerfMon:   Largest free block:   65536 bytes",
    "I (10002) PerfMon: DMA-capable:",
    "I (10002) PerfMon:   Free:                70000 bytes",
    "I (10003) PerfMon: PSRAM:",
    "I (10003) PerfMon:   Free:              8123456 bytes",
    "I (10004) PerfMon:   Allocated blocks:       1201",
    "I (10010) PerfMon:   Total tasks: 23",
]


def test_heap_block_emits_one_event_per_slot_at_block_end() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    events = feed_all(p, HEAP_BLOCK, start=100)
    heap = [e for e in events if e.kind == "heap"]
    assert [(e.data["slot"], e.data["free"]) for e in heap] == [
        (0, 76544),
        (1, 70000),
        (2, 8123456),
    ]
    assert all(e.seq == 110 for e in heap)  # all emitted on the "Total tasks:" line
    assert p.snapshot()["heap"] == {0: 76544, 1: 70000, 2: 8123456}


def test_heap_block_without_end_is_discarded_by_next_start() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    truncated = HEAP_BLOCK[:4]  # start + one Free line, no "Total tasks:"
    events = feed_all(p, truncated + HEAP_BLOCK)
    heap = [e for e in events if e.kind == "heap"]
    assert len(heap) == 3
    assert p.snapshot()["heap"] == {0: 76544, 1: 70000, 2: 8123456}


def test_heap_latest_value_wins() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    feed_all(p, HEAP_BLOCK)
    second = [ln.replace("76544", "70120") for ln in HEAP_BLOCK]
    feed_all(p, second, start=50)
    assert p.snapshot()["heap"][0] == 70120


def test_kit_requests_and_cdc_drops() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    events = feed_all(
        p,
        [
            "I (5000) hil_control: KIT_LOAD 3 started",
            "I (5100) hil_control: KIT_LOAD 4 queued",
            "W (6000) main: CDC: 12 commands dropped (app_queue full)",
            "W (7000) main: CDC: 15 commands dropped (app_queue full)",
        ],
        start=200,
    )
    kit = [e for e in events if e.kind == "kit"]
    assert [e.data for e in kit] == [{"kit": 3, "state": "started"}, {"kit": 4, "state": "queued"}]
    drops = [e for e in events if e.kind == "cdc_drops"]
    assert [e.data for e in drops] == [{"dropped": 12}, {"dropped": 15}]
    snap = p.snapshot()
    assert snap["kit_requests"] == [
        {"kit": 3, "state": "started", "seq": 200},
        {"kit": 4, "state": "queued", "seq": 201},
    ]
    assert snap["cdc_drops"] == 15  # cumulative firmware counter: latest, not summed


def test_reset_boot_tracking_clears_boot_state_keeps_session_counters() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    feed_all(p, GOOD_BOOT + ["E (9000) x: broken"])
    p.feed(99, "Guru Meditation Error: Core  0 panic'ed (StoreProhibited).")
    before = p.snapshot()
    assert before["boot_complete"] is True and before["bootloops"] == 0
    p.reset_boot_tracking()
    snap = p.snapshot()
    assert snap["boot_complete"] is False
    assert snap["markers_seen"] == {}
    assert snap["missing_markers"] == MARKERS["required"]
    assert snap["bootloops"] == 0
    # session counters survive
    assert snap["reboots"] == 1
    assert len(snap["errors"]) == 1
    assert len(snap["fatals"]) == 1
    assert snap["reset_reasons"] == ["0x1 (POWERON)"]
    # and a fresh boot after the reset completes again
    events = feed_all(p, GOOD_BOOT, start=300)
    assert "boot_complete" in kinds(events)
    assert p.snapshot()["bootloops"] == 0


def test_snapshot_is_a_copy() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    feed_all(p, GOOD_BOOT)
    snap = p.snapshot()
    snap["markers_seen"].clear()
    snap["reset_reasons"].append("bogus")
    fresh = p.snapshot()
    assert fresh["markers_seen"]["ESP-ROM:"] == 1
    assert fresh["reset_reasons"] == ["0x1 (POWERON)"]


def test_constructor_does_not_mutate_knowledge() -> None:
    k = copy.deepcopy(MARKERS)
    p = ConsoleParser(knowledge=k, required=["only this"])
    p.feed(0, "only this")
    assert k == MARKERS


def test_plain_line_yields_no_events() -> None:
    p = ConsoleParser(knowledge=MARKERS)
    assert p.feed(1, "I (100) main: hello") == []
    assert p.feed(2, "") == []
```

- [ ] **Step 2: Run the console tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_parsers_console.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.parsers'` (collection error).

- [ ] **Step 3: Write parsers.py — ConsoleParser plus stubs for the two functions**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/parsers.py` (whole file; the two CDC functions are
filled in at Step 7 and Step 11 — the file below is complete and importable as written):

```python
"""Console-line and CDC-reply parsers.

Pure functions plus one small stateful class; no I/O, no threads, no global state.
Console rules are ported from platform-idf/tools/hil_smoke.py, hil_stability.py and
hil_kit_churn.py; the CDC reply grammar is platform-idf/main/hil_control.cpp — each parser
below quotes the firmware printf format it decodes.
"""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from typing import Any

from crosspad_hil.knowledge import load


@dataclass
class ConsoleEvent:
    kind: str
    seq: int
    line: str
    data: dict[str, Any] = field(default_factory=dict)


class ConsoleParser:
    """Feed console lines one at a time; get typed events back; ask for a summary.

    Boot-scoped state (markers, pending required set, boot_complete) is cleared by
    reset_boot_tracking(); session counters (fatals, errors, reboots, heap, kit requests,
    cdc drops) accumulate for the life of the parser.
    """

    def __init__(self, knowledge: dict | None = None, required: list[str] | None = None) -> None:
        k = knowledge if knowledge is not None else load("markers")
        # hil_smoke.BOOT_MARKERS / REQUIRED_MARKERS / OPTIONAL_MARKERS
        self._boot_markers: list[str] = list(k["boot_markers"])
        self._required: list[str] = list(required) if required is not None else list(k["required"])
        self._optional: list[str] = list(k.get("optional", []))
        # hil_smoke: re.match(r"^E \(\d+\)", line) and ERROR_ALLOWLIST substrings
        self._error_re = re.compile(k["error_line"])
        self._error_allow: list[str] = list(k.get("error_allow", []))
        # hil_stability.FATAL_PATTERNS ∪ hil_kit_churn.FATAL_RE
        self._fatal_res: list[re.Pattern[str]] = [re.compile(p) for p in k["fatal_patterns"]]
        # hil_stability.RST_REASON_RE
        self._reset_re = re.compile(k["reset_reason"])
        # hil_stability / hil_kit_churn: "Heap Statistics" … HEAP_FREE_RE … "Total tasks:"
        heap = k["heap_block"]
        self._heap_start: str = heap["start"]
        self._heap_line = re.compile(heap["line"])
        self._heap_end: str = heap["end"]
        # hil_kit_churn.KIT_REQ_RE / CDC_DROP_RE
        self._kit_re = re.compile(k["kit_request"])
        self._drops_re = re.compile(k["cdc_drops"])
        # hil_kit_churn: "ESP-ROM:esp32s3" in line → reboots += 1
        self._reboot: str = k["reboot"]

        self._markers_seen: dict[str, int] = {}
        self._pending: set[str] = set(self._required)
        self._boot_complete = False
        self._reset_armed = True
        self._heap_block: list[int] = []
        self._in_heap_block = False

        self._reboots = 0
        self._reset_reasons: list[str] = []
        self._fatals: list[dict[str, Any]] = []
        self._errors: list[dict[str, Any]] = []
        self._heap: dict[int, int] = {}
        self._kit_requests: list[dict[str, Any]] = []
        self._cdc_drops = 0

    def reset_boot_tracking(self) -> None:
        self._markers_seen = {}
        self._pending = set(self._required)
        self._boot_complete = False
        self._reset_armed = True
        self._heap_block = []
        self._in_heap_block = False

    def feed(self, seq: int, line: str) -> list[ConsoleEvent]:
        events: list[ConsoleEvent] = []
        if not line:
            return events

        # Reboot banner (hil_kit_churn) — also re-arms the per-boot pending set (hil_stability).
        if self._reboot in line:
            self._reboots += 1
            self._pending = set(self._required)
            self._boot_complete = False
            events.append(ConsoleEvent("reboot", seq, line, {"count": self._reboots}))
        # Boot-loop counting (hil_smoke.evaluate): every boot marker occurrence is counted.
        for marker in self._boot_markers:
            if marker in line:
                self._markers_seen[marker] = self._markers_seen.get(marker, 0) + 1
                if marker == "ESP-ROM:":
                    self._reset_armed = True

        # Reset reason: first "rst:" line after a banner (hil_stability last_reset_reason rule).
        if self._reset_armed:
            m = self._reset_re.search(line)
            if m:
                self._reset_armed = False
                code, name = m.group(1), m.group(2)
                self._reset_reasons.append(f"{code} ({name})")
                events.append(ConsoleEvent("reset_reason", seq, line, {"code": code, "name": name}))

        # Required / optional markers (substring match, hil_smoke).
        for marker in self._required + self._optional:
            if marker in line:
                self._markers_seen[marker] = self._markers_seen.get(marker, 0) + 1
                events.append(ConsoleEvent("boot_marker", seq, line, {"marker": marker}))
                self._pending.discard(marker)
        if self._pending == set() and not self._boot_complete:
            self._boot_complete = True
            events.append(ConsoleEvent("boot_complete", seq, line, {"missing": []}))

        # Fatal: first pattern wins (hil_stability breaks after the first hit).
        for rx in self._fatal_res:
            if rx.search(line):
                self._fatals.append({"seq": seq, "pattern": rx.pattern, "line": line})
                events.append(ConsoleEvent("fatal", seq, line, {"pattern": rx.pattern}))
                break

        # E-level line outside the allowlist (hil_smoke).
        if self._error_re.match(line) and not any(a in line for a in self._error_allow):
            self._errors.append({"seq": seq, "line": line})
            events.append(ConsoleEvent("error_line", seq, line, {}))

        # PerfMon heap block: "Heap Statistics" opens, Free: lines collect, "Total tasks:" closes.
        hm = self._heap_line.search(line)
        if hm:
            if self._in_heap_block:
                self._heap_block.append(int(hm.group(1)))
        elif self._heap_start in line:
            self._heap_block = []
            self._in_heap_block = True
        elif self._heap_end in line and self._in_heap_block:
            for slot, free in enumerate(self._heap_block):
                self._heap[slot] = free
                events.append(ConsoleEvent("heap", seq, line, {"slot": slot, "free": free}))
            self._heap_block = []
            self._in_heap_block = False

        # Kit requests the firmware actually saw (hil_kit_churn KIT_REQ_RE).
        km = self._kit_re.search(line)
        if km:
            kit, state = int(km.group(1)), km.group(2)
            self._kit_requests.append({"kit": kit, "state": state, "seq": seq})
            events.append(ConsoleEvent("kit", seq, line, {"kit": kit, "state": state}))

        # Cumulative CDC drop counter (hil_kit_churn CDC_DROP_RE; main.cpp prints a running total).
        dm = self._drops_re.search(line)
        if dm:
            self._cdc_drops = int(dm.group(1))
            events.append(ConsoleEvent("cdc_drops", seq, line, {"dropped": self._cdc_drops}))

        return events

    def snapshot(self) -> dict:
        boots = max((self._markers_seen.get(m, 0) for m in self._boot_markers), default=0)
        return {
            "fatals": copy.deepcopy(self._fatals),
            "reboots": self._reboots,
            "reset_reasons": list(self._reset_reasons),
            "errors": copy.deepcopy(self._errors),
            "markers_seen": dict(self._markers_seen),
            "boot_complete": self._boot_complete,
            "missing_markers": [m for m in self._required if m in self._pending],
            "bootloops": max(0, boots - 1),
            "heap": dict(self._heap),
            "kit_requests": copy.deepcopy(self._kit_requests),
            "cdc_drops": self._cdc_drops,
        }


def parse_cdc_reply(line: str) -> dict | None:
    """Filled in at Step 7."""
    return None


def parse_enc_group(lines: list[str]) -> list[dict]:
    """Filled in at Step 11."""
    return []
```

- [ ] **Step 4: Run the console tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_parsers_console.py -q && ruff check crosspad_hil/parsers.py tests/test_parsers_console.py`
Expected: `27 passed` (8 fatal params + 4 error params + 15 plain tests) and ruff `All checks passed!`.

- [ ] **Step 5: Commit the console parser**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/parsers.py tests/test_parsers_console.py
git commit -m "feat(parsers): ConsoleParser ported from hil_smoke/hil_stability/hil_kit_churn"
```

- [ ] **Step 6: Write the failing CDC-reply tests**

`/home/matixan/GIT/crosspad-hil/tests/test_parsers_cdc.py` — every sample line is built from the
`snprintf` format in `hil_control.cpp` (the `\r\n` is stripped by the CdcLink reader before parsing,
but the parser must also tolerate a trailing `\r\n`):

```python
"""parse_cdc_reply: one dict per reply prefix, formats copied from main/hil_control.cpp."""
from __future__ import annotations

import pytest

from crosspad_hil.parsers import parse_cdc_reply

BLE_LINE = (
    "BLE: supported=1 running=1 state=connected mode=server "
    "self=7c:df:a1:00:11:22 peer=a4:c1:38:aa:bb:cc itvl=15 txoff=36 rxoff=0 "
    "tx_msg=181 tx_pkt=120 tx_drop=0 tx_err=0 rx_msg=4 rx_pkt=4"
)

LEDS_LINE = (
    "LEDS: bri=80 anim=1 coalesce=0 cfgbri=50 pwr=0x1F pwrN=3 txfail=0 colors="
    "FF0000,00FF00,0000FF,000000,000000,000000,000000,000000,"
    "000000,000000,000000,000000,000000,000000,000000,FFFFFF"
)

MEMBLK_LINE = (
    "MEMBLK: biggest_used=32768 | <=64 u=812/31240B f=40/1800B | <=128 u=210/19800B f=12/1100B"
    " | <=256 u=90/16000B f=3/600B | <=512 u=40/14000B f=2/900B | <=1k u=20/15000B f=1/800B"
    " | <=2k u=10/16000B f=0/0B | <=8k u=6/30000B f=1/4096B | <=big u=3/70000B f=1/18000B"
)

PADINFO_LINE = (
    "PADINFO: idx=3 num=39 kit=DRUMS vol=100 pan=0 mode=1 dirty=0 count=2"
    " | [0] 'kick.wav' 0..127 | [1] 'kick2.wav' 64..127"
)

CASES: list[tuple[str, dict]] = [
    # "KITSTATUS: current=%d loading=%d pending=%d name=%s"
    (
        "KITSTATUS: current=3 loading=1 pending=7 name=DRUMS",
        {"kind": "kitstatus", "current": 3, "loading": True, "pending": 7, "name": "DRUMS"},
    ),
    (
        "KITSTATUS: current=-1 loading=0 pending=-1 name=-",
        {"kind": "kitstatus", "current": -1, "loading": False, "pending": -1, "name": None},
    ),
    # "APPS: " + "%s%s" joined by "," + " running=%s"
    (
        "APPS: Sampler,Sequencer,Settings running=Sampler",
        {"kind": "apps", "apps": ["Sampler", "Sequencer", "Settings"], "running": "Sampler"},
    ),
    ("APPS:  running=-", {"kind": "apps", "apps": [], "running": None}),
    # "KITS: " + "%s%d:%s" joined by "," + " current=%d"
    (
        "KITS: 0:Basic,1:Drums,2:Deep House current=2",
        {
            "kind": "kits",
            "kits": [
                {"id": 0, "name": "Basic"},
                {"id": 1, "name": "Drums"},
                {"id": 2, "name": "Deep House"},
            ],
            "current": 2,
        },
    ),
    ("KITS:  current=-1", {"kind": "kits", "kits": [], "current": -1}),
    # "PADSTATS: press=%u release=%u played=%u freeslots=%d"
    (
        "PADSTATS: press=181 release=181 played=181 freeslots=12",
        {"kind": "padstats", "press": 181, "release": 181, "played": 181, "freeslots": 12},
    ),
    # "PADNOTES:" + " %u:%u" x16
    (
        "PADNOTES: 0:36 1:37 2:38 3:39 4:40 5:41 6:42 7:43 8:44 9:45 10:46 11:47 12:48 13:49"
        " 14:50 15:51",
        {"kind": "padnotes", "notes": {i: 36 + i for i in range(16)}},
    ),
    # "LEDS: bri=%u anim=%d coalesce=%d cfgbri=%u pwr=0x%02X pwrN=%u txfail=%u colors="
    #   + "%02X%02X%02X" per pad, comma-separated
    (
        LEDS_LINE,
        {
            "kind": "leds",
            "brightness": 80,
            "anim": True,
            "coalesce": False,
            "cfgbri": 50,
            "pwr": 0x1F,
            "pwr_count": 3,
            "txfail": 0,
            "colors": ["FF0000", "00FF00", "0000FF"] + ["000000"] * 12 + ["FFFFFF"],
        },
    ),
    # "MEM: int_free=%u int_largest=%u int_min=%u int_blocks=%u psram_free=%u psram_largest=%u
    #  psram_blocks=%u"
    (
        "MEM: int_free=76544 int_largest=65536 int_min=18700 int_blocks=1201 "
        "psram_free=8123456 psram_largest=4194304 psram_blocks=300",
        {
            "kind": "mem",
            "int_free": 76544,
            "int_largest": 65536,
            "int_min": 18700,
            "int_blocks": 1201,
            "psram_free": 8123456,
            "psram_largest": 4194304,
            "psram_blocks": 300,
        },
    ),
    # "MEMBLK: biggest_used=%u" + " | <=%s u=%u/%uB f=%u/%uB" x8
    (
        MEMBLK_LINE,
        {
            "kind": "memblk",
            "biggest_used": 32768,
            "buckets": [
                {"le": "64", "used_n": 812, "used_b": 31240, "free_n": 40, "free_b": 1800},
                {"le": "128", "used_n": 210, "used_b": 19800, "free_n": 12, "free_b": 1100},
                {"le": "256", "used_n": 90, "used_b": 16000, "free_n": 3, "free_b": 600},
                {"le": "512", "used_n": 40, "used_b": 14000, "free_n": 2, "free_b": 900},
                {"le": "1k", "used_n": 20, "used_b": 15000, "free_n": 1, "free_b": 800},
                {"le": "2k", "used_n": 10, "used_b": 16000, "free_n": 0, "free_b": 0},
                {"le": "8k", "used_n": 6, "used_b": 30000, "free_n": 1, "free_b": 4096},
                {"le": "big", "used_n": 3, "used_b": 70000, "free_n": 1, "free_b": 18000},
            ],
        },
    ),
    # "MEMBIG:" + " @%08x=%u" per block >= 8 kB
    (
        "MEMBIG: @3fc9a000=32768 @3fcb2000=8196",
        {
            "kind": "membig",
            "blocks": [{"addr": 0x3FC9A000, "size": 32768}, {"addr": 0x3FCB2000, "size": 8196}],
        },
    ),
    ("MEMBIG:", {"kind": "membig", "blocks": []}),
    # "CDCSTATS: rx=%u cmds=%u drop=%u"
    (
        "CDCSTATS: rx=1200 cmds=1180 drop=20",
        {"kind": "cdcstats", "rx": 1200, "cmds": 1180, "drop": 20},
    ),
    # "BLE: supported=%d running=%d state=%s mode=%s self=%s peer=%s itvl=%u txoff=%d rxoff=%d
    #  tx_msg=%u tx_pkt=%u tx_drop=%u tx_err=%u rx_msg=%u rx_pkt=%u"
    (
        BLE_LINE,
        {
            "kind": "ble",
            "supported": 1,
            "running": 1,
            "state": "connected",
            "mode": "server",
            "self": "7c:df:a1:00:11:22",
            "peer": "a4:c1:38:aa:bb:cc",
            "itvl": 15,
            "txoff": 36,
            "rxoff": 0,
            "tx_msg": 181,
            "tx_pkt": 120,
            "tx_drop": 0,
            "tx_err": 0,
            "rx_msg": 4,
            "rx_pkt": 4,
        },
    ),
    (
        "BLE: supported=0 running=0 state=off mode=server self=- peer=- itvl=0 txoff=0 rxoff=0 "
        "tx_msg=0 tx_pkt=0 tx_drop=0 tx_err=0 rx_msg=0 rx_pkt=0",
        {
            "kind": "ble",
            "supported": 0,
            "running": 0,
            "state": "off",
            "mode": "server",
            "self": None,
            "peer": None,
            "itvl": 0,
            "txoff": 0,
            "rxoff": 0,
            "tx_msg": 0,
            "tx_pkt": 0,
            "tx_drop": 0,
            "tx_err": 0,
            "rx_msg": 0,
            "rx_pkt": 0,
        },
    ),
    # "BLEDEV: count=%u" + " | %s %s %d" (addr name rssi) — names may contain spaces
    (
        "BLEDEV: count=2 | a4:c1:38:aa:bb:cc Steve iPad Pro -61 | 11:22:33:44:55:66 CrossPad -80",
        {
            "kind": "bledev",
            "count": 2,
            "devices": [
                {"addr": "a4:c1:38:aa:bb:cc", "name": "Steve iPad Pro", "rssi": -61},
                {"addr": "11:22:33:44:55:66", "name": "CrossPad", "rssi": -80},
            ],
        },
    ),
    ("BLEDEV: count=0", {"kind": "bledev", "count": 0, "devices": []}),
    # "UI: display=%s touch=%s drawer=%d lcd=%d rgb=%d theme=%u bt_icon=%s app=%s"
    (
        "UI: display=yes touch=no drawer=1 lcd=80 rgb=50 theme=2 bt_icon=hidden app=-",
        {
            "kind": "ui",
            "display": "yes",
            "touch": "no",
            "drawer": 1,
            "lcd": 80,
            "rgb": 50,
            "theme": 2,
            "bt_icon": "hidden",
            "app": None,
        },
    ),
    (
        "UI: display=none touch=no drawer=0 lcd=-1 rgb=-1 theme=0 bt_icon=solid app=Sampler",
        {
            "kind": "ui",
            "display": "none",
            "touch": "no",
            "drawer": 0,
            "lcd": -1,
            "rgb": -1,
            "theme": 0,
            "bt_icon": "solid",
            "app": "Sampler",
        },
    ),
    # "ENC: group=%p launcher=%p owner=%s"
    (
        "ENC: group=0x3fca1234 launcher=0x3fca1234 owner=launcher",
        {"kind": "enc", "group": "0x3fca1234", "launcher": "0x3fca1234", "owner": "launcher"},
    ),
    (
        "ENC: group=0 launcher=0x3fca1234 owner=none",
        {"kind": "enc", "group": 0, "launcher": "0x3fca1234", "owner": "none"},
    ),
    # "ENCFOCUS: obj=%p idx=%d text=%s" — text may contain spaces or be empty
    (
        "ENCFOCUS: obj=0x3fcb0010 idx=4 text=Send transpose",
        {"kind": "encfocus", "index": 4, "label": "Send transpose", "ptr": "0x3fcb0010"},
    ),
    ("ENCFOCUS: obj=0 idx=-1 text=", {"kind": "encfocus", "index": -1, "label": "", "ptr": "0"}),
    # "ENCGROUP: count=%u" (head line only; the body is parse_enc_group's job)
    ("ENCGROUP: count=5", {"kind": "encgroup", "count": 5}),
    # "AUDIOLVL: L=%.5f R=%.5f amp=%d allowed=%d"
    (
        "AUDIOLVL: L=0.12345 R=0.00000 amp=1 allowed=1",
        {"kind": "audiolvl", "left": 0.12345, "right": 0.0, "amp": True, "allowed": True},
    ),
    # "SMPLPEAK: %d free=%d"
    ("SMPLPEAK: 18234 free=12", {"kind": "smplpeak", "peak": 18234, "free": 12}),
    ("SMPLPEAK: 0 free=-1", {"kind": "smplpeak", "peak": 0, "free": -1}),
    # "APPVER: %s id=%s commit=%s ref=%s dirty=%d" / "APPVER: end count=%u"
    (
        "APPVER: crosspad-sampler id=sampler commit=a1b2c3d ref=v1.4.0 dirty=1",
        {
            "kind": "appver",
            "component": "crosspad-sampler",
            "id": "sampler",
            "commit": "a1b2c3d",
            "ref": "v1.4.0",
            "dirty": True,
        },
    ),
    (
        "APPVER: crosspad-core id=- commit=9f8e7d6 ref=- dirty=0",
        {
            "kind": "appver",
            "component": "crosspad-core",
            "id": None,
            "commit": "9f8e7d6",
            "ref": None,
            "dirty": False,
        },
    ),
    ("APPVER: end count=4", {"kind": "appver", "end": True, "count": 4}),
    # "PADINFO: idx=%d num=%u kit=%s vol=%d pan=%d mode=%u dirty=%d count=%u"
    #   + " | [%u] '%s' %u..%u" per sample slot
    (
        PADINFO_LINE,
        {
            "kind": "padinfo",
            "idx": 3,
            "num": 39,
            "kit": "DRUMS",
            "vol": 100,
            "pan": 0,
            "mode": 1,
            "dirty": 0,
            "count": 2,
            "slots": [
                {"index": 0, "file": "kick.wav", "lo": 0, "hi": 127},
                {"index": 1, "file": "kick2.wav", "lo": 64, "hi": 127},
            ],
            "raw": PADINFO_LINE,
        },
    ),
    # bare acknowledgements
    ("OK", {"kind": "ok"}),
    ("OK\r\n", {"kind": "ok"}),
    ("ERR", {"kind": "err", "message": ""}),
    ("ERR bad kit id", {"kind": "err", "message": "bad kit id"}),
    ("ERR unknown app\r\n", {"kind": "err", "message": "unknown app"}),
    # prefixed error bodies
    ("ENCGROUP: ERR lock", {"kind": "err", "message": "ENCGROUP: ERR lock"}),
    ("ENCFOCUS: ERR lock", {"kind": "err", "message": "ENCFOCUS: ERR lock"}),
]


@pytest.mark.parametrize(("line", "expected"), CASES, ids=[c[0][:24] for c in CASES])
def test_parse_cdc_reply(line: str, expected: dict) -> None:
    assert parse_cdc_reply(line) == expected


@pytest.mark.parametrize(
    "line",
    [
        "",
        "   ",
        "KIT_LOAD 3",  # an echoed command, not a reply
        "I (1234) main: some log line",
        "lowercase: nope",
        "TOTALLYNEW: x=1",
    ],
)
def test_parse_cdc_reply_unknown_returns_none(line: str) -> None:
    assert parse_cdc_reply(line) is None


def test_trailing_crlf_is_tolerated_on_prefixed_replies() -> None:
    assert parse_cdc_reply("CDCSTATS: rx=1 cmds=1 drop=0\r\n") == {
        "kind": "cdcstats",
        "rx": 1,
        "cmds": 1,
        "drop": 0,
    }


def test_leds_short_color_list_is_not_padded() -> None:
    # A truncated reply (buffer cap) yields whatever colours arrived; callers check len().
    out = parse_cdc_reply(
        "LEDS: bri=1 anim=0 coalesce=0 cfgbri=1 pwr=0x00 pwrN=0 txfail=0 colors=FF0000,00FF00"
    )
    assert out is not None
    assert out["colors"] == ["FF0000", "00FF00"]
    assert out["pwr"] == 0


def test_kitstatus_name_with_spaces() -> None:
    out = parse_cdc_reply("KITSTATUS: current=2 loading=0 pending=-1 name=Deep House")
    assert out == {
        "kind": "kitstatus",
        "current": 2,
        "loading": False,
        "pending": -1,
        "name": "Deep House",
    }
```

- [ ] **Step 7: Run the CDC tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_parsers_cdc.py -q`
Expected: FAIL — every `test_parse_cdc_reply[...]` case with `assert None == {...}` (the stub returns
`None`); the `_unknown_returns_none` cases pass already.

- [ ] **Step 8: Implement parse_cdc_reply**

Replace the `parse_cdc_reply` stub in `/home/matixan/GIT/crosspad-hil/crosspad_hil/parsers.py` with
the following block (everything from `_INT_RE` down to the end of `parse_cdc_reply`; keep the
`parse_enc_group` stub below it for now):

```python
_INT_RE = re.compile(r"-?\d+$")
_PREFIX_RE = re.compile(r"^([A-Z]+):\s?(.*)$")
_KITSTATUS_RE = re.compile(r"current=(-?\d+)\s+loading=(\d+)\s+pending=(-?\d+)\s+name=(.*)$")
_APPS_RE = re.compile(r"^(.*?)\s*running=(\S*)$")
_KITS_RE = re.compile(r"^(.*?)\s*current=(-?\d+)$")
_BUCKET_RE = re.compile(r"<=(\S+)\s+u=(\d+)/(\d+)B\s+f=(\d+)/(\d+)B")
_MEMBIG_RE = re.compile(r"@([0-9a-fA-F]+)=(\d+)")
_ENCFOCUS_RE = re.compile(r"obj=(\S+)\s+idx=(-?\d+)\s+text=(.*)$")
_AUDIOLVL_RE = re.compile(r"L=(-?[\d.]+)\s+R=(-?[\d.]+)\s+amp=(\d)\s+allowed=(\d)")
_SMPLPEAK_RE = re.compile(r"(-?\d+)\s+free=(-?\d+)")  # hil_kit_churn parse_peak
_APPVER_RE = re.compile(r"^(\S+)\s+id=(\S+)\s+commit=(\S+)\s+ref=(\S+)\s+dirty=(\d)$")
_APPVER_END_RE = re.compile(r"^end count=(\d+)$")
_PADINFO_SLOT_RE = re.compile(r"\[(\d+)\]\s+'(.*)'\s+(\d+)\.\.(\d+)")


def _scalar(value: str) -> Any:
    """key=value scalar rule: decimal → int, "-" → None, else the string itself."""
    if _INT_RE.match(value):
        return int(value)
    if value == "-":
        return None
    return value


def _kv(body: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for tok in body.split():
        key, sep, value = tok.partition("=")
        if sep:
            out[key] = _scalar(value)
    return out


def _dash_none(value: str) -> str | None:
    return None if value == "-" else value


def _parse_kitstatus(body: str) -> dict | None:
    # "KITSTATUS: current=%d loading=%d pending=%d name=%s"
    m = _KITSTATUS_RE.search(body)
    if not m:
        return None
    return {
        "kind": "kitstatus",
        "current": int(m.group(1)),
        "loading": m.group(2) != "0",
        "pending": int(m.group(3)),
        "name": _dash_none(m.group(4).strip()),
    }


def _parse_apps(body: str) -> dict | None:
    # "APPS: " + names joined by "," + " running=%s"
    m = _APPS_RE.match(body)
    if not m:
        return None
    apps = [a for a in m.group(1).split(",") if a]
    return {"kind": "apps", "apps": apps, "running": _dash_none(m.group(2))}


def _parse_kits(body: str) -> dict | None:
    # "KITS: " + "%d:%s" joined by "," + " current=%d"   (hil_kit_churn.parse_kits)
    m = _KITS_RE.match(body)
    if not m:
        return None
    kits: list[dict[str, Any]] = []
    for item in m.group(1).split(","):
        if not item:
            continue
        kit_id, sep, name = item.partition(":")
        if not sep or not _INT_RE.match(kit_id):
            continue
        kits.append({"id": int(kit_id), "name": name})
    return {"kind": "kits", "kits": kits, "current": int(m.group(2))}


def _parse_padstats(body: str) -> dict:
    # "PADSTATS: press=%u release=%u played=%u freeslots=%d"
    return {"kind": "padstats", **_kv(body)}


def _parse_padnotes(body: str) -> dict:
    # "PADNOTES:" + " %u:%u" per pad
    notes: dict[int, int] = {}
    for tok in body.split():
        pad, sep, note = tok.partition(":")
        if sep and _INT_RE.match(pad) and _INT_RE.match(note):
            notes[int(pad)] = int(note)
    return {"kind": "padnotes", "notes": notes}


def _parse_leds(body: str) -> dict:
    # "LEDS: bri=%u anim=%d coalesce=%d cfgbri=%u pwr=0x%02X pwrN=%u txfail=%u colors=RRGGBB,…"
    raw: dict[str, str] = {}
    for tok in body.split():
        key, sep, value = tok.partition("=")
        if sep:
            raw[key] = value
    colors = [c for c in raw.get("colors", "").split(",") if c]
    return {
        "kind": "leds",
        "brightness": int(raw.get("bri", "0")),
        "anim": raw.get("anim", "0") != "0",
        "coalesce": raw.get("coalesce", "0") != "0",
        "cfgbri": int(raw.get("cfgbri", "0")),
        "pwr": int(raw.get("pwr", "0"), 16),
        "pwr_count": int(raw.get("pwrN", "0")),
        "txfail": int(raw.get("txfail", "0")),
        "colors": colors,
    }


def _parse_mem(body: str) -> dict:
    # "MEM: int_free=%u int_largest=%u int_min=%u int_blocks=%u psram_free=%u psram_largest=%u
    #  psram_blocks=%u"
    return {"kind": "mem", **_kv(body)}


def _parse_memblk(body: str) -> dict:
    # "MEMBLK: biggest_used=%u" + " | <=%s u=%u/%uB f=%u/%uB" per bucket
    parts = [p.strip() for p in body.split("|")]
    head = _kv(parts[0]) if parts else {}
    buckets: list[dict[str, Any]] = []
    for part in parts[1:]:
        m = _BUCKET_RE.search(part)
        if m:
            buckets.append(
                {
                    "le": m.group(1),
                    "used_n": int(m.group(2)),
                    "used_b": int(m.group(3)),
                    "free_n": int(m.group(4)),
                    "free_b": int(m.group(5)),
                }
            )
    return {"kind": "memblk", "biggest_used": int(head.get("biggest_used", 0)), "buckets": buckets}


def _parse_membig(body: str) -> dict:
    # "MEMBIG:" + " @%08x=%u" per block >= 8 kB
    blocks = [{"addr": int(a, 16), "size": int(s)} for a, s in _MEMBIG_RE.findall(body)]
    return {"kind": "membig", "blocks": blocks}


def _parse_cdcstats(body: str) -> dict:
    # "CDCSTATS: rx=%u cmds=%u drop=%u"
    return {"kind": "cdcstats", **_kv(body)}


def _parse_ble(body: str) -> dict:
    # "BLE: supported=%d running=%d state=%s mode=%s self=%s peer=%s itvl=%u txoff=%d rxoff=%d …"
    return {"kind": "ble", **_kv(body)}


def _parse_bledev(body: str) -> dict:
    # "BLEDEV: count=%u" + " | %s %s %d" (addr, name with spaces, rssi)
    parts = [p.strip() for p in body.split("|")]
    head = _kv(parts[0]) if parts else {}
    devices: list[dict[str, Any]] = []
    for part in parts[1:]:
        toks = part.split()
        if len(toks) < 2 or not _INT_RE.match(toks[-1]):
            continue
        devices.append({"addr": toks[0], "name": " ".join(toks[1:-1]), "rssi": int(toks[-1])})
    return {"kind": "bledev", "count": int(head.get("count", 0)), "devices": devices}


def _parse_ui(body: str) -> dict:
    # "UI: display=%s touch=%s drawer=%d lcd=%d rgb=%d theme=%u bt_icon=%s app=%s"
    return {"kind": "ui", **_kv(body)}


def _parse_enc(body: str) -> dict:
    # "ENC: group=%p launcher=%p owner=%s"
    return {"kind": "enc", **_kv(body)}


def _parse_encfocus(body: str) -> dict | None:
    # "ENCFOCUS: obj=%p idx=%d text=%s"
    m = _ENCFOCUS_RE.search(body)
    if not m:
        return None
    return {"kind": "encfocus", "index": int(m.group(2)), "label": m.group(3), "ptr": m.group(1)}


def _parse_encgroup_head(body: str) -> dict | None:
    # "ENCGROUP: count=%u" — the indexed lines that follow are parse_enc_group's job
    head = _kv(body)
    if "count" not in head:
        return None
    return {"kind": "encgroup", "count": int(head["count"])}


def _parse_audiolvl(body: str) -> dict | None:
    # "AUDIOLVL: L=%.5f R=%.5f amp=%d allowed=%d"
    m = _AUDIOLVL_RE.search(body)
    if not m:
        return None
    return {
        "kind": "audiolvl",
        "left": float(m.group(1)),
        "right": float(m.group(2)),
        "amp": m.group(3) != "0",
        "allowed": m.group(4) != "0",
    }


def _parse_smplpeak(body: str) -> dict | None:
    # "SMPLPEAK: %d free=%d"
    m = _SMPLPEAK_RE.search(body)
    if not m:
        return None
    return {"kind": "smplpeak", "peak": int(m.group(1)), "free": int(m.group(2))}


def _parse_appver(body: str) -> dict | None:
    # "APPVER: %s id=%s commit=%s ref=%s dirty=%d"  |  "APPVER: end count=%u"
    end = _APPVER_END_RE.match(body)
    if end:
        return {"kind": "appver", "end": True, "count": int(end.group(1))}
    m = _APPVER_RE.match(body)
    if not m:
        return None
    return {
        "kind": "appver",
        "component": m.group(1),
        "id": _dash_none(m.group(2)),
        "commit": m.group(3),
        "ref": _dash_none(m.group(4)),
        "dirty": m.group(5) != "0",
    }


def _parse_padinfo(body: str, line: str) -> dict:
    # "PADINFO: idx=%d num=%u kit=%s vol=%d pan=%d mode=%u dirty=%d count=%u"
    #   + " | [%u] '%s' %u..%u" per sample slot
    parts = [p.strip() for p in body.split("|")]
    out: dict[str, Any] = {"kind": "padinfo", **(_kv(parts[0]) if parts else {})}
    slots: list[dict[str, Any]] = []
    for part in parts[1:]:
        m = _PADINFO_SLOT_RE.search(part)
        if m:
            slots.append(
                {
                    "index": int(m.group(1)),
                    "file": m.group(2),
                    "lo": int(m.group(3)),
                    "hi": int(m.group(4)),
                }
            )
    out["slots"] = slots
    out["raw"] = line
    return out


def parse_cdc_reply(line: str) -> dict | None:
    """Decode one CDC reply line into a dict keyed by "kind"; None when it is not a known reply."""
    text = line.strip()
    if not text:
        return None
    if text == "OK":
        return {"kind": "ok"}
    if text == "ERR" or text.startswith("ERR "):
        return {"kind": "err", "message": text[3:].strip()}
    m = _PREFIX_RE.match(text)
    if not m:
        return None
    prefix, body = m.group(1), m.group(2).strip()
    if body == "ERR" or body.startswith("ERR "):
        return {"kind": "err", "message": text}
    if prefix == "KITSTATUS":
        return _parse_kitstatus(body)
    if prefix == "APPS":
        return _parse_apps(body)
    if prefix == "KITS":
        return _parse_kits(body)
    if prefix == "PADSTATS":
        return _parse_padstats(body)
    if prefix == "PADNOTES":
        return _parse_padnotes(body)
    if prefix == "LEDS":
        return _parse_leds(body)
    if prefix == "MEM":
        return _parse_mem(body)
    if prefix == "MEMBLK":
        return _parse_memblk(body)
    if prefix == "MEMBIG":
        return _parse_membig(body)
    if prefix == "CDCSTATS":
        return _parse_cdcstats(body)
    if prefix == "BLE":
        return _parse_ble(body)
    if prefix == "BLEDEV":
        return _parse_bledev(body)
    if prefix == "UI":
        return _parse_ui(body)
    if prefix == "ENC":
        return _parse_enc(body)
    if prefix == "ENCFOCUS":
        return _parse_encfocus(body)
    if prefix == "ENCGROUP":
        return _parse_encgroup_head(body)
    if prefix == "AUDIOLVL":
        return _parse_audiolvl(body)
    if prefix == "SMPLPEAK":
        return _parse_smplpeak(body)
    if prefix == "APPVER":
        return _parse_appver(body)
    if prefix == "PADINFO":
        return _parse_padinfo(body, text)
    return None
```

- [ ] **Step 9: Run the CDC tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_parsers_cdc.py -q && ruff check crosspad_hil/parsers.py tests/test_parsers_cdc.py`
Expected: `48 passed` (39 reply cases + 6 unknown cases + 3 plain tests), ruff `All checks passed!`
(every sample line is ≤ 100 columns or split with implicit string concatenation — the bytes are
still identical to the firmware format).

- [ ] **Step 10: Commit the CDC reply parser**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/parsers.py tests/test_parsers_cdc.py
git commit -m "feat(parsers): parse_cdc_reply for every hil_control.cpp reply prefix"
```

- [ ] **Step 11: Write the failing ENC_GROUP tests**

`/home/matixan/GIT/crosspad-hil/tests/test_parsers_enc.py`:

```python
"""parse_enc_group: the multi-line ENC_GROUP dump → [{ref, index, ptr, label}]."""
from __future__ import annotations

import pytest

from crosspad_hil.parsers import parse_enc_group

# hil_control.cpp handle_enc_group:
#   "ENCGROUP: count=%u"            then per object
#   "  [%u] %p %s"                  (index, pointer, widget_label — may be "" or contain spaces)
SETTINGS_DUMP = [
    "ENCGROUP: count=5",
    "  [0] 0x3fcb0010 Display",
    "  [1] 0x3fcb0120 Audio",
    "  [2] 0x3fcb0230 BLE MIDI",
    "  [3] 0x3fcb0340 Send transpose",
    "  [4] 0x3fcb0450 ",
]


def test_settings_dump() -> None:
    assert parse_enc_group(SETTINGS_DUMP) == [
        {"ref": "e0", "index": 0, "ptr": "0x3fcb0010", "label": "Display"},
        {"ref": "e1", "index": 1, "ptr": "0x3fcb0120", "label": "Audio"},
        {"ref": "e2", "index": 2, "ptr": "0x3fcb0230", "label": "BLE MIDI"},
        {"ref": "e3", "index": 3, "ptr": "0x3fcb0340", "label": "Send transpose"},
        {"ref": "e4", "index": 4, "ptr": "0x3fcb0450", "label": ""},
    ]


def test_crlf_and_no_trailing_space_tolerated() -> None:
    lines = ["ENCGROUP: count=2\r\n", "  [0] 0x3fcb0010 Display\r\n", "  [1] 0x3fcb0120\r\n"]
    assert parse_enc_group(lines) == [
        {"ref": "e0", "index": 0, "ptr": "0x3fcb0010", "label": "Display"},
        {"ref": "e1", "index": 1, "ptr": "0x3fcb0120", "label": ""},
    ]


def test_empty_group() -> None:
    assert parse_enc_group(["ENCGROUP: count=0"]) == []


@pytest.mark.parametrize("lines", [[], ["ENCGROUP: ERR lock"], ["OK"], ["garbage"]])
def test_no_entries(lines: list[str]) -> None:
    assert parse_enc_group(lines) == []


def test_head_line_is_optional_and_noise_is_skipped() -> None:
    lines = [
        "I (1) hil_control: unrelated",
        "  [0] 0x3fcb0010 Sampler",
        "OK",
        "  [1] 0x3fcb0120 Sequencer",
    ]
    assert parse_enc_group(lines) == [
        {"ref": "e0", "index": 0, "ptr": "0x3fcb0010", "label": "Sampler"},
        {"ref": "e1", "index": 1, "ptr": "0x3fcb0120", "label": "Sequencer"},
    ]


def test_index_comes_from_the_firmware_not_position() -> None:
    # If a line was lost in transit the remaining indices must still be the device's own.
    lines = ["ENCGROUP: count=3", "  [0] 0x1 A", "  [2] 0x3 C"]
    out = parse_enc_group(lines)
    assert [e["index"] for e in out] == [0, 2]
    assert [e["ref"] for e in out] == ["e0", "e2"]


def test_label_with_brackets_and_multiple_spaces() -> None:
    lines = ["  [7] 0x3fcb0999 Vol  [dB]  -6"]
    assert parse_enc_group(lines) == [
        {"ref": "e7", "index": 7, "ptr": "0x3fcb0999", "label": "Vol  [dB]  -6"}
    ]
```

- [ ] **Step 12: Run the ENC tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_parsers_enc.py -q`
Expected: FAIL — `test_settings_dump`, `test_crlf_and_no_trailing_space_tolerated`,
`test_head_line_is_optional_and_noise_is_skipped`, `test_index_comes_from_the_firmware_not_position`
and `test_label_with_brackets_and_multiple_spaces` fail with `assert [] == [{...}]`; the empty-group
and no-entry cases pass against the stub.

- [ ] **Step 13: Implement parse_enc_group**

Replace the `parse_enc_group` stub at the bottom of
`/home/matixan/GIT/crosspad-hil/crosspad_hil/parsers.py` with:

```python
# "  [%u] %p %s" — the label is everything after the pointer and one separating space; it may be
# empty (widget_label returns "" for an object with no caption) or contain spaces and brackets.
_ENC_ENTRY_RE = re.compile(r"^\s*\[(\d+)\]\s+(\S+)(?: (.*))?$")


def parse_enc_group(lines: list[str]) -> list[dict]:
    """Decode an ENC_GROUP dump: head line optional, ERR/noise skipped, index is the device's."""
    entries: list[dict] = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        m = _ENC_ENTRY_RE.match(line)
        if not m:
            continue
        index = int(m.group(1))
        label = m.group(3) if m.group(3) is not None else ""
        entries.append({"ref": f"e{index}", "index": index, "ptr": m.group(2), "label": label})
    return entries
```

- [ ] **Step 14: Run the whole parsers suite and lint**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_parsers_console.py tests/test_parsers_cdc.py tests/test_parsers_enc.py -q && ruff check crosspad_hil/parsers.py tests/test_parsers_console.py tests/test_parsers_cdc.py tests/test_parsers_enc.py`
Expected: `85 passed` (27 + 48 + 10) and ruff `All checks passed!`.

- [ ] **Step 15: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/parsers.py tests/test_parsers_enc.py
git commit -m "feat(parsers): parse_enc_group for the ENC_GROUP multi-line dump"
```

**End state of Task 5:** `crosspad_hil/parsers.py` exports `ConsoleEvent`, `ConsoleParser`,
`parse_cdc_reply`, `parse_enc_group` exactly as the contract names them; `console.py` (Task 6)
builds on `ConsoleParser.feed/snapshot/reset_boot_tracking`, `cdc.py` (Task 7) calls
`parse_cdc_reply(line)` to fill `Reply.parsed`, and `verbs.py` (Task 8) calls `parse_enc_group` on
the lines returned by `CdcLink.transact_multi("ENC_GROUP", "ENCGROUP:")`.
# Plan A — chunk A4: console and CDC sessions (Tasks 6–7)

Repo: `/home/matixan/GIT/crosspad-hil`. Package `crosspad_hil`. All commands below run from that
directory with the venv active (`. .venv/bin/activate`). Python ≥ 3.10, pytest, ruff (line length
100). No test touches hardware: every session object takes `serial_factory` and the tests hand it a
`tests.fakes.FakeSerial`; port locks go to `tmp_path` through `XDG_RUNTIME_DIR` (same trick as
`tests/test_verbs.py` in chunk A5).

Origins ported (each regex, byte sequence and timing constant is cited in a code comment):

- `/home/matixan/GIT/platform-idf/tools/hil_kit_churn.py` — `class Console` (reader thread,
  `read(512)` + split on `\n`, log opened `"a", buffering=1, encoding="utf-8", errors="replace"`),
  `class Cdc` (reader thread owns the port, prefix waiters registered **before** the write, write
  lock held only for `write()`, `time.sleep(0.4)` + `reset_input_buffer()` after open, fire-and-forget
  `send()`), the "`OK` is not your ack" rule.
- `/home/matixan/GIT/platform-idf/tools/hil_smoke.py` — `reset_pulse` (via `serial_open`),
  `capture_boot` (3 s settle after the last required marker), `evaluate` boot-loop rule.
- `/home/matixan/GIT/platform-idf/tools/hil_stability.py` — `BOOT_WINDOW_S = 45`, the context
  dump idea (here: 20 lines ending at the hit).
- `/home/matixan/GIT/platform-idf/main/hil_control.cpp` and `main/main.cpp`
  `cdc_dispatch_one()` — an unhandled command is **echoed back verbatim** (that is the only signal
  for an unknown verb); `CDC_STATS` → `CDCSTATS: rx=%u cmds=%u drop=%u`; `ENC_GROUP` →
  `ENCGROUP: count=%u` + `  [%u] %p %s` lines; `APP_VERSIONS` ends with `APPVER: end count=%u`;
  `MEM_BLOCKS` is `MEMBLK:` then `MEMBIG:`.

Both tasks consume, from earlier Plan A tasks: `crosspad_hil.errors` (Task 1),
`crosspad_hil.knowledge.load` (Task 2), `crosspad_hil.serial_open.open_serial/reset_pulse` and
`crosspad_hil.locks.PortLock` (Task 3), `crosspad_hil.parsers` (Task 5), `tests.fakes.FakeSerial`
(Task 1).

Decisions where the contract is silent (stated once here; later chunks may rely on them):

| Topic | Decision |
|---|---|
| Sequence numbers | The first line ingested gets `seq == 1`; `Console.seq` is `0` before any line. |
| `read(since_seq)` | Returns lines with `seq >= since_seq` (so passing back `ReadResult.next_seq` continues without gaps). `since_seq=None` → from the oldest line still in the ring. `ReadResult.lines_lost` = how many lines of the requested range `[since_seq, …)` were already evicted from the ring (`0` when `since_seq` is `None`). `ReadResult.next_seq` = last returned seq + 1, or `since_seq` (resp. `seq + 1`) when nothing was returned. |
| `events(since_seq)` | Returns events with `seq > since_seq` ("everything after that line"), matching how chunk B2 walks them (`event_seq = max(event_seq, ev.seq)`). Event ring is bounded at 10 000. |
| `snapshot()["lines_lost"]` | Cumulative count of lines evicted from the ring since `open()`. |
| `expect()` scanning window | Only lines that arrive **after** the call (`seq > Console.seq` at call time). An extra keyword-only `since_seq: int | None = None` (an addition to the contract signature, defaults keep every contract call shape valid) lets a caller include lines that arrived between its command and the call. Reject patterns are checked before hit patterns on each line. `ExpectResult.hit`/`rejected` carry the **pattern source string** that matched; `seq` is the matching line's seq. |
| `ExpectResult.context` | The 20 lines ending at the matching line (hit inclusive) — the lines leading up to a fatal are what a person wants, and lines after the hit may not exist yet. On timeout: the last 20 lines in the ring. |
| `open(reset=True)` | `open()` calls `serial_factory(port, timeout=0.2)` (never `reset=`), starts the reader, then calls `self.reset()` — so a reset is always the `reset_pulse` sequence on the object the factory returned, whatever the factory is. |
| `wait_boot()` | `timeout_s=None` → `knowledge["boot_timeout_s"]` (45, hil_stability `BOOT_WINDOW_S`). Returns once the parser reports `boot_complete` and `settle_s` more seconds have elapsed (late errors), or at the deadline. It does **not** return early on a fatal (a panic is followed by a reboot that may complete; the caller judges `fatal`). `fatal`/`errors` are the parser entries recorded since the last `reset()` (or since `open()`); `bootloops` is the parser's value. |
| `on_event` exceptions | Caught, written to stderr as `console: on_event raised …`; the reader thread never dies because of a callback. Callbacks run outside the console lock. |
| CDC `send()` terminator | `cmd + "\n"` (contract). The firmware terminates on `\n` or `\r`. |
| `CdcLink` knowledge | `knowledge=None` → `load("cdc")`. `transact(expect=None)` for a verb absent from `cdc.yaml` raises `HilError(UNKNOWN_VERB)` **before sending** (hint: pass `expect=`). `reply: multi` → the first-line `prefix`. `reply: null` (USB_AUDIO, USB_DEFAULT, BOOTLOADER_REQUEST) → fire-and-forget, returns `Reply(line="", parsed=None, rtt_ms=0.0, extra_lines=[])`. |
| `transact()` on `ERR …` | Returns the `Reply` (`parsed == {"kind": "err", …}`); it never raises for a device `ERR` — the typed verbs (Task 8) decide the error code. |
| `Reply.extra_lines` | Lines that arrived between the send and the reply that **no waiter claimed** (interleaved traffic such as pad `OK`s) — the "OK is not your ack" evidence, kept per reply. |
| `transact_multi()` filtering | With `end` given, only lines starting with `expect` or `end` are collected (the `end` line included); with `end=None` every line from the first `expect` line until `idle_ms` of silence is collected. Reader-side lines are `.strip()`ped, so `"  [0] 0x… Back"` arrives as `"[0] 0x… Back"` (`parse_enc_group` tolerates both). |
| `unmatched()` | Returns a copy of the bounded (200) deque of lines no waiter claimed; it does not clear. Echoes of `send()`-only commands land there too. |
| `burst()` | `CDC_STATS` before, then each command at `t0 + i / rate_hz` (sleep only when ahead of schedule), then `BURST_SETTLE_S = 0.2` s so the prio-1 main loop drains `app_queue`, then `CDC_STATS` again. `dropped = max(0, after − before)`. `rate_hz <= 0` → `BAD_ARGS`. |
| Timing constants as module globals | `console.READ_CHUNK = 512`, `cdc.OPEN_SETTLE_S = 0.4`, `cdc.READ_CHUNK = 512`, `cdc.BURST_SETTLE_S = 0.2`, `cdc.UNMATCHED_RING = 200` — tests monkeypatch the sleeps to keep the suite fast; no constructor argument is added for them. |

---

### Task 6: Console session (`console.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/console.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_console.py`

**Interfaces:**
- Consumes:
  - `crosspad_hil.serial_open.open_serial(path, *, baud=115200, timeout=0.2, reset=False, serial_cls=serial.Serial)` and `reset_pulse(ser)` (Task 3).
  - `crosspad_hil.locks.PortLock(port, purpose, lock_dir=None)` with `acquire()` / `release()` (Task 3); default lock dir `$XDG_RUNTIME_DIR/crosspad-hil`.
  - `crosspad_hil.parsers.ConsoleParser(knowledge=None, required=None)` with `feed(seq, line) -> list[ConsoleEvent]`, `reset_boot_tracking()`, `snapshot() -> dict` (keys `fatals, reboots, reset_reasons, errors, markers_seen, boot_complete, missing_markers, bootloops, heap, kit_requests, cdc_drops`) and `ConsoleEvent(kind, seq, line, data)` (Task 5).
  - `crosspad_hil.knowledge.load("markers") -> dict` (Task 2) — only when `knowledge=None`.
  - `tests.fakes.FakeSerial` (Task 1): `feed(lines)`, `read(n)`, `control_history`, `written`.
- Produces (verbatim from the contract, plus the one stated addition):
  ```python
  @dataclass
  class ReadResult: lines: list[tuple[int, str]]; next_seq: int; lines_lost: int
  @dataclass
  class ExpectResult: hit: str | None; rejected: str | None; seq: int | None; context: list[str]; elapsed_s: float
  @dataclass
  class BootResult: complete: bool; missing: list[str]; fatal: list[dict]; errors: list[dict]; bootloops: int; seconds: float
  class Console:
      def __init__(self, port: str, *, log_path: Path | None = None, ring_size: int = 50_000,
                   knowledge: dict | None = None, required: list[str] | None = None,
                   serial_factory: Callable = open_serial,
                   on_event: Callable[[ConsoleEvent], None] | None = None) -> None
      def open(self, reset: bool = False) -> None
      def close(self) -> None
      def read(self, since_seq: int | None = None, wait_ms: int = 0, match: str | None = None,
               limit: int = 2000) -> ReadResult
      def expect(self, patterns: list[str], reject: list[str] = (), timeout_s: float = 30.0,
                 *, since_seq: int | None = None) -> ExpectResult
      def reset(self) -> None
      def wait_boot(self, timeout_s: float | None = None, settle_s: float = 3.0) -> BootResult
      def snapshot(self) -> dict
      def events(self, since_seq: int = 0) -> list[ConsoleEvent]
      seq: int   # property, last assigned (0 before any line)
      port: str; log_path: Path | None   # public attributes
  ```
  Module constants: `READ_CHUNK = 512`, `EVENT_RING = 10_000`, `CONTEXT_LINES = 20`.

- [ ] **Step 1: Write the failing tests**

`/home/matixan/GIT/crosspad-hil/tests/test_console.py`:

```python
"""Console: STM VCP tail with a ring buffer, parser events, expect and boot detection.

Every hygiene invariant from spec §2.4 that concerns the console is a test here:
opening never asserts DTR/RTS, and the only reset is Console.reset().
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from crosspad_hil import console as console_mod
from crosspad_hil.console import BootResult, Console, ExpectResult, ReadResult
from crosspad_hil.parsers import ConsoleEvent
from crosspad_hil.serial_open import open_serial
from tests.fakes import FakeSerial

# Same shape as knowledge/markers.yaml (contract §knowledge), inline so this file does not
# depend on the YAML being finished.
MARKERS: dict = {
    "boot_markers": ["ESP-ROM:", "main_task: Started on CPU0"],
    "required": [
        "Platform fully initialized",
        "STM32 ident:",
        "Crosspad initialization complete",
        "All systems operational",
        "LVGL setup done successfully",
        "App registry initialized",
        "LoadMainScreen completed successfully",
    ],
    "required_stability": [
        "Platform fully initialized",
        "Crosspad initialization complete",
        "All systems operational",
        "LVGL setup done successfully",
        "App registry initialized",
        "LoadMainScreen completed successfully",
    ],
    "optional": ["SD Card mounted successfully", "ES8388 [1] started", "DRV2605 found"],
    "error_line": r"^E \(\d+\)",
    "error_allow": ["file not found"],
    "fatal_patterns": [
        r"Guru Meditation",
        r"abort\(\) was called",
        r"assert failed",
        r"CORRUPT HEAP",
        r"Stack smashing",
        r"Task watchdog",
        r"Interrupt wdt timeout",
        r"LoadProhibited",
        r"StoreProhibited",
        r"InstrFetchProhibited",
        r"IllegalInstruction",
        r"Stack canary watchpoint",
        r"task_wdt",
        r"rst:0x[0-9a-f]+ \(([A-Z_]*(PANIC|WDT|BROWNOUT))",
    ],
    "reset_reason": r"rst:(0x[0-9a-fA-F]+)\s*\(([^)]+)\)",
    "heap_block": {
        "start": "Heap Statistics",
        "line": r"PerfMon:\s+Free:\s+(\d+) bytes",
        "end": "Total tasks:",
    },
    "kit_request": r"hil_control: KIT_LOAD (\d+) (queued|started)",
    "cdc_drops": r"CDC: (\d+) commands dropped",
    "reboot": "ESP-ROM:esp32s3",
    "boot_timeout_s": 45,
}

BANNER = "ESP-ROM:esp32s3-20210327"
BOOT_OK: list[str] = [
    BANNER,
    "Build:Mar 27 2021",
    "rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)",
    "I (312) main_task: Started on CPU0",
    "I (900) CrosspadPlatform: Platform fully initialized",
    "I (950) main: STM32 ident: 0x42 fw=2.0",
    "I (1200) main: Crosspad initialization complete",
    "I (1210) main: All systems operational",
    "E (1300) audio: file not found: /littlefs/STARTUP.wav",
    "I (1500) display: LVGL setup done successfully",
    "I (1600) gui: App registry initialized",
    "I (1800) gui: LoadMainScreen completed successfully",
]


def wait_until(pred: Callable[[], bool], timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.005)
    return pred()


@pytest.fixture
def make_console(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Callable[..., tuple[Console, FakeSerial]]:
    """Open a Console on a FakeSerial. Locks go to tmp_path; every console is closed."""
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    opened: list[Console] = []

    def _make(
        lines: list[str] | None = None, *, reset: bool = False, **kw: Any
    ) -> tuple[Console, FakeSerial]:
        fake = FakeSerial([], timeout=0.01)
        if lines:
            fake.feed(lines)
        con = Console(
            "/dev/fake-console",
            knowledge=MARKERS,
            serial_factory=lambda path, **_kw: fake,
            **kw,
        )
        con.open(reset=reset)
        opened.append(con)
        return con, fake

    yield _make
    for con in opened:
        con.close()


# ── hygiene ─────────────────────────────────────────────────────────────────
def test_open_never_asserts_dtr_or_rts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Through the real open_serial: only deassertions happen on open."""
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    fake = FakeSerial([], timeout=0.01)
    con = Console(
        "/dev/fake-console",
        knowledge=MARKERS,
        serial_factory=lambda path, **kw: open_serial(path, serial_cls=lambda: fake, **kw),
    )
    con.open()
    try:
        assert fake.is_open
        assert fake.control_history, "open_serial must deassert DTR/RTS explicitly"
        assert all(value is False for _name, value in fake.control_history)
    finally:
        con.close()


def test_reset_only_via_reset(make_console: Callable[..., Any]) -> None:
    con, fake = make_console()
    assert ("rts", True) not in fake.control_history
    con.reset()
    # from hil_smoke.py reset_pulse: dtr False, rts True, 0.1 s, rts False
    assert fake.control_history[-3:] == [("dtr", False), ("rts", True), ("rts", False)]
    assert fake.rts is False and fake.dtr is False
    assert sum(1 for name, value in fake.control_history if name == "rts" and value) == 1


def test_open_with_reset_pulses_exactly_once(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(reset=True)
    assert sum(1 for name, value in fake.control_history if name == "rts" and value) == 1
    assert fake.rts is False


def test_open_takes_port_lock(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from crosspad_hil.errors import PORT_BUSY, HilError
    from crosspad_hil.locks import PortLock

    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    fake = FakeSerial([], timeout=0.01)
    con = Console("/dev/fake-console", knowledge=MARKERS, serial_factory=lambda p, **kw: fake)
    con.open()
    try:
        holders = PortLock.holders()
        assert [(h["port"], h["purpose"]) for h in holders] == [("/dev/fake-console", "console")]
        with pytest.raises(HilError) as ei:
            PortLock("/dev/fake-console", "cdc").acquire()
        assert ei.value.code == PORT_BUSY
    finally:
        con.close()
    assert PortLock.holders() == []


# ── ring, seq, read ─────────────────────────────────────────────────────────
def test_lines_are_numbered_from_one_and_crlf_stripped(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(["first", "second"])
    assert wait_until(lambda: con.seq == 2)
    res = con.read()
    assert isinstance(res, ReadResult)
    assert res.lines == [(1, "first"), (2, "second")]
    assert res.next_seq == 3
    assert res.lines_lost == 0


def test_ring_wrap_counts_lines_lost(make_console: Callable[..., Any]) -> None:
    con, fake = make_console([f"line {i}" for i in range(1, 9)], ring_size=5)
    assert wait_until(lambda: con.seq == 8)
    res = con.read()
    assert [s for s, _ in res.lines] == [4, 5, 6, 7, 8]
    assert res.lines_lost == 0  # since_seq None: "from the oldest kept line"
    res = con.read(since_seq=1)
    assert [s for s, _ in res.lines] == [4, 5, 6, 7, 8]
    assert res.lines_lost == 3  # seqs 1..3 were evicted
    assert con.snapshot()["lines_lost"] == 3


def test_read_since_seq_limit_and_match(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(["I (1) a", "W (2) b", "I (3) c", "I (4) d"])
    assert wait_until(lambda: con.seq == 4)
    res = con.read(since_seq=2, limit=2)
    assert res.lines == [(2, "W (2) b"), (3, "I (3) c")]
    assert res.next_seq == 4
    res = con.read(match=r"^I \(")
    assert [line for _, line in res.lines] == ["I (1) a", "I (3) c", "I (4) d"]
    res = con.read(since_seq=99)
    assert res.lines == [] and res.next_seq == 99 and res.lines_lost == 0


def test_read_wait_ms_blocks_until_a_line_arrives(make_console: Callable[..., Any]) -> None:
    con, fake = make_console()
    threading.Timer(0.05, lambda: fake.feed(["late"])).start()
    t0 = time.monotonic()
    res = con.read(wait_ms=2000)
    assert res.lines == [(1, "late")]
    assert time.monotonic() - t0 < 1.5


def test_read_wait_ms_returns_empty_on_timeout(make_console: Callable[..., Any]) -> None:
    con, _ = make_console()
    t0 = time.monotonic()
    res = con.read(wait_ms=50)
    assert res.lines == [] and res.next_seq == 1
    assert 0.04 <= time.monotonic() - t0 < 1.0


def test_log_file_receives_every_line(make_console: Callable[..., Any], tmp_path: Path) -> None:
    log = tmp_path / "logs" / "console.log"
    con, fake = make_console(["alpha", "beta"], log_path=log)
    assert wait_until(lambda: con.seq == 2)
    con.close()
    assert log.read_text(encoding="utf-8") == "alpha\nbeta\n"
    assert con.snapshot()["log_path"] == str(log)


# ── expect ──────────────────────────────────────────────────────────────────
def test_expect_hit_on_new_lines_only(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(["I (1) Platform fully initialized"])
    assert wait_until(lambda: con.seq == 1)
    # Default window: lines after the call. The marker is already in the ring → no hit.
    miss = con.expect(["Platform fully initialized"], timeout_s=0.1)
    assert miss.hit is None and miss.rejected is None and miss.seq is None
    # since_seq=0 widens the window to the whole ring.
    hit = con.expect(["Platform fully initialized"], timeout_s=0.1, since_seq=0)
    assert isinstance(hit, ExpectResult)
    assert hit.hit == "Platform fully initialized" and hit.seq == 1
    # A line that arrives after the call is seen without since_seq.
    threading.Timer(0.05, lambda: fake.feed(["I (2) LoadMainScreen completed"])).start()
    hit = con.expect([r"LoadMainScreen \w+"], timeout_s=2.0)
    assert hit.hit == r"LoadMainScreen \w+" and hit.seq == 2
    assert hit.context[-1] == "I (2) LoadMainScreen completed"
    assert 0.0 <= hit.elapsed_s < 2.0


def test_expect_reject_wins_and_reports_pattern(make_console: Callable[..., Any]) -> None:
    con, fake = make_console()
    threading.Timer(
        0.02, lambda: fake.feed(["I (1) booting", "Guru Meditation Error: Core 0 panic'ed",
                                  "I (9) LoadMainScreen completed successfully"])
    ).start()
    res = con.expect(["LoadMainScreen"], reject=["Guru Meditation", "abort\\(\\)"], timeout_s=2.0)
    assert res.hit is None
    assert res.rejected == "Guru Meditation"
    assert res.seq == 2
    assert res.context == ["I (1) booting", "Guru Meditation Error: Core 0 panic'ed"]


def test_expect_context_is_twenty_lines_ending_at_hit(make_console: Callable[..., Any]) -> None:
    con, fake = make_console([f"line {i}" for i in range(1, 31)])
    assert wait_until(lambda: con.seq == 30)
    res = con.expect([r"^line 25$"], since_seq=0, timeout_s=0.5)
    assert res.seq == 25
    assert len(res.context) == 20
    assert res.context[0] == "line 6" and res.context[-1] == "line 25"


def test_expect_timeout_returns_tail_context(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(["a", "b"])
    assert wait_until(lambda: con.seq == 2)
    res = con.expect(["never"], timeout_s=0.05)
    assert res.hit is None and res.rejected is None and res.seq is None
    assert res.context == ["a", "b"]
    assert res.elapsed_s >= 0.05


# ── wait_boot ───────────────────────────────────────────────────────────────
def test_wait_boot_complete(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(BOOT_OK)
    t0 = time.monotonic()
    boot = con.wait_boot(timeout_s=5.0, settle_s=0.05)
    assert isinstance(boot, BootResult)
    assert boot.complete is True
    assert boot.missing == []
    assert boot.fatal == []
    assert boot.errors == []  # "file not found" is allow-listed (hil_smoke ERROR_ALLOWLIST)
    assert boot.bootloops == 0
    assert 0.05 <= boot.seconds <= time.monotonic() - t0 + 0.01
    assert boot.seconds < 2.0  # returned at completion + settle, not at the deadline


def test_wait_boot_missing_markers_at_timeout(make_console: Callable[..., Any]) -> None:
    partial = [line for line in BOOT_OK if "LoadMainScreen" not in line and "STM32 ident" not in line]
    con, fake = make_console(partial)
    boot = con.wait_boot(timeout_s=0.3, settle_s=0.05)
    assert boot.complete is False
    assert boot.missing == ["STM32 ident:", "LoadMainScreen completed successfully"]
    assert boot.seconds >= 0.3


def test_wait_boot_reports_fatal_and_error_lines(make_console: Callable[..., Any]) -> None:
    lines = list(BOOT_OK)
    lines.insert(4, "E (500) sd: mount failed")
    lines.insert(5, "Guru Meditation Error: Core  1 panic'ed (LoadProhibited)")
    con, fake = make_console(lines)
    boot = con.wait_boot(timeout_s=5.0, settle_s=0.05)
    assert boot.complete is True
    assert [f["line"] for f in boot.fatal] == [
        "Guru Meditation Error: Core  1 panic'ed (LoadProhibited)"
    ]
    assert boot.fatal[0]["pattern"] == "Guru Meditation"
    assert boot.fatal[0]["seq"] == 6
    assert [e["line"] for e in boot.errors] == ["E (500) sd: mount failed"]


def test_wait_boot_counts_bootloops(make_console: Callable[..., Any]) -> None:
    # Banner twice = the board started booting twice (hil_smoke evaluate: max(count) - 1).
    lines = [BANNER, "I (312) main_task: Started on CPU0", BANNER] + BOOT_OK[1:]
    con, fake = make_console(lines)
    boot = con.wait_boot(timeout_s=5.0, settle_s=0.05)
    assert boot.complete is True
    assert boot.bootloops == 1


def test_wait_boot_default_timeout_from_knowledge(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(BOOT_OK, knowledge={**MARKERS, "boot_timeout_s": 0.2})
    boot = con.wait_boot(settle_s=0.01)
    assert boot.complete is True


def test_reset_clears_boot_tracking_and_fatal_baseline(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(BOOT_OK + ["Guru Meditation Error: Core 0 panic'ed"])
    assert wait_until(lambda: con.seq == len(BOOT_OK) + 1)
    assert con.snapshot()["boot_complete"] is True
    con.reset()
    snap = con.snapshot()
    assert snap["boot_complete"] is False
    assert snap["missing_markers"] == MARKERS["required"]
    fake.feed(BOOT_OK)
    boot = con.wait_boot(timeout_s=5.0, settle_s=0.05)
    assert boot.complete is True
    assert boot.fatal == []  # the pre-reset fatal is not this boot's


# ── events ──────────────────────────────────────────────────────────────────
def test_events_emitted_to_callback_and_ring(make_console: Callable[..., Any]) -> None:
    seen: list[ConsoleEvent] = []
    con, fake = make_console(BOOT_OK, on_event=seen.append)
    assert wait_until(lambda: any(e.kind == "boot_complete" for e in seen))
    kinds = [e.kind for e in seen]
    assert "reboot" in kinds
    assert "reset_reason" in kinds
    assert kinds.count("boot_marker") == len(MARKERS["required"])
    assert kinds[-1] == "boot_complete"
    assert seen[-1].data == {"missing": []}
    assert seen[-1].seq == len(BOOT_OK)
    assert con.events(since_seq=0) == seen
    assert con.events(since_seq=seen[-1].seq) == []
    assert con.events(since_seq=seen[-1].seq - 1) == [seen[-1]]


def test_on_event_exception_does_not_kill_reader(
    make_console: Callable[..., Any], capsys: pytest.CaptureFixture[str]
) -> None:
    def boom(ev: ConsoleEvent) -> None:
        raise RuntimeError("callback bug")

    con, fake = make_console([BANNER, "after"], on_event=boom)
    assert wait_until(lambda: con.seq == 2)
    assert con.read().lines[-1] == (2, "after")
    assert "on_event raised" in capsys.readouterr().err


def test_snapshot_merges_parser_and_session_fields(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(BOOT_OK + ["CDC: 4 commands dropped"])
    assert wait_until(lambda: con.seq == len(BOOT_OK) + 1)
    snap = con.snapshot()
    assert snap["seq"] == len(BOOT_OK) + 1
    assert snap["lines_lost"] == 0
    assert snap["port"] == "/dev/fake-console"
    assert snap["log_path"] is None
    assert snap["reboots"] == 1
    assert snap["reset_reasons"] == ["0x1 (POWERON)"]
    assert snap["cdc_drops"] == 4
    assert snap["boot_complete"] is True


def test_close_is_idempotent_and_stops_reader(make_console: Callable[..., Any]) -> None:
    con, fake = make_console(["x"])
    assert wait_until(lambda: con.seq == 1)
    con.close()
    con.close()
    assert fake.is_open is False
    fake.feed(["after close"])
    time.sleep(0.05)
    assert con.seq == 1


def test_module_constants() -> None:
    assert console_mod.READ_CHUNK == 512
    assert console_mod.CONTEXT_LINES == 20
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && python -m pytest tests/test_console.py -q 2>&1 | tail -3`
Expected: `ImportError while importing test module … No module named 'crosspad_hil.console'` (collection error, exit code 2).

- [ ] **Step 3: Write the implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/console.py`:

```python
"""Console session on the STM32 bridge VCP (0x0483:0x5740).

The bridge carries the ESP32's UART0 console out over USB and survives ESP resets
and USB-profile switches, so it is the only port that ever sees the ROM banner.
Two traps, both from platform-idf/tools/hil_kit_churn.py, are encoded here and
nowhere else:

* the bridge emulates esptool's DTR/RTS auto-reset, so the port is opened with
  both deasserted (``serial_open.open_serial``) and the only reset is
  :meth:`Console.reset` (``serial_open.reset_pulse``, which always releases RTS);
* the log carries UTF-8 (perfmon box drawing, the panic banner), so decoding is
  ``errors="replace"`` and the log file is opened the same way — a reader that
  dies on the panic line dies exactly when the log matters.

A background thread owns the port. Lines are numbered (``seq``), kept in a
bounded ring, appended to an optional log file and fed to a
:class:`~crosspad_hil.parsers.ConsoleParser`; the resulting events are kept in a
second ring and handed to ``on_event`` (the daemon turns them into
``console.*`` events).
"""
from __future__ import annotations

import itertools
import re
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

from crosspad_hil.knowledge import load
from crosspad_hil.locks import PortLock
from crosspad_hil.parsers import ConsoleEvent, ConsoleParser
from crosspad_hil.serial_open import open_serial, reset_pulse

READ_CHUNK = 512  # from hil_kit_churn.py Console.run: ser.read(512)
EVENT_RING = 10_000
CONTEXT_LINES = 20


@dataclass
class ReadResult:
    lines: list[tuple[int, str]]
    next_seq: int
    lines_lost: int


@dataclass
class ExpectResult:
    hit: str | None
    rejected: str | None
    seq: int | None
    context: list[str]
    elapsed_s: float


@dataclass
class BootResult:
    complete: bool
    missing: list[str]
    fatal: list[dict]
    errors: list[dict]
    bootloops: int
    seconds: float


class Console:
    """Tail of the ESP console with a ring buffer, parser events and expect()."""

    def __init__(
        self,
        port: str,
        *,
        log_path: Path | None = None,
        ring_size: int = 50_000,
        knowledge: dict | None = None,
        required: list[str] | None = None,
        serial_factory: Callable = open_serial,
        on_event: Callable[[ConsoleEvent], None] | None = None,
    ) -> None:
        self.port = port
        self.log_path: Path | None = Path(log_path) if log_path is not None else None
        self._knowledge: dict = knowledge if knowledge is not None else load("markers")
        self._parser = ConsoleParser(knowledge=self._knowledge, required=required)
        self._serial_factory = serial_factory
        self._on_event = on_event
        self._ring: deque[tuple[int, str]] = deque(maxlen=ring_size)
        self._events: deque[ConsoleEvent] = deque(maxlen=EVENT_RING)
        self._cond = threading.Condition()
        self._seq = 0
        self._lines_lost = 0
        # Baselines for wait_boot(): entries recorded before the last reset()/open()
        # belong to an earlier boot.
        self._fatal_base = 0
        self._error_base = 0
        self._ser: Any = None
        self._log: IO[str] | None = None
        self._lock: PortLock | None = None
        self._thread: threading.Thread | None = None
        self._alive = False

    # ── properties ─────────────────────────────────────────────────────────
    @property
    def seq(self) -> int:
        """Sequence number of the last line ingested (0 before any line)."""
        return self._seq

    # ── lifecycle ──────────────────────────────────────────────────────────
    def open(self, reset: bool = False) -> None:
        """Lock the port, open it with DTR/RTS deasserted, start the reader.

        ``reset=True`` pulses the board through :meth:`reset` *after* the reader
        is running, so the banner is captured from its first byte.
        """
        if self._ser is not None:
            return
        lock = PortLock(self.port, "console")
        lock.acquire()
        try:
            ser = self._serial_factory(self.port, timeout=0.2)
        except Exception:
            lock.release()
            raise
        self._lock = lock
        self._ser = ser
        if self.log_path is not None:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            # from hil_kit_churn.py Console.__init__: utf-8 + replace, line-buffered
            self._log = open(  # noqa: SIM115 - closed in close()
                self.log_path, "a", buffering=1, encoding="utf-8", errors="replace"
            )
        self._alive = True
        self._thread = threading.Thread(
            target=self._read_loop, name=f"console:{self.port}", daemon=True
        )
        self._thread.start()
        if reset:
            self.reset()

    def close(self) -> None:
        """Stop the reader, close the port and the log, release the lock. Idempotent."""
        self._alive = False
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        ser, self._ser = self._ser, None
        if ser is not None:
            try:
                ser.close()
            except Exception:  # noqa: BLE001 - a port that vanished is still closed
                pass
        log, self._log = self._log, None
        if log is not None:
            log.close()
        lock, self._lock = self._lock, None
        if lock is not None:
            lock.release()

    def reset(self) -> None:
        """esptool-style reset through the bridge; boot tracking starts over."""
        if self._ser is None:
            return
        try:
            reset_pulse(self._ser)  # from hil_smoke.py reset_pulse (always releases RTS)
        finally:
            with self._cond:
                self._parser.reset_boot_tracking()
                snap = self._parser.snapshot()
                self._fatal_base = len(snap["fatals"])
                self._error_base = len(snap["errors"])

    # ── reader thread ──────────────────────────────────────────────────────
    def _read_loop(self) -> None:
        # from hil_kit_churn.py Console.run: read(512), split on b"\n", strip "\r"
        buf = b""
        while self._alive:
            ser = self._ser
            if ser is None:
                break
            try:
                chunk = ser.read(READ_CHUNK)
            except Exception:  # noqa: BLE001 - SerialException/OSError: port went away
                break
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                self._ingest(raw.decode("utf-8", "replace").rstrip("\r"))

    def _ingest(self, line: str) -> None:
        with self._cond:
            self._seq += 1
            seq = self._seq
            if self._ring.maxlen is not None and len(self._ring) == self._ring.maxlen:
                self._lines_lost += 1
            self._ring.append((seq, line))
            if self._log is not None:
                self._log.write(line + "\n")
            events = self._parser.feed(seq, line)
            self._events.extend(events)
            self._cond.notify_all()
        if self._on_event is not None:
            for ev in events:
                try:
                    self._on_event(ev)
                except Exception as exc:  # noqa: BLE001 - a callback must not kill the reader
                    print(f"console: on_event raised {exc!r} for {ev.kind}", file=sys.stderr)

    # ── ring access (all callers hold self._cond) ──────────────────────────
    def _oldest_seq(self) -> int:
        return self._ring[0][0] if self._ring else self._seq + 1

    def _from(self, start_seq: int) -> itertools.islice:
        """Iterate ring entries with seq >= start_seq without a Python-level scan."""
        offset = max(0, start_seq - self._oldest_seq())
        return itertools.islice(self._ring, offset, None)

    def _context(self, seq: int) -> list[str]:
        start = max(self._oldest_seq(), seq - CONTEXT_LINES + 1)
        return [line for s, line in self._from(start) if s <= seq]

    def _tail(self) -> list[str]:
        return [line for _s, line in self._from(max(self._oldest_seq(), self._seq - CONTEXT_LINES + 1))]

    def _select(
        self, since_seq: int | None, rx: re.Pattern[str] | None, limit: int
    ) -> tuple[list[tuple[int, str]], int]:
        oldest = self._oldest_seq()
        if since_seq is None:
            start, lost = oldest, 0
        else:
            start, lost = since_seq, max(0, oldest - since_seq)
        out: list[tuple[int, str]] = []
        for s, line in self._from(start):
            if s < start:
                continue
            if rx is not None and not rx.search(line):
                continue
            out.append((s, line))
            if len(out) >= limit:
                break
        return out, lost

    # ── public reads ───────────────────────────────────────────────────────
    def read(
        self,
        since_seq: int | None = None,
        wait_ms: int = 0,
        match: str | None = None,
        limit: int = 2000,
    ) -> ReadResult:
        """Lines with seq >= since_seq (oldest kept line when None), optionally filtered.

        ``wait_ms`` blocks until at least one matching line exists or the wait ends.
        """
        rx = re.compile(match) if match else None
        deadline = time.monotonic() + wait_ms / 1000.0
        with self._cond:
            while True:
                lines, lost = self._select(since_seq, rx, limit)
                if lines or wait_ms <= 0:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cond.wait(remaining)
            if lines:
                next_seq = lines[-1][0] + 1
            elif since_seq is not None:
                next_seq = since_seq
            else:
                next_seq = self._seq + 1
        return ReadResult(lines=lines, next_seq=next_seq, lines_lost=lost)

    def expect(
        self,
        patterns: list[str],
        reject: Sequence[str] = (),
        timeout_s: float = 30.0,
        *,
        since_seq: int | None = None,
    ) -> ExpectResult:
        """First line (after the call, or from ``since_seq``) matching a pattern.

        Reject patterns are tested first on every line. ``hit``/``rejected`` carry
        the pattern source; ``context`` is the 20 lines ending at the match.
        """
        pats = [(p, re.compile(p)) for p in patterns]
        rejs = [(p, re.compile(p)) for p in reject]
        t0 = time.monotonic()
        deadline = t0 + timeout_s
        with self._cond:
            cursor = since_seq if since_seq is not None else self._seq + 1
            while True:
                for s, line in self._from(cursor):
                    if s < cursor:
                        continue
                    cursor = s + 1
                    for p, rx in rejs:
                        if rx.search(line):
                            return ExpectResult(
                                hit=None, rejected=p, seq=s, context=self._context(s),
                                elapsed_s=time.monotonic() - t0,
                            )
                    for p, rx in pats:
                        if rx.search(line):
                            return ExpectResult(
                                hit=p, rejected=None, seq=s, context=self._context(s),
                                elapsed_s=time.monotonic() - t0,
                            )
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return ExpectResult(
                        hit=None, rejected=None, seq=None, context=self._tail(),
                        elapsed_s=time.monotonic() - t0,
                    )
                self._cond.wait(remaining)

    def wait_boot(self, timeout_s: float | None = None, settle_s: float = 3.0) -> BootResult:
        """Wait for every required marker (parser ``boot_complete``), then ``settle_s``.

        from hil_smoke.py capture_boot: after the last required marker keep reading
        3 s for late errors; from hil_stability.py BOOT_WINDOW_S = 45 (knowledge
        ``boot_timeout_s``) as the default deadline.
        """
        timeout = (
            float(timeout_s)
            if timeout_s is not None
            else float(self._knowledge.get("boot_timeout_s", 45))
        )
        t0 = time.monotonic()
        deadline = t0 + timeout
        settle_until: float | None = None
        with self._cond:
            while True:
                snap = self._parser.snapshot()
                now = time.monotonic()
                if snap["boot_complete"] and settle_until is None:
                    settle_until = now + settle_s
                if settle_until is not None and now >= settle_until:
                    break
                if now >= deadline:
                    break
                wake = settle_until if settle_until is not None else deadline
                self._cond.wait(max(0.0, min(wake - now, 0.25)))
            snap = self._parser.snapshot()
            fatal = list(snap["fatals"][self._fatal_base:])
            errors = list(snap["errors"][self._error_base:])
        return BootResult(
            complete=bool(snap["boot_complete"]),
            missing=list(snap["missing_markers"]),
            fatal=fatal,
            errors=errors,
            bootloops=int(snap["bootloops"]),
            seconds=time.monotonic() - t0,
        )

    def snapshot(self) -> dict:
        """Parser snapshot plus ``seq``, ``lines_lost``, ``log_path`` and ``port``."""
        with self._cond:
            snap = self._parser.snapshot()
            snap.update(
                seq=self._seq,
                lines_lost=self._lines_lost,
                log_path=str(self.log_path) if self.log_path is not None else None,
                port=self.port,
            )
        return snap

    def events(self, since_seq: int = 0) -> list[ConsoleEvent]:
        """Parser events whose line seq is greater than ``since_seq``."""
        with self._cond:
            return [ev for ev in self._events if ev.seq > since_seq]


__all__ = [
    "CONTEXT_LINES",
    "EVENT_RING",
    "READ_CHUNK",
    "BootResult",
    "Console",
    "ExpectResult",
    "ReadResult",
]
```

- [ ] **Step 4: Run the tests and ruff**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && python -m pytest tests/test_console.py -q && ruff check crosspad_hil/console.py tests/test_console.py`
Expected: `24 passed` and `All checks passed!`.

If `test_events_emitted_to_callback_and_ring` fails on `kinds.count("boot_marker")`, the parser (Task 5) emits `boot_marker` for optional markers too — `BOOT_OK` contains none, so the count must still equal `len(required)`; re-check that `BOOT_OK` was not edited. If `test_wait_boot_counts_bootloops` reports `bootloops == 0`, the parser clears `markers_seen` on the reboot line — chunk A3 decision 2 says it must not (only `reset_boot_tracking()` does).

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/console.py tests/test_console.py
git commit -m "feat(console): STM VCP session with ring buffer, parser events, expect and wait_boot

Opened with DTR/RTS deasserted; the only reset is Console.reset(). Ported from
hil_kit_churn.py Console and hil_smoke.py capture_boot.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CDC control link (`cdc.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/cdc.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_cdc.py`

**Interfaces:**
- Consumes:
  - `crosspad_hil.serial_open.open_serial(path, *, baud, timeout, reset, serial_cls)` (Task 3).
  - `crosspad_hil.locks.PortLock(port, "cdc")` (Task 3).
  - `crosspad_hil.knowledge.load("cdc") -> {"verbs": {VERB: {args, reply, end, profile[, prefix]}}}` (Task 2): `reply` is a prefix string, `"OK"`, `"multi"` (first-line prefix in `prefix`) or `null`.
  - `crosspad_hil.parsers.parse_cdc_reply(line) -> dict | None` (Task 5).
  - `crosspad_hil.errors.HilError`, codes `UNKNOWN_VERB`, `TIMEOUT`, `BAD_ARGS` (Task 1).
  - `tests.fakes.FakeSerial` (Task 1): scripted replies, echo of unknown commands, `feed()`, `written`.
- Produces (verbatim from the contract):
  ```python
  @dataclass
  class Reply: line: str; parsed: dict | None; rtt_ms: float; extra_lines: list[str]
  @dataclass
  class BurstResult: sent: int; seconds: float; drops_before: int; drops_after: int; dropped: int
  class CdcLink:
      def __init__(self, port: str, *, serial_factory: Callable = open_serial,
                   knowledge: dict | None = None) -> None
      def open(self) -> None
      def close(self) -> None
      def send(self, cmd: str) -> None
      def transact(self, cmd: str, expect: str | None = None, timeout_s: float = 2.0) -> Reply
      def transact_multi(self, cmd: str, expect: str, end: str | None = None,
                         idle_ms: int = 200, timeout_s: float = 3.0) -> list[str]
      def burst(self, cmds: list[str], rate_hz: float) -> BurstResult
      def unmatched(self) -> list[str]
      port: str   # public attribute
  ```
  Module constants: `OPEN_SETTLE_S = 0.4`, `READ_CHUNK = 512`, `UNMATCHED_RING = 200`,
  `BURST_SETTLE_S = 0.2`, `CDC_DROP_RE = re.compile(r"CDCSTATS:.*\bdrop=(\d+)")`.
  `serial_factory` is called as `serial_factory(port, timeout=0.2)`.

- [ ] **Step 1: Write the failing tests**

`/home/matixan/GIT/crosspad-hil/tests/test_cdc.py`:

```python
"""CdcLink: reader thread + prefix waiters (hil_kit_churn.Cdc), knowledge-derived expects,
echo → UNKNOWN_VERB, timeout hints, multi-line replies, burst drop accounting.

Reply formats are copied from platform-idf/main/hil_control.cpp snprintf strings.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from crosspad_hil import cdc as cdc_mod
from crosspad_hil.cdc import BurstResult, CdcLink, Reply
from crosspad_hil.errors import BAD_ARGS, TIMEOUT, UNKNOWN_VERB, HilError
from tests.fakes import FakeSerial

KITSTATUS = "KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS"
CDCSTATS_0 = "CDCSTATS: rx=100 cmds=98 drop=1"
CDCSTATS_1 = "CDCSTATS: rx=140 cmds=130 drop=3"
ENCGROUP = [
    "ENCGROUP: count=3",
    "  [0] 0x3fcb0001 Back",
    "  [1] 0x3fcb0002 Load",
    "  [2] 0x3fcb1234 Kit: DRUMS",
]
APPVER = [
    "APPVER: crosspad-sampler id=sampler commit=abc1234 ref=v1.2 dirty=0",
    "APPVER: crosspad-fishtank id=- commit=0123abc ref=- dirty=0",
    "APPVER: end count=2",
]
MEMBLOCKS = [
    "MEMBLK: biggest_used=4096 | <=64 u=120/5000B f=3/100B | <=big u=1/16384B f=0/0B",
    "MEMBIG: @3fc9a000=16384",
]

# Minimal cdc.yaml-shaped knowledge so the expect-derivation tests do not depend on Task 2.
CDC_KNOWLEDGE: dict = {
    "verbs": {
        "KIT_STATUS": {"args": [], "reply": "KITSTATUS:", "end": None, "profile": "default"},
        "KIT_LOAD": {"args": ["kit_id:int"], "reply": "OK", "end": None, "profile": "default"},
        "PAD_PRESS": {"args": ["idx:int", "vel:int?"], "reply": "OK", "end": None,
                      "profile": "default"},
        "ENC_GROUP": {"args": [], "reply": "multi", "prefix": "ENCGROUP:", "end": None,
                      "profile": "default"},
        "APP_VERSIONS": {"args": [], "reply": "multi", "prefix": "APPVER:", "end": "APPVER: end",
                         "profile": "default"},
        "MEM_BLOCKS": {"args": [], "reply": "multi", "prefix": "MEMBLK:", "end": "MEMBIG:",
                       "profile": "default"},
        "CDC_STATS": {"args": [], "reply": "CDCSTATS:", "end": None, "profile": "default"},
        "USB_AUDIO": {"args": [], "reply": None, "end": None, "profile": "default"},
    }
}


class SequencedFake(FakeSerial):
    """FakeSerial whose replies for one command are consumed in order (last one repeats).

    FakeSerial maps a command to one fixed reply; CDC_STATS before/after a burst needs two.
    """

    def __init__(self, sequences: dict[str, list[str]]) -> None:
        super().__init__([], timeout=0.01)
        self._sequences = {k: list(v) for k, v in sequences.items()}

    def write(self, data: bytes) -> int:
        text = data.decode("utf-8", errors="replace")
        for raw in text.split("\n"):
            cmd = raw.rstrip("\r")
            if not cmd:
                continue
            self.written.append(cmd)
            seq = self._sequences.get(cmd)
            if seq is None:
                self._rx.append((cmd + "\r\n").encode())
                continue
            reply = seq.pop(0) if len(seq) > 1 else seq[0]
            self._rx.append((reply + "\r\n").encode())
        return len(data)


class SilentFake(FakeSerial):
    """A port that swallows everything — the CDC endpoint of a board mid-reboot."""

    def write(self, data: bytes) -> int:
        self.written.append(data.decode("utf-8", errors="replace").rstrip("\r\n"))
        return len(data)


@pytest.fixture(autouse=True)
def fast_constants(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    monkeypatch.setattr(cdc_mod, "OPEN_SETTLE_S", 0.0)
    monkeypatch.setattr(cdc_mod, "BURST_SETTLE_S", 0.01)


@pytest.fixture
def make_link() -> Callable[..., tuple[CdcLink, FakeSerial]]:
    opened: list[CdcLink] = []

    def _make(
        script: list[tuple[str, str | list[str]]] | None = None,
        *,
        fake: FakeSerial | None = None,
        knowledge: dict | None = CDC_KNOWLEDGE,
    ) -> tuple[CdcLink, FakeSerial]:
        ser = fake if fake is not None else FakeSerial(script or [], timeout=0.01)
        link = CdcLink("/dev/fake-cdc", serial_factory=lambda path, **kw: ser, knowledge=knowledge)
        link.open()
        opened.append(link)
        return link, ser

    yield _make
    for link in opened:
        link.close()


# ── hygiene / lifecycle ─────────────────────────────────────────────────────
def test_open_deasserts_dtr_rts_and_locks_port(tmp_path: Path) -> None:
    from crosspad_hil.locks import PortLock
    from crosspad_hil.serial_open import open_serial

    fake = FakeSerial([], timeout=0.01)
    link = CdcLink(
        "/dev/fake-cdc",
        serial_factory=lambda path, **kw: open_serial(path, serial_cls=lambda: fake, **kw),
        knowledge=CDC_KNOWLEDGE,
    )
    link.open()
    try:
        assert fake.is_open
        assert all(value is False for _n, value in fake.control_history)
        assert [(h["port"], h["purpose"]) for h in PortLock.holders()] == [("/dev/fake-cdc", "cdc")]
    finally:
        link.close()
    assert PortLock.holders() == []
    assert fake.is_open is False


def test_send_is_fire_and_forget_with_newline(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([("PAD_PRESS 3 100", "OK")])
    link.send("PAD_PRESS 3 100")
    assert fake.written == ["PAD_PRESS 3 100"]
    time.sleep(0.05)
    assert link.unmatched() == ["OK"]  # nobody waited for it; it is not lost, just unclaimed


# ── "OK is not your ack" ────────────────────────────────────────────────────
def test_reply_matched_by_prefix_while_unrelated_ok_lines_interleave(
    make_link: Callable[..., Any],
) -> None:
    link, fake = make_link([("KIT_STATUS", KITSTATUS)])
    # Pad traffic that arrived just before our command's reply.
    fake.feed(["OK", "OK", "SMPLPEAK: 1200 free=7"])
    reply = link.transact("KIT_STATUS")
    assert isinstance(reply, Reply)
    assert reply.line == KITSTATUS
    assert reply.parsed is not None and reply.parsed["current"] == 3
    assert reply.parsed["loading"] is False and reply.parsed["pending"] == -1
    assert reply.rtt_ms >= 0.0
    assert reply.extra_lines == ["OK", "OK", "SMPLPEAK: 1200 free=7"]
    assert link.unmatched() == ["OK", "OK", "SMPLPEAK: 1200 free=7"]


def test_ok_verb_accepts_ok_or_err(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([("KIT_LOAD 3", "OK"), ("KIT_LOAD 99", "ERR bad kit id")])
    assert link.transact("KIT_LOAD 3").parsed == {"kind": "ok"}
    err = link.transact("KIT_LOAD 99")
    assert err.line == "ERR bad kit id"
    assert err.parsed is not None and err.parsed["kind"] == "err"


def test_concurrent_transacts_each_get_their_own_reply(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([("KIT_STATUS", KITSTATUS), ("CDC_STATS", CDCSTATS_0)])
    out: dict[str, str] = {}

    def worker(cmd: str) -> None:
        out[cmd] = link.transact(cmd).line

    threads = [threading.Thread(target=worker, args=(c,)) for c in ("KIT_STATUS", "CDC_STATS")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(2.0)
    assert out == {"KIT_STATUS": KITSTATUS, "CDC_STATS": CDCSTATS_0}


# ── expect derivation from knowledge ────────────────────────────────────────
def test_transact_derives_expect_from_knowledge(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([("KIT_STATUS", KITSTATUS)])
    assert link.transact("KIT_STATUS").line == KITSTATUS
    assert link.transact("KIT_STATUS", expect="KITSTATUS:").line == KITSTATUS


def test_transact_multi_verb_without_expect_uses_prefix(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([("ENC_GROUP", ENCGROUP)])
    reply = link.transact("ENC_GROUP")
    assert reply.line == "ENCGROUP: count=3"


def test_transact_no_reply_verb_is_fire_and_forget(make_link: Callable[..., Any]) -> None:
    link, fake = make_link(fake=SilentFake([], timeout=0.01))
    reply = link.transact("USB_AUDIO")
    assert reply == Reply(line="", parsed=None, rtt_ms=0.0, extra_lines=[])
    assert fake.written == ["USB_AUDIO"]


def test_transact_verb_absent_from_knowledge_raises_before_sending(
    make_link: Callable[..., Any],
) -> None:
    link, fake = make_link([])
    with pytest.raises(HilError) as ei:
        link.transact("NOT_A_VERB 1")
    assert ei.value.code == UNKNOWN_VERB
    assert "expect=" in (ei.value.hint or "")
    assert fake.written == []


def test_default_knowledge_is_cdc_yaml(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([("LED_STATE", "LEDS: bri=80 anim=0 coalesce=1 cfgbri=80 pwr=0x00 "
                              "pwrN=3 txfail=0 colors=" + ",".join(["000000"] * 16))],
                           knowledge=None)
    assert link.transact("LED_STATE").line.startswith("LEDS:")


# ── echo → UNKNOWN_VERB ─────────────────────────────────────────────────────
def test_echo_of_sent_line_is_unknown_verb(make_link: Callable[..., Any]) -> None:
    # FakeSerial echoes unscripted commands, exactly like cdc_dispatch_one() when no
    # handler matched.
    link, fake = make_link([])
    with pytest.raises(HilError) as ei:
        link.transact("KIT_STATUS", timeout_s=1.0)
    assert ei.value.code == UNKNOWN_VERB
    assert ei.value.details["cmd"] == "KIT_STATUS"
    assert fake.written == ["KIT_STATUS"]


def test_echo_with_explicit_expect_is_still_unknown_verb(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([])
    with pytest.raises(HilError) as ei:
        link.transact("FOO_BAR 7", expect="OK", timeout_s=1.0)
    assert ei.value.code == UNKNOWN_VERB


# ── timeouts ────────────────────────────────────────────────────────────────
def test_timeout_with_zero_bytes_hints_uac2(make_link: Callable[..., Any]) -> None:
    link, fake = make_link(fake=SilentFake([], timeout=0.01))
    t0 = time.monotonic()
    with pytest.raises(HilError) as ei:
        link.transact("KIT_STATUS", timeout_s=0.1)
    assert ei.value.code == TIMEOUT
    assert "UAC2" in (ei.value.hint or "")
    assert ei.value.details["rx_bytes"] == 0
    assert 0.1 <= time.monotonic() - t0 < 1.0


def test_timeout_with_traffic_does_not_blame_uac2(make_link: Callable[..., Any]) -> None:
    fake = SilentFake([], timeout=0.01)
    link, _ = make_link(fake=fake)
    threading.Timer(0.02, lambda: fake.feed(["OK", "OK"])).start()
    with pytest.raises(HilError) as ei:
        link.transact("KIT_STATUS", timeout_s=0.2)
    assert ei.value.code == TIMEOUT
    assert "UAC2" not in (ei.value.hint or "")
    assert ei.value.details["rx_bytes"] > 0
    assert link.unmatched() == ["OK", "OK"]


# ── transact_multi ──────────────────────────────────────────────────────────
def test_transact_multi_enc_group_ends_on_idle(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([("ENC_GROUP", ENCGROUP)])
    t0 = time.monotonic()
    lines = link.transact_multi("ENC_GROUP", "ENCGROUP:", end=None, idle_ms=100)
    assert lines == [
        "ENCGROUP: count=3",
        "[0] 0x3fcb0001 Back",
        "[1] 0x3fcb0002 Load",
        "[2] 0x3fcb1234 Kit: DRUMS",
    ]
    assert 0.1 <= time.monotonic() - t0 < 1.0
    from crosspad_hil.parsers import parse_enc_group

    assert [e["label"] for e in parse_enc_group(lines)] == ["Back", "Load", "Kit: DRUMS"]


def test_transact_multi_with_end_pattern_filters_interleaved_traffic(
    make_link: Callable[..., Any],
) -> None:
    link, fake = make_link([("APP_VERSIONS", [APPVER[0], "OK", APPVER[1], APPVER[2]])])
    t0 = time.monotonic()
    lines = link.transact_multi("APP_VERSIONS", "APPVER:", end="APPVER: end", idle_ms=500)
    assert lines == APPVER
    assert time.monotonic() - t0 < 0.4  # returned on the end line, not on idle


def test_transact_multi_mem_blocks_two_lines(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([("MEM_BLOCKS", MEMBLOCKS)])
    assert link.transact_multi("MEM_BLOCKS", "MEMBLK:", end="MEMBIG:") == MEMBLOCKS


def test_transact_multi_echo_and_timeout(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([])
    with pytest.raises(HilError) as ei:
        link.transact_multi("ENC_GROUP", "ENCGROUP:", timeout_s=0.5)
    assert ei.value.code == UNKNOWN_VERB
    link2, _ = make_link(fake=SilentFake([], timeout=0.01))
    with pytest.raises(HilError) as ei:
        link2.transact_multi("ENC_GROUP", "ENCGROUP:", timeout_s=0.1)
    assert ei.value.code == TIMEOUT


# ── burst ───────────────────────────────────────────────────────────────────
def test_burst_accounts_drops_from_cdc_stats(make_link: Callable[..., Any]) -> None:
    fake = SequencedFake({"CDC_STATS": [CDCSTATS_0, CDCSTATS_1], "PAD_PRESS 0 100": ["OK"],
                          "PAD_RELEASE 0": ["OK"]})
    link, _ = make_link(fake=fake)
    cmds = ["PAD_PRESS 0 100", "PAD_RELEASE 0"] * 3
    t0 = time.monotonic()
    res = link.burst(cmds, rate_hz=100.0)
    elapsed = time.monotonic() - t0
    assert isinstance(res, BurstResult)
    assert res.sent == 6
    assert res.drops_before == 1 and res.drops_after == 3 and res.dropped == 2
    assert 0.05 <= res.seconds <= elapsed
    assert fake.written[0] == "CDC_STATS" and fake.written[-1] == "CDC_STATS"
    assert fake.written[1:-1] == cmds


def test_burst_paces_at_rate(make_link: Callable[..., Any]) -> None:
    fake = SequencedFake({"CDC_STATS": [CDCSTATS_0, CDCSTATS_0]})
    link, _ = make_link(fake=fake)
    res = link.burst(["PAD_PRESS 1 90"] * 5, rate_hz=50.0)  # 4 intervals of 20 ms
    assert res.dropped == 0
    assert 0.08 <= res.seconds < 0.5


def test_burst_rejects_non_positive_rate(make_link: Callable[..., Any]) -> None:
    link, _ = make_link([])
    with pytest.raises(HilError) as ei:
        link.burst(["PAD_PRESS 0"], rate_hz=0)
    assert ei.value.code == BAD_ARGS


# ── unmatched ring ──────────────────────────────────────────────────────────
def test_unmatched_is_bounded(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([])
    fake.feed([f"noise {i}" for i in range(250)])
    time.sleep(0.1)
    lines = link.unmatched()
    assert len(lines) == cdc_mod.UNMATCHED_RING == 200
    assert lines[0] == "noise 50" and lines[-1] == "noise 249"


def test_close_is_idempotent(make_link: Callable[..., Any]) -> None:
    link, fake = make_link([])
    link.close()
    link.close()
    assert fake.is_open is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && python -m pytest tests/test_cdc.py -q 2>&1 | tail -3`
Expected: `ImportError while importing test module … No module named 'crosspad_hil.cdc'`.

- [ ] **Step 3: Write the implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/cdc.py`:

```python
"""CDC control link on the ESP native USB CDC (0x303A:0x3456), default profile.

Ported from platform-idf/tools/hil_kit_churn.py ``class Cdc``. The design that
looks obvious — lock, write, sleep, read — starves everyone else on the port
(measured there: 8 pad hits/s requested, 1.8 delivered while a status poll ran).
So one reader thread owns the port and nothing else reads it. A request registers
the reply prefix it wants *before* writing, writers hold a lock only for the
``write()`` itself, and unrelated traffic is simply not theirs.

Three device behaviours the client must know (main/main.cpp ``cdc_dispatch_one``,
main/hil_control.cpp):

* a command no handler matched is **echoed back verbatim** — that is the only
  "unknown verb" signal, so a waiter that sees its own line raises
  ``UNKNOWN_VERB``;
* ``OK`` is the reply of ``PAD_PRESS`` as much as of ``KIT_LOAD`` — a prefix
  match is never proof that *your* command was obeyed; ask a state verb;
* ``app_queue`` is 64 deep and drops on overflow; ``CDC_STATS`` counts the
  drops, and :meth:`CdcLink.burst` reads it before and after.
"""
from __future__ import annotations

import re
import threading
import time
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from crosspad_hil.errors import BAD_ARGS, TIMEOUT, UNKNOWN_VERB, HilError
from crosspad_hil.knowledge import load
from crosspad_hil.locks import PortLock
from crosspad_hil.parsers import parse_cdc_reply
from crosspad_hil.serial_open import open_serial

OPEN_SETTLE_S = 0.4  # from hil_kit_churn.py Cdc.__init__: sleep(0.4) then reset_input_buffer()
READ_CHUNK = 512  # from hil_kit_churn.py Cdc._read_loop: ser.read(512)
UNMATCHED_RING = 200
BURST_SETTLE_S = 0.2  # let the prio-1 main loop drain app_queue before CDC_STATS
# from hil_control.cpp: "CDCSTATS: rx=%u cmds=%u drop=%u"
CDC_DROP_RE = re.compile(r"CDCSTATS:.*\bdrop=(\d+)")


@dataclass
class Reply:
    line: str
    parsed: dict | None
    rtt_ms: float
    extra_lines: list[str]


@dataclass
class BurstResult:
    sent: int
    seconds: float
    drops_before: int
    drops_after: int
    dropped: int


@dataclass
class _Waiter:
    """One outstanding request: what it waits for and what it has collected."""

    prefixes: tuple[str, ...]
    echo: str
    multi: bool = False
    end: str | None = None
    lines: list[str] = field(default_factory=list)
    extra: list[str] = field(default_factory=list)
    last_t: float = 0.0
    done: bool = False
    echoed: bool = False
    event: threading.Event = field(default_factory=threading.Event)

    def offer(self, line: str, now: float) -> bool:
        """Claim ``line`` if it belongs to this request. Returns True when claimed."""
        if self.done:
            return False
        if line == self.echo:
            self.echoed = True
            self.done = True
            self.event.set()
            return True
        if not self.multi:
            if line.startswith(self.prefixes):
                self.lines.append(line)
                self.done = True
                self.event.set()
                return True
            return False
        if not self.lines:
            if not line.startswith(self.prefixes[0]):
                return False
        elif self.end is not None and not (
            line.startswith(self.prefixes[0]) or line.startswith(self.end)
        ):
            return False
        self.lines.append(line)
        self.last_t = now
        if self.end is not None and line.startswith(self.end):
            self.done = True
            self.event.set()
        return True


class CdcLink:
    """One reader thread, prefix waiters, a write lock held only for write()."""

    def __init__(
        self,
        port: str,
        *,
        serial_factory: Callable = open_serial,
        knowledge: dict | None = None,
    ) -> None:
        self.port = port
        self._serial_factory = serial_factory
        self._knowledge: dict = knowledge if knowledge is not None else load("cdc")
        self._verbs: dict[str, dict] = dict(self._knowledge.get("verbs", {}))
        self._ser: Any = None
        self._lock: PortLock | None = None
        self._wlock = threading.Lock()
        self._rlock = threading.Lock()
        self._waiters: list[_Waiter] = []
        self._unmatched: deque[str] = deque(maxlen=UNMATCHED_RING)
        self._rx_bytes = 0
        self._alive = False
        self._thread: threading.Thread | None = None

    # ── lifecycle ──────────────────────────────────────────────────────────
    def open(self) -> None:
        """Lock the port, open it with DTR/RTS deasserted, start the reader."""
        if self._ser is not None:
            return
        lock = PortLock(self.port, "cdc")
        lock.acquire()
        try:
            ser = self._serial_factory(self.port, timeout=0.2)
        except Exception:
            lock.release()
            raise
        self._lock = lock
        self._ser = ser
        # from hil_kit_churn.py Cdc.__init__: let the enumeration settle, drop stale bytes
        if OPEN_SETTLE_S > 0:
            time.sleep(OPEN_SETTLE_S)
        try:
            ser.reset_input_buffer()
        except Exception:  # noqa: BLE001 - not every serial-like object has one
            pass
        self._alive = True
        self._thread = threading.Thread(
            target=self._read_loop, name=f"cdc:{self.port}", daemon=True
        )
        self._thread.start()

    def close(self) -> None:
        """Stop the reader, close the port, release the lock. Idempotent."""
        self._alive = False
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        ser, self._ser = self._ser, None
        if ser is not None:
            try:
                ser.close()
            except Exception:  # noqa: BLE001 - a port that vanished is still closed
                pass
        lock, self._lock = self._lock, None
        if lock is not None:
            lock.release()
        with self._rlock:
            for w in self._waiters:
                w.done = True
                w.event.set()
            self._waiters.clear()

    # ── reader thread ──────────────────────────────────────────────────────
    def _read_loop(self) -> None:
        # from hil_kit_churn.py Cdc._read_loop
        buf = b""
        while self._alive:
            ser = self._ser
            if ser is None:
                break
            try:
                chunk = ser.read(READ_CHUNK)
            except Exception:  # noqa: BLE001 - SerialException/OSError: port went away
                break
            if not chunk:
                continue
            self._rx_bytes += len(chunk)
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    self._dispatch(line)

    def _dispatch(self, line: str) -> None:
        now = time.monotonic()
        with self._rlock:
            for w in self._waiters:
                if w.offer(line, now):
                    return
            self._unmatched.append(line)
            for w in self._waiters:
                if not w.done:
                    w.extra.append(line)

    def _register(self, w: _Waiter) -> None:
        with self._rlock:
            self._waiters.append(w)

    def _unregister(self, w: _Waiter) -> None:
        with self._rlock:
            try:
                self._waiters.remove(w)
            except ValueError:
                pass

    # ── writes ─────────────────────────────────────────────────────────────
    def send(self, cmd: str) -> None:
        """Fire and forget — the pad stimulus, which must never stall."""
        ser = self._ser
        if ser is None:
            raise HilError(BAD_ARGS, "CdcLink is not open", hint="call open() first",
                           port=self.port)
        with self._wlock:
            try:
                ser.write((cmd + "\n").encode("utf-8"))
            except Exception:  # noqa: BLE001 - from hil_kit_churn.py Cdc.send: never stall
                pass

    def _timeout_error(
        self, cmd: str, prefixes: tuple[str, ...], timeout_s: float, rx_bytes: int
    ) -> HilError:
        if rx_bytes == 0:
            hint = (
                "no bytes at all arrived on the CDC port: the device may be in the "
                "MIDI+UAC2 profile (no CDC endpoint) — usbmode.set mode=default — or it "
                "is rebooting; check `crosspad-hil devices`"
            )
        else:
            hint = (
                f"the device is talking but never answered {'/'.join(prefixes)}; another "
                "session may have consumed the reply, or the verb does not reply in this "
                "state — unmatched() shows what did arrive"
            )
        return HilError(
            TIMEOUT,
            f"no {'/'.join(prefixes)} reply to {cmd!r} within {timeout_s:g}s",
            hint=hint,
            cmd=cmd,
            expect=list(prefixes),
            timeout_s=timeout_s,
            rx_bytes=rx_bytes,
        )

    def _echo_error(self, cmd: str) -> HilError:
        return HilError(
            UNKNOWN_VERB,
            f"device echoed {cmd!r}: no CDC handler matched it",
            hint=(
                "the verb is misspelled, absent from this firmware, or not available in "
                "this USB profile; knowledge/cdc.yaml lists the catalog"
            ),
            cmd=cmd,
        )

    # ── request / reply ────────────────────────────────────────────────────
    def transact(self, cmd: str, expect: str | None = None, timeout_s: float = 2.0) -> Reply:
        """Send ``cmd`` and return the first reply line starting with ``expect``.

        ``expect=None`` derives the prefix from ``knowledge/cdc.yaml`` for the verb
        (first word). ``"OK"`` verbs accept ``OK`` or ``ERR …``. An echo of the sent
        line raises ``UNKNOWN_VERB``; silence raises ``TIMEOUT`` with a hint that
        names UAC2 mode when not a single byte arrived.
        """
        cmd = cmd.strip()
        verb = cmd.split(" ", 1)[0]
        if expect is None:
            entry = self._verbs.get(verb)
            if entry is None:
                raise HilError(
                    UNKNOWN_VERB,
                    f"{verb} is not in knowledge/cdc.yaml",
                    hint="pass expect=<reply prefix> (or expect='OK') to send it anyway",
                    verb=verb,
                    cmd=cmd,
                )
            reply_kind = entry.get("reply")
            if reply_kind is None:
                self.send(cmd)
                return Reply(line="", parsed=None, rtt_ms=0.0, extra_lines=[])
            expect = str(entry.get("prefix", "")) if reply_kind == "multi" else str(reply_kind)
        prefixes: tuple[str, ...] = ("OK", "ERR") if expect == "OK" else (expect,)
        waiter = _Waiter(prefixes=prefixes, echo=cmd)
        rx0 = self._rx_bytes
        # Registered before the write so an instant reply cannot be missed.
        self._register(waiter)
        t0 = time.monotonic()
        try:
            self.send(cmd)
            waiter.event.wait(timeout_s)
        finally:
            self._unregister(waiter)
        rtt_ms = (time.monotonic() - t0) * 1000.0
        if waiter.echoed:
            raise self._echo_error(cmd)
        if not waiter.lines:
            raise self._timeout_error(cmd, prefixes, timeout_s, self._rx_bytes - rx0)
        line = waiter.lines[0]
        return Reply(
            line=line, parsed=parse_cdc_reply(line), rtt_ms=rtt_ms, extra_lines=list(waiter.extra)
        )

    def transact_multi(
        self,
        cmd: str,
        expect: str,
        end: str | None = None,
        idle_ms: int = 200,
        timeout_s: float = 3.0,
    ) -> list[str]:
        """Multi-line reply: from the first ``expect`` line to ``end`` (inclusive).

        With ``end=None`` the reply ends after ``idle_ms`` without a new line
        (``ENC_GROUP``). With ``end`` given only lines starting with ``expect`` or
        ``end`` are kept, so interleaved pad ``OK``s do not land in the result.
        """
        cmd = cmd.strip()
        waiter = _Waiter(prefixes=(expect,), echo=cmd, multi=True, end=end)
        rx0 = self._rx_bytes
        self._register(waiter)
        deadline = time.monotonic() + timeout_s
        idle_s = idle_ms / 1000.0
        try:
            self.send(cmd)
            while True:
                if end is not None:
                    waiter.event.wait(0.02)
                else:
                    time.sleep(0.02)
                now = time.monotonic()
                with self._rlock:
                    echoed = waiter.echoed
                    done = waiter.done
                    n_lines = len(waiter.lines)
                    last_t = waiter.last_t
                if echoed:
                    raise self._echo_error(cmd)
                if done:
                    break
                if end is None and n_lines and now - last_t >= idle_s:
                    break
                if now >= deadline:
                    break
        finally:
            self._unregister(waiter)
        with self._rlock:
            lines = list(waiter.lines)
        if not lines:
            raise self._timeout_error(cmd, (expect,), timeout_s, self._rx_bytes - rx0)
        return lines

    # ── burst ──────────────────────────────────────────────────────────────
    def _drops(self) -> int:
        reply = self.transact("CDC_STATS", expect="CDCSTATS:")
        m = CDC_DROP_RE.search(reply.line)
        return int(m.group(1)) if m else 0

    def burst(self, cmds: Sequence[str], rate_hz: float) -> BurstResult:
        """Send ``cmds`` paced at ``rate_hz`` and account app_queue drops via CDC_STATS."""
        if rate_hz <= 0:
            raise HilError(BAD_ARGS, f"rate_hz must be > 0, got {rate_hz!r}", rate_hz=rate_hz)
        before = self._drops()
        period = 1.0 / rate_hz
        t0 = time.monotonic()
        for i, cmd in enumerate(cmds):
            target = t0 + i * period
            now = time.monotonic()
            if target > now:
                time.sleep(target - now)
            self.send(cmd)
        seconds = time.monotonic() - t0
        if BURST_SETTLE_S > 0:
            time.sleep(BURST_SETTLE_S)
        after = self._drops()
        return BurstResult(
            sent=len(cmds),
            seconds=seconds,
            drops_before=before,
            drops_after=after,
            dropped=max(0, after - before),
        )

    def unmatched(self) -> list[str]:
        """Lines no request claimed (bounded to the last 200); not cleared."""
        with self._rlock:
            return list(self._unmatched)


__all__ = [
    "BURST_SETTLE_S",
    "CDC_DROP_RE",
    "OPEN_SETTLE_S",
    "READ_CHUNK",
    "UNMATCHED_RING",
    "BurstResult",
    "CdcLink",
    "Reply",
]
```

- [ ] **Step 4: Run the tests and ruff**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && python -m pytest tests/test_cdc.py -q && ruff check crosspad_hil/cdc.py tests/test_cdc.py`
Expected: `24 passed` and `All checks passed!`.

If `test_reply_matched_by_prefix_while_unrelated_ok_lines_interleave` fails on `reply.parsed["loading"] is False`, `parse_cdc_reply` (Task 5) is not on the branch — every other assertion in that test must still pass. If `test_default_knowledge_is_cdc_yaml` fails with `ENV: unknown knowledge file`, Task 2 is missing.

- [ ] **Step 5: Run the whole suite once, then commit**

Run: `cd /home/matixan/GIT/crosspad-hil && . .venv/bin/activate && ruff check . && python -m pytest -q`
Expected: `All checks passed!` and every test passing (Tasks 1–7 so far: the counts from earlier chunks plus 48 from this one).

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/cdc.py tests/test_cdc.py
git commit -m "feat(cdc): reader-thread CDC link with prefix waiters, echo detection and burst drop accounting

Ported from hil_kit_churn.py Cdc: waiters registered before the write, write lock
held only for write(). Expect derives from knowledge/cdc.yaml; an echoed command is
UNKNOWN_VERB; a silent port hints at the UAC2 profile.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
# Plan A — chunk A5: typed CDC verbs and device snapshot

Contract: `scratchpad/contract.md` (names verbatim). Repo: `/home/matixan/GIT/crosspad-hil`.
Both tasks sit on top of `cdc.py` (`CdcLink`, `Reply`), `parsers.py` (`parse_cdc_reply`,
`parse_enc_group`), `errors.py` (`HilError`) and `tests/fakes.py` (`FakeSerial`) from earlier
tasks of plan A. Nothing here touches hardware; every test drives a `CdcLink` over a
`FakeSerial`.

Reply grammar was taken from `platform-idf/main/hil_control.cpp` (authoritative); the
"OK is not your ack" rules from `hil_kit_churn.py` / `hil_app_churn.py`.

Assumptions shared by both tasks (stated once, used verbatim below):

- `CdcLink.transact(cmd, expect=None)` returns `Reply(line, parsed, rtt_ms, extra_lines)`
  where `parsed = parse_cdc_reply(line)`; with `expect=None` the reply prefix comes from
  `knowledge/cdc.yaml`, and for `reply: "OK"` verbs the link waits for `OK` **or** `ERR`.
  Verbs with a prefixed reply pass the prefix explicitly (robust to a yaml gap); `OK`
  verbs pass `expect=None` so `ERR` is still caught.
- `CdcLink.transact_multi(cmd, expect, end=None, idle_ms=200, timeout_s=3.0)` returns
  every line from the first one starting with `expect` up to and **including** the `end`
  line (or until `idle_ms` of silence when `end is None`).
- `CdcLink` works over a `FakeSerial` exactly as `tests/test_cdc.py` establishes (the
  `serial_factory` kwarg receives the fake; if `fakes.py` lacks `reset_input_buffer()`,
  add a no-op there — the reader pattern from `hil_kit_churn.Cdc.__init__` calls it).
- `FakeSerial(script)` answers the same reply every time a command repeats. Verbs that
  poll (`kit_load`, `app_start`) need a reply that changes between polls, so the test
  files define `SeqFakeSerial(FakeSerial)` — a subclass using only the public `feed()` /
  `written` API — that pops per-command reply sequences (last one sticky).

---

### Task 8: Typed CDC verbs (`verbs.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/verbs.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_verbs.py`

**Interfaces:**
- Consumes (contract, earlier tasks):
  - `crosspad_hil.cdc.CdcLink` — `transact(cmd: str, expect: str | None = None, timeout_s: float = 2.0) -> Reply`, `transact_multi(cmd: str, expect: str, end: str | None = None, idle_ms: int = 200, timeout_s: float = 3.0) -> list[str]`
  - `crosspad_hil.cdc.Reply` — `line: str; parsed: dict | None; rtt_ms: float; extra_lines: list[str]`
  - `crosspad_hil.parsers.parse_cdc_reply(line: str) -> dict | None`, `crosspad_hil.parsers.parse_enc_group(lines: list[str]) -> list[dict]`
  - `crosspad_hil.errors.HilError(code, message, hint=None, **details)`; codes `BAD_ARGS`, `TIMEOUT`, `NOT_SUPPORTED`
  - `tests.fakes.FakeSerial(script)` with `feed(lines)`, `written`, `readline()`, `close()`
- Produces (contract §verbs.py, every function `first arg link: CdcLink`, returns plain dicts, raises `HilError`):
  - `app_list(link) -> {"apps": list[str], "running": str | None}`
  - `app_start(link, name: str, wait_s: float = 3.0) -> {"running": str}`
  - `app_stop(link) -> {"ok": True}`; `app_destroy(link) -> {"ok": True}`; `app_self_close(link) -> {"ok": True}`
  - `app_versions(link) -> {"components": [{component,id,commit,ref,dirty}], "count": int}`
  - `kit_list(link) -> {"kits": [{id,name}], "current": int}`; `kit_status(link) -> {current,loading,pending,name}`
  - `kit_load(link, kit_id: int, wait_s: float = 15.0) -> kit_status dict`
  - `pad_press(link, idx: int, vel: int = 127) -> {"ok": True}`; `pad_release(link, idx: int)`; `pad_pressure(link, idx: int, val: int)`
  - `pad_stats(link, reset: bool = False) -> {press,release,played,freeslots}`; `pad_notes(link) -> {"notes": {int: int}}`; `pad_info(link, idx: int) -> {"raw": str}`
  - `enc_rotate(link, delta: int)`; `enc_press(link, ms: int = 80)`; `enc_group(link) -> {"group": [{ref,index,ptr,label}]}`; `enc_focus(link) -> {index,label,ptr}`; `enc_state(link) -> dict`; `ui_state(link) -> dict`
  - `led_state(link) -> dict`; `mem(link) -> dict`; `mem_blocks(link) -> {"summary": dict, "big": list}`; `cdc_stats(link) -> {rx,cmds,drop}`; `audio_level(link) -> dict`; `smpl_peak(link) -> dict`
  - `ble_status(link) -> dict`; `ble_start(link, mode: int | None = None)`; `ble_stop(link)`; `ble_scan(link, ms: int = 5000)`; `ble_devices(link) -> dict`; `ble_connect(link, addr: str)`; `ble_disconnect(link)`; `ble_send(link, note: int, vel: int = 100)`; `ble_txoff(link, semis: int)`
  - `audio_tasks(link, on: bool)`; `bootloader_request(link) -> {"sent": True}`; `stm_dfu(link) -> {"sent": True}`
  - `VERBS: dict[str, Callable]` — name → function, for `serve.py cdc.verb` and `cli.py` (`{"app_list": app_list, …}` for every public verb above)
- Decisions where the contract is silent:
  - Device `ERR …` replies raise `HilError("BAD_ARGS", "<VERB>: device replied ERR <message>", hint=…, reply=<line>)` for verbs that carry arguments (`APP_START`, `KIT_LOAD`, `PAD_INFO`, `BLE_CONNECT`); `HilError("NOT_SUPPORTED", …)` for argument-less ones (`KIT_LIST` "no kit manager", `BLE_START`, `STM_DFU`).
  - A reply that `parse_cdc_reply` cannot parse (or of the wrong kind) raises `HilError("NOT_SUPPORTED", "<VERB>: unparseable reply", hint="firmware predates this verb?", line=…)`.
  - Poll interval for `kit_load` / `app_start` is `0.25 s` (`_POLL_S`); `wait_s <= 0` means one poll, no wait.
  - `app_start` compares `running` case-insensitively (firmware `find_app` uses `strcasecmp`).
  - Argument limits (from `hil_control.cpp`): pad idx `0..15`; vel `0..127`; pressure `0..255`; app name 1..31 chars, no whitespace (`%31s`); `ENC_ROTATE` delta `-16..16`, non-zero (firmware clamps at ±16 and ignores 0); `ENC_PRESS` ms `1..5000`; `BLE_SCAN` ms `1..65535`; `BLE_TXOFF` `-127..127`; `BLE_SEND` note/vel `0..127`; `BLE_START` mode `None|0|1`; `BLE_CONNECT` addr `^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$`; `KIT_LOAD` id `>= 0` (upper bound is the device's `ERR bad kit id`).
  - `bootloader_request` sends `BOOTLOADER_REQUEST` (from `requestBootloader.py` `CDC_MESSAGE`) with `link.send()` and returns `{"sent": True}` without waiting — the device reboots into ROM download mode and never replies. `stm_dfu` transacts `STM_DFU` (`OK`/`ERR`) and returns `{"sent": True}`.

- [ ] **Step 1: Write the failing tests**

`/home/matixan/GIT/crosspad-hil/tests/test_verbs.py`:

```python
"""Typed CDC verbs over a scripted FakeSerial. No hardware."""
from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest

from crosspad_hil import verbs
from crosspad_hil.cdc import CdcLink
from crosspad_hil.errors import HilError
from tests.fakes import FakeSerial


class SeqFakeSerial(FakeSerial):
    """FakeSerial whose reply to a repeated command changes between calls.

    `sequences` maps a command to a list of replies (each reply is a str or a
    list[str]); every write pops the next one, the last one stays sticky.
    Commands not in `sequences` fall through to the plain FakeSerial script.
    """

    def __init__(self, script=(), sequences: dict[str, list] | None = None) -> None:
        super().__init__(list(script))
        self.sequences = {k: list(v) for k, v in (sequences or {}).items()}

    def write(self, data: bytes) -> int:
        cmd = data.decode("utf-8", "replace").strip()
        seq = self.sequences.get(cmd)
        if seq is None:
            return super().write(data)
        reply = seq.pop(0) if len(seq) > 1 else seq[0]
        self.written.append(cmd)
        self.feed([reply] if isinstance(reply, str) else list(reply))
        return len(data)


def _open_link(fake: FakeSerial) -> CdcLink:
    link = CdcLink(f"fake-verbs-{uuid.uuid4().hex[:8]}",
                   serial_factory=lambda path, **kw: fake)
    link.open()
    return link


@pytest.fixture
def make_link() -> Iterator:
    opened: list[CdcLink] = []

    def _make(script=(), sequences=None) -> CdcLink:
        fake = SeqFakeSerial(script, sequences)
        link = _open_link(fake)
        link.fake = fake  # type: ignore[attr-defined]
        opened.append(link)
        return link

    yield _make
    for link in opened:
        link.close()


# ── app_* ──────────────────────────────────────────────────────────────

def test_app_list_parses_apps_and_running(make_link) -> None:
    link = make_link([("APP_LIST", "APPS: Sampler,Sequencer,Fishtank running=-")])
    assert verbs.app_list(link) == {
        "apps": ["Sampler", "Sequencer", "Fishtank"], "running": None}


def test_app_start_success_polls_app_list(make_link) -> None:
    link = make_link(
        [("APP_START Sampler", "OK")],
        sequences={"APP_LIST": ["APPS: Sampler,Fishtank running=-",
                                "APPS: Sampler,Fishtank running=Sampler"]},
    )
    assert verbs.app_start(link, "Sampler", wait_s=2.0) == {"running": "Sampler"}
    assert link.fake.written[0] == "APP_START Sampler"
    assert link.fake.written.count("APP_LIST") >= 2


def test_app_start_err_raises_bad_args(make_link) -> None:
    link = make_link([("APP_START Nope", "ERR unknown app")])
    with pytest.raises(HilError) as ei:
        verbs.app_start(link, "Nope")
    assert ei.value.code == "BAD_ARGS"
    assert "unknown app" in ei.value.message
    assert "APP_LIST" not in link.fake.written


def test_app_start_never_running_times_out(make_link) -> None:
    link = make_link([("APP_START Sampler", "OK"),
                      ("APP_LIST", "APPS: Sampler running=-")])
    with pytest.raises(HilError) as ei:
        verbs.app_start(link, "Sampler", wait_s=0.5)
    assert ei.value.code == "TIMEOUT"


@pytest.mark.parametrize("name", ["", "x" * 32, "has space"])
def test_app_start_rejects_bad_name(make_link, name: str) -> None:
    link = make_link()
    with pytest.raises(HilError) as ei:
        verbs.app_start(link, name)
    assert ei.value.code == "BAD_ARGS"
    assert link.fake.written == []


@pytest.mark.parametrize("fn,cmd", [
    (verbs.app_stop, "APP_STOP"),
    (verbs.app_destroy, "APP_DESTROY"),
    (verbs.app_self_close, "APP_SELF_CLOSE"),
])
def test_app_ok_verbs(make_link, fn, cmd: str) -> None:
    link = make_link([(cmd, "OK")])
    assert fn(link) == {"ok": True}
    assert link.fake.written == [cmd]


def test_app_versions_reads_until_end(make_link) -> None:
    link = make_link([("APP_VERSIONS", [
        "APPVER: crosspad-core id=- commit=2d7c54b ref=main dirty=0",
        "APPVER: crosspad-sampler id=sampler commit=af6dbd0 ref=v1.2 dirty=1",
        "APPVER: end count=2",
    ])])
    out = verbs.app_versions(link)
    assert out["count"] == 2
    assert len(out["components"]) == 2
    assert out["components"][1] == {
        "component": "crosspad-sampler", "id": "sampler", "commit": "af6dbd0",
        "ref": "v1.2", "dirty": True}


# ── kit_* ──────────────────────────────────────────────────────────────

def test_kit_list(make_link) -> None:
    link = make_link([("KIT_LIST", "KITS: 0:Basic,1:Drums,2:808 current=1")])
    assert verbs.kit_list(link) == {
        "kits": [{"id": 0, "name": "Basic"}, {"id": 1, "name": "Drums"},
                 {"id": 2, "name": "808"}],
        "current": 1}


def test_kit_status(make_link) -> None:
    link = make_link([("KIT_STATUS", "KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS")])
    assert verbs.kit_status(link) == {
        "current": 3, "loading": False, "pending": -1, "name": "DRUMS"}


def test_kit_load_waits_until_landed_with_pending(make_link) -> None:
    # Two polls in flight (loading=1, then the request is pending behind another
    # load), third poll shows the kit landed. OK alone proves nothing
    # (hil_kit_churn: KIT_STATUS is the honest answer).
    link = make_link(
        [("KIT_LOAD 5", "OK")],
        sequences={"KIT_STATUS": [
            "KITSTATUS: current=2 loading=1 pending=-1 name=OLD",
            "KITSTATUS: current=2 loading=1 pending=5 name=OLD",
            "KITSTATUS: current=5 loading=0 pending=-1 name=DRUMS",
        ]},
    )
    out = verbs.kit_load(link, 5, wait_s=5.0)
    assert out == {"current": 5, "loading": False, "pending": -1, "name": "DRUMS"}
    assert link.fake.written[0] == "KIT_LOAD 5"
    assert link.fake.written.count("KIT_STATUS") == 3


def test_kit_load_current_but_still_loading_is_not_landed(make_link) -> None:
    link = make_link(
        [("KIT_LOAD 5", "OK")],
        sequences={"KIT_STATUS": [
            "KITSTATUS: current=5 loading=1 pending=-1 name=DRUMS",
            "KITSTATUS: current=5 loading=0 pending=-1 name=DRUMS",
        ]},
    )
    out = verbs.kit_load(link, 5, wait_s=5.0)
    assert out["loading"] is False
    assert link.fake.written.count("KIT_STATUS") == 2


def test_kit_load_timeout_reports_last_status(make_link) -> None:
    link = make_link([("KIT_LOAD 5", "OK"),
                      ("KIT_STATUS", "KITSTATUS: current=2 loading=1 pending=5 name=OLD")])
    with pytest.raises(HilError) as ei:
        verbs.kit_load(link, 5, wait_s=0.6)
    assert ei.value.code == "TIMEOUT"
    assert ei.value.details["status"]["pending"] == 5


def test_kit_load_err_bad_id(make_link) -> None:
    link = make_link([("KIT_LOAD 99", "ERR bad kit id")])
    with pytest.raises(HilError) as ei:
        verbs.kit_load(link, 99)
    assert ei.value.code == "BAD_ARGS"


def test_kit_load_negative_rejected_locally(make_link) -> None:
    link = make_link()
    with pytest.raises(HilError) as ei:
        verbs.kit_load(link, -1)
    assert ei.value.code == "BAD_ARGS"
    assert link.fake.written == []


# ── pad_* ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("idx,vel,ok", [
    (0, 127, True), (15, 1, True), (7, 0, True),
    (16, 100, False), (-1, 100, False), (3, 128, False), (3, -1, False),
])
def test_pad_press_range_check(make_link, idx: int, vel: int, ok: bool) -> None:
    link = make_link([(f"PAD_PRESS {idx} {vel}", "OK")])
    if ok:
        assert verbs.pad_press(link, idx, vel) == {"ok": True}
        assert link.fake.written == [f"PAD_PRESS {idx} {vel}"]
    else:
        with pytest.raises(HilError) as ei:
            verbs.pad_press(link, idx, vel)
        assert ei.value.code == "BAD_ARGS"
        assert link.fake.written == []


@pytest.mark.parametrize("idx,ok", [(0, True), (15, True), (16, False), (-1, False)])
def test_pad_release_range_check(make_link, idx: int, ok: bool) -> None:
    link = make_link([(f"PAD_RELEASE {idx}", "OK")])
    if ok:
        assert verbs.pad_release(link, idx) == {"ok": True}
    else:
        with pytest.raises(HilError) as ei:
            verbs.pad_release(link, idx)
        assert ei.value.code == "BAD_ARGS"


@pytest.mark.parametrize("idx,val,ok", [(0, 0, True), (15, 255, True), (2, 256, False), (16, 1, False)])
def test_pad_pressure_range_check(make_link, idx: int, val: int, ok: bool) -> None:
    link = make_link([(f"PAD_PRESSURE {idx} {val}", "OK")])
    if ok:
        assert verbs.pad_pressure(link, idx, val) == {"ok": True}
    else:
        with pytest.raises(HilError) as ei:
            verbs.pad_pressure(link, idx, val)
        assert ei.value.code == "BAD_ARGS"


def test_pad_stats_and_reset(make_link) -> None:
    link = make_link([("PAD_STATS", "PADSTATS: press=12 release=11 played=12 freeslots=6"),
                      ("PAD_STATS_RESET", "OK")])
    assert verbs.pad_stats(link) == {"press": 12, "release": 11, "played": 12, "freeslots": 6}
    assert "PAD_STATS_RESET" not in link.fake.written
    verbs.pad_stats(link, reset=True)
    assert link.fake.written[-2:] == ["PAD_STATS_RESET", "PAD_STATS"]


def test_pad_notes_int_keys(make_link) -> None:
    line = "PADNOTES:" + "".join(f" {i}:{36 + i}" for i in range(16))
    link = make_link([("PAD_NOTES", line)])
    notes = verbs.pad_notes(link)["notes"]
    assert len(notes) == 16
    assert notes[0] == 36 and notes[15] == 51
    assert all(isinstance(k, int) for k in notes)


def test_pad_info_raw(make_link) -> None:
    raw = "PADINFO: idx=3 num=39 kit=/sd/kits/DRUMS vol=100 pan=0 mode=0 dirty=0 count=1 | [0] 'kick.wav' 0..0"
    link = make_link([("PAD_INFO 3", raw)])
    assert verbs.pad_info(link, 3) == {"raw": raw}


# ── enc_* / ui ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("delta,ok", [(1, True), (-16, True), (16, True), (0, False), (17, False)])
def test_enc_rotate_range(make_link, delta: int, ok: bool) -> None:
    link = make_link([(f"ENC_ROTATE {delta}", "OK")])
    if ok:
        assert verbs.enc_rotate(link, delta) == {"ok": True}
    else:
        with pytest.raises(HilError) as ei:
            verbs.enc_rotate(link, delta)
        assert ei.value.code == "BAD_ARGS"


@pytest.mark.parametrize("ms,ok", [(80, True), (1, True), (5000, True), (0, False), (5001, False)])
def test_enc_press_range(make_link, ms: int, ok: bool) -> None:
    link = make_link([(f"ENC_PRESS {ms}", "OK")])
    if ok:
        assert verbs.enc_press(link, ms) == {"ok": True}
        assert link.fake.written == [f"ENC_PRESS {ms}"]
    else:
        with pytest.raises(HilError):
            verbs.enc_press(link, ms)


def test_enc_group_via_transact_multi(make_link) -> None:
    link = make_link([("ENC_GROUP", [
        "ENCGROUP: count=3",
        "  [0] 0x3fcb1234 Sampler",
        "  [1] 0x3fcb5678 Sequencer",
        "  [2] 0x3fcb9abc Settings",
    ])])
    out = verbs.enc_group(link)
    assert [g["ref"] for g in out["group"]] == ["e0", "e1", "e2"]
    assert out["group"][2] == {"ref": "e2", "index": 2, "ptr": "0x3fcb9abc", "label": "Settings"}


def test_enc_group_empty(make_link) -> None:
    link = make_link([("ENC_GROUP", ["ENCGROUP: count=0"])])
    assert verbs.enc_group(link) == {"group": []}


def test_enc_focus_and_state(make_link) -> None:
    link = make_link([("ENC_FOCUS", "ENCFOCUS: obj=0x3fcb5678 idx=1 text=Sequencer"),
                      ("ENC_STATE", "ENC: group=0x3fcb0001 launcher=0x3fcb0001 owner=launcher")])
    assert verbs.enc_focus(link) == {"index": 1, "label": "Sequencer", "ptr": "0x3fcb5678"}
    st = verbs.enc_state(link)
    assert st["owner"] == "launcher"


def test_ui_state(make_link) -> None:
    link = make_link([("UI_STATE",
                       "UI: display=yes touch=yes drawer=1 lcd=80 rgb=60 theme=2 bt_icon=hidden app=-")])
    ui = verbs.ui_state(link)
    assert ui["display"] == "yes"
    assert int(ui["theme"]) == 2


# ── led / mem / stats ──────────────────────────────────────────────────

def test_led_state_colors_length_16(make_link) -> None:
    colors = ",".join(f"{i:02X}00FF" for i in range(16))
    link = make_link([("LED_STATE",
                       f"LEDS: bri=40 anim=0 coalesce=1 cfgbri=60 pwr=0x00 pwrN=3 txfail=0 colors={colors}")])
    out = verbs.led_state(link)
    assert len(out["colors"]) == 16
    assert out["colors"][0] == "0000FF" and out["colors"][15] == "0F00FF"
    assert out["brightness"] == 40
    assert out["txfail"] == 0


def test_mem_ints(make_link) -> None:
    link = make_link([("MEM", "MEM: int_free=76000 int_largest=32000 int_min=18000 int_blocks=900 "
                              "psram_free=6000000 psram_largest=4000000 psram_blocks=300")])
    out = verbs.mem(link)
    assert out["int_free"] == 76000 and out["psram_blocks"] == 300


def test_mem_blocks_two_lines(make_link) -> None:
    link = make_link([("MEM_BLOCKS", [
        "MEMBLK: biggest_used=16384 | <=64 u=400/12000B f=10/300B | <=128 u=100/9000B f=2/200B "
        "| <=256 u=50/9000B f=1/200B | <=512 u=20/7000B f=0/0B | <=1k u=10/8000B f=1/700B "
        "| <=2k u=5/8000B f=0/0B | <=8k u=4/20000B f=1/5000B | <=big u=2/30000B f=1/20000B",
        "MEMBIG: @3fcb0000=16384 @3fcc0000=12288",
    ])])
    out = verbs.mem_blocks(link)
    assert out["summary"]["biggest_used"] == 16384
    assert len(out["summary"]["buckets"]) == 8
    assert out["big"] == [{"addr": "3fcb0000", "size": 16384}, {"addr": "3fcc0000", "size": 12288}]


def test_cdc_stats(make_link) -> None:
    link = make_link([("CDC_STATS", "CDCSTATS: rx=120 cmds=118 drop=2")])
    assert verbs.cdc_stats(link) == {"rx": 120, "cmds": 118, "drop": 2}


def test_audio_level_and_smpl_peak(make_link) -> None:
    link = make_link([("AUDIO_LEVEL", "AUDIOLVL: L=0.01234 R=0.00500 amp=1 allowed=1"),
                      ("SMPL_PEAK", "SMPLPEAK: 1234 free=7")])
    lvl = verbs.audio_level(link)
    assert lvl["amp"] is True and abs(lvl["left"] - 0.01234) < 1e-9
    assert verbs.smpl_peak(link) == {"peak": 1234, "free": 7}


# ── ble_* ──────────────────────────────────────────────────────────────

def test_ble_status_ints(make_link) -> None:
    link = make_link([("BLE_STATUS",
                       "BLE: supported=1 running=1 state=connected mode=server self=aa:bb:cc:dd:ee:ff "
                       "peer=11:22:33:44:55:66 itvl=15 txoff=36 rxoff=0 tx_msg=181 tx_pkt=90 "
                       "tx_drop=0 tx_err=0 rx_msg=3 rx_pkt=3")])
    st = verbs.ble_status(link)
    assert st["supported"] == 1 and st["running"] == 1
    assert st["itvl"] == 15 and st["txoff"] == 36 and st["tx_msg"] == 181
    assert st["state"] == "connected" and st["mode"] == "server"
    assert st["peer"] == "11:22:33:44:55:66"


def test_ble_start_modes(make_link) -> None:
    link = make_link([("BLE_START", "OK"), ("BLE_START 0", "OK"), ("BLE_START 1", "OK")])
    assert verbs.ble_start(link) == {"ok": True}
    assert verbs.ble_start(link, 0) == {"ok": True}
    assert verbs.ble_start(link, 1) == {"ok": True}
    assert link.fake.written == ["BLE_START", "BLE_START 0", "BLE_START 1"]
    with pytest.raises(HilError) as ei:
        verbs.ble_start(link, 2)
    assert ei.value.code == "BAD_ARGS"


def test_ble_start_err_is_not_supported(make_link) -> None:
    link = make_link([("BLE_START", "ERR")])
    with pytest.raises(HilError) as ei:
        verbs.ble_start(link)
    assert ei.value.code == "NOT_SUPPORTED"


def test_ble_scan_devices(make_link) -> None:
    link = make_link([("BLE_SCAN 3000", "OK"),
                      ("BLE_DEVICES", "BLEDEV: count=2 | aa:bb:cc:dd:ee:01 Piano -60 | aa:bb:cc:dd:ee:02 - -71")])
    assert verbs.ble_scan(link, 3000) == {"ok": True}
    dev = verbs.ble_devices(link)
    assert dev["count"] == 2
    assert dev["devices"][0] == {"addr": "aa:bb:cc:dd:ee:01", "name": "Piano", "rssi": -60}


@pytest.mark.parametrize("addr,ok", [
    ("aa:bb:cc:dd:ee:ff", True), ("AA:BB:CC:DD:EE:FF", True),
    ("aa-bb-cc-dd-ee-ff", False), ("aabbccddeeff", False), ("", False),
])
def test_ble_connect_addr_format(make_link, addr: str, ok: bool) -> None:
    link = make_link([(f"BLE_CONNECT {addr}", "OK")])
    if ok:
        assert verbs.ble_connect(link, addr) == {"ok": True}
    else:
        with pytest.raises(HilError) as ei:
            verbs.ble_connect(link, addr)
        assert ei.value.code == "BAD_ARGS"


def test_ble_send_txoff_disconnect_stop(make_link) -> None:
    link = make_link([("BLE_SEND 60 100", "OK"), ("BLE_TXOFF 36", "OK"),
                      ("BLE_DISCONNECT", "OK"), ("BLE_STOP", "OK")])
    assert verbs.ble_send(link, 60) == {"ok": True}
    assert verbs.ble_txoff(link, 36) == {"ok": True}
    assert verbs.ble_disconnect(link) == {"ok": True}
    assert verbs.ble_stop(link) == {"ok": True}
    with pytest.raises(HilError):
        verbs.ble_send(link, 128)
    with pytest.raises(HilError):
        verbs.ble_txoff(link, 128)


# ── misc ───────────────────────────────────────────────────────────────

def test_audio_tasks(make_link) -> None:
    link = make_link([("AUDIO_TASKS 1", "OK"), ("AUDIO_TASKS 0", "OK")])
    assert verbs.audio_tasks(link, True) == {"ok": True}
    assert verbs.audio_tasks(link, False) == {"ok": True}
    assert link.fake.written == ["AUDIO_TASKS 1", "AUDIO_TASKS 0"]


def test_bootloader_request_is_fire_and_forget(make_link) -> None:
    link = make_link()  # device never replies: it reboots into ROM download mode
    assert verbs.bootloader_request(link) == {"sent": True}
    assert link.fake.written == ["BOOTLOADER_REQUEST"]


def test_stm_dfu(make_link) -> None:
    link = make_link([("STM_DFU", "OK")])
    assert verbs.stm_dfu(link) == {"sent": True}


def test_unparseable_reply_is_not_supported(make_link) -> None:
    link = make_link([("KIT_STATUS", "KITSTATUS: garbage")])
    with pytest.raises(HilError) as ei:
        verbs.kit_status(link)
    assert ei.value.code == "NOT_SUPPORTED"


def test_verbs_table_covers_every_public_function() -> None:
    public = {n for n in dir(verbs) if not n.startswith("_")
              and callable(getattr(verbs, n)) and getattr(verbs, n).__module__ == verbs.__name__}
    assert set(verbs.VERBS) == public
    assert verbs.VERBS["kit_load"] is verbs.kit_load
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_verbs.py -q`
Expected: FAIL with `ImportError: cannot import name 'verbs' from 'crosspad_hil'` (or `ModuleNotFoundError: No module named 'crosspad_hil.verbs'`).

- [ ] **Step 3: Write the implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/verbs.py`:

```python
"""Typed CDC verbs: one function per firmware command in hil_control.cpp.

Every function takes a `CdcLink` first, validates its arguments locally
(HilError BAD_ARGS before a byte is written), sends the command and returns a
plain dict. Two hygiene rules from the old scripts are enforced here rather
than left to callers:

* `OK` is never the ack of *your* command (PAD_PRESS answers `OK` exactly like
  KIT_LOAD does — hil_kit_churn.py). `kit_load` therefore waits on KIT_STATUS
  and `app_start` polls APP_LIST; neither trusts the `OK`.
* A reply that cannot be parsed is reported as NOT_SUPPORTED with a hint —
  the usual cause is firmware that predates the verb.

Argument limits are copied from the sscanf guards in hil_control.cpp.
"""
from __future__ import annotations

import re
import time
from collections.abc import Callable
from typing import Any

from .cdc import CdcLink, Reply
from .errors import BAD_ARGS, NOT_SUPPORTED, TIMEOUT, HilError
from .parsers import parse_cdc_reply, parse_enc_group

_POLL_S = 0.25
_APP_NAME_MAX = 31          # hil_control.cpp: char name[32]; sscanf "%31s"
_BLE_ADDR_RE = re.compile(r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$")   # BLE_CONNECT %23s


# ── helpers ────────────────────────────────────────────────────────────

def _check_range(name: str, value: int, lo: int, hi: int) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < lo or value > hi:
        raise HilError(BAD_ARGS, f"{name} must be an int in {lo}..{hi}, got {value!r}",
                       hint=f"{name}={lo}..{hi}", arg=name, value=value)


def _raise_err(verb: str, reply: Reply, code: str) -> None:
    parsed = reply.parsed or {}
    message = parsed.get("message") or reply.line
    raise HilError(code, f"{verb}: device replied ERR {message}".rstrip(),
                   hint="the device rejected the command; check the arguments "
                        "and what the state verbs report", reply=reply.line)


def _kind(verb: str, reply: Reply, kind: str) -> dict[str, Any]:
    """The parsed reply if it is of `kind`, else NOT_SUPPORTED."""
    parsed = reply.parsed
    if parsed is not None and parsed.get("kind") == "err":
        _raise_err(verb, reply, NOT_SUPPORTED)
    if parsed is None or parsed.get("kind") != kind:
        raise HilError(NOT_SUPPORTED, f"{verb}: unparseable reply",
                       hint="firmware predates this verb?", line=reply.line)
    return parsed


def _ok(link: CdcLink, cmd: str, *, err_code: str = NOT_SUPPORTED) -> dict[str, Any]:
    """Send an OK/ERR verb. expect=None so cdc.yaml makes the link accept ERR too."""
    verb = cmd.split(" ", 1)[0]
    reply = link.transact(cmd, None)
    parsed = reply.parsed or {}
    if parsed.get("kind") == "err":
        _raise_err(verb, reply, err_code)
    if parsed.get("kind") != "ok":
        raise HilError(NOT_SUPPORTED, f"{verb}: unparseable reply",
                       hint="firmware predates this verb?", line=reply.line)
    return {"ok": True}


def _query(link: CdcLink, cmd: str, prefix: str, kind: str) -> dict[str, Any]:
    verb = cmd.split(" ", 1)[0]
    return _kind(verb, link.transact(cmd, prefix), kind)


def _without_kind(parsed: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in parsed.items() if k != "kind"}


# ── app_* ──────────────────────────────────────────────────────────────

def app_list(link: CdcLink) -> dict[str, Any]:
    p = _query(link, "APP_LIST", "APPS:", "apps")
    return {"apps": list(p.get("apps", [])), "running": p.get("running")}


def app_start(link: CdcLink, name: str, wait_s: float = 3.0) -> dict[str, Any]:
    if not isinstance(name, str) or not name or len(name) > _APP_NAME_MAX \
            or any(ch.isspace() for ch in name):
        raise HilError(BAD_ARGS, f"app name must be 1..{_APP_NAME_MAX} chars without "
                       f"whitespace, got {name!r}", hint="APP_LIST names the apps", name=name)
    _ok(link, f"APP_START {name}", err_code=BAD_ARGS)
    # The OK only means the launch was queued on the LVGL thread (hil_control.cpp
    # lv_async_call_locked). APP_LIST running= is the state that proves it.
    deadline = time.monotonic() + max(0.0, wait_s)
    last: str | None = None
    while True:
        last = app_list(link)["running"]
        if last is not None and last.lower() == name.lower():
            return {"running": last}
        if time.monotonic() >= deadline:
            break
        time.sleep(_POLL_S)
    raise HilError(TIMEOUT, f"APP_START {name}: not running after {wait_s:.1f}s "
                   f"(APP_LIST running={last or '-'})",
                   hint="another app may still be tearing down; APP_DESTROY first",
                   running=last, name=name)


def app_stop(link: CdcLink) -> dict[str, Any]:
    return _ok(link, "APP_STOP")


def app_destroy(link: CdcLink) -> dict[str, Any]:
    return _ok(link, "APP_DESTROY")


def app_self_close(link: CdcLink) -> dict[str, Any]:
    return _ok(link, "APP_SELF_CLOSE")


def app_versions(link: CdcLink) -> dict[str, Any]:
    # hil_control.cpp handle_app_versions: one "APPVER: <component> id=… commit=…
    # ref=… dirty=…" per component, then "APPVER: end count=N".
    lines = link.transact_multi("APP_VERSIONS", "APPVER:", end="APPVER: end")
    components: list[dict[str, Any]] = []
    count: int | None = None
    for line in lines:
        parsed = parse_cdc_reply(line)
        if not parsed or parsed.get("kind") != "appver":
            continue
        if parsed.get("end"):
            count = int(parsed.get("count", len(components)))
            continue
        components.append({
            "component": parsed.get("component"),
            "id": parsed.get("id"),
            "commit": parsed.get("commit"),
            "ref": parsed.get("ref"),
            "dirty": bool(parsed.get("dirty", False)),
        })
    if count is None:
        raise HilError(NOT_SUPPORTED, "APP_VERSIONS: no 'APPVER: end' line",
                       hint="firmware predates APP_VERSIONS", lines=lines)
    return {"components": components, "count": count}


# ── kit_* ──────────────────────────────────────────────────────────────

def kit_list(link: CdcLink) -> dict[str, Any]:
    p = _query(link, "KIT_LIST", "KITS:", "kits")
    kits = [{"id": int(k["id"]), "name": str(k["name"])} for k in p.get("kits", [])]
    return {"kits": kits, "current": int(p.get("current", -1))}


def kit_status(link: CdcLink) -> dict[str, Any]:
    p = _query(link, "KIT_STATUS", "KITSTATUS:", "kitstatus")
    return {"current": int(p["current"]), "loading": bool(p["loading"]),
            "pending": int(p["pending"]), "name": p.get("name")}


def kit_load(link: CdcLink, kit_id: int, wait_s: float = 15.0) -> dict[str, Any]:
    if not isinstance(kit_id, int) or isinstance(kit_id, bool) or kit_id < 0:
        raise HilError(BAD_ARGS, f"kit_id must be a non-negative int, got {kit_id!r}",
                       hint="KIT_LIST names the kits", kit_id=kit_id)
    _ok(link, f"KIT_LOAD {kit_id}", err_code=BAD_ARGS)
    # From hil_kit_churn.parse_status: landed == current==kit and not loading and
    # nothing pending. KIT_LIST's current= alone cannot tell "loading" from
    # "the request went nowhere".
    deadline = time.monotonic() + max(0.0, wait_s)
    status = kit_status(link)
    while True:
        if status["current"] == kit_id and not status["loading"] and status["pending"] == -1:
            return status
        if time.monotonic() >= deadline:
            break
        time.sleep(_POLL_S)
        status = kit_status(link)
    raise HilError(TIMEOUT, f"KIT_LOAD {kit_id}: not current after {wait_s:.1f}s "
                   f"(current={status['current']} loading={int(status['loading'])} "
                   f"pending={status['pending']})",
                   hint="a load that never finishes blocks every later swap; "
                        "check the console for SD errors", status=status, kit_id=kit_id)


# ── pad_* ──────────────────────────────────────────────────────────────

def pad_press(link: CdcLink, idx: int, vel: int = 127) -> dict[str, Any]:
    _check_range("idx", idx, 0, 15)
    _check_range("vel", vel, 0, 127)
    return _ok(link, f"PAD_PRESS {idx} {vel}")


def pad_release(link: CdcLink, idx: int) -> dict[str, Any]:
    _check_range("idx", idx, 0, 15)
    return _ok(link, f"PAD_RELEASE {idx}")


def pad_pressure(link: CdcLink, idx: int, val: int) -> dict[str, Any]:
    _check_range("idx", idx, 0, 15)
    _check_range("val", val, 0, 255)
    return _ok(link, f"PAD_PRESSURE {idx} {val}")


def pad_stats(link: CdcLink, reset: bool = False) -> dict[str, Any]:
    if reset:
        _ok(link, "PAD_STATS_RESET")
    p = _query(link, "PAD_STATS", "PADSTATS:", "padstats")
    return {"press": int(p["press"]), "release": int(p["release"]),
            "played": int(p["played"]), "freeslots": int(p["freeslots"])}


def pad_notes(link: CdcLink) -> dict[str, Any]:
    p = _query(link, "PAD_NOTES", "PADNOTES:", "padnotes")
    return {"notes": {int(k): int(v) for k, v in p.get("notes", {}).items()}}


def pad_info(link: CdcLink, idx: int) -> dict[str, Any]:
    _check_range("idx", idx, 0, 15)
    reply = link.transact(f"PAD_INFO {idx}", "PADINFO:")
    if reply.parsed is not None and reply.parsed.get("kind") == "err":
        _raise_err("PAD_INFO", reply, BAD_ARGS)
    if not reply.line.startswith("PADINFO:"):
        raise HilError(NOT_SUPPORTED, "PAD_INFO: unparseable reply",
                       hint="firmware predates this verb?", line=reply.line)
    return {"raw": reply.line}


# ── enc_* / ui ─────────────────────────────────────────────────────────

def enc_rotate(link: CdcLink, delta: int) -> dict[str, Any]:
    _check_range("delta", delta, -16, 16)      # firmware clamps at ±16
    if delta == 0:
        raise HilError(BAD_ARGS, "delta must be non-zero (ENC_ROTATE 0 is ignored)",
                       hint="delta=-16..16, not 0", arg="delta", value=0)
    return _ok(link, f"ENC_ROTATE {delta}")


def enc_press(link: CdcLink, ms: int = 80) -> dict[str, Any]:
    _check_range("ms", ms, 1, 5000)            # firmware clamps at 5000
    return _ok(link, f"ENC_PRESS {ms}")


def enc_group(link: CdcLink) -> dict[str, Any]:
    # "ENCGROUP: count=N" then N lines "  [i] <ptr> <label>"; no end marker, so
    # the link reads until the port goes idle.
    lines = link.transact_multi("ENC_GROUP", "ENCGROUP:", end=None)
    if not lines:
        raise HilError(NOT_SUPPORTED, "ENC_GROUP: no reply",
                       hint="firmware predates this verb?")
    if lines[0].startswith("ENCGROUP: ERR"):
        raise HilError(TIMEOUT, f"ENC_GROUP: {lines[0]}",
                       hint="LVGL lock held >1 s; the UI thread is busy or stuck",
                       line=lines[0])
    return {"group": parse_enc_group(lines)}


def enc_focus(link: CdcLink) -> dict[str, Any]:
    reply = link.transact("ENC_FOCUS", "ENCFOCUS:")
    if reply.line.startswith("ENCFOCUS: ERR"):
        raise HilError(TIMEOUT, f"ENC_FOCUS: {reply.line}",
                       hint="LVGL lock held >1 s; the UI thread is busy or stuck",
                       line=reply.line)
    p = _kind("ENC_FOCUS", reply, "encfocus")
    return {"index": int(p["index"]), "label": str(p.get("label", "")), "ptr": str(p["ptr"])}


def enc_state(link: CdcLink) -> dict[str, Any]:
    return _without_kind(_query(link, "ENC_STATE", "ENC:", "enc"))


def ui_state(link: CdcLink) -> dict[str, Any]:
    return _without_kind(_query(link, "UI_STATE", "UI:", "ui"))


# ── led / mem / stats ──────────────────────────────────────────────────

def led_state(link: CdcLink) -> dict[str, Any]:
    p = _without_kind(_query(link, "LED_STATE", "LEDS:", "leds"))
    colors = list(p.get("colors", []))
    if len(colors) != 16:
        raise HilError(NOT_SUPPORTED, f"LED_STATE: expected 16 colors, got {len(colors)}",
                       hint="truncated reply?", colors=colors)
    p["colors"] = colors
    return p


def mem(link: CdcLink) -> dict[str, Any]:
    return _without_kind(_query(link, "MEM", "MEM:", "mem"))


def mem_blocks(link: CdcLink) -> dict[str, Any]:
    # Two lines by design (hil_control.cpp: the CDC endpoint takes ~512 B per
    # write, the block list would be cut off if it shared the first).
    lines = link.transact_multi("MEM_BLOCKS", "MEMBLK:", end="MEMBIG:")
    summary: dict[str, Any] | None = None
    big: list[dict[str, Any]] = []
    for line in lines:
        parsed = parse_cdc_reply(line)
        if not parsed:
            continue
        if parsed.get("kind") == "memblk":
            summary = _without_kind(parsed)
        elif parsed.get("kind") == "membig":
            big = list(parsed.get("blocks", []))
    if summary is None:
        raise HilError(NOT_SUPPORTED, "MEM_BLOCKS: no MEMBLK line",
                       hint="firmware predates this verb?", lines=lines)
    return {"summary": summary, "big": big}


def cdc_stats(link: CdcLink) -> dict[str, Any]:
    p = _query(link, "CDC_STATS", "CDCSTATS:", "cdcstats")
    return {"rx": int(p["rx"]), "cmds": int(p["cmds"]), "drop": int(p["drop"])}


def audio_level(link: CdcLink) -> dict[str, Any]:
    p = _query(link, "AUDIO_LEVEL", "AUDIOLVL:", "audiolvl")
    return {"left": float(p["left"]), "right": float(p["right"]),
            "amp": bool(p["amp"]), "allowed": bool(p["allowed"])}


def smpl_peak(link: CdcLink) -> dict[str, Any]:
    p = _query(link, "SMPL_PEAK", "SMPLPEAK:", "smplpeak")
    return {"peak": int(p["peak"]), "free": int(p["free"])}


# ── ble_* ──────────────────────────────────────────────────────────────

def ble_status(link: CdcLink) -> dict[str, Any]:
    return _without_kind(_query(link, "BLE_STATUS", "BLE:", "ble"))


def ble_start(link: CdcLink, mode: int | None = None) -> dict[str, Any]:
    # BLE_START [0|1] — 0 = Host (central), 1 = Server (peripheral); no arg =
    # the mode in settings.
    if mode is None:
        return _ok(link, "BLE_START")
    _check_range("mode", mode, 0, 1)
    return _ok(link, f"BLE_START {mode}")


def ble_stop(link: CdcLink) -> dict[str, Any]:
    return _ok(link, "BLE_STOP")


def ble_scan(link: CdcLink, ms: int = 5000) -> dict[str, Any]:
    _check_range("ms", ms, 1, 65535)           # startScan((uint16_t)a)
    return _ok(link, f"BLE_SCAN {ms}")


def ble_devices(link: CdcLink) -> dict[str, Any]:
    p = _query(link, "BLE_DEVICES", "BLEDEV:", "bledev")
    devices = [{"addr": d["addr"], "name": d.get("name"), "rssi": int(d["rssi"])}
               for d in p.get("devices", [])]
    return {"count": int(p.get("count", len(devices))), "devices": devices}


def ble_connect(link: CdcLink, addr: str) -> dict[str, Any]:
    if not isinstance(addr, str) or not _BLE_ADDR_RE.match(addr):
        raise HilError(BAD_ARGS, f"addr must look like aa:bb:cc:dd:ee:ff, got {addr!r}",
                       hint="BLE_DEVICES lists addresses after BLE_SCAN", addr=addr)
    return _ok(link, f"BLE_CONNECT {addr}", err_code=BAD_ARGS)


def ble_disconnect(link: CdcLink) -> dict[str, Any]:
    return _ok(link, "BLE_DISCONNECT")


def ble_send(link: CdcLink, note: int, vel: int = 100) -> dict[str, Any]:
    _check_range("note", note, 0, 127)
    _check_range("vel", vel, 0, 127)
    return _ok(link, f"BLE_SEND {note} {vel}")


def ble_txoff(link: CdcLink, semis: int) -> dict[str, Any]:
    _check_range("semis", semis, -127, 127)
    return _ok(link, f"BLE_TXOFF {semis}")


# ── misc ───────────────────────────────────────────────────────────────

def audio_tasks(link: CdcLink, on: bool) -> dict[str, Any]:
    return _ok(link, f"AUDIO_TASKS {1 if on else 0}")


def bootloader_request(link: CdcLink) -> dict[str, Any]:
    # requestBootloader.py CDC_MESSAGE. The device drops into ROM download mode
    # and never answers; the CDC port disappears and re-enumerates as
    # 0x303A:{0x1001,0x0009}.
    link.send("BOOTLOADER_REQUEST")
    return {"sent": True}


def stm_dfu(link: CdcLink) -> dict[str, Any]:
    _ok(link, "STM_DFU")
    return {"sent": True}


VERBS: dict[str, Callable[..., dict[str, Any]]] = {
    "app_list": app_list, "app_start": app_start, "app_stop": app_stop,
    "app_destroy": app_destroy, "app_self_close": app_self_close,
    "app_versions": app_versions,
    "kit_list": kit_list, "kit_status": kit_status, "kit_load": kit_load,
    "pad_press": pad_press, "pad_release": pad_release, "pad_pressure": pad_pressure,
    "pad_stats": pad_stats, "pad_notes": pad_notes, "pad_info": pad_info,
    "enc_rotate": enc_rotate, "enc_press": enc_press, "enc_group": enc_group,
    "enc_focus": enc_focus, "enc_state": enc_state, "ui_state": ui_state,
    "led_state": led_state, "mem": mem, "mem_blocks": mem_blocks,
    "cdc_stats": cdc_stats, "audio_level": audio_level, "smpl_peak": smpl_peak,
    "ble_status": ble_status, "ble_start": ble_start, "ble_stop": ble_stop,
    "ble_scan": ble_scan, "ble_devices": ble_devices, "ble_connect": ble_connect,
    "ble_disconnect": ble_disconnect, "ble_send": ble_send, "ble_txoff": ble_txoff,
    "audio_tasks": audio_tasks, "bootloader_request": bootloader_request,
    "stm_dfu": stm_dfu,
}
```

`errors.py` must export the code constants `BAD_ARGS`, `NOT_SUPPORTED`, `TIMEOUT` as module-level strings (contract: "Codes (string constants in errors.py)"); if the earlier task named them differently, import the string literals instead — the values are `"BAD_ARGS"`, `"NOT_SUPPORTED"`, `"TIMEOUT"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_verbs.py -q && ruff check crosspad_hil/verbs.py tests/test_verbs.py`
Expected: `… passed` (55+ tests, ~5 s: the timeout tests sleep 0.5–0.6 s each), ruff `All checks passed!`.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/verbs.py tests/test_verbs.py
git commit -m "feat(verbs): typed CDC verbs with local validation and state-verb confirmation"
```

---

### Task 9: Device snapshot (`snapshot.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/snapshot.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_snapshot.py`

**Interfaces:**
- Consumes:
  - `crosspad_hil.verbs` — `app_list, enc_focus, enc_group, ui_state, kit_status, led_state, pad_stats, pad_notes, mem, ble_status` (Task 8 signatures above)
  - `crosspad_hil.cdc.CdcLink`; `crosspad_hil.console.Console.snapshot() -> dict` (keys used: `fatals`, `reboots`, `cdc_drops`, `seq`)
  - `crosspad_hil.devices.Device` (`id: str`, `usb_mode: UsbMode`), `UsbMode`, `Ports`
  - `crosspad_hil.errors.HilError`, code `BAD_ARGS`
- Produces (contract §snapshot.py):
  - `DEFAULT_INCLUDE = ("apps", "ui", "kit", "leds", "pads", "mem", "ble", "console")`
  - `@dataclass class Snapshot: snapshot_id: str; device: str; usb_mode: str; apps: dict | None; ui: dict | None; kit: dict | None; leds: dict | None; pads: dict | None; mem: dict | None; ble: dict | None; console: dict | None; ts: float; changed: list[str]` with `to_dict(self) -> dict`
  - `take_snapshot(device: Device, link: CdcLink, *, console: Console | None = None, include: Sequence[str] = DEFAULT_INCLUDE, previous: Snapshot | None = None, counter: itertools.count | None = None) -> Snapshot`
  - `ref_to_delta(group: list[dict], focus_index: int, ref: str) -> int`
- Decisions where the contract is silent:
  - `snapshot_id` = `f"snap_{next(counter)}"` when a counter is given, else `"snap_" + uuid4().hex[:6]` (a counter is what `serve.py` passes to keep ids monotonic per daemon; the CLI takes one snapshot per process).
  - Section shapes: `apps` = `app_list()`; `kit` = `kit_status()`; `leds` = `led_state()`; `pads` = `pad_stats()` plus `"notes": pad_notes()["notes"]`; `mem` = `mem()`; `ble` = `ble_status()`; `ui` = `{"focus": {"ref": str|None, "index": int, "label": str}, "group": [...], "drawer": bool, "theme": int, "app": str|None}` where `focus.ref`/`focus.index` come from matching `ENCFOCUS obj=` pointer against the `ENC_GROUP` pointers (`ENCFOCUS idx=` is `lv_obj_get_index`, the child index in the parent, **not** the group index) — unmatched pointer → `ref None`, `index -1`; `console` = `{"handle": None, "fatals": [...], "reboots": int, "cdc_drops": int, "since_seq": int}` (the daemon fills `handle`).
  - An unknown name in `include` raises `HilError(BAD_ARGS)`; `"console"` in `include` with `console=None` yields `console=None` (not an error — the CLI has no console by default).
  - A section whose verb raises `HilError` is recorded as `{"error": err.to_dict()}` so one dead verb (e.g. `BLE:` on firmware without NimBLE, or a slow `MEM_BLOCKS`) does not sink the whole snapshot; a `TIMEOUT` on the very first section is re-raised because it means the link is dead.
  - `changed` = every key in `include` ∪ `{"usb_mode"}` whose value differs (`!=`) from `previous`; the mem section is compared on `int_free`, `psram_free` and `int_largest` only so every snapshot does not report `mem` changed for a 16-byte wobble. First snapshot (`previous None`) → `changed == []`.
  - `ref_to_delta`: the item whose `ref` equals `ref` → `item["index"] - focus_index`; unknown → `HilError(BAD_ARGS, …, hint="refs come from the latest snapshot's ui.group", ref=ref, known=[...])`.

- [ ] **Step 1: Write the failing tests**

`/home/matixan/GIT/crosspad-hil/tests/test_snapshot.py`:

```python
"""take_snapshot over a scripted FakeSerial, ref arithmetic. No hardware."""
from __future__ import annotations

import itertools
import uuid
from collections.abc import Iterator

import pytest

from crosspad_hil import snapshot as snap
from crosspad_hil.cdc import CdcLink
from crosspad_hil.devices import Device, Ports, UsbMode
from crosspad_hil.errors import HilError
from tests.fakes import FakeSerial

LEDS = "LEDS: bri=40 anim=0 coalesce=1 cfgbri=60 pwr=0x00 pwrN=3 txfail=0 colors=" + \
    ",".join("000000" for _ in range(16))
PADNOTES = "PADNOTES:" + "".join(f" {i}:{36 + i}" for i in range(16))
BLE = ("BLE: supported=1 running=0 state=idle mode=server self=- peer=- itvl=0 "
       "txoff=0 rxoff=0 tx_msg=0 tx_pkt=0 tx_drop=0 tx_err=0 rx_msg=0 rx_pkt=0")
MEM = ("MEM: int_free=76000 int_largest=32000 int_min=18000 int_blocks=900 "
       "psram_free=6000000 psram_largest=4000000 psram_blocks=300")


def full_script(*, running: str = "-", focus_ptr: str = "0x3fcb5678", kit: int = 3,
                int_free: int = 76000) -> list[tuple[str, str | list[str]]]:
    return [
        ("APP_LIST", f"APPS: Sampler,Sequencer,Settings running={running}"),
        ("ENC_FOCUS", f"ENCFOCUS: obj={focus_ptr} idx=7 text=Sequencer"),
        ("ENC_GROUP", ["ENCGROUP: count=3",
                       "  [0] 0x3fcb1234 Sampler",
                       "  [1] 0x3fcb5678 Sequencer",
                       "  [2] 0x3fcb9abc Settings"]),
        ("UI_STATE", "UI: display=yes touch=yes drawer=1 lcd=80 rgb=60 theme=2 bt_icon=hidden app=-"),
        ("KIT_STATUS", f"KITSTATUS: current={kit} loading=0 pending=-1 name=DRUMS"),
        ("LED_STATE", LEDS),
        ("PAD_STATS", "PADSTATS: press=12 release=11 played=12 freeslots=6"),
        ("PAD_NOTES", PADNOTES),
        ("MEM", MEM.replace("int_free=76000", f"int_free={int_free}")),
        ("BLE_STATUS", BLE),
    ]


class FakeConsole:
    """Only what take_snapshot reads: Console.snapshot()."""

    def __init__(self, fatals=(), reboots: int = 0, cdc_drops: int = 0, seq: int = 100) -> None:
        self._d = {"fatals": list(fatals), "reboots": reboots, "cdc_drops": cdc_drops,
                   "seq": seq, "lines_lost": 0, "log_path": None, "port": "/dev/fake"}

    def snapshot(self) -> dict:
        return dict(self._d)


def make_device() -> Device:
    return Device(id="dev_3f2a", serial="ABC123", usb_mode=UsbMode.DEFAULT, ports=Ports())


@pytest.fixture
def make_link() -> Iterator:
    opened: list[CdcLink] = []

    def _make(script) -> CdcLink:
        fake = FakeSerial(list(script))
        link = CdcLink(f"fake-snap-{uuid.uuid4().hex[:8]}",
                       serial_factory=lambda path, **kw: fake)
        link.open()
        link.fake = fake  # type: ignore[attr-defined]
        opened.append(link)
        return link

    yield _make
    for link in opened:
        link.close()


def test_full_snapshot_shape(make_link) -> None:
    link = make_link(full_script())
    s = snap.take_snapshot(make_device(), link, console=FakeConsole(seq=4321),
                           counter=itertools.count(1))
    assert s.snapshot_id == "snap_1"
    assert s.device == "dev_3f2a" and s.usb_mode == "default"
    assert s.apps == {"apps": ["Sampler", "Sequencer", "Settings"], "running": None}
    assert s.ui["focus"] == {"ref": "e1", "index": 1, "label": "Sequencer"}
    assert [g["ref"] for g in s.ui["group"]] == ["e0", "e1", "e2"]
    assert s.ui["drawer"] is True and s.ui["theme"] == 2 and s.ui["app"] is None
    assert s.kit == {"current": 3, "loading": False, "pending": -1, "name": "DRUMS"}
    assert len(s.leds["colors"]) == 16
    assert s.pads["press"] == 12 and s.pads["notes"][0] == 36
    assert s.mem["int_free"] == 76000
    assert s.ble["supported"] == 1
    assert s.console == {"handle": None, "fatals": [], "reboots": 0, "cdc_drops": 0,
                         "since_seq": 4321}
    assert s.changed == []
    assert s.ts > 0
    d = s.to_dict()
    assert set(d) == {"snapshot_id", "device", "usb_mode", "apps", "ui", "kit", "leds",
                      "pads", "mem", "ble", "console", "ts", "changed"}


def test_snapshot_ids_advance_with_counter(make_link) -> None:
    link = make_link(full_script())
    c = itertools.count(7)
    assert snap.take_snapshot(make_device(), link, include=("kit",), counter=c).snapshot_id == "snap_7"
    assert snap.take_snapshot(make_device(), link, include=("kit",), counter=c).snapshot_id == "snap_8"


def test_include_subset_only_sends_those_verbs(make_link) -> None:
    link = make_link(full_script())
    s = snap.take_snapshot(make_device(), link, include=("kit", "leds"))
    assert s.kit is not None and s.leds is not None
    assert s.apps is None and s.ui is None and s.pads is None
    assert s.mem is None and s.ble is None and s.console is None
    assert set(link.fake.written) == {"KIT_STATUS", "LED_STATE"}


def test_include_unknown_section_is_bad_args(make_link) -> None:
    link = make_link(full_script())
    with pytest.raises(HilError) as ei:
        snap.take_snapshot(make_device(), link, include=("kit", "bogus"))
    assert ei.value.code == "BAD_ARGS"
    assert link.fake.written == []


def test_console_section_without_console_is_none(make_link) -> None:
    link = make_link(full_script())
    s = snap.take_snapshot(make_device(), link, include=("console", "kit"))
    assert s.console is None and s.kit is not None


def test_focus_pointer_not_in_group(make_link) -> None:
    link = make_link(full_script(focus_ptr="0x0"))
    s = snap.take_snapshot(make_device(), link, include=("ui",))
    assert s.ui["focus"] == {"ref": None, "index": -1, "label": "Sequencer"}


def test_changed_detection(make_link) -> None:
    first = snap.take_snapshot(make_device(), make_link(full_script()), include=("apps", "kit", "mem"))
    same = snap.take_snapshot(make_device(), make_link(full_script()),
                              include=("apps", "kit", "mem"), previous=first)
    assert same.changed == []
    later = snap.take_snapshot(make_device(), make_link(full_script(running="Sampler", kit=5)),
                               include=("apps", "kit", "mem"), previous=first)
    assert sorted(later.changed) == ["apps", "kit"]


def test_changed_ignores_small_mem_wobble_but_sees_free_change(make_link) -> None:
    first = snap.take_snapshot(make_device(), make_link(full_script()), include=("mem",))
    wobble = snap.take_snapshot(make_device(), make_link(full_script(int_free=76000)),
                                include=("mem",), previous=first)
    assert wobble.changed == []
    drop = snap.take_snapshot(make_device(), make_link(full_script(int_free=60000)),
                              include=("mem",), previous=first)
    assert drop.changed == ["mem"]


def test_changed_includes_usb_mode(make_link) -> None:
    first = snap.take_snapshot(make_device(), make_link(full_script()), include=("kit",))
    dev = make_device()
    dev.usb_mode = UsbMode.AUDIO
    second = snap.take_snapshot(dev, make_link(full_script()), include=("kit",), previous=first)
    assert second.changed == ["usb_mode"]


def test_failed_section_recorded_not_raised(make_link) -> None:
    script = [s for s in full_script() if s[0] != "BLE_STATUS"]
    script.append(("BLE_STATUS", "ERR"))
    link = make_link(script)
    s = snap.take_snapshot(make_device(), link, include=("kit", "ble"))
    assert s.kit["current"] == 3
    assert "error" in s.ble and s.ble["error"]["code"] == "NOT_SUPPORTED"


GROUP = [{"ref": "e0", "index": 0, "ptr": "0x1", "label": "A"},
         {"ref": "e1", "index": 1, "ptr": "0x2", "label": "B"},
         {"ref": "e2", "index": 2, "ptr": "0x3", "label": "C"}]


def test_ref_to_delta_positive() -> None:
    assert snap.ref_to_delta(GROUP, 0, "e2") == 2


def test_ref_to_delta_negative() -> None:
    assert snap.ref_to_delta(GROUP, 2, "e0") == -2


def test_ref_to_delta_zero() -> None:
    assert snap.ref_to_delta(GROUP, 1, "e1") == 0


def test_ref_to_delta_unknown() -> None:
    with pytest.raises(HilError) as ei:
        snap.ref_to_delta(GROUP, 0, "e9")
    assert ei.value.code == "BAD_ARGS"
    assert ei.value.details["known"] == ["e0", "e1", "e2"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_snapshot.py -q`
Expected: FAIL with `ImportError: cannot import name 'snapshot' from 'crosspad_hil'`.

- [ ] **Step 3: Write the implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/snapshot.py`:

```python
"""One-call device state with UI refs.

A snapshot is what `ui focus REF` and the MCP `crosspad_ui` tool navigate from:
`ENC_GROUP` gives every widget the encoder can reach, `ENC_FOCUS` where it is
now, and `ref_to_delta()` turns a ref from the last snapshot into the
`ENC_ROTATE` count that reaches it. Everything else is the state verbs, one
section each, so a failed verb costs one section and not the whole picture.
"""
from __future__ import annotations

import itertools
import time
import uuid
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any

from . import verbs
from .cdc import CdcLink
from .console import Console
from .devices import Device
from .errors import BAD_ARGS, TIMEOUT, HilError

DEFAULT_INCLUDE = ("apps", "ui", "kit", "leds", "pads", "mem", "ble", "console")
_MEM_COMPARE_KEYS = ("int_free", "psram_free", "int_largest")


@dataclass
class Snapshot:
    snapshot_id: str
    device: str
    usb_mode: str
    apps: dict | None
    ui: dict | None
    kit: dict | None
    leds: dict | None
    pads: dict | None
    mem: dict | None
    ble: dict | None
    console: dict | None
    ts: float
    changed: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


def _none_if_dash(value: Any) -> str | None:
    if value is None or value == "-" or value == "":
        return None
    return str(value)


def _section_ui(link: CdcLink) -> dict[str, Any]:
    focus = verbs.enc_focus(link)
    group = verbs.enc_group(link)["group"]
    ui = verbs.ui_state(link)
    # ENCFOCUS idx= is lv_obj_get_index (child index in the parent), not the
    # group position. Match the object pointer against ENC_GROUP to get the
    # index the refs are minted from.
    ref: str | None = None
    index = -1
    for item in group:
        if item["ptr"] == focus["ptr"]:
            ref = item["ref"]
            index = int(item["index"])
            break
    return {
        "focus": {"ref": ref, "index": index, "label": focus["label"]},
        "group": group,
        "drawer": bool(int(ui.get("drawer", 0))),
        "theme": int(ui.get("theme", 0)),
        "app": _none_if_dash(ui.get("app")),
    }


def _section_pads(link: CdcLink) -> dict[str, Any]:
    out = verbs.pad_stats(link)
    out["notes"] = verbs.pad_notes(link)["notes"]
    return out


def _section_console(console: Console | None) -> dict[str, Any] | None:
    if console is None:
        return None
    d = console.snapshot()
    return {
        "handle": None,
        "fatals": list(d.get("fatals", [])),
        "reboots": int(d.get("reboots", 0)),
        "cdc_drops": int(d.get("cdc_drops", 0)),
        "since_seq": int(d.get("seq", 0)),
    }


def _mem_key(section: dict | None) -> Any:
    if not isinstance(section, dict) or "error" in section:
        return section
    return tuple(section.get(k) for k in _MEM_COMPARE_KEYS)


def _changed(current: dict[str, Any], previous: Snapshot | None,
             keys: Sequence[str]) -> list[str]:
    if previous is None:
        return []
    prev = previous.to_dict()
    changed: list[str] = []
    for key in keys:
        a, b = current.get(key), prev.get(key)
        if key == "mem":
            a, b = _mem_key(a), _mem_key(b)
        if a != b:
            changed.append(key)
    return changed


def take_snapshot(device: Device, link: CdcLink, *, console: Console | None = None,
                  include: Sequence[str] = DEFAULT_INCLUDE, previous: Snapshot | None = None,
                  counter: itertools.count | None = None) -> Snapshot:
    include = tuple(include)
    unknown = [k for k in include if k not in DEFAULT_INCLUDE]
    if unknown:
        raise HilError(BAD_ARGS, f"unknown snapshot section(s): {', '.join(unknown)}",
                       hint=f"include must be a subset of {list(DEFAULT_INCLUDE)}",
                       unknown=unknown)

    readers = {
        "apps": lambda: verbs.app_list(link),
        "ui": lambda: _section_ui(link),
        "kit": lambda: verbs.kit_status(link),
        "leds": lambda: verbs.led_state(link),
        "pads": lambda: _section_pads(link),
        "mem": lambda: verbs.mem(link),
        "ble": lambda: verbs.ble_status(link),
    }
    sections: dict[str, dict | None] = {k: None for k in DEFAULT_INCLUDE}
    first_device_section = True
    for key in include:
        if key == "console":
            sections["console"] = _section_console(console)
            continue
        try:
            sections[key] = readers[key]()
        except HilError as err:
            # A dead link shows up as a timeout on the first thing asked; every
            # later timeout is that one verb (or a UI lock) and stays local.
            if err.code == TIMEOUT and first_device_section:
                raise
            sections[key] = {"error": err.to_dict()}
        first_device_section = False

    usb_mode = device.usb_mode.value if hasattr(device.usb_mode, "value") else str(device.usb_mode)
    current = {**sections, "usb_mode": usb_mode}
    changed = _changed(current, previous, [*include, "usb_mode"])
    snapshot_id = f"snap_{next(counter)}" if counter is not None else f"snap_{uuid.uuid4().hex[:6]}"
    return Snapshot(
        snapshot_id=snapshot_id,
        device=device.id,
        usb_mode=usb_mode,
        apps=sections["apps"],
        ui=sections["ui"],
        kit=sections["kit"],
        leds=sections["leds"],
        pads=sections["pads"],
        mem=sections["mem"],
        ble=sections["ble"],
        console=sections["console"],
        ts=time.time(),
        changed=changed,
    )


def ref_to_delta(group: list[dict], focus_index: int, ref: str) -> int:
    for item in group:
        if item.get("ref") == ref:
            return int(item["index"]) - int(focus_index)
    known = [str(item.get("ref")) for item in group]
    raise HilError(BAD_ARGS, f"unknown ui ref {ref!r}",
                   hint="refs come from the latest snapshot's ui.group; take a new snapshot",
                   ref=ref, known=known)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_snapshot.py tests/test_verbs.py -q && ruff check crosspad_hil/snapshot.py tests/test_snapshot.py`
Expected: all tests `passed` (the `ui`-including snapshots each take ~0.2 s for the ENC_GROUP idle window), ruff `All checks passed!`.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/snapshot.py tests/test_snapshot.py
git commit -m "feat(snapshot): one-call device state with encoder refs and change detection"
```
# Plan A — chunk 6: midi.py, usbmode.py, ota.py (Tasks 10–12)

Repo: `/home/matixan/GIT/crosspad-hil`. Package `crosspad_hil`. All names below follow
`contract.md` verbatim. Every test runs without hardware (fakes only). Run tests from the
repo root with the project venv active (`python -m pytest`).

Prerequisites from earlier tasks (already merged before you start this chunk):

- `crosspad_hil/errors.py` — `HilError(code, message, hint=None, **details)` and the string
  constants `NO_DEVICE, BAD_ARGS, BAD_SYSEX, DENIED_SYSEX, TIMEOUT, NOT_SUPPORTED, FLASH_FAILED,
  ENV, NO_CDC_IN_AUDIO_MODE`.
- `crosspad_hil/knowledge/__init__.py` — `load(name) -> dict`; `sysex.yaml` with keys
  `manufacturer, usb_mode{id,default,audio}, audio_route{id,subs{…}}, bootloader{id,esp},
  host_denylist`.
- `crosspad_hil/devices.py` — `UsbMode, SerialPortInfo, MidiPortInfo, AudioCardInfo, Ports,
  Device, discover, ESP_VID, ESP_BOOT_PIDS`.
- `crosspad_hil/serial_open.py` — `open_serial(path, *, baud, timeout, reset, serial_cls)`.
- `crosspad_hil/console.py` — `Console`, `BootResult`.
- `tests/fakes.py` — `FakeSerial` (contract). This chunk appends `FakeMidiOut`, `FakeMidiIn`,
  `FakeMidiBus` to that file (Task 10, Step 1). If Task 1 already defined `FakeMidiOut`/
  `FakeMidiIn` with the same behaviour, keep that definition and add only `FakeMidiBus`.

Rtmidi surface used (and faked): `MidiOut().get_ports() -> list[str]`, `.open_port(i)`,
`.close_port()`, `.send_message(list[int])`; `MidiIn().get_ports()`, `.open_port(i)`,
`.close_port()`, `.ignore_types(sysex=False, timing=True, active_sense=True)`,
`.set_callback(fn, data=None)` where `fn((message: list[int], delta: float), data)`,
`.cancel_callback()`.

---

### Task 10: midi.py — MidiIO, SysEx builders, query/echo helpers

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/midi.py`
- Modify: `/home/matixan/GIT/crosspad-hil/tests/fakes.py` (append `FakeMidiOut`, `FakeMidiIn`, `FakeMidiBus` at end of file)
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_midi.py`

**Interfaces:**
- Consumes: `HilError` + codes (`errors.py`); `knowledge.load("sysex")`; `Device`, `Ports`,
  `MidiPortInfo`, `UsbMode` (`devices.py`).
- Produces (contract verbatim):
  - `class MidiRole(str, Enum): ESP = "esp"; STM = "stm"`
  - `class MidiIO: __init__(self, device: Device, role: MidiRole = MidiRole.ESP, *, backend: str = "rtmidi", out_factory=None, in_factory=None)`; `open()`, `close()`, `send_sysex(frame: bytes)`, `send_note(on, note, vel=100, channel=0)`, `receive(timeout_s=1.0) -> bytes | None`; context manager (`__enter__` opens, `__exit__` closes).
  - `sysex_usb_mode(mode: UsbMode) -> bytes`, `sysex_audio_route(sub: int, *args: int) -> bytes`, `sysex_pad(on: bool, pad: int, vel: int = 127) -> bytes`, `sysex_echo(seq: int) -> bytes`, `sysex_query() -> bytes`, `sysex_bootloader_esp() -> bytes`
  - `parse_query_reply(frame: bytes) -> dict`, `query_route(io: MidiIO, timeout_s: float = 1.0) -> dict`, `echo_rtt(io: MidiIO, n: int = 20, timeout_s: float = 1.0) -> dict`
  - Extra (contract silent, chosen here): `MidiIO.is_open: bool` property; `MidiIO.port_name: str | None`; `echo_rtt(..., clock=time.monotonic)` keyword-only injectable clock; `echo_rtt` sends frames one at a time and waits for each reply (RTT is per frame; a timeout counts as one lost frame).
  - Error mapping: no `rtmidi` importable and no factories → `HilError(ENV, hint="pip install python-rtmidi")`; role port missing on the Device or index `None` → `HilError(NO_DEVICE)`; `receive()` on `MidiRole.STM` → `HilError(NOT_SUPPORTED)`; sending while closed → `HilError(BAD_ARGS, "MidiIO not open")`; `sysex_echo(seq)` outside `0..0x0FFFFFFF` → `BAD_ARGS`; `sysex_pad` pad outside `0..15` / vel outside `0..127` → `BAD_ARGS`; `sysex_audio_route` arg outside `0..127` → `BAD_ARGS`.
- Fakes produced for later tasks (usbmode/ota/serve tests): `FakeMidiBus(out_ports, in_ports, responder=None)` with `.out_factory`, `.in_factory`, `.sent: list[list[int]]`, `.inject(msg)`.

- [ ] **Step 1: Append MIDI fakes to tests/fakes.py**

Append to `/home/matixan/GIT/crosspad-hil/tests/fakes.py`:

```python
# ---------------------------------------------------------------------------
# MIDI fakes (rtmidi-shaped). Used by test_midi.py, test_usbmode.py, test_ota.py.
# ---------------------------------------------------------------------------
from __future__ import annotations

from typing import Any, Callable


class FakeMidiIn:
    """rtmidi.MidiIn look-alike. Messages arrive via inject() and reach the callback."""

    def __init__(self, ports: list[str]) -> None:
        self._ports = list(ports)
        self.opened: int | None = None
        self.closed = False
        self.sysex_ignored = True
        self._callback: Callable[[tuple[list[int], float], Any], None] | None = None
        self._data: Any = None

    def get_ports(self) -> list[str]:
        return list(self._ports)

    def open_port(self, index: int) -> None:
        if index >= len(self._ports):
            raise RuntimeError(f"no MIDI in port {index}")
        self.opened = index
        self.closed = False

    def close_port(self) -> None:
        self.closed = True

    def ignore_types(self, sysex: bool = True, timing: bool = True,
                     active_sense: bool = True) -> None:
        self.sysex_ignored = sysex

    def set_callback(self, fn: Callable[[tuple[list[int], float], Any], None],
                     data: Any = None) -> None:
        self._callback = fn
        self._data = data

    def cancel_callback(self) -> None:
        self._callback = None

    def inject(self, msg: list[int], delta: float = 0.0) -> None:
        if self._callback is not None:
            self._callback((list(msg), delta), self._data)


class FakeMidiOut:
    """rtmidi.MidiOut look-alike; every send is recorded and offered to a responder."""

    def __init__(self, ports: list[str], bus: "FakeMidiBus") -> None:
        self._ports = list(ports)
        self._bus = bus
        self.opened: int | None = None
        self.closed = False

    def get_ports(self) -> list[str]:
        return list(self._ports)

    def open_port(self, index: int) -> None:
        if index >= len(self._ports):
            raise RuntimeError(f"no MIDI out port {index}")
        self.opened = index
        self.closed = False

    def close_port(self) -> None:
        self.closed = True

    def send_message(self, msg: list[int]) -> None:
        self._bus.sent.append(list(msg))
        if self._bus.responder is not None:
            for reply in self._bus.responder(list(msg)):
                self._bus.inject(reply)


class FakeMidiBus:
    """One out + one in port pair wired together.

    responder(msg) -> list of reply messages delivered synchronously to the IN side
    (before send_message returns) — exactly what a device echo looks like to rtmidi.
    """

    def __init__(self, out_ports: list[str] | None = None, in_ports: list[str] | None = None,
                 responder: Callable[[list[int]], list[list[int]]] | None = None) -> None:
        self.out_ports = out_ports if out_ports is not None else ["Crosspad MIDI 1"]
        self.in_ports = in_ports if in_ports is not None else ["Crosspad MIDI 1"]
        self.responder = responder
        self.sent: list[list[int]] = []
        self.outs: list[FakeMidiOut] = []
        self.ins: list[FakeMidiIn] = []

    def out_factory(self) -> FakeMidiOut:
        o = FakeMidiOut(self.out_ports, self)
        self.outs.append(o)
        return o

    def in_factory(self) -> FakeMidiIn:
        i = FakeMidiIn(self.in_ports)
        self.ins.append(i)
        return i

    def inject(self, msg: list[int]) -> None:
        for i in self.ins:
            if i.opened is not None and not i.closed:
                i.inject(msg)
```

- [ ] **Step 2: Write the failing tests**

Create `/home/matixan/GIT/crosspad-hil/tests/test_midi.py`:

```python
from __future__ import annotations

import pytest

from crosspad_hil.devices import Device, MidiPortInfo, Ports, UsbMode
from crosspad_hil.errors import (
    BAD_ARGS,
    BAD_SYSEX,
    DENIED_SYSEX,
    NO_DEVICE,
    NOT_SUPPORTED,
    TIMEOUT,
    HilError,
)
from crosspad_hil.midi import (
    MidiIO,
    MidiRole,
    echo_rtt,
    parse_query_reply,
    query_route,
    sysex_audio_route,
    sysex_bootloader_esp,
    sysex_echo,
    sysex_pad,
    sysex_query,
    sysex_usb_mode,
)
from tests.fakes import FakeMidiBus


def make_device(esp_out: int | None = 0, esp_in: int | None = 0,
                stm_out: int | None = 1) -> Device:
    return Device(
        id="dev_1234",
        serial="ABCD1234",
        usb_mode=UsbMode.DEFAULT,
        ports=Ports(
            esp_midi=MidiPortInfo(name="Crosspad MIDI 1", rtmidi_out=esp_out,
                                  rtmidi_in=esp_in, alsa_hw="hw:2,0,0", rawmidi=None),
            stm_midi=MidiPortInfo(name="CrossPad MIDI+Serial 2", rtmidi_out=stm_out,
                                  rtmidi_in=None, alsa_hw="hw:3,0,0", rawmidi=None),
        ),
    )


def make_io(bus: FakeMidiBus, role: MidiRole = MidiRole.ESP, device: Device | None = None) -> MidiIO:
    return MidiIO(device or make_device(), role,
                  out_factory=bus.out_factory, in_factory=bus.in_factory)


# ---- builders: byte-exact --------------------------------------------------

def test_sysex_usb_mode_bytes() -> None:
    assert sysex_usb_mode(UsbMode.DEFAULT) == bytes([0xF0, 0x7D, 0x1B, 0x01, 0xF7])
    assert sysex_usb_mode(UsbMode.AUDIO) == bytes([0xF0, 0x7D, 0x1B, 0x02, 0xF7])
    with pytest.raises(HilError) as e:
        sysex_usb_mode(UsbMode.BOOTLOADER)
    assert e.value.code == BAD_ARGS


def test_sysex_audio_route_and_pad_bytes() -> None:
    # hil_audio_loopback.py SYSEX_ROUTE_LOOP[0]: "F0 7D 1D 01 01 01 F7"
    assert sysex_audio_route(0x01, 1, 1) == bytes([0xF0, 0x7D, 0x1D, 0x01, 0x01, 0x01, 0xF7])
    assert sysex_pad(True, 3, 100) == bytes([0xF0, 0x7D, 0x1D, 0x07, 0x03, 0x64, 0xF7])
    assert sysex_pad(False, 3) == bytes([0xF0, 0x7D, 0x1D, 0x08, 0x03, 0xF7])
    assert sysex_query() == bytes([0xF0, 0x7D, 0x1D, 0x10, 0xF7])
    assert sysex_bootloader_esp() == bytes([0xF0, 0x7D, 0x19, 0x00, 0xF7])
    with pytest.raises(HilError) as e:
        sysex_pad(True, 16)
    assert e.value.code == BAD_ARGS
    with pytest.raises(HilError) as e:
        sysex_audio_route(0x01, 1, 200)
    assert e.value.code == BAD_ARGS


def test_sysex_echo_roundtrip_msb_first() -> None:
    # hil_midi_bench.py echo_frame(): (seq>>21)&0x7F, (seq>>14)&0x7F, (seq>>7)&0x7F, seq&0x7F
    seq = (1 << 27) | 0x123456
    frame = sysex_echo(seq)
    assert frame[:4] == bytes([0xF0, 0x7D, 0x1D, 0x09]) and frame[-1] == 0xF7
    assert len(frame) == 9
    assert all(b < 0x80 for b in frame[4:8])
    decoded = ((frame[4] & 0x7F) << 21) | ((frame[5] & 0x7F) << 14) \
        | ((frame[6] & 0x7F) << 7) | (frame[7] & 0x7F)
    assert decoded == seq
    assert sysex_echo(0) == bytes([0xF0, 0x7D, 0x1D, 0x09, 0, 0, 0, 0, 0xF7])
    with pytest.raises(HilError) as e:
        sysex_echo(1 << 28)
    assert e.value.code == BAD_ARGS


def test_parse_query_reply_layout() -> None:
    # audio_route_control.cpp send_query_reply: F0 7D 1D 10 micSrc adc0 adc1 out0 out1 v0 v1 m0 m1 F7
    frame = bytes([0xF0, 0x7D, 0x1D, 0x10, 1, 2, 1, 3, 2, 80, 90, 0, 1, 0xF7])
    assert parse_query_reply(frame) == {
        "mic_src": 1, "adc": [2, 1], "out": [3, 2], "vol": [80, 90], "mute": [0, 1],
    }
    with pytest.raises(HilError) as e:
        parse_query_reply(bytes([0xF0, 0x7D, 0x1D, 0x09, 0, 0, 0, 0, 0xF7]))
    assert e.value.code == BAD_SYSEX


# ---- MidiIO -----------------------------------------------------------------

def test_send_sysex_denylist_refuses_stm_bootloader_frame() -> None:
    bus = FakeMidiBus()
    io = make_io(bus)
    io.open()
    with pytest.raises(HilError) as e:
        io.send_sysex(bytes([0xF0, 0x7D, 0x19, 0x01, 0xF7]))
    assert e.value.code == DENIED_SYSEX
    assert bus.sent == []
    io.close()


def test_send_sysex_validates_framing() -> None:
    bus = FakeMidiBus()
    with make_io(bus) as io:
        for bad in (b"", bytes([0x7D, 0x1D, 0x10, 0xF7]), bytes([0xF0, 0x7D, 0x1D, 0x10]),
                    bytes([0xF0, 0x7D, 0x1D, 0x80, 0xF7])):
            with pytest.raises(HilError) as e:
                io.send_sysex(bad)
            assert e.value.code == BAD_SYSEX
        io.send_sysex(sysex_query())
    assert bus.sent == [[0xF0, 0x7D, 0x1D, 0x10, 0xF7]]
    assert bus.outs[0].closed and bus.ins[0].closed


def test_send_note_and_role_port_selection() -> None:
    bus = FakeMidiBus(out_ports=["Crosspad MIDI 1", "CrossPad MIDI+Serial 2"])
    with make_io(bus, MidiRole.STM) as io:
        assert bus.outs[0].opened == 1
        assert bus.ins == []  # STM role opens no IN port
        io.send_note(True, 60, 100, channel=2)
        io.send_note(False, 60)
        with pytest.raises(HilError) as e:
            io.receive(0.01)
        assert e.value.code == NOT_SUPPORTED
    assert bus.sent == [[0x92, 60, 100], [0x80, 60, 0]]
    with pytest.raises(HilError) as e:
        make_io(bus, device=make_device(esp_out=None)).open()
    assert e.value.code == NO_DEVICE
    with pytest.raises(HilError) as e:
        make_io(bus).send_note(True, 60)
    assert e.value.code == BAD_ARGS


def test_receive_returns_only_sysex_from_esp_in() -> None:
    bus = FakeMidiBus()
    with make_io(bus) as io:
        assert bus.ins[0].sysex_ignored is False
        bus.inject([0x90, 60, 100])            # note-on: dropped
        bus.inject([0xF0, 0x7D, 0x1D, 0x10, 0xF7])
        assert io.receive(0.05) == bytes([0xF0, 0x7D, 0x1D, 0x10, 0xF7])
        assert io.receive(0.01) is None


def test_query_route_reads_reply() -> None:
    def responder(msg: list[int]) -> list[list[int]]:
        if msg[:4] == [0xF0, 0x7D, 0x1D, 0x10]:
            return [[0xF0, 0x7D, 0x1D, 0x10, 0, 2, 1, 1, 2, 70, 70, 0, 0, 0xF7]]
        return []

    bus = FakeMidiBus(responder=responder)
    with make_io(bus) as io:
        bus.inject([0xF0, 0x7D, 0x1D, 0x09, 1, 2, 3, 4, 0xF7])   # stale frame, must be drained
        assert query_route(io, timeout_s=0.2) == {
            "mic_src": 0, "adc": [2, 1], "out": [1, 2], "vol": [70, 70], "mute": [0, 0],
        }
    with make_io(FakeMidiBus()) as io:
        with pytest.raises(HilError) as e:
            query_route(io, timeout_s=0.05)
        assert e.value.code == TIMEOUT


def test_echo_rtt_loss_accounting() -> None:
    def responder(msg: list[int]) -> list[list[int]]:
        # device echo (audio_route_control.cpp AUDIO_ROUTE_SUB_ECHO): mirrors the 4 bytes
        if msg[:4] == [0xF0, 0x7D, 0x1D, 0x09]:
            seq = (msg[4] << 21) | (msg[5] << 14) | (msg[6] << 7) | msg[7]
            if seq % 3 == 0:
                return []                     # drop every third
            return [[0xF0, 0x7D, 0x1D, 0x09, msg[4], msg[5], msg[6], msg[7], 0xF7]]
        return []

    ticks = iter(range(0, 10_000))

    def clock() -> float:
        return next(ticks) * 0.001            # 1 ms per call

    bus = FakeMidiBus(responder=responder)
    with make_io(bus) as io:
        r = echo_rtt(io, n=9, timeout_s=0.02, clock=clock)
    assert r["sent"] == 9
    assert r["received"] == 6
    assert r["lost"] == 3
    assert set(r["rtt_ms"]) == {"p50", "p90", "max"}
    assert r["rtt_ms"]["max"] >= r["rtt_ms"]["p90"] >= r["rtt_ms"]["p50"] > 0
    assert len(bus.sent) == 9
    with make_io(FakeMidiBus()) as io:
        r = echo_rtt(io, n=2, timeout_s=0.01)
    assert r == {"sent": 2, "received": 0, "lost": 2,
                 "rtt_ms": {"p50": None, "p90": None, "max": None}}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_midi.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.midi'`

- [ ] **Step 4: Write midi.py**

Create `/home/matixan/GIT/crosspad-hil/crosspad_hil/midi.py`:

```python
"""USB MIDI access (rtmidi) and the CrossPad SysEx catalog.

Frames, byte layouts and the replies are ported from platform-idf:
  tools/hil_midi_bench.py (echo_frame), tools/hil_sampler_record.py (Midi.query_route),
  tools/ota_flash.py (SYSEX_USB_MODE_DEFAULT), tools/requestBootloader.py (SYSEX_DATA),
  main/audio_route_control.cpp (send_query_reply, AUDIO_ROUTE_SUB_ECHO).
"""
from __future__ import annotations

import queue
import time
from enum import Enum
from typing import Any, Callable

from crosspad_hil import knowledge
from crosspad_hil.devices import Device, MidiPortInfo, UsbMode
from crosspad_hil.errors import (
    BAD_ARGS,
    BAD_SYSEX,
    DENIED_SYSEX,
    ENV,
    NO_DEVICE,
    NOT_SUPPORTED,
    TIMEOUT,
    HilError,
)

SYSEX_START = 0xF0
SYSEX_END = 0xF7


class MidiRole(str, Enum):
    ESP = "esp"
    STM = "stm"


def _sysex_knowledge() -> dict:
    return knowledge.load("sysex")


def _check7(value: int, what: str) -> int:
    if not isinstance(value, int) or value < 0 or value > 0x7F:
        raise HilError(BAD_ARGS, f"{what} must be 0..127, got {value!r}")
    return value


# ---------------------------------------------------------------------------
# builders
# ---------------------------------------------------------------------------

def sysex_usb_mode(mode: UsbMode) -> bytes:
    """F0 7D 1B 01|02 F7 — ota_flash.py SYSEX_USB_MODE_DEFAULT / hil_audio_loopback.py SYSEX_AUDIO."""
    k = _sysex_knowledge()
    if mode == UsbMode.DEFAULT:
        payload = int(k["usb_mode"]["default"])
    elif mode == UsbMode.AUDIO:
        payload = int(k["usb_mode"]["audio"])
    else:
        raise HilError(BAD_ARGS, f"usb mode {mode.value} cannot be requested over SysEx",
                       hint="only 'default' and 'audio' are switchable")
    return bytes([SYSEX_START, int(k["manufacturer"]), int(k["usb_mode"]["id"]),
                  payload, SYSEX_END])


def sysex_audio_route(sub: int, *args: int) -> bytes:
    """F0 7D 1D <sub> <args…> F7 — hil_sampler_record.py Midi.route()."""
    k = _sysex_knowledge()
    _check7(sub, "sub")
    body = [_check7(a, "arg") for a in args]
    return bytes([SYSEX_START, int(k["manufacturer"]), int(k["audio_route"]["id"]),
                  sub, *body, SYSEX_END])


def sysex_pad(on: bool, pad: int, vel: int = 127) -> bytes:
    """Pad press 0x07 <pad> <vel> / release 0x08 <pad> — hil_sampler_record.py SysexPads."""
    k = _sysex_knowledge()["audio_route"]["subs"]
    if not isinstance(pad, int) or pad < 0 or pad > 15:
        raise HilError(BAD_ARGS, f"pad must be 0..15, got {pad!r}")
    if on:
        return sysex_audio_route(int(k["pad_press"]), pad, _check7(vel, "vel"))
    return sysex_audio_route(int(k["pad_release"]), pad)


def sysex_echo(seq: int) -> bytes:
    """28-bit sequence, 7 bits per byte, MSB first — hil_midi_bench.py echo_frame()."""
    if not isinstance(seq, int) or seq < 0 or seq > 0x0FFFFFFF:
        raise HilError(BAD_ARGS, f"echo seq must be 0..0x0FFFFFFF, got {seq!r}")
    k = _sysex_knowledge()["audio_route"]["subs"]
    return sysex_audio_route(int(k["echo"]),
                             (seq >> 21) & 0x7F, (seq >> 14) & 0x7F,
                             (seq >> 7) & 0x7F, seq & 0x7F)


def decode_echo_seq(frame: bytes) -> int:
    """Inverse of sysex_echo — hil_midi_bench.py parse_replies()."""
    return ((frame[4] & 0x7F) << 21) | ((frame[5] & 0x7F) << 14) \
        | ((frame[6] & 0x7F) << 7) | (frame[7] & 0x7F)


def sysex_query() -> bytes:
    """F0 7D 1D 10 F7 — hil_midi_stress.py QUERY."""
    k = _sysex_knowledge()["audio_route"]["subs"]
    return sysex_audio_route(int(k["query"]))


def sysex_bootloader_esp() -> bytes:
    """F0 7D 19 00 F7 — requestBootloader.py SYSEX_DATA."""
    k = _sysex_knowledge()
    return bytes([SYSEX_START, int(k["manufacturer"]), int(k["bootloader"]["id"]),
                  int(k["bootloader"]["esp"]), SYSEX_END])


def parse_query_reply(frame: bytes) -> dict:
    """14-byte reply: F0 7D 1D 10 micSrc adc0 adc1 out0 out1 v0 v1 m0 m1 F7.

    Layout from audio_route_control.cpp send_query_reply()/get_state() and
    hil_sampler_record.py Midi.query_route().
    """
    k = _sysex_knowledge()
    route_id = int(k["audio_route"]["id"])
    query_sub = int(k["audio_route"]["subs"]["query"])
    if len(frame) < 14 or frame[0] != SYSEX_START or frame[2] != route_id \
            or frame[3] != query_sub:
        raise HilError(BAD_SYSEX, "not an audio-route query reply",
                       frame=frame.hex(" ").upper())
    b = frame
    return {"mic_src": b[4], "adc": [b[5], b[6]], "out": [b[7], b[8]],
            "vol": [b[9], b[10]], "mute": [b[11], b[12]]}


# ---------------------------------------------------------------------------
# MidiIO
# ---------------------------------------------------------------------------

def _rtmidi_factories() -> tuple[Callable[[], Any], Callable[[], Any]]:
    try:
        import rtmidi  # type: ignore[import-not-found]
    except ImportError as exc:
        raise HilError(ENV, "python-rtmidi is not installed",
                       hint="pip install python-rtmidi") from exc
    return rtmidi.MidiOut, rtmidi.MidiIn


class MidiIO:
    """One MIDI port pair of a Device: the ESP native port (IN+OUT) or the STM bridge (OUT).

    Replies (echo 0x1D 09, query 0x1D 10) only ever come back on the ESP port, and a
    mode-switch frame sent to the STM bridge is silently dropped — see the hygiene table
    in the spec (§2.4). The role therefore decides which index of the Device is opened.
    """

    def __init__(self, device: Device, role: MidiRole = MidiRole.ESP, *,
                 backend: str = "rtmidi",
                 out_factory: Callable[[], Any] | None = None,
                 in_factory: Callable[[], Any] | None = None) -> None:
        if backend != "rtmidi":
            raise HilError(NOT_SUPPORTED, f"midi backend {backend!r} not supported in P0",
                           hint="use backend='rtmidi'")
        self._device = device
        self._role = MidiRole(role)
        self._out_factory = out_factory
        self._in_factory = in_factory
        self._out: Any = None
        self._in: Any = None
        self._rx: queue.Queue[bytes] = queue.Queue()
        self._denylist: set[tuple[int, int, int]] = self._load_denylist()
        self.port_name: str | None = None

    @staticmethod
    def _load_denylist() -> set[tuple[int, int, int]]:
        k = _sysex_knowledge()
        manu = int(k["manufacturer"])
        denied: set[tuple[int, int, int]] = set()
        for entry in k.get("host_denylist", []):
            cmd, arg = int(entry[0]), int(entry[1])
            denied.add((manu, cmd, arg))
        return denied

    @property
    def role(self) -> MidiRole:
        return self._role

    @property
    def is_open(self) -> bool:
        return self._out is not None

    def _port_info(self) -> MidiPortInfo:
        info = self._device.ports.esp_midi if self._role is MidiRole.ESP \
            else self._device.ports.stm_midi
        if info is None:
            raise HilError(NO_DEVICE, f"{self._device.id} has no {self._role.value} MIDI port",
                           hint="is the device enumerated? run `crosspad-hil devices`")
        return info

    def open(self) -> None:
        if self.is_open:
            return
        info = self._port_info()
        if info.rtmidi_out is None:
            raise HilError(NO_DEVICE, f"{self._role.value} MIDI port has no rtmidi out index",
                           port=info.name)
        out_factory, in_factory = self._out_factory, self._in_factory
        if out_factory is None or in_factory is None:
            rt_out, rt_in = _rtmidi_factories()
            out_factory = out_factory or rt_out
            in_factory = in_factory or rt_in
        out = out_factory()
        out.open_port(info.rtmidi_out)
        self.port_name = info.name
        self._out = out
        if self._role is MidiRole.ESP and info.rtmidi_in is not None:
            inp = in_factory()
            inp.open_port(info.rtmidi_in)
            inp.ignore_types(sysex=False, timing=True, active_sense=True)
            inp.set_callback(self._on_message, None)
            self._in = inp

    def close(self) -> None:
        if self._in is not None:
            try:
                self._in.cancel_callback()
                self._in.close_port()
            finally:
                self._in = None
        if self._out is not None:
            try:
                self._out.close_port()
            finally:
                self._out = None

    def __enter__(self) -> "MidiIO":
        self.open()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _on_message(self, event: tuple[list[int], float], data: Any) -> None:
        msg, _delta = event
        if msg and msg[0] == SYSEX_START:
            self._rx.put(bytes(msg))

    def _require_open(self) -> Any:
        if self._out is None:
            raise HilError(BAD_ARGS, "MidiIO not open", hint="call open() first")
        return self._out

    def send_sysex(self, frame: bytes) -> None:
        out = self._require_open()
        frame = bytes(frame)
        if len(frame) < 2 or frame[0] != SYSEX_START or frame[-1] != SYSEX_END:
            raise HilError(BAD_SYSEX, "frame must start with F0 and end with F7",
                           frame=frame.hex(" ").upper())
        if any(b >= 0x80 for b in frame[1:-1]):
            raise HilError(BAD_SYSEX, "SysEx payload bytes must be 0..127",
                           frame=frame.hex(" ").upper())
        if len(frame) >= 5 and (frame[1], frame[2], frame[3]) in self._denylist:
            raise HilError(DENIED_SYSEX,
                           f"{frame.hex(' ').upper()} is never sent from a host",
                           hint="F0 7D 19 01 F7 hangs the STM uartLoop; use STM_DFU over CDC",
                           frame=frame.hex(" ").upper())
        out.send_message(list(frame))

    def send_note(self, on: bool, note: int, vel: int = 100, channel: int = 0) -> None:
        out = self._require_open()
        _check7(note, "note")
        _check7(vel, "vel")
        if not isinstance(channel, int) or channel < 0 or channel > 15:
            raise HilError(BAD_ARGS, f"channel must be 0..15, got {channel!r}")
        if on:
            out.send_message([0x90 | channel, note, vel])
        else:
            out.send_message([0x80 | channel, note, 0])

    def drain(self) -> int:
        """Discard queued SysEx frames; returns how many were dropped."""
        n = 0
        while True:
            try:
                self._rx.get_nowait()
                n += 1
            except queue.Empty:
                return n

    def receive(self, timeout_s: float = 1.0) -> bytes | None:
        if self._role is not MidiRole.ESP:
            raise HilError(NOT_SUPPORTED, "the STM bridge MIDI port has no usable IN side",
                           hint="replies only arrive on the ESP native MIDI port")
        self._require_open()
        try:
            return self._rx.get(timeout=max(timeout_s, 0.0))
        except queue.Empty:
            return None


# ---------------------------------------------------------------------------
# helpers on top of MidiIO
# ---------------------------------------------------------------------------

def query_route(io: MidiIO, timeout_s: float = 1.0) -> dict:
    """Send 0x1D 10 and return the parsed state — hil_sampler_record.py Midi.query_route()."""
    k = _sysex_knowledge()
    route_id = int(k["audio_route"]["id"])
    query_sub = int(k["audio_route"]["subs"]["query"])
    io.drain()
    io.send_sysex(sysex_query())
    deadline = time.monotonic() + timeout_s
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HilError(TIMEOUT, f"no audio-route query reply within {timeout_s} s",
                           hint="replies come back on the ESP native MIDI IN port only")
        frame = io.receive(remaining)
        if frame is None:
            continue
        if len(frame) >= 14 and frame[2] == route_id and frame[3] == query_sub:
            return parse_query_reply(frame)


def _percentile(sorted_ms: list[float], p: float) -> float:
    idx = int(round((len(sorted_ms) - 1) * p))
    return sorted_ms[min(max(idx, 0), len(sorted_ms) - 1)]


def echo_rtt(io: MidiIO, n: int = 20, timeout_s: float = 1.0, *,
             clock: Callable[[], float] = time.monotonic) -> dict:
    """Round-trip time of n echo frames (0x1D 09), one in flight at a time.

    {sent, received, lost, rtt_ms: {p50, p90, max}}; the percentiles are None when nothing
    came back. A reply carrying a different seq than the one in flight is a late echo of an
    already-lost frame and is ignored.
    """
    if n <= 0:
        raise HilError(BAD_ARGS, f"n must be >= 1, got {n}")
    k = _sysex_knowledge()
    route_id = int(k["audio_route"]["id"])
    echo_sub = int(k["audio_route"]["subs"]["echo"])
    io.drain()
    rtts: list[float] = []
    sent = 0
    for i in range(1, n + 1):
        seq = i & 0x0FFFFFFF
        t0 = clock()
        io.send_sysex(sysex_echo(seq))
        sent += 1
        deadline = t0 + timeout_s
        while True:
            remaining = deadline - clock()
            if remaining <= 0:
                break
            frame = io.receive(remaining)
            if frame is None:
                continue
            if len(frame) >= 9 and frame[2] == route_id and frame[3] == echo_sub \
                    and decode_echo_seq(frame) == seq:
                rtts.append((clock() - t0) * 1000.0)
                break
    received = len(rtts)
    if rtts:
        s = sorted(rtts)
        stats: dict[str, float | None] = {"p50": _percentile(s, 0.50),
                                          "p90": _percentile(s, 0.90), "max": s[-1]}
    else:
        stats = {"p50": None, "p90": None, "max": None}
    return {"sent": sent, "received": received, "lost": sent - received, "rtt_ms": stats}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_midi.py -q && ruff check crosspad_hil/midi.py tests/test_midi.py tests/fakes.py`
Expected: `10 passed` and `All checks passed!`

- [ ] **Step 6: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/midi.py tests/test_midi.py tests/fakes.py && git commit -m "feat(midi): MidiIO with SysEx denylist, builders, query and echo RTT"
```

---

### Task 11: usbmode.py — set_mode() and audio_mode()

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/usbmode.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_usbmode.py`

**Interfaces:**
- Consumes: `MidiIO`, `MidiRole`, `sysex_usb_mode` (Task 10); `Device`, `UsbMode`, `discover` (`devices.py`); `HilError`, `TIMEOUT`, `NO_DEVICE`, `BAD_ARGS`.
- Produces (contract verbatim):
  - `set_mode(device: Device, mode: UsbMode, *, wait: bool = True, timeout_s: float = 20.0, discover_fn=discover, midi_factory=MidiIO, sleep=time.sleep) -> Device`
  - `audio_mode(device: Device, *, keep: bool = False, **kw) -> Iterator[Device]` (contextmanager; `**kw` forwarded to `set_mode`)
- Decisions where the contract is silent: poll interval `0.5 s` (ota_flash.py `wait_for_cdc`); `midi_factory(device, MidiRole.ESP)` is used as a context manager (`open`/`close`); `mode` other than DEFAULT/AUDIO → `BAD_ARGS`; missing `ports.esp_midi` → `NO_DEVICE` with hint; a device already in the requested mode still gets the frame (idempotent from the caller's view, and the poll then returns immediately); "reached" = `d.usb_mode == mode` **or** (`mode is DEFAULT and d.ports.cdc is not None`) **or** (`mode is AUDIO and d.ports.uac2 is not None`) for the Device whose `id` matches; if `wait` is False the input Device is returned with `usb_mode` replaced by the requested mode (dataclass `replace`). The `TIMEOUT` error carries `details={"device": id, "mode": mode.value, "last_seen": <last usb_mode or None>}` and hint "device may have re-enumerated with a different serial; run devices".

- [ ] **Step 1: Write the failing tests**

Create `/home/matixan/GIT/crosspad-hil/tests/test_usbmode.py`:

```python
from __future__ import annotations

from dataclasses import replace

import pytest

from crosspad_hil.devices import (
    AudioCardInfo,
    Device,
    MidiPortInfo,
    Ports,
    SerialPortInfo,
    UsbMode,
)
from crosspad_hil.errors import BAD_ARGS, NO_DEVICE, TIMEOUT, HilError
from crosspad_hil.midi import MidiIO
from crosspad_hil.usbmode import audio_mode, set_mode
from tests.fakes import FakeMidiBus

CDC = SerialPortInfo(path="/dev/ttyACM0", vid=0x303A, pid=0x3456, serial="ABCD1234",
                     product="Crosspad", location="1-2:1.0")
UAC = AudioCardInfo(name="Crosspad Audio", sounddevice_index=3, alsa_id="hw:3")
MIDI = MidiPortInfo(name="Crosspad MIDI 1", rtmidi_out=0, rtmidi_in=0, alsa_hw=None,
                    rawmidi=None)


def dev_default() -> Device:
    return Device(id="dev_1234", serial="ABCD1234", usb_mode=UsbMode.DEFAULT,
                  ports=Ports(cdc=CDC, esp_midi=MIDI))


def dev_audio() -> Device:
    return Device(id="dev_1234", serial="ABCD1234", usb_mode=UsbMode.AUDIO,
                  ports=Ports(uac2=UAC, esp_midi=MIDI))


def dev_gone() -> list[Device]:
    return []


class FakeDiscover:
    """Returns the scripted inventories in order, repeating the last one forever."""

    def __init__(self, sequence: list[list[Device]]) -> None:
        self.sequence = list(sequence)
        self.calls = 0

    def __call__(self):
        self.calls += 1
        idx = min(self.calls - 1, len(self.sequence) - 1)
        return list(self.sequence[idx])


def midi_factory_for(bus: FakeMidiBus):
    def factory(device: Device, role=None, **kw) -> MidiIO:
        return MidiIO(device, role or "esp", out_factory=bus.out_factory,
                      in_factory=bus.in_factory)
    return factory


def test_set_mode_audio_polls_until_uac2_present() -> None:
    bus = FakeMidiBus()
    disc = FakeDiscover([dev_gone(), dev_gone(), [dev_audio()]])
    slept: list[float] = []
    d = set_mode(dev_default(), UsbMode.AUDIO, discover_fn=disc,
                 midi_factory=midi_factory_for(bus), sleep=slept.append)
    assert bus.sent == [[0xF0, 0x7D, 0x1B, 0x02, 0xF7]]
    assert bus.outs[0].closed
    assert d.usb_mode is UsbMode.AUDIO and d.ports.uac2 is UAC
    assert disc.calls == 3
    assert slept == [0.5, 0.5]


def test_set_mode_default_accepts_cdc_presence_even_if_mode_unknown() -> None:
    bus = FakeMidiBus()
    seen = replace(dev_default(), usb_mode=UsbMode.UNKNOWN)
    disc = FakeDiscover([[seen]])
    d = set_mode(dev_audio(), UsbMode.DEFAULT, discover_fn=disc,
                 midi_factory=midi_factory_for(bus), sleep=lambda s: None)
    assert bus.sent == [[0xF0, 0x7D, 0x1B, 0x01, 0xF7]]
    assert d is seen


def test_set_mode_ignores_other_devices_and_times_out() -> None:
    bus = FakeMidiBus()
    other = replace(dev_audio(), id="dev_9999", serial="ZZZZ")
    disc = FakeDiscover([[other]])
    clock = iter([0.0, 0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0])
    with pytest.raises(HilError) as e:
        set_mode(dev_default(), UsbMode.AUDIO, timeout_s=20.0, discover_fn=disc,
                 midi_factory=midi_factory_for(bus), sleep=lambda s: None,
                 clock=lambda: next(clock))
    assert e.value.code == TIMEOUT
    assert e.value.details["device"] == "dev_1234"
    assert e.value.details["mode"] == "audio"


def test_set_mode_no_wait_and_arg_errors() -> None:
    bus = FakeMidiBus()
    disc = FakeDiscover([dev_gone()])
    d = set_mode(dev_default(), UsbMode.AUDIO, wait=False, discover_fn=disc,
                 midi_factory=midi_factory_for(bus), sleep=lambda s: None)
    assert d.usb_mode is UsbMode.AUDIO and disc.calls == 0
    with pytest.raises(HilError) as e:
        set_mode(dev_default(), UsbMode.BOOTLOADER, discover_fn=disc,
                 midi_factory=midi_factory_for(bus))
    assert e.value.code == BAD_ARGS
    no_midi = replace(dev_default(), ports=Ports(cdc=CDC))
    with pytest.raises(HilError) as e:
        set_mode(no_midi, UsbMode.AUDIO, discover_fn=disc,
                 midi_factory=midi_factory_for(bus))
    assert e.value.code == NO_DEVICE
    assert bus.sent == [[0xF0, 0x7D, 0x1B, 0x02, 0xF7]]


def test_audio_mode_restores_default_unless_keep() -> None:
    bus = FakeMidiBus()
    disc = FakeDiscover([[dev_audio()], [dev_default()]])
    with audio_mode(dev_default(), discover_fn=disc, midi_factory=midi_factory_for(bus),
                    sleep=lambda s: None) as d:
        assert d.usb_mode is UsbMode.AUDIO
        assert bus.sent == [[0xF0, 0x7D, 0x1B, 0x02, 0xF7]]
    assert bus.sent == [[0xF0, 0x7D, 0x1B, 0x02, 0xF7], [0xF0, 0x7D, 0x1B, 0x01, 0xF7]]

    bus2 = FakeMidiBus()
    disc2 = FakeDiscover([[dev_audio()]])
    with audio_mode(dev_default(), keep=True, discover_fn=disc2,
                    midi_factory=midi_factory_for(bus2), sleep=lambda s: None):
        pass
    assert bus2.sent == [[0xF0, 0x7D, 0x1B, 0x02, 0xF7]]


def test_audio_mode_restores_on_exception() -> None:
    bus = FakeMidiBus()
    disc = FakeDiscover([[dev_audio()], [dev_default()]])
    with pytest.raises(RuntimeError):
        with audio_mode(dev_default(), discover_fn=disc, midi_factory=midi_factory_for(bus),
                        sleep=lambda s: None):
            raise RuntimeError("scenario blew up")
    assert bus.sent[-1] == [0xF0, 0x7D, 0x1B, 0x01, 0xF7]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_usbmode.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.usbmode'`

- [ ] **Step 3: Write usbmode.py**

Create `/home/matixan/GIT/crosspad-hil/crosspad_hil/usbmode.py`:

```python
"""USB profile switching (SysEx 0x1B) with wait-for-enumeration and a restoring context.

Ported from platform-idf tools: ota_flash.py send_midi_switch_to_cdc()/wait_for_cdc(),
hil_audio_loopback.py ensure_audio_mode()/restore_default_mode(),
hil_usb_mode_cycle.py wait_for(). The frame always goes to the ESP native MIDI port:
the STM bridge drops it silently (measured, hil_audio_loopback.py esp_midi_port()).
"""
from __future__ import annotations

import time
from contextlib import contextmanager
from dataclasses import replace
from typing import Any, Callable, Iterator

from crosspad_hil.devices import Device, UsbMode, discover
from crosspad_hil.errors import BAD_ARGS, NO_DEVICE, TIMEOUT, HilError
from crosspad_hil.midi import MidiIO, MidiRole, sysex_usb_mode

POLL_S = 0.5  # ota_flash.py wait_for_cdc() poll interval


def _reached(d: Device, mode: UsbMode) -> bool:
    if d.usb_mode == mode:
        return True
    if mode is UsbMode.DEFAULT and d.ports.cdc is not None:
        return True
    if mode is UsbMode.AUDIO and d.ports.uac2 is not None:
        return True
    return False


def set_mode(device: Device, mode: UsbMode, *, wait: bool = True, timeout_s: float = 20.0,
             discover_fn: Callable[[], list[Device]] = discover,
             midi_factory: Callable[..., Any] = MidiIO,
             sleep: Callable[[float], None] = time.sleep,
             clock: Callable[[], float] = time.monotonic) -> Device:
    """Ask the device for `mode` over the ESP MIDI port and (optionally) wait for it to show up."""
    mode = UsbMode(mode)
    if mode not in (UsbMode.DEFAULT, UsbMode.AUDIO):
        raise HilError(BAD_ARGS, f"usb mode {mode.value!r} cannot be set",
                       hint="use 'default' or 'audio'; bootloader is ota.request_bootloader()")
    if device.ports.esp_midi is None:
        raise HilError(NO_DEVICE, f"{device.id} has no ESP MIDI port; cannot switch USB mode",
                       hint="the 0x1B frame must reach the ESP native MIDI port, "
                            "not the STM bridge")
    io = midi_factory(device, MidiRole.ESP)
    with io:
        io.send_sysex(sysex_usb_mode(mode))
    if not wait:
        return replace(device, usb_mode=mode)

    deadline = clock() + timeout_s
    last_seen: str | None = None
    while True:
        for d in discover_fn():
            if d.id != device.id:
                continue
            last_seen = d.usb_mode.value
            if _reached(d, mode):
                return d
        if clock() >= deadline:
            raise HilError(TIMEOUT,
                           f"{device.id} did not re-enumerate in mode {mode.value!r} "
                           f"within {timeout_s:.0f} s",
                           hint="device may have re-enumerated with a different serial; "
                                "run `crosspad-hil devices`",
                           device=device.id, mode=mode.value, last_seen=last_seen)
        sleep(POLL_S)


@contextmanager
def audio_mode(device: Device, *, keep: bool = False, **kw: Any) -> Iterator[Device]:
    """Enter the MIDI+UAC2 profile; leave it on exit unless keep=True (spec §2.4)."""
    entered = set_mode(device, UsbMode.AUDIO, **kw)
    try:
        yield entered
    finally:
        if not keep:
            set_mode(entered, UsbMode.DEFAULT, **kw)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_usbmode.py -q && ruff check crosspad_hil/usbmode.py tests/test_usbmode.py`
Expected: `6 passed` and `All checks passed!`

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/usbmode.py tests/test_usbmode.py && git commit -m "feat(usbmode): set_mode with enumeration wait and restoring audio_mode context"
```

---

### Task 12: ota.py — ota_flash(), request_bootloader(), flash()

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/ota.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_ota.py`

**Interfaces:**
- Consumes: `open_serial` (`serial_open.py`); `set_mode` (Task 11); `MidiIO`, `MidiRole`, `sysex_bootloader_esp` (Task 10); `Device`, `UsbMode`, `discover` (`devices.py`); `Console`, `BootResult` (`console.py`); `HilError` + `FLASH_FAILED, NOT_SUPPORTED, NO_DEVICE, NO_CDC_IN_AUDIO_MODE, BAD_ARGS, TIMEOUT`.
- Produces (contract verbatim, plus keyword-only injectables the contract is silent on):
  - `ota_flash(device, firmware: Path, *, delta_base: Path | None = None, progress: Callable[[int, int], None] | None = None, timeout_s: float = 300.0, serial_factory=open_serial, set_mode_fn=set_mode, sleep=time.sleep, clock=time.monotonic) -> dict` → `{"bytes","seconds","kbps","version","mode":"full"|"delta"}`
  - `request_bootloader(device, target: str = "esp", *, method: str = "cdc,midi", timeout_s: float = 10.0, serial_factory=open_serial, midi_factory=MidiIO, discover_fn=discover, sleep=time.sleep, clock=time.monotonic) -> dict` → `{"bootloader_port": str | None}`
  - `flash(device, firmware: Path, *, transport: str = "ota", wait_boot: bool = True, console: Console | None = None, progress=None, ota_flash_fn=ota_flash, console_factory=Console) -> dict` → `{"flash": <ota_flash dict>, "boot": BootResult.__dict__ | None}`
  - `firmware_version(path: Path) -> str` (bin offset 48, 32 bytes, NUL-terminated — `ota_flash.py get_firmware_version`), `CHUNK_SIZE = 4096`, `OTA_WAIT_TIMEOUT_S = 90`, `OTA_ACK_TIMEOUT_S = 30`, `OTA_FINAL_TIMEOUT_S = 60`, `BOOTLOADER_SETTLE_S = 3.0`, `BOOTLOADER_POLL_S = 0.5`.
- Decisions: the serial port used is `device.ports.cdc.path`; if it is `None` after a mode switch → `HilError(NO_CDC_IN_AUDIO_MODE)`; `timeout_s` bounds the whole transfer (checked per chunk; exceeding it → `TIMEOUT`); a chunk with no ack within `OTA_ACK_TIMEOUT_S` (empty `readline()`) → `FLASH_FAILED "no ack"`; every `OTA_ERROR …` → `FLASH_FAILED` with `details={"reply": line}`; `progress(recv, total)` is called once per `OK recv/total` line and only when `recv` grew (monotonic); delta mode uses `detools.create_patch(base, new, patch, compression="heatshrink")` into `io.BytesIO`, `OTA_DELTA <size> <version>`; `detools` missing → `NOT_SUPPORTED` with hint `pip install detools`; `request_bootloader` with `target="stm"` sends `STM_DFU` over CDC and does not wait (STM DFU is not an Espressif PID) → `{"bootloader_port": None}`; `target="esp"` tries methods in the given order, stops at the first that could be sent (CDC needs `ports.cdc`, MIDI needs `ports.esp_midi`), then sleeps `BOOTLOADER_SETTLE_S` and polls `discover_fn` for a Device with `ports.bootloader` (any Device: the ROM bootloader enumerates with a different serial), returning its path or `None` on timeout (not an error — mirrors `requestBootloader.py`); no method possible → `NO_DEVICE`; `flash(transport="uart")` → `NOT_SUPPORTED` hint `use idf.py -p <PORT> flash`; `wait_boot` with no console and no `ports.console` → `boot: None`; a console passed in must already be open; a console created here is opened with `reset=False` (the OTA reboot is the boot we wait for) and closed afterwards.

- [ ] **Step 1: Write the failing tests**

Create `/home/matixan/GIT/crosspad-hil/tests/test_ota.py`:

```python
from __future__ import annotations

import sys
import types
from dataclasses import replace
from pathlib import Path

import pytest

from crosspad_hil.devices import (
    AudioCardInfo,
    Device,
    MidiPortInfo,
    Ports,
    SerialPortInfo,
    UsbMode,
)
from crosspad_hil.errors import FLASH_FAILED, NO_DEVICE, NOT_SUPPORTED, HilError
from crosspad_hil.midi import MidiIO
from crosspad_hil.ota import (
    CHUNK_SIZE,
    OTA_ACK_TIMEOUT_S,
    OTA_WAIT_TIMEOUT_S,
    firmware_version,
    flash,
    ota_flash,
    request_bootloader,
)
from tests.fakes import FakeMidiBus

CDC = SerialPortInfo(path="/dev/ttyACM0", vid=0x303A, pid=0x3456, serial="ABCD1234",
                     product="Crosspad", location="1-2:1.0")
CON = SerialPortInfo(path="/dev/ttyACM1", vid=0x0483, pid=0x5740, serial="STM1",
                     product="CrossPad MIDI+Serial", location="1-2:1.2")
BOOT = SerialPortInfo(path="/dev/ttyACM2", vid=0x303A, pid=0x1001, serial=None,
                      product="USB JTAG/serial debug unit", location="1-2:1.0")
MIDI = MidiPortInfo(name="Crosspad MIDI 1", rtmidi_out=0, rtmidi_in=0, alsa_hw=None,
                    rawmidi=None)
UAC = AudioCardInfo(name="Crosspad Audio", sounddevice_index=3, alsa_id="hw:3")


def dev_default() -> Device:
    return Device(id="dev_1234", serial="ABCD1234", usb_mode=UsbMode.DEFAULT,
                  ports=Ports(cdc=CDC, console=CON, esp_midi=MIDI))


def dev_audio() -> Device:
    return Device(id="dev_1234", serial="ABCD1234", usb_mode=UsbMode.AUDIO,
                  ports=Ports(uac2=UAC, console=CON, esp_midi=MIDI))


def make_firmware(tmp_path: Path, size: int, version: str = "v2.0.1-7-gabc") -> Path:
    body = bytearray((i * 7 + 3) & 0xFF for i in range(size))
    ver = version.encode() + b"\0"
    body[48:48 + len(ver)] = ver
    p = tmp_path / "CrossPad.bin"
    p.write_bytes(bytes(body))
    return p


class FakeOtaSerial:
    """Plays the device side of ota_cdc.cpp: OTA_BEGIN handshake, per-write 'OK recv/total',
    final OTA_OK. Text commands are matched; binary writes are counted as firmware bytes."""

    def __init__(self, *, wait_first: bool = False, ready: bool = True,
                 fail_after: int | None = None, drop_ack_after: int | None = None) -> None:
        self.wait_first = wait_first
        self.ready = ready
        self.fail_after = fail_after
        self.drop_ack_after = drop_ack_after
        self.queue: list[bytes] = []
        self.written: list[bytes] = []
        self.timeout: float = 0.0
        self.timeouts: list[float] = []
        self.total = 0
        self.received = 0
        self.began: str | None = None
        self.is_open = True
        self.dtr = False
        self.rts = False
        self.control_history: list[tuple[str, bool]] = []
        self.input_resets = 0

    def __setattr__(self, name: str, value) -> None:
        if name == "timeout" and "timeouts" in self.__dict__:
            self.__dict__["timeouts"].append(value)
        if name in ("dtr", "rts") and "control_history" in self.__dict__:
            self.__dict__["control_history"].append((name, value))
        object.__setattr__(self, name, value)

    def reset_input_buffer(self) -> None:
        self.input_resets += 1

    def write(self, data: bytes) -> int:
        self.written.append(bytes(data))
        if self.began is None:
            text = data.decode("ascii", "replace").strip()
            if not text.startswith("OTA_"):
                return len(data)              # BOOTLOADER_REQUEST / STM_DFU: no reply
            self.began = text
            parts = text.split(" ")
            self.total = int(parts[1])
            if self.wait_first:
                self.queue.append(b"OTA_WAIT\r\n")
            self.queue.append(b"OTA_READY\r\n" if self.ready else b"OTA_ERROR no_partition\r\n")
            return len(data)
        self.received += len(data)
        if self.fail_after is not None and self.received >= self.fail_after:
            self.queue.append(b"OTA_ERROR write_ESP_ERR_FLASH_OP_FAIL\r\n")
            return len(data)
        if self.drop_ack_after is not None and self.received >= self.drop_ack_after:
            return len(data)
        self.queue.append(f"OK {self.received}/{self.total}\r\n".encode())
        if self.received >= self.total:
            self.queue.append(b"I (1234) ota_cdc: OTA finished\r\n")  # noise before OTA_OK
            self.queue.append(b"OTA_OK\r\n")
        return len(data)

    def readline(self) -> bytes:
        if self.queue:
            return self.queue.pop(0)
        return b""

    def close(self) -> None:
        self.is_open = False


def factory_for(ser: FakeOtaSerial):
    calls: list[dict] = []

    def factory(path: str, **kw):
        calls.append({"path": path, **kw})
        return ser
    factory.calls = calls  # type: ignore[attr-defined]
    return factory


def test_firmware_version_offset_48(tmp_path: Path) -> None:
    fw = make_firmware(tmp_path, 100, "v1.2.3")
    assert firmware_version(fw) == "v1.2.3"
    assert firmware_version(tmp_path / "missing.bin") == ""


def test_ota_flash_full_dialogue(tmp_path: Path) -> None:
    fw = make_firmware(tmp_path, CHUNK_SIZE * 2 + 100)
    ser = FakeOtaSerial()
    fac = factory_for(ser)
    seen: list[tuple[int, int]] = []
    ticks = iter(range(0, 1000))
    r = ota_flash(dev_default(), fw, progress=lambda a, b: seen.append((a, b)),
                  serial_factory=fac, sleep=lambda s: None, clock=lambda: next(ticks) * 0.5)
    assert fac.calls[0]["path"] == "/dev/ttyACM0"
    assert fac.calls[0]["baud"] == 115200 and fac.calls[0]["timeout"] == OTA_ACK_TIMEOUT_S
    assert ser.input_resets == 1
    assert ser.began == f"OTA_BEGIN {fw.stat().st_size} v2.0.1-7-gabc"
    assert ser.written[0] == f"OTA_BEGIN {fw.stat().st_size} v2.0.1-7-gabc\n".encode()
    chunks = ser.written[1:]
    assert [len(c) for c in chunks] == [CHUNK_SIZE, CHUNK_SIZE, 100]
    assert b"".join(chunks) == fw.read_bytes()
    total = fw.stat().st_size
    assert seen == [(CHUNK_SIZE, total), (2 * CHUNK_SIZE, total), (total, total)]
    assert r["bytes"] == total and r["mode"] == "full" and r["version"] == "v2.0.1-7-gabc"
    assert r["seconds"] > 0 and r["kbps"] > 0
    assert not ser.is_open


def test_ota_flash_ota_wait_extends_timeout(tmp_path: Path) -> None:
    fw = make_firmware(tmp_path, 10)
    ser = FakeOtaSerial(wait_first=True)
    ota_flash(dev_default(), fw, serial_factory=factory_for(ser), sleep=lambda s: None)
    # ota_flash.py ota_begin(): 90 s while waiting for the on-device confirmation, then 30 s
    assert OTA_WAIT_TIMEOUT_S in ser.timeouts
    assert ser.timeouts[-1] == OTA_ACK_TIMEOUT_S or ser.timeouts[-1] == 60


def test_ota_flash_error_paths(tmp_path: Path) -> None:
    fw = make_firmware(tmp_path, CHUNK_SIZE * 3)
    ser = FakeOtaSerial(fail_after=CHUNK_SIZE * 2)
    with pytest.raises(HilError) as e:
        ota_flash(dev_default(), fw, serial_factory=factory_for(ser), sleep=lambda s: None)
    assert e.value.code == FLASH_FAILED
    assert e.value.details["reply"].startswith("OTA_ERROR write_")
    assert not ser.is_open

    ser2 = FakeOtaSerial(ready=False)
    with pytest.raises(HilError) as e:
        ota_flash(dev_default(), fw, serial_factory=factory_for(ser2), sleep=lambda s: None)
    assert e.value.code == FLASH_FAILED
    assert "OTA_READY" in e.value.message

    ser3 = FakeOtaSerial(drop_ack_after=CHUNK_SIZE)
    with pytest.raises(HilError) as e:
        ota_flash(dev_default(), fw, serial_factory=factory_for(ser3), sleep=lambda s: None)
    assert e.value.code == FLASH_FAILED
    assert "no ack" in e.value.message

    with pytest.raises(HilError) as e:
        ota_flash(dev_default(), tmp_path / "nope.bin", serial_factory=factory_for(ser))
    assert e.value.code == FLASH_FAILED


def test_ota_flash_leaves_audio_mode_first(tmp_path: Path) -> None:
    fw = make_firmware(tmp_path, 10)
    ser = FakeOtaSerial()
    switched: list[UsbMode] = []

    def fake_set_mode(device: Device, mode: UsbMode, **kw) -> Device:
        switched.append(mode)
        return dev_default()

    ota_flash(dev_audio(), fw, serial_factory=factory_for(ser), set_mode_fn=fake_set_mode,
              sleep=lambda s: None)
    assert switched == [UsbMode.DEFAULT]
    assert ser.began is not None


def test_ota_flash_delta_requires_detools(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fw = make_firmware(tmp_path, 300)
    base = tmp_path / "base.bin"
    base.write_bytes(bytes(300))
    monkeypatch.setitem(sys.modules, "detools", None)   # import fails
    with pytest.raises(HilError) as e:
        ota_flash(dev_default(), fw, delta_base=base, serial_factory=factory_for(FakeOtaSerial()))
    assert e.value.code == NOT_SUPPORTED

    fake = types.ModuleType("detools")

    def create_patch(ffrom, fto, fpatch, compression="heatshrink") -> None:
        assert compression == "heatshrink"
        fpatch.write(b"PATCH" + fto.read()[:20])
    fake.create_patch = create_patch  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "detools", fake)
    ser = FakeOtaSerial()
    r = ota_flash(dev_default(), fw, delta_base=base, serial_factory=factory_for(ser),
                  sleep=lambda s: None)
    assert ser.began == "OTA_DELTA 25 v2.0.1-7-gabc"
    assert r["mode"] == "delta" and r["bytes"] == 25


def test_request_bootloader_cdc_then_poll(tmp_path: Path) -> None:
    ser = FakeOtaSerial()
    boot_dev = Device(id="dev_boot", serial=None, usb_mode=UsbMode.BOOTLOADER,
                      ports=Ports(bootloader=BOOT))
    inventories = iter([[dev_default()], [], [boot_dev]])
    bus = FakeMidiBus()
    slept: list[float] = []
    r = request_bootloader(dev_default(), "esp", method="cdc,midi",
                           serial_factory=factory_for(ser),
                           midi_factory=lambda d, role: MidiIO(d, role, out_factory=bus.out_factory,
                                                               in_factory=bus.in_factory),
                           discover_fn=lambda: next(inventories), sleep=slept.append)
    assert ser.written == [b"BOOTLOADER_REQUEST\n"]
    assert bus.sent == []                      # CDC succeeded; MIDI not attempted
    assert r == {"bootloader_port": "/dev/ttyACM2"}
    assert 3.0 in slept                        # BOOTLOADER_SETTLE_S before the first scan


def test_request_bootloader_midi_fallback_and_timeout() -> None:
    bus = FakeMidiBus()
    no_cdc = replace(dev_default(), ports=Ports(esp_midi=MIDI, console=CON))
    clock = iter([0.0, 0.0, 4.0, 8.0, 12.0, 16.0])
    r = request_bootloader(no_cdc, "esp", method="cdc,midi", timeout_s=10.0,
                           midi_factory=lambda d, role: MidiIO(d, role, out_factory=bus.out_factory,
                                                               in_factory=bus.in_factory),
                           discover_fn=lambda: [], sleep=lambda s: None,
                           clock=lambda: next(clock))
    assert bus.sent == [[0xF0, 0x7D, 0x19, 0x00, 0xF7]]
    assert r == {"bootloader_port": None}
    nothing = replace(dev_default(), ports=Ports(console=CON))
    with pytest.raises(HilError) as e:
        request_bootloader(nothing, "esp", discover_fn=lambda: [])
    assert e.value.code == NO_DEVICE


def test_request_bootloader_stm_sends_dfu_only() -> None:
    ser = FakeOtaSerial()
    r = request_bootloader(dev_default(), "stm", serial_factory=factory_for(ser),
                           discover_fn=lambda: [], sleep=lambda s: None)
    assert ser.written == [b"STM_DFU\n"]
    assert r == {"bootloader_port": None}
    with pytest.raises(HilError) as e:
        request_bootloader(dev_default(), "fpga")
    assert e.value.code == NOT_SUPPORTED


class FakeConsole:
    def __init__(self, port: str, **kw) -> None:
        self.port = port
        self.kw = kw
        self.opened: list[bool] = []
        self.closed = False

    def open(self, reset: bool = False) -> None:
        self.opened.append(reset)

    def close(self) -> None:
        self.closed = True

    def wait_boot(self, timeout_s=None, settle_s: float = 3.0):
        from crosspad_hil.console import BootResult
        return BootResult(complete=True, missing=[], fatal=[], errors=[], bootloops=0,
                          seconds=12.5)


def test_flash_composes_ota_and_wait_boot(tmp_path: Path) -> None:
    fw = make_firmware(tmp_path, 10)
    made: list[FakeConsole] = []

    def console_factory(port: str, **kw) -> FakeConsole:
        c = FakeConsole(port, **kw)
        made.append(c)
        return c

    def fake_ota(device, firmware, *, progress=None, **kw) -> dict:
        return {"bytes": 10, "seconds": 1.0, "kbps": 0.01, "version": "v", "mode": "full"}

    r = flash(dev_default(), fw, ota_flash_fn=fake_ota, console_factory=console_factory)
    assert r["flash"]["bytes"] == 10
    assert r["boot"]["complete"] is True and r["boot"]["seconds"] == 12.5
    assert made[0].port == "/dev/ttyACM1" and made[0].opened == [False] and made[0].closed

    r2 = flash(dev_default(), fw, wait_boot=False, ota_flash_fn=fake_ota,
               console_factory=console_factory)
    assert r2["boot"] is None and len(made) == 1

    given = FakeConsole("/dev/ttyACM1")
    r3 = flash(dev_default(), fw, console=given, ota_flash_fn=fake_ota,
               console_factory=console_factory)
    assert r3["boot"]["complete"] is True and given.opened == [] and not given.closed

    with pytest.raises(HilError) as e:
        flash(dev_default(), fw, transport="uart", ota_flash_fn=fake_ota)
    assert e.value.code == NOT_SUPPORTED
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_ota.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.ota'`

- [ ] **Step 3: Write ota.py**

Create `/home/matixan/GIT/crosspad-hil/crosspad_hil/ota.py`:

```python
"""OTA over USB CDC, ROM-bootloader request, and flash-then-wait-for-boot.

Byte-for-byte port of platform-idf/tools/ota_flash.py (ota_begin, send_data_to_device,
get_firmware_version, generate_delta_patch) and tools/requestBootloader.py
(try_bootloader_request, find_bootloader_device polling). The device side is
main/ota_cdc.cpp: OTA_BEGIN|OTA_DELTA <size> <version> → OTA_WAIT? → OTA_READY;
per 4096-byte write "OK <recv>/<total>"; OTA_OK or "OTA_ERROR <reason>".
"""
from __future__ import annotations

import io
import time
from pathlib import Path
from typing import Any, Callable

from crosspad_hil.console import Console
from crosspad_hil.devices import Device, UsbMode, discover
from crosspad_hil.errors import (
    FLASH_FAILED,
    NO_CDC_IN_AUDIO_MODE,
    NO_DEVICE,
    NOT_SUPPORTED,
    TIMEOUT,
    HilError,
)
from crosspad_hil.midi import MidiIO, MidiRole, sysex_bootloader_esp
from crosspad_hil.serial_open import open_serial
from crosspad_hil.usbmode import set_mode

CHUNK_SIZE = 4096            # ota_flash.py CHUNK_SIZE (== OTA_WRITE_BUF_SIZE on device)
OTA_ACK_TIMEOUT_S = 30       # ota_flash.py serial.Serial(port, 115200, timeout=30)
OTA_WAIT_TIMEOUT_S = 90      # ota_flash.py ota_begin(): user confirmation on the device
OTA_FINAL_TIMEOUT_S = 60     # ota_flash.py send_data_to_device(): delta finalization
OTA_FINAL_READS = 30         # ota_flash.py: for _ in range(30)
OTA_CONNECT_SETTLE_S = 0.5   # ota_flash.py: time.sleep(0.5) after opening the port
BOOTLOADER_SETTLE_S = 3.0    # requestBootloader.py: time.sleep(3) before scanning
BOOTLOADER_POLL_S = 0.5      # requestBootloader.py: poll_interval
CDC_BOOTLOADER_CMD = "BOOTLOADER_REQUEST"   # main.cpp check_usb_bootloader_request
CDC_STM_DFU_CMD = "STM_DFU"


def firmware_version(path: Path) -> str:
    """ESP-IDF app version: esp_app_desc_t.version at bin offset 48 (0x30), 32 bytes."""
    try:
        with open(path, "rb") as f:
            f.seek(48)
            return f.read(32).split(b"\0")[0].decode("utf-8", "ignore")
    except OSError:
        return ""


def _readline(ser: Any) -> str:
    return ser.readline().decode(errors="ignore").strip()


def _fail(ser: Any, message: str, **details: Any) -> HilError:
    try:
        ser.close()
    except Exception:
        pass
    return HilError(FLASH_FAILED, message, hint="check the device console (STM VCP) for ota_cdc "
                    "logs; a rejected OTA_WAIT shows as OTA_ERROR rejected", **details)


def _ota_begin(ser: Any, command: str) -> None:
    """ota_flash.py ota_begin(): OTA_BEGIN/OTA_DELTA, tolerate OTA_WAIT, require OTA_READY."""
    ser.write(command.encode())
    response = _readline(ser)
    if response == "OTA_WAIT":
        ser.timeout = OTA_WAIT_TIMEOUT_S
        response = _readline(ser)
        ser.timeout = OTA_ACK_TIMEOUT_S
    if response != "OTA_READY":
        raise _fail(ser, f"expected OTA_READY, got {response!r}", reply=response)


def _send_data(ser: Any, data: bytes, *, progress: Callable[[int, int], None] | None,
               deadline: float, clock: Callable[[], float]) -> None:
    """ota_flash.py send_data_to_device(): chunked write, ack per chunk, final OTA_OK."""
    total = len(data)
    sent = 0
    last_reported = 0
    while sent < total:
        if clock() > deadline:
            ser.close()
            raise HilError(TIMEOUT, f"OTA exceeded its time budget at {sent}/{total} bytes",
                           sent=sent, total=total)
        chunk_end = min(sent + CHUNK_SIZE, total)
        ser.write(data[sent:chunk_end])
        sent = chunk_end
        while True:
            response = _readline(ser)
            if not response:
                raise _fail(ser, f"no ack from device (sent {sent}/{total})",
                            sent=sent, total=total)
            if response.startswith("OK "):
                received = int(response[3:].split("/")[0])
                if progress is not None and received > last_reported:
                    last_reported = received
                    progress(received, total)
                break
            if response == "OTA_OK":
                return
            if response.startswith("OTA_ERROR"):
                raise _fail(ser, f"device reported {response}", reply=response,
                            sent=sent, total=total)
            # stale echo / log noise: keep reading
    ser.timeout = OTA_FINAL_TIMEOUT_S
    response = ""
    for _ in range(OTA_FINAL_READS):
        response = _readline(ser)
        if response == "OTA_OK":
            return
        if response.startswith("OK "):
            received = int(response[3:].split("/")[0])
            if progress is not None and received > last_reported:
                last_reported = received
                progress(received, total)
            continue
        if response.startswith("OTA_ERROR"):
            raise _fail(ser, f"device reported {response}", reply=response,
                        sent=sent, total=total)
        if not response:
            break
    raise _fail(ser, f"no OTA_OK after transfer; final response {response!r}",
                reply=response, sent=sent, total=total)


def _delta_patch(base: Path, new: Path) -> bytes:
    """ota_flash.py generate_delta_patch(): detools heatshrink patch, in memory."""
    try:
        import detools  # type: ignore[import-not-found]
    except ImportError as exc:
        raise HilError(NOT_SUPPORTED, "delta OTA needs the 'detools' package",
                       hint="pip install detools") from exc
    if detools is None:
        raise HilError(NOT_SUPPORTED, "delta OTA needs the 'detools' package",
                       hint="pip install detools")
    patch = io.BytesIO()
    with open(base, "rb") as base_f, open(new, "rb") as new_f:
        detools.create_patch(base_f, new_f, patch, compression="heatshrink")
    return patch.getvalue()


def ota_flash(device: Device, firmware: Path, *, delta_base: Path | None = None,
              progress: Callable[[int, int], None] | None = None, timeout_s: float = 300.0,
              serial_factory: Callable[..., Any] = open_serial,
              set_mode_fn: Callable[..., Device] = set_mode,
              sleep: Callable[[float], None] = time.sleep,
              clock: Callable[[], float] = time.monotonic) -> dict:
    """Full or delta OTA over the ESP CDC port. Returns {bytes, seconds, kbps, version, mode}."""
    firmware = Path(firmware)
    if not firmware.is_file():
        raise HilError(FLASH_FAILED, f"firmware not found: {firmware}",
                       hint="build first: idf.py build (build/CrossPad.bin)")
    if delta_base is not None and not Path(delta_base).is_file():
        raise HilError(FLASH_FAILED, f"base firmware not found: {delta_base}")

    if device.usb_mode is UsbMode.AUDIO:
        # ota_flash.py ensure_port(): MIDI+UAC2 has no CDC → SysEx 0x1B 01 and wait
        device = set_mode_fn(device, UsbMode.DEFAULT)
    if device.ports.cdc is None:
        raise HilError(NO_CDC_IN_AUDIO_MODE if device.usb_mode is UsbMode.AUDIO else NO_DEVICE,
                       f"{device.id} has no CDC port for OTA",
                       hint="usbmode.set default, or check `crosspad-hil devices`")

    version = firmware_version(firmware)
    if delta_base is not None:
        payload = _delta_patch(Path(delta_base), firmware)
        command = f"OTA_DELTA {len(payload)} {version}\n"
        mode = "delta"
    else:
        payload = firmware.read_bytes()
        command = f"OTA_BEGIN {len(payload)} {version}\n"
        mode = "full"

    ser = serial_factory(device.ports.cdc.path, baud=115200, timeout=OTA_ACK_TIMEOUT_S)
    sleep(OTA_CONNECT_SETTLE_S)
    if hasattr(ser, "reset_input_buffer"):
        ser.reset_input_buffer()
    t0 = clock()
    _ota_begin(ser, command)
    _send_data(ser, payload, progress=progress, deadline=t0 + timeout_s, clock=clock)
    elapsed = max(clock() - t0, 1e-6)
    try:
        ser.close()
    except Exception:
        pass
    return {"bytes": len(payload), "seconds": round(elapsed, 3),
            "kbps": round(len(payload) / elapsed / 1024, 1), "version": version, "mode": mode}


def _send_cdc_line(device: Device, text: str, serial_factory: Callable[..., Any],
                   sleep: Callable[[float], None]) -> bool:
    """requestBootloader.py send_usb_cdc_message(): write line, no reply expected."""
    if device.ports.cdc is None:
        return False
    ser = serial_factory(device.ports.cdc.path, baud=115200, timeout=2)
    try:
        sleep(0.1)
        ser.write(text.encode("utf-8") + b"\n")
        if hasattr(ser, "flush"):
            ser.flush()
        sleep(0.1)
    finally:
        ser.close()
    return True


def request_bootloader(device: Device, target: str = "esp", *, method: str = "cdc,midi",
                       timeout_s: float = 10.0,
                       serial_factory: Callable[..., Any] = open_serial,
                       midi_factory: Callable[..., Any] = MidiIO,
                       discover_fn: Callable[[], list[Device]] = discover,
                       sleep: Callable[[float], None] = time.sleep,
                       clock: Callable[[], float] = time.monotonic) -> dict:
    """Ask the ESP for its ROM bootloader (or the STM for DFU). {bootloader_port: path|None}."""
    if target == "stm":
        if not _send_cdc_line(device, CDC_STM_DFU_CMD, serial_factory, sleep):
            raise HilError(NO_DEVICE, f"{device.id} has no CDC port to send {CDC_STM_DFU_CMD}")
        return {"bootloader_port": None}
    if target != "esp":
        raise HilError(NOT_SUPPORTED, f"bootloader target {target!r}", hint="use 'esp' or 'stm'")

    methods = [m.strip().lower() for m in method.split(",") if m.strip()]
    for m in methods:
        if m not in ("cdc", "midi"):
            raise HilError(NOT_SUPPORTED, f"bootloader method {m!r}", hint="cdc, midi")
    sent = False
    for m in methods:
        if m == "cdc" and _send_cdc_line(device, CDC_BOOTLOADER_CMD, serial_factory, sleep):
            sent = True
            break
        if m == "midi" and device.ports.esp_midi is not None:
            # requestBootloader.py send_sysex_message(): F0 7D 19 00 F7 on the ESP port
            with midi_factory(device, MidiRole.ESP) as mio:
                mio.send_sysex(sysex_bootloader_esp())
            sleep(0.1)
            sent = True
            break
    if not sent:
        raise HilError(NO_DEVICE, f"{device.id} has neither a CDC nor an ESP MIDI port",
                       hint="is it already in bootloader mode? run `crosspad-hil devices`")

    sleep(BOOTLOADER_SETTLE_S)
    deadline = clock() + timeout_s
    while True:
        for d in discover_fn():
            if d.ports.bootloader is not None:
                return {"bootloader_port": d.ports.bootloader.path}
        if clock() >= deadline:
            return {"bootloader_port": None}
        sleep(BOOTLOADER_POLL_S)


def flash(device: Device, firmware: Path, *, transport: str = "ota", wait_boot: bool = True,
          console: Console | None = None, progress: Callable[[int, int], None] | None = None,
          ota_flash_fn: Callable[..., dict] = ota_flash,
          console_factory: Callable[..., Any] = Console) -> dict:
    """ota_flash() and then Console.wait_boot() on the STM VCP. {flash, boot}."""
    if transport != "ota":
        raise HilError(NOT_SUPPORTED, f"flash transport {transport!r} is not available in P0",
                       hint="use idf.py -p <PORT> flash for UART, or transport='ota'")
    result = ota_flash_fn(device, firmware, progress=progress)
    boot: dict | None = None
    if wait_boot:
        if console is not None:
            boot = dict(vars(console.wait_boot()))
        elif device.ports.console is not None:
            own = console_factory(device.ports.console.path)
            own.open(reset=False)
            try:
                boot = dict(vars(own.wait_boot()))
            finally:
                own.close()
    return {"flash": result, "boot": boot}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_ota.py -q && ruff check crosspad_hil/ota.py tests/test_ota.py`
Expected: `10 passed` and `All checks passed!`

- [ ] **Step 5: Run the whole suite once**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest -q`
Expected: all tests pass (the counts of earlier tasks plus 26 from this chunk).

- [ ] **Step 6: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/ota.py tests/test_ota.py && git commit -m "feat(ota): port ota_flash and requestBootloader; flash() waits for boot on the console"
```
