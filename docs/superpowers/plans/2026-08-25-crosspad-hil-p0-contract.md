> Frozen interface contract shared by the three P0 plans. Names and signatures here are authoritative.

# crosspad-hil P0 — interface contract (shared by all plan tasks)

Spec: crosspad-mcp/docs/superpowers/specs/2026-08-25-crosspad-hil-and-mcp-v10-design.md
Repo: /home/matixan/GIT/crosspad-hil (new). Package `crosspad_hil`. Python >= 3.10. Deps: pyserial, python-rtmidi, pydantic>=2, pyyaml. Extras: audio (sounddevice, numpy, scipy), ble (bleak), all. Tests: pytest. Lint: ruff (line length 100). Type hints everywhere. No global mutable state except explicit registries.

Source material to PORT (read these, copy the real regexes/parsers/sequences, do not invent):
- /home/matixan/GIT/platform-idf/tools/hil_smoke.py (reset_pulse, REQUIRED_MARKERS, FATAL_PATTERNS, boot-loop count)
- /home/matixan/GIT/platform-idf/tools/hil_kit_churn.py (class Cdc: reader thread + prefix waiters — the best CDC client; console with DTR/RTS deasserted)
- /home/matixan/GIT/platform-idf/tools/hil_stability.py (console parsers: reset reason, PerfMon heap block, 300-line context dump, fatal union)
- /home/matixan/GIT/platform-idf/tools/hil_app_churn.py, hil_led_state.py, hil_usb_mode_cycle.py (scenario logic to port)
- /home/matixan/GIT/platform-idf/tools/hil_audio_loopback.py (ensure_audio_mode / restore_default_mode / find_esp_cdc_port / send_sysex)
- /home/matixan/GIT/platform-idf/tools/hil_sampler_record.py (rtmidi port matching, cross-platform)
- /home/matixan/GIT/platform-idf/tools/ota_flash.py, requestBootloader.py (OTA protocol, bootloader PIDs)
- /home/matixan/GIT/platform-idf/main/hil_control.cpp (authoritative CDC verbs + reply grammar)
- /home/matixan/GIT/crosspad-mcp/tracer/swd_tracer.py and src/tools/trace-session.ts (NDJSON daemon pattern to mirror)

## Package layout

```
crosspad-hil/
  pyproject.toml, README.md, LICENSE (MIT), .gitignore, .github/workflows/ci.yml (pytest on ubuntu + windows, py3.10/3.12)
  crosspad_hil/
    __init__.py            __version__ = "1.0.0"
    errors.py              HilError
    knowledge/__init__.py  load(name) -> dict
    knowledge/markers.yaml, sysex.yaml, cdc.yaml
    serial_open.py         open_serial(), reset_pulse()
    locks.py               PortLock
    devices.py             UsbMode, SerialPortInfo, MidiPortInfo, AudioCardInfo, Ports, Device, Backends, discover(), select()
    parsers.py             ConsoleEvent, ConsoleParser, parse_cdc_reply(), parse_enc_group()
    console.py             Console, ReadResult, ExpectResult, BootResult
    cdc.py                 CdcLink, Reply, BurstResult
    verbs.py               typed CDC verbs (functions taking a CdcLink)
    midi.py                MidiRole, MidiIO, sysex_* builders, query_route(), echo_rtt()
    usbmode.py             set_mode(), audio_mode()
    ota.py                 ota_flash(), request_bootloader(), flash()
    snapshot.py            Snapshot, take_snapshot(), ref_to_delta()
    scenarios/__init__.py  registry: register(), get(), names()
    scenarios/base.py      Report, Artifact, Progress, Context, Scenario, run_scenario(), params_to_argparse(), argparse_to_params()
    scenarios/smoke.py, app_churn.py, kit_churn.py, led_state.py, usb_mode_cycle.py
    cli.py                 main(argv) -> int
    serve.py               Daemon (NDJSON stdio), HandleRegistry, ops
    record.py              RecordingSerial, ReplaySerial (transcripts for tests)
  tests/
    conftest.py            fixtures: FakeSerial, fake_backends, knowledge
    fakes.py               FakeSerial (scriptable replies, records DTR/RTS state history), FakeMidiOut/In
    test_*.py per module
    fixtures/transcripts/*.ndjson
```

