# crosspad-hil P0 scenarios, CLI and daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `crosspad-hil` usable with no AI at all — the P0 HIL scenarios (`smoke`, `app_churn`, `kit_churn`, `led_state`, `usb_mode_cycle`) as a CLI with stable exit codes and `--json`, plus the NDJSON daemon (`crosspad-hil serve`) that crosspad-mcp v10 will proxy, and shims so `platform-idf/tools/hil_*.py` keep working.

**Architecture:** `scenarios/base.py` defines `Params` dataclasses → argparse (CLI) and JSON args (daemon) from one definition, `Context` (device, workdir, cancel, console/cdc factories) and `Report` (typed dict + artifacts + exit code). `cli.py` is a thin argparse tree over the core modules and scenarios. `serve.py` runs ops on a thread pool with explicit handles (`con_*`, `cdc_*`, `task_*`), per-device locks and unsolicited events — the same NDJSON pattern as `crosspad-mcp/tracer/swd_tracer.py`. `record.py` captures real device transcripts for replay tests.

**Tech Stack:** as plan A (Python ≥ 3.10, pyserial, python-rtmidi, PyYAML, pytest, ruff); no new runtime deps.

**Spec:** `crosspad-mcp/docs/superpowers/specs/2026-08-25-crosspad-hil-and-mcp-v10-design.md` (§2.2 daemon protocol, §2.5 scenarios, §2.6 CLI, §6 migration, §7 testing, §8 P0). **Prerequisite:** plan A (`2026-08-25-crosspad-hil-p0-core.md`) tasks 1–12 merged — this plan consumes their public API as listed in the contract.

## Global Constraints

- Same repo, package and lint/test rules as plan A.
- Scenario `Report.data` keys for `smoke` are byte-for-byte the old `hil_smoke.py --json` keys (`pass, missing, optional_missing, errors, fatal, bootloops`); exit codes `0 PASS / 1 FAIL / 2 environment` for every scenario and CLI command.
- Daemon protocol: one JSON object per line; requests `{id, op, args}`; responses `{id, ok, result|error}`; events `{ev, …}`; stderr for logs; never a console line per event — only parsed, significant events.
- A scenario never opens a port itself; it asks `Context.open_console()` / `Context.open_cdc()` (so tests inject fakes and locks are uniform).
- `kit_churn` must fail when zero pad hits land inside a swap window (false-negative guard) — a test proves it.
- `platform-idf` shims are 3 lines + a deprecation line on stderr; they must run `--help` successfully after the change.

---
# Plan B — chunk B1: scenario framework and transcript record/replay

Repo: `/home/matixan/GIT/crosspad-hil` (package `crosspad_hil`, created by Plan A Task 1).
All commands below run from `/home/matixan/GIT/crosspad-hil` with the venv that has
`pytest`, `pyserial`, `pyyaml`, `pydantic>=2` installed (`pip install -e ".[dev]"`).

Assumptions shared by both tasks (from the contract; nothing here is invented):

- `crosspad_hil.errors.HilError(code, message, hint=None, **details)` with `.to_dict()`, and the
  string constants `ENV, CANCELLED, BAD_ARGS, NO_DEVICE, AMBIGUOUS_DEVICE, PORT_BUSY,
  NO_CDC_IN_AUDIO_MODE, TIMEOUT` exist in `crosspad_hil/errors.py` (Plan A).
- `crosspad_hil.devices.Device / Ports / SerialPortInfo / UsbMode / discover / select` (Plan A).
- `crosspad_hil.console.Console(port, *, log_path=None, ..., serial_factory=open_serial)` with
  `.open(reset: bool)`, `.close()`; `crosspad_hil.cdc.CdcLink(port, *, serial_factory=open_serial)`
  with `.open()`, `.close()`, `.transact(cmd)` (Plan A).
- `crosspad_hil.serial_open.open_serial(path, *, baud=115200, timeout=0.2, reset=False, serial_cls=...)`.
- `tests/fakes.py` defines `FakeSerial(script=())` with `write(b)`, `readline()`, `read(n)`,
  `feed(lines)`, `close()`, `dtr`, `rts`, `is_open`, `timeout`, `control_history`, `written`
  (Plan A). `tests/conftest.py` is importable as a package root: Plan A's `pyproject.toml` has
  `[tool.pytest.ini_options] pythonpath = ["."]`, so tests import `from tests.fakes import FakeSerial`.
- `PortLock` resolves its default directory from `$XDG_RUNTIME_DIR`; every test below sets that
  to `tmp_path` via `monkeypatch` so no lock file leaks between tests.

---

### Task 1: Scenario protocol, registry, argparse bridge, `run_scenario`

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/base.py`
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/__init__.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_scenarios_base.py`

**Interfaces:**
- Consumes (contract, Plan A):
  - `HilError(code, message, hint=None, **details)`, codes `ENV, CANCELLED, BAD_ARGS, NO_DEVICE,
    AMBIGUOUS_DEVICE, PORT_BUSY, NO_CDC_IN_AUDIO_MODE`
  - `Device`, `UsbMode`, `discover(backends=None) -> list[Device]`, `select(devices, device=None) -> Device`
  - `Console(port, *, log_path, serial_factory)`, `CdcLink(port, *, serial_factory)`
  - `open_serial(path, *, baud, timeout, reset, serial_cls)`
- Produces (contract names, verbatim):
  - `@dataclass Artifact(path: str, mime: str, role: str)`
  - `@dataclass Report(passed: bool, summary: str, data: dict, artifacts: list[Artifact], exit_code: int)`
    with `.to_dict() -> dict` (added; the CLI `--json` and daemon `task.done` need it)
  - `class Progress: __call__(self, progress: int, total: int | None, message: str) -> None` (no-op)
  - `@dataclass Context(device, workdir, cancelled, log, serial_factory=open_serial)` with
    `open_console(reset=False) -> Console`, `open_cdc() -> CdcLink`, `check_cancelled()`
  - `class Scenario(Protocol): name: str; Params: type; description: str; run(ctx, params, progress) -> Report`
  - `register(s) -> Scenario`, `get(name) -> Scenario`, `names() -> list[str]` — defined in
    `base.py`, re-exported from `scenarios/__init__.py`
  - `params_to_argparse(params_cls, parser) -> None`, `argparse_to_params(params_cls, ns) -> Any`
  - `params_schema(params_cls) -> list[dict]` (added; `[{name, type, default, help}]` for the daemon's
    `scenario.list` op and the MCP catalog)
  - `run_scenario(name, params, *, device=None, workdir=None, progress=None, cancelled=None, log=print) -> Report`
  - `ENV_EXIT_CODES: frozenset[str]` (added) — HilError codes mapped to exit 2
  - `scenarios/__init__.py`: `BUILTIN_MODULES = ("smoke", "app_churn", "kit_churn", "led_state",
    "usb_mode_cycle")` and `load_builtin() -> list[str]` (imports each builtin module so its
    `register()` side effect runs; returns the names that imported; a builtin whose module is not
    yet on disk is skipped by name only — later chunks fill them in)
