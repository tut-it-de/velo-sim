/**
 * Geometry checks on the real routes (world files from public/worlds): ribbon edges without folds,
 * valid junction areas, no height steps where side roads join the ride's road.
 */
import { describe, expect, it } from 'vitest';
import { Noise2D } from '../noise';
import { crossSection, mouthMesh, mouthPoint, nodeMesh, planJunctions, polylineLength, sideRoadGround } from './junctions';
import { ROAD_COLS, drawnRuns, runGeometry } from './ribbonGeometry';
import { polygonArea, selfIntersects, subdivide, triangulate, type Vec2 } from './roadGeometry';
import { corridorFromDisk } from './routeFixture';

const ROUTES = ['lago-di-como', 'feldberg-taunus', 'alpe-dhuez', 'taunus-mammolshain'];

describe.each(ROUTES)('%s', (id) => {
  const { data, corridor: c } = corridorFromDisk(id);
  const plan = planJunctions(data.roads, c);

  it('road edges never fold back against the direction of travel', () => {
    const noise = new Noise2D(1);
    let worst = 0;
    let where = '';
    for (const run of drawnRuns(c)) {
      const geo = runGeometry(c, run, noise);
      for (const q of [0, 1, ROAD_COLS - 2, ROAD_COLS - 1]) {
        const lv = geo.road[q]!;
        for (let k = 0; k < run.length - 1; k++) {
          const fa = c.frames[run[k]!.r]!;
          const fb = c.frames[run[k + 1]!.r]!;
          // forward = right rotated: (−rz, rx), averaged over both rows
          const fx = -(fa.rz + fb.rz) / 2;
          const fz = (fa.rx + fb.rx) / 2;
          const back = -((lv.x[k + 1]! - lv.x[k]!) * fx + (lv.z[k + 1]! - lv.z[k]!) * fz);
          if (back > worst) {
            worst = back;
            where = `level ${q} at ${((run[k]!.r * c.rowLength) / 1000).toFixed(3)} km`;
          }
        }
      }
    }
    expect(worst, where).toBeLessThan(0.25);
  });

  it('junction areas are simple polygons that triangulate completely', () => {
    const polys = [...plan.mouths.map((m) => m.poly), ...plan.nodes.map((n) => n.poly)];
    for (const poly of polys) {
      expect(selfIntersects(poly)).toBe(false);
      const area = polygonArea(poly);
      expect(area).toBeGreaterThan(0);
      const tris = triangulate(poly);
      let sum = 0;
      for (let k = 0; k < tris.length; k += 3) sum += polygonArea([poly[tris[k]!]!, poly[tris[k + 1]!]!, poly[tris[k + 2]!]!]);
      expect(sum).toBeCloseTo(area, 3);
    }
  });

  it('side roads join the junction areas exactly and without a height step', () => {
    const ground = sideRoadGround(c, data.near);
    // a step is a jump that stays when the edge is halved again and again (steep but smooth ground shrinks)
    const jump = (h: (t: number) => number) => {
      let [t0, t1, h0, h1] = [0, 1, h(0), h(1)];
      for (let it = 0; it < 14; it++) {
        const tm = (t0 + t1) / 2;
        const hm = h(tm);
        if (Math.abs(hm - h0) > Math.abs(h1 - hm)) [t1, h1] = [tm, hm];
        else [t0, h0] = [tm, hm];
      }
      return Math.abs(h1 - h0);
    };
    let worstStep = 0;
    let where = '';
    const check = (pts: Vec2[], tris: number[], world: Array<[number, number, number]>, height: (p: Vec2) => number, tag: string) => {
      for (let k = 0; k < tris.length; k += 3) {
        for (const [i, j] of [[0, 1], [1, 2], [2, 0]] as const) {
          const p = world[tris[k + i]!]!;
          const q = world[tris[k + j]!]!;
          // only edges steeper than the steepest verge cut slopes are worth a closer look
          if (Math.abs(p[1] - q[1]) < 0.05 + 1.5 * Math.hypot(p[0] - q[0], p[2] - q[2])) continue;
          const a = pts[tris[k + i]!]!;
          const b = pts[tris[k + j]!]!;
          const step = jump((t) => height([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
          if (step > worstStep) [worstStep, where] = [step, tag];
        }
      }
    };
    for (const m of plan.mouths) {
      const sub = subdivide(m.poly, triangulate(m.poly), 2);
      check(sub.pts, sub.tris, mouthMesh(c, ground, m).pts, (p) => mouthPoint(c, ground, m, p)[1], `mouth at ${(m.s0 / 1000).toFixed(3)} km`);
    }
    for (const n of plan.nodes) {
      const sub = subdivide(n.poly, triangulate(n.poly), 2);
      check(sub.pts, sub.tris, nodeMesh(ground, n).pts, (p) => ground(n.x + p[0], n.z + p[1]), `node at ${n.x.toFixed(0)}, ${n.z.toFixed(0)}`);
    }
    expect(worstStep, where).toBeLessThan(0.05);
    for (const m of plan.mouths) {
      // each arm's first cross section is part of the outline
      for (const arm of m.arms) {
        const road = data.roads[arm.road]!;
        const cs = crossSection(road, arm.end, arm.cut, polylineLength(road.pts));
        for (const corner of [cs.left, cs.right]) {
          const d = Math.min(...m.fixed.map((f) => (f ? Math.hypot(f[0] - corner[0], f[1] - corner[1]) : Infinity)));
          expect(d).toBeLessThan(0.01);
        }
      }
      // the mouth starts on the ride's asphalt, just above it
      for (const x of [-2, 0, 2]) {
        const p = mouthPoint(c, ground, m, [x, 0.92 * m.hw]);
        const on = c.pointAt(m.s0 + m.sg * x, m.sg * 0.92 * m.hw);
        expect(p[1] - on.y).toBeGreaterThan(0);
        expect(p[1] - on.y).toBeLessThan(0.05);
      }
    }
  });
});
