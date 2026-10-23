import { Color3, StandardMaterial, Texture, type Mesh, type Scene } from '@babylonjs/core';
import { createRng, smoothstep } from '../noise';
import { SHOULDER, type RouteCorridor, type RouteHit } from './corridor';
import { gridContains, triSample } from './heightField';
import { GIVE_WAY_WIDTH, SIDE_LIFT as LIFT, mouthMesh, mouthPoint, nodeMesh, polylineLength, sideRoadGround, type JunctionPlan } from './junctions';
import { MeshData } from './meshData';
import type { QualityProfile } from './quality';
import type { Vec2 } from './roadGeometry';
import { asphaltTexture, gravelTexture, roadTexture, roadTextureRepeat } from './textures';
import type { Architecture, WorldData } from './worldData';

const TILE = 768;
const MAX_STEP = 6;
/** Lanes stop this far outside the ride's road (asphalt + shoulder). */
const JOIN_GAP = 0.15;
/** Length of one repeat of the gravel texture along the road, m (paved roads use the road texture's dash period). */
const TEX_ALONG = 8;
/** Size of one repeat of the plain asphalt on junction areas, m. */
const PATCH_TILE = 6;
const REACH: Record<QualityProfile['level'], number> = { ultra: 1100, hoch: 900, mittel: 600, niedrig: 300 };

/** Part of a polyline between `a` and `b` metres from its start. */
function slicePolyline(pts: Float32Array, a: number, b: number): Float32Array {
  const out: number[] = [];
  let d = 0;
  const n = pts.length / 2;
  for (let k = 0; k < n - 1; k++) {
    const ax = pts[2 * k]!;
    const az = pts[2 * k + 1]!;
    const bx = pts[2 * k + 2]!;
    const bz = pts[2 * k + 3]!;
    const len = Math.hypot(bx - ax, bz - az);
    const lo = Math.max(a, d);
    const hi = Math.min(b, d + len);
    if (hi > lo && len > 0) {
      const p = (lo - d) / len;
      if (out.length === 0) out.push(ax + (bx - ax) * p, az + (bz - az) * p);
      const q = (hi - d) / len;
      out.push(ax + (bx - ax) * q, az + (bz - az) * q);
    }
    d += len;
  }
  return Float32Array.from(out);
}

/**
 * Village streets, farm lanes and forest tracks from OpenStreetMap, draped over the full-resolution
 * terrain near the lap: streets in plain asphalt with worn edges, tracks in gravel. Where they meet the
 * ride's road (or each other) they end in a junction area with rounded corners (junctions.ts), paved
 * streets with a give-way line; ends without junction data run up to the road edge with a slightly
 * flared mouth. They are scenery: the ride stays on the lap. Sampled at the terrain's own
 * triangulation so they never sink into a slope.
 */