- Contract ambiguities resolved here (stated, not guessed later):
  1. `Context.serial_factory` is an extra dataclass field (default `open_serial`) — the contract
     says "inject serial_factory through Context".
  2. `Context.open_console()` raises `HilError(NO_DEVICE)` when `device.ports.console is None`;
     `open_cdc()` raises `HilError(NO_CDC_IN_AUDIO_MODE)` when `usb_mode == AUDIO`, else
     `HilError(NO_DEVICE)` when `ports.cdc is None`.
  3. `run_scenario` exit mapping: scenario returned normally → `report.exit_code` as given by the
     scenario (0 if passed else 1 when the scenario left it at the default); `HilError` whose code
     is in `ENV_EXIT_CODES = {ENV, NO_DEVICE, AMBIGUOUS_DEVICE, PORT_BUSY, NO_CDC_IN_AUDIO_MODE}`
     → `Report(passed=False, exit_code=2, data={"error": e.to_dict()})`; `HilError(CANCELLED)` →
     `Report(passed=False, exit_code=1, summary="cancelled: …", data={"cancelled": True, "error": …})`;
     any other `HilError` → exit 1 with `data["error"]`; a non-`HilError` exception → exit 1 with
     `data["error"] = {"code": "INTERNAL", "message": repr(exc), "traceback": str}` (a crash in a
     scenario must still produce `report.json`).
  4. `report.json` layout: `{"scenario", "passed", "summary", "exit_code", "data", "artifacts",
     "params", "workdir", "started", "finished", "seconds"}`; `report.json` itself is appended to
     `artifacts` with `mime="application/json", role="report"`.
  5. Registry: re-registering the same name replaces the previous entry (tests re-import modules).
  6. `params_to_argparse` type rules: `bool` → `--x` (store_true) plus `--no-x` (store_false), both
     `dest=x`; `int`/`float`/`str` → typed option; `X | None` / `Optional[X]` → typed option with
     default `None`; `list[int]` / `list[str]` (optionally `| None`) → comma-separated string parsed
     into a list (`"8,12,16"` → `[8, 12, 16]`, empty string → `[]`); field name `foo_bar` → `--foo-bar`;
     help = `metadata["help"]` + ` (default: …)`. Unsupported annotations raise `TypeError` at
     parser-build time (a scenario author's bug, not a runtime one).

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_scenarios_base.py`:

```python
"""Scenario framework: registry, argparse bridge, Context, run_scenario."""
from __future__ import annotations

import argparse
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from crosspad_hil.devices import Device, Ports, SerialPortInfo, UsbMode
from crosspad_hil.errors import CANCELLED, ENV, HilError, NO_CDC_IN_AUDIO_MODE, NO_DEVICE
from crosspad_hil.scenarios import base
from crosspad_hil.scenarios.base import (
    Artifact,
    Context,
    Progress,
    Report,
    argparse_to_params,
    get,
    names,
    params_schema,
    params_to_argparse,
    register,
    run_scenario,
)
from tests.fakes import FakeSerial


# ── fixtures ────────────────────────────────────────────────────────────────


def make_device(usb_mode: UsbMode = UsbMode.DEFAULT, with_cdc: bool = True) -> Device:
    cdc = SerialPortInfo(
        path="/dev/fake-cdc", vid=0x303A, pid=0x3456, serial="ABC123",
        product="Crosspad", location="1-2.3",
    ) if with_cdc else None
    console = SerialPortInfo(
        path="/dev/fake-console", vid=0x0483, pid=0x5740, serial="STM1",
        product="CrossPad MIDI+Serial", location="1-2.4",
    )
    return Device(id="dev_test", serial="ABC123", usb_mode=usb_mode,
                  ports=Ports(cdc=cdc, console=console))


@pytest.fixture(autouse=True)
def _lock_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    (tmp_path / "run").mkdir()


@dataclass
class DummyParams:
    rounds: int = 3
    dwell: float = 1.5
    label: str | None = None
    kits: list[int] | None = None
    apps: list[str] | None = field(default=None, metadata={"help": "apps to cycle"})
    no_play: bool = False
    verbose: bool = field(default=True, metadata={"help": "chatty"})


class DummyScenario:
    name = "dummy"
    Params = DummyParams
    description = "a scenario that does nothing on hardware"

    def __init__(self) -> None:
        self.calls: list[tuple[int, int | None, str]] = []

    def run(self, ctx: Context, params: DummyParams, progress: Progress) -> Report:
        for i in range(params.rounds):
            ctx.check_cancelled()
            progress(i + 1, params.rounds, f"round {i + 1}")
        return Report(passed=True, summary=f"{params.rounds} rounds", data={"rounds": params.rounds},
                      artifacts=[Artifact(path="console.log", mime="text/plain", role="log")],
                      exit_code=0)


class RaisingScenario:
    name = "raising"
    Params = DummyParams
    description = "raises what its params say"

    def run(self, ctx: Context, params: DummyParams, progress: Progress) -> Report:
        raise HilError(params.label or ENV, "boom", hint="fix the bench")


class FailingScenario:
    name = "failing"
    Params = DummyParams
    description = "returns a failed report"

    def run(self, ctx: Context, params: DummyParams, progress: Progress) -> Report:
        return Report(passed=False, summary="3 of 5 hits missing", data={}, artifacts=[], exit_code=1)


class CrashingScenario:
    name = "crashing"
    Params = DummyParams
    description = "throws a plain exception"

    def run(self, ctx: Context, params: DummyParams, progress: Progress) -> Report:
        raise ValueError("unexpected")


@pytest.fixture
def registered() -> DummyScenario:
    s = DummyScenario()
    register(s)
    register(RaisingScenario())
    register(FailingScenario())
    register(CrashingScenario())
    return s


# ── registry ────────────────────────────────────────────────────────────────


def test_register_get_names(registered: DummyScenario) -> None:
    assert get("dummy") is registered
    assert "dummy" in names()
    assert names() == sorted(names())


def test_get_unknown_raises_bad_args() -> None:
    with pytest.raises(HilError) as ei:
        get("no-such-scenario")
    assert ei.value.code == "BAD_ARGS"
    assert "no-such-scenario" in ei.value.message


def test_register_replaces_same_name() -> None:
    a = DummyScenario()
    b = DummyScenario()
    register(a)
    register(b)
    assert get("dummy") is b


# ── argparse bridge ──────────────────────────────────────────────────────────


def test_params_to_argparse_defaults() -> None:
    p = argparse.ArgumentParser()
    params_to_argparse(DummyParams, p)
    ns = p.parse_args([])
    params = argparse_to_params(DummyParams, ns)
    assert params == DummyParams()


def test_params_to_argparse_all_flag_kinds() -> None:
    p = argparse.ArgumentParser()
    params_to_argparse(DummyParams, p)
    ns = p.parse_args([
        "--rounds", "7", "--dwell", "0.25", "--label", "x",
        "--kits", "8,12,16", "--apps", "Sampler,Sequencer", "--no-play", "--no-verbose",
    ])
    params = argparse_to_params(DummyParams, ns)
    assert params == DummyParams(rounds=7, dwell=0.25, label="x", kits=[8, 12, 16],
                                 apps=["Sampler", "Sequencer"], no_play=True, verbose=False)


def test_bool_flags_have_both_forms() -> None:
    p = argparse.ArgumentParser()
    params_to_argparse(DummyParams, p)
    assert argparse_to_params(DummyParams, p.parse_args(["--verbose"])).verbose is True
    assert argparse_to_params(DummyParams, p.parse_args(["--no-play"])).no_play is True
    assert argparse_to_params(DummyParams, p.parse_args(["--no-no-play"])).no_play is False


def test_help_metadata_and_default_in_help() -> None:
    p = argparse.ArgumentParser()
    params_to_argparse(DummyParams, p)
    text = p.format_help()
    assert "apps to cycle" in text
    assert "--kebab" not in text
    assert "--no-play" in text
    assert "(default: 3)" in text


def test_empty_list_flag_gives_empty_list() -> None:
    p = argparse.ArgumentParser()
    params_to_argparse(DummyParams, p)
    assert argparse_to_params(DummyParams, p.parse_args(["--kits", ""])).kits == []


def test_params_schema() -> None:
    schema = params_schema(DummyParams)
    by_name = {row["name"]: row for row in schema}
    assert by_name["rounds"] == {"name": "rounds", "type": "int", "default": 3, "help": ""}
    assert by_name["kits"]["type"] == "list[int] | None"
    assert by_name["apps"]["help"] == "apps to cycle"
    assert by_name["verbose"]["default"] is True


def test_unsupported_annotation_is_type_error() -> None:
    @dataclass
    class Bad:
        weird: dict[str, int] = field(default_factory=dict)

    with pytest.raises(TypeError):
        params_to_argparse(Bad, argparse.ArgumentParser())


# ── Context ──────────────────────────────────────────────────────────────────


def test_context_open_cdc_uses_injected_factory(tmp_path: Path) -> None:
    created: list[FakeSerial] = []

    def factory(path: str, **kw: Any) -> FakeSerial:
        fake = FakeSerial(script=[
            ("KIT_STATUS", "KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS"),
        ])
        fake.port = path
        created.append(fake)
        return fake

    ctx = Context(device=make_device(), workdir=tmp_path, cancelled=threading.Event(),
                  log=lambda s: None, serial_factory=factory)
    link = ctx.open_cdc()
    try:
        reply = link.transact("KIT_STATUS")
        assert reply.parsed is not None
        assert reply.parsed["current"] == 3
        assert reply.parsed["name"] == "DRUMS"
    finally:
        link.close()
    assert created and created[0].port == "/dev/fake-cdc"


def test_context_open_console_logs_into_workdir(tmp_path: Path) -> None:
    created: list[FakeSerial] = []

    def factory(path: str, **kw: Any) -> FakeSerial:
        fake = FakeSerial()
        created.append(fake)
        return fake

    ctx = Context(device=make_device(), workdir=tmp_path, cancelled=threading.Event(),
                  log=lambda s: None, serial_factory=factory)
    con = ctx.open_console()
    try:
        created[0].feed(["I (100) main: Platform fully initialized"])
        res = con.read(wait_ms=500, match="Platform fully")
        assert any("Platform fully initialized" in line for _, line in res.lines)
    finally:
        con.close()
    assert (tmp_path / "console.log").exists()
    # hygiene: opening the console never asserted DTR or RTS on the fake
    assert ("dtr", True) not in created[0].control_history
    assert ("rts", True) not in created[0].control_history


def test_context_open_cdc_in_audio_mode() -> None:
    ctx = Context(device=make_device(UsbMode.AUDIO, with_cdc=False), workdir=Path("."),
                  cancelled=threading.Event(), log=lambda s: None)
    with pytest.raises(HilError) as ei:
        ctx.open_cdc()
    assert ei.value.code == NO_CDC_IN_AUDIO_MODE


def test_context_open_cdc_without_port() -> None:
    ctx = Context(device=make_device(with_cdc=False), workdir=Path("."),
                  cancelled=threading.Event(), log=lambda s: None)
    with pytest.raises(HilError) as ei:
        ctx.open_cdc()
    assert ei.value.code == NO_DEVICE


def test_check_cancelled() -> None:
    ev = threading.Event()
    ctx = Context(device=make_device(), workdir=Path("."), cancelled=ev, log=lambda s: None)
    ctx.check_cancelled()
    ev.set()
    with pytest.raises(HilError) as ei:
        ctx.check_cancelled()
    assert ei.value.code == CANCELLED


# ── run_scenario ─────────────────────────────────────────────────────────────


def test_run_scenario_writes_report(tmp_path: Path, registered: DummyScenario) -> None:
    progress_calls: list[tuple[int, int | None, str]] = []

    class P(Progress):
        def __call__(self, progress: int, total: int | None, message: str) -> None:
            progress_calls.append((progress, total, message))

    logs: list[str] = []
    workdir = tmp_path / "run1"
    report = run_scenario("dummy", DummyParams(rounds=2), device=make_device(), workdir=workdir,
                          progress=P(), log=logs.append)
    assert report.passed is True
    assert report.exit_code == 0
    assert progress_calls == [(1, 2, "round 1"), (2, 2, "round 2")]
    doc = json.loads((workdir / "report.json").read_text(encoding="utf-8"))
    assert doc["scenario"] == "dummy"
    assert doc["passed"] is True
    assert doc["exit_code"] == 0
    assert doc["params"] == {"rounds": 2, "dwell": 1.5, "label": None, "kits": None,
                             "apps": None, "no_play": False, "verbose": True}
    assert doc["data"] == {"rounds": 2}
    roles = {a["role"] for a in doc["artifacts"]}
    assert roles == {"log", "report"}
    assert report.artifacts[-1].path == str(workdir / "report.json")
    assert doc["seconds"] >= 0


def test_run_scenario_default_workdir(tmp_path: Path, registered: DummyScenario,
                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    report = run_scenario("dummy", DummyParams(rounds=1), device=make_device(), log=lambda s: None)
    report_path = Path(report.artifacts[-1].path)
    assert report_path.parent.parent == tmp_path / "hil_logs"
    assert report_path.parent.name.startswith("dummy_")
    assert len(report_path.parent.name) == len("dummy_") + len("20260826_120000")


def test_run_scenario_failed_report_exit_1(tmp_path: Path, registered: DummyScenario) -> None:
    report = run_scenario("failing", DummyParams(), device=make_device(), workdir=tmp_path,
                          log=lambda s: None)
    assert report.passed is False
    assert report.exit_code == 1


def test_run_scenario_env_error_exit_2(tmp_path: Path, registered: DummyScenario) -> None:
    report = run_scenario("raising", DummyParams(label=ENV), device=make_device(),
                          workdir=tmp_path, log=lambda s: None)
    assert report.passed is False
    assert report.exit_code == 2
    assert report.data["error"]["code"] == ENV
    assert report.data["error"]["hint"] == "fix the bench"
    doc = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert doc["exit_code"] == 2


def test_run_scenario_no_device_is_env(tmp_path: Path, registered: DummyScenario) -> None:
    report = run_scenario("raising", DummyParams(label=NO_DEVICE), device=make_device(),
                          workdir=tmp_path, log=lambda s: None)
    assert report.exit_code == 2


def test_run_scenario_other_hil_error_exit_1(tmp_path: Path, registered: DummyScenario) -> None:
    report = run_scenario("raising", DummyParams(label="TIMEOUT"), device=make_device(),
                          workdir=tmp_path, log=lambda s: None)
    assert report.exit_code == 1
    assert report.data["error"]["code"] == "TIMEOUT"


def test_run_scenario_cancelled(tmp_path: Path, registered: DummyScenario) -> None:
    ev = threading.Event()
    ev.set()
    report = run_scenario("dummy", DummyParams(rounds=5), device=make_device(), workdir=tmp_path,
                          cancelled=ev, log=lambda s: None)
    assert report.passed is False
    assert report.exit_code == 1
    assert report.data["cancelled"] is True
    assert report.data["error"]["code"] == CANCELLED
    assert report.summary.startswith("cancelled")


def test_run_scenario_crash_still_writes_report(tmp_path: Path,
                                                registered: DummyScenario) -> None:
    report = run_scenario("crashing", DummyParams(), device=make_device(), workdir=tmp_path,
                          log=lambda s: None)
    assert report.exit_code == 1
    assert report.data["error"]["code"] == "INTERNAL"
    assert "ValueError" in report.data["error"]["message"]
    assert (tmp_path / "report.json").exists()


def test_run_scenario_unknown_name() -> None:
    with pytest.raises(HilError) as ei:
        run_scenario("nope", DummyParams(), device=make_device())
    assert ei.value.code == "BAD_ARGS"


def test_run_scenario_discovers_when_no_device(tmp_path: Path, registered: DummyScenario,
                                               monkeypatch: pytest.MonkeyPatch) -> None:
    dev = make_device()
    monkeypatch.setattr(base, "discover", lambda backends=None: [dev])
    report = run_scenario("dummy", DummyParams(rounds=1), workdir=tmp_path, log=lambda s: None)
    assert report.passed is True
    doc = json.loads((tmp_path / "report.json").read_text(encoding="utf-8"))
    assert doc["device"] == "dev_test"


def test_report_to_dict() -> None:
    r = Report(passed=True, summary="ok", data={"a": 1},
               artifacts=[Artifact(path="x.wav", mime="audio/wav", role="capture")], exit_code=0)
    assert r.to_dict() == {"passed": True, "summary": "ok", "data": {"a": 1},
                           "artifacts": [{"path": "x.wav", "mime": "audio/wav", "role": "capture"}],
                           "exit_code": 0}


def test_package_exports_and_load_builtin() -> None:
    import crosspad_hil.scenarios as pkg

    assert pkg.register is register and pkg.get is get and pkg.names is names
    assert pkg.BUILTIN_MODULES == ("smoke", "app_churn", "kit_churn", "led_state", "usb_mode_cycle")
    loaded = pkg.load_builtin()
    assert set(loaded) <= set(pkg.BUILTIN_MODULES)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenarios_base.py -q 2>&1 | tail -5`
Expected: `ImportError` / `ModuleNotFoundError: No module named 'crosspad_hil.scenarios'` (collection error, 0 tests run).

- [ ] **Step 3: Write minimal implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/base.py`:

```python
"""Scenario framework: the protocol every `crosspad-hil run <name>` implements.

A scenario is a module-level object with `name`, `Params` (a dataclass), `description`
and `run(ctx, params, progress) -> Report`. The CLI derives argparse flags from `Params`
(`params_to_argparse`), the daemon derives the JSON schema (`params_schema`), and both
call `run_scenario()`, which owns the work directory, `report.json` and the exit code.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import threading
import time
import traceback
import types
import typing
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Protocol, runtime_checkable

from crosspad_hil.cdc import CdcLink
from crosspad_hil.console import Console
from crosspad_hil.devices import Device, UsbMode, discover, select
from crosspad_hil.errors import (
    AMBIGUOUS_DEVICE,
    BAD_ARGS,
    CANCELLED,
    ENV,
    NO_CDC_IN_AUDIO_MODE,
    NO_DEVICE,
    PORT_BUSY,
    HilError,
)
from crosspad_hil.serial_open import open_serial

# HilError codes that mean "the bench is wrong", not "the firmware failed": exit 2.
ENV_EXIT_CODES: frozenset[str] = frozenset(
    {ENV, NO_DEVICE, AMBIGUOUS_DEVICE, PORT_BUSY, NO_CDC_IN_AUDIO_MODE}
)


@dataclass
class Artifact:
    path: str
    mime: str
    role: str


@dataclass
class Report:
    passed: bool
    summary: str
    data: dict
    artifacts: list[Artifact]
    exit_code: int  # 0 pass, 1 fail, 2 env

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "summary": self.summary,
            "data": self.data,
            "artifacts": [dataclasses.asdict(a) for a in self.artifacts],
            "exit_code": self.exit_code,
        }


class Progress:
    """Progress sink. Default: no-op. The CLI prints; the daemon emits task.progress."""

    def __call__(self, progress: int, total: int | None, message: str) -> None:
        return None


@dataclass
class Context:
    device: Device
    workdir: Path
    cancelled: threading.Event
    log: Callable[[str], None]
    serial_factory: Callable[..., Any] = open_serial

    def open_console(self, reset: bool = False) -> Console:
        port = self.device.ports.console
        if port is None:
            raise HilError(
                NO_DEVICE,
                f"{self.device.id} has no STM VCP console port",
                hint="the STM32 bridge (0x0483:0x5740) carries the ESP console; is it enumerated?",
                device=self.device.id,
            )
        self.workdir.mkdir(parents=True, exist_ok=True)
        con = Console(
            port.path,
            log_path=self.workdir / "console.log",
            serial_factory=self.serial_factory,
        )
        con.open(reset=reset)
        return con

    def open_cdc(self) -> CdcLink:
        port = self.device.ports.cdc
        if port is None:
            if self.device.usb_mode == UsbMode.AUDIO:
                raise HilError(
                    NO_CDC_IN_AUDIO_MODE,
                    f"{self.device.id} is in MIDI+UAC2 profile; CDC endpoint absent",
                    hint="usb-mode set default (SysEx 0x1B on the ESP MIDI port) then retry",
                    device=self.device.id,
                )
            raise HilError(
                NO_DEVICE,
                f"{self.device.id} has no ESP CDC port",
                hint="expected VID 0x303A PID 0x3456; is the device in bootloader/DFU?",
                device=self.device.id,
            )
        link = CdcLink(port.path, serial_factory=self.serial_factory)
        link.open()
        return link

    def check_cancelled(self) -> None:
        if self.cancelled.is_set():
            raise HilError(CANCELLED, "scenario cancelled", hint="task.cancel was requested")


@runtime_checkable
class Scenario(Protocol):
    name: str
    Params: type
    description: str

    def run(self, ctx: Context, params: Any, progress: Progress) -> Report: ...


# The one explicit registry the package allows. Populated by `register()` calls at
# import time of each scenario module (see scenarios/__init__.py load_builtin()).
_REGISTRY: dict[str, Scenario] = {}


def register(s: Scenario) -> Scenario:
    _REGISTRY[s.name] = s
    return s


def get(name: str) -> Scenario:
    try:
        return _REGISTRY[name]
    except KeyError:
        raise HilError(
            BAD_ARGS,
            f"unknown scenario {name!r}",
            hint="known scenarios: " + ", ".join(names()),
            scenario=name,
        ) from None


def names() -> list[str]:
    return sorted(_REGISTRY)


# ── dataclass ↔ argparse ─────────────────────────────────────────────────────


def _unwrap_optional(tp: Any) -> tuple[Any, bool]:
    """`X | None` / `Optional[X]` → (X, True); anything else → (tp, False)."""
    origin = typing.get_origin(tp)
    if origin is typing.Union or origin is types.UnionType:
        args = [a for a in typing.get_args(tp) if a is not type(None)]
        if len(args) == 1 and len(typing.get_args(tp)) == 2:
            return args[0], True
    return tp, False


def _type_name(tp: Any) -> str:
    inner, optional = _unwrap_optional(tp)
    origin = typing.get_origin(inner)
    if origin is list:
        (item,) = typing.get_args(inner)
        base = f"list[{item.__name__}]"
    else:
        base = getattr(inner, "__name__", str(inner))
    return f"{base} | None" if optional else base


def _list_parser(item: type) -> Callable[[str], list]:
    def parse(text: str) -> list:
        text = text.strip()
        if not text:
            return []
        return [item(part.strip()) for part in text.split(",")]

    parse.__name__ = f"list[{item.__name__}]"
    return parse


def _field_default(f: dataclasses.Field) -> Any:
    if f.default is not dataclasses.MISSING:
        return f.default
    if f.default_factory is not dataclasses.MISSING:  # type: ignore[misc]
        return f.default_factory()  # type: ignore[misc]
    return None


def params_to_argparse(params_cls: type, parser: argparse.ArgumentParser) -> None:
    """Add one option per dataclass field.

    Rules: `bool` → `--x` / `--no-x`; `int|float|str` → typed option; `X | None` → same
    with default None; `list[int]` / `list[str]` → comma-separated; help from
    `metadata["help"]`, default appended.
    """
    if not dataclasses.is_dataclass(params_cls):
        raise TypeError(f"{params_cls!r} is not a dataclass")
    hints = typing.get_type_hints(params_cls)
    for f in dataclasses.fields(params_cls):
        tp = hints[f.name]
        inner, _optional = _unwrap_optional(tp)
        flag = "--" + f.name.replace("_", "-")
        default = _field_default(f)
        help_text = str(f.metadata.get("help", ""))
        suffix = f"(default: {default})" if default is not None else "(default: none)"
        full_help = f"{help_text} {suffix}".strip()
        if inner is bool:
            group = parser.add_mutually_exclusive_group()
            group.add_argument(flag, dest=f.name, action="store_true", default=default,
                               help=full_help)
            group.add_argument("--no-" + f.name.replace("_", "-"), dest=f.name,
                               action="store_false", help=f"negate {flag}")
            continue
        origin = typing.get_origin(inner)
        if origin is list:
            (item,) = typing.get_args(inner)
            if item not in (int, str, float):
                raise TypeError(f"field {f.name}: unsupported list item type {item!r}")
            parser.add_argument(flag, dest=f.name, type=_list_parser(item), default=default,
                                metavar="A,B,...", help=full_help)
            continue
        if inner in (int, float, str):
            parser.add_argument(flag, dest=f.name, type=inner, default=default,
                                metavar=inner.__name__.upper(), help=full_help)
            continue
        raise TypeError(f"field {f.name}: unsupported annotation {tp!r}")


def argparse_to_params(params_cls: type, ns: argparse.Namespace) -> Any:
    kwargs = {f.name: getattr(ns, f.name) for f in dataclasses.fields(params_cls)}
    return params_cls(**kwargs)


def params_schema(params_cls: type) -> list[dict]:
    """[{name, type, default, help}] — what the daemon's scenario.list reports."""
    hints = typing.get_type_hints(params_cls)
    return [
        {
            "name": f.name,
            "type": _type_name(hints[f.name]),
            "default": _field_default(f),
            "help": str(f.metadata.get("help", "")),
        }
        for f in dataclasses.fields(params_cls)
    ]


# ── runner ───────────────────────────────────────────────────────────────────


def _params_dict(params: Any) -> dict:
    if dataclasses.is_dataclass(params) and not isinstance(params, type):
        return dataclasses.asdict(params)
    if isinstance(params, dict):
        return dict(params)
    return {}


def run_scenario(
    name: str,
    params: Any,
    *,
    device: Device | None = None,
    workdir: Path | None = None,
    progress: Progress | None = None,
    cancelled: threading.Event | None = None,
    log: Callable[[str], None] = print,
) -> Report:
    """Run one registered scenario, write `<workdir>/report.json`, return its Report.

    Exit codes: 0 pass, 1 fail (including CANCELLED and any non-environment error),
    2 for HilError codes in ENV_EXIT_CODES. A crash inside the scenario is reported,
    never propagated — report.json must exist for every run that started.
    """
    scenario = get(name)
    if device is None:
        device = select(discover(), None)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    if workdir is None:
        workdir = Path("hil_logs") / f"{name}_{stamp}"
    workdir.mkdir(parents=True, exist_ok=True)
    ctx = Context(
        device=device,
        workdir=workdir,
        cancelled=cancelled if cancelled is not None else threading.Event(),
        log=log,
    )
    sink = progress if progress is not None else Progress()
    started = time.time()
    log(f"[{name}] device={device.id} workdir={workdir}")
    try:
        report = scenario.run(ctx, params, sink)
        if not report.passed and report.exit_code == 0:
            report.exit_code = 1
    except HilError as e:
        if e.code == CANCELLED:
            report = Report(passed=False, summary=f"cancelled: {e.message}",
                            data={"cancelled": True, "error": e.to_dict()},
                            artifacts=[], exit_code=1)
        elif e.code in ENV_EXIT_CODES:
            report = Report(passed=False, summary=f"environment: {e.code}: {e.message}",
                            data={"error": e.to_dict()}, artifacts=[], exit_code=2)
        else:
            report = Report(passed=False, summary=f"{e.code}: {e.message}",
                            data={"error": e.to_dict()}, artifacts=[], exit_code=1)
        log(f"[{name}] {report.summary}")
    except Exception as exc:  # noqa: BLE001 — a scenario crash must still produce a report
        report = Report(
            passed=False,
            summary=f"crashed: {exc!r}",
            data={"error": {"code": "INTERNAL", "message": repr(exc),
                            "hint": None, "details": {},
                            "traceback": traceback.format_exc()}},
            artifacts=[],
            exit_code=1,
        )
        log(f"[{name}] {report.summary}")
    finished = time.time()

    report_path = workdir / "report.json"
    report_artifact = Artifact(path=str(report_path), mime="application/json", role="report")
    if not any(a.role == "report" for a in report.artifacts):
        report.artifacts.append(report_artifact)
    doc = {
        "scenario": name,
        "device": device.id,
        "passed": report.passed,
        "summary": report.summary,
        "exit_code": report.exit_code,
        "data": report.data,
        "artifacts": [dataclasses.asdict(a) for a in report.artifacts],
        "params": _params_dict(params),
        "workdir": str(workdir),
        "started": started,
        "finished": finished,
        "seconds": round(finished - started, 3),
    }
    report_path.write_text(json.dumps(doc, indent=2, default=str) + "\n", encoding="utf-8")
    log(f"[{name}] {'PASS' if report.passed else 'FAIL'} exit={report.exit_code} "
        f"report={report_path}")
    return report
```

`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/__init__.py`:

```python
"""Scenario registry. Import a builtin module to register it; see `load_builtin()`."""
from __future__ import annotations

import importlib

from crosspad_hil.scenarios.base import (
    Artifact,
    Context,
    Progress,
    Report,
    Scenario,
    argparse_to_params,
    get,
    names,
    params_schema,
    params_to_argparse,
    register,
    run_scenario,
)

# P0 scenarios. Each module calls register() at import time.
BUILTIN_MODULES: tuple[str, ...] = ("smoke", "app_churn", "kit_churn", "led_state", "usb_mode_cycle")


def load_builtin() -> list[str]:
    """Import every builtin scenario module so `names()` is complete.

    Returns the scenario module names that imported. A builtin whose module file does
    not exist yet is skipped — only that exact module, never an ImportError from inside
    a module that does exist (those are real bugs and propagate).
    """
    loaded: list[str] = []
    for mod in BUILTIN_MODULES:
        qualified = f"{__name__}.{mod}"
        try:
            importlib.import_module(qualified)
        except ModuleNotFoundError as e:
            if e.name != qualified:
                raise
            continue
        loaded.append(mod)
    return loaded


__all__ = [
    "Artifact", "Context", "Progress", "Report", "Scenario",
    "argparse_to_params", "get", "names", "params_schema", "params_to_argparse",
    "register", "run_scenario", "BUILTIN_MODULES", "load_builtin",
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenarios_base.py -q 2>&1 | tail -5`
Expected: `25 passed` (the two `Context` tests that go through `CdcLink`/`Console` depend on Plan A
Tasks for `cdc.py`/`console.py` being merged; until then they fail with `ImportError`, which is a
merge-order issue, not a defect in this task).

Then: `cd /home/matixan/GIT/crosspad-hil && ruff check crosspad_hil/scenarios tests/test_scenarios_base.py`
Expected: `All checks passed!`

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/scenarios/__init__.py crosspad_hil/scenarios/base.py tests/test_scenarios_base.py
git commit -m "feat(scenarios): protocol, registry, argparse bridge and run_scenario with report.json"
```

---

### Task 2: Transcript record and replay (`record.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/record.py`
- Create: `/home/matixan/GIT/crosspad-hil/tests/fixtures/transcripts/README.md`
- Create: `/home/matixan/GIT/crosspad-hil/tests/fixtures/transcripts/kit_status_app_list.ndjson`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_record.py`

**Interfaces:**
- Consumes: `tests.fakes.FakeSerial` (contract), `crosspad_hil.serial_open.open_serial`.
- Produces (contract names verbatim, plus what the contract left unsaid):
  - `class RecordingSerial: __init__(self, inner, path: Path)` — wraps any serial-like object;
    proxies `write`, `read`, `readline`, `close`, `reset_input_buffer`, `flush`, `open`, and every
    other attribute via `__getattr__`; `dtr`/`rts` are properties that forward to `inner` and log.
  - `class ReplaySerial: __init__(self, path: Path, *, speed: float = 0.0, lenient: bool = False)`
    with `write(data) -> int`, `read(n=1) -> bytes`, `readline() -> bytes`, `close()`, `open()`,
    `reset_input_buffer()`, attributes `port`, `baudrate`, `timeout`, `is_open`, `in_waiting`,
    `written: list[bytes]`, `control_history: list[tuple[str, bool]]`, `dtr`, `rts`; helpers
    `remaining() -> int` (unconsumed transcript entries) and `assert_exhausted()`.
  - `class ReplayMismatch(AssertionError)` — raised by `write()` when the bytes differ from the
    next recorded `tx` (message shows expected vs got, entry index).
  - `def recording_factory(path: Path, base: Callable[..., Any] = open_serial) -> Callable[..., RecordingSerial]`
    — a `serial_factory` drop-in: `recording_factory(out)(port, **kw)` returns
    `RecordingSerial(base(port, **kw), out)`. `crosspad-hil record` (chunk B-CLI) and tests use it.
  - `def replay_factory(path: Path, **kw) -> Callable[..., ReplaySerial]` — the same for replay.
- Transcript format (one JSON object per line, `TRANSCRIPT_VERSION = 1`):
  - first line `{"t": 0.0, "dir": "meta", "version": 1, "port": str|None, "baudrate": int|None}`
  - `{"t": <seconds since first entry, float>, "dir": "tx", "data": "<hex>"}` for each `write()`
  - `{"t": …, "dir": "rx", "data": "<hex>"}` for each non-empty `read()`/`readline()` result
    (empty reads — timeouts — are not recorded)
  - `{"t": …, "dir": "ctl", "attr": "dtr"|"rts", "value": bool}` for each control-line set
  - Replay ignores `meta` and `ctl`; the replay client's own `dtr`/`rts` sets go to
    `control_history` so hygiene tests can assert on them.
- Replay semantics (chosen): a cursor walks the entries. `write(data)` collects any `rx` entries
  between the cursor and the next `tx` into a pending buffer (a real device may reply before the
  host reads — nothing is lost), then compares `data` to that `tx`; mismatch raises
  `ReplayMismatch` unless `lenient=True` (then the write is accepted and the cursor still moves
  past the `tx`). `read()`/`readline()` serve bytes from the pending buffer, pulling further `rx`
  entries only up to the next `tx` (a reply cannot precede the command that caused it); when no
  `rx` is available they sleep `min(timeout, 0.01)` and return `b""`, exactly what pyserial does
  on timeout. Before pulling an `rx` entry the replay sleeps `(t_entry − t_previous) * speed`;
  `speed=0.0` replays instantly, `1.0` in real time.

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_record.py`:

```python
"""RecordingSerial writes an ndjson transcript; ReplaySerial plays it back identically."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from crosspad_hil.record import (
    TRANSCRIPT_VERSION,
    RecordingSerial,
    ReplayMismatch,
    ReplaySerial,
    recording_factory,
    replay_factory,
)
from tests.fakes import FakeSerial

# Reply lines exactly as hil_control.cpp formats them (handle_kit_status / handle_app_list).
SCRIPT = [
    ("KIT_STATUS", "KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS"),
    ("APP_LIST", "APPS: Sampler,Sequencer,Settings running=-"),
    ("PAD_PRESS 0 100", "OK"),
]


def drive(ser: object) -> list[bytes]:
    """The session every test records and replays: hygiene, three commands, one timeout."""
    ser.dtr = False  # type: ignore[attr-defined]
    ser.rts = False  # type: ignore[attr-defined]
    got: list[bytes] = []
    ser.write(b"KIT_STATUS\n")  # type: ignore[attr-defined]
    got.append(ser.readline())  # type: ignore[attr-defined]
    ser.write(b"APP_LIST\n")  # type: ignore[attr-defined]
    got.append(ser.readline())  # type: ignore[attr-defined]
    got.append(ser.readline())  # type: ignore[attr-defined]  # nothing pending → b""
    ser.write(b"PAD_PRESS 0 100\n")  # type: ignore[attr-defined]
    got.append(ser.read(64))  # type: ignore[attr-defined]
    ser.close()  # type: ignore[attr-defined]
    return got


@pytest.fixture
def transcript(tmp_path: Path) -> tuple[Path, list[bytes]]:
    fake = FakeSerial(script=SCRIPT)
    fake.timeout = 0.05
    path = tmp_path / "session.ndjson"
    rec = RecordingSerial(fake, path)
    got = drive(rec)
    assert fake.control_history[:2] == [("dtr", False), ("rts", False)]
    assert fake.written[:3] == ["KIT_STATUS", "APP_LIST", "PAD_PRESS 0 100"]
    return path, got


def test_recording_format(transcript: tuple[Path, list[bytes]]) -> None:
    path, got = transcript
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert lines[0]["dir"] == "meta" and lines[0]["version"] == TRANSCRIPT_VERSION
    dirs = [entry["dir"] for entry in lines[1:]]
    # ctl, ctl, tx, rx, tx, rx, tx, rx — the empty readline() is not recorded
    assert dirs == ["ctl", "ctl", "tx", "rx", "tx", "rx", "tx", "rx"]
    assert lines[1] == {"t": lines[1]["t"], "dir": "ctl", "attr": "dtr", "value": False}
    assert bytes.fromhex(lines[3]["data"]) == b"KIT_STATUS\n"
    assert bytes.fromhex(lines[4]["data"]) == b"KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS\r\n"
    ts = [entry["t"] for entry in lines]
    assert ts == sorted(ts) and ts[0] == 0.0
    assert got[0] == b"KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS\r\n"
    assert got[2] == b""
    assert got[3] == b"OK\r\n"


def test_replay_identical(transcript: tuple[Path, list[bytes]]) -> None:
    path, recorded = transcript
    rep = ReplaySerial(path)
    replayed = drive(rep)
    assert replayed == recorded
    assert rep.control_history == [("dtr", False), ("rts", False)]
    assert rep.written == [b"KIT_STATUS\n", b"APP_LIST\n", b"PAD_PRESS 0 100\n"]
    assert rep.remaining() == 0
    rep.assert_exhausted()


def test_replay_is_instant_at_speed_zero(transcript: tuple[Path, list[bytes]]) -> None:
    path, _ = transcript
    rep = ReplaySerial(path, speed=0.0)
    rep.timeout = 0.01
    t0 = time.monotonic()
    drive(rep)
    assert time.monotonic() - t0 < 0.5


def test_replay_scales_delays(tmp_path: Path) -> None:
    path = tmp_path / "slow.ndjson"
    entries = [
        {"t": 0.0, "dir": "meta", "version": TRANSCRIPT_VERSION, "port": None, "baudrate": None},
        {"t": 0.0, "dir": "tx", "data": b"KIT_STATUS\n".hex()},
        {"t": 0.20, "dir": "rx", "data": b"KITSTATUS: current=1 loading=0 pending=-1 name=A\r\n".hex()},
    ]
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")
    rep = ReplaySerial(path, speed=0.5)
    rep.write(b"KIT_STATUS\n")
    t0 = time.monotonic()
    line = rep.readline()
    elapsed = time.monotonic() - t0
    assert line.startswith(b"KITSTATUS:")
    assert 0.08 <= elapsed < 0.5


def test_replay_mismatch_raises(transcript: tuple[Path, list[bytes]]) -> None:
    path, _ = transcript
    rep = ReplaySerial(path)
    with pytest.raises(ReplayMismatch) as ei:
        rep.write(b"APP_LIST\n")
    assert "KIT_STATUS" in str(ei.value)
    assert "APP_LIST" in str(ei.value)


def test_replay_lenient_accepts_mismatch(transcript: tuple[Path, list[bytes]]) -> None:
    path, _ = transcript
    rep = ReplaySerial(path, lenient=True)
    rep.write(b"APP_LIST\n")  # accepted, cursor moves past the recorded KIT_STATUS tx
    assert rep.readline() == b"KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS\r\n"


def test_replay_readline_splits_multi_line_chunk(tmp_path: Path) -> None:
    path = tmp_path / "chunk.ndjson"
    chunk = b"ENCGROUP: count=2\r\n  [0] 0x3fc9a000 Sampler\r\n  [1] 0x3fc9a100 Settings\r\n"
    entries = [
        {"t": 0.0, "dir": "meta", "version": TRANSCRIPT_VERSION, "port": None, "baudrate": None},
        {"t": 0.0, "dir": "tx", "data": b"ENC_GROUP\n".hex()},
        {"t": 0.01, "dir": "rx", "data": chunk.hex()},
    ]
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n", encoding="utf-8")
    rep = ReplaySerial(path)
    rep.write(b"ENC_GROUP\n")
    assert rep.readline() == b"ENCGROUP: count=2\r\n"
    assert rep.readline() == b"  [0] 0x3fc9a000 Sampler\r\n"
    assert rep.read(4) == b"  [1"
    assert rep.readline() == b"] 0x3fc9a100 Settings\r\n"
    assert rep.readline() == b""


def test_replay_does_not_serve_reply_before_its_command(transcript: tuple[Path, list[bytes]]) -> None:
    path, _ = transcript
    rep = ReplaySerial(path)
    rep.timeout = 0.01
    assert rep.readline() == b""  # cursor sits on the first tx: nothing to read yet
    rep.write(b"KIT_STATUS\n")
    assert rep.readline().startswith(b"KITSTATUS:")
    assert rep.readline() == b""  # the APPS reply waits for APP_LIST


def test_replay_exhausted_reports_leftover(transcript: tuple[Path, list[bytes]]) -> None:
    path, _ = transcript
    rep = ReplaySerial(path)
    rep.write(b"KIT_STATUS\n")
    assert rep.remaining() > 0
    with pytest.raises(AssertionError):
        rep.assert_exhausted()


def test_factories(tmp_path: Path) -> None:
    out = tmp_path / "f.ndjson"
    fake = FakeSerial(script=SCRIPT)
    made: list[str] = []

    def base(path: str, **kw: object) -> FakeSerial:
        made.append(path)
        return fake

    rec = recording_factory(out, base=base)("/dev/ttyACM9", baud=115200)
    assert isinstance(rec, RecordingSerial)
    assert made == ["/dev/ttyACM9"]
    rec.write(b"KIT_STATUS\n")
    assert rec.readline().startswith(b"KITSTATUS:")
    rec.close()
    rep = replay_factory(out)("/dev/ttyACM9", baud=115200)
    assert isinstance(rep, ReplaySerial)
    rep.write(b"KIT_STATUS\n")
    assert rep.readline().startswith(b"KITSTATUS:")


def test_checked_in_fixture_replays() -> None:
    fixture = Path(__file__).parent / "fixtures" / "transcripts" / "kit_status_app_list.ndjson"
    rep = ReplaySerial(fixture)
    rep.dtr = False
    rep.rts = False
    rep.write(b"KIT_STATUS\n")
    assert rep.readline() == b"KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS\r\n"
    rep.write(b"APP_LIST\n")
    assert rep.readline() == b"APPS: Sampler,Sequencer,Settings running=-\r\n"
    rep.assert_exhausted()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_record.py -q 2>&1 | tail -3`
Expected: `ModuleNotFoundError: No module named 'crosspad_hil.record'`

- [ ] **Step 3: Write minimal implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/record.py`:

```python
"""Serial transcripts: record a real session to ndjson, replay it without hardware.

Format (one JSON object per line):
    {"t": 0.0,  "dir": "meta", "version": 1, "port": "/dev/ttyACM0", "baudrate": 115200}
    {"t": 0.01, "dir": "ctl", "attr": "dtr", "value": false}
    {"t": 0.02, "dir": "tx",  "data": "4b49545f5354415455530a"}          # KIT_STATUS\n
    {"t": 0.03, "dir": "rx",  "data": "4b4954535441545553..."}           # KITSTATUS: …\r\n
`t` is seconds since the recorder was created. Empty reads (timeouts) are not recorded.

`crosspad-hil record --out FILE` wraps the device port in RecordingSerial; tests then
build a CdcLink/Console with `serial_factory=replay_factory(FILE)`.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable

from crosspad_hil.serial_open import open_serial

TRANSCRIPT_VERSION = 1


class ReplayMismatch(AssertionError):
    """The client wrote something other than what the transcript recorded next."""


class RecordingSerial:
    """Wrap a serial-like object and log every write/read/control change to ndjson."""

    def __init__(self, inner: Any, path: Path) -> None:
        self._inner = inner
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self._path.open("a", encoding="utf-8", buffering=1)
        self._t0 = time.monotonic()
        self._emit({
            "dir": "meta",
            "version": TRANSCRIPT_VERSION,
            "port": getattr(inner, "port", None),
            "baudrate": getattr(inner, "baudrate", None),
        })

    def _emit(self, entry: dict[str, Any]) -> None:
        row = {"t": round(time.monotonic() - self._t0, 6)}
        row.update(entry)
        self._file.write(json.dumps(row) + "\n")

    # ── data ──
    def write(self, data: bytes) -> int:
        self._emit({"dir": "tx", "data": bytes(data).hex()})
        return self._inner.write(data)

    def read(self, size: int = 1) -> bytes:
        data = self._inner.read(size)
        if data:
            self._emit({"dir": "rx", "data": bytes(data).hex()})
        return data

    def readline(self) -> bytes:
        data = self._inner.readline()
        if data:
            self._emit({"dir": "rx", "data": bytes(data).hex()})
        return data

    # ── control lines ──
    @property
    def dtr(self) -> bool:
        return bool(getattr(self._inner, "dtr", False))

    @dtr.setter
    def dtr(self, value: bool) -> None:
        self._emit({"dir": "ctl", "attr": "dtr", "value": bool(value)})
        self._inner.dtr = value

    @property
    def rts(self) -> bool:
        return bool(getattr(self._inner, "rts", False))

    @rts.setter
    def rts(self, value: bool) -> None:
        self._emit({"dir": "ctl", "attr": "rts", "value": bool(value)})
        self._inner.rts = value

    # ── lifecycle ──
    def close(self) -> None:
        try:
            self._inner.close()
        finally:
            if not self._file.closed:
                self._file.close()

    def __getattr__(self, name: str) -> Any:
        # Everything else (timeout, port, baudrate, is_open, in_waiting, reset_input_buffer,
        # flush, open, …) is the wrapped object's.
        return getattr(self._inner, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("_") or name in ("dtr", "rts"):
            object.__setattr__(self, name, value)
        else:
            setattr(self._inner, name, value)


class ReplaySerial:
    """A serial-like object driven by a transcript written by RecordingSerial."""

    def __init__(self, path: Path, *, speed: float = 0.0, lenient: bool = False) -> None:
        self._path = Path(path)
        self.speed = speed
        self.lenient = lenient
        self._entries: list[dict[str, Any]] = []
        self.port: str | None = None
        self.baudrate: int | None = None
        for line in self._path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            if entry.get("dir") == "meta":
                self.port = entry.get("port")
                self.baudrate = entry.get("baudrate")
                continue
            if entry.get("dir") in ("tx", "rx", "ctl"):
                self._entries.append(entry)
        self._cursor = 0
        self._pending = bytearray()
        self._last_t: float | None = None
        self.timeout: float = 0.2
        self.is_open = True
        self.written: list[bytes] = []
        self.control_history: list[tuple[str, bool]] = []
        self._dtr = False
        self._rts = False

    # ── transcript walking ──
    def _next_data_index(self) -> int | None:
        """Index of the next tx/rx entry at or after the cursor (ctl entries are skipped)."""
        i = self._cursor
        while i < len(self._entries):
            if self._entries[i]["dir"] in ("tx", "rx"):
                return i
            i += 1
        return None

    def _sleep_for(self, entry: dict[str, Any]) -> None:
        t = float(entry.get("t", 0.0))
        if self._last_t is not None and self.speed > 0.0:
            delay = (t - self._last_t) * self.speed
            if delay > 0:
                time.sleep(delay)
        self._last_t = t

    def _pull_rx(self) -> bool:
        """Move one rx entry into the pending buffer. False if the next data entry is a tx/end."""
        i = self._next_data_index()
        if i is None or self._entries[i]["dir"] != "rx":
            return False
        entry = self._entries[i]
        self._sleep_for(entry)
        self._pending += bytes.fromhex(entry["data"])
        self._cursor = i + 1
        return True

    # ── data ──
    def write(self, data: bytes) -> int:
        data = bytes(data)
        self.written.append(data)
        # A device may have replied before the host got round to reading: keep those rx
        # entries rather than skipping them.
        while True:
            i = self._next_data_index()
            if i is None:
                expected: bytes | None = None
                break
            if self._entries[i]["dir"] == "rx":
                self._pending += bytes.fromhex(self._entries[i]["data"])
                self._cursor = i + 1
                continue
            expected = bytes.fromhex(self._entries[i]["data"])
            self._last_t = float(self._entries[i].get("t", 0.0))
            self._cursor = i + 1
            break
        if expected != data and not self.lenient:
            raise ReplayMismatch(
                f"transcript {self._path.name} entry {self._cursor - 1}: "
                f"expected tx {expected!r}, got {data!r}"
            )
        return len(data)

    def read(self, size: int = 1) -> bytes:
        if not self._pending and not self._pull_rx():
            time.sleep(min(self.timeout, 0.01))
            return b""
        out = bytes(self._pending[:size])
        del self._pending[:size]
        return out

    def readline(self) -> bytes:
        while b"\n" not in self._pending:
            if not self._pull_rx():
                break
        if not self._pending:
            time.sleep(min(self.timeout, 0.01))
            return b""
        nl = self._pending.find(b"\n")
        end = len(self._pending) if nl < 0 else nl + 1
        out = bytes(self._pending[:end])
        del self._pending[:end]
        return out

    @property
    def in_waiting(self) -> int:
        return len(self._pending)

    def reset_input_buffer(self) -> None:
        self._pending.clear()

    def flush(self) -> None:
        return None

    # ── control lines ──
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

    # ── lifecycle / assertions ──
    def open(self) -> None:
        self.is_open = True

    def close(self) -> None:
        self.is_open = False

    def remaining(self) -> int:
        """Unconsumed tx/rx entries (ctl entries never count)."""
        return sum(1 for e in self._entries[self._cursor:] if e["dir"] in ("tx", "rx"))

    def assert_exhausted(self) -> None:
        left = self.remaining()
        if left or self._pending:
            nxt = self._next_data_index()
            preview = self._entries[nxt] if nxt is not None else None
            raise AssertionError(
                f"transcript {self._path.name}: {left} entries and {len(self._pending)} pending "
                f"bytes not consumed; next={preview!r}"
            )


def recording_factory(path: Path, base: Callable[..., Any] = open_serial) -> Callable[..., RecordingSerial]:
    """A `serial_factory` that records: `recording_factory(out)(port, **kw)`."""

    def factory(port: str, **kw: Any) -> RecordingSerial:
        return RecordingSerial(base(port, **kw), path)

    return factory


def replay_factory(path: Path, **replay_kw: Any) -> Callable[..., ReplaySerial]:
    """A `serial_factory` that replays: `replay_factory(fixture, speed=0.0)(port, **kw)`."""

    def factory(port: str, **kw: Any) -> ReplaySerial:
        ser = ReplaySerial(path, **replay_kw)
        timeout = kw.get("timeout")
        if timeout is not None:
            ser.timeout = float(timeout)
        return ser

    return factory
```

`/home/matixan/GIT/crosspad-hil/tests/fixtures/transcripts/kit_status_app_list.ndjson`
(hand-written in the recorder's format; the `data` fields are the hex of exactly the bytes shown
in the trailing comments — verify with `python -c "print(bytes.fromhex('...'))"`):

```
{"t": 0.0, "dir": "meta", "version": 1, "port": "/dev/ttyACM0", "baudrate": 115200}
{"t": 0.000123, "dir": "ctl", "attr": "dtr", "value": false}
{"t": 0.000151, "dir": "ctl", "attr": "rts", "value": false}
{"t": 0.412, "dir": "tx", "data": "4b49545f5354415455530a"}
{"t": 0.418, "dir": "rx", "data": "4b49545354415455533a2063757272656e743d33206c6f6164696e673d302070656e64696e673d2d31206e616d653d4452554d530d0a"}
{"t": 0.901, "dir": "tx", "data": "4150505f4c4953540a"}
{"t": 0.906, "dir": "rx", "data": "415050533a2053616d706c65722c53657175656e6365722c53657474696e67732072756e6e696e673d2d0d0a"}
```

Decoded: tx `KIT_STATUS\n`; rx `KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS\r\n`;
tx `APP_LIST\n`; rx `APPS: Sampler,Sequencer,Settings running=-\r\n`. Generate the file rather
than typing hex by hand:

```bash
cd /home/matixan/GIT/crosspad-hil && python - <<'EOF'
import json
from pathlib import Path
rows = [
    {"t": 0.0, "dir": "meta", "version": 1, "port": "/dev/ttyACM0", "baudrate": 115200},
    {"t": 0.000123, "dir": "ctl", "attr": "dtr", "value": False},
    {"t": 0.000151, "dir": "ctl", "attr": "rts", "value": False},
    {"t": 0.412, "dir": "tx", "data": b"KIT_STATUS\n".hex()},
    {"t": 0.418, "dir": "rx", "data": b"KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS\r\n".hex()},
    {"t": 0.901, "dir": "tx", "data": b"APP_LIST\n".hex()},
    {"t": 0.906, "dir": "rx", "data": b"APPS: Sampler,Sequencer,Settings running=-\r\n".hex()},
]
p = Path("tests/fixtures/transcripts/kit_status_app_list.ndjson")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
print(p, p.stat().st_size, "bytes")
EOF
```

`/home/matixan/GIT/crosspad-hil/tests/fixtures/transcripts/README.md`:

```markdown
# Serial transcripts

Each `*.ndjson` file here is a recorded conversation with a real CrossPad, replayed in
tests through `crosspad_hil.record.ReplaySerial` so scenarios and typed verbs run in CI
without hardware. The reply lines are what `platform-idf/main/hil_control.cpp` actually
printed — never hand-edit a reply to make a test pass; re-record instead.

## Format

One JSON object per line, in order of occurrence:

| `dir`  | fields                        | meaning                                                     |
|--------|-------------------------------|-------------------------------------------------------------|
| `meta` | `version`, `port`, `baudrate` | first line; `version` is `record.TRANSCRIPT_VERSION` (1)   |
| `ctl`  | `attr` (`dtr`/`rts`), `value` | the host set a control line (hygiene: both should be false) |
| `tx`   | `data` (hex)                  | bytes the host wrote                                        |
| `rx`   | `data` (hex)                  | bytes the host read (one `read()`/`readline()` result)      |

`t` is seconds since the recorder was created. Empty reads (timeouts) are not recorded.
`ReplaySerial(path, speed=1.0)` reproduces the recorded gaps; `speed=0.0` (default in tests)
replays instantly.

## Producing one

```bash
crosspad-hil record --out tests/fixtures/transcripts/<name>.ndjson -- kit status
crosspad-hil record --out tests/fixtures/transcripts/<name>.ndjson -- run smoke
```

`record` wraps the device's serial port(s) in `RecordingSerial` (via
`record.recording_factory`) and runs the subcommand after `--` exactly as it would run
otherwise. Keep transcripts short and named after the verbs they contain
(`kit_status_app_list.ndjson`, `smoke_boot_ok.ndjson`, `usb_mode_cycle_1round.ndjson`).

Any test may also build one programmatically — `tests/test_record.py::transcript` records a
`FakeSerial` session, which is how the format itself is tested.

## Replaying in a test

```python
from crosspad_hil.cdc import CdcLink
from crosspad_hil.record import replay_factory

link = CdcLink("/dev/ttyACM0", serial_factory=replay_factory(FIXTURE))
link.open()
reply = link.transact("KIT_STATUS")
```

`write()` on a `ReplaySerial` must match the next recorded `tx` byte-for-byte or it raises
`ReplayMismatch` — a test that sends a different command than the transcript recorded is
testing against a device that never answered that command. Pass `lenient=True` only for
transcripts that deliberately exercise unknown-verb echo handling. Call
`ser.assert_exhausted()` at the end of a test when the whole transcript is expected to
have been consumed.

## Before checking in

- Strip anything that is not the exchange under test (long boot logs belong in
  `smoke_*.ndjson` only).
- Confirm the `ctl` lines never show `true`: a transcript where the host asserted DTR/RTS
  on the STM VCP recorded a reboot, not a session.
- Note the firmware commit in the file's `meta` line if the reply grammar changed
  (`{"dir": "meta", ..., "firmware": "<git sha>"}` — extra meta keys are ignored by the replayer).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_record.py -q 2>&1 | tail -3`
Expected: `11 passed`

Run: `cd /home/matixan/GIT/crosspad-hil && ruff check crosspad_hil/record.py tests/test_record.py`
Expected: `All checks passed!`

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil
git add crosspad_hil/record.py tests/test_record.py tests/fixtures/transcripts/README.md tests/fixtures/transcripts/kit_status_app_list.ndjson
git commit -m "feat(record): RecordingSerial/ReplaySerial ndjson transcripts with factories and fixture docs"
```
# Plan B — chunk B2: scenarios `smoke`, `led_state`, `app_churn`

Repo: `/home/matixan/GIT/crosspad-hil`. All names below are taken verbatim from
`contract.md`. Every task assumes Plan A (core library: `devices`, `console`, `cdc`,
`verbs`, `parsers`, `knowledge`, `ota`) and chunk B1 (`scenarios/base.py`,
`scenarios/__init__.py` registry, `tests/fakes.py::FakeSerial`) are merged.

Conventions shared by the three tasks (stated once here, repeated in the code):

- A scenario module exposes `Params` (dataclass), a `Scenario`-shaped class, and
  `SCENARIO = register(<Class>())` executed at import time. **No `main()` in scenario
  modules and no edit of `scenarios/__init__.py`**: B1's `load_builtin()` imports
  `crosspad_hil.scenarios.{smoke,app_churn,kit_churn,led_state,usb_mode_cycle}` on the
  first `get()`/`names()` call, and B4's platform-idf shims call
  `crosspad_hil.cli.main(["run", "<name>", *sys.argv[1:]])`.
- Tests inject `FakeSerial` through B1's `Context.serial_factory` field (a callable
  `factory(path: str, **kw) -> serial-like`). One factory dispatches on the port path:
  the device's `ports.console.path` gets the console fake, `ports.cdc.path` the CDC fake.
  `Console.open(reset=True)` calls the factory with `reset=False` and then performs the
  pulse itself through `Console.reset()` → `reset_pulse(ser)`, so the pulse is visible in
  the fake's `control_history` as `("rts", True)` followed by `("rts", False)`.
- Waits use `ctx.cancelled.wait(seconds)` instead of `time.sleep`, so a daemon
  `task.cancel` interrupts a dwell immediately and tests run with `dwell=0`.
- Scenarios close what they open in a `finally`; `run_scenario` then calls
  `ctx.close_all()`, which is safe because `Console.close()` / `CdcLink.close()` are
  idempotent (Plan A: `if not self._alive and self._ser is None: return`).
- Reply grammar in the fakes is copied from `platform-idf/main/hil_control.cpp`
  (`handle_app_list`, `handle_led_state`, `handle_mem`, the `APP_START` dispatch).

---

### Task 3: `scenarios/smoke.py` — boot smoke (port of `hil_smoke.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/smoke.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_scenario_smoke.py`

**Interfaces:**
- Consumes (contract):
  - `crosspad_hil.scenarios.base.Context` (`device`, `workdir`, `cancelled`, `log`, `serial_factory`, `open_console(reset: bool = False) -> Console`, `check_cancelled()`)
  - `crosspad_hil.scenarios.base.Report(passed, summary, data, artifacts, exit_code)`, `Artifact(path, mime, role)`, `Progress`
  - `crosspad_hil.scenarios.register(s) -> s`, `crosspad_hil.scenarios.get(name)`
  - `crosspad_hil.console.Console.wait_boot(timeout_s, settle_s) -> BootResult(complete, missing, fatal: list[{seq,pattern,line}], errors: list[{seq,line}], bootloops, seconds)`, `.read(since_seq, wait_ms, match, limit) -> ReadResult(lines: list[tuple[int, str]], next_seq, lines_lost)`, `.snapshot() -> {..., "port": str}`, `.close()`
  - `crosspad_hil.knowledge.load("markers") -> dict` with keys `boot_markers`, `required`, `optional`
  - `crosspad_hil.ota.flash(device, firmware: Path, *, transport="ota", wait_boot=True, console=None, progress=None) -> dict`
  - `crosspad_hil.errors.HilError` (`.message`, `.to_dict()`)
  - `tests/fakes.py::FakeSerial()` with `.feed(lines)`, `.rts` property, `.control_history`
- Produces:
  - `Params(flash: str | None = None, timeout: int = 25)`
  - `SETTLE_S: float = 3.0` (module constant, from `hil_smoke.capture_boot`: `settle_until = time.time() + 3`; tests monkeypatch it)
  - `POST_FLASH_S: float = 3.0` (from `hil_smoke.main`: `time.sleep(3)  # let the device reboot and re-enumerate`)
  - `evaluate(boot: BootResult, lines: list[str], optional: list[str]) -> dict` — the old `hil_smoke.evaluate` verdict rule on top of `BootResult`
  - `class SmokeScenario` with `name = "smoke"`, `Params = Params`, `description`, `run(ctx, params, progress) -> Report`
  - `SCENARIO = register(SmokeScenario())`
  - `Report.data` keys **exactly** as the old `--json`: `pass` (bool), `missing` (list[str]), `optional_missing` (list[str]), `errors` (list[str] full lines), `fatal` (list[str] full lines), `bootloops` (int); plus `seconds` (float) and `port` (str), which the old script did not have.
  - Artifact: `Artifact(path=str(workdir/"console.log"), mime="text/plain", role="console")`.
  - Exit codes: 0 pass, 1 fail, 2 = no boot banner at all (old "No boot banner on any candidate port") or flash failure (old "FLASH FAILED").
  - Contract ambiguities resolved: (1) the old `--flash` was a bare switch (always `build/CrossPad.bin`); the contract's `flash: str | None` is the firmware path, `None` = do not flash. (2) `flash` runs with `wait_boot=False`, then `POST_FLASH_S` elapses, then the console is opened with `reset=True` so the boot that is judged is a clean, deliberately triggered one. (3) "a boot began" is decided the old way — any line containing one of `markers["boot_markers"]` (`"ESP-ROM:"`, `"main_task: Started on CPU0"`) in the captured lines — rather than from parser counters, so the rule is identical to `hil_smoke.capture_boot`.

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_scenario_smoke.py`:

```python
"""Scenario `smoke` against a scripted console (no hardware)."""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from crosspad_hil.devices import Device, Ports, SerialPortInfo, UsbMode
from crosspad_hil.scenarios import base, get, smoke
from tests.fakes import FakeSerial

CDC_PATH = "/dev/ttyACM0"
CONSOLE_PATH = "/dev/ttyACM1"

# A healthy boot as the STM VCP shows it — the seven REQUIRED_MARKERS of
# hil_smoke.py in the order the firmware prints them, plus one allow-listed
# E-line (a missing STARTUP.wav is cosmetic: ERROR_ALLOWLIST r"file not found").
HEALTHY_BOOT = [
    "ESP-ROM:esp32s3-20210327",
    "I (312) main_task: Started on CPU0",
    "I (900) CrosspadPlatform: Platform fully initialized",
    "I (950) STM32: STM32 ident: r20 fw 1.4",
    "E (1000) SD: file not found: STARTUP.wav",
    "I (1200) main: Crosspad initialization complete",
    "I (1210) main: All systems operational",
    "I (1500) display: LVGL setup done successfully",
    "I (1600) gui: App registry initialized",
    "I (1700) gui: LoadMainScreen completed successfully",
]


class BootingSerial(FakeSerial):
    """STM VCP stand-in: the esptool pulse (RTS high then low) makes the ESP boot.

    Lines are delivered 0.3 s after RTS falls, i.e. after Console.reset() has
    finished `reset_pulse()` (0.1 s) and `parser.reset_boot_tracking()`, so the
    boot is counted in the fresh boot window exactly as on hardware.
    """

    def __init__(self, boot_lines: list[str]) -> None:
        super().__init__(timeout=0.01)
        self.boot_lines = list(boot_lines)
        self.boots = 0

    @property
    def rts(self) -> bool:
        return FakeSerial.rts.fget(self)  # type: ignore[attr-defined]

    @rts.setter
    def rts(self, value: bool) -> None:
        was = FakeSerial.rts.fget(self)  # type: ignore[attr-defined]
        FakeSerial.rts.fset(self, value)  # type: ignore[attr-defined]
        if was and not value:
            self.boots += 1
            threading.Timer(0.3, self.feed, [list(self.boot_lines)]).start()


def make_device() -> Device:
    return Device(
        id="dev_ab12",
        serial="CP-1",
        usb_mode=UsbMode.DEFAULT,
        ports=Ports(
            cdc=SerialPortInfo(path=CDC_PATH, vid=0x303A, pid=0x3456,
                               serial="CP-1", product="Crosspad", location="1-2.1"),
            console=SerialPortInfo(path=CONSOLE_PATH, vid=0x0483, pid=0x5740,
                                   serial="STM-1", product="CrossPad MIDI+Serial",
                                   location="1-2.2"),
        ),
    )


def make_ctx(tmp_path: Path, lines: list[str]) -> tuple[base.Context, BootingSerial]:
    fake = BootingSerial(lines)
    opened: list[tuple[str, Any]] = []

    def factory(path: str, **kw: Any) -> FakeSerial:
        opened.append((path, kw.get("reset")))
        assert path == CONSOLE_PATH, path
        return fake

    ctx = base.Context(device=make_device(), workdir=tmp_path,
                       cancelled=threading.Event(), log=lambda s: None,
                       serial_factory=factory)
    return ctx, fake


@pytest.fixture(autouse=True)
def fast_settle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(smoke, "SETTLE_S", 0.2)


@pytest.fixture(autouse=True)
def lock_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))


def test_registered() -> None:
    assert get("smoke") is smoke.SCENARIO
    assert smoke.SCENARIO.name == "smoke"
    assert smoke.Params().timeout == 25
    assert smoke.Params().flash is None


def test_healthy_boot_passes(tmp_path: Path) -> None:
    ctx, fake = make_ctx(tmp_path, HEALTHY_BOOT)
    report = smoke.SCENARIO.run(ctx, smoke.Params(timeout=5), base.Progress())
    assert report.passed is True
    assert report.exit_code == 0
    assert report.data["pass"] is True
    assert report.data["missing"] == []
    assert report.data["errors"] == []          # "file not found" is allow-listed
    assert report.data["fatal"] == []
    assert report.data["bootloops"] == 0
    assert "SD Card mounted successfully" in report.data["optional_missing"]
    assert {"pass", "missing", "optional_missing", "errors", "fatal", "bootloops",
            "seconds", "port"} <= set(report.data)
    assert report.data["port"] == CONSOLE_PATH
    assert [a.role for a in report.artifacts] == ["console"]
    assert report.artifacts[0].path == str(tmp_path / "console.log")
    assert (tmp_path / "console.log").read_text(encoding="utf-8").count("\n") >= 10
    assert "HIL SMOKE: PASS" in report.summary
    # The device was reset once, esptool-style, and RTS was released afterwards.
    assert fake.boots == 1
    rts = [v for attr, v in fake.control_history if attr == "rts"]
    assert True in rts and rts[-1] is False
    assert all(v is False for attr, v in fake.control_history if attr == "dtr")


def test_missing_marker_fails(tmp_path: Path) -> None:
    lines = [ln for ln in HEALTHY_BOOT if "STM32 ident:" not in ln]
    ctx, _fake = make_ctx(tmp_path, lines)
    report = smoke.SCENARIO.run(ctx, smoke.Params(timeout=2), base.Progress())
    assert report.passed is False
    assert report.exit_code == 1
    assert report.data["pass"] is False
    assert report.data["missing"] == ["STM32 ident:"]
    assert "MISSING MARKER: STM32 ident:" in report.summary
    assert "HIL SMOKE: FAIL" in report.summary


def test_fatal_fails(tmp_path: Path) -> None:
    lines = list(HEALTHY_BOOT[:4])
    lines.append("Guru Meditation Error: Core  0 panic'ed (LoadProhibited).")
    ctx, _fake = make_ctx(tmp_path, lines)
    report = smoke.SCENARIO.run(ctx, smoke.Params(timeout=2), base.Progress())
    assert report.passed is False
    assert report.exit_code == 1
    assert report.data["fatal"] == ["Guru Meditation Error: Core  0 panic'ed (LoadProhibited)."]
    assert "FATAL: Guru Meditation" in report.summary
    assert len(report.data["missing"]) == 5      # everything after the panic is gone


def test_unallowed_error_line_fails(tmp_path: Path) -> None:
    lines = list(HEALTHY_BOOT)
    lines.insert(5, "E (1100) i2c: timeout waiting for ack")
    ctx, _fake = make_ctx(tmp_path, lines)
    report = smoke.SCENARIO.run(ctx, smoke.Params(timeout=5), base.Progress())
    assert report.passed is False
    assert report.exit_code == 1
    assert report.data["errors"] == ["E (1100) i2c: timeout waiting for ack"]
    assert "ERROR LINE: E (1100) i2c: timeout waiting for ack" in report.summary


def test_boot_loop_fails(tmp_path: Path) -> None:
    # hil_smoke.evaluate: boots = max(count per BOOT_MARKER); bootloops = boots - 1
    lines = list(HEALTHY_BOOT[:2]) + list(HEALTHY_BOOT)
    ctx, _fake = make_ctx(tmp_path, lines)
    report = smoke.SCENARIO.run(ctx, smoke.Params(timeout=5), base.Progress())
    assert report.passed is False
    assert report.data["bootloops"] == 1
    assert "BOOT LOOP: device reset 1 extra time(s)" in report.summary


def test_no_banner_is_env_error(tmp_path: Path) -> None:
    ctx, _fake = make_ctx(tmp_path, [])
    report = smoke.SCENARIO.run(ctx, smoke.Params(timeout=1), base.Progress())
    assert report.passed is False
    assert report.exit_code == 2
    assert report.data["pass"] is False
    assert "No boot banner" in report.summary


def test_no_flash_when_param_is_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[Any, ...]] = []
    monkeypatch.setattr(smoke, "flash", lambda *a, **k: calls.append((a, k)))
    ctx, _fake = make_ctx(tmp_path, HEALTHY_BOOT)
    smoke.SCENARIO.run(ctx, smoke.Params(timeout=5), base.Progress())
    assert calls == []


def test_flash_called_with_firmware(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, Path, bool | None]] = []

    def fake_flash(device: Device, firmware: Path, **kw: Any) -> dict[str, Any]:
        calls.append((device.id, Path(firmware), kw.get("wait_boot")))
        return {"flash": {"bytes": 1, "seconds": 0.1, "kbps": 1.0,
                          "version": "x", "mode": "full"}, "boot": None}

    monkeypatch.setattr(smoke, "flash", fake_flash)
    monkeypatch.setattr(smoke, "POST_FLASH_S", 0.0)
    ctx, _fake = make_ctx(tmp_path, HEALTHY_BOOT)
    report = smoke.SCENARIO.run(
        ctx, smoke.Params(flash="build/CrossPad.bin", timeout=5), base.Progress())
    assert calls == [("dev_ab12", Path("build/CrossPad.bin"), False)]
    assert report.passed is True
    assert report.data["flash"]["mode"] == "full"


def test_flash_failure_is_env_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from crosspad_hil.errors import FLASH_FAILED, HilError

    def failing_flash(device: Device, firmware: Path, **kw: Any) -> dict[str, Any]:
        raise HilError(FLASH_FAILED, "OTA_ERROR 3", hint="re-run")

    monkeypatch.setattr(smoke, "flash", failing_flash)
    ctx, fake = make_ctx(tmp_path, HEALTHY_BOOT)
    report = smoke.SCENARIO.run(
        ctx, smoke.Params(flash="build/CrossPad.bin", timeout=5), base.Progress())
    assert report.passed is False
    assert report.exit_code == 2
    assert report.summary == "FLASH FAILED: OTA_ERROR 3"
    assert report.data["flash_error"]["code"] == FLASH_FAILED
    assert fake.boots == 0                        # never got as far as the console
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_smoke.py -q 2>&1 | tail -3`
Expected: FAIL with `ImportError: cannot import name 'smoke' from 'crosspad_hil.scenarios'`

- [ ] **Step 3: Write minimal implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/smoke.py`:

