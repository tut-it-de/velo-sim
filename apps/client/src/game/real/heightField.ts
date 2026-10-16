import { LAND_CLASS, type Building, type WorldData, type WorldGrid } from './worldData';

/** Height of a grid cell split along the (i+1, j)–(i, j+1) diagonal — the same split the terrain mesh uses. */
export function triSample(h: ArrayLike<number>, nx: number, fx: number, fz: number): number {
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const a = j * nx + i;
  const ha = h[a]!;
  const hb = h[a + 1]!;
  const hc = h[a + nx]!;
  const hd = h[a + nx + 1]!;
  if (tx + tz <= 1) return ha + (hb - ha) * tx + (hc - ha) * tz;
  return hd + (hc - hd) * (1 - tx) + (hb - hd) * (1 - tz);
}

function bilinear(h: ArrayLike<number>, nx: number, fx: number, fz: number): number {
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const a = j * nx + i;
  const top = h[a]! + (h[a + 1]! - h[a]!) * tx;
  const bottom = h[a + nx]! + (h[a + nx + 1]! - h[a + nx]!) * tx;
  return top + (bottom - top) * tz;
}

export function gridContains(g: WorldGrid, x: number, z: number, margin = 0): boolean {
  const fx = (x - g.x0) / g.step;
  const fz = (z - g.z0) / g.step;
  return fx >= margin && fz >= margin && fx < g.nx - 1 - margin && fz < g.nz - 1 - margin;
}

/** Natural terrain (digital elevation model) from the three nested rasters. */
export class HeightField {
  readonly near: WorldGrid;
  readonly far: WorldGrid;
  readonly horizon: WorldGrid;
  readonly waterLevel: number;

  constructor(data: WorldData) {
    this.near = data.near;
    this.far = data.far;
    this.horizon = data.horizon;
    this.waterLevel = data.waterLevel;
  }

  dem(x: number, z: number): number {
    const g = this.near;
    const fx = (x - g.x0) / g.step;
    const fz = (z - g.z0) / g.step;
    if (fx >= 0 && fz >= 0 && fx < g.nx - 1 && fz < g.nz - 1) return triSample(g.heights, g.nx, fx, fz);
    return this.coarse(x, z);
  }

  coarse(x: number, z: number): number {
    for (const g of [this.far, this.horizon]) {
      const fx = (x - g.x0) / g.step;
      const fz = (z - g.z0) / g.step;
      if (fx >= 0 && fz >= 0 && fx < g.nx - 1 && fz < g.nz - 1) return bilinear(g.heights, g.nx, fx, fz);
    }
    return this.waterLevel + 1;
  }

  /** Land class of the nearest near-grid cell (far grid outside it). */
  classAt(x: number, z: number): number {
    for (const g of [this.near, this.far]) {
      const i = Math.round((x - g.x0) / g.step);
      const j = Math.round((z - g.z0) / g.step);
      if (i >= 0 && j >= 0 && i < g.nx && j < g.nz) return g.classes[j * g.nx + i]!;
    }
    return LAND_CLASS.grass;
  }

  isWater(x: number, z: number): boolean {
    return this.classAt(x, z) === LAND_CLASS.water || this.dem(x, z) < this.waterLevel;
  }
}

/** Spatial hash over building footprints for point-in-building tests. */
export class BuildingIndex {
  private readonly cell = 48;
  private readonly cells = new Map<number, number[]>();
  readonly bbox: Float32Array;

  constructor(readonly buildings: Building[]) {
    this.bbox = new Float32Array(buildings.length * 4);
    buildings.forEach((b, k) => {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < b.ring.length; i += 2) {
        x0 = Math.min(x0, b.ring[i]!);
        x1 = Math.max(x1, b.ring[i]!);
        z0 = Math.min(z0, b.ring[i + 1]!);
        z1 = Math.max(z1, b.ring[i + 1]!);
      }
      this.bbox.set([x0, z0, x1, z1], k * 4);
      for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++) {
        for (let cz = Math.floor(z0 / this.cell); cz <= Math.floor(z1 / this.cell); cz++) {
          const key = cellKey(cx, cz);
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(k);
        }
      }
    });
  }

  /** Index of the building containing (x, z), or -1. `pad` grows every footprint's bounding box test. */
  find(x: number, z: number, pad = 0): number {
    const list = this.cells.get(cellKey(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!list) return -1;
    for (const k of list) {
      const b = this.bbox;
      if (x < b[k * 4]! - pad || x > b[k * 4 + 2]! + pad || z < b[k * 4 + 1]! - pad || z > b[k * 4 + 3]! + pad) continue;
      if (pad > 0 || pointInRing(this.buildings[k]!.ring, x, z)) return k;
    }
    return -1;
  }
}

export function pointInRing(ring: Float32Array, x: number, z: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i]!;
    const zi = ring[2 * i + 1]!;
    const xj = ring[2 * j]!;
    const zj = ring[2 * j + 1]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}
