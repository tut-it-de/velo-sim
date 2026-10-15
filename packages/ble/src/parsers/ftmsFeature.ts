import { ByteReader } from '../bytes';

/** Decoded Fitness Machine Feature (0x2ACC): what the trainer measures and what it accepts as targets. */
export interface FtmsFeatures {
  cadence: boolean;
  power: boolean;
  heartRate: boolean;
  targetPower: boolean;
  targetResistance: boolean;
  indoorBikeSimulation: boolean;
  wheelCircumference: boolean;
  spinDown: boolean;
  targetCadence: boolean;
  raw: { machine: number; target: number };
}

export function parseFtmsFeatures(view: DataView): FtmsFeatures {
  const r = new ByteReader(view);
  const machine = r.uint32();
  const target = r.remaining >= 4 ? r.uint32() : 0;
  return {
    cadence: (machine & (1 << 1)) !== 0,
    heartRate: (machine & (1 << 10)) !== 0,
    power: (machine & (1 << 14)) !== 0,
    targetResistance: (target & (1 << 2)) !== 0,
    targetPower: (target & (1 << 3)) !== 0,
    indoorBikeSimulation: (target & (1 << 13)) !== 0,
    wheelCircumference: (target & (1 << 14)) !== 0,
    spinDown: (target & (1 << 15)) !== 0,
    targetCadence: (target & (1 << 16)) !== 0,
    raw: { machine, target },
  };
}
