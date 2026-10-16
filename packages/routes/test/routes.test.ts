import { describe, expect, it } from 'vitest';
import { ROUTES, getTrack } from '../src';

describe('route catalogue', () => {
  const kueste = getTrack('kuestenrunde');
  const huegel = getTrack('huegelrunde');
  const berg = getTrack('bergrunde');

  it('has the planned lengths (10–20 km)', () => {
    expect(kueste.length).toBeCloseTo(16000, -1);
    expect(huegel.length).toBeCloseTo(13000, -1);
    expect(berg.length).toBeCloseTo(18000, -1);
    for (const r of ROUTES.filter((r) => !r.path)) {
      const t = getTrack(r.id);
      expect(t.length).toBeGreaterThanOrEqual(10000);
      expect(t.length).toBeLessThanOrEqual(20000);
    }
  });

  it('flat / rolling / mountainous elevation gain', () => {
    expect(kueste.elevationGain).toBeGreaterThan(30);
    expect(kueste.elevationGain).toBeLessThan(70);
    expect(huegel.elevationGain).toBeGreaterThan(170);
    expect(huegel.elevationGain).toBeLessThan(250);
    expect(berg.elevationGain).toBeGreaterThan(420);
    expect(berg.elevationGain).toBeLessThan(540);
  });

  it('respects grade limits (KICKR Core: +16 % / −10 %)', () => {
    expect(kueste.maxGrade).toBeLessThan(3);
    expect(huegel.maxGrade).toBeLessThan(9);
    expect(huegel.maxGrade).toBeGreaterThan(5);
    expect(berg.maxGrade).toBeLessThanOrEqual(12.5);
    expect(berg.maxGrade).toBeGreaterThan(10);
    for (const t of [kueste, huegel, berg]) expect(t.minGrade).toBeGreaterThan(-10);
  });

  it('the main climb of the Bergrunde averages about 7 %', () => {
    const climb = berg.segments.find((s) => s.id === 'passo-alto')!;
    const avg = ((berg.sample(climb.endM).y - berg.sample(climb.startM).y) / (climb.endM - climb.startM)) * 100;
    expect(avg).toBeGreaterThan(6.5);
    expect(avg).toBeLessThan(8);
  });

  it('closes the loop smoothly', () => {
    for (const t of [kueste, huegel, berg, getTrack('lago-di-como')]) {
      const end = t.sample(t.length - 1);
      const start = t.sample(0);
      expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(2);
      expect(Math.abs(end.y - start.y)).toBeLessThan(0.5);
    }
  });

  it('wraps distances over multiple laps', () => {
    const a = kueste.sample(1234);
    const b = kueste.sample(1234 + 3 * kueste.length);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.distanceM).toBeCloseTo(1234, 6);
  });

  it('heading points along the direction of travel', () => {
    const a = huegel.sample(500);
    const b = huegel.sample(510);
    const dirX = b.x - a.x;
    const dirZ = b.z - a.z;
    const len = Math.hypot(dirX, dirZ);
    expect(Math.sin(a.heading)).toBeCloseTo(dirX / len, 1);
    expect(Math.cos(a.heading)).toBeCloseTo(dirZ / len, 1);
  });

  it('lateral offset is perpendicular and has the right length', () => {
    const c = berg.positionAt(4000, 0);
    const r = berg.positionAt(4000, 3);
    expect(Math.hypot(r.x - c.x, r.z - c.z)).toBeCloseTo(3, 5);
    const s = berg.sample(4000);
    const fwdX = Math.sin(s.heading);
    const fwdZ = Math.cos(s.heading);
    expect(fwdX * (r.x - c.x) + fwdZ * (r.z - c.z)).toBeCloseTo(0, 5);
  });

  it('segments lie within the lap', () => {
    for (const r of ROUTES) for (const s of r.segments) {
      expect(s.startM).toBeGreaterThanOrEqual(0);
      expect(s.endM).toBeLessThanOrEqual(r.lengthM);
      expect(s.endM).toBeGreaterThan(s.startM);
    }
  });

  it('profile spans the whole lap', () => {
    const p = kueste.profile(100);
    expect(p).toHaveLength(101);
    expect(p[0]![0]).toBe(0);
    expect(p.at(-1)![0]).toBeCloseTo(kueste.length);
  });
});

describe('Lago di Como (real road data)', () => {
  const como = getTrack('lago-di-como');

  it('is the real Bellagio loop', () => {
    expect(como.definition.world).toBe('lago-di-como');
    expect(como.length).toBeGreaterThan(22000);
    expect(como.length).toBeLessThan(24000);
    expect(Math.abs(como.length - como.definition.lengthM)).toBeLessThan(100);
  });

  it('starts at the lake and climbs to Civenna', () => {
    // lake level is 198 m; Bellagio's lakefront sits just above it
    expect(como.sample(0).y).toBeGreaterThan(198);
    expect(como.sample(0).y).toBeLessThan(215);
    expect(como.minElevation).toBeGreaterThan(198);
    expect(como.maxElevation).toBeGreaterThan(600);
    expect(como.maxElevation).toBeLessThan(700);
    expect(como.elevationGain).toBeGreaterThan(600);
    expect(como.elevationGain).toBeLessThan(760);
  });

  it('has no DEM spikes (roofs, trees) in the road profile', () => {
    expect(como.maxGrade).toBeLessThan(16);
    expect(como.minGrade).toBeGreaterThan(-16);
    // a 2 m step never jumps more than half a metre
    for (let i = 1; i < como.count; i++) expect(Math.abs(como.ys[i]! - como.ys[i - 1]!)).toBeLessThan(0.5);
  });

  it('the Civenna climb is a proper climb', () => {
    const climb = como.segments.find((s) => s.type === 'climb')!;
    const avg = ((como.sample(climb.endM).y - como.sample(climb.startM).y) / (climb.endM - climb.startM)) * 100;
    expect(climb.endM - climb.startM).toBeGreaterThan(3000);
    expect(avg).toBeGreaterThan(5);
    expect(avg).toBeLessThan(9);
  });
});
