/**
 * Vertex positions of the route ribbon (asphalt levels and verge columns) per run of rows, without
 * Babylon: the ribbon builds its meshes from this, the tests check it for folds.
 */
import { Noise2D, smoothstep } from '../noise';
import { EDGE, ROW_STRIDE, SHOULDER, VERGE_BLEND, WALL_THICK, type Frame, type RouteCorridor } from './corridor';
import { untangle } from './roadGeometry';

export const VERGE_COLS = 12;
/** Strips per half of the asphalt (vertices per road row = 2 * ROAD_SPLITS + 3). */
const ROAD_SPLITS = 4;
export const ROAD_COLS = 2 * ROAD_SPLITS + 3;

export interface Row {
  /** Corridor row. */
  r: number;
  /** Running distance for texture coordinates. */
  d: number;
}

/** Stretches of rows to draw: everything except the second pass of out-and-back sections. */
export function drawnRuns(c: RouteCorridor): Row[][] {
  const R = c.rows;
  const cov = c.covered;
  const rowLen = ROW_STRIDE * c.track.step;
  const start = cov.indexOf(1);
  if (start < 0) {
    const all: Row[] = [];
    for (let k = 0; k <= R; k++) all.push({ r: k % R, d: k * rowLen });
    return [all];
  }
  const out: Row[][] = [];
  let k = 0;
  while (k < R) {
    const r = (start + k) % R;
    if (cov[r]) {
      k++;
      continue;
    }
    let len = 0;
    while (len < R && !cov[(r + len) % R]) len++;
    // one extra row at both ends closes the gap to the pass that is drawn instead
    const rows: Row[] = [];
    for (let q = -1; q <= len; q++) rows.push({ r: (r + q + R) % R, d: (start + k + q) * rowLen });
    out.push(rows);
    k += len;
  }
  return out;
}

/** Vertex positions of one lateral level along a run (one value per row). */
export class Level {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  constructor(n: number) {
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
  }

  /**
   * Removes the swallowtails of this offset curve; returns the rows that moved. A real swallowtail lies
   * within its offset of every centre point it collapses (a teardrop loop of the lap crossing itself does not).
   */
  untangle(frames: Frame[]): number[] {
    const off = (q: number) => Math.hypot(this.x[q]! - frames[q]!.x, this.z[q]! - frames[q]!.z);
    return untangle(this.x, this.z, this.y, 0, this.x.length, 40, (k, j, x, z) => {
      for (let q = k + 1; q <= j; q++) {
        if (Math.hypot(x - frames[q]!.x, z - frames[q]!.z) > off(q) * 1.15 + 0.5) return false;
      }
      return true;
    });
  }
}

/** Crown of the asphalt at t = −1 (left edge) … 1 (right edge). */
export const crown = (t: number) => 0.035 * (1 - t * t);

/** U coordinate of the asphalt levels: shoulder, ROAD_SPLITS strips per half, shoulder. */
export const ROAD_U = Array.from({ length: ROAD_COLS }, (_, q) => (q === 0 ? 0 : q === ROAD_COLS - 1 ? 1 : 0.5 + (q - 1 - ROAD_SPLITS) / ROAD_SPLITS * 0.44));

export interface RunGeometry {
  /** Asphalt levels, left shoulder to right shoulder. */
  road: Level[];
  /** Per side: verge columns from the shoulder (or wall foot) outwards, plus the skirt below the last. */
  verge: [Level[], Level[]];
  blend: [Float32Array[], Float32Array[]];
  rock: [Float32Array[], Float32Array[]];
  /** Per side: 1 where the shoulder edge was pulled into the corner of a bend tighter than the road is wide. */
  pinched: [Uint8Array, Uint8Array];
}

/**
 * Every vertex of a run of ribbon rows, before it is cut into chunks: each lateral level is an offset
 * curve of the centre line, and on the inside of a bend tighter than its offset that curve would loop
 * back over itself (the folded shoulder of a hairpin). Each level is untangled on its own, so the
 * inner edges run into a clean corner, and the asphalt of a later pass that runs onto an earlier
 * one (merged rows) is lifted onto it instead of cutting through.
 */
