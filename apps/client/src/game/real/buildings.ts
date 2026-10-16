import { Color3, StandardMaterial, type Mesh, type Scene } from '@babylonjs/core';
import { SHOULDER, type RouteCorridor } from './corridor';
import { MeshData } from './meshData';
import type { QualityProfile } from './quality';
import { facadeTexture, roofTexture } from './textures';
import type { Architecture, Building } from './worldData';

type RGB = [number, number, number];

interface Style {
  /** Facade paints (vertex colours over the near-white facade texture). */
  paints: RGB[];
  /** Pitched roof colour for a house, from a 0–1 hash. */
  roof: (r: number) => RGB;
  flatRoof: RGB;
  /** Roof rise per metre of half-width (0.45 ≈ 24°, 0.85 ≈ 40°). */
  pitch: number;
  /** Roof overhang at the eaves, m. */
  eaves: number;
  /** Share of houses with a hip roof; the others get a gable roof. */
  hipShare: number;
  church: { wall: RGB; roof: RGB; pitch: number; tower: number; spire: number };
}

const TERRACOTTA: RGB[] = [
  [0.74, 0.39, 0.26],
  [0.68, 0.35, 0.24],
  [0.78, 0.45, 0.3],
  [0.62, 0.33, 0.25],
];
const pick = (list: RGB[], r: number) => list[Math.min(list.length - 1, Math.floor(r * list.length))]!;

const STYLES: Record<Architecture, Style> = {
  // Lake Como: cream, ochre, salmon, Pompeian red, pale yellow, white and rubble stone; clay hip roofs, campanili
  italian: {
    paints: [
      [0.95, 0.89, 0.76],
      [0.91, 0.74, 0.47],
      [0.93, 0.68, 0.54],
      [0.8, 0.49, 0.39],
      [0.96, 0.87, 0.6],
      [0.95, 0.94, 0.91],
      [0.93, 0.8, 0.66],
      [0.74, 0.71, 0.66],
    ],
    roof: (r) => (r < 0.25 ? [0.5, 0.49, 0.47] : pick(TERRACOTTA, (r - 0.25) / 0.75)),
    flatRoof: [0.58, 0.56, 0.53],
    pitch: 0.45,
    eaves: 0.4,
    hipShare: 1,
    church: { wall: [0.82, 0.78, 0.7], roof: TERRACOTTA[0]!, pitch: 0.55, tower: 12, spire: 0.9 },
  },
  // German villages: white, cream and pale grey plaster; steep gable roofs in anthracite or red-brown tiles;
  // white churches with a slate spire
  german: {
    paints: [
      [0.96, 0.96, 0.94],
      [0.95, 0.92, 0.84],
      [0.88, 0.88, 0.86],
      [0.95, 0.91, 0.74],
      [0.92, 0.87, 0.79],
      [0.94, 0.85, 0.78],
      [0.97, 0.97, 0.95],
    ],
    roof: (r) =>
      r < 0.4 ? [0.27, 0.28, 0.3] : r < 0.55 ? [0.38, 0.38, 0.39] : r < 0.8 ? [0.55, 0.26, 0.19] : [0.67, 0.31, 0.21],
    flatRoof: [0.5, 0.5, 0.5],
    pitch: 0.85,
    eaves: 0.5,
    hipShare: 0.15,
    church: { wall: [0.95, 0.94, 0.91], roof: [0.3, 0.31, 0.34], pitch: 1.0, tower: 16, spire: 2.6 },
  },
  // French Alps: plaster and stone, some timber; low gable roofs with deep eaves in slate, metal or stone slabs
  alpine: {
    paints: [
      [0.95, 0.92, 0.85],
      [0.96, 0.95, 0.92],
      [0.9, 0.8, 0.62],
      [0.72, 0.69, 0.64],
      [0.93, 0.86, 0.74],
      [0.58, 0.43, 0.3],
    ],
    roof: (r) => (r < 0.35 ? [0.4, 0.41, 0.43] : r < 0.6 ? [0.31, 0.32, 0.33] : r < 0.8 ? [0.43, 0.32, 0.24] : [0.54, 0.52, 0.49]),
    flatRoof: [0.5, 0.5, 0.5],
    pitch: 0.55,
    eaves: 0.9,
    hipShare: 0.1,
    church: { wall: [0.76, 0.73, 0.67], roof: [0.36, 0.37, 0.4], pitch: 0.8, tower: 13, spire: 1.8 },
  },
};
const CHUNK = 768;

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

