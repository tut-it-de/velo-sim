import type { Track } from '@velo/routes';
import { smoothstep } from '../noise';
import { routeDistanceField } from './ground';
import { cellKey, type BuildingIndex, type HeightField } from './heightField';
import { LAND_CLASS, type Roundabout } from './worldData';

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
export const EDGE = { verge: 0, lake: 1, wall: 2, rail: 3, parapet: 4 } as const;
/** Every 2nd track sample (4 m) is a ribbon row. */
export const ROW_STRIDE = 2;
/** Samples (2 m) on each side over which the cross direction of a ribbon row is averaged. */
const FRAME_SMOOTH = 4;
/** Below this radius (m) the centre line is left out (the lanes are no longer meaningful in a hairpin). */
export const TIGHT_RADIUS = 14;
/** Another pass of the lap farther along than this (m) that overlaps the asphalt is a merge, not a fold. */
const MERGE_GAP = 60;
/** Passes in opposite directions closer than this (m) are the two lanes of one road. */
const SHARED_DIST = 2.2;
/**
 * One-way carriageways of an out-and-back road (split around a traffic island before a roundabout):
 * the other direction's carriageway is at most this far (m) and the split starts on a shared stretch.
 */
const TWIN_REACH = 14;

/** Centre point and cross direction (right of travel) of a ribbon row. */
export interface Frame {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
}

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
 * needs a retaining wall, a stone parapet or a guardrail, how far each verge may reach (hairpins, tight bends,
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
  /** Rows whose asphalt overlaps an earlier, drawn pass (summit loops, roundabouts, double-passed junctions). */
  readonly merged: Uint8Array;
  /**
   * Rows on a one-way carriageway next to the other direction's (split out-and-back road): 1 while the two
   * still form one two-way road (drawn once, on their middle line), 2 where they run apart (one lane each).
   */
  readonly twin: Uint8Array;
  /** Index + 1 of the roundabout whose ring this row runs on (0 = none). */
  readonly ring: Uint8Array;
  /** Rows in bends tighter than TIGHT_RADIUS. */
  readonly tight: Uint8Array;
  /** Signed turn radius of the ribbon frames per row (> 0 turns right, Infinity = straight). */
  readonly radius: Float32Array;
  readonly frames: Frame[];
  private readonly cell = 16;
  private readonly cells = new Map<number, number[]>();

  constructor(
    readonly track: Track,
    readonly field: HeightField,
    buildings: BuildingIndex,
    readonly roundabouts: Roundabout[] = [],
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
    this.merged = new Uint8Array(rows);
    this.twin = new Uint8Array(rows);
    this.ring = new Uint8Array(rows);
    this.tight = new Uint8Array(rows);
    this.radius = new Float32Array(rows);
    this.frames = [];
    for (let r = 0; r < rows; r++) this.frames.push(this.computeFrame(r));
    this.analyze(buildings);
  }

  /** Length of one ribbon row, m. */
  get rowLength(): number {
    return ROW_STRIDE * this.track.step;
  }

  private computeFrame(r: number): Frame {
    const t = this.track;
    const n = t.count;
    const i = this.sampleOf(r);
    // Cross direction from the heading averaged over ±FRAME_SMOOTH samples (tent weights): on a constant bend it
    // equals the local heading, but where the map line kinks the cross sections fan out over a few metres
    // instead of folding the inner edge over itself (what is left of that, roadGeometry.untangle removes).
    let sx = 0;
    let sz = 0;
    for (let k = -FRAME_SMOOTH; k <= FRAME_SMOOTH; k++) {
      const h = t.headings[(((i + k) % n) + n) % n]!;
      const wgt = FRAME_SMOOTH + 1 - Math.abs(k);
      sx += Math.sin(h) * wgt;
      sz += Math.cos(h) * wgt;
    }
    const h = Math.atan2(sx, sz);
    return { x: t.xs[i]!, y: t.ys[i]!, z: t.zs[i]!, rx: Math.cos(h), rz: -Math.sin(h) };
  }

  /**
   * World position at lap distance `s` (m, any lap) and signed lateral offset `o` (right of travel),
   * interpolated between ribbon rows exactly as the ribbon's quads are: on the drawn asphalt.
   */
  pointAt(s: number, o: number): { x: number; y: number; z: number } {
    const R = this.rows;
    const u = s / this.rowLength;
    const k = Math.floor(u);
    const w = u - k;
    const a = this.frames[((k % R) + R) % R]!;
    const b = this.frames[(((k + 1) % R) + R) % R]!;
    return {
      x: a.x + a.rx * o + (b.x + b.rx * o - a.x - a.rx * o) * w,
      y: a.y + (b.y - a.y) * w,
      z: a.z + a.rz * o + (b.z + b.rz * o - a.z - a.rz * o) * w,
    };
  }

  /** Lap distance (m) of the foot point of (x, z) near sample `i`, and its signed lateral offset. */
  lapCoords(x: number, z: number, i: number): { s: number; o: number } {
    const t = this.track;
    const h = t.headings[i]!;
    const vx = x - t.xs[i]!;
    const vz = z - t.zs[i]!;
    return { s: i * t.step + vx * Math.sin(h) + vz * Math.cos(h), o: vx * Math.cos(h) - vz * Math.sin(h) };
  }

  /**
   * Inverse of `pointAt` near lap distance `s`: the (s, o) that `pointAt` maps onto (x, z), so points
   * placed in lap coordinates land exactly where they were taken from.
   */
  lapCoordsAt(x: number, z: number, s: number, o = 0): { s: number; o: number } {
    for (let it = 0; it < 8; it++) {
      const p = this.pointAt(s, o);
      const a = this.pointAt(s - 0.5, o);
      const b = this.pointAt(s + 0.5, o);
      const fx = b.x - a.x;
      const fz = b.z - a.z;
      const f2 = fx * fx + fz * fz;
      if (f2 < 1e-6) break;
      // lateral direction of the interpolated rows: unit vector across the strip at s
      const r0 = this.pointAt(s, o + 1);
      const rx = r0.x - p.x;
      const rz = r0.z - p.z;
      const dx = x - p.x;
      const dz = z - p.z;
      // solve d = ds·f + do·r (2×2)
      const det = fx * rz - fz * rx;
      if (Math.abs(det) < 1e-9) break;
      const ds = (dx * rz - dz * rx) / det;
      const dov = (fx * dz - fz * dx) / det;
      s += Math.max(-20, Math.min(20, ds));
      o += Math.max(-20, Math.min(20, dov));
      if (Math.abs(ds) + Math.abs(dov) < 1e-4) break;
    }
    return { s, o };
  }

  /** No wall, guardrail or parapet on one side of rows r0…r1 (a side road joins there). */
  openEdge(side: number, r0: number, r1: number): void {
    const R = this.rows;
    for (let r = r0; r <= r1; r++) {
      const k = ((r % R) + R) % R;
      if (this.edge[side]![k] !== EDGE.lake) this.edge[side]![k] = EDGE.verge;
    }
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

  /** Distance to the lap for every near-grid vertex (same layout as the near raster). */
  routeDistanceGrid(): Float32Array {
    return routeDistanceField(this.field.near, this.track).dist;
  }

  /** Distance (m) outside the nearest roundabout carriageway (negative on it); Infinity with none within 40 m. */
  ringGap(x: number, z: number): number {
    let best = Infinity;
    for (const rb of this.roundabouts) {
      const d = Math.hypot(x - rb.x, z - rb.z);
      if (d > rb.r + rb.hw + 40) continue;
      best = Math.min(best, Math.abs(d - rb.r) - rb.hw);
    }
    return best;
  }

  /** Distance to the lap from the nearest near-grid vertex (Infinity outside the near raster). */
  routeDistance(x: number, z: number): number {
    const g = this.field.near;
    const i = Math.round((x - g.x0) / g.step);
    const j = Math.round((z - g.z0) / g.step);
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return Infinity;
    return this.routeDistanceGrid()[j * g.nx + i]!;
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
    this.findPasses();
    // rows whose asphalt runs onto an earlier pass where the two diverge: drawn on top without markings
    for (let r = 0; r < rows; r++) {
      if (this.covered[r] || this.twin[r]) continue;
      const i = this.sampleOf(r);
      const reach = this.hw[0]![r]! + this.hw[1]![r]! + 2 * SHOULDER;
      const hit = this.nearest(t.xs[i]!, t.zs[i]!, reach, (j) => this.lapGap(i, j) > MERGE_GAP && j < i && !this.covered[Math.round(j / ROW_STRIDE) % rows]);
      if (hit && Math.abs(t.ys[i]! - hit.y) < 1.5) this.merged[r] = 1;
    }
    // rows on a roundabout's ring: the ring is drawn on its own (roundabouts.ts), the ribbon below it plain
    this.roundabouts.forEach((rb, k) => {
      for (let r = 0; r < rows; r++) {
        const f = this.frames[r]!;
        if (Math.abs(Math.hypot(f.x - rb.x, f.z - rb.z) - rb.r) < 0.8 * rb.hw) {
          this.ring[r] = k + 1;
          this.merged[r] = 0;
        }
      }
    });
    // turn radius of the frames over ±2 rows
    for (let r = 0; r < rows; r++) {
      const a = this.frames[(r - 2 + rows) % rows]!;
      const b = this.frames[(r + 2) % rows]!;
      const dh = wrapAngle(Math.atan2(-b.rz, b.rx) - Math.atan2(-a.rz, a.rx));
      this.radius[r] = Math.abs(dh) < 1e-4 ? Infinity : (4 * this.rowLength) / dh;
      if (Math.abs(this.radius[r]!) < TIGHT_RADIUS) this.tight[r] = 1;
    }
    cleanRuns(this.tight, 3);

    // 4) edges and verge extents
    // The elevation model is a surface model (trees, roofs), so the road profile deliberately sits
    // below it. Walls are therefore judged by how the ground rises across the road (relative to the
    // model at the centre line), not by the absolute difference to the road.
    const rise: SideArrays<Float32Array> = [new Float32Array(rows), new Float32Array(rows)];
    for (let r = 0; r < rows; r++) {
      const i = this.sampleOf(r);
      const x = t.xs[i]!;
      const z = t.zs[i]!;
      const y = t.ys[i]!;
      const rx = Math.cos(t.headings[i]!);
      const rz = -Math.sin(t.headings[i]!);
      const demC = f.dem(x, z);
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
          const d4 = f.dem(x4, z4);
          const up = d4 - y;
          rise[side]![r] = d4 - demC;
          const [x7, z7] = at(hw + 7);
          const down = f.dem(x7, z7) - y;
          // villages are terraced with stone walls; in the open a grassy cut is fine up to ~4 m
          const town = this.urban[r] === 1;
          if (town ? up > 2.2 : up > 4 && d4 - demC > 1.5) {
            edge = EDGE.wall;
            this.wallH[side]![r] = Math.min(3.2, Math.max(town ? 1.6 : 1.2, up - (town ? 1 : 2)));
          } else if (down < (town ? -2.5 : -3.5)) {
            // villages and the lakeside get stone parapets, mountain roads steel guardrails
            let lakeside = false;
            for (let o = 12; o <= 240 && !lakeside; o += 12) {
              const [px, pz] = at(hw + o);
              lakeside = f.classAt(px, pz) === LAND_CLASS.water;
            }
            edge = lakeside || this.urban[r] ? EDGE.parapet : EDGE.rail;
          }
        }
        this.edge[side]![r] = edge;
      }
      // out of town, a cutting with walls on both sides only where the ground clearly rises on both sides
      const bothWalls = this.edge[0]![r] === EDGE.wall && this.edge[1]![r] === EDGE.wall;
      if (bothWalls && !this.urban[r] && Math.min(rise[0]![r]!, rise[1]![r]!) < 3) {
        this.edge[rise[0]![r]! < rise[1]![r]! ? 0 : 1]![r] = EDGE.verge;
      }
    }
    for (const arr of this.edge) {
      for (const kind of [EDGE.lake, EDGE.wall, EDGE.rail, EDGE.parapet]) {
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
    // the inside of a ring is the roundabout's island: a flat verge under it, no walls or rails
    for (let r = 0; r < rows; r++) {
      const k = this.ring[r]!;
      if (!k) continue;
      const rb = this.roundabouts[k - 1]!;
      const f = this.frames[r]!;
      const inner = (rb.x - f.x) * f.rx + (rb.z - f.z) * f.rz > 0 ? 1 : 0;
      this.edge[inner]![r] = EDGE.verge;
      this.ext[inner]![r] = this.hw[inner]![r]! + SHOULDER + 1;
      this.mid[inner]![r] = f.y - 0.3;
    }
  }

  /**
   * Other passes of the same road: rows that repeat an earlier pass (out-and-back, either direction) are
   * covered, and one-way carriageways split around a traffic island (twin) are drawn as one two-way road
   * while they run side by side, as one lane each where they part.
   */
  private findPasses(): void {
    const t = this.track;
    const rows = this.rows;
    const opposite = (i: number, j: number) => Math.cos(t.headings[i]! - t.headings[j]!) < -0.5;
    const dist = new Float32Array(rows).fill(Infinity);
    const partner = new Int32Array(rows).fill(-1);
    const side = new Int8Array(rows);
    const cos = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      const i = this.sampleOf(r);
      const x = t.xs[i]!;
      const z = t.zs[i]!;
      // same road ridden again in the same direction far along the lap (Lake Como's junction)
      const same = this.nearest(x, z, SHARED_DIST, (j) => this.lapGap(i, j) > 150);
      if (same && same.i < i) this.covered[r] = 1;
      // the other direction: anywhere but the next metres of a hairpin
      const opp = this.nearest(x, z, TWIN_REACH, (j) => this.lapGap(i, j) > 40 && opposite(i, j));
      if (!opp) continue;
      const f = this.frames[r]!;
      const o = (t.xs[opp.i]! - x) * f.rx + (t.zs[opp.i]! - z) * f.rz;
      dist[r] = Math.abs(opp.offset);
      partner[r] = opp.i;
      cos[r] = Math.cos(t.headings[i]! - t.headings[opp.i]!);
      side[r] = o < 0 ? -1 : 1;
      if (dist[r]! < SHARED_DIST && opp.i < i) this.covered[r] = 1;
    }
    // twin rows: runs of rows near the other direction, nearly parallel to it, that start or end on a shared
    // stretch (hairpin legs and other roads close by never touch one, streets parting at a junction are not parallel)
    const cand = (r: number) => dist[r]! >= SHARED_DIST && dist[r]! <= TWIN_REACH && cos[r]! < -0.8;
    const shared = (r: number) => dist[(r + rows) % rows]! < SHARED_DIST;
    for (let r = 0; r < rows; r++) {
      if (!cand(r) || cand((r - 1 + rows) % rows)) continue;
      let len = 0;
      while (len < rows && cand((r + len) % rows)) len++;
      if (!shared(r - 1) && !shared(r + len)) continue;
      for (let q = 0; q < len; q++) this.twin[(r + q) % rows] = 1;
    }
    for (let r = 0; r < rows; r++) {
      if (!this.twin[r]) continue;
      // both carriageways must be twins of each other
      const pr = Math.round(partner[r]! / ROW_STRIDE) % rows;
      if (!this.twin[pr] && !this.twin[(pr + 1) % rows] && !this.twin[(pr - 1 + rows) % rows]) {
        this.twin[r] = 0;
        continue;
      }
      const w = this.hw[0]![r]! + this.hw[1]![r]!;
      const d = dist[r]!;
      if (d < w / 2) {
        // still one road: drawn once on the middle line between the carriageways, by the earlier pass
        const f = this.frames[r]!;
        f.x += f.rx * side[r]! * d / 2;
        f.z += f.rz * side[r]! * d / 2;
        if (partner[r]! < this.sampleOf(r)) this.covered[r] = 1;
      } else {
        // apart: one lane each, the island between them
        this.twin[r] = 2;
        this.hw[0]![r] = w / 4;
        this.hw[1]![r] = w / 4;
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
