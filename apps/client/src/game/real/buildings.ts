import { Color3, StandardMaterial, type Mesh, type Scene } from '@babylonjs/core';
import { SHOULDER, type RouteCorridor } from './corridor';
import { applyDetail } from './detailMaps';
import { MeshData } from './meshData';
import type { QualityProfile } from './quality';
import {
  decomposeRects,
  orientedRect,
  pieceRoof,
  planPieces,
  rectPoint,
  ringArea,
  skeletonRoof,
  type Rect,
  type RoofGeometry,
  type RoofPiece,
} from './roofs';
import { facadeBump, facadeTexture, roofTexture } from './textures';
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
  /** Stone base below the floor on sloping ground. */
  plinth: RGB;
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
    plinth: [0.66, 0.62, 0.55],
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
    plinth: [0.56, 0.56, 0.55],
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
    plinth: [0.5, 0.48, 0.44],
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

/** Ear clipping for a counter-clockwise ring (x east, z north). Falls back to a fan if the ring is degenerate. */
function earClip(ring: ArrayLike<number>): number[] {
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
  /** Chimneys, balconies: vertex colours only, no texture. */
  readonly extras = new MeshData(false, true);
}

/** Adds a planar polygon face with a flat normal (the upward one for roofs, outward for gable walls). */
function face(md: MeshData, pts: Array<[number, number, number]>, color: RGB, uvScale: number, ax: number, az: number, wantUp = true): void {
  // Newell normal: robust for concave polygons and collinear leading points
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
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
  if (pts.length <= 3 || !wantUp) {
    for (let i = 1; i < pts.length - 1; i++) md.tri(base, base + i, base + i + 1, nx, ny, nz);
    return;
  }
  // roof faces from the straight skeleton can be concave: ear-clip the plan view
  const flat: number[] = [];
  for (const p of pts) flat.push(p[0], p[2]);
  const ccw = ringArea(flat) >= 0;
  const order = pts.map((_, i) => (ccw ? i : pts.length - 1 - i));
  const ring: number[] = [];
  for (const k of order) ring.push(pts[k]![0], pts[k]![2]);
  const tris = earClip(ring);
  for (let i = 0; i < tris.length; i += 3) md.tri(base + order[tris[i]!]!, base + order[tris[i + 1]!]!, base + order[tris[i + 2]!]!, nx, ny, nz);
}

/** Roof planes in the roof material, gable triangles in the wall material. */
function emitRoof(chunk: Chunk, g: RoofGeometry, roof: RGB, wall: RGB): void {
  for (const p of g.roof) face(chunk.roofs, p.pts, roof, 2, p.ax, p.az);
  for (const p of g.gables) face(chunk.walls, p.pts, wall, 7.2, p.ax, p.az, false);
}

/**
 * Vertical walls around a ring from `base` to `top`, facade texture anchored at floor level `ground`.
 * With `plinth`, the part below the floor is a plain stone base (hillside houses show it on the downhill side).
 */