interface Rect {
  ax: number;
  az: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** Smallest bounding rectangle aligned with one of the footprint edges; u runs along the long side. */
function orientedRect(ring: Float32Array): Rect {
  const n = ring.length / 2;
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let e = 0; e < n; e++) {
    const dx = ring[((e + 1) % n) * 2]! - ring[e * 2]!;
    const dz = ring[((e + 1) % n) * 2 + 1]! - ring[e * 2 + 1]!;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const ax = dx / len;
    const az = dz / len;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = ring[k * 2]!;
      const z = ring[k * 2 + 1]!;
      const u = x * ax + z * az;
      const v = -x * az + z * ax;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea) {
      bestArea = area;
      best = u1 - u0 >= v1 - v0 ? { ax, az, u0, u1, v0, v1 } : { ax: -az, az: ax, u0: v0, u1: v1, v0: -u1, v1: -u0 };
    }
  }
  return best ?? { ax: 1, az: 0, u0: 0, u1: 1, v0: 0, v1: 1 };
}

/** Ear clipping for a counter-clockwise ring (x east, z north). Falls back to a fan if the ring is degenerate. */
function earClip(ring: Float32Array): number[] {
  const n = ring.length / 2;
  const X = (i: number) => ring[i * 2]!;
  const Z = (i: number) => ring[i * 2 + 1]!;
  const cross = (a: number, b: number, c: number) => (X(b) - X(a)) * (Z(c) - Z(a)) - (Z(b) - Z(a)) * (X(c) - X(a));
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length]!;
      const b = idx[i]!;
      const c = idx[(i + 1) % idx.length]!;
      if (cross(a, b, c) <= 1e-9) continue;
      let inside = false;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(a, b, c);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  else for (let i = 1; i < idx.length - 1; i++) out.push(idx[0]!, idx[i]!, idx[i + 1]!);
  return out;
}

class Chunk {
  readonly walls = new MeshData(true, true);
  readonly roofs = new MeshData(true, true);
}