export function runGeometry(c: RouteCorridor, run: Row[], noise: Noise2D): RunGeometry {
  const field = c.field;
  const m = run.length;
  const frames = run.map((row) => c.frames[row.r]!);
  const road: Level[] = [];
  for (let q = 0; q < ROAD_COLS; q++) road.push(new Level(m));
  for (let k = 0; k < m; k++) {
    const f = frames[k]!;
    const r = run[k]!.r;
    const hl = c.hw[0][r]!;
    const hr = c.hw[1][r]!;
    // shoulder, ROAD_SPLITS strips per half of the asphalt, shoulder: in bends the quads turn into trapezoids,
    // and wide ones shear the lane markings along their diagonal; narrow strips keep the lines straight
    const put = (q: number, o: number, dy: number) => {
      road[q]!.x[k] = f.x + f.rx * o;
      road[q]!.y[k] = f.y + dy;
      road[q]!.z[k] = f.z + f.rz * o;
    };
    put(0, -(hl + SHOULDER), -0.05);
    for (let q = 0; q <= 2 * ROAD_SPLITS; q++) {
      const tt = q / ROAD_SPLITS - 1; // -1 left edge … 1 right edge
      // rounded crown, 3.5 cm at the centre line
      put(q + 1, tt < 0 ? tt * hl : tt * hr, crown(tt));
    }
    put(ROAD_COLS - 1, hr + SHOULDER, -0.05);
  }
  const pinched: [Uint8Array, Uint8Array] = [new Uint8Array(m), new Uint8Array(m)];
  for (let q = 0; q < ROAD_COLS; q++) {
    const moved = road[q]!.untangle(frames);
    if (q === 0 || q === ROAD_COLS - 1) for (const k of moved) pinched[q === 0 ? 0 : 1][k] = 1;
  }
  // merged rows lie on top of the earlier pass they run onto
  for (let k = 0; k < m; k++) {
    const r = run[k]!.r;
    if (!c.merged[r]) continue;
    const i = c.sampleOf(r);
    for (let q = 0; q < ROAD_COLS; q++) {
      const lv = road[q]!;
      const hit = c.nearest(lv.x[k]!, lv.z[k]!, 8, (j) => c.lapGap(i, j) > 30 && !c.covered[Math.round(j / ROW_STRIDE) % c.rows]);
      if (!hit) continue;
      const hw = c.hw[hit.offset >= 0 ? 1 : 0]![hit.row]!;
      const o = Math.abs(hit.offset);
      if (o > hw + SHOULDER) continue;
      const below = o <= hw ? hit.y + crown(o / hw) : hit.y - 0.05;
      lv.y[k] = Math.max(lv.y[k]!, below + 0.03);
    }
  }

  const cols = VERGE_COLS + 2;
  const verge: [Level[], Level[]] = [[], []];
  const blend: [Float32Array[], Float32Array[]] = [[], []];
  const rock: [Float32Array[], Float32Array[]] = [[], []];
  for (let side = 0; side < 2; side++) {
    const sg = side === 0 ? -1 : 1;
    for (let q = 0; q < cols; q++) {
      verge[side]!.push(new Level(m));
      blend[side]!.push(new Float32Array(m));
      rock[side]!.push(new Float32Array(m));
    }
    for (let k = 0; k < m; k++) {
      const f = frames[k]!;
      const r = run[k]!.r;
      const hw = c.hw[side]![r]!;
      const edge0 = c.edge[side]![r]!;
      const edge = edge0 === EDGE.lake ? EDGE.verge : edge0;
      const o0 = hw + SHOULDER + (edge === EDGE.wall ? WALL_THICK : 0);
      const ext = Math.max(o0 + 1, c.ext[side]![r]!);
      const mid = c.mid[side]![r]!;
      let prevO = 0;
      let prevY = 0;
      for (let q = 0; q <= VERGE_COLS; q++) {
        const o = o0 + (ext - o0) * Math.pow(q / VERGE_COLS, 1.4);
        let x = f.x + sg * f.rx * o;
        let z = f.z + sg * f.rz * o;
        const sink = 0.15 * smoothstep(o0 + 2, ext, o);
        const y = c.profile(r, side, o, field.dem(x, z), f.y, edge) - sink;
        const w = Number.isNaN(mid) ? smoothstep(o0 + 1, o0 + VERGE_BLEND, o) : 0;
        // cut weight: a few metres into a cutting, fading out where the verge blends into the terrain
        const cut = edge0 === EDGE.verge
          ? smoothstep(1.2, 3.5, y - f.y) * smoothstep(o0 + 2.5, o0 + 4, o) * (1 - smoothstep(o0 + 0.6 * VERGE_BLEND, o0 + VERGE_BLEND, o))
          : 0;
        const slope = q === 0 ? 0 : (y - prevY) / (o - prevO);
        prevO = o;
        prevY = y;
        // rough cut face: push the point sideways (layered by height, so the bands run horizontally)
        const d = cut * 0.45 * noise.fbm((x + z) * 0.12, y * 0.7, 3);
        x += sg * f.rx * d;
        z += sg * f.rz * d;
        const lv = verge[side]![q]!;
        lv.x[k] = x;
        lv.y[k] = y;
        lv.z[k] = z;
        blend[side]![q]![k] = w;
        rock[side]![q]![k] = cut * smoothstep(0.35, 0.8, slope);
      }
    }
    // the verge starts where the asphalt's shoulder ends (also where that was pulled into a corner)
    const edgeLv = road[side === 0 ? 0 : ROAD_COLS - 1]!;
    for (let k = 0; k < m; k++) {
      if (!pinched[side]![k] || c.edge[side]![run[k]!.r] === EDGE.wall) continue;
      verge[side]![0]!.x[k] = edgeLv.x[k]!;
      verge[side]![0]!.z[k] = edgeLv.z[k]!;
    }
    for (let q = 0; q <= VERGE_COLS; q++) {
      const moved = verge[side]![q]!.untangle(frames);
      // a pulled-in column of the verge blends like the terrain it meets
      for (const k of moved) blend[side]![q]![k] = Math.max(blend[side]![q]![k]!, blend[side]![VERGE_COLS]![k]!);
    }
    // skirt: straight below the last column, hides the seam to the terrain mesh
    const last = verge[side]![VERGE_COLS]!;
    const skirt = verge[side]![VERGE_COLS + 1]!;
    for (let k = 0; k < m; k++) {
      skirt.x[k] = last.x[k]!;
      skirt.y[k] = last.y[k]! - 3;
      skirt.z[k] = last.z[k]!;
    }
  }
  return { road, verge, blend, rock, pinched };
}
