import { Mesh, VertexData, type Scene, type StandardMaterial } from '@babylonjs/core';
import { Noise2D, smoothstep } from '../noise';
import { PUSH_RADIUS, type RouteCorridor } from './corridor';
import { TO_SUN } from './env';
import type { HeightField } from './heightField';
import { orientedTri } from './meshData';
import type { QualityProfile } from './quality';
import { createTerrainMaterial } from './terrainMaterial';
import { LAND_CLASS, type WorldData, type WorldGrid } from './worldData';

type RGB = [number, number, number];

/** Albedo per land class (index = LAND_CLASS value). */
const CLASS_RGB: RGB[] = [
  [0.36, 0.48, 0.2], // grass
  [0.17, 0.27, 0.12], // forest
  [0.3, 0.38, 0.18], // shrub
  [0.38, 0.4, 0.3], // urban (courtyards, gardens, paving)
  [0.33, 0.45, 0.21], // garden
  [0.45, 0.5, 0.26], // farmland
  [0.5, 0.48, 0.45], // rock
  [0.25, 0.27, 0.22], // lake bed
  [0.7, 0.65, 0.52], // sand
  [0.34, 0.5, 0.22], // park
  [0.36, 0.46, 0.2], // orchard
  [0.92, 0.94, 0.97], // snow
];
/** How much of the class is tree canopy (drives canopy relief in the shader). */
const FOREST_COVER = [0, 1, 0.5, 0, 0.25, 0, 0, 0, 0, 0.15, 0.3, 0];
const ALPINE_MEADOW: RGB = [0.45, 0.47, 0.3];
const ROCK: RGB = [0.5, 0.48, 0.45];
const SNOW: RGB = [0.93, 0.95, 0.98];
const PEBBLES: RGB = [0.57, 0.54, 0.49];
const OTHER_LAKE: RGB = [0.17, 0.26, 0.32];
const NEAR_TILE = 64;

function mixInto(c: RGB, d: RGB, t: number): void {
  c[0] += (d[0] - c[0]) * t;
  c[1] += (d[1] - c[1]) * t;
  c[2] += (d[2] - c[2]) * t;
}

/**
 * Soft cast shadows of the mountains for the fixed afternoon sun, marched over the elevation model
 * on a coarser lattice and interpolated back to every vertex.
 */
function sunVisibility(g: WorldGrid, field: HeightField, stride: number, maxH: number): Float32Array {
  const wl = field.waterLevel;
  const hx = Math.hypot(TO_SUN.x, TO_SUN.z);
  const dx = TO_SUN.x / hx;
  const dz = TO_SUN.z / hx;
  const slope = TO_SUN.y / hx;
  const sx = Math.floor((g.nx - 1) / stride) + 1;
  const sz = Math.floor((g.nz - 1) / stride) + 1;
  const lattice = new Float32Array(sx * sz);
  for (let b = 0; b < sz; b++) {
    for (let a = 0; a < sx; a++) {
      const i = a * stride;
      const j = b * stride;
      const h = g.heights[j * g.nx + i]!;
      if (h < wl - 1) {
        lattice[b * sx + a] = 1;
        continue;
      }
      const x = g.x0 + i * g.step;
      const z = g.z0 + j * g.step;
      const h0 = Math.max(h, wl) + 1.5;
      let vis = 1;
      let t = g.step;
      while (t < 45000) {
        const ry = h0 + t * slope;
        if (ry > maxH) break;
        const px = x + dx * t;
        const pz = z + dz * t;
        const th = t < 800 ? field.dem(px, pz) : field.coarse(px, pz);
        const k = (ry - th) / (0.045 * t + 3);
        if (k < vis) {
          vis = k;
          if (vis <= 0) break;
        }
        t = t * 1.06 + g.step * 0.5;
      }
      lattice[b * sx + a] = smoothstep(0, 1, vis);
    }
  }
  const out = new Float32Array(g.nx * g.nz);
  for (let j = 0; j < g.nz; j++) {
    const fb = Math.min(j / stride, sz - 1);
    const b0 = Math.min(Math.floor(fb), sz - 2 < 0 ? 0 : sz - 2);
    const tb = Math.min(1, fb - b0);
    for (let i = 0; i < g.nx; i++) {
      const fa = Math.min(i / stride, sx - 1);
      const a0 = Math.min(Math.floor(fa), sx - 2 < 0 ? 0 : sx - 2);
      const ta = Math.min(1, fa - a0);
      const v00 = lattice[b0 * sx + a0]!;
      const v10 = lattice[b0 * sx + Math.min(a0 + 1, sx - 1)]!;
      const v01 = lattice[Math.min(b0 + 1, sz - 1) * sx + a0]!;
      const v11 = lattice[Math.min(b0 + 1, sz - 1) * sx + Math.min(a0 + 1, sx - 1)]!;
      out[j * g.nx + i] = (v00 + (v10 - v00) * ta) * (1 - tb) + (v01 + (v11 - v01) * ta) * tb;
    }
  }
  return out;
}

