import { Color3, StandardMaterial, type Mesh, type Scene } from '@babylonjs/core';
import { createRng } from '../noise';
import { SHOULDER, VERGE_OUT, type RouteCorridor } from './corridor';
import { gridContains, triSample } from './heightField';
import { MeshData } from './meshData';
import type { QualityProfile } from './quality';
import type { WorldData } from './worldData';

const TILE = 768;
const MAX_STEP = 6;
const LIFT = 0.12;
const REACH: Record<QualityProfile['level'], number> = { ultra: 1100, hoch: 900, mittel: 600, niedrig: 300 };

/**
 * Village streets, farm lanes and forest tracks from OpenStreetMap, draped over the full-resolution
 * terrain near the lap (they stop where they meet the ride's own road). Sampled at the terrain's
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
    let prev: [number, number] | null = null;
    let md: MeshData | null = null;
    for (let k = 0; k < xs.length; k++) {
      const x = xs[k]!;
      const z = zs[k]!;
      let ok = gridContains(g, x, z, 2) && corridor.routeDistance(x, z) < reach;
      if (ok) {
        const hit = corridor.nearest(x, z, 24);
        ok = hit === null || Math.abs(hit.offset) > corridor.hw[hit.offset >= 0 ? 1 : 0]![hit.row]! + SHOULDER + hw + 0.4;
      }
      if (ok && triSample(g.heights, g.nx, (x - g.x0) / g.step, (z - g.z0) / g.step) < wl + 0.3) ok = false;
      if (!ok) {
        prev = null;
        continue;
      }
      const k0 = Math.max(0, k - 1);
      const k1 = Math.min(xs.length - 1, k + 1);
      let tx = xs[k1]! - xs[k0]!;
      let tz = zs[k1]! - zs[k0]!;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      // right = (cos h, −sin h) with heading h = atan2(tx, tz)  →  (tz, −tx)
      const rx = tz;
      const rz = -tx;
      const shade = 0.9 + rng() * 0.18;
      const r = tint[0]! * shade;
      const gg = tint[1]! * shade;
      const b = tint[2]! * shade;
      const lx = x - rx * hw;
      const lz = z - rz * hw;
      const qx = x + rx * hw;
      const qz = z + rz * hw;
      const cur = tileOf(x, z);
      if (cur !== md) prev = null; // start a fresh strip in the new tile
      md = cur;
      const a = md.vertex(lx, height(lx, lz) + LIFT, lz, 0, 1, 0, 0, 0, r, gg, b);
      const c = md.vertex(qx, height(qx, qz) + LIFT, qz, 0, 1, 0, 0, 0, r, gg, b);
      if (prev) md.stripQuad(prev[0], prev[1], a, c);
      prev = [a, c];
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
