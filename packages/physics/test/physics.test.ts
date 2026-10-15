import { describe, expect, it } from 'vitest';
import {
  baseCdA,
  draftReduction,
  msToKmh,
  powerForSpeed,
  steadySpeed,
  step,
  windResistanceCoefficient,
  type RiderSetup,
} from '../src';

// The two setups from the plan: start equipment vs. top aero equipment, 75 kg rider.
const start: RiderSetup = { riderMassKg: 75, bikeMassKg: 8.6, wheelsMassKg: 2.0, cda: 0.325, crr: 0.004 };
const topAero: RiderSetup = { riderMassKg: 75, bikeMassKg: 6.0, wheelsMassKg: 1.6, cda: 0.275, crr: 0.004 };

describe('steadySpeed', () => {
  it('matches the plan numbers on the flat (250 W)', () => {
    expect(msToKmh(steadySpeed(250, start, { gradePercent: 0 }))).toBeCloseTo(36.6, 0);
    expect(msToKmh(steadySpeed(250, topAero, { gradePercent: 0 }))).toBeCloseTo(38.7, 0);
  });

  it('matches the plan numbers on a 7 % climb (250 W)', () => {
    expect(msToKmh(steadySpeed(250, start, { gradePercent: 7 }))).toBeCloseTo(13.6, 0);
    expect(msToKmh(steadySpeed(250, topAero, { gradePercent: 7 }))).toBeCloseTo(14.1, 0);
  });

  it('is the inverse of powerForSpeed', () => {
    const env = { gradePercent: 3, headwindMps: 2 };
    const v = steadySpeed(300, start, env);
    expect(powerForSpeed(v, start, env)).toBeCloseTo(300, 3);
  });

  it('coasts to a terminal speed downhill and stalls on impossible climbs', () => {
    const descent = msToKmh(steadySpeed(0, start, { gradePercent: -6 }));
    expect(descent).toBeGreaterThan(50);
    expect(descent).toBeLessThan(75);
    expect(steadySpeed(0, start, { gradePercent: 5 })).toBe(0);
  });

  it('drafting makes you faster', () => {
    const solo = steadySpeed(200, start, { gradePercent: 0 });
    const draft = steadySpeed(200, start, { gradePercent: 0, draftReduction: draftReduction(1) });
    expect(msToKmh(draft - solo)).toBeGreaterThan(3);
  });
});

describe('step (integration)', () => {
  it('accelerates from standstill and converges to steady speed', () => {
    let s = { speedMps: 0, distanceM: 0 };
    for (let i = 0; i < 1500; i++) s = step(s, 250, start, { gradePercent: 0 }, 0.1);
    expect(s.speedMps).toBeCloseTo(steadySpeed(250, start, { gradePercent: 0 }), 1);
    expect(s.distanceM).toBeGreaterThan(500);
  });

  it('a big step equals many small steps', () => {
    const a = step({ speedMps: 8, distanceM: 0 }, 200, start, { gradePercent: 2 }, 1);
    let b = { speedMps: 8, distanceM: 0 };
    for (let i = 0; i < 100; i++) b = step(b, 200, start, { gradePercent: 2 }, 0.01);
    expect(a.speedMps).toBeCloseTo(b.speedMps, 3);
    expect(a.distanceM).toBeCloseTo(b.distanceM, 2);
  });

  it('never rolls backwards on a climb without power', () => {
    let s = { speedMps: 3, distanceM: 100 };
    for (let i = 0; i < 100; i++) s = step(s, 0, start, { gradePercent: 10 }, 0.1);
    expect(s.speedMps).toBe(0);
    expect(s.distanceM).toBeGreaterThanOrEqual(100);
  });

  it('heavier wheels accelerate slower', () => {
    const light = { ...start, wheelsMassKg: 1.2 };
    const heavy = { ...start, bikeMassKg: start.bikeMassKg - 0.8, wheelsMassKg: 2.0 }; // same total mass
    const a = step({ speedMps: 5, distanceM: 0 }, 400, light, { gradePercent: 0 }, 2);
    const b = step({ speedMps: 5, distanceM: 0 }, 400, heavy, { gradePercent: 0 }, 2);
    expect(a.speedMps).toBeGreaterThan(b.speedMps);
  });
});

describe('helpers', () => {
  it('scales CdA by body size', () => {
    expect(baseCdA(178, 75)).toBeCloseTo(0.3, 5);
    expect(baseCdA(190, 90)).toBeGreaterThan(0.31);
    expect(baseCdA(160, 55)).toBeLessThan(0.28);
  });

  it('draft falls off with distance', () => {
    expect(draftReduction(1)).toBeCloseTo(0.32);
    expect(draftReduction(5)).toBeLessThan(0.15);
    expect(draftReduction(20)).toBe(0);
    expect(draftReduction(-1)).toBe(0);
  });

  it('computes the FTMS wind coefficient', () => {
    expect(windResistanceCoefficient(0.32)).toBeCloseTo(0.196, 3);
  });
});