/** Adds a planar polygon face with a flat normal (the upward one for roofs, outward for gable walls). */
function face(md: MeshData, pts: Array<[number, number, number]>, color: RGB, uvScale: number, ax: number, az: number, wantUp = true): void {
  const [p0, p1, p2] = pts;
  const e1 = [p1![0] - p0![0], p1![1] - p0![1], p1![2] - p0![2]];
  const e2 = [p2![0] - p0![0], p2![1] - p0![1], p2![2] - p0![2]];
  let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
  let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
  let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  if (wantUp && ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const base = md.vertexCount;
  for (const p of pts) {
    const u = (p[0] * ax + p[2] * az) / uvScale;
    const v = (-p[0] * az + p[2] * ax) / uvScale + p[1] / uvScale;
    md.vertex(p[0], p[1], p[2], nx, ny, nz, u, v, color[0], color[1], color[2]);
  }
  for (let i = 1; i < pts.length - 1; i++) md.tri(base, base + i, base + i + 1, nx, ny, nz);
}

/** Vertical walls around a ring from `base` to `top`, facade texture anchored at ground level `ground`. */
function walls(md: MeshData, ring: Float32Array, base: number, top: number, ground: number, color: RGB): void {
  const n = ring.length / 2;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const x0 = ring[i * 2]!;
    const z0 = ring[i * 2 + 1]!;
    const x1 = ring[((i + 1) % n) * 2]!;
    const z1 = ring[((i + 1) % n) * 2 + 1]!;
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.05) continue;
    const nx = (z1 - z0) / len;
    const nz = -(x1 - x0) / len;
    const u0 = run / 7.2;
    const u1 = (run + len) / 7.2;
    run += len;
    // fake ambient occlusion: darker where the wall meets the ground
    const skirt = ground + 1.8;
    const rows: Array<[number, number]> = skirt > base + 0.2 && top > skirt + 0.5 ? [[base, 0.6], [skirt, 1], [top, 1]] : [[base, 0.8], [top, 1]];
    for (let r = 0; r + 1 < rows.length; r++) {
      const [y0, s0] = rows[r]!;
      const [y1, s1] = rows[r + 1]!;
      const v0 = (y0 - ground) / 6.2;
      const v1 = (y1 - ground) / 6.2;
      const a = md.vertex(x0, y0, z0, nx, 0, nz, u0, v0, color[0] * s0, color[1] * s0, color[2] * s0);
      const b = md.vertex(x0, y1, z0, nx, 0, nz, u0, v1, color[0] * s1, color[1] * s1, color[2] * s1);
      const c = md.vertex(x1, y1, z1, nx, 0, nz, u1, v1, color[0] * s1, color[1] * s1, color[2] * s1);
      const d = md.vertex(x1, y0, z1, nx, 0, nz, u1, v0, color[0] * s0, color[1] * s0, color[2] * s0);
      md.quad(a, b, c, d, nx, 0, nz);
    }
  }
}

function rectPoint(r: Rect, u: number, v: number, y: number): [number, number, number] {
  return [r.ax * u - r.az * v, y, r.az * u + r.ax * v];
}

/** Hip roof (or pyramid) over the oriented rectangle with eaves; the roof planes meet the wall tops at `top`. */
function hipRoof(md: MeshData, r: Rect, top: number, color: RGB, style: Style): void {
  const e = style.eaves;
  const eave = top - e * style.pitch + 0.03;
  const u0 = r.u0 - e;
  const u1 = r.u1 + e;
  const v0 = r.v0 - e;
  const v1 = r.v1 + e;
  const half = (v1 - v0) / 2;
  const vm = (v0 + v1) / 2;
  const ridgeY = eave + half * style.pitch;
  const ra = Math.min(u0 + half, (u0 + u1) / 2);
  const rb = Math.max(u1 - half, (u0 + u1) / 2);
  const A = rectPoint(r, u0, v0, eave);
  const B = rectPoint(r, u1, v0, eave);
  const C = rectPoint(r, u1, v1, eave);
  const D = rectPoint(r, u0, v1, eave);
  const R1 = rectPoint(r, ra, vm, ridgeY);
  const R2 = rectPoint(r, rb, vm, ridgeY);
  if (rb - ra > 0.05) {
    face(md, [A, B, R2, R1], color, 2, r.ax, r.az);
    face(md, [C, D, R1, R2], color, 2, r.ax, r.az);
  } else {
    face(md, [A, B, R1], color, 2, r.ax, r.az);
    face(md, [C, D, R1], color, 2, r.ax, r.az);
  }
  face(md, [D, A, R1], color, 2, r.az, -r.ax);
  face(md, [B, C, R2], color, 2, r.az, -r.ax);
}

/**
 * Gable roof along the long side of the oriented rectangle: two roof planes with eaves and a
 * smaller overhang at the gables, gable triangles closed with wall.
 */
