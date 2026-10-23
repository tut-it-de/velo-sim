import { describe, expect, it } from 'vitest';
import {
  decomposeRects,
  distanceToRing,
  orientedRect,
  pieceRoof,
  planPieces,
  pointInRing,
  ringArea,
  skeletonRoof,
  straightSkeleton,
  type P3,
  type Poly,
  type RoofGeometry,
} from './roofs';

/** Ring from (x, z) pairs, rotated by `angle` and shifted, counter-clockwise as in worldData. */
function ring(pts: Array<[number, number]>, angle = 0, ox = 0, oz = 0): Float32Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const out = new Float32Array(pts.length * 2);
  pts.forEach(([x, z], i) => {
    out[i * 2] = ox + x * c - z * s;
    out[i * 2 + 1] = oz + x * s + z * c;
  });
  if (ringArea(out) < 0) throw new Error('test ring must be counter-clockwise');
  return out;
}

const RECT = [
  [0, 0],
  [12, 0],
  [12, 8],
  [0, 8],
] as Array<[number, number]>;
const L = [
  [0, 0],
  [14, 0],
  [14, 6],
  [6, 6],
  [6, 14],
  [0, 14],
] as Array<[number, number]>;
const T = [
  [0, 0],
  [18, 0],
  [18, 6],
  [11, 6],
  [11, 15],
  [6, 15],
  [6, 6],
  [0, 6],
] as Array<[number, number]>;
const U = [
  [0, 0],
  [16, 0],
  [16, 12],
  [11, 12],
  [11, 5],
  [5, 5],
  [5, 12],
  [0, 12],
] as Array<[number, number]>;
/** Oblique, concave footprints (no orthogonal walls). */
const ARROW = [
  [0, 0],
  [10, 2],
  [16, 9],
  [9, 7],
  [3, 12],
] as Array<[number, number]>;
const BOOT = [
  [0, 0],
  [9, -1],
  [14, 4],
  [13, 9],
  [7, 7.5],
  [5, 13],
  [-1, 11],
  [1, 5],
] as Array<[number, number]>;

const STYLE = { pitch: 0.6, eaves: 0.5 };
const TOP = 10;

function piecesRoof(r: Float32Array, kind: 'hip' | 'gable'): RoofGeometry {
  const frame = orientedRect(r);
  const pieces = decomposeRects(r, frame)!;
  const out: RoofGeometry = { roof: [], gables: [] };
  for (const p of planPieces(pieces)) pieceRoof(p, TOP, kind, STYLE, out);
  return out;
}

/** Every roof vertex lies inside the footprint or within the overhang (mitred corners: up to √2·eaves). */
function expectWithinOverhang(r: Float32Array, polys: Poly[], margin: number): void {
  for (const poly of polys) {
    for (const [x, , z] of poly.pts) {
      if (pointInRing(r, x, z)) continue;
      expect(distanceToRing(r, x, z)).toBeLessThanOrEqual(margin + 1e-6);
    }
  }
}

/** Point-in-polygon on the plan view of a roof polygon. */
function covers(poly: Poly, x: number, z: number): boolean {
  const flat: number[] = [];
  for (const p of poly.pts) flat.push(p[0], p[2]);
  return pointInRing(flat, x, z);
}

/** No holes: every point of the footprint lies under some roof plane at or above the wall tops. */
function expectClosed(r: Float32Array, polys: Poly[]): void {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]!);
    x1 = Math.max(x1, r[i]!);
    z0 = Math.min(z0, r[i + 1]!);
    z1 = Math.max(z1, r[i + 1]!);
  }
  for (let i = 1; i < 30; i++) {
    for (let j = 1; j < 30; j++) {
      const x = x0 + ((x1 - x0) * i) / 30;
      const z = z0 + ((z1 - z0) * j) / 30;
      if (!pointInRing(r, x, z) || distanceToRing(r, x, z) < 0.05) continue;
      expect(polys.some((p) => covers(p, x, z))).toBe(true);
    }
  }
}

describe('orientedRect', () => {
  it('fits a rotated rectangle exactly with u along the long side', () => {
    const r = orientedRect(ring(RECT, 0.4, 100, -50));
    expect(r.u1 - r.u0).toBeCloseTo(12, 4);
    expect(r.v1 - r.v0).toBeCloseTo(8, 4);
  });
});

describe('decomposeRects', () => {
  for (const [name, pts, count] of [
    ['L', L, 2],
    ['T', T, 2],
    ['U', U, 3],
  ] as const) {
    it(`splits a rotated ${name} footprint into ${count} rectangles without gaps or overlaps`, () => {
      const r = ring(pts as Array<[number, number]>, 0.7, 30, 20);
      const pieces = decomposeRects(r, orientedRect(r))!;
      expect(pieces).toHaveLength(count);
      const area = pieces.reduce((a, p) => a + (p.u1 - p.u0) * (p.v1 - p.v0), 0);
      expect(area).toBeCloseTo(ringArea(r), 2);
      for (const a of pieces) {
        for (const b of pieces) {
          if (a === b) continue;
          const ou = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
          const ov = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0);
          expect(ou <= 1e-6 || ov <= 1e-6).toBe(true);
        }
      }
    });
  }

  it('tolerates slightly crooked walls from the map', () => {
    const noisy = L.map(([x, z], i) => [x + (i % 2 ? 0.12 : -0.08), z + (i % 3 ? 0.1 : -0.06)] as [number, number]);
    expect(decomposeRects(ring(noisy, 1.1), orientedRect(ring(noisy, 1.1)))).toHaveLength(2);
  });

  it('rejects oblique footprints', () => {
    expect(decomposeRects(ring(ARROW), orientedRect(ring(ARROW)))).toBeNull();
  });
});

