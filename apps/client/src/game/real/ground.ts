import type { Track } from '@velo/routes';
import { smoothstep } from '../noise';
import { triSample } from './heightField';
import { LAND_CLASS, type WorldData, type WorldGrid } from './worldData';

/** Distance to the lap per near-grid vertex and the track sample that distance was measured to. */
export interface RouteDistanceField {
  dist: Float32Array;
  seed: Int32Array;
}

const fields = new WeakMap<Track, Map<WorldGrid, RouteDistanceField>>();

/**
 * Distance to the lap for every vertex of a raster, built by propagating the nearest route sample
 * through the grid (two-pass vector distance transform) — accurate to well under a metre and far
 * cheaper than a radius search per vertex. Cached per track and grid.
 */
export function routeDistanceField(g: WorldGrid, t: Track): RouteDistanceField {
  let perGrid = fields.get(t);
  if (!perGrid) fields.set(t, (perGrid = new Map()));
  const cached = perGrid.get(g);
  if (cached) return cached;
  const { nx, nz, step, x0, z0 } = g;
  const seed = new Int32Array(nx * nz).fill(-1);
  const dist = new Float32Array(nx * nz).fill(Infinity);
  const d2 = (k: number, s: number) => {
    const ex = x0 + (k % nx) * step - t.xs[s]!;
    const ez = z0 + Math.floor(k / nx) * step - t.zs[s]!;
    return ex * ex + ez * ez;
  };
  for (let s = 0; s < t.count; s++) {
    const i = Math.round((t.xs[s]! - x0) / step);
    const j = Math.round((t.zs[s]! - z0) / step);
    if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
    const k = j * nx + i;
    const v = d2(k, s);
    if (v < dist[k]!) {
      dist[k] = v;
      seed[k] = s;
    }
  }
  const relax = (k: number, n: number) => {
    const s = seed[n]!;
    if (s < 0) return;
    const v = d2(k, s);
    if (v < dist[k]!) {
      dist[k] = v;
      seed[k] = s;
    }
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i > 0) relax(k, k - 1);
      if (j > 0) {
        relax(k, k - nx);
        if (i > 0) relax(k, k - nx - 1);
        if (i < nx - 1) relax(k, k - nx + 1);
      }
    }
    for (let i = nx - 2; i >= 0; i--) relax(j * nx + i, j * nx + i + 1);
  }
  for (let j = nz - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      if (i < nx - 1) relax(k, k + 1);
      if (j < nz - 1) {
        relax(k, k + nx);
        if (i < nx - 1) relax(k, k + nx + 1);
        if (i > 0) relax(k, k + nx - 1);
      }
    }
    for (let i = 1; i < nx; i++) relax(j * nx + i, j * nx + i - 1);
  }
  for (let k = 0; k < dist.length; k++) dist[k] = Math.sqrt(dist[k]!);
  const field = { dist, seed };
  perGrid.set(g, field);
  return field;
}

/** Built-up cells: roofs are removed with a morphological opening over this many cells (±24 m). */
const OPEN_RADIUS = 2;
/** The road's own surface-model offset is removed fully within FIT_IN of the lap, fading out by FIT_OUT. */
const FIT_IN = 30;
const FIT_OUT = 140;
const MAX_OFFSET = 10;

const applied = new WeakMap<WorldData, { track: string; original: Float32Array }>();

/**
 * The elevation model is a surface model: roofs and tree crowns sit on top of the ground, while
 * the route's elevation profile follows the road itself. Left alone, the ground stands metres above
 * the road (walls on both sides, mounds between houses, houses standing on their neighbours' roofs).
 * This turns the near raster into a ground model once per world and track:
 *  1. built-up cells lose roofs through a morphological opening (keeps slopes and valleys, removes
 *     bumps narrower than ~60 m),
 *  2. near the lap the remaining offset between model and road is subtracted, fading out over
 *     ~100 m, so cross-slopes stay natural.
 * Land never drops under the shore line the lake was carved with.
 */