```python
"""Boot smoke test — port of platform-idf/tools/hil_smoke.py.

Resets the device through the STM32 VCP bridge (esptool-style DTR/RTS pulse —
the bridge turns it into EN/IO0), captures the boot log and asserts:

  * every required marker appears (knowledge/markers.yaml `required`),
  * no E-level line outside the allow-list (`error_allow`),
  * no Guru Meditation / abort / assert / boot loop (`fatal_patterns`).

Exit code 0 = PASS, 1 = FAIL, 2 = no boot banner at all / flash failed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from crosspad_hil.console import BootResult
from crosspad_hil.errors import HilError
from crosspad_hil.knowledge import load as load_knowledge
from crosspad_hil.ota import flash
from crosspad_hil.scenarios import register
from crosspad_hil.scenarios.base import Artifact, Context, Progress, Report

# from hil_smoke.capture_boot: after the last required marker keep reading for
# 3 s so a late error is still caught.
SETTLE_S: float = 3.0
# from hil_smoke.main: time.sleep(3)  # let the device reboot and re-enumerate
POST_FLASH_S: float = 3.0


@dataclass
class Params:
    flash: str | None = field(
        default=None,
        metadata={"help": "OTA-flash this firmware image (e.g. build/CrossPad.bin) first"},
    )
    timeout: int = field(
        default=25,
        metadata={"help": "boot capture window in seconds"},
    )


def evaluate(boot: BootResult, lines: list[str], optional: list[str]) -> dict[str, Any]:
    """hil_smoke.evaluate on top of Console.wait_boot: same keys, same verdict rule."""
    text = "\n".join(lines)
    data: dict[str, Any] = {
        "pass": False,
        "missing": list(boot.missing),
        "optional_missing": [m for m in optional if m not in text],
        "errors": [e["line"] for e in boot.errors],
        "fatal": [f["line"] for f in boot.fatal],
        "bootloops": int(boot.bootloops),
    }
    data["pass"] = (
        not data["missing"]
        and not data["errors"]
        and not data["fatal"]
        and data["bootloops"] == 0
    )
    return data


def _summary(data: dict[str, Any]) -> str:
    """The lines hil_smoke.main printed in non-JSON mode."""
    lines: list[str] = []
    for m in data["missing"]:
        lines.append(f"MISSING MARKER: {m}")
    for m in data["optional_missing"]:
        lines.append(f"note: optional marker absent: {m}")
    for e in data["errors"]:
        lines.append(f"ERROR LINE: {e}")
    for f in data["fatal"]:
        lines.append(f"FATAL: {f}")
    if data["bootloops"]:
        lines.append(f"BOOT LOOP: device reset {data['bootloops']} extra time(s)")
    lines.append("HIL SMOKE: PASS" if data["pass"] else "HIL SMOKE: FAIL")
    return "\n".join(lines)


class SmokeScenario:
    name = "smoke"
    Params = Params
    description = "reset, capture the boot log, check markers / E-lines / fatals / boot loops"

    def run(self, ctx: Context, params: Params, progress: Progress) -> Report:
        console_log = ctx.workdir / "console.log"
        artifacts = [Artifact(path=str(console_log), mime="text/plain", role="console")]
        flash_result: dict[str, Any] | None = None

        if params.flash is not None:
            progress(0, 3, f"flashing {params.flash}")
            try:
                flash_result = flash(
                    ctx.device, Path(params.flash), transport="ota", wait_boot=False
                )
            except HilError as e:
                return Report(
                    passed=False,
                    summary=f"FLASH FAILED: {e.message}",
                    data={
                        "pass": False, "missing": [], "optional_missing": [],
                        "errors": [], "fatal": [], "bootloops": 0,
                        "flash_error": e.to_dict(),
                    },
                    artifacts=[],
                    exit_code=2,
                )
            ctx.cancelled.wait(POST_FLASH_S)
            ctx.check_cancelled()

        markers = load_knowledge("markers")
        boot_markers: list[str] = list(markers["boot_markers"])
        optional: list[str] = list(markers.get("optional", []))

        progress(1, 3, "resetting device and capturing boot")
        console = ctx.open_console(reset=True)
        try:
            boot = console.wait_boot(timeout_s=float(params.timeout), settle_s=SETTLE_S)
            ctx.check_cancelled()
            captured = console.read(since_seq=0, limit=50_000)
            port = console.snapshot()["port"]
        finally:
            console.close()

        progress(2, 3, "evaluating")
        lines = [line for _seq, line in captured.lines]
        # hil_smoke.capture_boot: no BOOT_MARKER at all means the wrong port or
        # a dead board, which is an environment failure, not a failed boot.
        saw_banner = any(any(m in line for m in boot_markers) for line in lines)
        if not saw_banner:
            data = {
                "pass": False, "missing": list(boot.missing), "optional_missing": optional,
                "errors": [], "fatal": [], "bootloops": 0,
                "seconds": boot.seconds, "port": port,
            }
            if flash_result is not None:
                data["flash"] = flash_result.get("flash")
            return Report(
                passed=False,
                summary="No boot banner on the console port — is the device connected, "
                        "and is the STM32 bridge VCP (0x0483:0x5740) the console?",
                data=data,
                artifacts=artifacts,
                exit_code=2,
            )

        data = evaluate(boot, lines, optional)
        data["seconds"] = boot.seconds
        data["port"] = port
        if flash_result is not None:
            data["flash"] = flash_result.get("flash")
        progress(3, 3, "done")
        return Report(
            passed=data["pass"],
            summary=_summary(data),
            data=data,
            artifacts=artifacts,
            exit_code=0 if data["pass"] else 1,
        )


SCENARIO = register(SmokeScenario())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_smoke.py -q 2>&1 | tail -3 && ruff check crosspad_hil/scenarios/smoke.py tests/test_scenario_smoke.py && ruff format --check crosspad_hil/scenarios/smoke.py tests/test_scenario_smoke.py`
Expected: `9 passed`, `All checks passed!` (run `ruff format` on both files if the format check complains, then re-run).

- [ ] **Step 5: Check the scenario shows up in the registry and the CLI help**

Run: `cd /home/matixan/GIT/crosspad-hil && python -c "from crosspad_hil.scenarios import names; print(names())"`
Expected: a list containing `'smoke'`.

- [ ] **Step 6: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/scenarios/smoke.py tests/test_scenario_smoke.py && git commit -m "feat(scenarios): smoke — boot markers, E-lines, fatals and boot loops, ported from hil_smoke.py"
```

---

### Task 4: `scenarios/led_state.py` — LED model dump (port of `hil_led_state.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/led_state.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_scenario_led_state.py`

**Interfaces:**
- Consumes (contract):
  - `Context.open_cdc() -> CdcLink`, `Context.cancelled: threading.Event`, `Context.log`
  - `crosspad_hil.verbs.led_state(link) -> dict` — the parsed `LEDS:` reply: `{kind: "leds", brightness: int, anim: bool, coalesce: bool, cfgbri: int, pwr: int, pwr_count: int, txfail: int, colors: list[str] (16 × "RRGGBB")}` (Plan A `parsers._parse_leds` of `hil_control.cpp handle_led_state`: `"LEDS: bri=%u anim=%d coalesce=%d cfgbri=%u pwr=0x%02X pwrN=%u txfail=%u colors=RRGGBB,…"`)
  - `crosspad_hil.cdc.CdcLink.close()`
  - `Report`, `Progress`, `register`, `get`
- Produces:
  - `Params(watch: bool = False)`
  - `WATCH_PERIOD_S: float = 2.0` (from `hil_led_state.main`: `time.sleep(2)`)
  - `render_grid(state: dict) -> str` — the text block of the old `render()`: header lines, the 4×4 grid with pads 12..15 on the top row, the txfail line when non-zero, the "every pad is black" note
  - `class LedStateScenario` (`name = "led_state"`), `SCENARIO`
  - `Report.data`: `{"leds": <verbs.led_state dict of the last sample>, "all_black": bool, "samples": int}`
  - Contract ambiguities resolved: (1) the scenario never *fails* — it is a diagnostic dump, `passed=True`, `exit_code=0`, exactly like the old script; a device `ERR`/timeout propagates as `HilError` (exit 2 through `run_scenario`). (2) With `watch=True` the loop ends **cleanly** when `ctx.cancelled` is set (no `CANCELLED` error), because cancelling a watch is the normal way to stop it; each sample is reported through `progress(n, None, grid)` and `ctx.log(grid)`. (3) `anim`/`coalesce` are rendered as `0`/`1` like the old script, although the parser gives bools.

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_scenario_led_state.py`:

```python
"""Scenario `led_state` against a scripted CDC link (no hardware)."""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from crosspad_hil.devices import Device, Ports, SerialPortInfo, UsbMode
from crosspad_hil.scenarios import base, get, led_state
from tests.fakes import FakeSerial

CDC_PATH = "/dev/ttyACM0"
CONSOLE_PATH = "/dev/ttyACM1"

# Reply format from platform-idf/main/hil_control.cpp handle_led_state():
# "LEDS: bri=%u anim=%d coalesce=%d cfgbri=%u pwr=0x%02X pwrN=%u txfail=%u colors=…"
COLORS = ["FF0000", "00FF00", "0000FF", "FFFFFF",
          "101010", "202020", "303030", "404040",
          "505050", "606060", "707070", "808080",
          "AA0000", "00AA00", "0000AA", "AAAAAA"]
LEDS_REPLY = ("LEDS: bri=200 anim=0 coalesce=1 cfgbri=200 pwr=0x03 pwrN=2 txfail=0 "
              "colors=" + ",".join(COLORS))
BLACK_REPLY = ("LEDS: bri=0 anim=1 coalesce=0 cfgbri=200 pwr=0x04 pwrN=5 txfail=3 "
               "colors=" + ",".join(["000000"] * 16))


def make_device() -> Device:
    return Device(
        id="dev_ab12", serial="CP-1", usb_mode=UsbMode.DEFAULT,
        ports=Ports(
            cdc=SerialPortInfo(path=CDC_PATH, vid=0x303A, pid=0x3456,
                               serial="CP-1", product="Crosspad", location="1-2.1"),
            console=SerialPortInfo(path=CONSOLE_PATH, vid=0x0483, pid=0x5740,
                                   serial="STM-1", product="CrossPad MIDI+Serial",
                                   location="1-2.2"),
        ),
    )


def make_ctx(tmp_path: Path, reply: str) -> tuple[base.Context, FakeSerial]:
    fake = FakeSerial(script=[("LED_STATE", reply)], timeout=0.01)

    def factory(path: str, **kw: Any) -> FakeSerial:
        assert path == CDC_PATH, path
        return fake

    ctx = base.Context(device=make_device(), workdir=tmp_path,
                       cancelled=threading.Event(), log=lambda s: None,
                       serial_factory=factory)
    return ctx, fake


@pytest.fixture(autouse=True)
def lock_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))


def test_registered() -> None:
    assert get("led_state") is led_state.SCENARIO
    assert led_state.SCENARIO.name == "led_state"
    assert led_state.Params().watch is False


def test_single_query_renders_grid(tmp_path: Path) -> None:
    ctx, fake = make_ctx(tmp_path, LEDS_REPLY)
    report = led_state.SCENARIO.run(ctx, led_state.Params(), base.Progress())
    assert report.passed is True
    assert report.exit_code == 0
    assert report.data["samples"] == 1
    assert report.data["all_black"] is False
    assert report.data["leds"]["brightness"] == 200
    assert report.data["leds"]["colors"] == COLORS
    rows = [ln for ln in report.summary.splitlines() if ln.strip().startswith("12:")]
    assert rows, report.summary
    # Top row is pads 12..15, as they sit under your hands.
    assert rows[0].split() == ["12:AA0000", "13:00AA00", "14:0000AA", "15:AAAAAA"]
    bottom = [ln for ln in report.summary.splitlines() if ln.strip().startswith("0:")]
    assert bottom[0].split() == ["0:FF0000", "1:00FF00", "2:0000FF", "3:FFFFFF"]
    assert "brightness 200   settings 200   animating 0   coalesced 1" in report.summary
    assert "last power state 0x03   notifications 2" in report.summary
    assert "never reached the strip" not in report.summary
    assert "every pad is black" not in report.summary
    assert fake.written == ["LED_STATE"]
    assert report.artifacts == []


def test_black_model_is_called_out(tmp_path: Path) -> None:
    ctx, _fake = make_ctx(tmp_path, BLACK_REPLY)
    report = led_state.SCENARIO.run(ctx, led_state.Params(), base.Progress())
    assert report.passed is True
    assert report.data["all_black"] is True
    assert "every pad is black in the model — nothing repainted them" in report.summary
    assert "3 frame(s) never reached the strip" in report.summary
    assert "last power state 0x04   notifications 5" in report.summary


def test_render_grid_pads_missing_colors() -> None:
    state = {"brightness": 1, "anim": False, "coalesce": True, "cfgbri": 1, "pwr": 0,
             "pwr_count": 0, "txfail": 0, "colors": ["112233"]}
    text = led_state.render_grid(state)
    assert " 0:112233" in text
    assert "15:??????" in text
    assert "animating 0   coalesced 1" in text
    assert "every pad is black" not in text      # one non-black pad known


def test_watch_stops_on_cancel(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(led_state, "WATCH_PERIOD_S", 0.05)
    ctx, fake = make_ctx(tmp_path, LEDS_REPLY)
    seen: list[tuple[int, int | None, str]] = []

    class Counting(base.Progress):
        def __call__(self, progress: int, total: int | None, message: str) -> None:
            seen.append((progress, total, message))
            if progress >= 3:
                ctx.cancelled.set()

    report = led_state.SCENARIO.run(ctx, led_state.Params(watch=True), Counting())
    assert report.passed is True                  # a cancelled watch is not a failure
    assert report.exit_code == 0
    assert report.data["samples"] == 3
    assert fake.written == ["LED_STATE"] * 3
    assert [p for p, _t, _m in seen] == [1, 2, 3]
    assert all(t is None for _p, t, _m in seen)
    assert "12:AA0000" in seen[0][2]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_led_state.py -q 2>&1 | tail -3`
Expected: FAIL with `ImportError: cannot import name 'led_state' from 'crosspad_hil.scenarios'`

- [ ] **Step 3: Write minimal implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/led_state.py`:

```python
"""Dump what the firmware thinks the pad LEDs should be showing.

Port of platform-idf/tools/hil_led_state.py. Prints the LED controller's model
— per-pad colour, brightness, animation flag — plus the last power-state
notification the STM sent. Run it while the pads look wrong: the answer to
"why are they dark?" is one of

  * colours are 000000        -> whatever painted them last painted black
  * bri=0 (or cfgbri=0)       -> brightness, not colour
  * anim=1                    -> an animation owns the strip and blocks repaints
  * pwr/pwrN did not change   -> the wake notification never reached the ESP
  * everything looks right    -> the frame is correct and the fault is below the
                                 driver: the RMT transmission or the strip rail

This is a diagnostic dump, not a check: it always passes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from crosspad_hil import verbs
from crosspad_hil.scenarios import register
from crosspad_hil.scenarios.base import Context, Progress, Report

# from hil_led_state.main: time.sleep(2) between polls
WATCH_PERIOD_S: float = 2.0


@dataclass
class Params:
    watch: bool = field(
        default=False, metadata={"help": "poll every 2 s until cancelled (Ctrl-C)"}
    )


def render_grid(state: dict[str, Any]) -> str:
    """Text block of hil_led_state.render(): header, 4x4 grid, black-model note."""
    colors: list[str] = list(state.get("colors", []))
    out: list[str] = []
    out.append(
        f"  brightness {state.get('brightness')}   settings {state.get('cfgbri')}"
        f"   animating {int(bool(state.get('anim', 0)))}"
        f"   coalesced {int(bool(state.get('coalesce', 0)))}"
    )
    out.append(
        f"  last power state 0x{int(state.get('pwr', 0xFF)):02X}"
        f"   notifications {state.get('pwr_count')}"
        f"   (0x00 AWAKE · 0x03 WOKE · 0x04 LIGHT)"
    )
    txfail = int(state.get("txfail", 0))
    if txfail != 0:
        out.append(
            f"  {txfail} frame(s) never reached the strip — the model is "
            f"right and the wire is not"
        )
    out.append("")
    # 4x4 as it sits under your hands: pad 12..15 on the top row.
    for row in range(3, -1, -1):
        cells = []
        for col in range(4):
            idx = row * 4 + col
            c = colors[idx] if idx < len(colors) else "??????"
            cells.append(f"{idx:2d}:{c}")
        out.append("   " + "  ".join(cells))
    out.append("")
    if colors and all(c == "000000" for c in colors):
        out.append("  every pad is black in the model — nothing repainted them")
    return "\n".join(out)


class LedStateScenario:
    name = "led_state"
    Params = Params
    description = "dump the LED controller model (colours, brightness, anim, power state)"

    def run(self, ctx: Context, params: Params, progress: Progress) -> Report:
        link = ctx.open_cdc()
        samples = 0
        state: dict[str, Any] = {}
        grid = ""
        try:
            while True:
                state = verbs.led_state(link)
                samples += 1
                grid = render_grid(state)
                progress(samples, None, grid)
                ctx.log(grid)
                if not params.watch:
                    break
                # A cancelled watch is the normal way to stop it, not an error.
                if ctx.cancelled.wait(WATCH_PERIOD_S):
                    break
                ctx.log("-" * 60)
        finally:
            link.close()

        colors = list(state.get("colors", []))
        data = {
            "leds": state,
            "all_black": bool(colors) and all(c == "000000" for c in colors),
            "samples": samples,
        }
        return Report(passed=True, summary=grid, data=data, artifacts=[], exit_code=0)


SCENARIO = register(LedStateScenario())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_led_state.py -q 2>&1 | tail -3 && ruff check crosspad_hil/scenarios/led_state.py tests/test_scenario_led_state.py && ruff format --check crosspad_hil/scenarios/led_state.py tests/test_scenario_led_state.py`
Expected: `5 passed`, `All checks passed!`

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/scenarios/led_state.py tests/test_scenario_led_state.py && git commit -m "feat(scenarios): led_state — LED model dump with 4x4 grid and cancellable watch, ported from hil_led_state.py"
```

---

### Task 5: `scenarios/app_churn.py` — open/close every app, watch the heap (port of `hil_app_churn.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/app_churn.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_scenario_app_churn.py`

**Interfaces:**
- Consumes (contract):
  - `Context.open_console(reset=False) -> Console`, `Context.open_cdc() -> CdcLink`, `Context.cancelled`, `Context.check_cancelled()`, `Context.log`, `Context.serial_factory` (tests)
  - `Console.events(since_seq: int = 0) -> list[ConsoleEvent]` (`ConsoleEvent(kind, seq, line, data)`; kinds used: `"fatal"` with `data["pattern"]`, `"reboot"` with `data["count"]`), `Console.close()`
  - `verbs.app_list(link) -> {"kind": "apps", "apps": list[str], "running": str | None}` (`APPS: A,B,C running=X`; `running=-` → `None`)
  - `verbs.app_start(link, name, wait_s=3.0) -> {"running": name}` — raises `HilError(BAD_ARGS)` on `ERR unknown app`, `HilError(TIMEOUT)` when `APP_LIST` never reports it running
  - `verbs.app_stop(link) -> {"ok": True}` (`APP_STOP` → `OK`)
  - `verbs.mem(link) -> dict` with `int_free`, `int_largest`, `int_min`, `int_blocks`, `psram_free`, `psram_largest`, `psram_blocks` (from `hil_control.cpp handle_mem`)
  - `HilError` (`.code`, `.message`), codes `CANCELLED`; `Report`, `Artifact`, `Progress`, `register`, `get`
- Produces:
  - `Params(rounds: int = 3, apps: list[str] | None = None, skip: list[str] | None = None, dwell: float = 1.0, settle: float = 1.2, leak_bytes: int = 2048)`
  - `DEFAULT_SKIP: tuple[str, ...] = ("Power OFF", "Update", "Settings")` (from `hil_app_churn.DEFAULT_SKIP`; used when `skip is None`)
  - `START_WAIT_S: float = 3.0` — `wait_s` passed to `verbs.app_start`
  - `slope(series: list[int]) -> tuple[float, float, int, float] | None` — `(head, tail, visits, per_visit)` with the old rule from `hil_app_churn.report` (`head = mean(series[1:3])`, `tail = mean(series[-2:])`, `visits = len(series) - 2`, `per_visit = (head - tail) / visits`); `None` when fewer than 3 samples
  - `class AppChurnScenario` (`name = "app_churn"`), `SCENARIO`
  - `Report.data`: `{"apps": list[str] (launcher), "targets": list[str], "skipped": list[str], "rounds": int, "trend": {app: list[int]}, "slopes": {app: {"head": float, "tail": float, "visits": int, "per_visit": float, "leak": bool}}, "leaks": list[str], "failures": list[str], "launch_fail": {app: int}, "fatal": list[str], "reboots": int, "leak_bytes": int}`
  - Artifact: `Artifact(path=str(workdir/"console.log"), mime="text/plain", role="console")`
  - Exit codes: 0 pass, 1 leak / crash / reboot / stuck / refused launch, 2 empty `APP_LIST` or unknown `--apps` names.
  - Contract ambiguities resolved: (1) heap sampling is `verbs.mem(link)["int_free"]` after every close (the task brief), not the PerfMon `Free:` console block the old script scraped — `MEM` is on demand, PerfMon prints every ~10 s, so per-visit sampling is finally exact. (2) The console is opened with `reset=False` (fixing the old script, which reset the ESP just by opening the STM VCP with DTR/RTS asserted) and is used **only** for fatal/reboot detection through `Console.events`; a `"reboot"` event during the churn is a crash even without a fatal line, because nobody asked for a reset. (3) The launcher exit is `APP_STOP` (the contract's `app_stop`; the old script used `APP_DESTROY`). (4) `dwell`/`settle` waits go through `ctx.cancelled.wait`, and `ctx.check_cancelled()` runs before every visit, so `task.cancel` returns within one CDC transaction with `HilError(CANCELLED)`.

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_scenario_app_churn.py`:

```python
"""Scenario `app_churn` against a stateful fake device (no hardware)."""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from crosspad_hil.devices import Device, Ports, SerialPortInfo, UsbMode
from crosspad_hil.errors import CANCELLED, HilError
from crosspad_hil.scenarios import app_churn, base, get
from tests.fakes import FakeSerial

CDC_PATH = "/dev/ttyACM0"
CONSOLE_PATH = "/dev/ttyACM1"
LAUNCHER = ["Sampler", "Mixer", "Leaky", "Settings", "Power OFF"]
GURU = "Guru Meditation Error: Core  1 panic'ed (StoreProhibited). Exception was unhandled."


class ChurnDevice(FakeSerial):
    """A CDC endpoint that behaves like hil_control.cpp for the churn verbs.

    APP_LIST reports the running app ("APPS: A,B running=X" / "running=-"),
    APP_START <name> answers OK (or "ERR unknown app") and makes it run,
    APP_STOP answers OK and returns to the launcher, MEM reports an internal
    heap that drops `leak_per_visit[app]` bytes every time that app is closed —
    a leak with a name attached. Anything else is echoed, as the device does.
    """

    def __init__(self, leak_per_visit: dict[str, int] | None = None) -> None:
        super().__init__(timeout=0.01)
        self.running: str | None = None
        self.int_free = 100_000
        self.leak_per_visit = leak_per_visit or {}
        self.visits: dict[str, int] = {}

    def write(self, data: bytes) -> int:
        cmd = data.decode("utf-8", "replace").strip()
        self.written.append(cmd)
        if cmd == "APP_LIST":
            self.feed([f"APPS: {','.join(LAUNCHER)} running={self.running or '-'}"])
        elif cmd.startswith("APP_START "):
            name = cmd.split(" ", 1)[1]
            if name not in LAUNCHER:
                self.feed(["ERR unknown app"])
            else:
                self.running = name
                self.feed(["OK"])
        elif cmd == "APP_STOP":
            if self.running is not None:
                self.visits[self.running] = self.visits.get(self.running, 0) + 1
                self.int_free -= self.leak_per_visit.get(self.running, 0)
                self.running = None
            self.feed(["OK"])
        elif cmd == "MEM":
            self.feed([f"MEM: int_free={self.int_free} int_largest=65536 int_min=90000 "
                       f"int_blocks=400 psram_free=7000000 psram_largest=6000000 "
                       f"psram_blocks=120"])
        else:
            self.feed([cmd])
        return len(data)


def make_device() -> Device:
    return Device(
        id="dev_ab12", serial="CP-1", usb_mode=UsbMode.DEFAULT,
        ports=Ports(
            cdc=SerialPortInfo(path=CDC_PATH, vid=0x303A, pid=0x3456,
                               serial="CP-1", product="Crosspad", location="1-2.1"),
            console=SerialPortInfo(path=CONSOLE_PATH, vid=0x0483, pid=0x5740,
                                   serial="STM-1", product="CrossPad MIDI+Serial",
                                   location="1-2.2"),
        ),
    )


def make_ctx(tmp_path: Path, dev: ChurnDevice) -> tuple[base.Context, FakeSerial]:
    con = FakeSerial(timeout=0.01)
    ports = {CDC_PATH: dev, CONSOLE_PATH: con}

    def factory(path: str, **kw: Any) -> FakeSerial:
        return ports[path]

    ctx = base.Context(device=make_device(), workdir=tmp_path,
                       cancelled=threading.Event(), log=lambda s: None,
                       serial_factory=factory)
    return ctx, con


FAST: dict[str, float] = {"dwell": 0.0, "settle": 0.0}


@pytest.fixture(autouse=True)
def lock_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))


def test_registered_and_defaults() -> None:
    assert get("app_churn") is app_churn.SCENARIO
    assert app_churn.SCENARIO.name == "app_churn"
    p = app_churn.Params()
    assert (p.rounds, p.apps, p.skip, p.dwell, p.settle, p.leak_bytes) == \
        (3, None, None, 1.0, 1.2, 2048)
    assert app_churn.DEFAULT_SKIP == ("Power OFF", "Update", "Settings")


def test_slope_rule() -> None:
    assert app_churn.slope([]) is None
    assert app_churn.slope([1, 2]) is None
    # head = mean(series[1:3]), tail = mean(series[-2:]), visits = len - 2
    assert app_churn.slope([100, 90, 80, 70, 60]) == (85.0, 65.0, 3, 20.0)
    assert app_churn.slope([100, 100, 100]) == (100.0, 100.0, 1, 0.0)


def test_clean_run_passes(tmp_path: Path) -> None:
    dev = ChurnDevice()
    ctx, con = make_ctx(tmp_path, dev)
    report = app_churn.SCENARIO.run(ctx, app_churn.Params(rounds=4, **FAST), base.Progress())
    assert report.passed is True
    assert report.exit_code == 0
    assert report.data["apps"] == LAUNCHER
    assert report.data["targets"] == ["Sampler", "Mixer", "Leaky"]
    assert report.data["skipped"] == ["Settings", "Power OFF"]
    assert report.data["leaks"] == []
    assert report.data["failures"] == []
    assert report.data["fatal"] == [] and report.data["reboots"] == 0
    assert all(len(s) == 4 for s in report.data["trend"].values())
    assert all(v["leak"] is False for v in report.data["slopes"].values())
    assert dev.visits == {"Sampler": 4, "Mixer": 4, "Leaky": 4}
    assert dev.running is None
    # The console was opened deasserted and never pulsed: no ESP reset on open.
    assert ("rts", True) not in con.control_history
    assert ("dtr", True) not in con.control_history
    assert "PASS — no crashes" in report.summary
    assert [a.role for a in report.artifacts] == ["console"]
    assert report.artifacts[0].path == str(tmp_path / "console.log")


def test_leak_detected(tmp_path: Path) -> None:
    dev = ChurnDevice(leak_per_visit={"Leaky": 5000})
    ctx, _con = make_ctx(tmp_path, dev)
    report = app_churn.SCENARIO.run(
        ctx, app_churn.Params(rounds=5, leak_bytes=2048, **FAST), base.Progress())
    assert report.passed is False
    assert report.exit_code == 1
    assert report.data["slopes"]["Leaky"]["leak"] is True
    assert report.data["slopes"]["Leaky"]["per_visit"] == 5000.0
    assert report.data["slopes"]["Sampler"]["leak"] is False
    assert report.data["slopes"]["Sampler"]["per_visit"] == 0.0
    assert len(report.data["leaks"]) == 1
    assert report.data["leaks"][0].startswith("Leaky: ~5000 B lost per visit")
    assert "<-- LEAK ~5000 B/visit" in report.summary
    assert "FAIL — 1 problem(s):" in report.summary


def test_leak_under_threshold_passes(tmp_path: Path) -> None:
    dev = ChurnDevice(leak_per_visit={"Mixer": 1000})
    ctx, _con = make_ctx(tmp_path, dev)
    report = app_churn.SCENARIO.run(
        ctx, app_churn.Params(rounds=5, leak_bytes=2048, **FAST), base.Progress())
    assert report.passed is True
    assert report.data["slopes"]["Mixer"]["per_visit"] == 1000.0
    assert report.data["slopes"]["Mixer"]["leak"] is False


def test_apps_subset_and_skip(tmp_path: Path) -> None:
    dev = ChurnDevice()
    ctx, _con = make_ctx(tmp_path, dev)
    report = app_churn.SCENARIO.run(
        ctx, app_churn.Params(rounds=3, apps=["Mixer"], **FAST), base.Progress())
    assert report.passed is True
    assert report.data["targets"] == ["Mixer"]
    assert report.data["skipped"] == []
    assert dev.visits == {"Mixer": 3}

    dev2 = ChurnDevice()
    ctx2, _con2 = make_ctx(tmp_path, dev2)
    report2 = app_churn.SCENARIO.run(
        ctx2, app_churn.Params(rounds=3, skip=["Sampler", "Mixer"], **FAST), base.Progress())
    assert report2.data["targets"] == ["Leaky", "Settings", "Power OFF"]
    assert report2.data["skipped"] == ["Sampler", "Mixer"]


def test_unknown_app_is_env_error(tmp_path: Path) -> None:
    dev = ChurnDevice()
    ctx, _con = make_ctx(tmp_path, dev)
    report = app_churn.SCENARIO.run(
        ctx, app_churn.Params(rounds=3, apps=["Nope"], **FAST), base.Progress())
    assert report.passed is False
    assert report.exit_code == 2
    assert "not in the launcher: Nope" in report.summary
    assert dev.visits == {}


def test_running_app_is_stopped_first(tmp_path: Path) -> None:
    dev = ChurnDevice()
    dev.running = "Mixer"
    ctx, _con = make_ctx(tmp_path, dev)
    app_churn.SCENARIO.run(ctx, app_churn.Params(rounds=1, **FAST), base.Progress())
    assert dev.written[:2] == ["APP_LIST", "APP_STOP"]


def test_fatal_on_console_fails_fast(tmp_path: Path) -> None:
    dev = ChurnDevice()
    ctx, con = make_ctx(tmp_path, dev)

    class PanicOnFirstVisit(base.Progress):
        """The console shows a panic while the first app is open."""

        def __call__(self, progress: int, total: int | None, message: str) -> None:
            if progress == 1:
                con.feed([GURU])

    report = app_churn.SCENARIO.run(
        ctx, app_churn.Params(rounds=5, **FAST), PanicOnFirstVisit())
    assert report.passed is False
    assert report.exit_code == 1
    assert report.data["fatal"] == [GURU]
    assert any("Sampler: device fault on round 1" in f for f in report.data["failures"])
    # It stopped at the first visit rather than churning on over a crash.
    assert sum(dev.visits.values()) == 1
    assert report.data["trend"]["Sampler"] == []


def test_reboot_without_fatal_line_fails(tmp_path: Path) -> None:
    dev = ChurnDevice()
    ctx, con = make_ctx(tmp_path, dev)

    class RebootOnSecondVisit(base.Progress):
        def __call__(self, progress: int, total: int | None, message: str) -> None:
            if progress == 2:
                con.feed(["ESP-ROM:esp32s3-20210327", "rst:0x7 (TG0WDT_SYS_RST),boot:0x8"])

    report = app_churn.SCENARIO.run(
        ctx, app_churn.Params(rounds=5, **FAST), RebootOnSecondVisit())
    assert report.passed is False
    assert report.data["reboots"] == 1
    assert any("Mixer: device rebooted on round 1" in f for f in report.data["failures"])
    assert sum(dev.visits.values()) == 2


def test_cancel_stops_between_visits(tmp_path: Path) -> None:
    dev = ChurnDevice()
    ctx, _con = make_ctx(tmp_path, dev)

    class CancelAfterTwo(base.Progress):
        def __call__(self, progress: int, total: int | None, message: str) -> None:
            if progress >= 2:
                ctx.cancelled.set()

    with pytest.raises(HilError) as ei:
        app_churn.SCENARIO.run(ctx, app_churn.Params(rounds=10, **FAST), CancelAfterTwo())
    assert ei.value.code == CANCELLED
    assert sum(dev.visits.values()) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_app_churn.py -q 2>&1 | tail -3`
Expected: FAIL with `ImportError: cannot import name 'app_churn' from 'crosspad_hil.scenarios'`

- [ ] **Step 3: Write minimal implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/app_churn.py`:

```python
"""Open and close every app in the launcher, over and over, and watch what leaks.

Port of platform-idf/tools/hil_app_churn.py. This is the demo-floor test: a
visitor picks an app, plays with it, backs out, picks another. Two failure
modes only show up here:

  * an app that never frees what create() allocated — internal heap trends
    down one step per visit, and after enough visits allocation starts failing
  * an app that leaves a dangling encoder group or widget pointer behind —
    the crash lands on the SECOND visit, not the first

The device is driven over CDC (APP_LIST / APP_START / APP_STOP), the internal
heap is sampled with MEM after every close, and the STM VCP console — opened
WITHOUT resetting the ESP — is watched for fatals and reboots.

Exit code 0 = PASS, 1 = leak / crash / stuck, 2 = device without HIL control
or an unknown app name.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from crosspad_hil import verbs
from crosspad_hil.console import Console
from crosspad_hil.errors import HilError
from crosspad_hil.scenarios import register
from crosspad_hil.scenarios.base import Artifact, Context, Progress, Report

# from hil_app_churn.DEFAULT_SKIP: apps that are not a "visit" — they power the
# device down, re-enumerate USB, or flash firmware. Churning them tests the
# harness, not the launcher.
DEFAULT_SKIP: tuple[str, ...] = ("Power OFF", "Update", "Settings")
# How long verbs.app_start polls APP_LIST before a launch counts as refused.
START_WAIT_S: float = 3.0


@dataclass
class Params:
    rounds: int = field(default=3, metadata={"help": "visits per app"})
    apps: list[str] | None = field(
        default=None,
        metadata={"help": "comma-separated subset; default is everything APP_LIST reports"},
    )
    skip: list[str] | None = field(
        default=None,
        metadata={"help": "comma-separated apps to leave alone (default: Power OFF,Update,Settings)"},
    )
    dwell: float = field(
        default=1.0, metadata={"help": "seconds to stay inside an app before closing"}
    )
    settle: float = field(
        default=1.2, metadata={"help": "seconds after closing before sampling the heap"}
    )
    leak_bytes: int = field(
        default=2048,
        metadata={"help": "per-visit internal-heap loss that counts as a leak"},
    )


def slope(series: list[int]) -> tuple[float, float, int, float] | None:
    """(head, tail, visits, per_visit) of a free-heap series, or None if too short.

    from hil_app_churn.report: compare the tail to the head rather than
    first-to-last — the first visit pays one-off costs (font glyph cache, lazily
    built tables) that are not a leak, and averaging both ends rejects jitter.
    """
    if len(series) < 3:
        return None
    head = sum(series[1:3]) / 2
    tail = sum(series[-2:]) / 2
    visits = len(series) - 2
    drop = head - tail
    per_visit = drop / visits if visits else 0.0
    return head, tail, visits, per_visit


class _ConsoleWatch:
    """New fatal / reboot events since the last look, from Console.events()."""

    def __init__(self, console: Console) -> None:
        self._console = console
        self._handled = 0

    def poll(self) -> tuple[list[str], int]:
        events = self._console.events(since_seq=0)
        fresh, self._handled = events[self._handled:], len(events)
        fatal = [ev.line for ev in fresh if ev.kind == "fatal"]
        reboots = sum(1 for ev in fresh if ev.kind == "reboot")
        return fatal, reboots


def _report(data: dict[str, Any], console_log: str, leak_bytes: int) -> Report:
    lines: list[str] = ["--- per-app free-heap trend " + "-" * 32]
    leaks: list[str] = []
    slopes: dict[str, dict[str, Any]] = {}
    for app, series in data["trend"].items():
        s = slope(series)
        if s is None:
            lines.append(f"  {app:<20} too few samples ({len(series)})")
            continue
        head, tail, visits, per_visit = s
        leak = per_visit > leak_bytes
        slopes[app] = {
            "head": head, "tail": tail, "visits": visits,
            "per_visit": per_visit, "leak": leak,
        }
        verdict = ""
        if leak:
            verdict = f"  <-- LEAK ~{int(per_visit)} B/visit"
            leaks.append(
                f"{app}: ~{int(per_visit)} B lost per visit "
                f"({int(head - tail)} B over {visits})"
            )
        lines.append(
            f"  {app:<20} {int(head):>8} -> {int(tail):>8}  "
            f"({int(per_visit):+6} B/visit){verdict}"
        )
    data["slopes"] = slopes
    data["leaks"] = leaks
    failures = list(data["failures"]) + leaks
    lines.append("")
    if failures:
        lines.append(f"FAIL — {len(failures)} problem(s):")
        for f in failures:
            lines.append(f"  * {f}")
        passed = False
    else:
        lines.append(f"PASS — no crashes, no per-app heap slope over {leak_bytes} B/visit")
        passed = True
    lines.append(f"console log: {console_log}")
    return Report(
        passed=passed,
        summary="\n".join(lines),
        data=data,
        artifacts=[Artifact(path=console_log, mime="text/plain", role="console")],
        exit_code=0 if passed else 1,
    )