function gableRoof(chunk: Chunk, r: Rect, top: number, color: RGB, wall: RGB, pitch: number, eaves: number): void {
  const eave = top - eaves * pitch + 0.03;
  const u0 = r.u0 - eaves * 0.6;
  const u1 = r.u1 + eaves * 0.6;
  const v0 = r.v0 - eaves;
  const v1 = r.v1 + eaves;
  const vm = (r.v0 + r.v1) / 2;
  const ridge = eave + ((v1 - v0) / 2) * pitch;
  const A = rectPoint(r, u0, v0, eave);
  const B = rectPoint(r, u1, v0, eave);
  const C = rectPoint(r, u1, v1, eave);
  const D = rectPoint(r, u0, v1, eave);
  const Ra = rectPoint(r, u0, vm, ridge);
  const Rb = rectPoint(r, u1, vm, ridge);
  face(chunk.roofs, [A, B, Rb, Ra], color, 2, r.ax, r.az);
  face(chunk.roofs, [C, D, Ra, Rb], color, 2, r.ax, r.az);
  // gable walls in the wall plane, up to just under the roof
  const apex = ridge - 0.05;
  const wa = rectPoint(r, r.u0, r.v0, top);
  const wd = rectPoint(r, r.u0, r.v1, top);
  const wb = rectPoint(r, r.u1, r.v0, top);
  const wc = rectPoint(r, r.u1, r.v1, top);
  face(chunk.walls, [wd, wa, rectPoint(r, r.u0, vm, apex)], wall, 7.2, r.az, -r.ax, false);
  face(chunk.walls, [wb, wc, rectPoint(r, r.u1, vm, apex)], wall, 7.2, r.az, -r.ax, false);
}

function church(chunk: Chunk, ring: Float32Array, base: number, top: number, ground: number, style: Style): void {
  const cs = style.church;
  const r = orientedRect(ring);
  walls(chunk.walls, ring, base, top, ground, cs.wall);
  gableRoof(chunk, r, top, cs.roof, cs.wall, cs.pitch, 0.3);
  // bell tower at the back corner of the nave
  const w = Math.min(5.5, Math.max(3, 0.3 * (r.v1 - r.v0)));
  const tu = r.u1 - w;
  const tv = r.v1 - w;
  const towerTop = ground + Math.max(top - ground + cs.tower, 10 + cs.tower);
  const tower = new Float32Array(8);
  const corners: Array<[number, number]> = [
    [tu, tv],
    [tu + w, tv],
    [tu + w, tv + w],
    [tu, tv + w],
  ];
  corners.forEach(([u, v], q) => {
    const p = rectPoint(r, u, v, 0);
    tower[q * 2] = p[0];
    tower[q * 2 + 1] = p[2];
  });
  // (u, v) is a rotation of (x, z), so this corner order is counter-clockwise like the footprints
  walls(chunk.walls, tower, base, towerTop, ground, cs.wall);
  const tr = orientedRect(tower);
  const ta = rectPoint(tr, tr.u0 - 0.2, tr.v0 - 0.2, towerTop);
  const tb = rectPoint(tr, tr.u1 + 0.2, tr.v0 - 0.2, towerTop);
  const tc = rectPoint(tr, tr.u1 + 0.2, tr.v1 + 0.2, towerTop);
  const td = rectPoint(tr, tr.u0 - 0.2, tr.v1 + 0.2, towerTop);
  const apex = rectPoint(tr, (tr.u0 + tr.u1) / 2, (tr.v0 + tr.v1) / 2, towerTop + w * cs.spire);
  for (const [p, q] of [
    [ta, tb],
    [tb, tc],
    [tc, td],
    [td, ta],
  ] as const) {
    face(chunk.roofs, [p, q, apex], cs.roof, 2, tr.ax, tr.az);
  }
}

/**
 * Buildings from the map footprints in the region's architecture: plastered walls, pitched roofs
 * (hip or gable, colours and pitch by region), flat roofs where the footprint is irregular, churches
 * with a bell tower. Grouped into ~770 m chunks that drop out beyond the quality profile's distance.
 */
