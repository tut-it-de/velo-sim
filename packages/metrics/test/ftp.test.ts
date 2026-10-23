import { describe, expect, it } from 'vitest';
import { CURVE_DURATIONS, estimateFtp, fitCriticalPower, hourFactor, powerCurve, sparseCurve, type CurveRide } from '../src/ftp';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);

/** A rider with CP 250 W and W′ 20 kJ, riding all-out over `maxS` seconds at most. */
function maxedCurve(maxS: number): number[] {
  return CURVE_DURATIONS.map((d) => (d <= maxS ? Math.round(250 + 20000 / d) : 0));
}

describe('FTP estimate', () => {
  it('scales single efforts to an hour like Zwift', () => {
    expect(hourFactor(480)).toBeCloseTo(0.9);
    expect(hourFactor(1200)).toBeCloseTo(0.95);
    expect(hourFactor(3600)).toBeCloseTo(1);
    expect(hourFactor(900)).toBeGreaterThan(0.9);
    expect(hourFactor(900)).toBeLessThan(0.95);
  });

  it('fits Critical Power from work over time', () => {
    const fit = fitCriticalPower([180, 300, 600, 1200].map((t) => ({ t, p: 250 + 20000 / t })))!;
    expect(fit.cp).toBeCloseTo(250, 3);
    expect(fit.wPrime).toBeCloseTo(20000, 0);
    expect(fit.r2).toBeCloseTo(1, 6);
  });

  it('finds the FTP of a rider who went hard over 20 minutes', () => {
    const rides: CurveRide[] = [0, 3, 7].map((d) => ({ startTime: NOW - d * DAY, durationS: 3000, curve: maxedCurve(1200) }));
    const e = estimateFtp(rides, NOW)!;
    expect(e.ftp).toBeGreaterThanOrEqual(245);
    expect(e.ftp).toBeLessThanOrEqual(260);
    expect(e.confidence).toBe('hoch');
    expect(e.rides).toBe(3);
  });

  it('gives only a rough, low-confidence guess from short efforts', () => {
    const e = estimateFtp([{ startTime: NOW, durationS: 400, curve: maxedCurve(300) }], NOW)!;
    expect(e.confidence).toBe('niedrig');
    expect(e.ftp).toBe(Math.round(Math.round(250 + 20000 / 300) * 0.85));
  });

  it('ignores rides older than 42 days and rides without power', () => {
    expect(estimateFtp([{ startTime: NOW - 50 * DAY, durationS: 3600, curve: maxedCurve(3600) }], NOW)).toBeUndefined();
    expect(estimateFtp([{ startTime: NOW, durationS: 120, curve: maxedCurve(60) }], NOW)).toBeUndefined();
  });

  it('works with the sparse curve of older rides (1/5/20 min)', () => {
    const e = estimateFtp([{ startTime: NOW, durationS: 1800, curve: sparseCurve(400, 300, 260) }], NOW)!;
    expect(e.ftp).toBe(Math.round(260 * 0.95));
  });

  it('builds the curve from 1 Hz samples', () => {
    const c = powerCurve(Array.from({ length: 600 }, (_, i) => (i < 300 ? 300 : 100)));
    expect(c[CURVE_DURATIONS.indexOf(300)]).toBe(300);
    expect(c[CURVE_DURATIONS.indexOf(600)]).toBe(200);
    expect(c[CURVE_DURATIONS.indexOf(1200)]).toBe(0);
  });
});