/** RGBA colour map: land-cover albedo, altitude zones, pebble shores, large-scale variation and baked shadows. */
function bakeColors(g: WorldGrid, wl: number, vis: Float32Array, noise: Noise2D): Uint8Array {
  const out = new Uint8Array(g.nx * g.nz * 4);
  const c: RGB = [0, 0, 0];
  for (let j = 0; j < g.nz; j++) {
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      const x = g.x0 + i * g.step;
      const z = g.z0 + j * g.step;
      const h = g.heights[k]!;
      let cls: number = g.classes[k]!;
      if (g.name === 'horizon' && cls !== LAND_CLASS.water && cls !== LAND_CLASS.rock) {
        cls = h < 1150 && noise.noise(x / 1800, z / 1800) > -0.35 ? LAND_CLASS.forest : LAND_CLASS.grass;
      }
      let forest = FOREST_COVER[cls] ?? 0;
      const base = CLASS_RGB[cls] ?? CLASS_RGB[0]!;
      c[0] = base[0];
      c[1] = base[1];
      c[2] = base[2];
      if (cls === LAND_CLASS.water) {
        if (h > wl + 3) mixInto(c, OTHER_LAKE, 1);
      } else {
        if (cls !== LAND_CLASS.urban && cls !== LAND_CLASS.rock) {
          mixInto(c, ALPINE_MEADOW, smoothstep(1300, 1750, h));
          forest *= 1 - smoothstep(1550, 1900, h);
        }
        mixInto(c, ROCK, smoothstep(2000, 2450, h));
        mixInto(c, SNOW, smoothstep(2500, 2850, h));
        if (h < wl + 1.6) mixInto(c, PEBBLES, 0.8 * smoothstep(wl + 1.6, wl + 0.6, h));
        const v = noise.fbm(x / 1100, z / 1100, 3);
        const dry = Math.max(0, noise.noise(x / 2600 + 31.7, z / 2600 - 12.3));
        mixInto(c, [0.52, 0.49, 0.32], 0.22 * dry * (1 - forest));
        const b = 1 + 0.1 * v;
        c[0] *= b;
        c[1] *= b;
        c[2] *= b;
      }
      const light = 0.55 + 0.45 * vis[k]!;
      out[k * 4] = Math.min(255, Math.round(c[0] * light * 255));
      out[k * 4 + 1] = Math.min(255, Math.round(c[1] * light * 255));
      out[k * 4 + 2] = Math.min(255, Math.round(c[2] * light * 255));
      out[k * 4 + 3] = Math.round(forest * 255);
    }
  }
  return out;
}

function gridNormals(g: WorldGrid, h: Float32Array): Float32Array {
  const n = new Float32Array(g.nx * g.nz * 3);
  const { nx, nz, step } = g;
  for (let j = 0; j < nz; j++) {
    const jd = Math.max(0, j - 1);
    const ju = Math.min(nz - 1, j + 1);
    for (let i = 0; i < nx; i++) {
      const il = Math.max(0, i - 1);
      const ir = Math.min(nx - 1, i + 1);
      const ddx = (h[j * nx + ir]! - h[j * nx + il]!) / ((ir - il) * step);
      const ddz = (h[ju * nx + i]! - h[jd * nx + i]!) / ((ju - jd) * step);
      const inv = 1 / Math.hypot(ddx, 1, ddz);
      const k = (j * nx + i) * 3;
      n[k] = -ddx * inv;
      n[k + 1] = inv;
      n[k + 2] = -ddz * inv;
    }
  }
  return n;
}

