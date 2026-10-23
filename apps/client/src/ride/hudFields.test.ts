import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HUD_LAYOUT,
  MAX_HUD_FIELDS,
  addField,
  fieldValue,
  liveIntensity,
  liveTss,
  moveField,
  removeField,
  sanitizeFields,
  sanitizeLayout,
  splitFields,
  type HudFieldId,
} from './hudFields';
import { LiveStats } from './liveStats';
import type { RideSnapshot } from './rideSession';

const snap = (p: Partial<RideSnapshot> = {}): RideSnapshot =>
  ({
    state: 'riding',
    movingS: 3600,
    distanceM: 30_000,
    lapDistanceM: 0,
    lap: 2,
    lapTimesS: [],
    speedMps: 10,
    power: 200,
    power3s: 210,
    cadence: 90,
    gradePercent: 3.2,
    elevationM: 0,
    ascentM: 120,
    avgPower: 190,
    normalizedPower: 200,
    kilojoules: 684,
    draft: 0,
    gear: 12,
    noTrainerData: false,
    others: [],
    activeSegments: [],
    coins: 0,
    coinsDisabled: false,
    teleported: false,
    autoPaused: false,
    testAborted: false,
    power10s: 205,
    lapPower: 195,
    lapPowerS: 600,
    canWattLock: false,
    ...p,
  }) as RideSnapshot;

const ctx = { ftp: 250, weightKg: 70 };

describe('HUD data fields', () => {
  it('computes IF and TSS from the running NP', () => {
    expect(liveIntensity(snap(), 250)).toBeCloseTo(0.8);
    // one hour at IF 0.8 → 64 TSS
    expect(liveTss(snap(), 250)).toBeCloseTo(64);
    expect(fieldValue('tss', snap(), ctx).value).toBe('64');
    expect(fieldValue('if', snap(), ctx).value).toBe('0.80');
    expect(fieldValue('tss', snap(), { ...ctx, ftp: 0 }).value).toBe('–');
  });

  it('formats power, W/kg, speed, time and the lap average', () => {
    expect(fieldValue('power3s', snap(), ctx)).toMatchObject({ value: '210', unit: 'W', sub: '3.0 W/kg · Z3' });
    expect(fieldValue('power10s', snap(), ctx).value).toBe('205');
    expect(fieldValue('wkg', snap(), ctx).value).toBe('3.0');
    expect(fieldValue('speed', snap(), ctx).value).toBe('36.0');
    expect(fieldValue('time', snap(), ctx).value).toBe('1:00:00');
    expect(fieldValue('lapPower', snap(), ctx)).toMatchObject({ value: '195', sub: 'Runde 2 · 10:00' });
    expect(fieldValue('lapPower', snap({ lapPowerS: 0 }), ctx).value).toBe('–');
    expect(fieldValue('grade', snap({ gradePercent: -2.5 }), ctx).value).toBe('−2.5');
    expect(fieldValue('heartRate', snap(), ctx).value).toBe('–');
  });

  it('shows the workout target and the time left in the block', () => {
    const workout = { mode: 'erg', targetWatts: 220, segmentRemainingS: 64.2, finished: false, segment: { label: 'Intervall 2' } } as unknown as RideSnapshot['workout'];
    expect(fieldValue('targetPower', snap({ workout }), ctx)).toMatchObject({ value: '220', sub: '✓ im Ziel' });
    expect(fieldValue('targetPower', snap({ workout, power3s: 180 }), ctx).sub).toBe('-40 W');
    expect(fieldValue('intervalRemaining', snap({ workout }), ctx)).toMatchObject({ value: '1:05', sub: 'Intervall 2' });
    expect(fieldValue('targetPower', snap(), ctx).value).toBe('–');
  });

  it('cleans stored lists and keeps the limit', () => {
    expect(sanitizeFields(['speed', 'speed', 'nope', 'targetPower', 'np'], 'free')).toEqual(['speed', 'np']);
    expect(sanitizeFields(['targetPower', 'intervalRemaining'], 'workout')).toEqual(['targetPower', 'intervalRemaining']);
    expect(sanitizeFields('x', 'free')).toEqual(DEFAULT_HUD_LAYOUT.free);
    const many = ['power3s', 'power10s', 'avgPower', 'np', 'wkg', 'heartRate', 'cadence', 'speed', 'distance'];
    expect(sanitizeFields(many, 'free')).toHaveLength(MAX_HUD_FIELDS);
    expect(sanitizeLayout({ free: [] })).toEqual({ free: [], workout: DEFAULT_HUD_LAYOUT.workout });
  });

  it('moves, adds and removes fields', () => {
    const l: HudFieldId[] = ['speed', 'power3s', 'cadence'];
    expect(moveField(l, 0, -1)).toEqual(l);
    expect(moveField(l, 0, 1)).toEqual(['power3s', 'speed', 'cadence']);
    expect(moveField(l, 2, -1)).toEqual(['speed', 'cadence', 'power3s']);
    expect(addField(l, 'speed')).toEqual(l);
    expect(addField(l, 'np')).toEqual([...l, 'np']);
    expect(addField(DEFAULT_HUD_LAYOUT.free, 'np')).toHaveLength(MAX_HUD_FIELDS);
    expect(removeField(l, 'power3s')).toEqual(['speed', 'cadence']);
  });

  it('splits like the old bar: 4 left, 3 right', () => {
    const [left, right] = splitFields(DEFAULT_HUD_LAYOUT.free);
    expect(left).toEqual(['speed', 'power3s', 'cadence', 'heartRate']);
    expect(right).toEqual(['distance', 'time', 'grade']);
    expect(splitFields(['np'])).toEqual([['np'], []]);
  });
});

describe('LiveStats', () => {
  it('keeps a 10-second average and the lap average', () => {
    const s = new LiveStats();
    for (let i = 0; i < 10; i++) s.addSecond(100);
    expect(s.power10s).toBe(100);
    for (let i = 0; i < 5; i++) s.addSecond(200);
    expect(s.power10s).toBe(150);
    expect(s.lapPower).toBeCloseTo(133.33, 1);
    s.lap();
    expect(s.lapPower).toBe(0);
    s.addSecond(300);
    expect(s.lapPower).toBe(300);
    expect(s.lapSeconds).toBe(1);
  });
});
