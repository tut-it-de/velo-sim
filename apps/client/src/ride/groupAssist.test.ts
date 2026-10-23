import { describe, expect, it } from 'vitest';
import { STARTER_LOADOUT, setupFor } from '@velo/equipment';
import { draftReduction, step, type RiderState } from '@velo/physics';
import { getTrack } from '@velo/routes';
import { ASSIST, GroupAssist, assistConstrain, assistEnvironment } from './groupAssist';

interface SimRider {
  wkg: number;
  weightKg: number;
  state: RiderState;
  assist: GroupAssist;
}

/**
 * Rides a group like the app does: physics at 10 Hz per rider, the server's median every 250 ms,
 * arriving 250 ms late. Returns the largest spread after the first `settleS` seconds.
 */
function simulate(opts: { riders: Array<{ wkg: number; weightKg: number }>; together: boolean; grade: (d: number) => number; minutes: number; settleS?: number }) {
  const dt = 0.1;
  const riders: SimRider[] = opts.riders.map((r) => ({ ...r, state: { speedMps: 0, distanceM: 0 }, assist: new GroupAssist(opts.together) }));
  const setups = riders.map((r) => setupFor({ weightKg: r.weightKg, heightCm: 178 }, STARTER_LOADOUT));
  let pending: { d: number; v: number; n: number; due: number } | undefined;
  let maxSpread = 0;
  let maxSpeed = 0;
  const steps = (opts.minutes * 60) / dt;
  for (let i = 0; i < steps; i++) {
    const now = i * dt * 1000;
    if (i % 2 === 0 && i % 5 === 0) {
      // server tick (4 Hz ≈ every 250 ms; every 500 ms here keeps it conservative)
      const ds = riders.map((r) => r.state.distanceM).sort((a, b) => a - b);
      const vs = riders.map((r) => r.state.speedMps).sort((a, b) => a - b);
      const m = ds.length >> 1;
      const med = (xs: number[]) => (xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2);
      pending = { d: med(ds), v: med(vs), n: riders.length, due: now + 250 };
    }
    if (pending && now >= pending.due) {
      for (const r of riders) r.assist.update(pending.d, pending.v, pending.n, pending.due);
      pending = undefined;
    }
    riders.forEach((r, k) => {
      const ahead = Math.min(...riders.filter((o) => o !== r && o.state.distanceM > r.state.distanceM).map((o) => o.state.distanceM - r.state.distanceM), Infinity);
      const env = { gradePercent: opts.grade(r.state.distanceM), draftReduction: draftReduction(ahead - 1.8) };
      const power = r.wkg * r.weightKg;
      const next = step(r.state, power, setups[k]!, r.assist.environment(env, r.state, now), dt);
      r.state = r.assist.constrain(r.state, next, dt, now);
      maxSpeed = Math.max(maxSpeed, r.state.speedMps);
    });
    const ds = riders.map((r) => r.state.distanceM);
    if (i * dt >= (opts.settleS ?? 0)) maxSpread = Math.max(maxSpread, Math.max(...ds) - Math.min(...ds));
  }
  if (process.env.GROUP_SIM_LOG) console.log(JSON.stringify({ together: opts.together, maxSpread: Math.round(maxSpread * 10) / 10, maxSpeed, km: riders.map((r) => Math.round(r.state.distanceM) / 1000) }));
  return { maxSpread, maxSpeed, distance: riders.map((r) => r.state.distanceM) };
}

const pair = [
  { wkg: 2, weightKg: 75 },
  { wkg: 4, weightKg: 75 },
];

