import { ByteReader, ByteWriter, clamp } from '../bytes';

/** Fitness Machine Control Point (0x2AD9) op codes, FTMS spec v1.0 §4.16. */
export const FtmsOpCode = {
  RequestControl: 0x00,
  Reset: 0x01,
  SetTargetPower: 0x05,
  StartOrResume: 0x07,
  StopOrPause: 0x08,
  SetIndoorBikeSimulation: 0x11,
  SetWheelCircumference: 0x12,
  SpinDownControl: 0x13,
  SetTargetCadence: 0x14,
  ResponseCode: 0x80,
} as const;

export const FtmsResultCode = {
  Success: 0x01,
  OpCodeNotSupported: 0x02,
  InvalidParameter: 0x03,
  OperationFailed: 0x04,
  ControlNotPermitted: 0x05,
} as const;

const RESULT_NAMES: Record<number, string> = {
  [FtmsResultCode.Success]: 'Success',
  [FtmsResultCode.OpCodeNotSupported]: 'Op Code not supported',
  [FtmsResultCode.InvalidParameter]: 'Invalid Parameter',
  [FtmsResultCode.OperationFailed]: 'Operation Failed',
  [FtmsResultCode.ControlNotPermitted]: 'Control Not Permitted',
};

export function ftmsResultName(code: number): string {
  return RESULT_NAMES[code] ?? `Unknown (0x${code.toString(16)})`;
}

export interface SimulationParameters {
  /** Road grade in percent, e.g. 5 for 5 %. */
  gradePercent: number;
  /** Head wind in m/s (negative = tail wind). */
  windSpeedMps?: number;
  /** Rolling resistance coefficient, e.g. 0.004. */
  crr?: number;
  /** Wind resistance coefficient in kg/m (= 0.5 · ρ · CdA). */
  cwKgPerM?: number;
}

export const DEFAULT_CRR = 0.004;
/** 0.5 · 1.225 kg/m³ · 0.32 m² — a rider on the hoods. */
export const DEFAULT_CW = 0.196;

export function encodeRequestControl(): Uint8Array {
  return Uint8Array.of(FtmsOpCode.RequestControl);
}

export function encodeReset(): Uint8Array {
  return Uint8Array.of(FtmsOpCode.Reset);
}

export function encodeStartOrResume(): Uint8Array {
  return Uint8Array.of(FtmsOpCode.StartOrResume);
}

export function encodeStop(pause = false): Uint8Array {
  return Uint8Array.of(FtmsOpCode.StopOrPause, pause ? 0x02 : 0x01);
}

export function encodeSetTargetPower(watts: number): Uint8Array {
  return new ByteWriter()
    .uint8(FtmsOpCode.SetTargetPower)
    .int16(clamp(Math.round(watts), 0, 4000))
    .toUint8Array();
}

export function encodeIndoorBikeSimulation(p: SimulationParameters): Uint8Array {
  const wind = clamp(Math.round((p.windSpeedMps ?? 0) * 1000), -32768, 32767);
  const grade = clamp(Math.round(p.gradePercent * 100), -32768, 32767);
  const crr = clamp(Math.round((p.crr ?? DEFAULT_CRR) * 10000), 0, 255);
  const cw = clamp(Math.round((p.cwKgPerM ?? DEFAULT_CW) * 100), 0, 255);
  return new ByteWriter()
    .uint8(FtmsOpCode.SetIndoorBikeSimulation)
    .int16(wind)
    .int16(grade)
    .uint8(crr)
    .uint8(cw)
    .toUint8Array();
}

export function encodeSetWheelCircumference(mm: number): Uint8Array {
  return new ByteWriter()
    .uint8(FtmsOpCode.SetWheelCircumference)
    .uint16(clamp(Math.round(mm * 10), 0, 0xffff))
    .toUint8Array();
}

export interface ControlPointResponse {
  requestOpCode: number;
  resultCode: number;
  ok: boolean;
}

/** Parses a control point indication; returns null for anything that is not a response (0x80). */
export function parseControlPointResponse(view: DataView): ControlPointResponse | null {
  const r = new ByteReader(view);
  if (r.remaining < 3 || r.uint8() !== FtmsOpCode.ResponseCode) return null;
  const requestOpCode = r.uint8();
  const resultCode = r.uint8();
  return { requestOpCode, resultCode, ok: resultCode === FtmsResultCode.Success };
}

const STATUS_NAMES: Record<number, string> = {
  0x01: 'Reset',
  0x02: 'Stopped or paused by user',
  0x03: 'Stopped by safety key',
  0x04: 'Started or resumed by user',
  0x05: 'Target speed changed',
  0x06: 'Target incline changed',
  0x07: 'Target resistance level changed',
  0x08: 'Target power changed',
  0x12: 'Indoor bike simulation parameters changed',
  0x13: 'Wheel circumference changed',
  0x14: 'Spin down status',
  0x15: 'Targeted cadence changed',
  0xff: 'Control permission lost',
};

/** Fitness Machine Status (0x2ADA) — used for diagnostics and to detect lost control. */
export function parseFitnessMachineStatus(view: DataView): { code: number; name: string } {
  const code = view.byteLength > 0 ? view.getUint8(0) : 0;
  return { code, name: STATUS_NAMES[code] ?? `Unknown (0x${code.toString(16)})` };
}