## errors.py
```python
class HilError(Exception):
    def __init__(self, code: str, message: str, hint: str | None = None, **details: Any): ...
    code: str; message: str; hint: str | None; details: dict[str, Any]
    def to_dict(self) -> dict  # {"code","message","hint","details"}
```
Codes (string constants in errors.py): NO_DEVICE, AMBIGUOUS_DEVICE, PORT_BUSY, NO_CDC_IN_AUDIO_MODE, TIMEOUT, UNKNOWN_VERB, DENIED_SYSEX, BAD_SYSEX, HANDLE_EXPIRED, BAD_ARGS, FLASH_FAILED, ENV, CANCELLED, NOT_SUPPORTED.

## knowledge
`load(name: str) -> dict` reads `crosspad_hil/knowledge/<name>.yaml` via importlib.resources, cached.
markers.yaml keys: boot_markers (list[str]), required (list[str], the 7 from hil_smoke), required_stability (6, minus "STM32 ident:"), optional (list), error_line (regex str), error_allow (list[str] substrings), fatal_patterns (list[str] regex), reset_reason (regex with 2 groups), heap_block {start: "Heap Statistics", line: regex with 1 group free bytes, end: "Total tasks:"}, kit_request (regex 2 groups), cdc_drops (regex 1 group), reboot ("ESP-ROM:esp32s3"), boot_timeout_s: 45.
sysex.yaml keys: manufacturer: 0x7D; usb_mode {id: 0x1B, default: 0x01, audio: 0x02}; audio_route {id: 0x1D, subs: {adc_input: 0x01, mic_src: 0x02, dac_output: 0x03, volume: 0x04, mute: 0x05, audio_tasks: 0x06, pad_press: 0x07, pad_release: 0x08, echo: 0x09, query: 0x10}}; bootloader {id: 0x19, esp: 0x00}; host_denylist: [[0x19, 0x01]].
cdc.yaml: verbs: {VERB: {args: list[str], reply: prefix|"OK"|"multi", end: str|null, profile: "default"}} for every verb in hil_control.cpp §1.3 + APP_*, KIT_*, PAD_*, ENC_*, LED_STATE, MEM, MEM_BLOCKS, CDC_STATS, AUDIO_*, SMPL_*, BLE_*, OTA_BEGIN, OTA_DELTA, USB_AUDIO, USB_DEFAULT, BOOTLOADER_REQUEST, STM_DFU. `multi` verbs: ENC_GROUP (end: null → read until 200 ms idle), APP_VERSIONS (end: "APPVER: end"), MEM_BLOCKS (2 lines: MEMBLK:, MEMBIG:).

## serial_open.py
```python
def open_serial(path: str, *, baud: int = 115200, timeout: float = 0.2, reset: bool = False,
                serial_cls: type = serial.Serial) -> serial.Serial
    # ser = serial_cls(); ser.port=path; ser.baudrate=baud; ser.timeout=timeout; ser.dtr=False; ser.rts=False; ser.open(); if reset: reset_pulse(ser)
def reset_pulse(ser) -> None
    # ser.dtr=False; ser.rts=True; sleep(0.1); finally: ser.rts=False   (hil_smoke.reset_pulse)
```

