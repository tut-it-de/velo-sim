import { ByteReader } from '../bytes';

export interface RevolutionData {
  /** Cumulative revolutions (wraps around). */
  revolutions: number;
  /** Time of the last revolution event in ticks (wraps at 65536). */
  eventTime: number;
}

/** Decoded Cycling Power Measurement (0x2A63). */
export interface CyclingPowerMeasurement {
  power: number;
  pedalPowerBalancePercent?: number;
  accumulatedTorqueNm?: number;
  /** Wheel event time resolution is 1/2048 s. */
  wheel?: RevolutionData;
  /** Crank event time resolution is 1/1024 s. */
  crank?: RevolutionData;
  accumulatedEnergyKj?: number;
}

const FLAG = {
  pedalPowerBalance: 1 << 0,
  accumulatedTorque: 1 << 2,
  wheelRevolution: 1 << 4,
  crankRevolution: 1 << 5,
  extremeForce: 1 << 6,
  extremeTorque: 1 << 7,
  extremeAngles: 1 << 8,
  topDeadSpot: 1 << 9,
  bottomDeadSpot: 1 << 10,
  accumulatedEnergy: 1 << 11,
} as const;

export function parseCyclingPowerMeasurement(view: DataView): CyclingPowerMeasurement {
  const r = new ByteReader(view);
  const flags = r.uint16();
  const out: CyclingPowerMeasurement = { power: r.int16() };

  if (flags & FLAG.pedalPowerBalance) out.pedalPowerBalancePercent = r.uint8() / 2;
  if (flags & FLAG.accumulatedTorque) out.accumulatedTorqueNm = r.uint16() / 32;
  if (flags & FLAG.wheelRevolution) {
    out.wheel = { revolutions: r.uint32(), eventTime: r.uint16() };
  }
  if (flags & FLAG.crankRevolution) {
    out.crank = { revolutions: r.uint16(), eventTime: r.uint16() };
  }
  if (flags & FLAG.extremeForce) r.skip(4);
  if (flags & FLAG.extremeTorque) r.skip(4);
  if (flags & FLAG.extremeAngles) r.skip(3);
  if (flags & FLAG.topDeadSpot) r.skip(2);
  if (flags & FLAG.bottomDeadSpot) r.skip(2);
  if (flags & FLAG.accumulatedEnergy) out.accumulatedEnergyKj = r.uint16();

  return out;
}