class AppChurnScenario:
    name = "app_churn"
    Params = Params
    description = "open/close every app repeatedly; per-app internal-heap slope + crash watch"

    def run(self, ctx: Context, params: Params, progress: Progress) -> Report:
        console_log = str(ctx.workdir / "console.log")
        data: dict[str, Any] = {
            "apps": [], "targets": [], "skipped": [], "rounds": params.rounds,
            "trend": {}, "slopes": {}, "leaks": [], "failures": [],
            "launch_fail": {}, "fatal": [], "reboots": 0, "leak_bytes": params.leak_bytes,
        }

        # Opened deasserted: the old script reset the ESP just by opening the
        # STM VCP, which threw away the state the churn was supposed to test.
        console = ctx.open_console(reset=False)
        link = ctx.open_cdc()
        watch = _ConsoleWatch(console)
        try:
            listing = verbs.app_list(link)
            apps: list[str] = list(listing["apps"])
            running: str | None = listing["running"]
            data["apps"] = apps
            if not apps:
                return Report(
                    passed=False,
                    summary="APP_LIST returned nothing — firmware without HIL control?",
                    data=data, artifacts=[], exit_code=2,
                )
            if running:
                verbs.app_stop(link)
                ctx.cancelled.wait(params.settle)

            skip = set(DEFAULT_SKIP if params.skip is None else params.skip)
            if params.apps:
                wanted = [a for a in params.apps if a]
                unknown = [a for a in wanted if a not in apps]
                if unknown:
                    return Report(
                        passed=False,
                        summary=f"not in the launcher: {', '.join(unknown)}",
                        data=data, artifacts=[], exit_code=2,
                    )
                targets = wanted
                skipped: list[str] = []
            else:
                targets = [a for a in apps if a not in skip]
                skipped = [a for a in apps if a in skip]
            data["targets"] = targets
            data["skipped"] = skipped
            ctx.log(
                f"launcher has {len(apps)} apps; churning {len(targets)}: {', '.join(targets)}"
            )
            if skipped:
                ctx.log(f"skipped: {', '.join(skipped)}")
            ctx.log(f"{params.rounds} rounds, dwell {params.dwell}s")

            # (app -> [int_free after each visit]); failures are collected, not
            # raised, so one broken app does not hide the rest.
            trend: dict[str, list[int]] = {a: [] for a in targets}
            failures: list[str] = []
            launch_fail: dict[str, int] = {a: 0 for a in targets}
            data["trend"] = trend
            data["failures"] = failures
            data["launch_fail"] = launch_fail
            total = params.rounds * len(targets)
            visit = 0

            for rnd in range(1, params.rounds + 1):
                for app in targets:
                    ctx.check_cancelled()
                    visit += 1
                    progress(visit, total, f"round {rnd}/{params.rounds} {app}")
                    try:
                        verbs.app_start(link, app, wait_s=START_WAIT_S)
                    except HilError as e:
                        launch_fail[app] += 1
                        failures.append(
                            f"{app}: APP_START refused ({e.code}: {e.message}) on round {rnd}"
                        )
                        continue
                    ctx.cancelled.wait(params.dwell)
                    verbs.app_stop(link)
                    ctx.cancelled.wait(params.settle)

                    fatal, reboots = watch.poll()
                    if fatal or reboots:
                        data["fatal"].extend(fatal)
                        data["reboots"] += reboots
                        for f in fatal[-5:]:
                            ctx.log(f"   {f}")
                        what = "device fault" if fatal else "device rebooted"
                        failures.append(f"{app}: {what} on round {rnd} — see {console_log}")
                        return _report(data, console_log, params.leak_bytes)

                    trend[app].append(int(verbs.mem(link)["int_free"]))

                # A round that never got the device back to the launcher means
                # the state machine is stuck, and every later measurement is noise.
                running = verbs.app_list(link)["running"]
                heap_now = int(verbs.mem(link)["int_free"])
                stuck = f" STUCK in {running}" if running else ""
                ctx.log(f"round {rnd:3d}/{params.rounds}  int_free={heap_now}{stuck}")
                if running:
                    failures.append(
                        f"round {rnd}: device did not return to the launcher (in {running})"
                    )
                    verbs.app_stop(link)
                    ctx.cancelled.wait(params.settle)

            return _report(data, console_log, params.leak_bytes)
        finally:
            link.close()
            console.close()