export function buildSideRoads(
  scene: Scene,
  data: WorldData,
  corridor: RouteCorridor,
  quality: QualityProfile,
  plan: JunctionPlan,
  style: Architecture,
): Mesh[] {
  const g = data.near;
  const wl = data.waterLevel;
  const reach = REACH[quality.level];
  const rng = createRng(99);

  const material = (name: string, tex: Texture | null, color: Color3, zOffset: number) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseTexture = tex;
    m.diffuseColor = color;
    m.specularColor = new Color3(0.03, 0.03, 0.03);
    m.zOffset = zOffset;
    return m;
  };
  // paved side roads have two lanes too: edge lines and centre line like the ride's road
  const pavedTex = roadTexture(scene, false, style);
  const pavedAlong = roadTextureRepeat(style);
  pavedTex.wrapU = Texture.CLAMP_ADDRESSMODE;
  pavedTex.wrapV = Texture.WRAP_ADDRESSMODE;
  // arms first, junction areas on top of their ends, give-way lines on top of both
  const mats = {
    paved: material('side-roads', pavedTex, Color3.White(), -2),
    track: material('side-tracks', gravelTexture(scene), Color3.White(), -2),
    patch: material('junctions', asphaltTexture(scene), Color3.White(), -3),
    gravel: material('junctions-gravel', null, new Color3(0.53, 0.47, 0.38), -3),
    line: material('give-way', null, new Color3(0.86, 0.86, 0.84), -4),
  };
  type Kind = keyof typeof mats;
  const tiles = new Map<string, { kind: Kind; md: MeshData }>();
  const tileOf = (kind: Kind, x: number, z: number) => {
    const key = `${kind}:${Math.floor((x - g.x0) / TILE)},${Math.floor((z - g.z0) / TILE)}`;
    let t = tiles.get(key);
    if (!t) tiles.set(key, (t = { kind, md: new MeshData(true, true) }));
    return t.md;
  };

  const height = sideRoadGround(corridor, g);

  data.roads.forEach((road, ri) => {
    const len = polylineLength(road.pts);
    const a = plan.cuts[ri * 2]!;
    const b = len - plan.cuts[ri * 2 + 1]!;
    if (b - a < 0.5) return;
    const pts = a > 0 || b < len ? slicePolyline(road.pts, a, b) : road.pts;
    const n = pts.length / 2;
    if (n < 2) return;
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
    const kind: Kind = road.track ? 'track' : 'paved';
    const flared = plan.mouthed[ri] === 0;
    // Distance of a point outside the ride's road (asphalt + shoulder); null = far from the lap.
    const gapAt = (x: number, z: number): { gap: number; hit: RouteHit } | null => {
      const hit = corridor.nearest(x, z, 24);
      if (!hit) return null;
      return { gap: Math.abs(hit.offset) - corridor.hw[hit.offset >= 0 ? 1 : 0]![hit.row]! - SHOULDER, hit };
    };
    // ends without a junction area: the lane widens a little over its last metres before the ride's road
    const flareAt = (x: number, z: number): number => {
      if (!flared) return 1;
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
    let along = a;
    let last: [number, number] | null = null;
    const emit = (x: number, z: number, tx: number, tz: number) => {
      if (last) along += Math.hypot(x - last[0], z - last[1]);
      last = [x, z];
      const shade = 0.93 + rng() * 0.1;
      const [lx, lz, qx, qz] = corners(x, z, tx, tz);
      const cur = tileOf(kind, x, z);
      if (cur !== md) prev = null; // start a fresh strip in the new tile
      md = cur;
      const v = along / (kind === 'paved' ? pavedAlong : TEX_ALONG);
      const l = md.vertex(lx, height(lx, lz) + LIFT, lz, 0, 1, 0, 0, v, shade, shade, shade);
      const r = md.vertex(qx, height(qx, qz) + LIFT, qz, 0, 1, 0, 1, v, shade, shade, shade);
      if (prev) md.stripQuad(prev[0], prev[1], l, r);
      prev = [l, r];
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
    // the first and last cross sections inside a junction area meet its outline exactly
    if (!Number.isNaN(plan.tans[ri * 4]!)) tan[0] = [plan.tans[ri * 4]!, plan.tans[ri * 4 + 1]!];
    if (!Number.isNaN(plan.tans[ri * 4 + 2]!)) tan[tan.length - 1] = [plan.tans[ri * 4 + 2]!, plan.tans[ri * 4 + 3]!];
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
        last = null;
        continue;
      }
      if (!prev && k > 0 && !ok[k - 1]) {
        // a lane leaving the ride's road starts right at its edge
        const p = meet(xs[k]!, zs[k]!, xs[k - 1]!, zs[k - 1]!, tx, tz);
        if (p) emit(p[0], p[1], tx, tz);
      }
      emit(xs[k]!, zs[k]!, tx, tz);
    }
  });

  // ---- junction areas: where side roads meet the ride's road …
  const fill = (kind: Kind, mesh: { pts: Array<[number, number, number]>; tris: number[] }) => {
    if (mesh.tris.length === 0) return;
    const md = tileOf(kind, mesh.pts[0]![0], mesh.pts[0]![2]);
    const ids = mesh.pts.map((w) => md.vertex(w[0], w[1], w[2], 0, 1, 0, w[0] / PATCH_TILE, w[2] / PATCH_TILE));
    for (let k = 0; k < mesh.tris.length; k += 3) md.tri(ids[mesh.tris[k]!]!, ids[mesh.tris[k + 1]!]!, ids[mesh.tris[k + 2]!]!, 0, 1, 0);
  };
  for (const m of plan.mouths) {
    fill('patch', mouthMesh(corridor, height, m));
    // give-way line across paved streets, just outside the ride's shoulder
    for (const arm of m.arms) {
      if (!arm.paved || arm.hw * 2 < GIVE_WAY_WIDTH) continue;
      const lo = m.edge + 0.45;
      const xsAt = [-1, 1].map((sgn) => {
        const t = (lo - sgn * arm.hw * arm.dir[0]) / arm.dir[1];
        return -sgn * arm.hw * arm.dir[1] + t * arm.dir[0];
      });
      const x0 = Math.min(xsAt[0]!, xsAt[1]!) + 0.2;
      const x1 = Math.max(xsAt[0]!, xsAt[1]!) - 0.2;
      for (let x = x0; x + 0.5 <= x1; x += 0.8) {
        const quad: Vec2[] = [
          [x, lo - 0.15],
          [x + 0.5, lo - 0.15],
          [x + 0.5, lo + 0.15],
          [x, lo + 0.15],
        ];
        const w = quad.map((p) => mouthPoint(corridor, height, m, p, 0.01));
        const md = tileOf('line', w[0]![0], w[0]![2]);
        const ids = w.map((v) => md.vertex(v[0], v[1], v[2]));
        md.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!, 0, 1, 0);
      }
    }
  }
  // … and each other
  for (const node of plan.nodes) {
    if (!gridContains(g, node.x, node.z, 2) || corridor.routeDistance(node.x, node.z) >= reach) continue;
    fill(node.paved ? 'patch' : 'gravel', nodeMesh(height, node));
  }

  const meshes: Mesh[] = [];
  let id = 0;
  for (const { kind, md } of tiles.values()) {
    md.computeNormals();
    const m = md.build(scene, `side-roads-${kind}-${id++}`, mats[kind]);
    if (!m) continue;
    m.addLODLevel(quality.terrainLod[0], null);
    meshes.push(m);
  }
  return meshes;
}
