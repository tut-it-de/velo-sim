import type { Track } from '@velo/routes';
import { smoothstep } from '../noise';
import { cellKey, type BuildingIndex, type HeightField } from './heightField';
import { LAND_CLASS } from './worldData';

/** Gravel/curb strip next to the asphalt. */
export const SHOULDER = 0.5;
/** The verge ribbon (cut/fill slopes between road and terrain) reaches this far from the centre line. */
export const VERGE_OUT = 40;
/** Distance over which the verge blends from road level into the natural terrain. */
export const VERGE_BLEND = 12;
/**
 * Terrain-grid vertices closer than this are lowered under the ribbon. Any 12 m grid triangle that
 * touches the asphalt then lies completely under the ribbon (12·√2 + road < PUSH_RADIUS + 17 < VERGE_OUT).
 */
export const PUSH_RADIUS = 21;
export const PUSH_DEPTH = 2.5;
export const DEFAULT_HALF_WIDTH = 3.3;
export const WALL_THICK = 0.45;
/** What borders the road on one side. */
export const EDGE = { verge: 0, lake: 1, wall: 2, rail: 3 } as const;
/** Every 2nd track sample (4 m) is a ribbon row. */
export const ROW_STRIDE = 2;

export interface RouteHit {
  /** Track sample index. */
  i: number;
  row: number;
  dist: number;
  /** Signed lateral offset, positive = right of the direction of travel. */
  offset: number;
  /** Road elevation at the foot point. */
  y: number;
}

type SideArrays<T> = [T, T];

/**
 * Analyses the lap once: road widths (narrow streets between houses), which side borders the lake,
 * needs a retaining wall or a guardrail, how far each verge may reach (hairpins, tight bends,
 * other parts of the lap) and which rows duplicate an earlier pass (out-and-back sections).
 * Also answers "how high is the ground here?" consistently for the terrain, buildings and trees.
 */
export class RouteCorridor {
  readonly rows: number;
  readonly hw: SideArrays<Float32Array>;
  readonly edge: SideArrays<Uint8Array>;
  readonly ext: SideArrays<Float32Array>;
  /** Height both verges meet at when another part of the lap is close (NaN = blend into the terrain). */
  readonly mid: SideArrays<Float32Array>;
  readonly wallH: SideArrays<Float32Array>;
  readonly urban: Uint8Array;
  readonly covered: Uint8Array;
  private readonly cell = 16;
  private readonly cells = new Map<number, number[]>();

  constructor(
    readonly track: Track,
    readonly field: HeightField,
    buildings: BuildingIndex,
  ) {
    for (let i = 0; i < track.count; i++) {
      const key = cellKey(Math.floor(track.xs[i]! / this.cell), Math.floor(track.zs[i]! / this.cell));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    }
    const rows = (this.rows = Math.floor(track.count / ROW_STRIDE));
    const pair = <T>(make: () => T): SideArrays<T> => [make(), make()];
    this.hw = pair(() => new Float32Array(rows));
    this.edge = pair(() => new Uint8Array(rows));
    this.ext = pair(() => new Float32Array(rows));
    this.mid = pair(() => new Float32Array(rows));
    this.wallH = pair(() => new Float32Array(rows));
    this.urban = new Uint8Array(rows);
    this.covered = new Uint8Array(rows);
    this.analyze(buildings);
  }

  sampleOf(row: number): number {
    return row * ROW_STRIDE;
  }

  /** Distance along the lap between two samples (shorter way round). */
  lapGap(i: number, j: number): number {
    const n = this.track.count;
    const d = Math.abs(i - j) % n;
    return Math.min(d, n - d) * this.track.step;
  }