function axis(from: number, to: number, s: number): number[] {
  const out: number[] = [];
  for (let v = from; v < to; v += s) out.push(v);
  out.push(to);
  return out;
}

/**
 * One terrain tile at a level of detail `s` (every s-th vertex). Triangles that lie completely under
 * the lake surface are dropped; skirts hang below the borders to hide cracks between neighbouring LODs.
 */
function tileVertexData(g: WorldGrid, h: Float32Array, n: Float32Array, i0: number, i1: number, j0: number, j1: number, s: number, wl: number, skirt: number): VertexData | null {
  const cols = axis(i0, i1, s);
  const rows = axis(j0, j1, s);
  const nc = cols.length;
  const nr = rows.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const j of rows) {
    for (const i of cols) {
      const k = j * g.nx + i;
      pos.push(g.x0 + i * g.step, h[k]!, g.z0 + j * g.step);
      nor.push(n[k * 3]!, n[k * 3 + 1]!, n[k * 3 + 2]!);
    }
  }
  const under = wl - 1;
  const below = (v: number) => pos[v * 3 + 1]! < under;
  for (let r = 0; r < nr - 1; r++) {
    for (let c = 0; c < nc - 1; c++) {
      const a = r * nc + c;
      const b = a + 1;
      const cc = a + nc;
      const d = cc + 1;
      if (!(below(a) && below(b) && below(cc))) idx.push(a, b, cc);
      if (!(below(b) && below(d) && below(cc))) idx.push(b, d, cc);
    }
  }
  if (idx.length === 0) return null;
  if (skirt > 0) {
    const edges: Array<[number[], number, number]> = [
      [cols.map((_, c) => c), 0, -1],
      [cols.map((_, c) => (nr - 1) * nc + c), 0, 1],
      [rows.map((_, r) => r * nc), -1, 0],
      [rows.map((_, r) => r * nc + nc - 1), 1, 0],
    ];
    for (const [verts, ox, oz] of edges) {
      const base = pos.length / 3;
      for (const v of verts) {
        pos.push(pos[v * 3]!, pos[v * 3 + 1]! - skirt, pos[v * 3 + 2]!);
        nor.push(nor[v * 3]!, nor[v * 3 + 1]!, nor[v * 3 + 2]!);
      }
      for (let q = 0; q < verts.length - 1; q++) {
        const t0 = verts[q]!;
        const t1 = verts[q + 1]!;
        if (below(t0) && below(t1)) continue;
        orientedTri(idx, pos, t0, t1, base + q, ox, 0, oz);
        orientedTri(idx, pos, t1, base + q + 1, base + q, ox, 0, oz);
      }
    }
  }
  const vd = new VertexData();
  vd.positions = new Float32Array(pos);
  vd.normals = new Float32Array(nor);
  vd.indices = pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
  return vd;
}

function insideGrid(g: WorldGrid, x: number, z: number, margin: number): boolean {
  return x > g.x0 + margin && z > g.z0 + margin && x < g.x0 + (g.nx - 1) * g.step - margin && z < g.z0 + (g.nz - 1) * g.step - margin;
}

/**
 * Three nested terrain rasters (12 m near the route, 60 m, 250 m up to the horizon). Each coarser
 * raster leaves a hole where the finer one lies and sinks its rim under it.
 */
export class RealTerrain {
  readonly meshes: Mesh[] = [];
  readonly materials: StandardMaterial[] = [];
  nearMaterial!: StandardMaterial;
  private nearNormals!: Float32Array;

  private constructor(
    private readonly scene: Scene,
    private readonly data: WorldData,
  ) {}