export function buildBuildings(
  scene: Scene,
  buildings: Building[],
  corridor: RouteCorridor,
  quality: QualityProfile,
  architecture: Architecture = 'italian',
): Mesh[] {
  const style = STYLES[architecture];
  const wallMat = new StandardMaterial('facade', scene);
  wallMat.diffuseTexture = facadeTexture(scene, architecture);
  wallMat.specularColor = new Color3(0.02, 0.02, 0.02);
  const roofMat = new StandardMaterial('roof', scene);
  roofMat.diffuseTexture = roofTexture(scene, architecture);
  roofMat.specularColor = new Color3(0.05, 0.05, 0.05);
  roofMat.backFaceCulling = false;
  roofMat.twoSidedLighting = true;

  const chunks = new Map<string, Chunk>();
  const wl = corridor.field.waterLevel;
  buildings.forEach((b, k) => {
    const ring = b.ring;
    const n = ring.length / 2;
    if (n < 3) return;
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += ring[i * 2]!;
      cz += ring[i * 2 + 1]!;
    }
    cx /= n;
    cz /= n;
    // keep the road clear
    for (let i = 0; i < n; i++) {
      const x0 = ring[i * 2]!;
      const z0 = ring[i * 2 + 1]!;
      const x1 = ring[((i + 1) % n) * 2]!;
      const z1 = ring[((i + 1) % n) * 2 + 1]!;
      for (const t of [0, 0.5]) {
        const hit = corridor.nearest(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, 6);
        if (hit && Math.abs(hit.offset) < corridor.hw[hit.offset >= 0 ? 1 : 0][hit.row]! + SHOULDER + 0.2) return;
      }
    }
    let minS = Infinity;
    let maxS = -Infinity;
    for (let i = 0; i < n; i++) {
      const s = corridor.surface(ring[i * 2]!, ring[i * 2 + 1]!);
      minS = Math.min(minS, s);
      maxS = Math.max(maxS, s);
    }
    if (maxS < wl + 0.3) return;
    const ground = Math.max(minS, wl + 0.2);
    const base = minS - 1;
    const top = Math.max(ground + b.height, maxS + 2.6);
    const key = `${Math.floor(cx / CHUNK)},${Math.floor(cz / CHUNK)}`;
    let chunk = chunks.get(key);
    if (!chunk) chunks.set(key, (chunk = new Chunk()));
    if (b.kind === 2) {
      church(chunk, ring, base, top, ground, style);
      return;
    }
    const paint = pick(style.paints, hash(k));
    const shade = 0.92 + hash(k + 17) * 0.1;
    const color: RGB = [paint[0] * shade, paint[1] * shade, paint[2] * shade];
    walls(chunk.walls, ring, base, top, ground, color);
    if (b.kind === 1) {
      const roofColor = style.roof(hash(k + 3));
      const rect = orientedRect(ring);
      if (hash(k + 7) < style.hipShare) hipRoof(chunk.roofs, rect, top, roofColor, style);
      else gableRoof(chunk, rect, top, roofColor, color, style.pitch, style.eaves);
    } else {
      const tris = earClip(ring);
      const roofs = chunk.roofs;
      const base0 = roofs.vertexCount;
      for (let i = 0; i < n; i++) roofs.vertex(ring[i * 2]!, top, ring[i * 2 + 1]!, 0, 1, 0, ring[i * 2]! / 2, ring[i * 2 + 1]! / 2, ...style.flatRoof);
      for (let i = 0; i < tris.length; i += 3) roofs.tri(base0 + tris[i]!, base0 + tris[i + 1]!, base0 + tris[i + 2]!, 0, 1, 0);
    }
  });

  const meshes: Mesh[] = [];
  for (const [key, chunk] of chunks) {
    for (const [md, mat, name] of [
      [chunk.walls, wallMat, 'walls'],
      [chunk.roofs, roofMat, 'roofs'],
    ] as const) {
      const m = md.build(scene, `bld-${name}-${key}`, mat);
      if (!m) continue;
      m.addLODLevel(quality.buildingDistance, null);
      meshes.push(m);
    }
  }
  return meshes;
}