function walls(md: MeshData, ring: ArrayLike<number>, base: number, top: number, ground: number, color: RGB, plinth?: RGB): void {
  const n = ring.length / 2;
  // fake ambient occlusion: darker where the wall meets the ground
  const skirt = ground + 1.8;
  const rows: Array<[number, number]> =
    plinth && ground > base + 0.1
      ? top > skirt + 0.5
        ? [[ground, 0.62], [skirt, 1], [top, 1]]
        : [[ground, 0.8], [top, 1]]
      : skirt > base + 0.2 && top > skirt + 0.5
        ? [[base, 0.6], [skirt, 1], [top, 1]]
        : [[base, 0.8], [top, 1]];
  const stone = plinth && ground > base + 0.1;
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
    if (stone) {
      // constant v: a plain plaster strip of the texture, stretched along the wall
      const p = plinth!;
      const v = 0.35 / 6.2;
      const a = md.vertex(x0, base, z0, nx, 0, nz, u0, v, p[0] * 0.8, p[1] * 0.8, p[2] * 0.8);
      const b = md.vertex(x0, ground, z0, nx, 0, nz, u0, v, p[0], p[1], p[2]);
      const c = md.vertex(x1, ground, z1, nx, 0, nz, u1, v, p[0], p[1], p[2]);
      const d = md.vertex(x1, base, z1, nx, 0, nz, u1, v, p[0] * 0.8, p[1] * 0.8, p[2] * 0.8);
      md.quad(a, b, c, d, nx, 0, nz);
    }
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

/** Parapet (Attika) around a flat roof: a low band outside and inside, with a cap. */
function parapet(md: MeshData, ring: ArrayLike<number>, top: number, color: RGB): void {
  const n = ring.length / 2;
  const h = top + 0.55;
  const v = 0.35 / 6.2;
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
    // inner face 0.25 m inside the wall line; cap on top
    const ix0 = x0 - nx * 0.25;
    const iz0 = z0 - nz * 0.25;
    const ix1 = x1 - nx * 0.25;
    const iz1 = z1 - nz * 0.25;
    for (const [ax, az, bx, bz, fx, fz, shade] of [
      [x0, z0, x1, z1, nx, nz, 1],
      [ix1, iz1, ix0, iz0, -nx, -nz, 0.8],
    ] as const) {
      const a = md.vertex(ax, top, az, fx, 0, fz, u0, v, color[0] * shade, color[1] * shade, color[2] * shade);
      const b = md.vertex(ax, h, az, fx, 0, fz, u0, v, color[0] * shade, color[1] * shade, color[2] * shade);
      const c = md.vertex(bx, h, bz, fx, 0, fz, u1, v, color[0] * shade, color[1] * shade, color[2] * shade);
      const d = md.vertex(bx, top, bz, fx, 0, fz, u1, v, color[0] * shade, color[1] * shade, color[2] * shade);
      md.quad(a, b, c, d, fx, 0, fz);
    }
    const a = md.vertex(x0, h, z0, 0, 1, 0, u0, v, color[0], color[1], color[2]);
    const b = md.vertex(x1, h, z1, 0, 1, 0, u1, v, color[0], color[1], color[2]);
    const c = md.vertex(ix1, h, iz1, 0, 1, 0, u1, v, color[0], color[1], color[2]);
    const d = md.vertex(ix0, h, iz0, 0, 1, 0, u0, v, color[0], color[1], color[2]);
    md.quad(a, b, c, d, 0, 1, 0);
  }
}

const scale = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];

/**
 * Axis-aligned box centred at `c`. U and V are horizontal unit vectors, `size` is [along U, along V, height].
 * Every face gets its outward normal, so the winding comes from MeshData.quad.
 */
function box(md: MeshData, c: [number, number, number], U: [number, number], V: [number, number], size: [number, number, number], color: RGB): void {
  const axes: Array<[number, number, number]> = [
    [U[0], 0, U[1]],
    [V[0], 0, V[1]],
    [0, 1, 0],
  ];
  const at = (s: number[]): [number, number, number] => {
    const p: number[] = [c[0], c[1], c[2]];
    for (let i = 0; i < 3; i++) {
      const o = (s[i]! * size[i]!) / 2;
      for (let j = 0; j < 3; j++) p[j]! += axes[i]![j]! * o;
    }
    return [p[0]!, p[1]!, p[2]!];
  };
  const LOOP: Array<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const k = (i + 2) % 3;
    for (const sign of [-1, 1]) {
      const nx = axes[i]![0] * sign;
      const ny = axes[i]![1] * sign;
      const nz = axes[i]![2] * sign;
      const v = LOOP.map(([sj, sk]) => {
        const s = [0, 0, 0];
        s[i] = sign;
        s[j] = sj;
        s[k] = sk;
        const p = at(s);
        return md.vertex(p[0], p[1], p[2], nx, ny, nz, 0, 0, color[0], color[1], color[2]);
      });
      md.quad(v[0]!, v[1]!, v[2]!, v[3]!, nx, ny, nz);
    }
  }
}

