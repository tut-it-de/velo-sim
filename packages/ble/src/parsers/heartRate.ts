import { ByteReader } from '../bytes';

/** Decoded Heart Rate Measurement (0x2A37). */
export interface HeartRateMeasurement {
  heartRate: number;
  /** undefined when the sensor does not support contact detection */
  contactDetected?: boolean;
  energyExpendedKj?: number;
  rrIntervalsMs: number[];
}

export function parseHeartRateMeasurement(view: DataView): HeartRateMeasurement {
  const r = new ByteReader(view);
  const flags = r.uint8();
  const heartRate = flags & 0x01 ? r.uint16() : r.uint8();
  const contactSupported = (flags & 0x04) !== 0;
  const out: HeartRateMeasurement = { heartRate, rrIntervalsMs: [] };
  if (contactSupported) out.contactDetected = (flags & 0x02) !== 0;
  if (flags & 0x08) out.energyExpendedKj = r.uint16();
  if (flags & 0x10) {
    while (r.remaining >= 2) out.rrIntervalsMs.push((r.uint16() / 1024) * 1000);
  }
  return out;
}
