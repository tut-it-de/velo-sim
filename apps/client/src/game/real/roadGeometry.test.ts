import { describe, expect, it } from 'vitest';
import { junctionOutline, polygonArea, segmentHit, selfIntersects, subdivide, triangulate, untangle, type Arm, type Vec2 } from './roadGeometry';

/** Right (inner) offset curve at offset o of a right-hand bend: 30 m straight, `turn` degrees on radius r, 30 m straight. */
function hairpin(r: number, o: number, turn = 150, step = 0.5): { x: Float32Array; z: Float32Array } {
  const x: number[] = [];
  const z: number[] = [];
  let px = 0;
  let pz = 0;
  let h = 0; // heading, clockwise from +z
  const arc = (Math.PI * r * turn) / 180;
  for (let s = 0; s <= 60 + arc; s += step) {
    if (s > 30 && s <= 30 + arc) h += step / r;
    px += Math.sin(h) * step;
    pz += Math.cos(h) * step;
    // right of travel with x east, z north: (cos h, -sin h)
    x.push(px + Math.cos(h) * o);
    z.push(pz - Math.sin(h) * o);
  }
  return { x: Float32Array.from(x), z: Float32Array.from(z) };
}

function crossings(x: Float32Array, z: Float32Array): number {
  let n = 0;
  for (let k = 0; k < x.length - 1; k++) {
    for (let j = k + 2; j < x.length - 1; j++) {
      if (segmentHit(x[k]!, z[k]!, x[k + 1]!, z[k + 1]!, x[j]!, z[j]!, x[j + 1]!, z[j + 1]!)) n++;
    }
  }
  return n;
}

describe('untangle', () => {
  it('removes the swallowtail of an offset curve wider than the bend', () => {
    const { x, z } = hairpin(4, 6);
    expect(crossings(x, z)).toBeGreaterThan(0);
    const moved = untangle(x, z, null, 0, x.length, 200);
    expect(moved.length).toBeGreaterThan(0);
    expect(crossings(x, z)).toBe(0);
  });

  it('leaves an offset curve inside the bend radius alone', () => {
    const { x, z } = hairpin(9, 4);
    const before = Float32Array.from(x);
    expect(untangle(x, z, null, 0, x.length)).toEqual([]);
    expect(Array.from(x)).toEqual(Array.from(before));
  });

  it('averages the heights of the collapsed points', () => {
    const { x, z } = hairpin(3, 5);
    const y = Float32Array.from(x, (_, k) => k * 0.1);
    const moved = untangle(x, z, y, 0, x.length);
    const ys = new Set(moved.map((k) => y[k]!.toFixed(5)));
    expect(ys.size).toBe(1);
  });

  it('can veto crossings that are no swallowtail', () => {
    const { x, z } = hairpin(4, 6);
    expect(untangle(x, z, null, 0, x.length, 40, () => false)).toEqual([]);
  });
});

describe('triangulation', () => {
  it('covers a concave polygon exactly', () => {
    const poly: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [5, 4],
      [0, 10],
    ];
    const tris = triangulate(poly);
    expect(tris.length).toBe(9);
    let area = 0;
    for (let k = 0; k < tris.length; k += 3) area += polygonArea([poly[tris[k]!]!, poly[tris[k + 1]!]!, poly[tris[k + 2]!]!]);
    expect(area).toBeCloseTo(polygonArea(poly), 6);
    const sub = subdivide(poly, tris, 2);
    expect(sub.tris.length).toBe(tris.length * 16);
  });
});

describe('junction outlines', () => {
  const arm = (deg: number, hw: number, radius = 5, through = false): Arm => ({
    dir: [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)],
    hw,
    radius,
    through,
  });

  it('builds a simple, rounded mouth for a T junction on a through road', () => {
    const out = junctionOutline([arm(0, 3.8, 6, true), arm(90, 2.5, 6), arm(180, 3.8, 6, true)], 3);
    expect(selfIntersects(out.poly)).toBe(false);
    expect(polygonArea(out.poly)).toBeGreaterThan(0);
    // corners rounded with r = 6: the arm starts beyond the fillet
    expect(out.cut[1]).toBeGreaterThan(3.8 + 6 - 0.01);
    // nothing of the outline lies inside the through road beyond `inner`
    for (const p of out.poly) expect(p[1]).toBeGreaterThanOrEqual(3 - 1e-6);
  });

  it('handles oblique arms and crossroads', () => {
    for (const angles of [[0, 35, 180], [0, 60, 120, 180], [0, 150, 180]]) {
      const arms = angles.map((a, k) => arm(a, k === 0 || k === angles.length - 1 ? 3.8 : 2.5, 6, k === 0 || k === angles.length - 1));
      const out = junctionOutline(arms, 3);
      expect(selfIntersects(out.poly)).toBe(false);
      expect(polygonArea(out.poly)).toBeGreaterThan(0);
    }
  });

  it('closes around a node of side roads', () => {
    for (const angles of [[0, 120, 240], [0, 90, 180, 270], [10, 100, 190]]) {
      const out = junctionOutline(angles.map((a) => arm(a, 2, 3)));
      expect(selfIntersects(out.poly)).toBe(false);
      expect(polygonArea(out.poly)).toBeGreaterThan(0);
      expect(out.cut.every((c) => c >= 2)).toBe(true);
    }
  });
});
