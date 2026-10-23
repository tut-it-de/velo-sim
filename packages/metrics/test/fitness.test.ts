import { describe, expect, it } from 'vitest';
import { dayStart, fitnessSeries, formState, rampRate, weeklyLoad } from '../src/fitness';

const DAY = 86_400_000;
const T0 = new Date(2026, 8, 1, 18).getTime();

describe('fitness and form', () => {
  it('builds up fitness slowly and fatigue fast; form turns negative under load', () => {
    const rides = Array.from({ length: 28 }, (_, i) => ({ startTime: T0 + i * DAY, tss: 100 }));
    const s = fitnessSeries(rides, T0 + 27 * DAY);
    expect(s).toHaveLength(28);
    const last = s.at(-1)!;
    // after 4 weeks of 100 TSS a day: CTL ≈ 100·(1 − e^(−28/42)) ≈ 49, ATL close to 100
    expect(last.ctl).toBeGreaterThan(45);
    expect(last.ctl).toBeLessThan(53);
    expect(last.atl).toBeGreaterThan(95);
    expect(last.tsb).toBeLessThan(-40);
    expect(formState(last.tsb)).toBe('ermüdet');
    expect(rampRate(s)).toBeGreaterThan(8);
  });

  it('recovers form in a rest week and fills days without rides', () => {
    const rides = Array.from({ length: 21 }, (_, i) => ({ startTime: T0 + i * DAY, tss: 80 }));
    const s = fitnessSeries(rides, T0 + 32 * DAY);
    expect(s).toHaveLength(33);
    expect(s.at(-1)!.tss).toBe(0);
    expect(s.at(-1)!.tsb).toBeGreaterThan(5);
    expect(formState(s.at(-1)!.tsb)).toBe('frisch');
  });

  it('adds up rides of the same day and returns only the window', () => {
    const rides = [
      { startTime: T0, tss: 50 },
      { startTime: T0 + 2 * 3_600_000, tss: 30 },
      { startTime: T0 + 10 * DAY, tss: 60 },
    ];
    const s = fitnessSeries(rides, T0 + 10 * DAY, T0 + 5 * DAY);
    expect(s[0]!.day).toBe(dayStart(T0 + 5 * DAY));
    expect(s.at(-1)!.tss).toBe(60);
    const full = fitnessSeries(rides, T0 + 10 * DAY);
    expect(full[0]!.tss).toBe(80);
    expect(s.at(-1)!.ctl).toBeCloseTo(full.at(-1)!.ctl, 9);
  });

  it('sums TSS per week, Monday to Sunday', () => {
    // 2026-09-07 is a Monday
    const mon = new Date(2026, 8, 7, 10).getTime();
    const w = weeklyLoad([{ startTime: mon, tss: 40 }, { startTime: mon + 6 * DAY, tss: 20 }, { startTime: mon + 7 * DAY, tss: 5 }], 3, mon + 8 * DAY);
    expect(w.map((x) => x.tss)).toEqual([0, 60, 5]);
  });
});