export function fitGroundModel(data: WorldData, track: Track): void {
  const g = data.near;
  const done = applied.get(data);
  if (done?.track === track.definition.id) return;
  if (done) g.heights.set(done.original);
  const original = Float32Array.from(g.heights);
  applied.set(data, { track: track.definition.id, original });

  const { nx, nz } = g;
  const h = g.heights;
  const cls = g.classes;
  const wl = data.waterLevel;
  const water = LAND_CLASS.water;

  // 1) opening (erosion, then dilation) with a square window; water cells take no part
  const built = new Float32Array(nx * nz);
  for (let k = 0; k < built.length; k++) built[k] = cls[k] === LAND_CLASS.urban || cls[k] === LAND_CLASS.garden ? 1 : 0;
  const weight = boxFilter(boxFilter(built, nx, nz, 1, true, 'avg'), nx, nz, 1, false, 'avg');
  const src = Float32Array.from(h, (v, k) => (cls[k] === water ? Infinity : v));
  const eroded = boxFilter(boxFilter(src, nx, nz, OPEN_RADIUS, true, 'min'), nx, nz, OPEN_RADIUS, false, 'min');
  for (let k = 0; k < eroded.length; k++) if (eroded[k] === Infinity) eroded[k] = -Infinity;
  const opened = boxFilter(boxFilter(eroded, nx, nz, OPEN_RADIUS, true, 'max'), nx, nz, OPEN_RADIUS, false, 'max');
  for (let k = 0; k < h.length; k++) {
    const w = weight[k]!;
    if (w <= 0 || cls[k] === water || !Number.isFinite(opened[k]!)) continue;
    h[k] = h[k]! - w * Math.max(0, h[k]! - opened[k]!);
  }

  // 2) the road's own offset, smoothed along the lap
  const n = track.count;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const fx = (track.xs[i]! - g.x0) / g.step;
    const fz = (track.zs[i]! - g.z0) / g.step;
    const inside = fx >= 0 && fz >= 0 && fx < nx - 1 && fz < nz - 1;
    raw[i] = inside ? Math.min(MAX_OFFSET, Math.max(0, triSample(h, nx, fx, fz) - track.ys[i]!)) : 0;
  }
  const half = 12;
  const offset = new Float32Array(n);
  let acc = 0;
  for (let k = -half; k <= half; k++) acc += raw[(k + n) % n]!;
  for (let i = 0; i < n; i++) {
    offset[i] = acc / (2 * half + 1);
    acc += raw[(i + half + 1) % n]! - raw[(i - half + n) % n]!;
  }
  const { dist, seed } = routeDistanceField(g, track);
  for (let k = 0; k < h.length; k++) {
    const d = dist[k]!;
    if (d >= FIT_OUT || seed[k]! < 0 || cls[k] === water) continue;
    const lowered = h[k]! - offset[seed[k]!]! * (1 - smoothstep(FIT_IN, FIT_OUT, d));
    h[k] = original[k]! < wl + 0.6 ? lowered : Math.max(wl + 0.6, lowered);
  }
}

/** Separable sliding-window min / max / mean along rows (`alongX`) or columns. */
function boxFilter(src: Float32Array, nx: number, nz: number, r: number, alongX: boolean, op: 'min' | 'max' | 'avg'): Float32Array {
  const out = new Float32Array(src.length);
  const len = alongX ? nx : nz;
  const lines = alongX ? nz : nx;
  const at = (line: number, p: number) => (alongX ? line * nx + p : p * nx + line);
  for (let line = 0; line < lines; line++) {
    for (let p = 0; p < len; p++) {
      let v = op === 'min' ? Infinity : op === 'max' ? -Infinity : 0;
      let count = 0;
      for (let q = Math.max(0, p - r); q <= Math.min(len - 1, p + r); q++) {
        const s = src[at(line, q)]!;
        if (op === 'min') v = Math.min(v, s);
        else if (op === 'max') v = Math.max(v, s);
        else v += s;
        count++;
      }
      out[at(line, p)] = op === 'avg' ? v / count : v;
    }
  }
  return out;
}
