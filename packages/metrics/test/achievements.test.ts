import { describe, expect, it } from 'vitest';
import { evaluateAchievements, monthKey, type AchievementRide } from '../src/achievements';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 23, 12);
let n = 0;
const ride = (startTime: number, p: Partial<AchievementRide> = {}): AchievementRide => ({
  id: `r${n++}`,
  startTime,
  routeId: 'huegelrunde',
  distanceM: 30_000,
  durationS: 3600,
  ascentM: 300,
  lapCount: 0,
  simulated: false,
  ...p,
});
const ROUTES = ['huegelrunde', 'alpe-dhuez'];
const NAMES = { huegelrunde: 'Hügelrunde', 'alpe-dhuez': 'Alpe d’Huez' };

describe('achievements', () => {
  it('counts the month in German time', () => {
    // 31 Oct 23:30 UTC is already November in Germany
    expect(monthKey(Date.UTC(2026, 9, 31, 23, 30))).toBe('2026-11');
    expect(monthKey(Date.UTC(2026, 9, 31, 22, 30))).toBe('2026-10');
  });

  it('fills the monthly challenges and books past months too', () => {
    const rides = [
      ...Array.from({ length: 4 }, (_, i) => ride(Date.UTC(2026, 8, 2 + i, 10))), // September: 4 rides, 120 km
      ride(NOW - DAY, { distanceM: 110_000, durationS: 4 * 3600 }),
    ];
    const a = evaluateAchievements(rides, ROUTES, NAMES, NOW);
    expect(a.month).toBe('2026-10');
    const km = a.challenges.find((c) => c.metric === 'distance')!;
    expect(km.value).toBeCloseTo(110);
    expect(km.tiers.map((t) => t.done)).toEqual([true, false, false]);
    expect(a.earned.has('month:2026-09:rides:1')).toBe(true);
    expect(a.earned.has('month:2026-09:distance:1')).toBe(true);
    expect(a.earned.has('month:2026-10:rides:1')).toBe(false);
  });

  it('ignores simulator and implausible rides', () => {
    const a = evaluateAchievements([ride(NOW, { simulated: true }), ride(NOW, { distanceM: 200_000, durationS: 3600 })], ROUTES, NAMES, NOW);
    expect(a.earned.size).toBe(0);
    expect(a.badges.find((b) => b.key === 'first-ride')!.earnedAt).toBeUndefined();
  });

  it('awards badges with the ride that earned them', () => {
    const t0 = Date.UTC(2026, 8, 1, 10); // a Tuesday
    const rides = [
      ride(t0),
      ride(t0 + 7 * DAY, { routeId: 'alpe-dhuez', lapCount: 1, ascentM: 1100 }),
      ride(t0 + 14 * DAY, { ftpTest: true }),
      ride(t0 + 21 * DAY, { lapCount: 1, segmentPb: true }),
    ];
    const a = evaluateAchievements(rides, ROUTES, NAMES, NOW);
    const at = (k: string) => a.badges.find((b) => b.key === k)?.earnedAt;
    expect(at('first-ride')).toBe(t0);
    expect(at('km-100')).toBe(t0 + 21 * DAY);
    expect(at('alpe-21')).toBe(t0 + 7 * DAY);
    expect(at('ftp-test')).toBe(t0 + 14 * DAY);
    expect(at('streak-4')).toBe(t0 + 21 * DAY);
    expect(at('all-routes')).toBe(t0 + 21 * DAY);
    expect(at('route:alpe-dhuez')).toBe(t0 + 7 * DAY);
    expect(at('group-ride')).toBeUndefined();
    expect(a.earned.get('badge:all-routes')?.reward).toBe(2000);
    expect(a.earned.has('route:alpe-dhuez')).toBe(false);
  });

  it('breaks the streak after a week without riding', () => {
    const t0 = Date.UTC(2026, 8, 1, 10);
    const a = evaluateAchievements([0, 7, 21, 28].map((d) => ride(t0 + d * DAY)), ROUTES, NAMES, NOW);
    expect(a.badges.find((b) => b.key === 'streak-4')!.earnedAt).toBeUndefined();
  });
});
