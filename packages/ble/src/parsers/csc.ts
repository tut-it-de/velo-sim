import { ByteReader } from '../bytes';
import type { RevolutionData } from './cyclingPower';

/** Decoded CSC Measurement (0x2A5B). Both event times use 1/1024 s resolution. */
export interface CscMeasurement {
  wheel?: RevolutionData;
  crank?: RevolutionData;
}

export function parseCscMeasurement(view: DataView): CscMeasurement {
  const r = new ByteReader(view);
  const flags = r.uint8();
  const out: CscMeasurement = {};
  if (flags & 0x01) out.wheel = { revolutions: r.uint32(), eventTime: r.uint16() };
  if (flags & 0x02) out.crank = { revolutions: r.uint16(), eventTime: r.uint16() };
  return out;
}