/** Brick chimney on a pitched roof: from the wall top to 0.7 m above the ridge, with a cap slab. */
function chimney(md: MeshData, at: ChimneySpot, top: number, body: RGB, roof: RGB): void {
  const U: [number, number] = [at.ax, at.az];
  const V: [number, number] = [-at.az, at.ax];
  const capY = at.ridge + 0.7;
  box(md, [at.x, (top + capY) / 2, at.z], U, V, [0.55, 0.55, capY - top], scale(body, 0.9));
  box(md, [at.x, capY + 0.04, at.z], U, V, [0.7, 0.7, 0.08], scale(roof, 0.8));
}

interface ChimneySpot {
  x: number;
  z: number;
  /** Height of the roof's highest point near the chimney. */
  ridge: number;
  ax: number;
  az: number;
}

interface PlannedRoof {
  geometry: RoofGeometry;
  chimney: ChimneySpot;
  /** Which method built it (rectangle, rectangle pieces or straight skeleton). */
  mode: 'rect' | 'pieces' | 'skeleton';
}

/** Share of its oriented rectangle a footprint must fill to get a plain roof over that rectangle. */
const RECT_FILL = 0.85;

/**
 * Pitched roof for a footprint: one hip/gable roof over the oriented rectangle when the footprint
 * nearly fills it, a roof per rectangle for L/T/U shapes, otherwise a hip roof over the real outline
 * from its straight skeleton. Null means: give it a flat roof.
 */
function planRoof(ring: Float32Array, top: number, kind: 'hip' | 'gable', pitch: number, eaves: number): PlannedRoof | null {
  const style = { pitch, eaves };
  const rect = orientedRect(ring);
  const fill = Math.abs(ringArea(ring)) / ((rect.u1 - rect.u0) * (rect.v1 - rect.v0));
  const chimneyOn = (r: Rect, ridge: number): ChimneySpot => {
    const p = rectPoint(r, r.u0 + 0.3 * (r.u1 - r.u0), r.v0 + 0.3 * (r.v1 - r.v0), 0);
    return { x: p[0], z: p[2], ridge, ax: r.ax, az: r.az };
  };
  if (fill >= RECT_FILL) {
    const geometry: RoofGeometry = { roof: [], gables: [] };
    const { ridge } = pieceRoof({ rect, ext0: 0, ext1: 0, inner0: false, inner1: false }, top, kind, style, geometry);
    return { geometry, chimney: chimneyOn(rect, ridge), mode: 'rect' };
  }
  const pieces = decomposeRects(ring, rect);
  if (pieces) {
    const geometry: RoofGeometry = { roof: [], gables: [] };
    let main: { p: RoofPiece; ridge: number } | null = null;
    for (const p of planPieces(pieces)) {
      const { ridge } = pieceRoof(p, top, kind, style, geometry);
      if (!main || ridge > main.ridge) main = { p, ridge };
    }
    return { geometry, chimney: chimneyOn(main!.p.rect, main!.ridge), mode: 'pieces' };
  }
  const geometry = skeletonRoof(ring, top, style);
  if (!geometry) return null;
  // chimney on the steepest-rising spot: halfway between the outline and the highest skeleton node
  let hi: [number, number, number] = [ring[0]!, top, ring[1]!];
  for (const p of geometry.roof) for (const q of p.pts) if (q[1] > hi[1]) hi = q;
  let cx = 0;
  let cz = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2]!;
    cz += ring[i * 2 + 1]!;
  }
  return { geometry, chimney: { x: (hi[0] * 2 + cx / n) / 3, z: (hi[2] * 2 + cz / n) / 3, ridge: hi[1], ax: rect.ax, az: rect.az }, mode: 'skeleton' };
}