  static async build(scene: Scene, data: WorldData, field: HeightField, corridor: RouteCorridor, quality: QualityProfile, step: (msg: string) => Promise<void>): Promise<RealTerrain> {
    const t = new RealTerrain(scene, data);
    const wl = data.waterLevel;
    const noise = new Noise2D(4711);
    let maxH = 0;
    for (const v of data.horizon.heights) maxH = Math.max(maxH, v);

    const grids = [data.near, data.far, data.horizon];
    const strides = [quality.level === 'niedrig' ? 4 : 3, 2, 1];
    const colors: Uint8Array[] = [];
    for (let k = 0; k < grids.length; k++) {
      await step(k === 0 ? 'Licht und Schatten der Berge …' : `Licht und Schatten (${k + 1}/3) …`);
      const vis = sunVisibility(grids[k]!, field, strides[k]!, maxH);
      colors.push(bakeColors(grids[k]!, wl, vis, noise));
    }
    const mats = grids.map((g, k) => createTerrainMaterial(scene, `terrain-${g.name}`, g, colors[k]!, wl, quality.detail && k < 2));
    t.materials.push(...mats);
    t.nearMaterial = mats[0]!;

    await step('Gelände wird modelliert …');
    const near = data.near;
    t.nearNormals = gridNormals(near, near.heights);
    const nearH = Float32Array.from(near.heights);
    const mark = new Uint8Array(near.nx * near.nz);
    const reach = Math.ceil((PUSH_RADIUS + near.step) / near.step);
    const tr = corridor.track;
    for (let i = 0; i < tr.count; i += 2) {
      const ci = Math.round((tr.xs[i]! - near.x0) / near.step);
      const cj = Math.round((tr.zs[i]! - near.z0) / near.step);
      for (let jj = Math.max(0, cj - reach); jj <= Math.min(near.nz - 1, cj + reach); jj++) {
        for (let ii = Math.max(0, ci - reach); ii <= Math.min(near.nx - 1, ci + reach); ii++) mark[jj * near.nx + ii] = 1;
      }
    }
    for (let k = 0; k < mark.length; k++) {
      if (!mark[k]) continue;
      const x = near.x0 + (k % near.nx) * near.step;
      const z = near.z0 + Math.floor(k / near.nx) * near.step;
      nearH[k] = corridor.gridHeight(x, z, nearH[k]!);
    }

    // decimated route for "how close can the camera get to this tile"
    const routePts: number[] = [];
    for (let i = 0; i < tr.count; i += 10) routePts.push(tr.xs[i]!, tr.zs[i]!);
    const routeDist = (x0: number, z0: number, x1: number, z1: number) => {
      let best = Infinity;
      for (let p = 0; p < routePts.length; p += 2) {
        const dx = Math.max(x0 - routePts[p]!, 0, routePts[p]! - x1);
        const dz = Math.max(z0 - routePts[p + 1]!, 0, routePts[p + 1]! - z1);
        best = Math.min(best, dx * dx + dz * dz);
      }
      return Math.sqrt(best);
    };

    const [lod1, lod2] = quality.terrainLod;
    let built = 0;
    for (let j0 = 0; j0 < near.nz - 1; j0 += NEAR_TILE) {
      for (let i0 = 0; i0 < near.nx - 1; i0 += NEAR_TILE) {
        const i1 = Math.min(i0 + NEAR_TILE, near.nx - 1);
        const j1 = Math.min(j0 + NEAR_TILE, near.nz - 1);
        const d = routeDist(near.x0 + i0 * near.step, near.z0 + j0 * near.step, near.x0 + i1 * near.step, near.z0 + j1 * near.step) - 60;
        const levels = d > lod2 ? [4] : d > lod1 ? [2, 4] : [1, 2, 4];
        const lodMeshes: Mesh[] = [];
        for (const s of levels) {
          const vd = tileVertexData(near, nearH, t.nearNormals, i0, i1, j0, j1, s, wl, s * near.step * 0.6 + 3);
          if (!vd) break;
          lodMeshes.push(t.mesh(`terrain-near-${i0}-${j0}-${s}`, vd, t.nearMaterial));
        }
        const main = lodMeshes[0];
        if (!main) continue;
        if (lodMeshes.length === 3) {
          main.addLODLevel(lod1, lodMeshes[1]!);
          main.addLODLevel(lod2, lodMeshes[2]!);
        } else if (lodMeshes.length === 2) {
          main.addLODLevel(levels[0] === 1 ? lod1 : lod2, lodMeshes[1]!);
        }
        if (++built % 24 === 0) await step('Gelände wird modelliert …');
      }
    }

    await step('Berge bis zum Horizont …');
    t.coarseGrid(data.far, near, mats[1]!, wl);
    t.coarseGrid(data.horizon, data.far, mats[2]!, wl);
    return t;
  }