## locks.py
```python
class PortLock:
    def __init__(self, port: str, purpose: str, lock_dir: Path | None = None)  # default: $XDG_RUNTIME_DIR/crosspad-hil or tempdir/crosspad-hil-<uid>
    def acquire(self) -> None      # raises HilError(PORT_BUSY, hint="…", pid=…, purpose=…); stale lock (pid not alive) reclaimed
    def release(self) -> None
    def __enter__/__exit__
    @staticmethod
    def holders(lock_dir: Path | None = None) -> list[dict]   # [{port, pid, purpose, alive}]
```
Lock file JSON: {"pid", "purpose", "port", "ts"}; name = sha1(port)[:12] + ".lock"; created with O_CREAT|O_EXCL.

## devices.py
```python
class UsbMode(str, Enum): DEFAULT="default"; AUDIO="audio"; BOOTLOADER="bootloader"; UNKNOWN="unknown"
@dataclass class SerialPortInfo: path: str; vid: int; pid: int; serial: str | None; product: str | None; location: str | None
@dataclass class MidiPortInfo: name: str; rtmidi_out: int | None; rtmidi_in: int | None; alsa_hw: str | None; rawmidi: str | None
@dataclass class AudioCardInfo: name: str; sounddevice_index: int | None; alsa_id: str | None
@dataclass class Ports: cdc: SerialPortInfo | None = None; console: SerialPortInfo | None = None; esp_midi: MidiPortInfo | None = None; stm_midi: MidiPortInfo | None = None; uac2: AudioCardInfo | None = None; bootloader: SerialPortInfo | None = None
@dataclass class Device:
    id: str; serial: str | None; usb_mode: UsbMode; ports: Ports; board_rev: str | None = None
    def to_dict(self) -> dict
@dataclass class Backends:
    list_serial: Callable[[], list[SerialPortInfo]]
    list_midi: Callable[[], list[MidiPortInfo]]
    list_audio: Callable[[], list[AudioCardInfo]]
def default_backends() -> Backends     # pyserial list_ports; rtmidi MidiOut/MidiIn port names (+ ALSA amidi -l / /proc/asound/cards enrichment on Linux); sounddevice query_devices (+ arecord -l on Linux); each guarded — missing optional dep → empty list
def discover(backends: Backends | None = None) -> list[Device]
def select(devices: list[Device], device: str | None = None) -> Device
def device_id_for(serial: str | None, fallback: str) -> str   # "dev_" + sha1(serial or fallback).hexdigest()[:4]
```
Constants: ESP_VID=0x303A; ESP_CDC_PIDS={0x3456,0x4001}; ESP_BOOT_PIDS={0x1001,0x0009}; STM_VID=0x0483; STM_PID=0x5740; ESP_MIDI_NAME_MATCH: name contains "Crosspad" (case-insensitive) and not "MIDI+Serial"; STM_MIDI_NAME_MATCH: contains "MIDI+Serial"; UAC2_NAME_MATCH: contains "Crosspad Audio".
Grouping: one ESP CDC (or bootloader) + one STM VCP → same Device when exactly one of each; with several, pair by longest common prefix of `location` (USB topology); unpaired STM VCP → Device with only ports.console, usb_mode UNKNOWN. usb_mode: bootloader port → BOOTLOADER; cdc → DEFAULT; no cdc but uac2 → AUDIO; else UNKNOWN. Device id from ESP serial when known, else STM serial.
select(): device None → exactly one Device with an ESP side, else raise NO_DEVICE ("no CrossPad found; is it in bootloader/DFU?") / AMBIGUOUS_DEVICE (details candidates=[to_dict…], hint "pass device=<id>"); device given → match id, or a port path (must equal one of the device's port paths; hint names its role), else NO_DEVICE.

## parsers.py
```python
@dataclass class ConsoleEvent: kind: str; seq: int; line: str; data: dict
# kinds: "boot_marker" {marker}, "boot_complete" {missing: []}, "reboot" {count}, "reset_reason" {code, name}, "error_line" {}, "fatal" {pattern}, "heap" {slot, free}, "kit" {kit, state}, "cdc_drops" {dropped}
class ConsoleParser:
    def __init__(self, knowledge: dict | None = None, required: list[str] | None = None)
    def feed(self, seq: int, line: str) -> list[ConsoleEvent]
    def reset_boot_tracking(self) -> None
    def snapshot(self) -> dict   # {fatals: [{seq,pattern,line}], reboots: int, reset_reasons: [str], errors: [{seq,line}], markers_seen: {marker: count}, boot_complete: bool, missing_markers: [str], bootloops: int, heap: {slot_index: free}, kit_requests: [{kit,state,seq}], cdc_drops: int}
def parse_cdc_reply(line: str) -> dict | None
    # returns {"kind": <prefix without colon lowercased>, ...fields} — KITSTATUS→{current:int,loading:bool,pending:int,name:str|None}; APPS→{apps:[...],running:str|None}; KITS→{kits:[{id,name}],current:int}; PADSTATS→ints; PADNOTES→{notes:{pad:int}}; LEDS→{brightness,anim,coalesce,cfgbri,pwr,pwr_count,txfail,colors:[16 str]}; MEM→ints; MEMBLK→{biggest_used:int, buckets:[{le,used_n,used_b,free_n,free_b}]}; MEMBIG→{blocks:[{addr,size}]}; CDCSTATS→{rx,cmds,drop}; BLE→dict of key=value with ints where numeric; BLEDEV→{count, devices:[{addr,name,rssi}]}; UI→dict; ENC→dict; ENCFOCUS→{index:int,label:str,ptr:str}; AUDIOLVL→{left:float,right:float,amp:bool,allowed:bool}; SMPLPEAK→{peak:int,free:int}; APPVER→{component,id,commit,ref,dirty:bool} or {end:True,count}; "OK"→{"kind":"ok"}; "ERR …"→{"kind":"err","message"}; unknown → None
def parse_enc_group(lines: list[str]) -> list[dict]   # from "ENCGROUP: count=N" + "  [i] <ptr> <label>" → [{ref:"e<i>", index:i, ptr:str, label:str}]
```

## console.py
```python
@dataclass class ReadResult: lines: list[tuple[int, str]]; next_seq: int; lines_lost: int
@dataclass class ExpectResult: hit: str | None; rejected: str | None; seq: int | None; context: list[str]; elapsed_s: float
@dataclass class BootResult: complete: bool; missing: list[str]; fatal: list[dict]; errors: list[dict]; bootloops: int; seconds: float
class Console:
    def __init__(self, port: str, *, log_path: Path | None = None, ring_size: int = 50_000, knowledge: dict | None = None, required: list[str] | None = None, serial_factory: Callable = open_serial, on_event: Callable[[ConsoleEvent], None] | None = None)
    def open(self, reset: bool = False) -> None      # PortLock(port, "console"); background reader thread; lines decoded utf-8 errors="replace", CRLF stripped
    def close(self) -> None
    def read(self, since_seq: int | None = None, wait_ms: int = 0, match: str | None = None, limit: int = 2000) -> ReadResult
    def expect(self, patterns: list[str], reject: list[str] = (), timeout_s: float = 30.0) -> ExpectResult   # regex search; context = 20 lines around hit
    def reset(self) -> None                          # reset_pulse + parser.reset_boot_tracking()
    def wait_boot(self, timeout_s: float | None = None, settle_s: float = 3.0) -> BootResult  # all required markers or timeout; bootloops = max marker count − 1
    def snapshot(self) -> dict                       # parser.snapshot() + {seq, lines_lost, log_path, port}
    def events(self, since_seq: int = 0) -> list[ConsoleEvent]
    seq: int (property, last assigned)
```

## cdc.py
```python
@dataclass class Reply: line: str; parsed: dict | None; rtt_ms: float; extra_lines: list[str]
@dataclass class BurstResult: sent: int; seconds: float; drops_before: int; drops_after: int; dropped: int
class CdcLink:
    def __init__(self, port: str, *, serial_factory: Callable = open_serial, knowledge: dict | None = None)
    def open(self) -> None   # PortLock(port, "cdc"); reader thread (hil_kit_churn.Cdc pattern): lines → prefix waiters; unmatched lines kept in a bounded deque (200)
    def close(self) -> None
    def send(self, cmd: str) -> None                                  # write lock; cmd + "\n"
    def transact(self, cmd: str, expect: str | None = None, timeout_s: float = 2.0) -> Reply
        # expect None → cdc.yaml reply prefix for the verb (first word); "OK" verbs wait for "OK"/"ERR"; echo of the sent line → HilError(UNKNOWN_VERB); timeout → HilError(TIMEOUT, hint mentions UAC2 mode if no bytes at all)
    def transact_multi(self, cmd: str, expect: str, end: str | None = None, idle_ms: int = 200, timeout_s: float = 3.0) -> list[str]
    def burst(self, cmds: list[str], rate_hz: float) -> BurstResult   # CDC_STATS before/after
    def unmatched(self) -> list[str]
```

## verbs.py (every function: first arg `link: CdcLink`; returns plain dicts; raises HilError)
app_list(link) -> {"apps": list[str], "running": str|None}; app_start(link, name: str, wait_s: float = 3.0) -> {"running": str}; app_stop(link) -> {"ok": True}; app_destroy(link); app_self_close(link); app_versions(link) -> {"components": [{component,id,commit,ref,dirty}], "count": int}
kit_list(link) -> {"kits": [{id,name}], "current": int}; kit_status(link) -> {current,loading,pending,name}; kit_load(link, kit_id: int, wait_s: float = 15.0) -> kit_status dict (waits current==kit_id and loading False and pending==-1; TIMEOUT otherwise)
pad_press(link, idx: int, vel: int = 127); pad_release(link, idx); pad_pressure(link, idx, val); pad_stats(link, reset: bool = False) -> {press,release,played,freeslots}; pad_notes(link) -> {"notes": {int: int}}; pad_info(link, idx) -> {"raw": str}
enc_rotate(link, delta: int); enc_press(link, ms: int = 80); enc_group(link) -> {"group": [{ref,index,ptr,label}]}; enc_focus(link) -> {index,label,ptr}; enc_state(link) -> dict; ui_state(link) -> dict
led_state(link) -> dict (LEDS parsed); mem(link) -> dict; mem_blocks(link) -> {"summary": MEMBLK dict, "big": [..]}; cdc_stats(link) -> {rx,cmds,drop}; audio_level(link) -> dict; smpl_peak(link) -> dict
ble_status(link) -> dict; ble_start(link, mode: int|None); ble_stop(link); ble_scan(link, ms: int = 5000); ble_devices(link) -> dict; ble_connect(link, addr: str); ble_disconnect(link); ble_send(link, note: int, vel: int = 100); ble_txoff(link, semis: int)
audio_tasks(link, on: bool); bootloader_request(link) -> {"sent": True}; stm_dfu(link) -> {"sent": True}
All validation (ranges 0..15, 0..127, 0..255, name ≤ 31 chars) raises HilError(BAD_ARGS).

## midi.py
```python
class MidiRole(str, Enum): ESP="esp"; STM="stm"
class MidiIO:
    def __init__(self, device: Device, role: MidiRole = MidiRole.ESP, *, backend: str = "rtmidi", out_factory=None, in_factory=None)  # factories for tests
    def open(self) -> None; def close(self) -> None
    def send_sysex(self, frame: bytes) -> None      # frame[0]==0xF0 and frame[-1]==0xF7 else BAD_SYSEX; (frame[1],frame[2],frame[3]) in denylist → DENIED_SYSEX
    def send_note(self, on: bool, note: int, vel: int = 100, channel: int = 0) -> None
    def receive(self, timeout_s: float = 1.0) -> bytes | None   # next SysEx frame from the IN port (ESP only; STM → NOT_SUPPORTED)
def sysex_usb_mode(mode: UsbMode) -> bytes            # F0 7D 1B 01|02 F7
def sysex_audio_route(sub: int, *args: int) -> bytes  # F0 7D 1D sub args… F7
def sysex_pad(on: bool, pad: int, vel: int = 127) -> bytes
def sysex_echo(seq: int) -> bytes                      # 28-bit seq, 7 bits per byte, MSB first
def sysex_query() -> bytes                             # F0 7D 1D 10 F7
def sysex_bootloader_esp() -> bytes                    # F0 7D 19 00 F7
def parse_query_reply(frame: bytes) -> dict            # {mic_src, adc:[a0,a1], out:[o0,o1], vol:[v0,v1], mute:[m0,m1]}
def query_route(io: MidiIO, timeout_s: float = 1.0) -> dict
def echo_rtt(io: MidiIO, n: int = 20, timeout_s: float = 1.0) -> dict   # {sent, received, lost, rtt_ms: {p50,p90,max}}
```

## usbmode.py
```python
def set_mode(device: Device, mode: UsbMode, *, wait: bool = True, timeout_s: float = 20.0, discover_fn=discover, midi_factory=MidiIO, sleep=time.sleep) -> Device
    # requires device.ports.esp_midi; sends sysex_usb_mode on ESP role; if wait: poll discover_fn until Device with same id reports usb_mode==mode (or has cdc for DEFAULT / uac2 for AUDIO); TIMEOUT otherwise; returns refreshed Device
@contextmanager
def audio_mode(device: Device, *, keep: bool = False, **kw) -> Iterator[Device]   # set AUDIO; yield; finally set DEFAULT unless keep
```

## ota.py
```python
def ota_flash(device: Device, firmware: Path, *, delta_base: Path | None = None, progress: Callable[[int, int], None] | None = None, timeout_s: float = 300.0, serial_factory=open_serial, set_mode_fn=set_mode) -> dict   # {"bytes","seconds","kbps","version","mode":"full"|"delta"}
    # if device.usb_mode is AUDIO → set_mode_fn(DEFAULT) first; protocol from ota_flash.py: OTA_BEGIN <size> <version> → OTA_READY|OTA_WAIT(≤90 s); 4096-byte chunks each acked "OK recv/total"; final OTA_OK|OTA_ERROR; version read from bin offset 48 (32 bytes, NUL-terminated)
def request_bootloader(device: Device, target: str = "esp", *, method: str = "cdc,midi", timeout_s: float = 10.0) -> dict  # {"bootloader_port": str|None}
def flash(device: Device, firmware: Path, *, transport: str = "ota", wait_boot: bool = True, console: Console | None = None, progress=None) -> dict   # {"flash": ota_flash dict, "boot": BootResult.__dict__ | None}; transport "uart" → NOT_SUPPORTED in P0 (use idf.py)
```

## snapshot.py
```python
DEFAULT_INCLUDE = ("apps", "ui", "kit", "leds", "pads", "mem", "ble", "console")
@dataclass class Snapshot: snapshot_id: str; device: str; usb_mode: str; apps: dict | None; ui: dict | None; kit: dict | None; leds: dict | None; pads: dict | None; mem: dict | None; ble: dict | None; console: dict | None; ts: float; changed: list[str]
    def to_dict(self) -> dict
def take_snapshot(device: Device, link: CdcLink, *, console: Console | None = None, include: Sequence[str] = DEFAULT_INCLUDE, previous: Snapshot | None = None, counter: itertools.count | None = None) -> Snapshot
    # ui = {"focus": {ref,index,label}, "group": [...], "drawer": bool, "theme": int, "app": str|None} from enc_focus + enc_group + ui_state; console = {handle?: None, fatals, reboots, cdc_drops, since_seq} from console.snapshot() when given; changed = top-level keys whose dict differs from previous
def ref_to_delta(group: list[dict], focus_index: int, ref: str) -> int   # index(ref) − focus_index; unknown ref → BAD_ARGS
```

## scenarios/base.py
```python
@dataclass class Artifact: path: str; mime: str; role: str
@dataclass class Report: passed: bool; summary: str; data: dict; artifacts: list[Artifact]; exit_code: int  # 0 pass, 1 fail, 2 env
class Progress: def __call__(self, progress: int, total: int | None, message: str) -> None   # default: no-op; CLI prints; daemon emits task.progress
@dataclass class Context:
    device: Device; workdir: Path; cancelled: threading.Event; log: Callable[[str], None]
    def open_console(self, reset: bool = False) -> Console     # log_path = workdir/"console.log"
    def open_cdc(self) -> CdcLink
    def check_cancelled(self) -> None                            # raises HilError(CANCELLED)
class Scenario(Protocol): name: str; Params: type; description: str; def run(self, ctx: Context, params: Any, progress: Progress) -> Report
def register(s: Scenario) -> Scenario; def get(name) -> Scenario; def names() -> list[str]
def params_to_argparse(params_cls: type, parser: argparse.ArgumentParser) -> None    # dataclass fields → --kebab-case flags; bool → store_true/--no-x; list[int] → comma-separated; metadata={"help": str}
def argparse_to_params(params_cls: type, ns: argparse.Namespace) -> Any
def run_scenario(name: str, params: Any, *, device: Device | None = None, workdir: Path | None = None, progress: Progress | None = None, cancelled: threading.Event | None = None, log=print) -> Report   # workdir default hil_logs/<name>_<YYYYmmdd_HHMMSS>; writes report.json
```
Scenarios P0 (Params fields = old script flags): smoke(flash: str|None=None, timeout: int=25), app_churn(rounds=3, apps: list[str]|None, skip: list[str]|None, dwell=1.0, settle=1.2, leak_bytes=2048), kit_churn(rounds=20, kits: list[int]|None, dwell=2.0, load_timeout=15.0, hit_rate=8.0, pads: list[int]|None, rapid: float|None=None, no_play=False, silence_fails=False), led_state(watch: bool=False), usb_mode_cycle(rounds=5, dwell=2.0, enum_timeout=15.0).

## serve.py (daemon)
Protocol: stdin NDJSON `{"id": int, "op": str, "args": dict}`; stdout `{"id", "ok": true, "result"}` / `{"id", "ok": false, "error": HilError.to_dict()}`; events `{"ev": str, ...}`. Stderr for logs. Ops run on a ThreadPoolExecutor (8); per-device `threading.Lock` for ops that touch a device's serial ports (console/cdc ops on the same handle are serialized by the handle's own lock; discovery is lock-free).
```python
class HandleRegistry:  # thread-safe
    def mint(self, prefix: str, obj: Any, ttl_s: float | None) -> str   # "con_1", "task_3"
    def get(self, handle: str) -> Any    # HANDLE_EXPIRED if unknown/expired (hint: "open again")
    def touch(self, handle); def drop(self, handle) -> Any | None; def sweep(self) -> list[str]; def list(self) -> list[dict]
class Daemon:
    def __init__(self, stdin, stdout, *, backends=None, serial_factory=open_serial)
    def run(self) -> None     # until EOF or op serve.shutdown
    def handle(self, req: dict) -> dict   # sync dispatch, used by tests
    def emit(self, ev: dict) -> None      # thread-safe stdout write
OPS (name → args → result):
serve.ping {} → {"version", "uptime_s"}; serve.shutdown {} → {"ok": true}
devices.list {} → {"devices": [Device.to_dict]}; devices.doctor {} → {"checks": [{name, ok, detail, fix}]}
console.open {device, reset?: false, log_to?: str} → {"handle", "port", "log_path"}; console.read {handle, since_seq?, wait_ms?, match?, limit?} → ReadResult dict; console.expect {handle, patterns, reject?, timeout_s?} → ExpectResult dict; console.reset {handle} → {"ok"}; console.wait_boot {handle, timeout_s?} → BootResult dict; console.snapshot {handle} → dict; console.close {handle} → {"ok"}
cdc.open {device} → {"handle"}; cdc.transact {handle|device, cmd, expect?, timeout_s?} → Reply dict; cdc.verb {handle|device, verb: str, args: dict} → verb result (verb = function name in verbs.py); cdc.burst {handle, cmds, rate_hz} → BurstResult; cdc.close {handle}
midi.sysex {device, role?, frame: "F0 7D …" hex string} → {"sent": n}; midi.note {device, role?, on, note, vel?, channel?}; midi.echo_rtt {device, n?} → dict; midi.query_route {device} → dict
usbmode.set {device, mode, wait?} → Device dict
ota.flash {device, firmware, delta_base?, wait_boot?} → task handle (see below)
snapshot.take {device, cdc_handle?, console_handle?, include?, previous?} → Snapshot dict
scenario.list {} → {"scenarios": [{name, description, params: [{name,type,default,help}]}]}; scenario.run {name, params, device?} → {"task": "task_N"}
task.status {task} → {"task","status": working|completed|failed|cancelled, "progress", "total", "message", "result"?, "error"?}; task.wait {task, timeout_s} → same; task.cancel {task} → {"ok"}; task.list {} → {"tasks": [...]}
Events: console.fatal, console.reboot, console.cdc_drops, console.kit, console.boot_complete (from Console.on_event, with "handle"); task.progress {task, progress, total, message}; task.done {task, status, result|error}.
Any op that gets `device` (an id or port path) resolves it with discover()+select() each time (fresh mode).
```

