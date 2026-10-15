import { describe, expect, it } from 'vitest';
import {
  ByteWriter,
  CrankCadenceCalculator,
  ParseError,
  describeUuid,
  normalizeUuid,
  parseCscMeasurement,
  parseCyclingPowerMeasurement,
  parseFtmsFeatures,
  parseHeartRateMeasurement,
  parseIndoorBikeData,
} from '../src';

const dv = (...bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer);

describe('uuids', () => {
  it('normalises short and long forms', () => {
    expect(normalizeUuid('1826')).toBe('00001826-0000-1000-8000-00805f9b34fb');
    expect(normalizeUuid(0x2ad2)).toBe('00002ad2-0000-1000-8000-00805f9b34fb');
    expect(normalizeUuid('A026E005-0A7D-4AB3-97FA-F1500F9FEB8B')).toBe('a026e005-0a7d-4ab3-97fa-f1500f9feb8b');
    expect(describeUuid('1826')).toBe('Fitness Machine (FTMS) (0x1826)');
  });
});

describe('parseIndoorBikeData', () => {
  it('decodes speed, cadence and power (typical KICKR packet)', () => {
    // flags 0x0044: speed present (bit0 = 0), cadence, power
    const view = new ByteWriter().uint16(0x0044).uint16(3250).uint16(180).int16(215).toDataView();
    expect(parseIndoorBikeData(view)).toEqual({ speedKmh: 32.5, cadence: 90, power: 215 });
  });

  it('honours the inverted "more data" bit', () => {
    const view = new ByteWriter().uint16(0x0041).int16(300).toDataView();
    expect(parseIndoorBikeData(view)).toEqual({ power: 300 });
  });

  it('decodes every optional field in order', () => {
    const view = new ByteWriter()
      .uint16(0x1fff) // all fields; bit0 = 1 means no instantaneous speed
      .uint16(2900) // avg speed
      .uint16(170) // cadence 85
      .uint16(160) // avg cadence 80
      .uint24(12345) // distance
      .int16(12) // resistance
      .int16(250) // power
      .int16(230) // avg power
      .uint16(400) // total kcal
      .uint16(0xffff) // per hour n/a
      .uint8(0xff) // per minute n/a
      .uint8(142) // HR
      .uint8(85) // MET 8.5
      .uint16(3600) // elapsed
      .uint16(600) // remaining
      .toDataView();
    expect(parseIndoorBikeData(view)).toEqual({
      averageSpeedKmh: 29,
      cadence: 85,
      averageCadence: 80,
      totalDistanceM: 12345,
      resistanceLevel: 12,
      power: 250,
      averagePower: 230,
      totalEnergyKcal: 400,
      heartRate: 142,
      metabolicEquivalent: 8.5,
      elapsedTimeS: 3600,
      remainingTimeS: 600,
    });
  });

  it('throws a ParseError on truncated packets', () => {
    expect(() => parseIndoorBikeData(dv(0x44, 0x00, 0x10))).toThrow(ParseError);
  });
});

describe('parseCyclingPowerMeasurement', () => {
  it('decodes power and crank revolution data', () => {
    const view = new ByteWriter().uint16(0x0020).int16(250).uint16(1000).uint16(2048).toDataView();
    expect(parseCyclingPowerMeasurement(view)).toEqual({ power: 250, crank: { revolutions: 1000, eventTime: 2048 } });
  });

  it('skips fields it does not use and still finds accumulated energy', () => {
    const view = new ByteWriter()
      .uint16(0x0001 | 0x0010 | 0x0020 | 0x0040 | 0x0800)
      .int16(-5)
      .uint8(100) // balance 50 %
      .uint32(77) // wheel revs
      .uint16(4096)
      .uint16(10) // crank revs
      .uint16(1024)
      .int16(300) // extreme force max
      .int16(-20) // extreme force min
      .uint16(42) // accumulated energy kJ
      .toDataView();
    const m = parseCyclingPowerMeasurement(view);
    expect(m.power).toBe(-5);
    expect(m.pedalPowerBalancePercent).toBe(50);
    expect(m.wheel).toEqual({ revolutions: 77, eventTime: 4096 });
    expect(m.crank).toEqual({ revolutions: 10, eventTime: 1024 });
    expect(m.accumulatedEnergyKj).toBe(42);
  });
});

describe('parseHeartRateMeasurement', () => {
  it('decodes 8-bit HR', () => {
    expect(parseHeartRateMeasurement(dv(0x00, 72))).toEqual({ heartRate: 72, rrIntervalsMs: [] });
  });

  it('decodes 16-bit HR with contact and RR intervals', () => {
    const m = parseHeartRateMeasurement(dv(0x17, 0x2c, 0x01, 0x00, 0x04));
    expect(m.heartRate).toBe(300);
    expect(m.contactDetected).toBe(true);
    expect(m.rrIntervalsMs).toEqual([1000]);
  });
});

describe('parseCscMeasurement', () => {
  it('decodes crank-only packets', () => {
    expect(parseCscMeasurement(dv(0x02, 0x0a, 0x00, 0x00, 0x04))).toEqual({ crank: { revolutions: 10, eventTime: 1024 } });
  });
});

describe('parseFtmsFeatures', () => {
  it('reads ERG and SIM support bits', () => {
    const view = new ByteWriter().uint32((1 << 1) | (1 << 14)).uint32((1 << 3) | (1 << 13)).toDataView();
    const f = parseFtmsFeatures(view);
    expect(f.cadence).toBe(true);
    expect(f.power).toBe(true);
    expect(f.targetPower).toBe(true);
    expect(f.indoorBikeSimulation).toBe(true);
    expect(f.targetResistance).toBe(false);
  });
});

describe('CrankCadenceCalculator', () => {
  it('computes rpm from consecutive events', () => {
    const c = new CrankCadenceCalculator();
    c.update(100, 0, 0);
    // 1.5 revolutions per second → 90 rpm; 3 revs in 2 s = 2048 ticks
    expect(c.update(103, 2048, 2000)).toBeCloseTo(90);
  });

  it('handles 16-bit wrap-around of both counters', () => {
    const c = new CrankCadenceCalculator();
    c.update(65535, 65000, 0);
    // +2 revs, +1024 ticks (wrapped) → 120 rpm
    expect(c.update(1, (65000 + 1024) % 65536, 1000)).toBeCloseTo(120);
  });

  it('falls to zero when no new crank event arrives', () => {
    const c = new CrankCadenceCalculator(2500);
    c.update(0, 0, 0);
    c.update(2, 1024, 1000);
    expect(c.update(2, 1024, 2000)).toBeCloseTo(120);
    expect(c.update(2, 1024, 4000)).toBe(0);
  });

  it('ignores impossible spikes', () => {
    const c = new CrankCadenceCalculator();
    c.update(0, 0, 0);
    c.update(1, 682, 700); // ~90 rpm
    expect(c.update(400, 700, 800)).toBeCloseTo(90, 0);
  });
});
