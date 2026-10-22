import { Color3, StandardMaterial, type Mesh, type Scene } from '@babylonjs/core';
import { createRng, smoothstep } from '../noise';
import { SHOULDER, VERGE_OUT, type RouteCorridor, type RouteHit } from './corridor';
import { gridContains, triSample } from './heightField';
import { MeshData } from './meshData';
import type { QualityProfile } from './quality';
import type { WorldData } from './worldData';

const TILE = 768;
const MAX_STEP = 6;
const LIFT = 0.12;
/** Lanes stop this far outside the ride's road (asphalt + shoulder). */
const JOIN_GAP = 0.15;
const REACH: Record<QualityProfile['level'], number> = { ultra: 1100, hoch: 900, mittel: 600, niedrig: 300 };

/**
 * Village streets, farm lanes and forest tracks from OpenStreetMap, draped over the full-resolution
 * terrain near the lap. Where they meet the ride's own road they run up to its edge with a slightly flared mouth,
 * so crossings and turn-offs read as junctions (they are scenery: the ride stays on the lap). Sampled at the terrain's
 * own triangulation so they never sink into a slope.
 */
export function buildSideRoads(scene: Scene, data: WorldData, corridor: RouteCorridor, quality: QualityProfile): Mesh[] {
  const g = data.near;
  const wl = data.waterLevel;
  const reach = REACH[quality.level];
  const rng = createRng(99);
  const mat = new StandardMaterial('side-roads', scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = new Color3(0.03, 0.03, 0.03);
  mat.zOffset = -2;

  const tiles = new Map<number, MeshData>();
  const tileOf = (x: number, z: number) => {
    const key = (Math.floor((x - g.x0) / TILE) + 64) * 256 + Math.floor((z - g.z0) / TILE) + 64;
    let md = tiles.get(key);
    if (!md) tiles.set(key, (md = new MeshData(false, true)));
    return md;
  };

  const height = (x: number, z: number): number => {
    const dem = triSample(g.heights, g.nx, (x - g.x0) / g.step, (z - g.z0) / g.step);
    const hit = corridor.nearest(x, z, VERGE_OUT);
    if (!hit) return dem;
    return corridor.profile(hit.row, hit.offset >= 0 ? 1 : 0, Math.abs(hit.offset), dem, hit.y);
  };

  for (const road of data.roads) {
    const pts = road.pts;
    const n = pts.length / 2;
    if (n < 2) continue;
    // resample the polyline
    const xs: number[] = [];
    const zs: number[] = [];
    for (let k = 0; k < n - 1; k++) {
      const ax = pts[2 * k]!;
      const az = pts[2 * k + 1]!;
      const bx = pts[2 * k + 2]!;
      const bz = pts[2 * k + 3]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / MAX_STEP));
      for (let s = 0; s < steps; s++) {
        xs.push(ax + ((bx - ax) * s) / steps);
        zs.push(az + ((bz - az) * s) / steps);
      }
    }
    xs.push(pts[2 * n - 2]!);
    zs.push(pts[2 * n - 1]!);

    const hw = road.width / 2;
    const tint = road.track ? [0.5, 0.43, 0.33] : [0.42, 0.41, 0.4];
    // Distance of a point outside the ride's road (asphalt + shoulder); null = far from the lap.
    const gapAt = (x: number, z: number): { gap: number; hit: RouteHit } | null => {
      const hit = corridor.nearest(x, z, 24);
      if (!hit) return null;
      return { gap: Math.abs(hit.offset) - corridor.hw[hit.offset >= 0 ? 1 : 0]![hit.row]! - SHOULDER, hit };
    };
    // junction mouth: the lane widens a little over its last metres before the ride's road
    const flareAt = (x: number, z: number): number => {
      const near = gapAt(x, z);
      return near ? 1 + 0.35 * (1 - smoothstep(JOIN_GAP, JOIN_GAP + 5, near.gap)) : 1;
    };
    const corners = (x: number, z: number, tx: number, tz: number): [number, number, number, number] => {
      // right = (cos h, −sin h) with heading h = atan2(tx, tz)  →  (tz, −tx)
      const w = hw * flareAt(x, z);
      return [x - tz * w, z + tx * w, x + tz * w, z - tx * w];
    };
    const clear = (x: number, z: number): boolean => {
      const near = gapAt(x, z);
      return !near || near.gap >= JOIN_GAP;
    };
    // a cross section is drawn when it lies completely beside the ride's road (the road is never covered)
    const fits = (x: number, z: number, tx: number, tz: number): boolean => {
      const [lx, lz, qx, qz] = corners(x, z, tx, tz);
      return clear(x, z) && clear(lx, lz) && clear(qx, qz);
    };
    const usable = (x: number, z: number, tx: number, tz: number): boolean => {
      if (!gridContains(g, x, z, 2) || corridor.routeDistance(x, z) >= reach) return false;
      if (!fits(x, z, tx, tz)) return false;
      return triSample(g.heights, g.nx, (x - g.x0) / g.step, (z - g.z0) / g.step) >= wl + 0.3;
    };
    let prev: [number, number] | null = null;
    let md: MeshData | null = null;
    const emit = (x: number, z: number, tx: number, tz: number) => {
      const shade = 0.9 + rng() * 0.18;
      const r = tint[0]! * shade;
      const gg = tint[1]! * shade;
      const b = tint[2]! * shade;
      const [lx, lz, qx, qz] = corners(x, z, tx, tz);
      const cur = tileOf(x, z);
      if (cur !== md) prev = null; // start a fresh strip in the new tile
      md = cur;
      const a = md.vertex(lx, height(lx, lz) + LIFT, lz, 0, 1, 0, 0, 0, r, gg, b);
      const c = md.vertex(qx, height(qx, qz) + LIFT, qz, 0, 1, 0, 0, 0, r, gg, b);
      if (prev) md.stripQuad(prev[0], prev[1], a, c);
      prev = [a, c];
    };
    // the last cross section between a drawn and a blocked sample that still fits beside the ride's road
    const meet = (ax: number, az: number, bx: number, bz: number, tx: number, tz: number): [number, number] | null => {
      const nb = gapAt(bx, bz);
      if (!nb || nb.gap >= JOIN_GAP + 3 * hw) return null; // cut for another reason (water, reach)
      let lo = 0;
      let hi = 1;
      for (let it = 0; it < 8; it++) {
        const m = (lo + hi) / 2;
        if (fits(ax + (bx - ax) * m, az + (bz - az) * m, tx, tz)) lo = m;
        else hi = m;
      }
      return lo > 0.02 ? [ax + (bx - ax) * lo, az + (bz - az) * lo] : null;
    };
    const tan = xs.map((_, k): [number, number] => {
      const k0 = Math.max(0, k - 1);
      const k1 = Math.min(xs.length - 1, k + 1);
      const tx = xs[k1]! - xs[k0]!;
      const tz = zs[k1]! - zs[k0]!;
      const tl = Math.hypot(tx, tz) || 1;
      return [tx / tl, tz / tl];
    });
    const ok = xs.map((x, k) => usable(x, zs[k]!, tan[k]![0], tan[k]![1]));
    for (let k = 0; k < xs.length; k++) {
      const [tx, tz] = tan[k]!;
      if (!ok[k]) {
        // close the lane right at the edge of the ride's road
        if (prev && k > 0) {
          const p = meet(xs[k - 1]!, zs[k - 1]!, xs[k]!, zs[k]!, tx, tz);
          if (p) emit(p[0], p[1], tx, tz);
        }
        prev = null;
        continue;
      }
      if (!prev && k > 0 && !ok[k - 1]) {
        // a lane leaving the ride's road starts right at its edge
        const p = meet(xs[k]!, zs[k]!, xs[k - 1]!, zs[k - 1]!, tx, tz);
        if (p) emit(p[0], p[1], tx, tz);
      }
      emit(xs[k]!, zs[k]!, tx, tz);
    }
  }

  const meshes: Mesh[] = [];
  let id = 0;
  for (const md of tiles.values()) {
    md.computeNormals();
    const m = md.build(scene, `side-roads-${id++}`, mat);
    if (!m) continue;
    m.addLODLevel(quality.terrainLod[0], null);
    meshes.push(m);
  }
  return meshes;
}