## cli.py
`main(argv: list[str] | None = None) -> int`. Global flags: `--device/-d`, `--json`. Subcommands (P0): devices [--watch], doctor, console [--reset] [--expect P …] [--reject P …] [--timeout S] [--log FILE], cdc VERB [ARGS…] [--expect P] [--timeout MS], app {list|start NAME|stop|versions}, kit {list|load ID [--wait]|status}, pad {press I [VEL]|release I|pressure I V|stats [--reset]|notes}, ui {snapshot|focus REF|press|rotate N}, led state, mem [--blocks], ble {status|start [server|host]|stop|scan [MS]|devices|connect ADDR|disconnect|send NOTE [VEL]}, midi {sysex HEX [--port esp|stm]|note on|off N [VEL]|echo [--n N]}, usb-mode {get|set default|audio [--no-wait]}, snapshot, flash FW [--ota] [--delta --base-fw F] [--wait-boot/--no-wait-boot], bootloader [--esp|--stm], run SCENARIO [flags from Params] [--json], record [--out FILE], serve. Exit codes: 0 ok, 1 fail (scenario failed / device ERR), 2 env/usage. Errors print `error: <code>: <message>` + `hint: …` to stderr (or JSON with --json).

## record.py
```python
class RecordingSerial:   # wraps a real serial.Serial; logs every read/write as {"t": float, "dir": "rx"|"tx", "data": hex} lines to an ndjson file
    def __init__(self, inner, path: Path)
class ReplaySerial:      # serial-like object driven by a transcript: write() matches the next expected "tx" (raises on mismatch unless lenient), read()/readline() return the following "rx" bytes in order with recorded delays scaled by `speed`
    def __init__(self, path: Path, *, speed: float = 0.0, lenient: bool = False)
    dtr/rts attributes recorded in `.control_history` (list of (attr, value)) for hygiene assertions
```
tests/fakes.py FakeSerial: `FakeSerial(script: list[tuple[str, str|list[str]]] = ())` — `write(b)` looks up the decoded command (without newline) in `script` and enqueues the reply lines (each + "\r\n"); unknown commands are echoed back (device behaviour); `readline()` pops from the queue (or returns b"" after `timeout`); attributes `dtr`, `rts`, `is_open`, `control_history`, `written: list[str]`; `feed(lines)` to push unsolicited console lines; `close()`.