  /** Terrain normal of the natural (un-pushed) near grid, for verges that blend into the ground. */
  normalAt(x: number, z: number, out: RGB): RGB {
    const g = this.data.near;
    const fx = Math.min(g.nx - 1.001, Math.max(0, (x - g.x0) / g.step));
    const fz = Math.min(g.nz - 1.001, Math.max(0, (z - g.z0) / g.step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const n = this.nearNormals;
    const k00 = (j * g.nx + i) * 3;
    const k10 = k00 + 3;
    const k01 = k00 + g.nx * 3;
    const k11 = k01 + 3;
    for (let a = 0; a < 3; a++) {
      out[a] = (n[k00 + a]! * (1 - tx) + n[k10 + a]! * tx) * (1 - tz) + (n[k01 + a]! * (1 - tx) + n[k11 + a]! * tx) * tz;
    }
    const len = Math.hypot(out[0], out[1], out[2]);
    out[0] /= len;
    out[1] /= len;
    out[2] /= len;
    return out;
  }

  private coarseGrid(g: WorldGrid, finer: WorldGrid, mat: StandardMaterial, wl: number): void {
    const h = Float32Array.from(g.heights);
    const inside = new Uint8Array(g.nx * g.nz);
    for (let j = 0; j < g.nz; j++) {
      for (let i = 0; i < g.nx; i++) {
        if (insideGrid(finer, g.x0 + i * g.step, g.z0 + j * g.step, finer.step)) {
          inside[j * g.nx + i] = 1;
          h[j * g.nx + i]! -= 4;
        }
      }
    }
    const n = gridNormals(g, g.heights);
    const tiles = 4;
    const tw = Math.ceil((g.nx - 1) / tiles);
    const th = Math.ceil((g.nz - 1) / tiles);
    for (let tj = 0; tj < tiles; tj++) {
      for (let ti = 0; ti < tiles; ti++) {
        const i0 = ti * tw;
        const j0 = tj * th;
        const i1 = Math.min(i0 + tw, g.nx - 1);
        const j1 = Math.min(j0 + th, g.nz - 1);
        if (i0 >= i1 || j0 >= j1) continue;
        const vd = tileVertexData(g, h, n, i0, i1, j0, j1, 1, wl, 0);
        if (!vd) continue;
        // drop the cells covered completely by the finer raster
        const idx = vd.indices!;
        const pos = vd.positions!;
        const keep: number[] = [];
        const nc = i1 - i0 + 1;
        const vin = (v: number) => {
          const i = i0 + (v % nc);
          const j = j0 + Math.floor(v / nc);
          return inside[j * g.nx + i] === 1;
        };
        for (let q = 0; q < idx.length; q += 3) {
          if (vin(idx[q]!) && vin(idx[q + 1]!) && vin(idx[q + 2]!)) continue;
          keep.push(idx[q]!, idx[q + 1]!, idx[q + 2]!);
        }
        if (keep.length === 0) continue;
        vd.indices = pos.length / 3 > 65535 ? new Uint32Array(keep) : new Uint16Array(keep);
        this.mesh(`terrain-${g.name}-${ti}-${tj}`, vd, mat);
      }
    }
  }

  private mesh(name: string, vd: VertexData, mat: StandardMaterial): Mesh {
    const m = new Mesh(name, this.scene);
    vd.applyToMesh(m, false);
    m.material = mat;
    m.isPickable = false;
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    this.meshes.push(m);
    return m;
  }
}