SCENARIO = register(AppChurnScenario())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_app_churn.py -q 2>&1 | tail -3 && ruff check crosspad_hil/scenarios/app_churn.py tests/test_scenario_app_churn.py && ruff format --check crosspad_hil/scenarios/app_churn.py tests/test_scenario_app_churn.py`
Expected: `11 passed`, `All checks passed!`

- [ ] **Step 5: Run the three scenario suites together** (registry import order, no cross-test state)

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_smoke.py tests/test_scenario_led_state.py tests/test_scenario_app_churn.py tests/test_scenarios_base.py -q 2>&1 | tail -3`
Expected: all passed (`9 + 5 + 11` from this chunk plus B1's base tests), no failures.

- [ ] **Step 6: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/scenarios/app_churn.py tests/test_scenario_app_churn.py && git commit -m "feat(scenarios): app_churn — per-app int_free slope via MEM, console fatal/reboot watch without resetting the ESP"
```
## Chunk B3 — scenarios `kit_churn` and `usb_mode_cycle`

Both tasks assume plan A tasks 1–12 and plan B tasks 1–5 are on the branch
(`base.py`, `scenarios/__init__.py`, `tests/fakes.py::FakeSerial`, `verbs.py`,
`usbmode.py`, `console.py`, `cdc.py`, `locks.py`). Run every command from
`/home/matixan/GIT/crosspad-hil`. The same `FakeContext` pattern as task 5
(`app_churn`) is used: a `Context` subclass whose `open_console()`/`open_cdc()`
build the real `Console`/`CdcLink` over a `FakeSerial` via `serial_factory`, so
the scenario code exercised in tests is byte-for-byte the code that runs on
hardware — only the port is fake.

---

### Task 6: `scenarios/kit_churn.py` — swap kits while the pads keep firing (port of `hil_kit_churn.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/kit_churn.py`
- Modify: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/__init__.py` (last line — add `kit_churn` to the `from . import …` list)
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_scenario_kit_churn.py`

**Interfaces:**
- Consumes (contract):
  - `Context.open_console(reset=False) -> Console`, `Context.open_cdc() -> CdcLink`, `Context.cancelled: threading.Event`, `Context.check_cancelled()`, `Context.log`
  - `Console.events(since_seq: int = 0) -> list[ConsoleEvent]` (inclusive; kinds used: `"fatal"` `{pattern}`, `"reboot"` `{count}`, `"kit"` `{kit, state}`, `"cdc_drops"` `{dropped}`), `Console.seq` property, `Console.snapshot()["heap"]` (`{slot: free}`, slot 0 = internal SRAM)
  - `CdcLink.send(cmd: str) -> None` (fire-and-forget, write lock only — the `hil_kit_churn.Cdc.send` design) and the typed verbs:
  - `verbs.kit_list(link) -> {"kits": [{id, name}], "current": int}`; `verbs.kit_status(link) -> {current, loading, pending, name}`; `verbs.kit_load(link, kit_id, wait_s=15.0) -> kit_status dict` (raises `HilError(TIMEOUT)` when `current==kit_id and loading is False and pending==-1` is never reached; `HilError(BAD_ARGS)` on `ERR bad kit id`)
  - `verbs.app_list(link) -> {"apps": [...], "running": str|None}`; `verbs.app_destroy(link)`; `verbs.app_start(link, name, wait_s=3.0) -> {"running": name}`
  - `verbs.pad_stats(link, reset=False) -> {press, release, played, freeslots}`; `verbs.smpl_peak(link) -> {peak, free}` (peak is read-and-clear on the device: `marcelSamplePeak().exchange(0)`)
  - `HilError` (`.code`, `.message`, `.to_dict()`), codes `TIMEOUT`, `BAD_ARGS`; `Report`, `Progress`, `register`
  - `tests.fakes.FakeSerial` (`.written`, `.feed(lines)`, `write()` override point)
- Produces:
  - `Params(rounds: int = 20, kits: list[int] | None = None, dwell: float = 2.0, load_timeout: float = 15.0, hit_rate: float = 8.0, pads: list[int] | None = None, rapid: float | None = None, no_play: bool = False, silence_fails: bool = False)` — exactly the contract's field list; `pads is None` → `list(range(16))`, `kits is None` → every kit `KIT_LIST` reports.
  - `class Player(threading.Thread)` — `Player(link: CdcLink, hit_rate: float, pads: list[int])`, `.hits: int`, `.hits_between(t0: float, t1: float) -> int` (monotonic stamps), `.stop()`. Ported from `hil_kit_churn.Player` (one `PAD_PRESS` and one `PAD_RELEASE` per period via `link.send`; velocity `60 + (i * 17) % 67`).
  - `class KitChurnScenario` (`name = "kit_churn"`), `SCENARIO = register(KitChurnScenario())`, `main(argv)` for the platform-idf shim.
  - Module constants (tests monkeypatch them; every value is the old script's literal): `APP_DESTROY_SETTLE_S = 1.0`, `APP_START_SETTLE_S = 2.5`, `MIN_DWELL_S = 0.3`, `SLOW_FRACTION = 0.5`, `MIN_HITS_IN_WINDOW = 2`, `STATUS_TIMEOUT_S = 1.5`, `RAPID_DRAIN_S = 1.5`, `RAPID_QUIET_POLL_S = 0.4`, `RAPID_QUIET_NEEDED = 3`, `RAPID_SOUND_SETTLE_S = 1.5`, `PEAK_WINDOW_S = 1.0`, `RAPID_STATUS_EVERY = 10`.
  - `Report.data` (normal mode): `{"mode": "normal", "kits": [{id,name}], "cycle": [int], "pads": [int], "rounds_requested": int, "rounds": [record…], "hits_sent": int, "hits_per_s": float, "hits_in_windows": int, "starved": [{round, kit, hits}], "silent": [{round, kit}], "slow": [{round, kit, seconds}], "failures": [str], "fatal": [str], "reboots": int, "cdc_drops": int, "pad_stats": dict|None, "false_negative": bool, "silence_fails": bool, "rapid": None}` where each round `record` is `{"round": int, "kit": int, "name": str, "seconds": float, "landed": bool, "hits_in_window": int, "peak": int|None, "free": int|None, "silent": bool, "heap": int|None}`.
  - `Report.data` (rapid mode): same top-level keys with `"mode": "rapid"`, `"rounds": []`, and `"rapid": {"interval_s": float, "requested": [int], "device_logged": [int], "last_logged": int|None, "settled": {current, loading, pending, name}|None, "peak": int|None, "free": int|None, "drops_this_run": int}`.
  - Exit codes: 0 pass; 1 crash / stuck load / wrong settle / silence with `silence_fails` / **false negative** (stimulus on, but every completed round saw fewer than `MIN_HITS_IN_WINDOW` hits inside its swap window); 2 no kits, unknown `--kits` id, Sampler absent, seed kit never loaded.
- Contract ambiguities resolved here:
  1. The stimulus uses `CdcLink.send` (fire-and-forget), **not** `verbs.pad_press` — `verbs.pad_press` waits for an `OK` that, under pad traffic, is never provably its own; the old script's whole point (see its `Cdc` docstring) is that pad writes never block. The device's view of the stimulus is read back once at the end with `verbs.pad_stats` and reported as `pad_stats`.
  2. Kit swaps go through `verbs.kit_load` (which sends `KIT_LOAD` and polls `KIT_STATUS` — the honest answer), so a swap's window is `[t0, return of kit_load]`.
  3. The false-negative guard: `false_negative = player is not None and len(rounds) > 0 and every round has hits_in_window < MIN_HITS_IN_WINDOW`. The old script only *printed* starved rounds; the plan requires a failure, and "every window quiet" is the exact condition under which the run tested nothing.
  4. Console fault baseline is `con.seq + 1` taken after the seed load (events are inclusive of `since_seq`); `fatal`/`reboot` events at or after it are the run's own.
  5. Heap per round is `Console.snapshot()["heap"].get(0)` (internal SRAM from the last PerfMon block) rather than the old script's sum over all three slots, which was dominated by PSRAM and hid internal-RAM loss.
  6. In rapid mode "last request the device logged" = the last `"kit"` console event (state `queued` or `started`) at/after the burst baseline — as in `run_rapid`, the host's own send list is only a fallback when the console logged nothing.

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_scenario_kit_churn.py`:

```python
"""Scenario `kit_churn` against a stateful fake device — no hardware.

The fake models exactly the parts of hil_control.cpp the scenario leans on:
KIT_LIST / KIT_STATUS / KIT_LOAD with the "queued vs started" console line,
PAD_PRESS / PAD_RELEASE answering OK like everything else, SMPL_PEAK that is
read-and-clear and only non-zero when pads were hit, PAD_STATS, APP_LIST.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import pytest

from crosspad_hil.cdc import CdcLink
from crosspad_hil.console import Console
from crosspad_hil.devices import Device, Ports, SerialPortInfo, UsbMode
from crosspad_hil.scenarios import get, kit_churn
from crosspad_hil.scenarios import base
from tests.fakes import FakeSerial

KITS = ["Basic", "Drums", "Perc", "Synth"]
PANIC = "Guru Meditation Error: Core  1 panic'ed (LoadProhibited)."


class KitDevice(FakeSerial):
    """CDC endpoint with the kit loader's state machine.

    A load takes `load_polls` KIT_STATUS polls to finish (so a swap window has
    a measurable length in the test). A KIT_LOAD that arrives mid-load is held
    as `pending` and started when the running one completes — unless
    `drop_pending` models the old bug where it was thrown away. `stuck` never
    finishes a load. `crash_on_kit` feeds a panic line into the console fake
    when that kit is requested. `silent` makes SMPL_PEAK report 0 forever.
    """

    def __init__(self, console: FakeSerial, *, load_polls: int = 2) -> None:
        super().__init__()
        self.console = console
        self.load_polls = load_polls
        self.current = -1
        self.target = -1
        self.pending = -1
        self.loading_left = 0
        self.running: str | None = "Sampler"
        self.apps = ["Sampler", "Mixer"]
        self.presses = 0
        self.releases = 0
        self.presses_since_peak = 0
        self.silent = False
        self.stuck = False
        self.drop_pending = False
        self.crash_on_kit: int | None = None

    def _log(self, text: str) -> None:
        self.console.feed([f"I (4242) hil_control: {text}"])

    def _status(self) -> str:
        if self.loading_left > 0 and not self.stuck:
            self.loading_left -= 1
            if self.loading_left == 0:
                self.current = self.target
                if self.pending != -1 and not self.drop_pending:
                    self.target = self.pending
                    self.loading_left = self.load_polls
                self.pending = -1
        name = KITS[self.current] if self.current >= 0 else "-"
        loading = 1 if self.loading_left > 0 else 0
        return f"KITSTATUS: current={self.current} loading={loading} pending={self.pending} name={name}"

    def write(self, data: bytes) -> int:
        for raw in data.decode("utf-8", "replace").split("\n"):
            cmd = raw.strip()
            if not cmd:
                continue
            self.written.append(cmd)
            if cmd == "APP_LIST":
                self.feed([f"APPS: {','.join(self.apps)} running={self.running or '-'}"])
            elif cmd == "APP_DESTROY":
                self.running = None
                self.feed(["OK"])
            elif cmd.startswith("APP_START "):
                self.running = cmd.split(" ", 1)[1]
                self.feed(["OK"])
            elif cmd == "KIT_LIST":
                body = ",".join(f"{i}:{n}" for i, n in enumerate(KITS))
                self.feed([f"KITS: {body} current={self.current}"])
            elif cmd == "KIT_STATUS":
                self.feed([self._status()])
            elif cmd.startswith("KIT_LOAD "):
                kit = int(cmd.split(" ", 1)[1])
                if kit >= len(KITS):
                    self.feed(["ERR bad kit id"])
                    continue
                if self.crash_on_kit == kit:
                    self.console.feed([PANIC])
                if self.loading_left > 0:
                    self.pending = kit
                    self._log(f"KIT_LOAD {kit} queued")
                else:
                    self.target = kit
                    self.loading_left = self.load_polls
                    self._log(f"KIT_LOAD {kit} started")
                self.feed(["OK"])
            elif cmd.startswith("PAD_PRESS "):
                self.presses += 1
                self.presses_since_peak += 1
                self.feed(["OK"])
            elif cmd.startswith("PAD_RELEASE "):
                self.releases += 1
                self.feed(["OK"])
            elif cmd == "PAD_STATS":
                self.feed([f"PADSTATS: press={self.presses} release={self.releases} "
                           f"played={self.presses} freeslots=7"])
            elif cmd == "SMPL_PEAK":
                peak = 0 if self.silent or self.presses_since_peak == 0 else 12000
                self.presses_since_peak = 0
                self.feed([f"SMPLPEAK: {peak} free=7"])
            else:
                self._rx.append((cmd + "\r\n").encode())
        return len(data)


def make_device() -> Device:
    return Device(
        id="dev_ab12", serial="CP-1", usb_mode=UsbMode.DEFAULT,
        ports=Ports(
            cdc=SerialPortInfo(path="/dev/ttyACM0", vid=0x303A, pid=0x3456,
                               serial="CP-1", product="CrossPad", location="1-2.1"),
            console=SerialPortInfo(path="/dev/ttyACM1", vid=0x0483, pid=0x5740,
                                   serial="STM-1", product="CrossPad", location="1-2.2"),
        ),
    )


@dataclass
class FakeContext(base.Context):
    cdc_fake: KitDevice = None  # type: ignore[assignment]
    console_fake: FakeSerial = None  # type: ignore[assignment]

    def open_console(self, reset: bool = False) -> Console:
        fake = self.console_fake
        con = Console(self.device.ports.console.path,
                      log_path=self.workdir / "console.log",
                      serial_factory=lambda path, **kw: fake)
        con.open(reset=reset)
        self.opened.append(con)
        return con

    def open_cdc(self) -> CdcLink:
        fake = self.cdc_fake
        link = CdcLink(self.device.ports.cdc.path, serial_factory=lambda path, **kw: fake)
        link.open()
        self.opened.append(link)
        return link


def make_ctx(tmp_path: Path, **dev_kw: object) -> tuple[FakeContext, KitDevice]:
    con = FakeSerial()
    dev = KitDevice(con, **dev_kw)  # type: ignore[arg-type]
    ctx = FakeContext(device=make_device(), workdir=tmp_path,
                      cancelled=threading.Event(), log=lambda s: None,
                      cdc_fake=dev, console_fake=con)
    return ctx, dev


@pytest.fixture(autouse=True)
def fast(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapse every human-scale wait the old script carried."""
    monkeypatch.setattr(kit_churn, "APP_DESTROY_SETTLE_S", 0.0)
    monkeypatch.setattr(kit_churn, "APP_START_SETTLE_S", 0.0)
    monkeypatch.setattr(kit_churn, "MIN_DWELL_S", 0.0)
    monkeypatch.setattr(kit_churn, "RAPID_DRAIN_S", 0.0)
    monkeypatch.setattr(kit_churn, "RAPID_QUIET_POLL_S", 0.01)
    monkeypatch.setattr(kit_churn, "RAPID_SOUND_SETTLE_S", 0.0)
    monkeypatch.setattr(kit_churn, "PEAK_WINDOW_S", 0.05)


def run(ctx: FakeContext, **params: object) -> base.Report:
    return kit_churn.SCENARIO.run(ctx, kit_churn.Params(**params), base.Progress())  # type: ignore[arg-type]


def test_registered_and_defaults() -> None:
    assert get("kit_churn") is kit_churn.SCENARIO
    p = kit_churn.Params()
    assert (p.rounds, p.kits, p.dwell, p.load_timeout, p.hit_rate, p.pads,
            p.rapid, p.no_play, p.silence_fails) == (20, None, 2.0, 15.0, 8.0, None, None, False, False)


def test_normal_mode_swaps_under_play_and_counts_hits_in_window(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=2)
    rep = run(ctx, rounds=4, dwell=0.0, hit_rate=50.0, load_timeout=5.0)
    assert rep.passed, rep.summary
    assert rep.exit_code == 0
    d = rep.data
    assert d["mode"] == "normal"
    assert d["cycle"] == [0, 1, 2, 3]
    assert d["pads"] == list(range(16))
    assert len(d["rounds"]) == 4
    # round r loads cycle[r % len(cycle)] — the seed already loaded kit 0
    assert [r["kit"] for r in d["rounds"]] == [1, 2, 3, 0]
    assert all(r["landed"] for r in d["rounds"])
    # each swap window spans two KIT_STATUS polls (~0.8 s) at 50 hits/s
    assert all(r["hits_in_window"] >= kit_churn.MIN_HITS_IN_WINDOW for r in d["rounds"])
    assert d["hits_in_windows"] == sum(r["hits_in_window"] for r in d["rounds"])
    assert d["false_negative"] is False
    assert d["starved"] == []
    assert d["silent"] == []
    assert d["failures"] == []
    assert d["pad_stats"]["press"] == dev.presses
    assert d["hits_sent"] == dev.presses
    assert d["reboots"] == 0 and d["fatal"] == []
    # the device saw the seed plus four swaps, all from an idle loader
    assert dev.written.count("KIT_LOAD 0") == 2
    assert "KIT_LOAD 1" in dev.written and "KIT_LOAD 3" in dev.written


def test_false_negative_guard_fails_when_stimulus_never_fires(tmp_path: Path,
                                                             monkeypatch: pytest.MonkeyPatch) -> None:
    """The stimulus thread is started but never sends: every swap window is
    quiet, and the run must FAIL rather than report a green swap from silence."""
    monkeypatch.setattr(kit_churn.Player, "run", lambda self: None)
    ctx, dev = make_ctx(tmp_path, load_polls=2)
    rep = run(ctx, rounds=3, dwell=0.0, hit_rate=50.0, load_timeout=5.0)
    assert not rep.passed
    assert rep.exit_code == 1
    assert rep.data["false_negative"] is True
    assert [r["hits_in_window"] for r in rep.data["rounds"]] == [0, 0, 0]
    assert len(rep.data["starved"]) == 3
    assert dev.presses == 0
    assert "false negative" in rep.summary


def test_no_play_control_case_skips_the_guard(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=1)
    rep = run(ctx, rounds=2, no_play=True, dwell=0.0, load_timeout=5.0)
    assert rep.passed
    assert rep.data["false_negative"] is False
    assert rep.data["hits_sent"] == 0
    assert rep.data["silent"] == []          # silence is not judged without stimulus
    assert dev.presses == 0
    assert not any(c.startswith("PAD_PRESS") for c in dev.written)


@pytest.mark.parametrize("silence_fails, expect_pass", [(False, True), (True, False)])
def test_silent_kit_is_warn_or_fail(tmp_path: Path, silence_fails: bool, expect_pass: bool) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=2)
    dev.silent = True
    rep = run(ctx, rounds=2, dwell=0.0, hit_rate=50.0, load_timeout=5.0,
              silence_fails=silence_fails)
    assert rep.passed is expect_pass
    assert len(rep.data["silent"]) == 2
    assert all(r["silent"] and r["peak"] == 0 for r in rep.data["rounds"])
    assert rep.data["silence_fails"] is silence_fails


def test_crash_during_swap_fails_with_console_line(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=1)
    dev.crash_on_kit = 2
    rep = run(ctx, rounds=4, dwell=0.0, hit_rate=50.0, load_timeout=5.0)
    assert not rep.passed
    assert rep.exit_code == 1
    assert rep.data["failures"] and "CRASH" in rep.data["failures"][0]
    assert any("Guru Meditation" in line for line in rep.data["fatal"])
    # the run stops at the crash: kits 1 and 2 were requested, 3 never was
    assert len(rep.data["rounds"]) == 2
    assert "KIT_LOAD 3" not in dev.written


def test_stuck_load_fails_as_never_current(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=1)
    rep = run(ctx, rounds=2, dwell=0.0, hit_rate=50.0, load_timeout=5.0)
    assert rep.passed
    dev.stuck = True
    rep = run(ctx, rounds=2, dwell=0.0, hit_rate=50.0, load_timeout=0.6)
    assert rep.exit_code == 2 or not rep.passed
    # a stuck *seed* is an environment error (2); a stuck *swap* is a failure (1)
    if rep.exit_code == 1:
        assert "never became current" in rep.data["failures"][0]


def test_environment_errors_exit_2(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path)
    dev.apps = ["Mixer"]
    dev.running = "Mixer"
    rep = run(ctx, rounds=1)
    assert rep.exit_code == 2 and not rep.passed
    assert "Sampler" in rep.summary

    ctx, dev = make_ctx(tmp_path)
    rep = run(ctx, rounds=1, kits=[0, 9])
    assert rep.exit_code == 2
    assert "9" in rep.summary


def test_sampler_is_started_when_not_running(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=1)
    dev.running = "Mixer"
    rep = run(ctx, rounds=1, no_play=True, dwell=0.0, load_timeout=5.0)
    assert rep.passed
    assert "APP_DESTROY" in dev.written
    assert "APP_START Sampler" in dev.written
    assert dev.running == "Sampler"


def test_rapid_mode_settles_on_last_logged_kit(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=1)
    rep = run(ctx, rounds=6, rapid=0.02, hit_rate=50.0, dwell=0.0, load_timeout=1.0)
    assert rep.passed, rep.summary
    d = rep.data
    assert d["mode"] == "rapid"
    assert d["rounds"] == []
    r = d["rapid"]
    assert r["interval_s"] == 0.02
    # round n asks for cycle[n % 4]: 1,2,3,0,1,2
    assert r["requested"] == [1, 2, 3, 0, 1, 2]
    assert r["device_logged"] == [1, 2, 3, 0, 1, 2]
    assert r["last_logged"] == 2
    assert r["settled"]["current"] == 2
    assert r["settled"]["loading"] is False and r["settled"]["pending"] == -1
    assert r["peak"] == 12000
    # first request met an idle loader, the other five were queued
    assert dev.written.count("KIT_LOAD 1") == 2


def test_rapid_mode_fails_when_pending_request_is_dropped(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=1)
    dev.drop_pending = True
    rep = run(ctx, rounds=5, rapid=0.02, hit_rate=50.0, dwell=0.0, load_timeout=1.0)
    assert not rep.passed
    assert rep.exit_code == 1
    r = rep.data["rapid"]
    assert r["last_logged"] == 1          # requested 1,2,3,0,1 → last logged is 1
    assert r["settled"]["current"] == 1   # …but only because the first one landed
    # the coalescing check is on the *sequence*: the device logged 2,3,0 and
    # never loaded them; the failure text names the mismatch when it exists
    assert rep.data["failures"]


def test_rapid_mode_without_stimulus_does_not_judge_silence(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=1)
    rep = run(ctx, rounds=3, rapid=0.02, no_play=True, load_timeout=1.0)
    assert rep.passed
    assert rep.data["rapid"]["peak"] == 0
    assert rep.data["hits_sent"] == 0


def test_cancel_stops_the_run_and_the_player(tmp_path: Path) -> None:
    ctx, dev = make_ctx(tmp_path, load_polls=2)
    ctx.cancelled.set()
    from crosspad_hil.errors import CANCELLED, HilError
    with pytest.raises(HilError) as ei:
        run(ctx, rounds=5, dwell=0.0, hit_rate=50.0, load_timeout=5.0)
    assert ei.value.code == CANCELLED
    # every thread the scenario started is gone
    assert not any(t.name.startswith("kit_churn_player") for t in threading.enumerate())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_kit_churn.py -q 2>&1 | tail -3`
Expected: `ImportError: cannot import name 'kit_churn' from 'crosspad_hil.scenarios'`

- [ ] **Step 3: Write the implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/kit_churn.py`:

```python
"""Keep playing while the kit is swapped underneath — the live-set test.

Port of ``platform-idf/tools/hil_kit_churn.py``. A pad stimulus runs from its
own thread and never stops for the kit change; the swap loop asks the loader's
own state (``KIT_STATUS``) whether a swap landed, because ``PAD_PRESS`` answers
``OK`` exactly like ``KIT_LOAD`` does and an ``OK`` off the wire proves nothing.

Two modes. Normal waits for every swap to land and measures how long it took
under load. ``rapid`` fires requests faster than a load can finish — the
coalescing path — and asserts the burst settles on the last kit the *device*
logged receiving, then that the kit still sounds.

The stimulus-in-window rule: a run where no pad hit landed inside any swap
window has not tested the thing this scenario exists for, however many rounds
it survived. That is reported as ``false_negative`` and is a FAIL.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any

from crosspad_hil import verbs
from crosspad_hil.cdc import CdcLink
from crosspad_hil.console import Console
from crosspad_hil.errors import TIMEOUT, HilError
from crosspad_hil.scenarios.base import Context, Progress, Report, register

# --- timing constants, every one the old script's literal ---------------------
APP_DESTROY_SETTLE_S = 1.0     # hil_kit_churn.main: time.sleep(1.0) after APP_DESTROY
APP_START_SETTLE_S = 2.5       # time.sleep(2.5) after APP_START Sampler
MIN_DWELL_S = 0.3              # time.sleep(max(0.3, args.dwell))
SLOW_FRACTION = 0.5            # elapsed > load_timeout * 0.5 → "slow"
MIN_HITS_IN_WINDOW = 2         # `if player and during < 2: starved.append(...)`
STATUS_TIMEOUT_S = 1.5         # cdc.request("KIT_STATUS", "KITSTATUS:", 1.5)
RAPID_DRAIN_S = 1.5            # run_rapid: time.sleep(1.5) before believing KIT_STATUS
RAPID_QUIET_POLL_S = 0.4       # run_rapid: time.sleep(0.4) between quiet polls
RAPID_QUIET_NEEDED = 3         # three quiescent samples in a row
RAPID_SOUND_SETTLE_S = 1.5     # "Let the new kit actually sound"
PEAK_WINDOW_S = 1.0            # run_rapid: SMPL_PEAK clear, sleep(1.0), SMPL_PEAK read
RAPID_STATUS_EVERY = 10        # `if rnd % 10 == 0:` progress poll during the burst
PAD_COUNT = 16
SAMPLER_APP = "Sampler"


@dataclass
class Params:
    rounds: int = field(default=20, metadata={"help": "kit swaps to perform"})
    kits: list[int] | None = field(
        default=None, metadata={"help": "kit ids to cycle (comma-separated); default every kit"})
    dwell: float = field(default=2.0, metadata={"help": "seconds of playing between swaps"})
    load_timeout: float = field(
        default=15.0, metadata={"help": "seconds a single kit load may take"})
    hit_rate: float = field(default=8.0, metadata={"help": "pad hits per second"})
    pads: list[int] | None = field(
        default=None, metadata={"help": "pads to cycle (comma-separated); default 0-15"})
    rapid: float | None = field(
        default=None,
        metadata={"help": "seconds between kit requests fired without waiting for the "
                          "previous load (e.g. 0.4); unset = one-at-a-time mode"})
    no_play: bool = field(default=False, metadata={"help": "swap from silence (control case)"})
    silence_fails: bool = field(
        default=False, metadata={"help": "treat a kit that renders nothing as a failure"})


class Player(threading.Thread):
    """Fingerdrumming that never stops, least of all during the swap.

    From hil_kit_churn.Player: round-robins the pads so several voices stream
    off the card at once, varies velocity so the engine takes a different path
    per hit, and stamps every hit so the run can count how many landed inside
    each swap window instead of assuming they did. Writes are fire-and-forget
    through ``CdcLink.send`` — a blocking pad write would starve the stimulus
    exactly across the seconds that matter.
    """

    def __init__(self, link: CdcLink, hit_rate: float, pads: list[int]) -> None:
        super().__init__(name="kit_churn_player", daemon=True)
        self._link = link
        self._period = 1.0 / max(1.0, hit_rate)
        self._pads = list(pads)
        self.hits = 0
        self._stamps: list[float] = []
        self._lock = threading.Lock()
        self._halt = threading.Event()

    def run(self) -> None:
        i = 0
        while not self._halt.is_set():
            pad = self._pads[i % len(self._pads)]
            i += 1
            vel = 60 + (i * 17) % 67                       # hil_kit_churn.Player.run
            self._link.send(f"PAD_PRESS {pad} {vel}")
            with self._lock:
                self.hits += 1
                self._stamps.append(time.monotonic())
            if self._halt.wait(self._period * 0.5):
                break
            self._link.send(f"PAD_RELEASE {pad}")
            if self._halt.wait(self._period * 0.5):
                break

    def hits_between(self, t0: float, t1: float) -> int:
        with self._lock:
            return sum(1 for t in self._stamps if t0 <= t <= t1)

    def stop(self) -> None:
        self._halt.set()


def _faults(con: Console, since_seq: int) -> tuple[list[str], int]:
    """(new fatal lines, reboot count) at or after ``since_seq``."""
    fatal: list[str] = []
    reboots = 0
    for ev in con.events(since_seq=since_seq):
        if ev.kind == "fatal":
            fatal.append(ev.line)
        elif ev.kind == "reboot":
            reboots += 1
    return fatal, reboots


def _kits_logged(con: Console, since_seq: int) -> list[int]:
    """Kit ids the firmware logged receiving (``hil_control: KIT_LOAD n queued|started``)."""
    return [int(ev.data["kit"]) for ev in con.events(since_seq=since_seq) if ev.kind == "kit"]


def _cdc_drops(con: Console) -> int:
    return int(con.snapshot().get("cdc_drops", 0) or 0)


def _heap_internal(con: Console) -> int | None:
    heap = con.snapshot().get("heap") or {}
    value = heap.get(0)
    return int(value) if value is not None else None


def _env(summary: str, data: dict[str, Any]) -> Report:
    return Report(passed=False, summary=summary, data=data, artifacts=[], exit_code=2)


def _wait(ctx: Context, seconds: float) -> None:
    """Sleep that returns early on cancel and then raises CANCELLED."""
    if seconds > 0:
        ctx.cancelled.wait(seconds)
    ctx.check_cancelled()


class KitChurnScenario:
    name = "kit_churn"
    Params = Params
    description = "swap kits while the pads keep firing; --rapid spins the selector"

    def run(self, ctx: Context, params: Params, progress: Progress) -> Report:
        p = params
        pads = list(p.pads) if p.pads else list(range(PAD_COUNT))
        data: dict[str, Any] = {
            "mode": "rapid" if p.rapid else "normal",
            "kits": [], "cycle": [], "pads": pads,
            "rounds_requested": p.rounds, "rounds": [],
            "hits_sent": 0, "hits_per_s": 0.0, "hits_in_windows": 0,
            "starved": [], "silent": [], "slow": [], "failures": [],
            "fatal": [], "reboots": 0, "cdc_drops": 0, "pad_stats": None,
            "false_negative": False, "silence_fails": p.silence_fails, "rapid": None,
        }
        ctx.check_cancelled()
        con = ctx.open_console(reset=False)
        link = ctx.open_cdc()

        # --- what is on the card ----------------------------------------------
        try:
            kl = verbs.kit_list(link)
        except HilError as e:
            return _env(f"kit_churn: KIT_LIST failed ({e.code}: {e.message}) — "
                        "no kit manager, or no SD card", data)
        kits = [{"id": int(k["id"]), "name": str(k["name"])} for k in kl.get("kits", [])]
        if not kits:
            return _env("kit_churn: KIT_LIST returned nothing — no kit manager, or no SD card",
                        data)
        names = {k["id"]: k["name"] for k in kits}
        data["kits"] = kits
        if p.kits:
            unknown = [k for k in p.kits if k not in names]
            if unknown:
                return _env(f"kit_churn: no such kit id: {unknown}", data)
            cycle = list(p.kits)
        else:
            cycle = [k["id"] for k in kits]
        data["cycle"] = cycle
        ctx.log(f"{len(kits)} kits on the card; cycling {len(cycle)}: "
                + ", ".join(names[k] for k in cycle))

        # --- the Sampler has to own pad logic for a hit to reach the engine ---
        apps = verbs.app_list(link)
        if SAMPLER_APP not in apps.get("apps", []):
            return _env("kit_churn: Sampler is not in the launcher — nothing to churn", data)
        if apps.get("running") != SAMPLER_APP:
            try:
                verbs.app_destroy(link)
            except HilError as e:
                ctx.log(f"APP_DESTROY: {e.code}: {e.message} (nothing running?)")
            _wait(ctx, APP_DESTROY_SETTLE_S)
            verbs.app_start(link, SAMPLER_APP)
            _wait(ctx, APP_START_SETTLE_S)

        # --- seed with the first kit from silence, so round 1 is a swap like the rest
        ctx.log(f"seeding with {names[cycle[0]]} ...")
        try:
            verbs.kit_load(link, cycle[0], wait_s=p.load_timeout)
        except HilError as e:
            if e.code != TIMEOUT:
                raise
            return _env("kit_churn: seed kit never finished loading — "
                        "SD card or sampler state is bad", data)

        player: Player | None = None
        if not p.no_play:
            player = Player(link, p.hit_rate, pads)
            player.start()
            ctx.log(f"playing {p.hit_rate:.0f} hits/s across pads {pads[0]}..{pads[-1]} "
                    "— this does not stop for the swap")

        # events at/after this seq are the run's own (Console.events is inclusive)
        seq0 = con.seq + 1
        drops0 = _cdc_drops(con)
        t_play0 = time.monotonic()
        try:
            if p.rapid:
                self._run_rapid(ctx, p, link, con, player, cycle, names, seq0, drops0, data,
                                progress)
            else:
                self._run_normal(ctx, p, link, con, player, cycle, names, seq0, data, progress)
        finally:
            if player is not None:
                player.stop()
                player.join(timeout=2.0)
                data["hits_sent"] = player.hits
                span = max(0.001, time.monotonic() - t_play0)
                data["hits_per_s"] = round(player.hits / span, 2)

        fatal, reboots = _faults(con, seq0)
        data["fatal"] = fatal
        data["reboots"] = reboots
        data["cdc_drops"] = max(0, _cdc_drops(con) - drops0)
        try:
            data["pad_stats"] = verbs.pad_stats(link)
        except HilError as e:
            ctx.log(f"PAD_STATS: {e.code}: {e.message}")

        return self._verdict(p, player is not None, data)

    # --- normal mode ---------------------------------------------------------
    def _run_normal(self, ctx: Context, p: Params, link: CdcLink, con: Console,
                    player: Player | None, cycle: list[int], names: dict[int, str],
                    seq0: int, data: dict[str, Any], progress: Progress) -> None:
        for rnd in range(1, p.rounds + 1):
            ctx.check_cancelled()
            target = cycle[rnd % len(cycle)]
            t0 = time.monotonic()
            landed = True
            load_err: HilError | None = None
            try:
                # KIT_LOAD + KIT_STATUS polling: the id flips when changeKit()
                # succeeds, loading=0 once the pads are reassigned, pending=-1
                # when nothing is queued behind it. All three, or it did not land.
                verbs.kit_load(link, target, wait_s=p.load_timeout)
            except HilError as e:
                landed = False
                load_err = e
            t1 = time.monotonic()
            elapsed = t1 - t0
            during = player.hits_between(t0, t1) if player is not None else 0

            record: dict[str, Any] = {
                "round": rnd, "kit": target, "name": names[target],
                "seconds": round(elapsed, 3), "landed": landed,
                "hits_in_window": during, "peak": None, "free": None,
                "silent": False, "heap": _heap_internal(con),
            }
            data["rounds"].append(record)

            fatal, reboots = _faults(con, seq0)
            if fatal or reboots:
                lines = fatal[:6] or ["(reset with no panic line)"]
                data["failures"].append(
                    f"round {rnd}: CRASH swapping to {names[target]} after {elapsed:.1f}s\n    "
                    + "\n    ".join(lines))
                break
            if not landed:
                detail = f" ({load_err.code}: {load_err.message})" if load_err else ""
                data["failures"].append(
                    f"round {rnd}: kit {names[target]} never became current "
                    f"({p.load_timeout:.0f}s) — load stuck or dropped{detail}")
                break
            if elapsed > p.load_timeout * SLOW_FRACTION:
                data["slow"].append({"round": rnd, "kit": target, "seconds": round(elapsed, 2)})

            # SMPL_PEAK is read-and-clear: clear, let the new kit play, read.
            verbs.smpl_peak(link)
            _wait(ctx, max(MIN_DWELL_S, p.dwell))
            pk = verbs.smpl_peak(link)
            record["peak"] = pk.get("peak")
            record["free"] = pk.get("free")
            if player is not None and pk.get("peak") == 0:
                record["silent"] = True
                data["silent"].append({"round": rnd, "kit": target})
            if player is not None and during < MIN_HITS_IN_WINDOW:
                data["starved"].append({"round": rnd, "kit": target, "hits": during})

            ctx.log(f"  [{rnd:>3}/{p.rounds}] {names[target]:<16} {elapsed:5.1f}s  "
                    f"hits={during:<3} peak={record['peak']} free={record['free']}"
                    f"{'  <- SILENT' if record['silent'] else ''}  heap={record['heap']}")
            progress(rnd, p.rounds,
                     f"round {rnd}/{p.rounds} kit={target} hits_in_window={during}")

    # --- rapid mode ----------------------------------------------------------
    def _run_rapid(self, ctx: Context, p: Params, link: CdcLink, con: Console,
                   player: Player | None, cycle: list[int], names: dict[int, str],
                   seq0: int, drops0: int, data: dict[str, Any], progress: Progress) -> None:
        interval = float(p.rapid or 0.0)
        rapid: dict[str, Any] = {
            "interval_s": interval, "requested": [], "device_logged": [],
            "last_logged": None, "settled": None, "peak": None, "free": None,
            "drops_this_run": 0,
        }
        data["rapid"] = rapid
        ctx.log(f"rapid mode: a kit request every {interval:.2f}s for {p.rounds} requests, "
                "without waiting for any of them")

        for rnd in range(1, p.rounds + 1):
            ctx.check_cancelled()
            target = cycle[rnd % len(cycle)]
            # Fire and forget: the point is to meet a busy loader, and an OK
            # here would not be this command's anyway.
            link.send(f"KIT_LOAD {target}")
            rapid["requested"].append(target)
            fatal, reboots = _faults(con, seq0)
            if fatal or reboots:
                data["failures"].append(
                    "crash during the burst:\n    "
                    + "\n    ".join(fatal[:6] or ["(reset with no panic line)"]))
                return
            if rnd % RAPID_STATUS_EVERY == 0:
                st = verbs.kit_status(link)
                ctx.log(f"  [{rnd:>3}/{p.rounds}] asked {names[target]:<16} "
                        f"current={st['current']} loading={st['loading']} "
                        f"pending={st['pending']}")
            progress(rnd, p.rounds, f"request {rnd}/{p.rounds} kit={target}")
            _wait(ctx, interval)

        ctx.log(f"burst done; host sent {len(rapid['requested'])}. "
                "waiting for the loader to drain ...")
        # A request travels CDC -> lv_async_call -> the LVGL thread; give that
        # queue time to drain before believing KIT_STATUS, or the first poll
        # catches the gap between one load finishing and the next being picked
        # up — which reads as "settled", one or two kits early.
        _wait(ctx, RAPID_DRAIN_S)

        # Require the quiet to hold: RAPID_QUIET_NEEDED quiescent samples in a row.
        deadline = time.monotonic() + p.load_timeout * 2
        settled: dict[str, Any] | None = None
        quiet = 0
        while time.monotonic() < deadline:
            settled = verbs.kit_status(link)
            quiet = quiet + 1 if (settled["loading"] is False and settled["pending"] == -1) else 0
            if quiet >= RAPID_QUIET_NEEDED:
                break
            _wait(ctx, RAPID_QUIET_POLL_S)
        rapid["settled"] = settled

        # Let the new kit actually sound before asking whether it does.
        _wait(ctx, RAPID_SOUND_SETTLE_S)
        verbs.smpl_peak(link)
        _wait(ctx, PEAK_WINDOW_S)
        pk = verbs.smpl_peak(link)
        rapid["peak"] = pk.get("peak")
        rapid["free"] = pk.get("free")

        # Now the console has caught up: judge the device on the requests it
        # logged receiving, not on the ones the host sent.
        logged = _kits_logged(con, seq0)
        rapid["device_logged"] = logged
        last = logged[-1] if logged else (rapid["requested"][-1] if rapid["requested"] else None)
        rapid["last_logged"] = last
        rapid["drops_this_run"] = max(0, _cdc_drops(con) - drops0)
        ctx.log(f"requests: host sent {len(rapid['requested'])}, device logged {len(logged)}; "
                f"last it saw was {names.get(last)} ({last})")
        ctx.log(f"CDC commands dropped in transit: {rapid['drops_this_run']} this run")

        fatal, reboots = _faults(con, seq0)
        cur = settled["current"] if settled else None
        if fatal or reboots:
            data["failures"].append("crash during or after the burst")
        elif settled is None or settled["loading"] is not False or settled["pending"] != -1:
            data["failures"].append("the loader never drained; a request is stuck")
        elif cur != last:
            # Coalescing keeps the newest request, so the burst must settle on
            # the last one the device received.
            data["failures"].append(
                f"settled on {names.get(cur)} ({cur}) but {names.get(last)} ({last}) "
                "was the last request the device logged")
        elif logged and any(k != cur for k in logged[logged.index(cur) + 1:] if cur in logged):
            data["failures"].append(
                f"device logged {logged} but only {names.get(cur)} ({cur}) was ever loaded")
        elif player is not None and rapid["peak"] == 0:
            data["failures"].append("silent after the burst: pads accepted, nothing rendered")

    # --- verdict -------------------------------------------------------------
    def _verdict(self, p: Params, stimulus: bool, data: dict[str, Any]) -> Report:
        rounds: list[dict[str, Any]] = data["rounds"]
        data["hits_in_windows"] = sum(int(r["hits_in_window"]) for r in rounds)
        if data["mode"] == "normal":
            data["false_negative"] = bool(
                stimulus and rounds
                and all(int(r["hits_in_window"]) < MIN_HITS_IN_WINDOW for r in rounds))
        failures: list[str] = data["failures"]
        problems: list[str] = list(failures)
        if data["false_negative"]:
            problems.append(
                f"false negative: {len(rounds)} rounds and not one swap window saw "
                f">= {MIN_HITS_IN_WINDOW} pad hits — the swap was never tested under play")
        if data["silent"] and p.silence_fails:
            problems.append("kits that rendered nothing: "
                            + ", ".join(f"{s['kit']} (round {s['round']})" for s in data["silent"]))
        if problems:
            return Report(passed=False, summary="kit_churn: FAIL — " + "; ".join(problems),
                          data=data, artifacts=[], exit_code=1)
        note = ""
        if data["silent"]:
            note = f" (WARN: {len(data['silent'])} silent round(s))"
        if data["mode"] == "rapid":
            summary = "kit_churn: PASS — the burst coalesced onto the last kit and it plays" + note
        else:
            summary = (f"kit_churn: PASS — {len(rounds)} swaps under continuous play, "
                       f"{data['hits_in_windows']} hits inside swap windows, no crash" + note)
        return Report(passed=True, summary=summary, data=data, artifacts=[], exit_code=0)


SCENARIO = register(KitChurnScenario())


def main(argv: list[str] | None = None) -> int:
    """Entry point for the platform-idf shim `tools/hil_kit_churn.py`."""
    import sys

    from crosspad_hil.cli import main as cli_main

    args = list(sys.argv[1:] if argv is None else argv)
    return cli_main(["run", "kit_churn", *args])
```

Then append `kit_churn` to the import at the very end of
`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/__init__.py`, so the
last line reads:

```python
from . import smoke, led_state, app_churn, kit_churn  # noqa: E402,F401  (registers on import)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_kit_churn.py -q 2>&1 | tail -3 && ruff check crosspad_hil/scenarios/kit_churn.py tests/test_scenario_kit_churn.py`
Expected: `14 passed` (about 15 s wall clock — the swap windows are real `KIT_STATUS` poll intervals), ruff `All checks passed!`

If `test_rapid_mode_fails_when_pending_request_is_dropped` passes the verdict
instead of failing it, the `elif logged and any(...)` branch is the one that
catches it: with `drop_pending` the device logged `[1, 2, 3, 0, 1]` and settled
on 1, so `cur == last` holds by coincidence of the cycle wrapping — the extra
branch fails the run because kits logged *after the first occurrence of the
settled kit* were never loaded. Keep that branch.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/scenarios/kit_churn.py crosspad_hil/scenarios/__init__.py tests/test_scenario_kit_churn.py && git commit -m "feat(scenarios): kit_churn — swaps under continuous pad play, rapid coalescing, hits-in-window guard"
```

---

### Task 7: `scenarios/usb_mode_cycle.py` — flip the USB profile back and forth (port of `hil_usb_mode_cycle.py`)

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/usb_mode_cycle.py`
- Modify: `/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/__init__.py` (last line — add `usb_mode_cycle` to the `from . import …` list)
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_scenario_usb_mode_cycle.py`

**Interfaces:**
- Consumes (contract):
  - `usbmode.set_mode(device, mode, *, wait=True, timeout_s=20.0, discover_fn=discover, midi_factory=MidiIO, sleep=time.sleep) -> Device` (raises `HilError(TIMEOUT)` when the device does not re-enumerate; `HilError(NOT_SUPPORTED)` when `device.ports.esp_midi is None`)
  - `UsbMode.DEFAULT / UsbMode.AUDIO`, `Device` (`.id`, `.usb_mode`, `.ports.cdc`, `.ports.uac2`, `.ports.esp_midi`, `.to_dict()`)
  - `Context.open_console(reset=False) -> Console`, `Context.device`, `Context.cancelled`, `Context.check_cancelled()`, `Context.log`
  - `Console.events(since_seq)` (kinds `"fatal"`, `"reboot"`, `"heap"` `{slot, free}`), `Console.seq`, `Console.snapshot()["heap"]`
  - `locks.PortLock(port, purpose, lock_dir=None)` as a context manager (spec §Appendix B: *takes the device's CDC lock for the whole run* — nobody else may open the CDC while its endpoint comes and goes)
  - `HilError` (`.code`, `.message`, `.to_dict()`), codes `TIMEOUT`, `ENV`; `Report`, `Progress`, `register`
- Produces:
  - `Params(rounds: int = 5, dwell: float = 2.0, enum_timeout: float = 15.0)` — the contract's fields (the old script's defaults were 20 / 2.0 / 12.0; the contract wins).
  - Module attributes tests inject: `set_mode = crosspad_hil.usbmode.set_mode` (module-level name, monkeypatched in tests), `LOCK_DIR: Path | None = None` (passed to `PortLock`), `LEAK_BYTES_PER_ROUND = 2048` (`if drift / rounds > 2048`), `WARMUP_ROUNDS = 1` (the `heaps[1]` baseline: *the first switch allocates the UAC2 buffers every later round reuses*), `LOCK_PURPOSE = "usb_mode_cycle"`.
  - `heap_drift(heaps: list[int]) -> tuple[int, int, float] | None` — `(base, last, per_round)` with the old rule `base = heaps[1] if len(heaps) > 1 else heaps[0]`, `per_round = (base - last) / max(1, len(heaps) - 1)`; `None` when `heaps` is empty.
  - `class UsbModeCycleScenario` (`name = "usb_mode_cycle"`), `SCENARIO = register(UsbModeCycleScenario())`, `main(argv)`.
  - `Report.data`: `{"rounds_requested": int, "rounds": [{"round": int, "to_audio_s": float, "to_default_s": float, "heap": int|None, "fatal": [str], "reboots": int}], "heap_start": int|None, "heaps": [int], "drift": {"base": int, "last": int, "per_round": float}|None, "leak": bool, "failures": [str], "fatal": [str], "reboots": int, "restored": bool, "final_mode": str}`.
  - Exit codes: 0 pass; 1 a round failed (switch ignored / never re-enumerated / fatal / reboot / heap leak); 2 device not in `default` mode at start, no ESP MIDI port (`set_mode` → `NOT_SUPPORTED`), CDC lock busy.
- Contract ambiguities resolved here:
  1. **Both directions use `set_mode` over the ESP MIDI port** (SysEx `0x1B`), as the task brief says — the old script sent `USB_AUDIO` over CDC for the first leg because it had no MIDI library; the firmware handles both and `set_mode` already waits for enumeration with the fresh `Device` returned. The scenario therefore never opens the CDC at all; it only holds the CDC port's `PortLock` so another session cannot grab an endpoint that is about to vanish.
  2. Heap samples come from console `"heap"` events, slot 0 (internal SRAM), one sample per round = the latest value the PerfMon block reported by the end of that round (`None` when no block was printed yet — PerfMon runs every ~10 s, so with a short dwell several rounds share one sample; the drift rule only counts rounds that had a sample).
  3. Fatal detection per round is the console event kinds `fatal`/`reboot` at/after the run baseline `con.seq + 1`; a round with either is a failure and the loop stops, as in the old script.
  4. `finally` restores `DEFAULT` when the last `Device` the scenario holds is not in `DEFAULT` mode (`set_mode(..., wait=True)` with `enum_timeout`); a failure to restore is recorded as `restored: False` and appended to `failures` (the old script printed the manual SysEx recovery hint — it is now the `HilError.hint`).
  5. Cancellation: `dwell` waits go through `ctx.cancelled.wait`; a cancel is honoured between legs, and the `finally` restore still runs.

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_scenario_usb_mode_cycle.py`:

```python
"""Scenario `usb_mode_cycle` with an injected `set_mode` and a console fake."""
from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from crosspad_hil.console import Console
from crosspad_hil.devices import AudioCardInfo, Device, MidiPortInfo, Ports, SerialPortInfo, UsbMode
from crosspad_hil.errors import CANCELLED, TIMEOUT, HilError
from crosspad_hil.scenarios import base, get, usb_mode_cycle
from tests.fakes import FakeSerial

CDC = SerialPortInfo(path="/dev/ttyACM0", vid=0x303A, pid=0x3456,
                     serial="CP-1", product="CrossPad", location="1-2.1")
CONSOLE = SerialPortInfo(path="/dev/ttyACM1", vid=0x0483, pid=0x5740,
                         serial="STM-1", product="CrossPad", location="1-2.2")
ESP_MIDI = MidiPortInfo(name="Crosspad MIDI 1", rtmidi_out=2, rtmidi_in=2,
                        alsa_hw="hw:4,0,0", rawmidi="/dev/snd/midiC4D0")
UAC2 = AudioCardInfo(name="Crosspad Audio", sounddevice_index=5, alsa_id="hw:5")


def heap_block(free_internal: int) -> list[str]:
    # the PerfMon block as the STM VCP shows it (parsers test HEAP_BLOCK)
    return [
        "I (10000) PerfMon: === Heap Statistics ===",
        "I (10000) PerfMon: Internal SRAM:",
        f"I (10001) PerfMon:   Free:                {free_internal} bytes",
        "I (10002) PerfMon: DMA-capable:",
        "I (10002) PerfMon:   Free:                70000 bytes",
        "I (10003) PerfMon: PSRAM:",
        "I (10003) PerfMon:   Free:              8123456 bytes",
        "I (10010) PerfMon:   Total tasks: 23",
    ]


def device_in(mode: UsbMode) -> Device:
    if mode == UsbMode.AUDIO:
        ports = Ports(cdc=None, console=CONSOLE, esp_midi=ESP_MIDI, uac2=UAC2)
    else:
        ports = Ports(cdc=CDC, console=CONSOLE, esp_midi=ESP_MIDI, uac2=None)
    return Device(id="dev_ab12", serial="CP-1", usb_mode=mode, ports=ports)


class FakeSetMode:
    """Stands in for usbmode.set_mode: records every call, flips the Device,
    and can fail a given call with TIMEOUT or feed console lines per switch."""

    def __init__(self, console: FakeSerial) -> None:
        self.console = console
        self.calls: list[tuple[str, str, bool, float]] = []
        self.fail_call: int | None = None
        self.heap_per_switch: list[int] = []
        self.lines_on_switch: dict[int, list[str]] = {}
        self.mode = UsbMode.DEFAULT

    def __call__(self, device: Device, mode: UsbMode, *, wait: bool = True,
                 timeout_s: float = 20.0, **kw: Any) -> Device:
        n = len(self.calls)
        self.calls.append((device.id, mode.value, wait, timeout_s))
        if self.fail_call == n:
            raise HilError(TIMEOUT, f"{device.id} did not re-enumerate in {mode.value} mode",
                           hint="power-cycle, or send F0 7D 1B 01 F7 by hand")
        self.mode = mode
        if n < len(self.heap_per_switch):
            self.console.feed(heap_block(self.heap_per_switch[n]))
        self.console.feed(self.lines_on_switch.get(n, []))
        return device_in(mode)


@dataclass
class FakeContext(base.Context):
    console_fake: FakeSerial = None  # type: ignore[assignment]

    def open_console(self, reset: bool = False) -> Console:
        fake = self.console_fake
        con = Console(self.device.ports.console.path,
                      log_path=self.workdir / "console.log",
                      serial_factory=lambda path, **kw: fake)
        con.open(reset=reset)
        self.opened.append(con)
        return con


def make_ctx(tmp_path: Path, start_mode: UsbMode = UsbMode.DEFAULT,
             heap0: int | None = 80_000) -> tuple[FakeContext, FakeSetMode]:
    con = FakeSerial()
    if heap0 is not None:
        con.feed(heap_block(heap0))
    ctx = FakeContext(device=device_in(start_mode), workdir=tmp_path,
                      cancelled=threading.Event(), log=lambda s: None, console_fake=con)
    return ctx, FakeSetMode(con)


@pytest.fixture(autouse=True)
def isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(usb_mode_cycle, "LOCK_DIR", tmp_path / "locks")


def run(ctx: FakeContext, sm: FakeSetMode, monkeypatch: pytest.MonkeyPatch,
        **params: object) -> base.Report:
    monkeypatch.setattr(usb_mode_cycle, "set_mode", sm)
    return usb_mode_cycle.SCENARIO.run(ctx, usb_mode_cycle.Params(**params), base.Progress())  # type: ignore[arg-type]


def test_registered_and_defaults() -> None:
    assert get("usb_mode_cycle") is usb_mode_cycle.SCENARIO
    p = usb_mode_cycle.Params()
    assert (p.rounds, p.dwell, p.enum_timeout) == (5, 2.0, 15.0)


def test_heap_drift_rule() -> None:
    assert usb_mode_cycle.heap_drift([]) is None
    assert usb_mode_cycle.heap_drift([100]) == (100, 100, 0.0)
    # base is the second sample (warm-up), per round over len-1 rounds
    base_, last, per_round = usb_mode_cycle.heap_drift([100, 90, 80, 70])
    assert (base_, last) == (90, 70)
    assert per_round == pytest.approx(20 / 3)


def test_three_clean_rounds(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, sm = make_ctx(tmp_path)
    sm.heap_per_switch = [79_000, 79_000, 79_000, 79_000, 79_000, 79_000]
    rep = run(ctx, sm, monkeypatch, rounds=3, dwell=0.0, enum_timeout=7.0)
    assert rep.passed, rep.summary
    assert rep.exit_code == 0
    modes = [c[1] for c in sm.calls]
    assert modes == ["audio", "default"] * 3
    assert all(c[2] is True and c[3] == 7.0 for c in sm.calls)
    d = rep.data
    assert len(d["rounds"]) == 3
    assert d["heap_start"] == 80_000
    assert d["heaps"] == [79_000, 79_000, 79_000]
    assert d["drift"] == {"base": 79_000, "last": 79_000, "per_round": 0.0}
    assert d["leak"] is False
    assert d["failures"] == []
    assert d["restored"] is True and d["final_mode"] == "default"
    # a console log is an artifact of every run
    assert any(a.role == "console" for a in rep.artifacts)
    assert (tmp_path / "console.log").exists()


def test_heap_leak_per_round_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, sm = make_ctx(tmp_path)
    # after warm-up the heap falls 5 kB every cycle
    sm.heap_per_switch = [78_000, 78_000, 73_000, 73_000, 68_000, 68_000, 63_000, 63_000]
    rep = run(ctx, sm, monkeypatch, rounds=4, dwell=0.0)
    assert not rep.passed
    assert rep.exit_code == 1
    assert rep.data["heaps"] == [78_000, 73_000, 68_000, 63_000]
    assert rep.data["leak"] is True
    assert rep.data["drift"]["per_round"] == pytest.approx(5000.0)
    assert any("heap falls" in f for f in rep.data["failures"])


def test_switch_that_never_enumerates_fails_and_restores(tmp_path: Path,
                                                        monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, sm = make_ctx(tmp_path)
    sm.fail_call = 3            # round 2, audio -> default never comes back
    rep = run(ctx, sm, monkeypatch, rounds=3, dwell=0.0)
    assert not rep.passed and rep.exit_code == 1
    assert "round 2" in rep.data["failures"][0]
    assert "default" in rep.data["failures"][0]
    # the finally clause tried again to restore DEFAULT after the failed leg
    assert [c[1] for c in sm.calls] == ["audio", "default", "audio", "default", "default"]
    assert rep.data["restored"] is True
    assert rep.data["final_mode"] == "default"


def test_fatal_on_console_stops_the_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, sm = make_ctx(tmp_path)
    sm.lines_on_switch = {2: ["Guru Meditation Error: Core  0 panic'ed (StoreProhibited).",
                              "ESP-ROM:esp32s3-20210327"]}
    rep = run(ctx, sm, monkeypatch, rounds=4, dwell=0.0)
    assert not rep.passed and rep.exit_code == 1
    assert len(rep.data["rounds"]) == 2
    assert rep.data["rounds"][1]["fatal"] and rep.data["rounds"][1]["reboots"] == 1
    assert rep.data["reboots"] == 1
    assert any("device fault" in f for f in rep.data["failures"])
    # rounds 3 and 4 were never attempted
    assert len(sm.calls) == 4


def test_not_in_default_mode_is_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, sm = make_ctx(tmp_path, start_mode=UsbMode.AUDIO)
    rep = run(ctx, sm, monkeypatch, rounds=2)
    assert rep.exit_code == 2 and not rep.passed
    assert sm.calls == []
    assert "default" in rep.summary


def test_cdc_lock_is_held_for_the_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from crosspad_hil.locks import PortLock

    ctx, sm = make_ctx(tmp_path)
    seen: list[list[dict]] = []
    original = sm.__call__

    def spy(device: Device, mode: UsbMode, **kw: Any) -> Device:
        seen.append(PortLock.holders(tmp_path / "locks"))
        return original(device, mode, **kw)

    monkeypatch.setattr(usb_mode_cycle, "set_mode", spy)
    rep = usb_mode_cycle.SCENARIO.run(ctx, usb_mode_cycle.Params(rounds=1, dwell=0.0),
                                      base.Progress())
    assert rep.passed
    assert seen and all(any(h["port"] == CDC.path and h["purpose"] == "usb_mode_cycle"
                            for h in holders) for holders in seen)
    assert PortLock.holders(tmp_path / "locks") == []      # released at the end


def test_lock_busy_is_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from crosspad_hil.locks import PortLock

    ctx, sm = make_ctx(tmp_path)
    with PortLock(CDC.path, "someone-else", tmp_path / "locks"):
        rep = run(ctx, sm, monkeypatch, rounds=1, dwell=0.0)
    assert rep.exit_code == 2
    assert sm.calls == []
    assert "busy" in rep.summary.lower() or "PORT_BUSY" in rep.summary


def test_cancel_between_legs_still_restores(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, sm = make_ctx(tmp_path)
    original = sm.__call__

    def cancel_after_audio(device: Device, mode: UsbMode, **kw: Any) -> Device:
        out = original(device, mode, **kw)
        if mode == UsbMode.AUDIO:
            ctx.cancelled.set()
        return out

    monkeypatch.setattr(usb_mode_cycle, "set_mode", cancel_after_audio)
    with pytest.raises(HilError) as ei:
        usb_mode_cycle.SCENARIO.run(ctx, usb_mode_cycle.Params(rounds=3, dwell=0.5),
                                    base.Progress())
    assert ei.value.code == CANCELLED
    # audio (then cancel noticed in the dwell) → restore default in finally
    assert [c[1] for c in sm.calls] == ["audio", "default"]
    assert sm.mode == UsbMode.DEFAULT
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_usb_mode_cycle.py -q 2>&1 | tail -3`
Expected: `ImportError: cannot import name 'usb_mode_cycle' from 'crosspad_hil.scenarios'`

- [ ] **Step 3: Write the implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/usb_mode_cycle.py`:

```python
"""Flip the USB profile back and forth and check the device survives it.

Port of ``platform-idf/tools/hil_usb_mode_cycle.py``. Switching between
CDC+MIDI and MIDI+UAC2 tears down TinyUSB, installs a different descriptor set
and re-enumerates. Once is not the interesting number: a descriptor leak, an
endpoint that is not released, an audio task left suspended only shows after
several rounds.

Both legs go through ``usbmode.set_mode`` on the ESP MIDI port (SysEx 0x1B) and
return only when the host has re-enumerated the expected interfaces. Heap and
faults are read from the STM VCP console, which is unaffected by the ESP's USB
going away — the whole reason the check is possible at all.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from crosspad_hil.console import Console
from crosspad_hil.devices import Device, UsbMode
from crosspad_hil.errors import PORT_BUSY, HilError
from crosspad_hil.locks import PortLock
from crosspad_hil.scenarios.base import Artifact, Context, Progress, Report, register
from crosspad_hil.usbmode import set_mode

LEAK_BYTES_PER_ROUND = 2048    # hil_usb_mode_cycle: `if drift / rounds > 2048`
WARMUP_ROUNDS = 1              # `base = heaps[1]`: the first switch allocates the UAC2 buffers
LOCK_PURPOSE = "usb_mode_cycle"
LOCK_DIR: Path | None = None   # tests point this at a temp dir; None = locks.default_lock_dir()
RECOVERY_HINT = ("device stuck without CDC: send F0 7D 1B 01 F7 to its ESP MIDI port "
                 "(`crosspad-hil usb-mode set default`), or power-cycle")


@dataclass
class Params:
    rounds: int = field(default=5, metadata={"help": "default->audio->default cycles"})
    dwell: float = field(default=2.0, metadata={"help": "seconds to stay in each profile"})
    enum_timeout: float = field(
        default=15.0, metadata={"help": "seconds to wait for the host to re-enumerate"})


def heap_drift(heaps: list[int]) -> tuple[int, int, float] | None:
    """(base, last, bytes lost per round) with the old warm-up rule.

    The first switch allocates the UAC2 buffers every later round reuses, so
    counting it as a leak would be wrong: the baseline is the sample after
    round 2 when there is one.
    """
    if not heaps:
        return None
    base = heaps[WARMUP_ROUNDS] if len(heaps) > WARMUP_ROUNDS else heaps[0]
    last = heaps[-1]
    rounds = max(1, len(heaps) - 1)
    return base, last, (base - last) / rounds


def _faults(con: Console, since_seq: int) -> tuple[list[str], int]:
    fatal: list[str] = []
    reboots = 0
    for ev in con.events(since_seq=since_seq):
        if ev.kind == "fatal":
            fatal.append(ev.line)
        elif ev.kind == "reboot":
            reboots += 1
    return fatal, reboots


def _heap_internal(con: Console) -> int | None:
    heap = con.snapshot().get("heap") or {}
    value = heap.get(0)
    return int(value) if value is not None else None


def _wait(ctx: Context, seconds: float) -> None:
    if seconds > 0:
        ctx.cancelled.wait(seconds)
    ctx.check_cancelled()


def _env(summary: str, data: dict[str, Any], artifacts: list[Artifact]) -> Report:
    return Report(passed=False, summary=summary, data=data, artifacts=artifacts, exit_code=2)


class UsbModeCycleScenario:
    name = "usb_mode_cycle"
    Params = Params
    description = "cycle CDC+MIDI <-> MIDI+UAC2 and watch enumeration, heap and faults"

    def run(self, ctx: Context, params: Params, progress: Progress) -> Report:
        p = params
        data: dict[str, Any] = {
            "rounds_requested": p.rounds, "rounds": [], "heap_start": None, "heaps": [],
            "drift": None, "leak": False, "failures": [], "fatal": [], "reboots": 0,
            "restored": True, "final_mode": ctx.device.usb_mode.value,
        }
        artifacts: list[Artifact] = []
        ctx.check_cancelled()
        dev: Device = ctx.device
        if dev.usb_mode != UsbMode.DEFAULT or dev.ports.cdc is None:
            return _env(f"usb_mode_cycle: {dev.id} is in {dev.usb_mode.value} mode — "
                        "start from default (CDC+MIDI)", data, artifacts)
        if dev.ports.esp_midi is None:
            return _env(f"usb_mode_cycle: {dev.id} has no ESP MIDI port; the mode switch "
                        "(SysEx 0x1B) has nothing to travel on", data, artifacts)

        con = ctx.open_console(reset=False)
        if con.log_path is not None:
            artifacts.append(Artifact(path=str(con.log_path), mime="text/plain", role="console"))
        seq0 = con.seq + 1
        cdc_path = dev.ports.cdc.path

        # Hold the CDC port for the whole run: its endpoint is about to vanish
        # and come back several times, and another session opening it in
        # between would either wedge or measure the wrong thing.
        lock = PortLock(cdc_path, LOCK_PURPOSE, LOCK_DIR)
        try:
            lock.acquire()
        except HilError as e:
            if e.code != PORT_BUSY:
                raise
            return _env(f"usb_mode_cycle: CDC port busy — {e.message}"
                        + (f" ({e.hint})" if e.hint else ""), data, artifacts)

        try:
            # give the console reader a moment to deliver a PerfMon block that
            # was already in flight, so heap_start is not None on a warm board
            time.sleep(0.05)
            data["heap_start"] = _heap_internal(con)
            ctx.log(f"{p.rounds} rounds, dwell {p.dwell}s, start heap {data['heap_start']}")
            try:
                self._cycle(ctx, p, con, seq0, data, progress)
            finally:
                # Whatever happened, do not leave the board without a CDC.
                dev = ctx.device
                if dev.usb_mode != UsbMode.DEFAULT:
                    try:
                        dev = set_mode(dev, UsbMode.DEFAULT, wait=True, timeout_s=p.enum_timeout)
                        ctx.device = dev
                    except HilError as e:
                        data["restored"] = False
                        data["failures"].append(
                            f"restore to default failed: {e.code}: {e.message} — {RECOVERY_HINT}")
                data["final_mode"] = ctx.device.usb_mode.value
        finally:
            lock.release()

        fatal, reboots = _faults(con, seq0)
        data["fatal"] = fatal
        data["reboots"] = reboots
        return self._verdict(p, data, artifacts)

    def _cycle(self, ctx: Context, p: Params, con: Console, seq0: int,
               data: dict[str, Any], progress: Progress) -> None:
        dev = ctx.device
        for rnd in range(1, p.rounds + 1):
            ctx.check_cancelled()
            record: dict[str, Any] = {
                "round": rnd, "to_audio_s": 0.0, "to_default_s": 0.0,
                "heap": None, "fatal": [], "reboots": 0,
            }
            # --- default -> audio ------------------------------------------
            t0 = time.monotonic()
            try:
                dev = set_mode(dev, UsbMode.AUDIO, wait=True, timeout_s=p.enum_timeout)
            except HilError as e:
                data["failures"].append(
                    f"round {rnd}: switch to audio failed — {e.code}: {e.message}")
                data["rounds"].append(record)
                return
            ctx.device = dev
            record["to_audio_s"] = round(time.monotonic() - t0, 3)
            _wait(ctx, p.dwell)

            # --- audio -> default (still SysEx: no CDC in this profile) -----
            t0 = time.monotonic()
            try:
                dev = set_mode(dev, UsbMode.DEFAULT, wait=True, timeout_s=p.enum_timeout)
            except HilError as e:
                data["failures"].append(
                    f"round {rnd}: switch to default failed — {e.code}: {e.message} "
                    f"— device stuck in audio profile")
                data["rounds"].append(record)
                return
            ctx.device = dev
            record["to_default_s"] = round(time.monotonic() - t0, 3)
            _wait(ctx, p.dwell)

            # --- what the console saw --------------------------------------
            heap_now = _heap_internal(con)
            record["heap"] = heap_now
            if heap_now is not None:
                data["heaps"].append(heap_now)
            fatal, reboots = _faults(con, seq0)
            already = sum(len(r["fatal"]) for r in data["rounds"])
            already_reb = sum(int(r["reboots"]) for r in data["rounds"])
            record["fatal"] = fatal[already:]
            record["reboots"] = reboots - already_reb
            data["rounds"].append(record)
            if record["fatal"] or record["reboots"]:
                for line in record["fatal"][-5:]:
                    ctx.log(f"   {line}")
                data["failures"].append(
                    f"round {rnd}: device fault — {len(record['fatal'])} fatal line(s), "
                    f"{record['reboots']} reboot(s); see console log")
                return
            start = data["heap_start"]
            delta = f"  ({heap_now - start:+d} vs start)" if (heap_now is not None
                                                             and start is not None) else ""
            ctx.log(f"round {rnd:3d}/{p.rounds}  ok   free={heap_now}{delta}")
            progress(rnd, p.rounds, f"round {rnd}/{p.rounds} ok free={heap_now}")

    def _verdict(self, p: Params, data: dict[str, Any], artifacts: list[Artifact]) -> Report:
        drift = heap_drift(list(data["heaps"]))
        if drift is not None:
            base, last, per_round = drift
            data["drift"] = {"base": base, "last": last, "per_round": round(per_round, 2)}
            if per_round > LEAK_BYTES_PER_ROUND:
                data["leak"] = True
                data["failures"].append(f"heap falls ~{int(per_round)} B per mode cycle")
        failures: list[str] = data["failures"]
        if failures:
            summary = (f"usb_mode_cycle: FAIL — {len(failures)} problem(s): "
                       + "; ".join(failures))
            return Report(passed=False, summary=summary, data=data, artifacts=artifacts,
                          exit_code=1)
        done = len(data["rounds"])
        return Report(passed=True,
                      summary=f"usb_mode_cycle: PASS — {done} clean profile switches",
                      data=data, artifacts=artifacts, exit_code=0)


SCENARIO = register(UsbModeCycleScenario())


def main(argv: list[str] | None = None) -> int:
    """Entry point for the platform-idf shim `tools/hil_usb_mode_cycle.py`."""
    import sys

    from crosspad_hil.cli import main as cli_main

    args = list(sys.argv[1:] if argv is None else argv)
    return cli_main(["run", "usb_mode_cycle", *args])
```

Note: `Console.log_path` is the read-only property Plan A task 6 exposes; if it
is absent on the branch, use `con.snapshot()["log_path"]`. The freshest `Device`
`set_mode` hands back is stored on `ctx.device` (a dataclass field), which is why
the `finally` sees the audio-mode device after a failed default leg.

Then extend the last line of
`/home/matixan/GIT/crosspad-hil/crosspad_hil/scenarios/__init__.py` to:

```python
from . import smoke, led_state, app_churn, kit_churn, usb_mode_cycle  # noqa: E402,F401  (registers on import)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenario_usb_mode_cycle.py -q 2>&1 | tail -3 && ruff check crosspad_hil/scenarios/usb_mode_cycle.py tests/test_scenario_usb_mode_cycle.py`
Expected: `10 passed`, ruff `All checks passed!`

If `test_three_clean_rounds` reports `heaps == []`, the console reader has not
delivered the PerfMon block fed by `FakeSetMode` before `_heap_internal` runs
(the fake feeds synchronously, the `Console` thread reads with a 0.2 s
`readline` timeout). Bump the `time.sleep(0.05)` after lock acquisition to
`0.25` and add the same `time.sleep(0.25)` immediately before
`heap_now = _heap_internal(con)`; the test asserts on values, not timing.

- [ ] **Step 5: Run the whole scenario suite and commit**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_scenarios_base.py tests/test_scenario_smoke.py tests/test_scenario_led_state.py tests/test_scenario_app_churn.py tests/test_scenario_kit_churn.py tests/test_scenario_usb_mode_cycle.py -q 2>&1 | tail -3 && python -c "from crosspad_hil.scenarios import names; print(sorted(names()))"`
Expected: all passed; `['app_churn', 'kit_churn', 'led_state', 'smoke', 'usb_mode_cycle']`

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/scenarios/usb_mode_cycle.py crosspad_hil/scenarios/__init__.py tests/test_scenario_usb_mode_cycle.py && git commit -m "feat(scenarios): usb_mode_cycle — SysEx-driven profile flips with enumeration wait, heap drift and fault checks"
```
# Plan B — chunk 4: CLI (Task 8), daemon (Task 9), platform-idf shims (Task 10)

All names follow `contract.md` verbatim. Repo for Tasks 8–9: `/home/matixan/GIT/crosspad-hil`. Repo for Task 10: `/home/matixan/GIT/platform-idf` (branch `crosspad_v20`).

Contract points this chunk had to resolve (stated once here, repeated in each task's Interfaces block):

- **Test injection** is a `CliDeps` dataclass passed as `main(argv, deps=CliDeps(...))` — no module-level `set_test_backends()` registry, because the contract forbids global mutable state. `CliDeps` carries `backends`, `serial_factory`, `midi_factory`, `run_scenario_fn`, `flash_fn`, `bootloader_fn`, `set_mode_fn`, `sleep`, `stdin/stdout/stderr`.
- `--device/-d` and `--json` are accepted **both before and after** the subcommand (two parent parsers: real defaults at top level, `argparse.SUPPRESS` in subparsers so the subparser never clobbers a top-level value). `-p/--port` is an alias of `--device` so the old `hil_*.py -p PORT` keeps working through the shims.
- `flash`: transport is `ota` when `--ota` is given **or when neither flag is given**; `--uart` passes `transport="uart"` and therefore gets `NOT_SUPPORTED` from `ota.flash()` in P0.
- `cdc VERB` for the three `multi` verbs uses a fixed prefix table in `cli.py` (`ENC_GROUP→"ENCGROUP:"`, `APP_VERSIONS→"APPVER:"`, `MEM_BLOCKS→"MEMBLK:"`) because `cdc.yaml` stores `reply: "multi"` without the prefix.
- `ble start server|host` maps to `ble_start(link, mode=0|1)` (`BLE_START [0|1]` in `hil_control.cpp`, 0 = server/peripheral, 1 = host/central).
- `run SCENARIO` adds `--logdir DIR` (default `hil_logs`) → `run_scenario(workdir=Path(logdir)/f"{name}_{ts}")`, preserving the old scripts' `--logdir`.
- Exit codes: `HilError` → 2; a device `ERR …` reply (`parsed["kind"] == "err"`) → 1; scenario → `Report.exit_code`; `console --expect` with no hit → 1.
- Daemon: the parser's `reset_reason` event kind is **not** emitted as a daemon event (it is in `console.snapshot`); `console.reboot` carries `{handle, seq, count, line}`. Task handles live in the same `HandleRegistry` with `ttl_s=None` (never expire) so an unknown task is `HANDLE_EXPIRED` like any other handle. `HandleRegistry.__init__(clock=time.monotonic, on_expire=None)` — `on_expire(handle, obj)` lets the daemon close sessions the sweep drops.
- Shims call `crosspad_hil.cli.main([...])` — no `main()` is added to scenario modules (the task brief's `crosspad_hil.scenarios.<name>` import form would need a `main` per scenario, which plan B-2/B-3 do not define). The old `hil_smoke.py --flash` (store_true) becomes `--flash PATH`; `requestBootloader.py --vid/--pid/--skip-bootloader-check` are dropped (the deprecation line says so). Each shim's docstring is a single line so the "three statements" test can count by lines.
- The task brief suggests an environment hook such as `crosspad_hil.cli.set_test_backends()`; that would be module-level mutable state, which the contract forbids, so injection is the `deps=` keyword instead. Nothing else in the CLI reads the environment.
- Daemon `scenario.list` / `scenario.run` use plan B-1's additive helpers `scenarios.base.params_schema(params_cls)` and `scenarios.base.params_from_dict(params_cls, d)` (unknown key → `BAD_ARGS`, list fields accept a comma-separated string or a list), so the daemon and the CLI cannot disagree on how a params field is typed.
- Per-device lock acquisition in the daemon is bounded: `_dev_lock(device_id)` is a context manager that waits at most `DEV_LOCK_WAIT_S` (60 s) and then raises `HilError(PORT_BUSY, hint="another op or task on this device is running; task.list / task.cancel")` rather than parking a worker forever behind a running scenario.
- On stdin EOF or `serve.shutdown` the daemon cancels every task, waits for in-flight ops to finish (so their responses are still written), then closes every handle.

---

### Task 8: CLI — `crosspad_hil/cli.py`

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/cli.py`
- Modify: `/home/matixan/GIT/crosspad-hil/pyproject.toml` (append `[project.scripts]` block if absent)
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_cli.py`

**Interfaces:**
- Consumes (contract): `devices.discover(backends) / select(devices, device) / Backends / Device / UsbMode / SerialPortInfo`; `cdc.CdcLink(port, *, serial_factory, knowledge)` with `.open() .close() .transact(cmd, expect, timeout_s) -> Reply .transact_multi(cmd, expect, end, idle_ms, timeout_s) -> list[str]`; `console.Console(port, *, log_path, serial_factory, ...)` with `.open(reset) .reset() .expect(patterns, reject, timeout_s) -> ExpectResult .read(since_seq, wait_ms, match, limit) -> ReadResult .snapshot() .close()`; every function in `verbs.py`; `midi.MidiIO(device, role, out_factory, in_factory) .open/.close/.send_sysex/.send_note`, `midi.echo_rtt(io, n, timeout_s)`; `usbmode.set_mode(device, mode, *, wait, discover_fn, midi_factory)`; `ota.flash(device, firmware, *, transport, wait_boot, console, progress)`, `ota.request_bootloader(device, target, *, method, timeout_s)`; `snapshot.take_snapshot(device, link, *, console, include, previous, counter)`, `snapshot.ref_to_delta(group, focus_index, ref)`; `scenarios.get(name)/names()`, `scenarios.base.params_to_argparse / argparse_to_params / run_scenario / Report / Progress`; `record.RecordingSerial(inner, path)`; `locks.PortLock.holders()`; `knowledge.load("cdc")`; `errors.HilError` + code constants; `tests/fakes.FakeSerial`.
- Produces:
  - `main(argv: list[str] | None = None, *, deps: CliDeps | None = None) -> int`
  - `@dataclass class CliDeps` (fields above)
  - `build_parser() -> argparse.ArgumentParser`
  - `doctor_checks(backends: Backends | None = None) -> list[dict]` — `[{name, ok, detail, fix}]`; reused by the daemon's `devices.doctor` (Task 9)
  - `render_led_grid(leds: dict) -> str`, `render_snapshot(snap: dict) -> str`, `render_devices(devices: list[dict]) -> str`
  - console script `crosspad-hil = "crosspad_hil.cli:main"`

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_cli.py`:

```python
"""CLI tests: argparse tree, injected backends/serial, exit codes. No hardware."""
from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from crosspad_hil import cli
from crosspad_hil.devices import Backends, SerialPortInfo, discover
from crosspad_hil.scenarios.base import Report
from tests.fakes import FakeSerial

CDC = "/dev/ttyACM0"
CON = "/dev/ttyACM1"


def _backends() -> Backends:
    ports = [
        SerialPortInfo(path=CDC, vid=0x303A, pid=0x3456, serial="AB12CD34",
                       product="CrossPad", location="1-1.2:1.0"),
        SerialPortInfo(path=CON, vid=0x0483, pid=0x5740, serial="STM0001",
                       product="CrossPad MIDI+Serial", location="1-1.3:1.0"),
    ]
    return Backends(list_serial=lambda: list(ports), list_midi=lambda: [],
                    list_audio=lambda: [])


@pytest.fixture
def lock_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    return tmp_path


def _deps(script, **kw) -> tuple[cli.CliDeps, io.StringIO, io.StringIO, FakeSerial]:
    fake = FakeSerial(script)
    out, err = io.StringIO(), io.StringIO()

    def factory(path: str, **_: object) -> FakeSerial:
        return fake

    deps = cli.CliDeps(backends=_backends(), serial_factory=factory,
                       stdout=out, stderr=err, sleep=lambda s: None, **kw)
    return deps, out, err, fake


def test_devices_json(lock_dir):
    deps, out, _, _ = _deps([])
    rc = cli.main(["devices", "--json"], deps=deps)
    assert rc == 0
    data = json.loads(out.getvalue())
    assert len(data["devices"]) == 1
    dev = data["devices"][0]
    assert dev["usb_mode"] == "default"
    assert dev["ports"]["cdc"]["path"] == CDC
    assert dev["ports"]["console"]["path"] == CON
    assert dev["id"].startswith("dev_")


def test_devices_human(lock_dir):
    deps, out, _, _ = _deps([])
    assert cli.main(["devices"], deps=deps) == 0
    text = out.getvalue()
    assert "dev_" in text and CDC in text and "default" in text


def test_cdc_app_list(lock_dir):
    deps, out, _, fake = _deps([("APP_LIST", "APPS: Sampler,Sequencer,Settings running=-")])
    rc = cli.main(["cdc", "APP_LIST", "--json"], deps=deps)
    assert rc == 0
    data = json.loads(out.getvalue())
    assert data["line"].startswith("APPS:")
    assert data["parsed"]["apps"] == ["Sampler", "Sequencer", "Settings"]
    assert data["parsed"]["running"] is None
    assert "APP_LIST" in fake.written
    # hygiene: the ESP CDC is opened with DTR/RTS deasserted
    assert fake.dtr is False and fake.rts is False


def test_app_list_typed(lock_dir):
    deps, out, _, _ = _deps([("APP_LIST", "APPS: Sampler,Sequencer running=Sampler")])
    assert cli.main(["--json", "app", "list"], deps=deps) == 0
    data = json.loads(out.getvalue())
    assert data == {"apps": ["Sampler", "Sequencer"], "running": "Sampler"}


def test_device_err_reply_exits_1(lock_dir):
    deps, out, _, _ = _deps([("APP_START Nope", "ERR unknown app")])
    rc = cli.main(["cdc", "APP_START", "Nope", "--json"], deps=deps)
    assert rc == 1
    assert json.loads(out.getvalue())["parsed"]["kind"] == "err"


def test_kit_load_wait(lock_dir):
    deps, out, _, fake = _deps([
        ("KIT_LOAD 3", "OK"),
        ("KIT_STATUS", "KITSTATUS: current=3 loading=0 pending=-1 name=DRUMS"),
    ])
    rc = cli.main(["kit", "load", "3", "--wait", "--json"], deps=deps)
    assert rc == 0
    data = json.loads(out.getvalue())
    assert data == {"current": 3, "loading": False, "pending": -1, "name": "DRUMS"}
    assert "KIT_LOAD 3" in fake.written and "KIT_STATUS" in fake.written


def test_led_state_grid(lock_dir):
    colors = ",".join(["000000"] * 15 + ["FF0000"])
    deps, out, _, _ = _deps([
        ("LED_STATE", f"LEDS: bri=80 anim=0 coalesce=1 cfgbri=80 pwr=0x00 pwrN=3 txfail=0 colors={colors}"),
    ])
    assert cli.main(["led", "state"], deps=deps) == 0
    text = out.getvalue()
    assert "15:FF0000" in text and " 0:000000" in text
    assert "brightness 80" in text


def test_run_smoke_json(lock_dir):
    calls: list[dict] = []

    def fake_run(name, params, *, device=None, workdir=None, progress=None,
                 cancelled=None, log=print) -> Report:
        calls.append({"name": name, "params": params, "device": device, "workdir": workdir})
        progress(1, 1, "boot complete")
        return Report(passed=True, summary="boot ok in 12.3 s", data={"missing": []},
                      artifacts=[], exit_code=0)

    deps, out, _, _ = _deps([], run_scenario_fn=fake_run)
    rc = cli.main(["run", "smoke", "--timeout", "30", "--json"], deps=deps)
    assert rc == 0
    data = json.loads(out.getvalue())
    assert data["passed"] is True and data["summary"] == "boot ok in 12.3 s"
    assert calls[0]["name"] == "smoke"
    assert calls[0]["params"].timeout == 30
    assert calls[0]["device"].id.startswith("dev_")
    assert Path(calls[0]["workdir"]).name.startswith("smoke_")


def test_run_failed_scenario_exits_1(lock_dir):
    def fake_run(name, params, **_) -> Report:
        return Report(passed=False, summary="missing marker", data={}, artifacts=[], exit_code=1)

    deps, out, _, _ = _deps([], run_scenario_fn=fake_run)
    assert cli.main(["run", "smoke"], deps=deps) == 1
    assert "FAIL" in out.getvalue()


def test_no_device_exit_2(lock_dir):
    deps, out, err, _ = _deps([])
    rc = cli.main(["-d", "dev_zzzz", "app", "list"], deps=deps)
    assert rc == 2
    assert err.getvalue().startswith("error: NO_DEVICE:")
    assert out.getvalue() == ""


def test_no_device_exit_2_json(lock_dir):
    deps, out, err, _ = _deps([])
    rc = cli.main(["--json", "-d", "dev_zzzz", "app", "list"], deps=deps)
    assert rc == 2
    data = json.loads(out.getvalue())
    assert data["ok"] is False and data["error"]["code"] == "NO_DEVICE"


def test_usage_error_exit_2(lock_dir):
    deps, _, err, _ = _deps([])
    assert cli.main(["kit", "load"], deps=deps) == 2
    assert "usage" in err.getvalue()


def test_help_exit_0(lock_dir):
    deps, out, _, _ = _deps([])
    assert cli.main(["--help"], deps=deps) == 0
    text = out.getvalue()
    for cmd in ("devices", "doctor", "console", "cdc", "app", "kit", "pad", "ui", "led",
                "mem", "ble", "midi", "usb-mode", "snapshot", "flash", "bootloader",
                "run", "record", "serve"):
        assert cmd in text


def test_run_lists_p0_scenarios(lock_dir):
    deps, out, _, _ = _deps([])
    assert cli.main(["run", "--help"], deps=deps) == 0
    text = out.getvalue()
    for name in ("smoke", "app_churn", "kit_churn", "led_state", "usb_mode_cycle"):
        assert name in text


def test_bad_arg_exit_2(lock_dir):
    deps, _, err, _ = _deps([])
    assert cli.main(["pad", "press", "16"], deps=deps) == 2
    assert "BAD_ARGS" in err.getvalue()


def test_doctor_checks_shape(lock_dir):
    checks = cli.doctor_checks(_backends())
    names = {c["name"] for c in checks}
    assert {"python", "import:serial", "import:rtmidi", "import:yaml", "devices", "locks"} <= names
    for c in checks:
        assert set(c) == {"name", "ok", "detail", "fix"}


def test_device_selection_by_port_path(lock_dir):
    deps, out, _, _ = _deps([("KIT_STATUS", "KITSTATUS: current=1 loading=0 pending=-1 name=A")])
    assert cli.main(["-d", CDC, "kit", "status", "--json"], deps=deps) == 0
    assert json.loads(out.getvalue())["current"] == 1


def test_snapshot_render_marks_focus():
    snap = {
        "snapshot_id": "snap_1", "device": "dev_ab12", "usb_mode": "default",
        "apps": {"apps": ["Sampler"], "running": None},
        "ui": {"focus": {"ref": "e1", "index": 1, "label": "Sampler"},
               "group": [{"ref": "e0", "index": 0, "ptr": "0x3c0", "label": "Sequencer"},
                         {"ref": "e1", "index": 1, "ptr": "0x3c1", "label": "Sampler"}],
               "drawer": True, "theme": 0, "app": None},
        "kit": {"current": 3, "loading": False, "pending": -1, "name": "DRUMS"},
        "leds": {"brightness": 80, "anim": 0, "coalesce": 1, "cfgbri": 80, "pwr": 0,
                 "pwr_count": 1, "txfail": 0, "colors": ["000000"] * 16},
        "pads": None, "mem": {"free": 60000, "largest": 30000, "min": 50000},
        "ble": None, "console": {"fatals": [], "reboots": 0, "cdc_drops": 0, "since_seq": 10},
        "ts": 1.0, "changed": [],
    }
    text = cli.render_snapshot(snap)
    assert "> e1  Sampler" in text and "  e0  Sequencer" in text
    assert "15:000000" in text and "DRUMS" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_cli.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.cli'` (or `ImportError: cannot import name 'CliDeps'`).

- [ ] **Step 3: Write minimal implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/cli.py`:

```python
"""crosspad-hil command line: `main(argv) -> int`.

Every subcommand builds the same dict the daemon returns for the equivalent op;
`--json` prints that dict, otherwise a one-screen human summary. Exit codes:
0 ok, 1 fail (scenario failed / device replied ERR / expect missed), 2 env or
usage (any HilError, argparse error).
"""
from __future__ import annotations

import argparse
import dataclasses
import importlib
import json
import os
import platform
import shutil
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO

from . import __version__, verbs
from .cdc import CdcLink, Reply
from .console import Console
from .devices import Backends, Device, UsbMode, discover, select
from .errors import BAD_ARGS, NO_CDC_IN_AUDIO_MODE, NO_DEVICE, HilError
from .knowledge import load as load_knowledge
from .locks import PortLock
from .midi import MidiIO, MidiRole, echo_rtt
from .ota import flash as ota_flash_and_boot
from .ota import request_bootloader
from .record import RecordingSerial
from .scenarios import app_churn, kit_churn, led_state, smoke, usb_mode_cycle  # noqa: F401
from .scenarios import base as scen
from .scenarios import get as get_scenario
from .scenarios import names as scenario_names
from .serial_open import open_serial
from .snapshot import take_snapshot, ref_to_delta
from .usbmode import set_mode

# Multi-line verbs: cdc.yaml says reply "multi" but not the prefix (hil_control.cpp).
MULTI_PREFIX: dict[str, str] = {
    "ENC_GROUP": "ENCGROUP:",
    "APP_VERSIONS": "APPVER:",
    "MEM_BLOCKS": "MEMBLK:",
}
_DOCTOR_REQUIRED = ("python", "import:serial", "import:rtmidi", "import:yaml")


@dataclass
class CliDeps:
    """Everything the CLI touches that a test wants to replace."""

    backends: Backends | None = None
    serial_factory: Callable[..., Any] = open_serial
    midi_factory: Callable[..., Any] = MidiIO
    run_scenario_fn: Callable[..., scen.Report] = scen.run_scenario
    flash_fn: Callable[..., dict] = ota_flash_and_boot
    bootloader_fn: Callable[..., dict] = request_bootloader
    set_mode_fn: Callable[..., Device] = set_mode
    sleep: Callable[[float], None] = time.sleep
    stdin: TextIO | None = None
    stdout: TextIO | None = None
    stderr: TextIO | None = None

    def inp(self) -> TextIO:
        return self.stdin or sys.stdin

    def out(self) -> TextIO:
        return self.stdout or sys.stdout

    def err(self) -> TextIO:
        return self.stderr or sys.stderr


@dataclass
class CmdResult:
    data: dict
    text: str
    exit_code: int = 0


Handler = Callable[[CliDeps, argparse.Namespace], CmdResult]


# --------------------------------------------------------------------------- helpers

def _resolve(deps: CliDeps, ns: argparse.Namespace) -> Device:
    return select(discover(deps.backends), getattr(ns, "device", None))


@contextmanager
def _cdc(deps: CliDeps, dev: Device) -> Iterator[CdcLink]:
    if dev.ports.cdc is None:
        if dev.usb_mode == UsbMode.AUDIO:
            raise HilError(NO_CDC_IN_AUDIO_MODE,
                           f"{dev.id} is in the MIDI+UAC2 profile; CDC endpoint absent",
                           hint="crosspad-hil usb-mode set default", device=dev.id)
        raise HilError(NO_DEVICE, f"{dev.id} has no CDC port (usb_mode={dev.usb_mode.value})",
                       hint="is the board in bootloader/DFU?", device=dev.id)
    link = CdcLink(dev.ports.cdc.path, serial_factory=deps.serial_factory)
    link.open()
    try:
        yield link
    finally:
        link.close()


@contextmanager
def _console(deps: CliDeps, dev: Device, *, reset: bool = False,
             log_path: Path | None = None) -> Iterator[Console]:
    if dev.ports.console is None:
        raise HilError(NO_DEVICE, f"{dev.id} has no STM32 bridge VCP (0x0483:0x5740)",
                       hint="the console comes off the STM bridge, not the ESP CDC", device=dev.id)
    con = Console(dev.ports.console.path, log_path=log_path, serial_factory=deps.serial_factory)
    con.open(reset=reset)
    try:
        yield con
    finally:
        con.close()


def _reply_dict(reply: Reply) -> dict:
    return {"line": reply.line, "parsed": reply.parsed, "rtt_ms": reply.rtt_ms,
            "extra_lines": reply.extra_lines}


def _reply_exit(reply: Reply) -> int:
    return 1 if (reply.parsed or {}).get("kind") == "err" else 0


def _kv(d: dict, keys: tuple[str, ...] | None = None) -> str:
    items = d.items() if keys is None else ((k, d.get(k)) for k in keys)
    return "  ".join(f"{k}={v}" for k, v in items)


def _int_arg(value: Any, name: str, lo: int, hi: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError) as e:
        raise HilError(BAD_ARGS, f"{name} must be an integer, got {value!r}") from e
    if not lo <= v <= hi:
        raise HilError(BAD_ARGS, f"{name} must be {lo}..{hi}, got {v}")
    return v


# --------------------------------------------------------------------------- renderers

def render_devices(devices: list[dict]) -> str:
    if not devices:
        return "no CrossPad found (ESP CDC 0x303A:0x3456 / STM bridge 0x0483:0x5740)"
    rows = ["ID        MODE        CDC              CONSOLE          ESP MIDI / STM MIDI / UAC2"]
    for d in devices:
        p = d["ports"]

        def path(k: str) -> str:
            v = p.get(k)
            return (v.get("path") or v.get("name") or "-") if v else "-"

        rows.append(f"{d['id']:<9} {d['usb_mode']:<11} {path('cdc'):<16} {path('console'):<16} "
                    f"{path('esp_midi')} / {path('stm_midi')} / {path('uac2')}")
    return "\n".join(rows)


def render_led_grid(leds: dict) -> str:
    """Port of hil_led_state.render: 4x4 as it sits under your hands, pads 12..15 on top."""
    colors = list(leds.get("colors") or [])
    lines = [
        f"  brightness {leds.get('brightness')}   settings {leds.get('cfgbri')}"
        f"   animating {leds.get('anim')}   coalesced {leds.get('coalesce')}",
        f"  last power state 0x{int(leds.get('pwr') or 0):02X}"
        f"   notifications {leds.get('pwr_count')}"
        f"   (0x00 AWAKE · 0x03 WOKE · 0x04 LIGHT)",
    ]
    txfail = leds.get("txfail") or 0
    if txfail:
        lines.append(f"  {txfail} frame(s) never reached the strip — the model is right "
                     f"and the wire is not")
    lines.append("")
    for row in range(3, -1, -1):
        cells = []
        for col in range(4):
            idx = row * 4 + col
            c = colors[idx] if idx < len(colors) else "??????"
            cells.append(f"{idx:2d}:{c}")
        lines.append("   " + "  ".join(cells))
    if colors and all(c == "000000" for c in colors):
        lines.append("")
        lines.append("  every pad is black in the model — nothing repainted them")
    return "\n".join(lines)


def render_ui(ui: dict) -> str:
    focus = ui.get("focus") or {}
    focus_ref = focus.get("ref")
    lines = [f"UI  drawer={ui.get('drawer')}  theme={ui.get('theme')}  app={ui.get('app') or '-'}"]
    for item in ui.get("group") or []:
        mark = ">" if item.get("ref") == focus_ref else " "
        lines.append(f"{mark} {item.get('ref'):<3} {item.get('label')}")
    if not ui.get("group"):
        lines.append("  (encoder group empty)")
    return "\n".join(lines)


def render_snapshot(snap: dict) -> str:
    out = [f"{snap.get('snapshot_id')}  {snap.get('device')}  usb_mode={snap.get('usb_mode')}"]
    apps = snap.get("apps")
    if apps:
        out.append(f"apps: running={apps.get('running') or '-'}  "
                   f"[{', '.join(apps.get('apps') or [])}]")
    kit = snap.get("kit")
    if kit:
        out.append(f"kit: {kit.get('current')} {kit.get('name') or ''}  "
                   f"loading={kit.get('loading')} pending={kit.get('pending')}")
    ui = snap.get("ui")
    if ui:
        out.append(render_ui(ui))
    leds = snap.get("leds")
    if leds:
        out.append("leds:")
        out.append(render_led_grid(leds))
    pads = snap.get("pads")
    if pads:
        out.append("pads: " + _kv(pads))
    mem = snap.get("mem")
    if mem:
        out.append("mem: " + _kv(mem))
    ble = snap.get("ble")
    if ble:
        out.append("ble: " + _kv(ble))
    con = snap.get("console")
    if con:
        out.append(f"console: fatals={len(con.get('fatals') or [])} reboots={con.get('reboots')} "
                   f"cdc_drops={con.get('cdc_drops')} since_seq={con.get('since_seq')}")
    if snap.get("changed"):
        out.append("changed: " + ", ".join(snap["changed"]))
    return "\n".join(out)


def render_report(report: scen.Report) -> str:
    head = "PASS" if report.passed else "FAIL"
    lines = [f"{head}: {report.summary}"]
    for k, v in report.data.items():
        if isinstance(v, (int, float, str, bool)) or v is None:
            lines.append(f"  {k}: {v}")
        else:
            lines.append(f"  {k}: {json.dumps(v)[:200]}")
    for a in report.artifacts:
        lines.append(f"  artifact[{a.role}]: {a.path}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- doctor

def doctor_checks(backends: Backends | None = None) -> list[dict]:
    checks: list[dict] = []

    def add(name: str, ok: bool, detail: str, fix: str | None = None) -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail, "fix": fix})

    add("python", sys.version_info >= (3, 10), platform.python_version(),
        None if sys.version_info >= (3, 10) else "install Python >= 3.10")
    for mod, pkg, required in (("serial", "pyserial", True), ("rtmidi", "python-rtmidi", True),
                               ("yaml", "PyYAML", True), ("sounddevice", "crosspad-hil[audio]", False),
                               ("bleak", "crosspad-hil[ble]", False)):
        try:
            importlib.import_module(mod)
            add(f"import:{mod}", True, "present")
        except Exception as e:  # noqa: BLE001 — a broken optional dep is a finding, not a crash
            add(f"import:{mod}", not required, f"missing ({type(e).__name__}: {e})",
                f"pip install '{pkg}'")
    holders = PortLock.holders()
    live = [h for h in holders if h.get("alive")]
    add("locks", True, "no live port locks" if not live else
        "; ".join(f"{h['port']} held by pid {h['pid']} ({h['purpose']})" for h in live),
        None if not live else "close the other crosspad-hil / script, or wait")
    try:
        devs = discover(backends)
        add("devices", len(devs) > 0,
            ", ".join(f"{d.id}:{d.usb_mode.value}" for d in devs) or "none found",
            None if devs else "connect the board; if only the STM VCP shows, the ESP may be in "
                              "bootloader or UAC2 mode")
    except Exception as e:  # noqa: BLE001
        add("devices", False, f"discovery failed: {e}", "run with --json for details")
    if sys.platform.startswith("linux"):
        try:
            import grp

            groups = {grp.getgrgid(g).gr_name for g in os.getgroups()}
            ok = bool(groups & {"dialout", "uucp", "plugdev"})
            add("serial-group", ok, ", ".join(sorted(groups & {"dialout", "uucp", "plugdev"})) or
                "not in dialout/uucp", None if ok else "sudo usermod -aG dialout $USER; re-login")
        except Exception as e:  # noqa: BLE001
            add("serial-group", True, f"could not read groups ({e})")
    a2l = shutil.which("xtensa-esp32s3-elf-addr2line")
    add("addr2line", True, a2l or "not on PATH (only diagnose needs it)",
        None if a2l else ". $IDF_PATH/export.sh")
    return checks


# --------------------------------------------------------------------------- commands

def cmd_devices(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    def once() -> tuple[dict, str]:
        devs = [d.to_dict() for d in discover(deps.backends)]
        return {"devices": devs}, render_devices(devs)

    data, text = once()
    if not ns.watch:
        return CmdResult(data, text)
    out = deps.out()
    try:
        while True:
            out.write((json.dumps(data) if ns.as_json else text) + "\n")
            out.flush()
            deps.sleep(1.0)
            data, text = once()
    except KeyboardInterrupt:
        pass
    return CmdResult(data, text)


def cmd_doctor(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    checks = doctor_checks(deps.backends)
    bad = [c for c in checks if c["name"] in _DOCTOR_REQUIRED and not c["ok"]]
    lines = []
    for c in checks:
        lines.append(f"[{'ok' if c['ok'] else '!!'}] {c['name']:<14} {c['detail']}")
        if not c["ok"] and c["fix"]:
            lines.append(f"     fix: {c['fix']}")
    return CmdResult({"checks": checks}, "\n".join(lines), 2 if bad else 0)


def cmd_console(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    log_path = Path(ns.log) if ns.log else None
    with _console(deps, dev, reset=False, log_path=log_path) as con:
        if ns.reset:
            con.reset()
        if ns.expect:
            res = con.expect(list(ns.expect), list(ns.reject or []), timeout_s=ns.timeout)
            data = dataclasses.asdict(res)
            data["port"] = dev.ports.console.path
            if res.hit:
                text = f"HIT {res.hit!r} at seq {res.seq} after {res.elapsed_s:.1f}s\n" + \
                       "\n".join(res.context)
                return CmdResult(data, text, 0)
            if res.rejected:
                text = f"REJECTED {res.rejected!r} at seq {res.seq}\n" + "\n".join(res.context)
            else:
                text = f"no match within {ns.timeout:.0f}s"
            return CmdResult(data, text, 1)
        out = deps.out()
        deadline = time.monotonic() + ns.timeout if ns.timeout > 0 else None
        seq: int | None = None
        count = 0
        try:
            while deadline is None or time.monotonic() < deadline:
                r = con.read(since_seq=seq, wait_ms=500)
                seq = r.next_seq
                for _, line in r.lines:
                    count += 1
                    if not ns.as_json:
                        out.write(line + "\n")
                out.flush()
        except KeyboardInterrupt:
            pass
        snap = con.snapshot()
        return CmdResult({"lines": count, "snapshot": snap}, f"{count} lines", 0)


def cmd_cdc(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    cmd = " ".join([ns.verb, *ns.args])
    verb = ns.verb.upper()
    dev = _resolve(deps, ns)
    entry = (load_knowledge("cdc").get("verbs") or {}).get(verb)
    with _cdc(deps, dev) as link:
        if entry and entry.get("reply") == "multi":
            lines = link.transact_multi(cmd, ns.expect or MULTI_PREFIX.get(verb, verb),
                                        end=entry.get("end"), timeout_s=ns.timeout / 1000.0)
            return CmdResult({"lines": lines}, "\n".join(lines), 0)
        reply = link.transact(cmd, expect=ns.expect, timeout_s=ns.timeout / 1000.0)
    text = reply.line + ("\n" + "\n".join(reply.extra_lines) if reply.extra_lines else "")
    return CmdResult(_reply_dict(reply), text, _reply_exit(reply))


def cmd_app(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    with _cdc(deps, dev) as link:
        if ns.app_cmd == "list":
            r = verbs.app_list(link)
            return CmdResult(r, f"running={r['running'] or '-'}\n" + "\n".join(r["apps"]))
        if ns.app_cmd == "start":
            r = verbs.app_start(link, ns.name, wait_s=ns.wait)
            return CmdResult(r, f"running={r['running']}")
        if ns.app_cmd == "stop":
            r = verbs.app_stop(link)
            return CmdResult(r, "stopped")
        r = verbs.app_versions(link)
        lines = [f"{c['component']:<24} {c['id']:<12} {c['commit']} {c['ref']}"
                 f"{' dirty' if c['dirty'] else ''}" for c in r["components"]]
        return CmdResult(r, "\n".join(lines) or "(no app components)")


def cmd_kit(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    with _cdc(deps, dev) as link:
        if ns.kit_cmd == "list":
            r = verbs.kit_list(link)
            lines = [f"{'*' if k['id'] == r['current'] else ' '} {k['id']:>3}  {k['name']}"
                     for k in r["kits"]]
            return CmdResult(r, "\n".join(lines))
        if ns.kit_cmd == "status":
            r = verbs.kit_status(link)
            return CmdResult(r, _kv(r))
        kit_id = _int_arg(ns.id, "ID", 0, 255)
        if ns.wait:
            r = verbs.kit_load(link, kit_id, wait_s=ns.timeout)
        else:
            link.transact(f"KIT_LOAD {kit_id}")
            r = verbs.kit_status(link)
        return CmdResult(r, _kv(r))


def cmd_pad(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    with _cdc(deps, dev) as link:
        if ns.pad_cmd == "press":
            r = verbs.pad_press(link, _int_arg(ns.idx, "I", 0, 15), _int_arg(ns.vel, "VEL", 0, 127))
            return CmdResult(r or {"ok": True}, f"pad {ns.idx} pressed vel={ns.vel}")
        if ns.pad_cmd == "release":
            r = verbs.pad_release(link, _int_arg(ns.idx, "I", 0, 15))
            return CmdResult(r or {"ok": True}, f"pad {ns.idx} released")
        if ns.pad_cmd == "pressure":
            r = verbs.pad_pressure(link, _int_arg(ns.idx, "I", 0, 15), _int_arg(ns.val, "V", 0, 255))
            return CmdResult(r or {"ok": True}, f"pad {ns.idx} pressure={ns.val}")
        if ns.pad_cmd == "stats":
            r = verbs.pad_stats(link, reset=ns.reset)
            return CmdResult(r, _kv(r))
        r = verbs.pad_notes(link)
        notes = r["notes"]
        rows = []
        for row in range(3, -1, -1):
            rows.append("   " + "  ".join(f"{row * 4 + c:2d}:{notes.get(row * 4 + c, '?'):>3}"
                                          for c in range(4)))
        return CmdResult({"notes": {str(k): v for k, v in notes.items()}}, "\n".join(rows))


def cmd_ui(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    with _cdc(deps, dev) as link:
        if ns.ui_cmd == "snapshot":
            snap = take_snapshot(dev, link, include=("apps", "ui")).to_dict()
            return CmdResult(snap, render_snapshot(snap))
        if ns.ui_cmd == "press":
            verbs.enc_press(link, ms=ns.ms)
            r = verbs.enc_focus(link)
            return CmdResult(r, "pressed; focus " + _kv(r))
        if ns.ui_cmd == "rotate":
            verbs.enc_rotate(link, int(ns.n))
            r = verbs.enc_focus(link)
            return CmdResult(r, f"rotated {ns.n}; focus " + _kv(r))
        group = verbs.enc_group(link)["group"]
        focus = verbs.enc_focus(link)
        delta = ref_to_delta(group, focus["index"], ns.ref)
        if delta:
            verbs.enc_rotate(link, delta)
        r = verbs.enc_focus(link)
        r["delta"] = delta
        return CmdResult(r, f"focus {ns.ref} (delta {delta}) -> {r['label']}")


def cmd_led(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    with _cdc(deps, dev) as link:
        r = verbs.led_state(link)
    return CmdResult(r, render_led_grid(r))


def cmd_mem(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    with _cdc(deps, dev) as link:
        if ns.blocks:
            r = verbs.mem_blocks(link)
            s = r["summary"]
            lines = [f"biggest used block {s.get('biggest_used')} B"]
            for b in s.get("buckets", []):
                lines.append(f"  <= {b['le']:>7}: used {b['used_n']:>4} ({b['used_b']:>7} B)  "
                             f"free {b['free_n']:>4} ({b['free_b']:>7} B)")
            for blk in r["big"]:
                lines.append(f"  big {blk['addr']} {blk['size']} B")
            return CmdResult(r, "\n".join(lines))
        r = verbs.mem(link)
    return CmdResult(r, _kv(r))


def cmd_ble(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    with _cdc(deps, dev) as link:
        c = ns.ble_cmd
        if c == "status":
            r = verbs.ble_status(link)
        elif c == "start":
            mode = None if ns.role is None else {"server": 0, "host": 1}[ns.role]
            r = verbs.ble_start(link, mode) or {"ok": True}
        elif c == "stop":
            r = verbs.ble_stop(link) or {"ok": True}
        elif c == "scan":
            r = verbs.ble_scan(link, ms=int(ns.ms)) or {"ok": True}
        elif c == "devices":
            r = verbs.ble_devices(link)
        elif c == "connect":
            r = verbs.ble_connect(link, ns.addr) or {"ok": True}
        elif c == "disconnect":
            r = verbs.ble_disconnect(link) or {"ok": True}
        else:
            r = verbs.ble_send(link, _int_arg(ns.note, "NOTE", 0, 127),
                               _int_arg(ns.vel, "VEL", 0, 127)) or {"ok": True}
    if c == "devices":
        lines = [f"{d['addr']}  rssi={d['rssi']}  {d['name']}" for d in r.get("devices", [])]
        return CmdResult(r, "\n".join(lines) or "(no BLE MIDI devices)")
    return CmdResult(r, _kv(r))


def cmd_midi(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    role = MidiRole.STM if getattr(ns, "port", "esp") == "stm" else MidiRole.ESP
    io = deps.midi_factory(dev, role)
    io.open()
    try:
        if ns.midi_cmd == "sysex":
            try:
                frame = bytes.fromhex(ns.hex.replace(" ", "").replace(",", ""))
            except ValueError as e:
                raise HilError(BAD_ARGS, f"not a hex string: {ns.hex!r}") from e
            io.send_sysex(frame)
            return CmdResult({"sent": len(frame)}, f"sent {len(frame)} bytes on {role.value}")
        if ns.midi_cmd == "note":
            note = _int_arg(ns.note, "N", 0, 127)
            vel = _int_arg(ns.vel, "VEL", 0, 127)
            io.send_note(ns.state == "on", note, vel)
            return CmdResult({"sent": 1, "on": ns.state == "on", "note": note, "vel": vel},
                             f"note {ns.state} {note} vel={vel}")
        r = echo_rtt(io, n=int(ns.n))
        rtt = r.get("rtt_ms", {})
        return CmdResult(r, f"sent={r['sent']} received={r['received']} lost={r['lost']}  "
                            f"rtt p50={rtt.get('p50')} p90={rtt.get('p90')} max={rtt.get('max')} ms")
    finally:
        io.close()


def cmd_usb_mode(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    if ns.usb_cmd == "get":
        return CmdResult({"device": dev.id, "usb_mode": dev.usb_mode.value}, dev.usb_mode.value)
    mode = UsbMode(ns.mode)
    new = deps.set_mode_fn(dev, mode, wait=not ns.no_wait,
                           discover_fn=lambda: discover(deps.backends),
                           midi_factory=deps.midi_factory)
    return CmdResult(new.to_dict(), f"{new.id} usb_mode={new.usb_mode.value}")


def cmd_snapshot(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    with _cdc(deps, dev) as link:
        snap = take_snapshot(dev, link).to_dict()
    return CmdResult(snap, render_snapshot(snap))


def cmd_flash(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    fw = Path(ns.firmware)
    if not fw.is_file():
        raise HilError(BAD_ARGS, f"firmware not found: {fw}", hint="idf.py build first")
    if ns.delta and not ns.base_fw:
        raise HilError(BAD_ARGS, "--delta requires --base-fw (firmware currently on the device)")
    transport = "uart" if ns.uart else "ota"
    err = deps.err()

    def progress(done: int, total: int) -> None:
        if not ns.as_json and total:
            err.write(f"\rProgress: {done * 100 // total}% ({done}/{total})")
            err.flush()

    kw: dict[str, Any] = {"transport": transport, "wait_boot": ns.wait_boot, "console": None,
                          "progress": progress}
    if ns.delta:
        kw["delta_base"] = Path(ns.base_fw)
    r = deps.flash_fn(dev, fw, **kw)
    if not ns.as_json:
        err.write("\n")
    f = r.get("flash") or {}
    text = (f"flashed {f.get('bytes')} B in {f.get('seconds', 0):.1f}s ({f.get('kbps', 0):.0f} kB/s) "
            f"mode={f.get('mode')} version={f.get('version')}")
    boot = r.get("boot")
    code = 0
    if boot is not None:
        ok = boot.get("complete") and not boot.get("fatal") and not boot.get("bootloops")
        text += f"\nboot: {'complete' if ok else 'FAILED'} in {boot.get('seconds', 0):.1f}s"
        if boot.get("missing"):
            text += "\n  missing: " + ", ".join(boot["missing"])
        if boot.get("fatal"):
            text += "\n  fatal: " + json.dumps(boot["fatal"])[:200]
        code = 0 if ok else 1
    return CmdResult(r, text, code)


def cmd_bootloader(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    target = "stm" if ns.stm else "esp"
    r = deps.bootloader_fn(dev, target, method=ns.method, timeout_s=ns.timeout)
    port = r.get("bootloader_port")
    return CmdResult(r, f"{target} bootloader port: {port}" if port else
                     f"{target} bootloader request sent; no bootloader port seen yet")


class CliProgress(scen.Progress):
    def __init__(self, stream: TextIO, quiet: bool) -> None:
        self._stream = stream
        self._quiet = quiet

    def __call__(self, progress: int, total: int | None, message: str) -> None:
        if self._quiet:
            return
        tot = f"/{total}" if total is not None else ""
        self._stream.write(f"[{progress}{tot}] {message}\n")
        self._stream.flush()


def cmd_run(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    name = ns.scenario
    s = get_scenario(name)
    params = scen.argparse_to_params(s.Params, ns)
    dev = _resolve(deps, ns)
    workdir = Path(ns.logdir) / f"{name}_{time.strftime('%Y%m%d_%H%M%S')}"
    report = deps.run_scenario_fn(name, params, device=dev, workdir=workdir,
                                  progress=CliProgress(deps.err(), ns.as_json),
                                  log=lambda m: deps.err().write(str(m) + "\n"))
    data = dataclasses.asdict(report)
    data["scenario"] = name
    data["workdir"] = str(workdir)
    return CmdResult(data, render_report(report), report.exit_code)


def cmd_record(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    dev = _resolve(deps, ns)
    out_path = Path(ns.out)

    def factory(path: str, **kw: Any) -> Any:
        return RecordingSerial(deps.serial_factory(path, **kw), out_path)

    rec_deps = dataclasses.replace(deps, serial_factory=factory)
    n = 0
    out = deps.out()
    with _cdc(rec_deps, dev) as link:
        for raw in deps.inp():
            cmd = raw.strip()
            if not cmd:
                continue
            n += 1
            try:
                reply = link.transact(cmd, timeout_s=2.0)
                out.write(reply.line + "\n")
                for extra in reply.extra_lines:
                    out.write(extra + "\n")
            except HilError as e:
                out.write(f"error: {e.code}: {e.message}\n")
            out.flush()
    return CmdResult({"out": str(out_path), "commands": n}, f"{n} commands recorded to {out_path}")


def cmd_serve(deps: CliDeps, ns: argparse.Namespace) -> CmdResult:
    from .serve import Daemon

    Daemon(deps.inp(), deps.out(), backends=deps.backends, serial_factory=deps.serial_factory).run()
    return CmdResult({"ok": True}, "", 0)


# --------------------------------------------------------------------------- parser

def _common(suppress: bool) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(add_help=False)
    dflt = argparse.SUPPRESS if suppress else None
    p.add_argument("-d", "--device", "-p", "--port", dest="device", default=dflt,
                   help="device id (dev_xxxx) or a port path; implicit when one board is attached")
    p.add_argument("--json", dest="as_json", action="store_true",
                   default=argparse.SUPPRESS if suppress else False,
                   help="print the same object the daemon returns")
    return p


def build_parser() -> argparse.ArgumentParser:
    top = _common(False)
    sub_common = _common(True)
    ap = argparse.ArgumentParser(prog="crosspad-hil", parents=[top],
                                 description="Talk to a CrossPad: discovery, console, CDC verbs, "
                                             "MIDI, USB mode, OTA, snapshots, HIL scenarios.")
    ap.add_argument("--version", action="version", version=f"crosspad-hil {__version__}")
    sub = ap.add_subparsers(dest="command", required=True, metavar="COMMAND")

    def add(name: str, func: Handler, help_: str) -> argparse.ArgumentParser:
        p = sub.add_parser(name, help=help_, parents=[sub_common])
        p.set_defaults(func=func)
        return p

    p = add("devices", cmd_devices, "list attached CrossPads and their ports")
    p.add_argument("--watch", action="store_true", help="re-list every second until Ctrl-C")

    add("doctor", cmd_doctor, "check deps, permissions, port locks, devices")

    p = add("console", cmd_console, "STM bridge console: tail, or --expect patterns")
    p.add_argument("--reset", action="store_true", help="pulse DTR/RTS (reboots the ESP) first")
    p.add_argument("--expect", nargs="+", metavar="P", help="regexes; exit 0 on first hit")
    p.add_argument("--reject", nargs="+", metavar="P", help="regexes that fail the expect")
    p.add_argument("--timeout", type=float, default=30.0, help="seconds (tail: 0 = until Ctrl-C)")
    p.add_argument("--log", metavar="FILE", help="also append every line to FILE")

    p = add("cdc", cmd_cdc, "send a raw CDC verb and print the reply")
    p.add_argument("verb", metavar="VERB")
    p.add_argument("args", nargs="*", metavar="ARGS")
    p.add_argument("--expect", metavar="PREFIX", help="reply prefix (default: from cdc.yaml)")
    p.add_argument("--timeout", type=float, default=2000.0, help="milliseconds")

    p = add("app", cmd_app, "list / start NAME / stop / versions")
    s = p.add_subparsers(dest="app_cmd", required=True)
    s.add_parser("list", parents=[sub_common])
    q = s.add_parser("start", parents=[sub_common])
    q.add_argument("name", metavar="NAME")
    q.add_argument("--wait", type=float, default=3.0, help="seconds to wait for APP_LIST running=")
    s.add_parser("stop", parents=[sub_common])
    s.add_parser("versions", parents=[sub_common])

    p = add("kit", cmd_kit, "list / load ID [--wait] / status")
    s = p.add_subparsers(dest="kit_cmd", required=True)
    s.add_parser("list", parents=[sub_common])
    q = s.add_parser("load", parents=[sub_common])
    q.add_argument("id", metavar="ID")
    q.add_argument("--wait", action="store_true", help="wait until KIT_STATUS reports the kit")
    q.add_argument("--timeout", type=float, default=15.0, help="seconds for --wait")
    s.add_parser("status", parents=[sub_common])

    p = add("pad", cmd_pad, "press I [VEL] / release I / pressure I V / stats [--reset] / notes")
    s = p.add_subparsers(dest="pad_cmd", required=True)
    q = s.add_parser("press", parents=[sub_common])
    q.add_argument("idx", metavar="I")
    q.add_argument("vel", nargs="?", default=127, metavar="VEL")
    q = s.add_parser("release", parents=[sub_common])
    q.add_argument("idx", metavar="I")
    q = s.add_parser("pressure", parents=[sub_common])
    q.add_argument("idx", metavar="I")
    q.add_argument("val", metavar="V")
    q = s.add_parser("stats", parents=[sub_common])
    q.add_argument("--reset", action="store_true")
    s.add_parser("notes", parents=[sub_common])

    p = add("ui", cmd_ui, "snapshot / focus REF / press / rotate N")
    s = p.add_subparsers(dest="ui_cmd", required=True)
    s.add_parser("snapshot", parents=[sub_common])
    q = s.add_parser("focus", parents=[sub_common])
    q.add_argument("ref", metavar="REF", help="e<i> from ui snapshot")
    q = s.add_parser("press", parents=[sub_common])
    q.add_argument("--ms", type=int, default=80)
    q = s.add_parser("rotate", parents=[sub_common])
    q.add_argument("n", type=int, metavar="N")

    p = add("led", cmd_led, "state: the LED controller's model as a 4x4 grid")
    s = p.add_subparsers(dest="led_cmd", required=True)
    s.add_parser("state", parents=[sub_common])

    p = add("mem", cmd_mem, "free/largest/min internal + PSRAM; --blocks for the histogram")
    p.add_argument("--blocks", action="store_true")

    p = add("ble", cmd_ble, "status / start [server|host] / stop / scan [MS] / devices / "
                            "connect ADDR / disconnect / send NOTE [VEL]")
    s = p.add_subparsers(dest="ble_cmd", required=True)
    s.add_parser("status", parents=[sub_common])
    q = s.add_parser("start", parents=[sub_common])
    q.add_argument("role", nargs="?", choices=["server", "host"], default=None)
    s.add_parser("stop", parents=[sub_common])
    q = s.add_parser("scan", parents=[sub_common])
    q.add_argument("ms", nargs="?", default=5000, metavar="MS")
    s.add_parser("devices", parents=[sub_common])
    q = s.add_parser("connect", parents=[sub_common])
    q.add_argument("addr", metavar="ADDR")
    s.add_parser("disconnect", parents=[sub_common])
    q = s.add_parser("send", parents=[sub_common])
    q.add_argument("note", metavar="NOTE")
    q.add_argument("vel", nargs="?", default=100, metavar="VEL")

    p = add("midi", cmd_midi, "sysex HEX [--port esp|stm] / note on|off N [VEL] / echo [--n N]")
    s = p.add_subparsers(dest="midi_cmd", required=True)
    q = s.add_parser("sysex", parents=[sub_common])
    q.add_argument("hex", metavar="HEX", help='e.g. "F0 7D 1D 10 F7"')
    q.add_argument("--port", dest="port", choices=["esp", "stm"], default="esp")
    q = s.add_parser("note", parents=[sub_common])
    q.add_argument("state", choices=["on", "off"])
    q.add_argument("note", metavar="N")
    q.add_argument("vel", nargs="?", default=100, metavar="VEL")
    q = s.add_parser("echo", parents=[sub_common])
    q.add_argument("--n", type=int, default=20)

    p = add("usb-mode", cmd_usb_mode, "get / set default|audio [--no-wait]")
    s = p.add_subparsers(dest="usb_cmd", required=True)
    s.add_parser("get", parents=[sub_common])
    q = s.add_parser("set", parents=[sub_common])
    q.add_argument("mode", choices=["default", "audio"])
    q.add_argument("--no-wait", action="store_true", help="do not wait for re-enumeration")

    add("snapshot", cmd_snapshot, "one-call device state: apps, ui, kit, leds, pads, mem, ble")

    p = add("flash", cmd_flash, "OTA-flash FW over CDC (switches out of UAC2 mode if needed)")
    p.add_argument("firmware", nargs="?", default="build/CrossPad.bin", metavar="FW")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--ota", action="store_true", help="OTA over CDC (default)")
    g.add_argument("--uart", action="store_true", help="UART/esptool (not in P0: use idf.py flash)")
    p.add_argument("--delta", action="store_true", help="send a delta patch (needs --base-fw)")
    p.add_argument("--base-fw", dest="base_fw", metavar="F", help="firmware currently on device")
    p.add_argument("--wait-boot", dest="wait_boot", action="store_true", default=True)
    p.add_argument("--no-wait-boot", dest="wait_boot", action="store_false")

    p = add("bootloader", cmd_bootloader, "request ROM bootloader (--esp, default) or STM DFU")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--esp", action="store_true")
    g.add_argument("--stm", action="store_true")
    p.add_argument("--method", default="cdc,midi", help="order of transports to try")
    p.add_argument("--timeout", type=float, default=10.0, help="seconds to wait for the port")

    p = add("run", cmd_run, "run a HIL scenario: " + ", ".join(scenario_names()))
    rs = p.add_subparsers(dest="scenario", required=True, metavar="SCENARIO")
    for name in scenario_names():
        s_obj = get_scenario(name)
        q = rs.add_parser(name, help=s_obj.description, parents=[sub_common])
        scen.params_to_argparse(s_obj.Params, q)
        q.add_argument("--logdir", default="hil_logs", help="where <name>_<ts>/ is created")

    p = add("record", cmd_record, "record a CDC transcript (stdin commands) for replay tests")
    p.add_argument("--out", default="transcript.ndjson", metavar="FILE")

    add("serve", cmd_serve, "NDJSON daemon on stdio (used by crosspad-mcp)")
    return ap


# --------------------------------------------------------------------------- main

def _print_error(deps: CliDeps, as_json: bool, err: HilError) -> None:
    if as_json:
        deps.out().write(json.dumps({"ok": False, "error": err.to_dict()}) + "\n")
        deps.out().flush()
        return
    e = deps.err()
    e.write(f"error: {err.code}: {err.message}\n")
    if err.hint:
        e.write(f"hint: {err.hint}\n")
    if err.details.get("candidates"):
        for c in err.details["candidates"]:
            e.write(f"  candidate: {c.get('id')} usb_mode={c.get('usb_mode')}\n")
    e.flush()


def main(argv: list[str] | None = None, *, deps: CliDeps | None = None) -> int:
    deps = deps or CliDeps()
    parser = build_parser()
    args = list(sys.argv[1:] if argv is None else argv)
    # argparse writes to the real sys.std* — redirect so tests can capture --help / usage.
    saved = (sys.stdout, sys.stderr)
    sys.stdout, sys.stderr = deps.out(), deps.err()
    try:
        ns = parser.parse_args(args)
    except SystemExit as e:
        return int(e.code or 0) if isinstance(e.code, int) else 2
    finally:
        sys.stdout, sys.stderr = saved
    as_json = bool(getattr(ns, "as_json", False))
    try:
        res: CmdResult = ns.func(deps, ns)
    except HilError as e:
        _print_error(deps, as_json, e)
        return 2
    except KeyboardInterrupt:
        deps.err().write("interrupted\n")
        return 130
    if ns.command == "serve":
        return res.exit_code
    out = deps.out()
    if as_json:
        out.write(json.dumps(res.data, default=str) + "\n")
    elif res.text:
        out.write(res.text + "\n")
    out.flush()
    return res.exit_code


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
```

Add the console script to `pyproject.toml` (idempotent):

```bash
cd /home/matixan/GIT/crosspad-hil && grep -q '^\[project.scripts\]' pyproject.toml || printf '\n[project.scripts]\ncrosspad-hil = "crosspad_hil.cli:main"\n' >> pyproject.toml
grep -q 'crosspad-hil = "crosspad_hil.cli:main"' pyproject.toml || sed -i 's/^\[project.scripts\]$/[project.scripts]\ncrosspad-hil = "crosspad_hil.cli:main"/' pyproject.toml
pip install -e . >/dev/null && crosspad-hil --version
```

Expected: `crosspad-hil 1.0.0`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_cli.py -q && ruff check crosspad_hil/cli.py tests/test_cli.py`
Expected: `17 passed`, ruff `All checks passed!`.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/cli.py tests/test_cli.py pyproject.toml && git commit -m "feat(cli): crosspad-hil command tree with --json, injected deps and exit codes"
```

---

### Task 9: Daemon — `crosspad_hil/serve.py`

**Files:**
- Create: `/home/matixan/GIT/crosspad-hil/crosspad_hil/serve.py`
- Test: `/home/matixan/GIT/crosspad-hil/tests/test_serve.py`

**Interfaces:**
- Consumes: everything Task 8 consumes, plus `cli.doctor_checks`, `parsers.ConsoleEvent`, `console.Console(on_event=...)`, `ota.ota_flash(device, firmware, *, delta_base, progress, timeout_s, serial_factory, set_mode_fn)`, `console.Console.wait_boot(timeout_s) -> BootResult`, `midi.query_route(io, timeout_s)`, `snapshot.Snapshot`, and plan B-1's additive `scenarios.base.params_schema(params_cls) -> list[dict]` / `scenarios.base.params_from_dict(params_cls, d) -> Any`; `errors.PORT_BUSY`.
- Produces (contract verbatim):
  - `class HandleRegistry: __init__(self, clock: Callable[[], float] = time.monotonic, on_expire: Callable[[str, Any], None] | None = None); mint(prefix, obj, ttl_s) -> str; get(handle) -> Any; touch(handle) -> None; drop(handle) -> Any | None; sweep() -> list[str]; list() -> list[dict]`
  - `class Daemon: __init__(self, stdin, stdout, *, backends=None, serial_factory=open_serial, clock=time.monotonic, midi_factory=MidiIO, run_scenario_fn=run_scenario, ota_flash_fn=ota_flash, set_mode_fn=set_mode, handle_ttl_s=600.0, log=None); run() -> None; handle(req: dict) -> dict; emit(ev: dict) -> None`
  - Op names exactly: `serve.ping serve.shutdown devices.list devices.doctor console.open console.read console.expect console.reset console.wait_boot console.snapshot console.close cdc.open cdc.transact cdc.verb cdc.burst cdc.close midi.sysex midi.note midi.echo_rtt midi.query_route usbmode.set ota.flash snapshot.take scenario.list scenario.run task.status task.wait task.cancel task.list`
  - Events: `console.fatal console.reboot console.cdc_drops console.kit console.boot_complete task.progress task.done`
  - `class DaemonProgress(scenarios.base.Progress)`
  - Class constants `Daemon.SWEEP_S = 5.0` (handle-TTL sweep period; tests lower it) and `Daemon.DEV_LOCK_WAIT_S = 60.0` (bounded per-device lock wait → `PORT_BUSY`).
  - Task handles never expire (`ttl_s=None`); `task.list` reports them until the daemon exits. `task.done` events carry `result` (the `Report` as a dict, artifacts included) or `error`.

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/crosspad-hil/tests/test_serve.py`:

```python
"""Daemon tests: handle() dispatch, events, tasks, handle expiry, stdio round trip."""
from __future__ import annotations

import io
import json
import threading
import time
from dataclasses import dataclass, field

import pytest

from crosspad_hil import serve
from crosspad_hil.devices import Backends, SerialPortInfo, discover
from crosspad_hil.errors import HANDLE_EXPIRED, BAD_ARGS, HilError
from crosspad_hil.scenarios import base as scen
from tests.fakes import FakeSerial

CDC = "/dev/ttyACM0"
CON = "/dev/ttyACM1"


def _backends() -> Backends:
    ports = [
        SerialPortInfo(path=CDC, vid=0x303A, pid=0x3456, serial="AB12CD34",
                       product="CrossPad", location="1-1.2:1.0"),
        SerialPortInfo(path=CON, vid=0x0483, pid=0x5740, serial="STM0001",
                       product="CrossPad MIDI+Serial", location="1-1.3:1.0"),
    ]
    return Backends(list_serial=lambda: list(ports), list_midi=lambda: [],
                    list_audio=lambda: [])


@pytest.fixture
def lock_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    return tmp_path


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@dataclass
class Rig:
    daemon: serve.Daemon
    out: io.StringIO
    fakes: dict[str, FakeSerial]
    clock: Clock
    dev_id: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)

    def events(self, name: str) -> list[dict]:
        evs = []
        for line in self.out.getvalue().splitlines():
            obj = json.loads(line)
            if obj.get("ev") == name:
                evs.append(obj)
        return evs

    def wait(self, pred, timeout: float = 3.0) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if pred():
                return True
            time.sleep(0.02)
        return False


def _rig(lock_dir, cdc_script=(), **kw) -> Rig:
    fakes = {CDC: FakeSerial(list(cdc_script)), CON: FakeSerial([])}
    out = io.StringIO()
    clock = Clock()

    def factory(path: str, **_: object) -> FakeSerial:
        return fakes[path]

    d = serve.Daemon(io.StringIO(), out, backends=_backends(), serial_factory=factory,
                     clock=clock, handle_ttl_s=60.0, **kw)
    dev_id = discover(_backends())[0].id
    return Rig(d, out, fakes, clock, dev_id)


def _ok(resp: dict) -> dict:
    assert resp["ok"] is True, resp
    return resp["result"]


def _err(resp: dict) -> dict:
    assert resp["ok"] is False, resp
    return resp["error"]


# ---------------------------------------------------------------- HandleRegistry

def test_registry_mint_get_expire():
    clock = Clock()
    closed: list[tuple[str, object]] = []
    reg = serve.HandleRegistry(clock=clock, on_expire=lambda h, o: closed.append((h, o)))
    h1 = reg.mint("con", "A", ttl_s=10)
    h2 = reg.mint("con", "B", ttl_s=None)
    t1 = reg.mint("task", "T", ttl_s=None)
    assert (h1, h2, t1) == ("con_1", "con_2", "task_1")
    assert reg.get(h1) == "A"
    clock.t += 11
    with pytest.raises(HilError) as ei:
        reg.get(h1)
    assert ei.value.code == HANDLE_EXPIRED and ei.value.hint == "open again"
    assert closed == [(h1, "A")]
    assert reg.get(h2) == "B"
    with pytest.raises(HilError) as ei:
        reg.get("con_99")
    assert ei.value.code == HANDLE_EXPIRED
    assert reg.drop(h2) == "B" and reg.drop(h2) is None
    assert [e["handle"] for e in reg.list()] == [t1]


def test_registry_sweep_and_touch():
    clock = Clock()
    reg = serve.HandleRegistry(clock=clock)
    h = reg.mint("cdc", object(), ttl_s=5)
    clock.t += 4
    reg.touch(h)
    clock.t += 4
    assert reg.sweep() == []
    clock.t += 2
    assert reg.sweep() == [h]
    assert reg.list() == []


# ---------------------------------------------------------------- dispatch basics

def test_ping_and_unknown_op(lock_dir):
    rig = _rig(lock_dir)
    r = _ok(rig.daemon.handle({"id": 1, "op": "serve.ping", "args": {}}))
    assert r["version"] and r["uptime_s"] >= 0
    e = _err(rig.daemon.handle({"id": 2, "op": "nope.op"}))
    assert e["code"] == BAD_ARGS and "serve.ping" in e["hint"]
    e = _err(rig.daemon.handle({"id": 3, "args": {}}))
    assert e["code"] == BAD_ARGS


def test_devices_list_and_doctor(lock_dir):
    rig = _rig(lock_dir)
    r = _ok(rig.daemon.handle({"id": 1, "op": "devices.list"}))
    assert r["devices"][0]["id"] == rig.dev_id
    r = _ok(rig.daemon.handle({"id": 2, "op": "devices.doctor"}))
    assert {c["name"] for c in r["checks"]} >= {"python", "devices", "locks"}


def test_cdc_verb_ephemeral_and_handle(lock_dir):
    rig = _rig(lock_dir, [("APP_LIST", "APPS: Sampler,Settings running=-"),
                          ("KIT_STATUS", "KITSTATUS: current=2 loading=0 pending=-1 name=X")])
    r = _ok(rig.daemon.handle({"id": 1, "op": "cdc.verb",
                               "args": {"device": rig.dev_id, "verb": "app_list", "args": {}}}))
    assert r == {"apps": ["Sampler", "Settings"], "running": None}
    h = _ok(rig.daemon.handle({"id": 2, "op": "cdc.open", "args": {"device": rig.dev_id}}))["handle"]
    assert h == "cdc_1"
    r = _ok(rig.daemon.handle({"id": 3, "op": "cdc.transact",
                               "args": {"handle": h, "cmd": "KIT_STATUS"}}))
    assert r["parsed"]["current"] == 2 and r["line"].startswith("KITSTATUS:")
    e = _err(rig.daemon.handle({"id": 4, "op": "cdc.verb",
                                "args": {"handle": h, "verb": "no_such_verb", "args": {}}}))
    assert e["code"] == BAD_ARGS
    e = _err(rig.daemon.handle({"id": 5, "op": "cdc.verb",
                                "args": {"handle": h, "verb": "pad_press", "args": {"idx": 99}}}))
    assert e["code"] == BAD_ARGS
    assert _ok(rig.daemon.handle({"id": 6, "op": "cdc.close", "args": {"handle": h}})) == {"ok": True}
    e = _err(rig.daemon.handle({"id": 7, "op": "cdc.transact", "args": {"handle": h, "cmd": "MEM"}}))
    assert e["code"] == HANDLE_EXPIRED
    assert rig.fakes[CDC].dtr is False and rig.fakes[CDC].rts is False


# ---------------------------------------------------------------- console + events

def test_console_open_fatal_event(lock_dir):
    rig = _rig(lock_dir)
    r = _ok(rig.daemon.handle({"id": 1, "op": "console.open", "args": {"device": rig.dev_id}}))
    assert r["handle"] == "con_1" and r["port"] == CON
    con = rig.fakes[CON]
    assert con.dtr is False and con.rts is False  # hygiene: STM VCP never asserted
    con.feed(["I (1234) main: hello",
              "Guru Meditation Error: Core  0 panic'ed (LoadProhibited). Exception was unhandled."])
    assert rig.wait(lambda: rig.events("console.fatal"))
    ev = rig.events("console.fatal")[0]
    assert ev["handle"] == "con_1" and ev["pattern"] == "Guru Meditation"
    assert "panic'ed" in ev["line"] and isinstance(ev["seq"], int)
    r = _ok(rig.daemon.handle({"id": 2, "op": "console.read",
                               "args": {"handle": "con_1", "match": "hello"}}))
    assert len(r["lines"]) == 1 and r["lines"][0][1].endswith("hello")
    r = _ok(rig.daemon.handle({"id": 3, "op": "console.snapshot", "args": {"handle": "con_1"}}))
    assert len(r["fatals"]) == 1
    assert _ok(rig.daemon.handle({"id": 4, "op": "console.close", "args": {"handle": "con_1"}}))


def test_console_reboot_and_cdc_drop_events(lock_dir):
    rig = _rig(lock_dir)
    _ok(rig.daemon.handle({"id": 1, "op": "console.open", "args": {"device": rig.dev_id}}))
    con = rig.fakes[CON]
    con.feed(["ESP-ROM:esp32s3-20210327",
              "W (5000) CDC: 12 commands dropped",
              "ESP-ROM:esp32s3-20210327"])
    assert rig.wait(lambda: rig.events("console.cdc_drops"))
    assert rig.events("console.cdc_drops")[0]["dropped"] == 12
    assert rig.wait(lambda: rig.events("console.reboot"))
    reboots = rig.events("console.reboot")
    assert reboots[-1]["handle"] == "con_1"
    assert isinstance(reboots[-1]["count"], int) and reboots[-1]["count"] >= len(reboots) - 1
    assert reboots[-1]["line"].startswith("ESP-ROM:esp32s3")


def test_console_reset_pulses_and_releases(lock_dir):
    rig = _rig(lock_dir)
    _ok(rig.daemon.handle({"id": 1, "op": "console.open", "args": {"device": rig.dev_id}}))
    _ok(rig.daemon.handle({"id": 2, "op": "console.reset", "args": {"handle": "con_1"}}))
    con = rig.fakes[CON]
    assert ("rts", True) in con.control_history
    assert con.rts is False and con.dtr is False


# ---------------------------------------------------------------- handle expiry

def test_handle_expiry(lock_dir):
    rig = _rig(lock_dir)
    _ok(rig.daemon.handle({"id": 1, "op": "console.open", "args": {"device": rig.dev_id}}))
    rig.clock.t += 61
    e = _err(rig.daemon.handle({"id": 2, "op": "console.read", "args": {"handle": "con_1"}}))
    assert e["code"] == HANDLE_EXPIRED and e["hint"] == "open again"
    assert rig.fakes[CON].is_open is False  # the sweep closed it


# ---------------------------------------------------------------- scenario tasks

@dataclass
class FakeParams:
    rounds: int = 3
    label: str = "x"


class FakeScenario:
    name = "fake_scn"
    Params = FakeParams
    description = "test scenario"

    def run(self, ctx, params, progress):  # pragma: no cover - replaced by run_scenario_fn
        raise AssertionError("not used")


def _fake_run(started: threading.Event, release: threading.Event):
    def run(name, params, *, device=None, workdir=None, progress=None, cancelled=None, log=print):
        started.set()
        for i in range(1, params.rounds + 1):
            if cancelled.is_set():
                raise HilError("CANCELLED", "cancelled by request")
            progress(i, params.rounds, f"round {i}/{params.rounds}")
            release.wait(2.0)
        return scen.Report(passed=True, summary=f"{name} ok", data={"rounds": params.rounds},
                           artifacts=[scen.Artifact(path="report.json", mime="application/json",
                                                    role="report")], exit_code=0)
    return run


def test_scenario_list_and_task_lifecycle(lock_dir):
    scen.register(FakeScenario())
    started, release = threading.Event(), threading.Event()
    release.set()
    rig = _rig(lock_dir, run_scenario_fn=_fake_run(started, release))
    r = _ok(rig.daemon.handle({"id": 1, "op": "scenario.list"}))
    entry = next(s for s in r["scenarios"] if s["name"] == "fake_scn")
    assert entry["description"] == "test scenario"
    assert {p["name"] for p in entry["params"]} == {"rounds", "label"}
    assert next(p for p in entry["params"] if p["name"] == "rounds")["default"] == 3

    r = _ok(rig.daemon.handle({"id": 2, "op": "scenario.run",
                               "args": {"name": "fake_scn", "params": {"rounds": 2},
                                        "device": rig.dev_id}}))
    task = r["task"]
    assert task == "task_1"
    r = _ok(rig.daemon.handle({"id": 3, "op": "task.wait", "args": {"task": task, "timeout_s": 3}}))
    assert r["status"] == "completed"
    assert r["result"]["passed"] is True and r["result"]["data"]["rounds"] == 2
    assert r["progress"] == 2 and r["total"] == 2
    progress = rig.events("task.progress")
    assert [p["progress"] for p in progress] == [1, 2]
    done = rig.events("task.done")
    assert done and done[0]["task"] == task and done[0]["status"] == "completed"
    assert done[0]["result"]["artifacts"][0]["path"] == "report.json"
    assert _ok(rig.daemon.handle({"id": 4, "op": "task.list"}))["tasks"][0]["task"] == task


def test_scenario_bad_params_and_cancel(lock_dir):
    scen.register(FakeScenario())
    started, release = threading.Event(), threading.Event()
    rig = _rig(lock_dir, run_scenario_fn=_fake_run(started, release))
    e = _err(rig.daemon.handle({"id": 1, "op": "scenario.run",
                                "args": {"name": "fake_scn", "params": {"bogus": 1}}}))
    assert e["code"] == BAD_ARGS
    e = _err(rig.daemon.handle({"id": 2, "op": "scenario.run", "args": {"name": "no_such"}}))
    assert e["code"] == BAD_ARGS

    task = _ok(rig.daemon.handle({"id": 3, "op": "scenario.run",
                                  "args": {"name": "fake_scn", "params": {"rounds": 5}}}))["task"]
    assert started.wait(2.0)
    r = _ok(rig.daemon.handle({"id": 4, "op": "task.status", "args": {"task": task}}))
    assert r["status"] == "working"
    assert _ok(rig.daemon.handle({"id": 5, "op": "task.cancel", "args": {"task": task}})) == {"ok": True}
    release.set()
    r = _ok(rig.daemon.handle({"id": 6, "op": "task.wait", "args": {"task": task, "timeout_s": 3}}))
    assert r["status"] == "cancelled" and r["error"]["code"] == "CANCELLED"
    e = _err(rig.daemon.handle({"id": 7, "op": "task.status", "args": {"task": "task_42"}}))
    assert e["code"] == HANDLE_EXPIRED


# ---------------------------------------------------------------- stdio round trip

def test_run_stdio_pipe(lock_dir):
    reqs = [
        {"id": 1, "op": "serve.ping", "args": {}},
        {"id": 2, "op": "devices.list"},
        "this is not json",
        {"id": 3, "op": "serve.shutdown"},
    ]
    stdin = io.StringIO("".join((json.dumps(r) if isinstance(r, dict) else r) + "\n" for r in reqs))
    out = io.StringIO()
    fakes = {CDC: FakeSerial([]), CON: FakeSerial([])}
    d = serve.Daemon(stdin, out, backends=_backends(), serial_factory=lambda p, **_: fakes[p])
    d.SWEEP_S = 0.05
    t = threading.Thread(target=d.run, daemon=True)
    t.start()
    t.join(5.0)
    assert not t.is_alive(), "daemon did not stop on serve.shutdown"
    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    by_id = {r.get("id"): r for r in lines if "id" in r}
    assert by_id[1]["ok"] and by_id[1]["result"]["version"]
    assert by_id[2]["ok"] and by_id[2]["result"]["devices"]
    assert by_id[3] == {"id": 3, "ok": True, "result": {"ok": True}}
    assert by_id[None]["ok"] is False and by_id[None]["error"]["code"] == BAD_ARGS
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_serve.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'crosspad_hil.serve'`.

- [ ] **Step 3: Write minimal implementation**

`/home/matixan/GIT/crosspad-hil/crosspad_hil/serve.py`:

```python
"""NDJSON daemon on stdio (`crosspad-hil serve`), the transport crosspad-mcp talks to.

Request  {"id": int, "op": str, "args": dict}
Response {"id", "ok": true, "result"} | {"id", "ok": false, "error": HilError.to_dict()}
Event    {"ev": str, ...}          (console.*, task.*)
Logs go to stderr only. Pattern mirrors crosspad-mcp/tracer/swd_tracer.py: a
reader thread consumes stdin, every op runs on a worker, stdout writes are
serialized by one lock so lines never interleave.
"""
from __future__ import annotations

import dataclasses
import itertools
import json
import sys
import threading
import time
import traceback
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, TextIO

from . import __version__, verbs
from .cdc import CdcLink
from .console import Console
from .devices import Backends, Device, UsbMode, discover, select
from .errors import (
    BAD_ARGS,
    CANCELLED,
    ENV,
    HANDLE_EXPIRED,
    NO_CDC_IN_AUDIO_MODE,
    NO_DEVICE,
    PORT_BUSY,
    HilError,
)
from .midi import MidiIO, MidiRole, echo_rtt, query_route
from .ota import ota_flash
from .parsers import ConsoleEvent
from .scenarios import app_churn, kit_churn, led_state, smoke, usb_mode_cycle  # noqa: F401
from .scenarios import base as scen
from .scenarios import get as get_scenario
from .scenarios import names as scenario_names
from .serial_open import open_serial
from .snapshot import Snapshot, take_snapshot
from .usbmode import set_mode

_MISSING = object()


def _json_default(o: Any) -> Any:
    if dataclasses.is_dataclass(o) and not isinstance(o, type):
        return dataclasses.asdict(o)
    if isinstance(o, Enum):
        return o.value
    if isinstance(o, Path):
        return str(o)
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    if isinstance(o, bytes):
        return o.hex()
    return str(o)


def _arg(args: dict, name: str, typ: type | tuple[type, ...], default: Any = _MISSING) -> Any:
    if name not in args or args[name] is None:
        if default is _MISSING:
            raise HilError(BAD_ARGS, f"missing argument {name!r}")
        return default
    v = args[name]
    if typ is float and isinstance(v, int) and not isinstance(v, bool):
        v = float(v)
    if typ is int and isinstance(v, bool):
        raise HilError(BAD_ARGS, f"argument {name!r} must be int, got bool")
    if not isinstance(v, typ):
        want = typ.__name__ if isinstance(typ, type) else "/".join(t.__name__ for t in typ)
        raise HilError(BAD_ARGS, f"argument {name!r} must be {want}, got {type(v).__name__}")
    return v


# --------------------------------------------------------------------------- handles

@dataclass
class _Entry:
    obj: Any
    prefix: str
    created: float
    last_used: float
    ttl_s: float | None


class HandleRegistry:
    """Thread-safe handle table with idle TTL. Handles look like "con_1", "task_3"."""

    def __init__(self, clock: Callable[[], float] = time.monotonic,
                 on_expire: Callable[[str, Any], None] | None = None) -> None:
        self._clock = clock
        self._on_expire = on_expire
        self._lock = threading.Lock()
        self._entries: dict[str, _Entry] = {}
        self._counters: dict[str, itertools.count] = {}

    def mint(self, prefix: str, obj: Any, ttl_s: float | None) -> str:
        with self._lock:
            counter = self._counters.setdefault(prefix, itertools.count(1))
            handle = f"{prefix}_{next(counter)}"
            now = self._clock()
            self._entries[handle] = _Entry(obj, prefix, now, now, ttl_s)
            return handle

    @staticmethod
    def _expired(e: _Entry, now: float) -> bool:
        return e.ttl_s is not None and (now - e.last_used) > e.ttl_s

    def get(self, handle: str) -> Any:
        expired: _Entry | None = None
        with self._lock:
            e = self._entries.get(handle)
            now = self._clock()
            if e is None:
                raise HilError(HANDLE_EXPIRED, f"unknown handle {handle!r}", hint="open again",
                               handle=handle)
            if self._expired(e, now):
                expired = self._entries.pop(handle)
            else:
                e.last_used = now
                return e.obj
        if self._on_expire is not None and expired is not None:
            self._on_expire(handle, expired.obj)
        assert expired is not None
        raise HilError(HANDLE_EXPIRED,
                       f"handle {handle} expired after {expired.ttl_s:.0f}s idle",
                       hint="open again", handle=handle)

    def touch(self, handle: str) -> None:
        with self._lock:
            e = self._entries.get(handle)
            if e is not None:
                e.last_used = self._clock()

    def drop(self, handle: str) -> Any | None:
        with self._lock:
            e = self._entries.pop(handle, None)
        return None if e is None else e.obj

    def sweep(self) -> list[str]:
        dead: list[tuple[str, _Entry]] = []
        with self._lock:
            now = self._clock()
            for h, e in list(self._entries.items()):
                if self._expired(e, now):
                    dead.append((h, self._entries.pop(h)))
        for h, e in dead:
            if self._on_expire is not None:
                self._on_expire(h, e.obj)
        return [h for h, _ in dead]

    def list(self) -> list[dict]:
        with self._lock:
            now = self._clock()
            return [{"handle": h, "kind": e.prefix, "age_s": round(now - e.created, 1),
                     "idle_s": round(now - e.last_used, 1), "ttl_s": e.ttl_s}
                    for h, e in self._entries.items()]

    def all_handles(self) -> list[str]:
        with self._lock:
            return list(self._entries)


# --------------------------------------------------------------------------- sessions

@dataclass
class _ConsoleSession:
    console: Console
    device_id: str
    port: str
    log_path: str | None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def close(self) -> None:
        self.console.close()


@dataclass
class _CdcSession:
    link: CdcLink
    device_id: str
    lock: threading.Lock = field(default_factory=threading.Lock)

    def close(self) -> None:
        self.link.close()


@dataclass
class _Task:
    handle: str
    kind: str
    status: str = "working"
    progress: int = 0
    total: int | None = None
    message: str = ""
    result: Any = None
    error: dict | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    future: Future | None = None

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"task": self.handle, "kind": self.kind, "status": self.status,
                             "progress": self.progress, "total": self.total,
                             "message": self.message}
        if self.result is not None:
            d["result"] = self.result
        if self.error is not None:
            d["error"] = self.error
        return d

    def close(self) -> None:
        self.cancelled.set()


class DaemonProgress(scen.Progress):
    def __init__(self, daemon: Daemon, task: _Task) -> None:
        self._daemon = daemon
        self._task = task

    def __call__(self, progress: int, total: int | None, message: str) -> None:
        self._task.progress = int(progress)
        self._task.total = total
        self._task.message = message
        self._daemon.emit({"ev": "task.progress", "task": self._task.handle,
                           "progress": int(progress), "total": total, "message": message})


# --------------------------------------------------------------------------- daemon

class Daemon:
    SWEEP_S = 5.0
    DEV_LOCK_WAIT_S = 60.0

    def __init__(self, stdin: TextIO, stdout: TextIO, *,
                 backends: Backends | None = None,
                 serial_factory: Callable[..., Any] = open_serial,
                 clock: Callable[[], float] = time.monotonic,
                 midi_factory: Callable[..., Any] = MidiIO,
                 run_scenario_fn: Callable[..., scen.Report] = scen.run_scenario,
                 ota_flash_fn: Callable[..., dict] = ota_flash,
                 set_mode_fn: Callable[..., Device] = set_mode,
                 handle_ttl_s: float = 600.0,
                 log: Callable[[str], None] | None = None) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self._backends = backends
        self._serial_factory = serial_factory
        self._clock = clock
        self._midi_factory = midi_factory
        self._run_scenario_fn = run_scenario_fn
        self._ota_flash_fn = ota_flash_fn
        self._set_mode_fn = set_mode_fn
        self._ttl = handle_ttl_s
        self._log = log or (lambda m: (sys.stderr.write(m.rstrip("\n") + "\n"), sys.stderr.flush()))
        self._out_lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="hil-op")
        self._handles = HandleRegistry(clock=clock, on_expire=self._on_expire)
        self._devlocks: dict[str, threading.Lock] = {}
        self._devlocks_guard = threading.Lock()
        self._snap_counter = itertools.count(1)
        self._stop = threading.Event()
        self._t0 = time.monotonic()
        self._ops: dict[str, Callable[[dict], Any]] = {
            "serve.ping": self._op_ping,
            "serve.shutdown": self._op_shutdown,
            "devices.list": self._op_devices_list,
            "devices.doctor": self._op_devices_doctor,
            "console.open": self._op_console_open,
            "console.read": self._op_console_read,
            "console.expect": self._op_console_expect,
            "console.reset": self._op_console_reset,
            "console.wait_boot": self._op_console_wait_boot,
            "console.snapshot": self._op_console_snapshot,
            "console.close": self._op_console_close,
            "cdc.open": self._op_cdc_open,
            "cdc.transact": self._op_cdc_transact,
            "cdc.verb": self._op_cdc_verb,
            "cdc.burst": self._op_cdc_burst,
            "cdc.close": self._op_cdc_close,
            "midi.sysex": self._op_midi_sysex,
            "midi.note": self._op_midi_note,
            "midi.echo_rtt": self._op_midi_echo_rtt,
            "midi.query_route": self._op_midi_query_route,
            "usbmode.set": self._op_usbmode_set,
            "ota.flash": self._op_ota_flash,
            "snapshot.take": self._op_snapshot_take,
            "scenario.list": self._op_scenario_list,
            "scenario.run": self._op_scenario_run,
            "task.status": self._op_task_status,
            "task.wait": self._op_task_wait,
            "task.cancel": self._op_task_cancel,
            "task.list": self._op_task_list,
        }

    # ----------------------------------------------------------------- transport

    def run(self) -> None:
        reader = threading.Thread(target=self._reader, name="ndjson-reader", daemon=True)
        reader.start()
        try:
            while not self._stop.wait(self.SWEEP_S):
                for h in self._handles.sweep():
                    self._log(f"handle {h} expired")
        finally:
            self._shutdown_all()

    def _reader(self) -> None:
        try:
            for raw in self._stdin:
                line = raw.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                except ValueError as e:
                    self.emit({"id": None, "ok": False,
                               "error": HilError(BAD_ARGS, f"malformed JSON: {e}").to_dict()})
                    continue
                if not isinstance(req, dict):
                    self.emit({"id": None, "ok": False,
                               "error": HilError(BAD_ARGS, "request must be an object").to_dict()})
                    continue
                if self._stop.is_set():
                    break
                self._pool.submit(self._serve_one, req)
        finally:
            self._stop.set()  # EOF: the parent went away, or serve.shutdown was queued

    def _serve_one(self, req: dict) -> None:
        resp = self.handle(req)
        self.emit(resp)
        if req.get("op") == "serve.shutdown" and resp.get("ok"):
            self._stop.set()

    def handle(self, req: dict) -> dict:
        rid = req.get("id")
        op = req.get("op")
        args = req.get("args", {})
        try:
            if not isinstance(op, str):
                raise HilError(BAD_ARGS, "missing 'op'")
            if args is None:
                args = {}
            if not isinstance(args, dict):
                raise HilError(BAD_ARGS, "'args' must be an object")
            fn = self._ops.get(op)
            if fn is None:
                raise HilError(BAD_ARGS, f"unknown op {op!r}",
                               hint="ops: " + ", ".join(sorted(self._ops)))
            return {"id": rid, "ok": True, "result": fn(args)}
        except HilError as e:
            return {"id": rid, "ok": False, "error": e.to_dict()}
        except Exception as e:  # noqa: BLE001 — every failure must become a response
            self._log(traceback.format_exc())
            return {"id": rid, "ok": False,
                    "error": HilError(ENV, f"{type(e).__name__}: {e}", op=op).to_dict()}

    def emit(self, ev: dict) -> None:
        line = json.dumps(ev, default=_json_default)
        with self._out_lock:
            self._stdout.write(line + "\n")
            self._stdout.flush()

    def _shutdown_all(self) -> None:
        # 1. tell every task to stop, 2. let in-flight ops write their responses,
        # 3. close whatever is still open (ports, tasks) so the locks are released.
        for h in self._handles.all_handles():
            try:
                obj = self._handles.get(h)
            except HilError:
                continue
            if isinstance(obj, _Task):
                obj.cancelled.set()
        self._pool.shutdown(wait=True, cancel_futures=True)
        for h in self._handles.all_handles():
            obj = self._handles.drop(h)
            if obj is not None:
                self._safe_close(h, obj)

    def _on_expire(self, handle: str, obj: Any) -> None:
        self._safe_close(handle, obj)

    def _safe_close(self, handle: str, obj: Any) -> None:
        try:
            obj.close()
        except Exception as e:  # noqa: BLE001
            self._log(f"closing {handle}: {e}")

    # ----------------------------------------------------------------- devices / locks

    def _resolve(self, args: dict) -> Device:
        device = args.get("device")
        if device is not None and not isinstance(device, str):
            raise HilError(BAD_ARGS, "'device' must be a string (id or port path)")
        return select(discover(self._backends), device)

    @contextmanager
    def _dev_lock(self, device_id: str) -> Iterator[None]:
        with self._devlocks_guard:
            lock = self._devlocks.setdefault(device_id, threading.Lock())
        if not lock.acquire(timeout=self.DEV_LOCK_WAIT_S):
            raise HilError(PORT_BUSY,
                           f"{device_id} is busy (another op held it for {self.DEV_LOCK_WAIT_S:.0f}s)",
                           hint="another op or task on this device is running; task.list / "
                                "task.cancel", device=device_id)
        try:
            yield
        finally:
            lock.release()

    def _open_cdc(self, dev: Device) -> CdcLink:
        if dev.ports.cdc is None:
            if dev.usb_mode == UsbMode.AUDIO:
                raise HilError(NO_CDC_IN_AUDIO_MODE,
                               f"{dev.id} is in the MIDI+UAC2 profile; CDC endpoint absent",
                               hint="usbmode.set mode=default (SysEx 0x1B on the ESP MIDI port) "
                                    "then retry", device=dev.id)
            raise HilError(NO_DEVICE, f"{dev.id} has no CDC port (usb_mode={dev.usb_mode.value})",
                           hint="is the board in bootloader/DFU?", device=dev.id)
        link = CdcLink(dev.ports.cdc.path, serial_factory=self._serial_factory)
        link.open()
        return link

    def _console_port(self, dev: Device) -> str:
        if dev.ports.console is None:
            raise HilError(NO_DEVICE, f"{dev.id} has no STM32 bridge VCP (0x0483:0x5740)",
                           hint="the console comes off the STM bridge, not the ESP CDC",
                           device=dev.id)
        return dev.ports.console.path

    def _session(self, args: dict, cls: type, key: str = "handle") -> Any:
        handle = _arg(args, key, str)
        sess = self._handles.get(handle)
        if not isinstance(sess, cls):
            raise HilError(BAD_ARGS, f"{handle} is not a {cls.__name__.strip('_').lower()} handle")
        return sess

    @contextmanager
    def _cdc_from(self, args: dict) -> Iterator[CdcLink]:
        if args.get("handle") is not None:
            sess = self._session(args, _CdcSession)
            with sess.lock:
                yield sess.link
            return
        dev = self._resolve(args)
        with self._dev_lock(dev.id):
            link = self._open_cdc(dev)
            try:
                yield link
            finally:
                link.close()

    # ----------------------------------------------------------------- tasks

    def _start_task(self, kind: str, fn: Callable[[_Task], Any]) -> str:
        task = _Task(handle="", kind=kind)
        handle = self._handles.mint("task", task, None)
        task.handle = handle

        def body() -> None:
            try:
                if task.cancelled.is_set():
                    raise HilError(CANCELLED, "cancelled before start")
                task.result = fn(task)
                task.status = "completed"
                self.emit({"ev": "task.done", "task": handle, "status": "completed",
                           "result": task.result})
            except HilError as e:
                task.error = e.to_dict()
                task.status = "cancelled" if e.code == CANCELLED else "failed"
                self.emit({"ev": "task.done", "task": handle, "status": task.status,
                           "error": task.error})
            except Exception as e:  # noqa: BLE001
                self._log(traceback.format_exc())
                task.error = HilError(ENV, f"{type(e).__name__}: {e}").to_dict()
                task.status = "failed"
                self.emit({"ev": "task.done", "task": handle, "status": "failed",
                           "error": task.error})
            finally:
                task.done.set()

        task.future = self._pool.submit(body)
        return handle

    def _task(self, args: dict) -> _Task:
        return self._session(args, _Task, key="task")

    # ----------------------------------------------------------------- ops: serve

    def _op_ping(self, args: dict) -> dict:
        return {"version": __version__, "uptime_s": round(time.monotonic() - self._t0, 3)}

    def _op_shutdown(self, args: dict) -> dict:
        return {"ok": True}

    # ----------------------------------------------------------------- ops: devices

    def _op_devices_list(self, args: dict) -> dict:
        return {"devices": [d.to_dict() for d in discover(self._backends)]}

    def _op_devices_doctor(self, args: dict) -> dict:
        from .cli import doctor_checks

        return {"checks": doctor_checks(self._backends)}

    # ----------------------------------------------------------------- ops: console

    def _op_console_open(self, args: dict) -> dict:
        dev = self._resolve(args)
        port = self._console_port(dev)
        reset = _arg(args, "reset", bool, False)
        log_to = _arg(args, "log_to", str, None)
        holder: dict[str, str] = {}

        def on_event(ev: ConsoleEvent) -> None:
            h = holder.get("handle")
            if h is not None:
                self._console_event(h, ev)

        con = Console(port, log_path=Path(log_to) if log_to else None,
                      serial_factory=self._serial_factory, on_event=on_event)
        with self._dev_lock(dev.id):
            con.open(reset=reset)
        sess = _ConsoleSession(con, dev.id, port, log_to)
        holder["handle"] = self._handles.mint("con", sess, self._ttl)
        return {"handle": holder["handle"], "port": port, "log_path": log_to}

    def _console_event(self, handle: str, ev: ConsoleEvent) -> None:
        base = {"handle": handle, "seq": ev.seq}
        if ev.kind == "fatal":
            self.emit({"ev": "console.fatal", **base, "pattern": ev.data.get("pattern"),
                       "line": ev.line})
        elif ev.kind == "reboot":
            self.emit({"ev": "console.reboot", **base, "count": ev.data.get("count"),
                       "line": ev.line})
        elif ev.kind == "cdc_drops":
            self.emit({"ev": "console.cdc_drops", **base, "dropped": ev.data.get("dropped")})
        elif ev.kind == "kit":
            self.emit({"ev": "console.kit", **base, "kit": ev.data.get("kit"),
                       "state": ev.data.get("state")})
        elif ev.kind == "boot_complete":
            self.emit({"ev": "console.boot_complete", **base,
                       "missing": list(ev.data.get("missing") or [])})

    def _op_console_read(self, args: dict) -> dict:
        sess = self._session(args, _ConsoleSession)
        with sess.lock:
            r = sess.console.read(since_seq=_arg(args, "since_seq", int, None),
                                  wait_ms=_arg(args, "wait_ms", int, 0),
                                  match=_arg(args, "match", str, None),
                                  limit=min(_arg(args, "limit", int, 2000), 2000))
        return {"lines": [[seq, line] for seq, line in r.lines], "next_seq": r.next_seq,
                "lines_lost": r.lines_lost}

    def _op_console_expect(self, args: dict) -> dict:
        sess = self._session(args, _ConsoleSession)
        patterns = _arg(args, "patterns", list)
        reject = _arg(args, "reject", list, [])
        timeout_s = _arg(args, "timeout_s", (int, float), 30.0)
        if not patterns or not all(isinstance(p, str) for p in patterns):
            raise HilError(BAD_ARGS, "'patterns' must be a non-empty list of regex strings")
        with sess.lock:
            r = sess.console.expect([str(p) for p in patterns], [str(p) for p in reject],
                                    timeout_s=float(timeout_s))
        return dataclasses.asdict(r)

    def _op_console_reset(self, args: dict) -> dict:
        sess = self._session(args, _ConsoleSession)
        with sess.lock, self._dev_lock(sess.device_id):
            sess.console.reset()
        return {"ok": True}

    def _op_console_wait_boot(self, args: dict) -> dict:
        sess = self._session(args, _ConsoleSession)
        timeout_s = _arg(args, "timeout_s", (int, float), None)
        with sess.lock:
            r = sess.console.wait_boot(timeout_s=None if timeout_s is None else float(timeout_s))
        return dataclasses.asdict(r)

    def _op_console_snapshot(self, args: dict) -> dict:
        sess = self._session(args, _ConsoleSession)
        with sess.lock:
            return sess.console.snapshot()

    def _op_console_close(self, args: dict) -> dict:
        handle = _arg(args, "handle", str)
        sess = self._handles.drop(handle)
        if sess is None:
            raise HilError(HANDLE_EXPIRED, f"unknown handle {handle!r}", hint="open again")
        self._safe_close(handle, sess)
        return {"ok": True}

    # ----------------------------------------------------------------- ops: cdc

    def _op_cdc_open(self, args: dict) -> dict:
        dev = self._resolve(args)
        with self._dev_lock(dev.id):
            link = self._open_cdc(dev)
        return {"handle": self._handles.mint("cdc", _CdcSession(link, dev.id), self._ttl),
                "port": dev.ports.cdc.path if dev.ports.cdc else None}

    def _op_cdc_transact(self, args: dict) -> dict:
        cmd = _arg(args, "cmd", str)
        expect = _arg(args, "expect", str, None)
        timeout_s = _arg(args, "timeout_s", (int, float), 2.0)
        with self._cdc_from(args) as link:
            r = link.transact(cmd, expect=expect, timeout_s=float(timeout_s))
        return {"line": r.line, "parsed": r.parsed, "rtt_ms": r.rtt_ms,
                "extra_lines": r.extra_lines}

    def _op_cdc_verb(self, args: dict) -> Any:
        verb = _arg(args, "verb", str)
        vargs = _arg(args, "args", dict, {})
        fn = getattr(verbs, verb, None)
        if fn is None or verb.startswith("_") or not callable(fn):
            raise HilError(BAD_ARGS, f"unknown verb {verb!r}",
                           hint="verb = a function name in crosspad_hil.verbs, e.g. kit_status")
        with self._cdc_from(args) as link:
            try:
                r = fn(link, **vargs)
            except TypeError as e:
                raise HilError(BAD_ARGS, f"{verb}: {e}") from e
        return r if r is not None else {"ok": True}

    def _op_cdc_burst(self, args: dict) -> dict:
        sess = self._session(args, _CdcSession)
        cmds = _arg(args, "cmds", list)
        rate_hz = float(_arg(args, "rate_hz", (int, float)))
        if not cmds or not all(isinstance(c, str) for c in cmds):
            raise HilError(BAD_ARGS, "'cmds' must be a non-empty list of strings")
        with sess.lock:
            r = sess.link.burst([str(c) for c in cmds], rate_hz)
        return dataclasses.asdict(r)

    def _op_cdc_close(self, args: dict) -> dict:
        handle = _arg(args, "handle", str)
        sess = self._handles.drop(handle)
        if sess is None:
            raise HilError(HANDLE_EXPIRED, f"unknown handle {handle!r}", hint="open again")
        self._safe_close(handle, sess)
        return {"ok": True}

    # ----------------------------------------------------------------- ops: midi

    @contextmanager
    def _midi(self, args: dict) -> Iterator[Any]:
        dev = self._resolve(args)
        role_s = _arg(args, "role", str, "esp")
        try:
            role = MidiRole(role_s)
        except ValueError as e:
            raise HilError(BAD_ARGS, f"role must be esp|stm, got {role_s!r}") from e
        io = self._midi_factory(dev, role)
        with self._dev_lock(dev.id):
            io.open()
            try:
                yield io
            finally:
                io.close()

    def _op_midi_sysex(self, args: dict) -> dict:
        hex_s = _arg(args, "frame", str)
        try:
            frame = bytes.fromhex(hex_s.replace(" ", "").replace(",", ""))
        except ValueError as e:
            raise HilError(BAD_ARGS, f"frame is not a hex string: {hex_s!r}") from e
        with self._midi(args) as io:
            io.send_sysex(frame)
        return {"sent": len(frame)}

    def _op_midi_note(self, args: dict) -> dict:
        on = _arg(args, "on", bool)
        note = _arg(args, "note", int)
        vel = _arg(args, "vel", int, 100)
        channel = _arg(args, "channel", int, 0)
        if not 0 <= note <= 127 or not 0 <= vel <= 127 or not 0 <= channel <= 15:
            raise HilError(BAD_ARGS, "note/vel 0..127, channel 0..15")
        with self._midi(args) as io:
            io.send_note(on, note, vel, channel)
        return {"sent": 1, "on": on, "note": note, "vel": vel, "channel": channel}

    def _op_midi_echo_rtt(self, args: dict) -> dict:
        n = _arg(args, "n", int, 20)
        with self._midi(args) as io:
            return echo_rtt(io, n=n)

    def _op_midi_query_route(self, args: dict) -> dict:
        with self._midi(args) as io:
            return query_route(io)

    # ----------------------------------------------------------------- ops: usbmode / ota

    def _op_usbmode_set(self, args: dict) -> dict:
        dev = self._resolve(args)
        mode_s = _arg(args, "mode", str)
        try:
            mode = UsbMode(mode_s)
        except ValueError as e:
            raise HilError(BAD_ARGS, f"mode must be default|audio, got {mode_s!r}") from e
        if mode not in (UsbMode.DEFAULT, UsbMode.AUDIO):
            raise HilError(BAD_ARGS, f"mode must be default|audio, got {mode_s!r}")
        wait = _arg(args, "wait", bool, True)
        with self._dev_lock(dev.id):
            new = self._set_mode_fn(dev, mode, wait=wait,
                                    discover_fn=lambda: discover(self._backends),
                                    midi_factory=self._midi_factory)
        return new.to_dict()

    def _op_ota_flash(self, args: dict) -> dict:
        dev = self._resolve(args)
        firmware = Path(_arg(args, "firmware", str))
        if not firmware.is_file():
            raise HilError(BAD_ARGS, f"firmware not found: {firmware}")
        delta_base = _arg(args, "delta_base", str, None)
        wait_boot = _arg(args, "wait_boot", bool, True)
        console_port = self._console_port(dev) if wait_boot else None

        def body(task: _Task) -> dict:
            def progress(done: int, total: int) -> None:
                task.progress, task.total, task.message = done, total, f"{done}/{total} bytes"
                self.emit({"ev": "task.progress", "task": task.handle, "progress": done,
                           "total": total, "message": task.message})

            with self._dev_lock(dev.id):
                flashed = self._ota_flash_fn(
                    dev, firmware, delta_base=Path(delta_base) if delta_base else None,
                    progress=progress, serial_factory=self._serial_factory,
                    set_mode_fn=self._set_mode_fn)
                boot: dict | None = None
                if console_port is not None:
                    con = Console(console_port, serial_factory=self._serial_factory)
                    con.open(reset=False)
                    try:
                        boot = dataclasses.asdict(con.wait_boot())
                    finally:
                        con.close()
            return {"flash": flashed, "boot": boot}

        return {"task": self._start_task("ota.flash", body)}

    # ----------------------------------------------------------------- ops: snapshot

    def _op_snapshot_take(self, args: dict) -> dict:
        dev = self._resolve(args)
        include = _arg(args, "include", list, None)
        previous = _arg(args, "previous", dict, None)
        prev_obj: Snapshot | None = None
        if previous is not None:
            names = {f.name for f in dataclasses.fields(Snapshot)}
            prev_obj = Snapshot(**{k: v for k, v in previous.items() if k in names})
        console = None
        console_sess: _ConsoleSession | None = None
        if args.get("console_handle") is not None:
            console_sess = self._session(args, _ConsoleSession, key="console_handle")
            console = console_sess.console
        kw: dict[str, Any] = {"console": console, "previous": prev_obj,
                              "counter": self._snap_counter}
        if include is not None:
            kw["include"] = tuple(str(i) for i in include)
        if args.get("cdc_handle") is not None:
            sess = self._session(args, _CdcSession, key="cdc_handle")
            with sess.lock:
                return take_snapshot(dev, sess.link, **kw).to_dict()
        with self._dev_lock(dev.id):
            link = self._open_cdc(dev)
            try:
                return take_snapshot(dev, link, **kw).to_dict()
            finally:
                link.close()

    # ----------------------------------------------------------------- ops: scenarios / tasks

    def _op_scenario_list(self, args: dict) -> dict:
        out = []
        for name in scenario_names():
            s = get_scenario(name)
            params = [{"name": p["name"], "type": p["type"], "default": p["default"],
                       "help": p["help"]} for p in scen.params_schema(s.Params)]
            out.append({"name": name, "description": s.description, "params": params})
        return {"scenarios": out}

    def _op_scenario_run(self, args: dict) -> dict:
        name = _arg(args, "name", str)
        raw = _arg(args, "params", dict, {})
        try:
            s = get_scenario(name)
        except (KeyError, HilError) as e:
            raise HilError(BAD_ARGS, f"unknown scenario {name!r}",
                           hint="scenario.list names them") from e
        params = scen.params_from_dict(s.Params, raw)  # unknown key / bad type -> BAD_ARGS
        dev = self._resolve(args)

        def body(task: _Task) -> dict:
            with self._dev_lock(dev.id):
                report = self._run_scenario_fn(name, params, device=dev,
                                               progress=DaemonProgress(self, task),
                                               cancelled=task.cancelled, log=self._log)
            return dataclasses.asdict(report)

        return {"task": self._start_task(f"scenario:{name}", body)}

    def _op_task_status(self, args: dict) -> dict:
        return self._task(args).to_dict()

    def _op_task_wait(self, args: dict) -> dict:
        task = self._task(args)
        timeout_s = float(_arg(args, "timeout_s", (int, float), 30.0))
        task.done.wait(timeout_s)
        return task.to_dict()

    def _op_task_cancel(self, args: dict) -> dict:
        task = self._task(args)
        task.cancelled.set()
        if task.future is not None and task.future.cancel():
            task.status = "cancelled"
            task.error = HilError(CANCELLED, "cancelled before start").to_dict()
            task.done.set()
            self.emit({"ev": "task.done", "task": task.handle, "status": "cancelled",
                       "error": task.error})
        return {"ok": True}

    def _op_task_list(self, args: dict) -> dict:
        tasks = []
        for h in self._handles.all_handles():
            if not h.startswith("task_"):
                continue
            try:
                t = self._handles.get(h)
            except HilError:
                continue
            if isinstance(t, _Task):
                tasks.append(t.to_dict())
        return {"tasks": tasks}


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - `crosspad-hil serve` path
    Daemon(sys.stdin, sys.stdout).run()
    return 0
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/matixan/GIT/crosspad-hil && python -m pytest tests/test_serve.py -q && ruff check crosspad_hil/serve.py tests/test_serve.py && python -m pytest -q`
Expected: `12 passed` for the file, ruff `All checks passed!`, full suite green.

Manual round trip (no hardware, proves the console script wiring):

```bash
cd /home/matixan/GIT/crosspad-hil && printf '{"id":1,"op":"serve.ping","args":{}}\n{"id":2,"op":"scenario.list"}\n{"id":3,"op":"serve.shutdown"}\n' | crosspad-hil serve
```

Expected: three lines, `{"id": 1, "ok": true, "result": {"version": "1.0.0", ...}}`, a `scenario.list` result naming `smoke, app_churn, kit_churn, led_state, usb_mode_cycle`, then `{"id": 3, "ok": true, "result": {"ok": true}}` and the process exits 0.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/crosspad-hil && git add crosspad_hil/serve.py tests/test_serve.py && git commit -m "feat(serve): NDJSON stdio daemon with handles, per-device locks, console events and tasks"
```

---

### Task 10: platform-idf shims, requirements, README rows

**Files:**
- Modify (whole file replaced by a shim): `/home/matixan/GIT/platform-idf/tools/hil_smoke.py`, `/home/matixan/GIT/platform-idf/tools/hil_app_churn.py`, `/home/matixan/GIT/platform-idf/tools/hil_kit_churn.py`, `/home/matixan/GIT/platform-idf/tools/hil_led_state.py`, `/home/matixan/GIT/platform-idf/tools/hil_usb_mode_cycle.py`, `/home/matixan/GIT/platform-idf/tools/ota_flash.py`, `/home/matixan/GIT/platform-idf/tools/requestBootloader.py`
- Create: `/home/matixan/GIT/platform-idf/tools/requirements-hil.txt`
- Modify: `/home/matixan/GIT/platform-idf/README.md:387-411` (HIL table rows + example block) and `:133-137` (flash commands)
- Test: `/home/matixan/GIT/platform-idf/tools/test_hil_shims.py` (pytest, runs each shim with `--help`)
- **Untouched in P0** (P1 moves them): `hil_stability.py`, `hil_audio_loopback.py`, `hil_speaker_acoustic.py`, `hil_velocity.py`, `hil_speedtest.py`, `hil_sampler_record.py`, `hil_midi_stress.py`, `hil_midi_bench.py`, `hil_rt_glitch.py`, `hil_ble_midi.py`. `hil_speaker_acoustic.py` imports from `hil_audio_loopback.py` — both stay, so that import keeps working. `hil_smoke.py` was the only file importing `ota_flash` and it becomes a shim itself.

**Interfaces:**
- Consumes: `crosspad_hil.cli.main(argv) -> int` (Task 8) with subcommands `run smoke|app_churn|kit_churn|led_state|usb_mode_cycle`, `flash`, `bootloader`; the `-p/--port` alias.
- Produces: seven 3-statement shims; `tools/requirements-hil.txt`; README rows.
- Flag translation (state of the art after the shim): every old flag that the scenario `Params` still has passes straight through (`--rounds`, `--dwell`, `--settle`, `--leak-bytes`, `--apps`, `--skip`, `--kits`, `--load-timeout`, `--hit-rate`, `--pads`, `--rapid`, `--no-play`, `--silence-fails`, `--timeout`, `--watch`, `--enum-timeout`, `--logdir`, `-p/--port`, `--json`). Dropped: `--console-port` (discovery pairs both ports), `hil_smoke --flash` as a bare switch (now `--flash PATH`), `requestBootloader --vid/--pid/--skip-bootloader-check`, `ota_flash --patch` (P0 `ota.flash` regenerates from `--base-fw`).

- [ ] **Step 1: Write the failing test**

`/home/matixan/GIT/platform-idf/tools/test_hil_shims.py`:

```python
"""Every P0 shim must run `--help` through crosspad-hil and warn on stderr."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

TOOLS = Path(__file__).resolve().parent

SHIMS = {
    "hil_smoke.py": "run smoke",
    "hil_app_churn.py": "run app_churn",
    "hil_kit_churn.py": "run kit_churn",
    "hil_led_state.py": "run led_state",
    "hil_usb_mode_cycle.py": "run usb_mode_cycle",
    "ota_flash.py": "flash",
    "requestBootloader.py": "bootloader",
}

UNTOUCHED = [
    "hil_stability.py", "hil_audio_loopback.py", "hil_speaker_acoustic.py", "hil_velocity.py",
    "hil_speedtest.py", "hil_sampler_record.py", "hil_midi_stress.py", "hil_midi_bench.py",
    "hil_rt_glitch.py", "hil_ble_midi.py",
]


@pytest.mark.parametrize("script,target", sorted(SHIMS.items()))
def test_shim_help(script: str, target: str) -> None:
    p = subprocess.run([sys.executable, str(TOOLS / script), "--help"],
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr
    assert "usage: crosspad-hil" in p.stdout
    assert "deprecated" in p.stderr and f"crosspad-hil {target}" in p.stderr


@pytest.mark.parametrize("script", sorted(SHIMS))
def test_shim_is_three_lines(script: str) -> None:
    text = (TOOLS / script).read_text()
    code = [ln for ln in text.splitlines()
            if ln.strip() and not ln.startswith("#!") and not ln.startswith('"""')]
    assert len(code) == 3, code
    assert code[0] == "import sys; from crosspad_hil.cli import main"
    assert code[1].startswith("print(") and "file=sys.stderr" in code[1]
    assert code[2].startswith("raise SystemExit(main([")
    assert "def main" not in text  # the old body is gone, not commented out


@pytest.mark.parametrize("script", UNTOUCHED)
def test_untouched_scripts_still_have_bodies(script: str) -> None:
    text = (TOOLS / script).read_text()
    assert "crosspad_hil" not in text
    assert "def main" in text


def test_requirements_pin() -> None:
    assert "crosspad-hil>=1.0" in (TOOLS / "requirements-hil.txt").read_text()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/matixan/GIT/platform-idf && pip install -e /home/matixan/GIT/crosspad-hil >/dev/null && python -m pytest tools/test_hil_shims.py -q`
Expected: FAIL — `test_shim_help` cases assert `"usage: crosspad-hil" in p.stdout` (old scripts print `usage: hil_smoke.py`), `test_shim_is_three_lines` fails on line counts, `test_requirements_pin` fails with `FileNotFoundError`.

- [ ] **Step 3: Write the shims, requirements and README rows**

Each shim is: shebang + a one-line docstring, then exactly three lines of code (`import sys; from crosspad_hil.cli import main` / the deprecation `print` to stderr / `raise SystemExit(main([...]))`). Write them verbatim (`cat > … <<'EOF'`); the old bodies are deleted entirely — no commented-out remains:

`/home/matixan/GIT/platform-idf/tools/hil_smoke.py`:
```python
#!/usr/bin/env python3
"""Deprecated shim: `crosspad-hil run smoke` (kept one release; `--flash` now takes a path)."""
import sys; from crosspad_hil.cli import main
print("hil_smoke.py is deprecated: use `crosspad-hil run smoke` (pip install -r tools/requirements-hil.txt)", file=sys.stderr)
raise SystemExit(main(["run", "smoke", *sys.argv[1:]]))
```

`/home/matixan/GIT/platform-idf/tools/hil_app_churn.py`:
```python
#!/usr/bin/env python3
"""Deprecated shim: `crosspad-hil run app_churn` (kept one release; `--console-port` is gone)."""
import sys; from crosspad_hil.cli import main
print("hil_app_churn.py is deprecated: use `crosspad-hil run app_churn` (pip install -r tools/requirements-hil.txt)", file=sys.stderr)
raise SystemExit(main(["run", "app_churn", *sys.argv[1:]]))
```

`/home/matixan/GIT/platform-idf/tools/hil_kit_churn.py`:
```python
#!/usr/bin/env python3
"""Deprecated shim: `crosspad-hil run kit_churn` (kept one release; `--console-port` is gone)."""
import sys; from crosspad_hil.cli import main
print("hil_kit_churn.py is deprecated: use `crosspad-hil run kit_churn` (pip install -r tools/requirements-hil.txt)", file=sys.stderr)
raise SystemExit(main(["run", "kit_churn", *sys.argv[1:]]))
```

`/home/matixan/GIT/platform-idf/tools/hil_led_state.py`:
```python
#!/usr/bin/env python3
"""Deprecated shim: `crosspad-hil run led_state` (or `crosspad-hil led state`); kept one release."""
import sys; from crosspad_hil.cli import main
print("hil_led_state.py is deprecated: use `crosspad-hil run led_state` (pip install -r tools/requirements-hil.txt)", file=sys.stderr)
raise SystemExit(main(["run", "led_state", *sys.argv[1:]]))
```

`/home/matixan/GIT/platform-idf/tools/hil_usb_mode_cycle.py`:
```python
#!/usr/bin/env python3
"""Deprecated shim: `crosspad-hil run usb_mode_cycle` (kept one release; `--console-port` is gone)."""
import sys; from crosspad_hil.cli import main
print("hil_usb_mode_cycle.py is deprecated: use `crosspad-hil run usb_mode_cycle` (pip install -r tools/requirements-hil.txt)", file=sys.stderr)
raise SystemExit(main(["run", "usb_mode_cycle", *sys.argv[1:]]))
```

`/home/matixan/GIT/platform-idf/tools/ota_flash.py`:
```python
#!/usr/bin/env python3
"""Deprecated shim: `crosspad-hil flash --ota [FW]` (kept one release; `--patch` gone, use `--delta --base-fw F`)."""
import sys; from crosspad_hil.cli import main
print("ota_flash.py is deprecated: use `crosspad-hil flash --ota` (pip install -r tools/requirements-hil.txt)", file=sys.stderr)
raise SystemExit(main(["flash", "--ota", *sys.argv[1:]]))
```

`/home/matixan/GIT/platform-idf/tools/requestBootloader.py`:
```python
#!/usr/bin/env python3
"""Deprecated shim: `crosspad-hil bootloader --esp` (kept one release; --device/--vid/--pid/--skip-bootloader-check gone)."""
import sys; from crosspad_hil.cli import main
print("requestBootloader.py is deprecated: use `crosspad-hil bootloader --esp` (pip install -r tools/requirements-hil.txt)", file=sys.stderr)
raise SystemExit(main(["bootloader", "--esp", *sys.argv[1:]]))
```

`/home/matixan/GIT/platform-idf/tools/requirements-hil.txt`:
```
# Host-side HIL tooling. `crosspad-hil[all]` adds audio (sounddevice/numpy/scipy) and BLE (bleak).
crosspad-hil>=1.0
```

README edits — replace the flash block (lines 133–137) and the HIL rows (387–411) with `sed`/an editor so the result reads exactly:

Lines 133–137 become:
```
# Option A: Flash via UART (requires bootloader mode)
crosspad-hil bootloader --esp            # was: python tools/requestBootloader.py --method cdc,midi
idf.py -p COM7 flash monitor

# Option B: OTA quick flash over USB CDC (device stays running) - requires that previous firmware has OTA support on ESP-IDF and the same partition layout (16 MB flash)
crosspad-hil flash --ota build/CrossPad.bin   # was: python tools/ota_flash.py
```

The table header and the five migrated rows become (other rows unchanged):
```
| Script | What it answers |
|--------|-----------------|
| `crosspad-hil run smoke` (was `hil_smoke.py`) | Did it boot? Resets the device and asserts on the boot log. Run after every flash. |
| `hil_stability.py` | Does it stay up? Hours-long soak: resets, fatals, stalls, heap trend. |
| `crosspad-hil run app_churn` (was `hil_app_churn.py`) | Does opening and closing apps leak or crash? Per-app free-heap slope over N visits. |
| `crosspad-hil run kit_churn` (was `hil_kit_churn.py`) | Does changing kits mid-performance survive? Swaps the kit while the pads keep firing. |
| `crosspad-hil run usb_mode_cycle` (was `hil_usb_mode_cycle.py`) | Does switching USB profiles survive repetition? CDC↔UAC2 re-enumeration. |
```
and the `hil_led_state.py` row becomes:
```
| `crosspad-hil run led_state` (was `hil_led_state.py`) | Why are the pads dark? Dumps the LED controller's model. |
```
The example block (lines 408–411) becomes:
```bash
pip install -r tools/requirements-hil.txt              # once
crosspad-hil run smoke                                 # after a flash
crosspad-hil run app_churn --rounds 10                 # before a release
python3 tools/hil_stability.py --duration-hours 8 --stim-midi   # overnight (P1 moves it)
crosspad-hil run kit_churn --rapid 0.4 --rounds 40     # kit swaps under load
```
Add one sentence after the table: `The old `tools/hil_*.py` names for the migrated rows are shims that print a deprecation line and forward to `crosspad-hil`; they go away next release.`

Exact commands:

```bash
cd /home/matixan/GIT/platform-idf
sed -i 's|^python tools/requestBootloader.py --method cdc,midi$|crosspad-hil bootloader --esp            # was: python tools/requestBootloader.py --method cdc,midi|' README.md
sed -i 's|^python tools/ota_flash.py$|crosspad-hil flash --ota build/CrossPad.bin   # was: python tools/ota_flash.py|' README.md
sed -i 's#^| `hil_smoke.py` |#| `crosspad-hil run smoke` (was `hil_smoke.py`) |#' README.md
sed -i 's#^| `hil_app_churn.py` |#| `crosspad-hil run app_churn` (was `hil_app_churn.py`) |#' README.md
sed -i 's#^| `hil_kit_churn.py` |#| `crosspad-hil run kit_churn` (was `hil_kit_churn.py`) |#' README.md
sed -i 's#^| `hil_usb_mode_cycle.py` |#| `crosspad-hil run usb_mode_cycle` (was `hil_usb_mode_cycle.py`) |#' README.md
sed -i 's#^| `hil_led_state.py` |#| `crosspad-hil run led_state` (was `hil_led_state.py`) |#' README.md
sed -i 's|^python3 tools/hil_smoke.py                    # after a flash$|pip install -r tools/requirements-hil.txt              # once\ncrosspad-hil run smoke                                 # after a flash|' README.md
sed -i 's|^python3 tools/hil_app_churn.py --rounds 10    # before a release$|crosspad-hil run app_churn --rounds 10                 # before a release|' README.md
sed -i 's|^python3 tools/hil_stability.py --duration-hours 8 --stim-midi   # overnight$|python3 tools/hil_stability.py --duration-hours 8 --stim-midi   # overnight (P1 moves it)|' README.md
sed -i 's|^python3 tools/hil_kit_churn.py --rapid 0.4 --rounds 40         # kit swaps under load$|crosspad-hil run kit_churn --rapid 0.4 --rounds 40     # kit swaps under load|' README.md
grep -n "crosspad-hil" README.md | wc -l   # expected: 10
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd /home/matixan/GIT/platform-idf && python -m pytest tools/test_hil_shims.py -q
for s in hil_smoke hil_app_churn hil_kit_churn hil_led_state hil_usb_mode_cycle ota_flash requestBootloader; do python3 tools/$s.py --help >/dev/null || echo "FAIL $s"; done
```
Expected: `25 passed`; the loop prints seven deprecation lines on stderr and no `FAIL`. Also `python3 tools/hil_smoke.py --help | head -1` prints `usage: crosspad-hil run smoke [-h] [-d DEVICE] [--json] [--flash FLASH] [--timeout TIMEOUT] [--logdir LOGDIR]`.

- [ ] **Step 5: Commit**

```bash
cd /home/matixan/GIT/platform-idf && git add tools/hil_smoke.py tools/hil_app_churn.py tools/hil_kit_churn.py tools/hil_led_state.py tools/hil_usb_mode_cycle.py tools/ota_flash.py tools/requestBootloader.py tools/requirements-hil.txt tools/test_hil_shims.py README.md && git commit -m "chore(tools): shim the P0 HIL scripts, ota_flash and requestBootloader onto crosspad-hil"
```

---

## Cross-plan verification (run 2026-08-26, before execution)

Mechanical checks over the three assembled plans plus the frozen contract:

| Check | Result |
|---|---|
| Placeholder scan (`TBD`, `TODO`, `implement later`, `similar to Task N`, `add appropriate …`, trailing `...`) | clean — the only `...` is the `Scenario` Protocol stub in plan B Task 1, which is valid Python |
| Task numbering | no duplicates, no gaps: core 1–12, scenarios/CLI/daemon 1–10, mcp 1–11 |
| Error codes | every code used across all plans is one of the 15 defined in the contract's `errors.py`; none invented |
| Cross-plan call sites (`set_mode`, `take_snapshot`, `run_scenario`, `open_console`, `open_cdc`, `kit_load`, `app_start`) | argument names and defaults at every call site match the definitions in plan A |
| Daemon op names | every op the MCP plan requests (`devices.list`, `devices.doctor`, `console.open/read/expect/reset/snapshot/close`, `cdc.transact`, `cdc.verb`, `snapshot.take`, `task.status/wait/cancel`, `serve.ping`, and in tasks 8–11 `midi.*`, `usbmode.set`, `ota.flash`, `console.wait_boot`, `scenario.list`, `knowledge.get`) is registered by plan B Task 9 — except `knowledge.get`, which plan C Task 10 explicitly flags as an op to add to `serve.py` |
| Hardware in tests | no test in any plan opens a real port, spawns the real daemon, or needs a board; every I/O boundary is injected (`serial_factory`, `Backends`, `discover_fn`, mocked `HilDaemon`) |

What this check does **not** cover, and should be done by a reader before task 1: semantic review of the ported regexes and byte sequences against the current firmware (`main/hil_control.cpp` moves), and whether each test actually fails for the stated reason.

### Correction found on real hardware (2026-08-26)

Plan A Task 4 pairs the ESP CDC and the STM console port by the longest common
prefix of pyserial's `location`. On the connected rev2 board the two interfaces
enumerate on **different USB paths**:

```
/dev/ttyACM1  0x303a:0x3456  'Crosspad'              serial='123456'        location=1-4:1.0
/dev/ttyACM0  0x0483:0x5740  'CrossPad MIDI+Serial'  serial='205D36865830'  location=7-2:1.0
```

They are two independent USB devices (separate cables/hubs), so no location
prefix is shared and the serial numbers are unrelated. Consequences for the
implementation:

- The single-pair rule (exactly one ESP side + exactly one STM side → one
  `Device`) is the primary rule and must not be gated on location similarity.
- Location prefix may only be used as a tie-breaker when **more than one** of
  each kind is present, and when it yields no match the discovery must return
  them as separate `Device`s and let `select()` raise `AMBIGUOUS_DEVICE` rather
  than guess.
- `Device.id` must come from the ESP serial (`123456` here — note it is not
  unique across boards, so the id derivation needs the port path mixed in when
  the serial is a known placeholder).
