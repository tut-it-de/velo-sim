import { Color3, StandardMaterial, type Mesh, type Scene } from '@babylonjs/core';
import { Noise2D } from '../noise';
import { SHOULDER, VERGE_OUT, type RouteCorridor } from './corridor';
import { gridContains, pointInRing, triSample } from './heightField';
import { MeshData } from './meshData';
import type { QualityProfile } from './quality';
import type { WorldData } from './worldData';

const TILE = 768;
const CELL = 2;
const LIFT = 0.1;
const LINE_LIFT = 0.13;
const LINE_W = 0.12;
const BAY_W = 2.6;
const BAY_D = 5;
const REACH: Record<QualityProfile['level'], number> = { ultra: 900, hoch: 700, mittel: 450, niedrig: 0 };

type Pt = [number, number];

/** Sutherland–Hodgman: the part of `poly` on the side of the line where `inside` holds. */
function clip(poly: Pt[], inside: (p: Pt) => boolean, cut: (a: Pt, b: Pt) => Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ia = inside(a);
    const ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) out.push(cut(a, b));
  }
  return out;
}

function clipToCell(poly: Pt[], x0: number, z0: number, x1: number, z1: number): Pt[] {
  const atX = (x: number) => (a: Pt, b: Pt): Pt => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const atZ = (z: number) => (a: Pt, b: Pt): Pt => [a[0] + ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]), z];
  let p = clip(poly, (q) => q[0] >= x0, atX(x0));
  if (p.length) p = clip(p, (q) => q[0] <= x1, atX(x1));
  if (p.length) p = clip(p, (q) => q[1] >= z0, atZ(z0));
  if (p.length) p = clip(p, (q) => q[1] <= z1, atZ(z1));
  return p;
}

/**
 * Surface car parks from OpenStreetMap (e.g. the "Applauskurve" on the Feldberg): asphalt draped
 * over the terrain like the side roads, cut into 2 m cells so it follows every bump, with white bay
 * lines along the long edges. Kept clear of the ride's own road.
 */
