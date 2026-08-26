// src/hil/schemas.ts — zod mirrors of the crosspad_hil dataclasses / dicts
// (contract: devices.py, console.py, cdc.py, snapshot.py, serve.py). Every
// object is loose: the daemon may add keys and the TS side never rejects them.
import { z } from "zod";

const Rec = z.record(z.string(), z.unknown());

export const UsbModeSchema = z.enum(["default", "audio", "bootloader", "unknown"]);
export type UsbMode = z.infer<typeof UsbModeSchema>;

// devices.py SerialPortInfo
export const SerialPortInfoSchema = z.looseObject({
  path: z.string(),
  vid: z.number().int(),
  pid: z.number().int(),
  serial: z.string().nullable(),
  product: z.string().nullable(),
  location: z.string().nullable(),
});
export type SerialPortInfo = z.infer<typeof SerialPortInfoSchema>;

// devices.py MidiPortInfo
export const MidiPortInfoSchema = z.looseObject({
  name: z.string(),
  rtmidi_out: z.number().int().nullable(),
  rtmidi_in: z.number().int().nullable(),
  alsa_hw: z.string().nullable(),
  rawmidi: z.string().nullable(),
});
export type MidiPortInfo = z.infer<typeof MidiPortInfoSchema>;

// devices.py AudioCardInfo
export const AudioCardInfoSchema = z.looseObject({
  name: z.string(),
  sounddevice_index: z.number().int().nullable(),
  alsa_id: z.string().nullable(),
});
export type AudioCardInfo = z.infer<typeof AudioCardInfoSchema>;

// devices.py Ports — every role optional/null
export const PortsSchema = z.looseObject({
  cdc: SerialPortInfoSchema.nullable().optional(),
  console: SerialPortInfoSchema.nullable().optional(),
  esp_midi: MidiPortInfoSchema.nullable().optional(),
  stm_midi: MidiPortInfoSchema.nullable().optional(),
  uac2: AudioCardInfoSchema.nullable().optional(),
  bootloader: SerialPortInfoSchema.nullable().optional(),
});
export type Ports = z.infer<typeof PortsSchema>;

// devices.py Device.to_dict()
export const DeviceSchema = z.looseObject({
  id: z.string(),
  serial: z.string().nullable(),
  usb_mode: UsbModeSchema,
  ports: PortsSchema,
  board_rev: z.string().nullable().optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

// snapshot.py Snapshot.to_dict()
export const SnapshotSchema = z.looseObject({
  snapshot_id: z.string(),
  device: z.string(),
  usb_mode: z.string(),
  apps: Rec.nullable(),
  ui: Rec.nullable(),
  kit: Rec.nullable(),
  leds: Rec.nullable(),
  pads: Rec.nullable(),
  mem: Rec.nullable(),
  ble: Rec.nullable(),
  console: Rec.nullable(),
  ts: z.number(),
  changed: z.array(z.string()),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// cdc.py Reply
export const ReplySchema = z.looseObject({
  line: z.string(),
  parsed: Rec.nullable(),
  rtt_ms: z.number(),
  extra_lines: z.array(z.string()),
});
export type Reply = z.infer<typeof ReplySchema>;

// console.py ReadResult — lines: list[tuple[int, str]]
export const ReadResultSchema = z.looseObject({
  lines: z.array(z.tuple([z.number().int(), z.string()])),
  next_seq: z.number().int(),
  lines_lost: z.number().int(),
});
export type ReadResult = z.infer<typeof ReadResultSchema>;

// console.py ExpectResult
export const ExpectResultSchema = z.looseObject({
  hit: z.string().nullable(),
  rejected: z.string().nullable(),
  seq: z.number().int().nullable(),
  context: z.array(z.string()),
  elapsed_s: z.number(),
});
export type ExpectResult = z.infer<typeof ExpectResultSchema>;

// console.py BootResult
export const BootResultSchema = z.looseObject({
  complete: z.boolean(),
  missing: z.array(z.string()),
  fatal: z.array(Rec),
  errors: z.array(Rec),
  bootloops: z.number().int(),
  seconds: z.number(),
});
export type BootResult = z.infer<typeof BootResultSchema>;

// serve.py task.status
export const TaskErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  hint: z.string().nullable().optional(),
});
export const TaskStatusSchema = z.looseObject({
  task: z.string(),
  status: z.enum(["working", "completed", "failed", "cancelled"]),
  progress: z.number().nullable().optional(),
  total: z.number().nullable().optional(),
  message: z.string().nullable().optional(),
  result: z.unknown().optional(),
  error: TaskErrorSchema.optional(),
});
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// serve.py devices.doctor checks[]
export const DoctorCheckSchema = z.looseObject({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  fix: z.string().nullable().optional(),
});
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

// serve.py scenario.list scenarios[]
export const ScenarioParamSchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  default: z.unknown().optional(),
  help: z.string().nullable().optional(),
});
export const ScenarioInfoSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  params: z.array(ScenarioParamSchema),
});
export type ScenarioInfo = z.infer<typeof ScenarioInfoSchema>;
