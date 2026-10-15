import { ByteWriter, clamp } from '../bytes';

/**
 * Wahoo's legacy trainer protocol (characteristic a026e005-… inside the Cycling
 * Power service). Used only when the trainer firmware does not expose FTMS.
 *
 * The op codes match the open-source implementations (GoldenCheetah, qdomyos-zwift).
 * The scaling of the sim-mode parameters is NOT verified on real hardware yet —
 * Phase 0 checks this against the KICKR Core. FTMS is always preferred.
 */
export const WahooOpCode = {
  Unlock: 0x20,
  SetResistanceMode: 0x40,
  SetStandardMode: 0x41,
  SetErgMode: 0x42,
  SetSimMode: 0x43,
  SetSimCrr: 0x44,
  SetSimWindResistance: 0x45,
  SetSimGrade: 0x46,
  SetSimWindSpeed: 0x47,
  SetWheelCircumference: 0x48,
} as const;

export function encodeWahooUnlock(): Uint8Array {
  return Uint8Array.of(WahooOpCode.Unlock, 0xee, 0xfc);
}

export function encodeWahooErg(watts: number): Uint8Array {
  return new ByteWriter()
    .uint8(WahooOpCode.SetErgMode)
    .uint16(clamp(Math.round(watts), 0, 4000))
    .toUint8Array();
}

export interface WahooSimMode {
  /** Rider + bike weight in kg. */
  weightKg: number;
  crr: number;
  /** Wind resistance coefficient in kg/m. */
  windResistance: number;
}

export function encodeWahooSimMode(p: WahooSimMode): Uint8Array {
  return new ByteWriter()
    .uint8(WahooOpCode.SetSimMode)
    .uint16(clamp(Math.round(p.weightKg * 100), 0, 0xffff))
    .uint16(clamp(Math.round(p.crr * 10000), 0, 0xffff))
    .uint16(clamp(Math.round(p.windResistance * 1000), 0, 0xffff))
    .toUint8Array();
}

/** Grade is sent as a fraction in [-1, 1] mapped onto 0…65535. */
export function encodeWahooSimGrade(gradePercent: number): Uint8Array {
  const fraction = clamp(gradePercent / 100, -1, 1);
  return new ByteWriter()
    .uint8(WahooOpCode.SetSimGrade)
    .uint16(Math.round(((fraction + 1) * 0xffff) / 2))
    .toUint8Array();
}

export function encodeWahooSimWindSpeed(mps: number): Uint8Array {
  return new ByteWriter()
    .uint8(WahooOpCode.SetSimWindSpeed)
    .uint16(clamp(Math.round((mps + 32.768) * 1000), 0, 0xffff))
    .toUint8Array();
}