export function buildParking(scene: Scene, data: WorldData, corridor: RouteCorridor, quality: QualityProfile): Mesh[] {
  const reach = REACH[quality.level];
  if (reach === 0 || data.parking.length === 0) return [];
  const g = data.near;
  const noise = new Noise2D(311);
  const height = (x: number, z: number): number => {
    const dem = triSample(g.heights, g.nx, (x - g.x0) / g.step, (z - g.z0) / g.step);
    const hit = corridor.nearest(x, z, VERGE_OUT);
    if (!hit) return dem;
    return corridor.profile(hit.row, hit.offset >= 0 ? 1 : 0, Math.abs(hit.offset), dem, hit.y);
  };
  // on the ride's road or its shoulder (plus `pad`)
  const onRoad = (x: number, z: number, pad: number): boolean => {
    const hit = corridor.nearest(x, z, 24);
    return hit !== null && Math.abs(hit.offset) < corridor.hw[hit.offset >= 0 ? 1 : 0]![hit.row]! + SHOULDER + pad;
  };

  // one surface and one line mesh per 768 m tile, so distant tiles drop out by LOD
  const tiles = new Map<number, { surface: MeshData; lines: MeshData }>();
  for (const ring of data.parking) {
    const n = ring.length / 2;
    const poly: Pt[] = [];
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < n; k++) {
      poly.push([ring[2 * k]!, ring[2 * k + 1]!]);
      cx += ring[2 * k]! / n;
      cz += ring[2 * k + 1]! / n;
    }
    if (!gridContains(g, cx, cz, 4) || corridor.routeDistance(cx, cz) > reach) continue;
    const key = Math.floor((cx - g.x0) / TILE) * 1024 + Math.floor((cz - g.z0) / TILE);
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, (tile = { surface: new MeshData(false, true), lines: new MeshData(false, false) }));
    const { surface, lines } = tile;
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const [x, z] of poly) {
      x0 = Math.min(x0, x);
      z0 = Math.min(z0, z);
      x1 = Math.max(x1, x);
      z1 = Math.max(z1, z);
    }
    // same asphalt as the side roads (the lanes through a car park are mapped as service roads on top);
    // patches of slightly different tone; normals stay straight up (cells are not welded, so computed
    // normals would light every 2 m cell differently)
    const tone = 0.92 + noise.noise(cx * 0.01, cz * 0.01) * 0.08;
    for (let gx = Math.floor(x0 / CELL) * CELL; gx < x1; gx += CELL) {
      for (let gz = Math.floor(z0 / CELL) * CELL; gz < z1; gz += CELL) {
        const piece = clipToCell(poly, gx, gz, gx + CELL, gz + CELL);
        if (piece.length < 3) continue;
        const mx = gx + CELL / 2;
        const mz = gz + CELL / 2;
        if (onRoad(mx, mz, 0.6)) continue;
        const ids = piece.map(([x, z]) => {
          const s = tone * (0.9 + 0.1 * noise.noise(x * 0.35, z * 0.35));
          return surface.vertex(x, height(x, z) + LIFT, z, 0, 1, 0, 0, 0, 0.42 * s, 0.41 * s, 0.4 * s);
        });
        // the clipped piece of a concave outline can come back as the whole cell (Sutherland–Hodgman joins the
        // parts along the cell border), so only triangles whose centre lies in the outline are kept
        for (let i = 1; i < piece.length - 1; i++) {
          const tx = (piece[0]![0] + piece[i]![0] + piece[i + 1]![0]) / 3;
          const tz = (piece[0]![1] + piece[i]![1] + piece[i + 1]![1]) / 3;
          if (pointInRing(ring, tx, tz)) surface.tri(ids[0]!, ids[i]!, ids[i + 1]!, 0, 1, 0);
        }
      }
    }
    // bay lines: perpendicular to every long edge, pointing into the car park
    for (let k = 0; k < n; k++) {
      const [ax, az] = poly[k]!;
      const [bx, bz] = poly[(k + 1) % n]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 12) continue;
      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      // counter-clockwise ring: the inside is to the left of the edge
      const ix = -tz;
      const iz = tx;
      for (let s = BAY_W; s < len - BAY_W / 2; s += BAY_W) {
        const px = ax + tx * s;
        const pz = az + tz * s;
        const p0: Pt = [px + ix * 0.3, pz + iz * 0.3];
        const p1: Pt = [px + ix * BAY_D, pz + iz * BAY_D];
        if (!pointInRing(ring, p0[0], p0[1]) || !pointInRing(ring, p1[0], p1[1])) continue;
        if (onRoad(p0[0], p0[1], 2) || onRoad(p1[0], p1[1], 2)) continue;
        const ox = tx * (LINE_W / 2);
        const oz = tz * (LINE_W / 2);
        const steps = 3;
        let prev: [number, number] | null = null;
        for (let q = 0; q <= steps; q++) {
          const x = p0[0] + ((p1[0] - p0[0]) * q) / steps;
          const z = p0[1] + ((p1[1] - p0[1]) * q) / steps;
          const y = height(x, z) + LINE_LIFT;
          const a = lines.vertex(x - ox, y, z - oz);
          const b = lines.vertex(x + ox, y, z + oz);
          if (prev) lines.quad(prev[0], prev[1], b, a, 0, 1, 0);
          prev = [a, b];
        }
      }
    }
  }

  const asphalt = new StandardMaterial('parking', scene);
  asphalt.diffuseColor = Color3.White();
  asphalt.specularColor = new Color3(0.03, 0.03, 0.03);
  asphalt.zOffset = -2;
  const paint = new StandardMaterial('parking-lines', scene);
  paint.diffuseColor = new Color3(0.82, 0.82, 0.8);
  paint.specularColor = new Color3(0.05, 0.05, 0.05);
  paint.zOffset = -3;

  const meshes: Mesh[] = [];
  let id = 0;
  for (const { surface, lines } of tiles.values()) {
    const s = surface.build(scene, `parking-${id}`, asphalt);
    const l = lines.build(scene, `parking-lines-${id++}`, paint);
    for (const m of [s, l]) {
      if (!m) continue;
      m.addLODLevel(quality.terrainLod[0], null);
      meshes.push(m);
    }
  }
  return meshes;
}