  nearest(x: number, z: number, maxDist: number, accept?: (i: number) => boolean): RouteHit | null {
    const c = this.cell;
    const r = Math.ceil(maxDist / c);
    const cx = Math.floor(x / c);
    const cz = Math.floor(z / c);
    const t = this.track;
    let best = maxDist * maxDist;
    let bi = -1;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const list = this.cells.get(cellKey(cx + dx, cz + dz));
        if (!list) continue;
        for (const i of list) {
          const ex = t.xs[i]! - x;
          const ez = t.zs[i]! - z;
          const d2 = ex * ex + ez * ez;
          if (d2 < best && (!accept || accept(i))) {
            best = d2;
            bi = i;
          }
        }
      }
    }
    return bi < 0 ? null : this.hitFor(bi, x, z);
  }

  hitFor(i: number, x: number, z: number): RouteHit {
    const t = this.track;
    const h = t.headings[i]!;
    const vx = x - t.xs[i]!;
    const vz = z - t.zs[i]!;
    const along = vx * Math.sin(h) + vz * Math.cos(h);
    const offset = vx * Math.cos(h) - vz * Math.sin(h);
    return { i, row: Math.round(i / ROW_STRIDE) % this.rows, dist: Math.hypot(vx, vz), offset, y: t.ys[i]! + (along * t.grades[i]!) / 100 };
  }

  /** Ground height at lateral distance `o` (≥ 0) from the centre line on one side of a row. */
  profile(row: number, side: number, o: number, dem: number, roadY: number, edge: number = this.edge[side]![row]!): number {
    const hw = this.hw[side]![row]!;
    if (o <= hw) return roadY;
    if (o <= hw + SHOULDER) return roadY - 0.05;
    if (edge === EDGE.lake) return this.field.waterLevel - 2.5;
    let base = roadY - 0.12;
    let start = hw + SHOULDER;
    if (edge === EDGE.wall) {
      base = roadY + this.wallH[side]![row]!;
      start += WALL_THICK;
      if (o <= start) return base;
    }
    const ext = Math.max(start + 0.5, this.ext[side]![row]!);
    const mid = this.mid[side]![row]!;
    if (!Number.isNaN(mid)) return base + (mid - base) * smoothstep(start, ext, o);
    return base + (dem - base) * smoothstep(start, Math.min(start + VERGE_BLEND, ext), o);
  }

  /** Final ground height (road, verge or natural terrain) — buildings and trees stand on this. */
  surface(x: number, z: number): number {
    const dem = this.field.dem(x, z);
    const hit = this.nearest(x, z, VERGE_OUT);
    if (!hit) return dem;
    const side = hit.offset >= 0 ? 1 : 0;
    return this.profile(hit.row, side, Math.abs(hit.offset), dem, hit.y);
  }

  /** Terrain-grid vertex height: lowered under the ribbon near the road. */
  gridHeight(x: number, z: number, dem: number): number {
    const hit = this.nearest(x, z, PUSH_RADIUS);
    if (!hit) return dem;
    const side = hit.offset >= 0 ? 1 : 0;
    return Math.min(dem, this.profile(hit.row, side, Math.abs(hit.offset), dem, hit.y)) - PUSH_DEPTH;
  }

  private analyze(buildings: BuildingIndex): void {
    const t = this.track;
    const f = this.field;
    const rows = this.rows;
    const n = t.count;
    const wl = f.waterLevel;

    // 1) road width: narrower where houses stand close (Bellagio's old town)
    for (let r = 0; r < rows; r++) {
      const i = this.sampleOf(r);
      const rx = Math.cos(t.headings[i]!);
      const rz = -Math.sin(t.headings[i]!);
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? -1 : 1;
        let hw = DEFAULT_HALF_WIDTH;
        for (const o of [1.9, 2.4, 2.9, 3.4, 3.9]) {
          if (buildings.find(t.xs[i]! + sg * rx * o, t.zs[i]! + sg * rz * o) >= 0) {
            hw = Math.min(hw, o - 0.6);
            break;
          }
        }
        this.hw[side]![r] = Math.max(2.1, hw);
      }
    }
    for (const arr of this.hw) {
      const min = windowed(arr, 2, (a, b) => Math.min(a, b), Infinity);
      const avg = windowed(min, 3, (a, b) => a + b, 0);
      for (let r = 0; r < rows; r++) arr[r] = avg[r]! / 7;
    }

    // 2) built-up area (no centre line, street lamps)
    for (let r = 0; r < rows; r++) {
      const i = this.sampleOf(r);
      const rx = Math.cos(t.headings[i]!);
      const rz = -Math.sin(t.headings[i]!);
      let built = 0;
      for (const o of [-14, -7, 7, 14]) {
        const c = f.classAt(t.xs[i]! + rx * o, t.zs[i]! + rz * o);
        if (c === LAND_CLASS.urban || c === LAND_CLASS.garden) built++;
      }
      this.urban[r] = built >= 2 ? 1 : 0;
    }
    cleanRuns(this.urban, 25);

    // 3) rows that repeat an earlier pass (same road, other direction)
    for (let r = 0; r < rows; r++) {
      const i = this.sampleOf(r);
      const hit = this.nearest(t.xs[i]!, t.zs[i]!, 2.2, (j) => this.lapGap(i, j) > 150);
      if (hit && hit.i < i) this.covered[r] = 1;
    }

    // 4) edges and verge extents
    for (let r = 0; r < rows; r++) {
      const i = this.sampleOf(r);
      const x = t.xs[i]!;
      const z = t.zs[i]!;
      const y = t.ys[i]!;
      const rx = Math.cos(t.headings[i]!);
      const rz = -Math.sin(t.headings[i]!);
      // signed curvature over ±12 m: > 0 turns right (heading grows clockwise)
      const dh = wrapAngle(t.headings[(i + 6) % n]! - t.headings[(i - 6 + n) % n]!);
      const radius = 24 / Math.max(Math.abs(dh), 1e-3);
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? -1 : 1;
        const hw = this.hw[side]![r]!;
        const at = (o: number): [number, number] => [x + sg * rx * o, z + sg * rz * o];
        let ext = VERGE_OUT;
        let mid = NaN;
        for (let o = hw + 2; o <= 2 * VERGE_OUT; o += 2) {
          const [px, pz] = at(o);
          const other = this.nearest(px, pz, 3.5, (j) => this.lapGap(i, j) > 1.5 * o + 12);
          if (other) {
            ext = Math.max(hw + SHOULDER + 1, (hw + o - DEFAULT_HALF_WIDTH) / 2);
            mid = (y + other.y) / 2 - 0.12;
            break;
          }
        }
        const inner = (dh > 0 && side === 1) || (dh < 0 && side === 0);
        if (inner) ext = Math.min(ext, Math.max(hw + SHOULDER + 1, 0.8 * radius));
        this.ext[side]![r] = ext;
        this.mid[side]![r] = mid;

        const [x4, z4] = at(hw + 4);
        const [x9, z9] = at(hw + 9);
        const lake = f.isWater(x4, z4) || (f.dem(x4, z4) < wl + 0.8 && f.isWater(x9, z9));
        let edge: number = EDGE.verge;
        if (lake) edge = EDGE.lake;
        else if (Number.isNaN(mid)) {
          const up = f.dem(x4, z4) - y;
          const [x7, z7] = at(hw + 7);
          const down = f.dem(x7, z7) - y;
          if (up > 3) {
            edge = EDGE.wall;
            this.wallH[side]![r] = Math.min(3.2, Math.max(1, up - 1.2));
          } else if (down < -3.5) edge = EDGE.rail;
        }
        this.edge[side]![r] = edge;
      }
    }
    for (const arr of this.edge) {
      for (const kind of [EDGE.lake, EDGE.wall, EDGE.rail]) {
        const mask = Uint8Array.from(arr, (v) => (v === kind ? 1 : 0));
        cleanRuns(mask, 4);
        for (let r = 0; r < rows; r++) {
          if (mask[r] && arr[r] === EDGE.verge) arr[r] = kind;
          else if (!mask[r] && arr[r] === kind) arr[r] = EDGE.verge;
        }
      }
    }
    for (let side = 0; side < 2; side++) {
      const h = this.wallH[side]!;
      const smooth = windowed(h, 3, (a, b) => a + b, 0);
      for (let r = 0; r < rows; r++) {
        if (this.edge[side]![r] === EDGE.wall) h[r] = Math.max(1, smooth[r]! / 7);
      }
    }
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Circular sliding-window reduction over ±half rows. */
function windowed(arr: Float32Array, half: number, op: (a: number, b: number) => number, init: number): Float32Array {
  const n = arr.length;
  const out = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let acc = init;
    for (let k = -half; k <= half; k++) acc = op(acc, arr[(r + k + n) % n]!);
    out[r] = acc;
  }
  return out;
}

/** Closes gaps shorter than `min` rows, then drops runs shorter than `min` rows (on a circular mask). */
export function cleanRuns(mask: Uint8Array, min: number): void {
  for (const value of [0, 1]) {
    const n = mask.length;
    const start = mask.findIndex((v) => v !== value);
    if (start < 0) continue;
    let r = 0;
    while (r < n) {
      const k = (start + r) % n;
      if (mask[k] === value) {
        let len = 0;
        while (len < n && mask[(k + len) % n] === value) len++;
        if (len < min) for (let q = 0; q < len; q++) mask[(k + q) % n] = 1 - value;
        r += len;
      } else r++;
    }
  }
}