/**
 * Balcony on the longest outer edge of a house, centred on a window of the upper floor. Windows repeat every
 * 7.2 m along the wall at 1.8 m and 5.4 m; the balcony takes the point nearest the edge middle, 1.4 m clear of corners.
 * Slab 2.4 m wide and 0.9 m deep, railing with a handrail, two side rails and nine posts.
 */
function balcony(md: MeshData, ring: Float32Array, ground: number, rail: RGB, post: number): void {
  const n = ring.length / 2;
  const edges: Array<{ i: number; start: number; len: number }> = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    const len = Math.hypot(ring[((i + 1) % n) * 2]! - ring[i * 2]!, ring[((i + 1) % n) * 2 + 1]! - ring[i * 2 + 1]!);
    if (len < 0.05) continue;
    edges.push({ i, start: run, len });
    run += len;
  }
  let e: (typeof edges)[number] | undefined = edges[0];
  for (const c of edges) if (!e || c.len > e.len) e = c;
  if (!e || e.len < 2.8) return;
  let t = -1;
  let bestGap = Infinity;
  for (const target of [1.8, 5.4]) {
    let s = (((target - e.start) % 7.2) + 7.2) % 7.2;
    while (s < 1.4) s += 7.2;
    for (; s <= e.len - 1.4; s += 7.2) {
      const gap = Math.abs(s - e.len / 2);
      if (gap < bestGap) {
        bestGap = gap;
        t = s;
      }
    }
  }
  if (t < 0) return;
  const x0 = ring[e.i * 2]!;
  const z0 = ring[e.i * 2 + 1]!;
  const x1 = ring[((e.i + 1) % n) * 2]!;
  const z1 = ring[((e.i + 1) % n) * 2 + 1]!;
  // along the edge and outward, the same normal as walls()
  const U: [number, number] = [(x1 - x0) / e.len, (z1 - z0) / e.len];
  const V: [number, number] = [U[1], -U[0]];
  const px = x0 + U[0] * t;
  const pz = z0 + U[1] * t;
  // point `along` m beside the window and `out` m away from the wall, at height y
  const at = (along: number, out: number, y: number): [number, number, number] => [
    px + U[0] * along + V[0] * out,
    y,
    pz + U[1] * along + V[1] * out,
  ];
  const slabTop = ground + 3.1 + 0.95 - 0.05;
  box(md, at(0, 0.45, slabTop - 0.06), U, V, [2.4, 0.9, 0.12], [0.82, 0.8, 0.76]);
  box(md, at(0, 0.88, slabTop + 1.0), U, V, [2.4, 0.04, 0.04], rail);
  for (const side of [-1.2, 1.2]) box(md, at(side, 0.45, slabTop + 1.0), U, V, [0.04, 0.9, 0.04], rail);
  for (let i = 0; i < 9; i++) box(md, at(-1.2 + ((i + 0.5) * 2.4) / 9, 0.88, slabTop + 0.5), U, V, [post, post, 1.0], rail);
}

/** Flat roof over the real outline; with `rim` colour, a parapet (Attika) around it. */
function flatRoof(chunk: Chunk, ring: Float32Array, top: number, color: RGB, rim: RGB | null): void {
  const n = ring.length / 2;
  const tris = earClip(ring);
  const roofs = chunk.roofs;
  const base0 = roofs.vertexCount;
  for (let i = 0; i < n; i++) roofs.vertex(ring[i * 2]!, top, ring[i * 2 + 1]!, 0, 1, 0, ring[i * 2]! / 2, ring[i * 2 + 1]! / 2, ...color);
  for (let i = 0; i < tris.length; i += 3) roofs.tri(base0 + tris[i]!, base0 + tris[i + 1]!, base0 + tris[i + 2]!, 0, 1, 0);
  if (rim) parapet(chunk.walls, ring, top, rim);
}

