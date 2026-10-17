import { describe, expect, it } from 'vitest';
import { getTrack } from '@velo/routes';
import {
  BIKES,
  CATALOG,
  JERSEYS,
  STARTER_LOADOUT,
  WHEELS,
  aeroStars,
  compareLoadouts,
  estimateTime,
  rideEarnings,
  setupFor,
  total,
  weightStars,
} from '../src';

const body = { weightKg: 75, heightCm: 178 };
const topAero = { bike: 'bike-servelo-a5', wheels: 'wheels-envi-65', jersey: 'jersey-skinsuit-carbon' };
const climber = { bike: 'bike-kanyon-ultimo', wheels: 'wheels-dsswiss-ark35', jersey: 'jersey-skinsuit-carbon' };

describe('catalogue', () => {
  it('has unique ids, free starter items and sane values', () => {
    expect(new Set(CATALOG.map((i) => i.id)).size).toBe(CATALOG.length);
    for (const id of Object.values(STARTER_LOADOUT)) expect(CATALOG.find((i) => i.id === id)?.price).toBe(0);
    expect(BIKES.length).toBeGreaterThanOrEqual(15);
    expect(WHEELS.length).toBeGreaterThanOrEqual(7);
    expect(JERSEYS.length).toBeGreaterThanOrEqual(10);
  });

  it('jerseys only change CdA slightly', () => {
    for (const j of JERSEYS) expect(Math.abs(j.cdaDelta)).toBeLessThanOrEqual(0.005);
  });

  it('derives star ratings', () => {
    // lying down beats any upright aero frame
    const fastest = BIKES.find((b) => b.id === 'bike-m6-hochracer')!;
    const lightest = BIKES.find((b) => b.id === 'bike-kanyon-ultimo')!;
    const basis = BIKES.find((b) => b.id === 'bike-basis')!;
    expect(aeroStars(fastest)).toBe(5);
    expect(aeroStars(basis)).toBe(1);
    expect(weightStars(lightest)).toBe(5);
    // a racing trike carries a third wheel and an axle
    expect(weightStars(BIKES.find((b) => b.id === 'bike-trivelo-sprint')!)).toBe(1);
    expect(weightStars(basis)).toBeLessThanOrEqual(2);
    expect(weightStars(JERSEYS[0]!)).toBeUndefined();
    for (const i of CATALOG) {
      expect(aeroStars(i)).toBeGreaterThanOrEqual(1);
      expect(aeroStars(i)).toBeLessThanOrEqual(5);
    }
  });
});

describe('setup', () => {
  it('starter vs. top aero matches the plan (CdA 0.325 vs 0.275)', () => {
    expect(setupFor(body, STARTER_LOADOUT).cda).toBeCloseTo(0.325, 3);
    expect(setupFor(body, topAero).cda).toBeCloseTo(0.275, 3);
    expect(setupFor(body, STARTER_LOADOUT).bikeMassKg + setupFor(body, STARTER_LOADOUT).wheelsMassKg).toBeCloseTo(10.6);
  });

  it('top aero gains about 1:25 on the 16 km Küstenrunde at 250 W', () => {
    const kueste = getTrack('kuestenrunde');
    const [cmp] = compareLoadouts([kueste], body, STARTER_LOADOUT, topAero, 250);
    expect(cmp!.deltaS).toBeLessThan(-60);
    expect(cmp!.deltaS).toBeGreaterThan(-110);
  });

  it('aero wins on the flat, the climbing bike wins on the Passo Alto', () => {
    const kueste = getTrack('kuestenrunde');
    const berg = getTrack('bergrunde');
    const a = setupFor(body, topAero);
    const c = setupFor(body, climber);
    expect(estimateTime(kueste, a, 220)).toBeLessThan(estimateTime(kueste, c, 220));
    const climb = berg.segments.find((s) => s.id === 'passo-alto')!;
    expect(estimateTime(berg, c, 220, climb.startM, climb.endM)).toBeLessThan(estimateTime(berg, a, 220, climb.startM, climb.endM));
  });
});

describe('economy', () => {
  it('pays per kJ plus bonuses', () => {
    const lines = rideEarnings({ kilojoules: 720.6, workoutKilojoules: 500, workoutCompleted: true, lapsCompleted: 2, firstLapOnRoute: true, personalBests: 1 });
    expect(lines.map((l) => l.reason)).toEqual(['work', 'lap', 'first-lap', 'pb', 'workout']);
    expect(total(lines)).toBe(720 + 100 + 500 + 100 + 100);
  });

  it('no laps → no first-lap bonus', () => {
    const lines = rideEarnings({ kilojoules: 10, workoutKilojoules: 0, workoutCompleted: false, lapsCompleted: 0, firstLapOnRoute: true, personalBests: 0 });
    expect(total(lines)).toBe(10);
  });
});