describe('group ride: stay together', () => {
  it('keeps 2 and 4 W/kg within 30 m on the flat', () => {
    const r = simulate({ riders: pair, together: true, grade: () => 0, minutes: 20 });
    expect(r.maxSpread).toBeLessThan(30);
    expect(Math.min(...r.distance)).toBeGreaterThan(9000); // still riding at a real pace (~30+ km/h)
  });

  it('keeps 2 and 4 W/kg within 30 m on a 7 % climb', () => {
    const r = simulate({ riders: pair, together: true, grade: () => 7, minutes: 20 });
    expect(r.maxSpread).toBeLessThan(30);
  });

  it('keeps a light 2 W/kg and a heavy 4 W/kg rider together on a real mountain route', () => {
    const track = getTrack('bergrunde');
    const r = simulate({
      riders: [
        { wkg: 2, weightKg: 60 },
        { wkg: 4, weightKg: 90 },
        { wkg: 3, weightKg: 75 },
      ],
      together: true,
      grade: (d) => track.sample(d).gradePercent,
      minutes: 30,
    });
    expect(r.maxSpread).toBeLessThan(30);
    expect(r.maxSpeed).toBeLessThan(25); // well under the server's 28 m/s plausibility limit
  });

  it('rides with normal physics when "stay together" is off', () => {
    const flat = simulate({ riders: pair, together: false, grade: () => 0, minutes: 20 });
    expect(flat.maxSpread).toBeGreaterThan(1500);
    const climb = simulate({ riders: pair, together: false, grade: () => 7, minutes: 20 });
    expect(climb.maxSpread).toBeGreaterThan(1500);
  });

  it('pushes riders behind and slows riders ahead, more with a larger gap', () => {
    const env = { gradePercent: 2, draftReduction: 0.1 };
    const me = (d: number) => ({ distanceM: d, speedMps: 8 });
    const group = { d: 100, v: 8 };
    expect(assistEnvironment(env, me(100), group)).toEqual(env);
    const S = ASSIST.SOFT_M;
    const behindHalf = assistEnvironment(env, me(100 - S / 2), group);
    const behindFull = assistEnvironment(env, me(100 - S), group);
    expect(behindHalf.gradePercent).toBeCloseTo(2 - ASSIST.MAX_GRADE / 2);
    expect(behindFull.gradePercent).toBeCloseTo(2 - ASSIST.MAX_GRADE);
    expect(behindFull.draftReduction).toBeCloseTo(0.1 + ASSIST.EXTRA_DRAFT);
    expect(assistEnvironment(env, me(100 - 2 * S), group).gradePercent).toBeCloseTo(behindFull.gradePercent); // capped
    const aheadFull = assistEnvironment(env, me(100 + S), group);
    expect(aheadFull.gradePercent).toBeCloseTo(2 + ASSIST.MAX_GRADE);
    expect(aheadFull.draftReduction).toBeCloseTo(0);
    // a rider slower than the group gets a little more push (damping)
    expect(assistEnvironment(env, { distanceM: 100 - S / 2, speedMps: 6 }, group).gradePercent).toBeLessThan(behindHalf.gradePercent);
  });

  it('pulls dropped riders back and holds riders who are too far ahead', () => {
    const group = { d: 1000, v: 8 };
    const dropped = assistConstrain({ distanceM: 899, speedMps: 5 }, { distanceM: 900, speedMps: 5 }, group, 0.1);
    expect(dropped.distanceM).toBeCloseTo(900 + ASSIST.PULL_MAX_MPS * 0.1);
    expect(dropped.speedMps).toBe(5); // the speed stays the rider's own
    const stopped = assistConstrain({ distanceM: 900, speedMps: 0 }, { distanceM: 900, speedMps: 0 }, group, 0.1);
    expect(stopped.distanceM).toBe(900);
    const ahead = assistConstrain({ distanceM: 1059, speedMps: 12 }, { distanceM: 1070, speedMps: 12 }, group, 0.1);
    expect(ahead.distanceM).toBe(1060);
    expect(ahead.speedMps).toBe(8.5);
    const never = assistConstrain({ distanceM: 1100, speedMps: 3 }, { distanceM: 1100.3, speedMps: 3 }, group, 0.1);
    expect(never.distanceM).toBe(1100); // never moved backwards
  });

  it('does nothing alone or without a group position', () => {
    const a = new GroupAssist(true);
    const env = { gradePercent: 3 };
    expect(a.environment(env, { distanceM: 0, speedMps: 5 }, 0)).toBe(env);
    a.update(100, 8, 1, 0);
    expect(a.environment(env, { distanceM: 0, speedMps: 5 }, 0)).toBe(env);
    a.update(100, 8, 2, 0);
    expect(a.environment(env, { distanceM: 0, speedMps: 5 }, 100).gradePercent).toBeLessThan(0);
    expect(a.state.get()).toMatchObject({ mode: 'hold', riders: 2 });
    expect(a.environment(env, { distanceM: 0, speedMps: 5 }, 9000)).toBe(env); // stale fix
  });
});