/**
 * True when a wall stands on the road or its shoulder, or the roof (eaves included) reaches over the
 * asphalt. Walls are sampled every 1.5 m, roofs at every corner and edge middle.
 */
function overRoad(corridor: RouteCorridor, ring: Float32Array, roof: RoofGeometry | null): boolean {
  const n = ring.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2]! / n;
    cz += ring[i * 2 + 1]! / n;
  }
  let reach = 0;
  for (let i = 0; i < n; i++) reach = Math.max(reach, Math.hypot(ring[i * 2]! - cx, ring[i * 2 + 1]! - cz));
  // the widest road is well under 12 m from the centre line; roofs overhang the walls by less than 3 m
  const R = 15;
  if (!corridor.nearest(cx, cz, reach + R)) return false;
  const blocked = (x: number, z: number, clearance: number): boolean => {
    const hit = corridor.nearest(x, z, R);
    return !!hit && Math.abs(hit.offset) < corridor.hw[hit.offset >= 0 ? 1 : 0][hit.row]! + clearance;
  };
  for (let i = 0; i < n; i++) {
    const x0 = ring[i * 2]!;
    const z0 = ring[i * 2 + 1]!;
    const x1 = ring[((i + 1) % n) * 2]!;
    const z1 = ring[((i + 1) % n) * 2 + 1]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 1.5));
    for (let k = 0; k < steps; k++) if (blocked(x0 + ((x1 - x0) * k) / steps, z0 + ((z1 - z0) * k) / steps, SHOULDER + 0.2)) return true;
  }
  if (roof) {
    for (const p of roof.roof) {
      for (let i = 0; i < p.pts.length; i++) {
        const a = p.pts[i]!;
        const b = p.pts[(i + 1) % p.pts.length]!;
        if (blocked(a[0], a[2], 0.3) || blocked((a[0] + b[0]) / 2, (a[2] + b[2]) / 2, 0.3)) return true;
      }
    }
  }
  return false;
}

