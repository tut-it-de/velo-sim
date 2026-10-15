import { ByteReader } from '../bytes';

/** Decoded FTMS Indoor Bike Data (0x2AD2). Only fields present in the packet are set. */
export interface IndoorBikeData {
  speedKmh?: number;
  averageSpeedKmh?: number;
  cadence?: number;
  averageCadence?: number;
  totalDistanceM?: number;
  resistanceLevel?: number;
  power?: number;
  averagePower?: number;
  totalEnergyKcal?: number;
  energyPerHourKcal?: number;
  energyPerMinuteKcal?: number;
  heartRate?: number;
  metabolicEquivalent?: number;
  elapsedTimeS?: number;
  remainingTimeS?: number;
}

const FLAG = {
  moreData: 1 << 0, // inverted: 0 means instantaneous speed IS present
  averageSpeed: 1 << 1,
  instantaneousCadence: 1 << 2,
  averageCadence: 1 << 3,
  totalDistance: 1 << 4,
  resistanceLevel: 1 << 5,
  instantaneousPower: 1 << 6,
  averagePower: 1 << 7,
  expendedEnergy: 1 << 8,
  heartRate: 1 << 9,
  metabolicEquivalent: 1 << 10,
  elapsedTime: 1 << 11,
  remainingTime: 1 << 12,
} as const;

export function parseIndoorBikeData(view: DataView): IndoorBikeData {
  const r = new ByteReader(view);
  const flags = r.uint16();
  const out: IndoorBikeData = {};

  if ((flags & FLAG.moreData) === 0) out.speedKmh = r.uint16() / 100;
  if (flags & FLAG.averageSpeed) out.averageSpeedKmh = r.uint16() / 100;
  if (flags & FLAG.instantaneousCadence) out.cadence = r.uint16() / 2;
  if (flags & FLAG.averageCadence) out.averageCadence = r.uint16() / 2;
  if (flags & FLAG.totalDistance) out.totalDistanceM = r.uint24();
  if (flags & FLAG.resistanceLevel) out.resistanceLevel = r.int16();
  if (flags & FLAG.instantaneousPower) out.power = r.int16();
  if (flags & FLAG.averagePower) out.averagePower = r.int16();
  if (flags & FLAG.expendedEnergy) {
    const total = r.uint16();
    const perHour = r.uint16();
    const perMinute = r.uint8();
    // 0xFFFF / 0xFF mean "data not available"
    if (total !== 0xffff) out.totalEnergyKcal = total;
    if (perHour !== 0xffff) out.energyPerHourKcal = perHour;
    if (perMinute !== 0xff) out.energyPerMinuteKcal = perMinute;
  }
  if (flags & FLAG.heartRate) out.heartRate = r.uint8();
  if (flags & FLAG.metabolicEquivalent) out.metabolicEquivalent = r.uint8() / 10;
  if (flags & FLAG.elapsedTime) out.elapsedTimeS = r.uint16();
  if (flags & FLAG.remainingTime) out.remainingTimeS = r.uint16();

  return out;
}