describe('planPieces', () => {
  it('lets the arm of an L run into the main wing by half its width', () => {
    const r = ring(L);
    const plan = planPieces(decomposeRects(r, orientedRect(r))!);
    const ext = plan.map((p) => p.ext0 + p.ext1).sort((a, b) => a - b);
    expect(ext[0]).toBe(0);
    expect(ext[1]).toBeCloseTo(3, 6);
  });
});

describe('straightSkeleton', () => {
  it('meets in the middle of a square', () => {
    const faces = straightSkeleton(ring([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]))!;
    expect(faces).toHaveLength(4);
    for (const f of faces) {
      expect(f.pts).toHaveLength(3);
      const apex = f.pts.find((p) => p[2] > 0)!;
      expect(apex[0]).toBeCloseTo(5, 6);
      expect(apex[1]).toBeCloseTo(5, 6);
      expect(apex[2]).toBeCloseTo(5, 6);
    }
  });

  it('builds a ridge over a rectangle', () => {
    const faces = straightSkeleton(ring(RECT, 0.3))!;
    const max = Math.max(...faces.flatMap((f) => f.pts.map((p) => p[2])));
    expect(max).toBeCloseTo(4, 6);
    expect(faces.map((f) => f.pts.length).sort()).toEqual([3, 3, 4, 4]);
  });

  for (const [name, pts] of [
    ['L', L],
    ['T', T],
    ['U', U],
    ['arrow', ARROW],
    ['boot', BOOT],
  ] as const) {
    it(`tiles the ${name} footprint with one face per edge`, () => {
      const r = ring(pts as Array<[number, number]>, 0.5, -20, 7);
      const faces = straightSkeleton(r)!;
      expect(faces).not.toBeNull();
      expect(faces).toHaveLength(r.length / 2);
      const area = faces.reduce((a, f) => a + ringArea(f.pts.flatMap((p) => [p[0], p[1]])), 0);
      expect(area).toBeCloseTo(ringArea(r), 3);
      for (const f of faces) {
        for (const [x, z, t] of f.pts) {
          // height = distance to the face's own edge line, never more than the distance to the outline
          expect(t).toBeLessThanOrEqual(distanceToRing(r, x, z) + 1e-4 + (pointInRing(r, x, z) ? 0 : Infinity));
        }
      }
    });
  }
});

describe('gable walls', () => {
  it('face out of the house at both ends', () => {
    const r = ring(RECT, 0.8, 3, -4);
    const rect = orientedRect(r);
    const out: RoofGeometry = { roof: [], gables: [] };
    pieceRoof({ rect, ext0: 0, ext1: 0, inner0: false, inner1: false }, TOP, 'gable', STYLE, out);
    expect(out.gables).toHaveLength(2);
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < r.length; i += 2) {
      cx += r[i]! / 4;
      cz += r[i + 1]! / 4;
    }
    for (const g of out.gables) {
      const [a, b, c] = g.pts as [P3, P3, P3];
      // normal = (b − a) × (c − a)
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
      const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      expect(nx * (a[0] - cx) + nz * (a[2] - cz)).toBeGreaterThan(0);
    }
  });
});

describe('roofs stay over the footprint', () => {
  for (const [name, pts] of [
    ['L', L],
    ['T', T],
    ['U', U],
  ] as const) {
    for (const kind of ['hip', 'gable'] as const) {
      it(`${kind} roofs over the pieces of a ${name}`, () => {
        const r = ring(pts as Array<[number, number]>, 0.9, 5, 5);
        const g = piecesRoof(r, kind);
        expectWithinOverhang(r, g.roof, STYLE.eaves * Math.SQRT2);
        expectWithinOverhang(r, g.gables, 0);
        expectClosed(r, g.roof);
        for (const p of g.roof) for (const q of p.pts) expect(q[1]).toBeGreaterThanOrEqual(TOP - STYLE.eaves * STYLE.pitch);
        for (const p of g.gables) for (const q of p.pts) expect(q[1]).toBeGreaterThanOrEqual(TOP - 1e-6);
      });
    }
  }

  for (const [name, pts] of [
    ['arrow', ARROW],
    ['boot', BOOT],
    ['L', L],
  ] as const) {
    it(`skeleton hip roof over the ${name} footprint`, () => {
      const r = ring(pts as Array<[number, number]>, 2.2, 40, -3);
      const g = skeletonRoof(r, TOP, STYLE)!;
      expect(g).not.toBeNull();
      // mitres are capped at 2.5·eaves
      expectWithinOverhang(r, g.roof, STYLE.eaves * 2.5);
      expectClosed(r, g.roof);
    });
  }

  it('gives up on very deep footprints', () => {
    const big = ring([
      [0, 0],
      [60, 0],
      [60, 40],
      [30, 50],
      [0, 40],
    ]);
    expect(skeletonRoof(big, TOP, STYLE, 6.5)).toBeNull();
  });
});