function church(chunk: Chunk, ring: Float32Array, base: number, top: number, ground: number, style: Style, plinth: RGB, roof: PlannedRoof | null): void {
  const cs = style.church;
  const r = orientedRect(ring);
  walls(chunk.walls, ring, base, top, ground, cs.wall, plinth);
  if (roof) emitRoof(chunk, roof.geometry, cs.roof, cs.wall);
  else flatRoof(chunk, ring, top, scale(cs.roof, 0.8), cs.wall);
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
  walls(chunk.walls, tower, base, towerTop, ground, cs.wall, plinth);
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
  const extrasMat = new StandardMaterial('building-extras', scene);
  extrasMat.specularColor = new Color3(0.05, 0.05, 0.05);
  // detail maps add a texture read per pixel on the largest surfaces, so only the two top profiles get them
  if (quality.level === 'ultra' || quality.level === 'hoch') {
    // facade units are 7.2 m (walls) and 6.2 m (height) wide, roof units 2 m; plaster tiles 3 m, roof tiles 2 m
    applyDetail(wallMat, scene, 'plaster', [7.2 / 3, 6.2 / 3], { diffuse: 0.3, bump: 0.4 });
    applyDetail(roofMat, scene, 'rooftile', [1, 1], { diffuse: 0.5, bump: 0.8 });
    // window reveals: parallax from the bump map's alpha; it offsets diffuse and detail lookups too, so the reveals stay on the windows
    wallMat.bumpTexture = facadeBump(scene, architecture);
    wallMat.useParallax = true;
    wallMat.useParallaxOcclusion = false;
    wallMat.parallaxScaleBias = 0.035;
  }

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
    let minS = Infinity;
    let maxS = -Infinity;
    for (let i = 0; i < n; i++) {
      const s = corridor.surface(ring[i * 2]!, ring[i * 2 + 1]!);
      minS = Math.min(minS, s);
      maxS = Math.max(maxS, s);
    }
    if (maxS < wl + 0.3) return;
    // the terrain between the corners can dip lower than at them: the base reaches below every edge sample
    let lowest = minS;
    for (let i = 0; i < n; i++) {
      const x0 = ring[i * 2]!;
      const z0 = ring[i * 2 + 1]!;
      const x1 = ring[((i + 1) % n) * 2]!;
      const z1 = ring[((i + 1) % n) * 2 + 1]!;
      const steps = Math.floor(Math.hypot(x1 - x0, z1 - z0) / 4);
      for (let k = 1; k <= steps; k++) lowest = Math.min(lowest, corridor.surface(x0 + ((x1 - x0) * k) / (steps + 1), z0 + ((z1 - z0) * k) / (steps + 1)));
    }
    // floor level: on a slope the house sits partly on a plinth instead of burying its downhill windows
    const ground = Math.max(minS + Math.min(1.2, (maxS - minS) * 0.35), wl + 0.2);
    const base = lowest - 1.2;
    const top = Math.max(ground + b.height, maxS + 2.6);

    const paint = pick(style.paints, hash(k));
    const shade = 0.92 + hash(k + 17) * 0.1;
    const color: RGB = b.kind === 2 ? style.church.wall : [paint[0] * shade, paint[1] * shade, paint[2] * shade];
    const kind = b.kind === 2 || hash(k + 7) >= style.hipShare ? 'gable' : 'hip';
    const roof = b.kind === 0 ? null : planRoof(ring, top, kind, b.kind === 2 ? style.church.pitch : style.pitch, b.kind === 2 ? 0.3 : style.eaves);
    // keep the road clear of walls and roofs (eaves, roofs over the bounding rectangle)
    if (roof ? overRoad(corridor, ring, roof.geometry) : overRoad(corridor, ring, null)) return;

    const key = `${Math.floor(cx / CHUNK)},${Math.floor(cz / CHUNK)}`;
    let chunk = chunks.get(key);
    if (!chunk) chunks.set(key, (chunk = new Chunk()));
    const plinth: RGB = [
      color[0] * 0.35 + style.plinth[0] * 0.65,
      color[1] * 0.35 + style.plinth[1] * 0.65,
      color[2] * 0.35 + style.plinth[2] * 0.65,
    ];
    if (b.kind === 2) {
      church(chunk, ring, base, top, ground, style, plinth, roof);
      return;
    }
    walls(chunk.walls, ring, base, top, ground, color, plinth);
    if ((architecture === 'italian' || architecture === 'alpine') && top - ground >= 5.6 && hash(k + 29) < 0.45) {
      const italian = architecture === 'italian';
      balcony(chunk.extras, ring, ground, italian ? [0.1, 0.13, 0.1] : [0.42, 0.28, 0.16], italian ? 0.025 : 0.08);
    }
    if (roof) {
      const roofColor = style.roof(hash(k + 3));
      emitRoof(chunk, roof.geometry, roofColor, color);
      if (hash(k + 23) < 0.7) chimney(chunk.extras, roof.chimney, top, color, roofColor);
    } else {
      flatRoof(chunk, ring, top, style.flatRoof, b.kind === 1 ? color : null);
    }
  });

  const meshes: Mesh[] = [];
  for (const [key, chunk] of chunks) {
    for (const [md, mat, name, dist] of [
      [chunk.walls, wallMat, 'walls', quality.buildingDistance],
      [chunk.roofs, roofMat, 'roofs', quality.buildingDistance],
      [chunk.extras, extrasMat, 'extras', Math.min(600, quality.buildingDistance)],
    ] as const) {
      const m = md.build(scene, `bld-${name}-${key}`, mat);
      if (!m) continue;
      m.addLODLevel(dist, null);
      meshes.push(m);
    }
  }
  return meshes;
}
