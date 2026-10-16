import type { RouteDefinition, RoutePath, RouteSegment } from './types';

export interface TrackSample {
  /** Distance along the lap in metres, wrapped into [0, length). */
  distanceM: number;
  x: number;
  y: number;
  z: number;
  /** Yaw in radians, 0 = facing +z, measured towards +x (Babylon's left-handed system). */
  heading: number;
  gradePercent: number;
  /** Unit vector pointing to the rider's right on the road plane. */
  rightX: number;
  rightZ: number;
}

const STEP = 2; // metres between samples

/**
 * A closed loop sampled every 2 m. Parametric routes: horizontal path from a
 * periodic Catmull-Rom spline (rescaled to the exact target length), elevation
 * from linear keyframes. Real-world routes: the given polyline as is. Either
 * way the elevation is smoothed with a circular moving average.
 */
export class Track {
  readonly definition: RouteDefinition;
  readonly length: number;
  readonly step = STEP;
  readonly count: number;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly zs: Float64Array;
  readonly grades: Float64Array;
  readonly headings: Float64Array;
  readonly elevationGain: number;
  readonly minElevation: number;
  readonly maxElevation: number;
  readonly maxGrade: number;
  readonly minGrade: number;
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  constructor(def: RouteDefinition) {
    this.definition = def;
    let raw: Float64Array;
    if (def.path) {
      const { pts, elev } = polylineFromPath(def.path);
      this.count = Math.round(polylineLength(pts, true) / STEP);
      this.length = this.count * STEP;
      const res = resampleClosed(pts, this.count, this.length, elev);
      this.xs = res.xs;
      this.zs = res.zs;
      raw = res.ys!;
    } else {
      if (!def.shape || !def.elevation) throw new Error(`Strecke ${def.id}: Form oder Höhenprofil fehlt`);
      const dense = sampleClosedCatmullRom(def.shape, 64);
      const rawLength = polylineLength(dense, true);
      const scale = def.lengthM / rawLength;
      const scaled = dense.map(([x, z]) => [x * scale, z * scale] as [number, number]);
      this.count = Math.round(def.lengthM / STEP);
      this.length = this.count * STEP;
      const res = resampleClosed(scaled, this.count, this.length);
      this.xs = res.xs;
      this.zs = res.zs;
      // Elevation: keyframes → per-sample.
      const keys = def.elevation;
      raw = new Float64Array(this.count);
      for (let i = 0; i < this.count; i++) raw[i] = interpolateKeyframes(keys, (i * STEP * def.lengthM) / this.length, def.lengthM);
    }
    const xs = this.xs;
    const zs = this.zs;
    const smoothing = def.smoothingM ?? (def.path ? 8 : 120);
    this.ys = circularMovingAverage(raw, Math.max(1, Math.round(smoothing / STEP / 2)));

    this.grades = new Float64Array(this.count);
    this.headings = new Float64Array(this.count);
    const k = 5; // ±10 m window for grade
    let gain = 0;
    let minE = Infinity;
    let maxE = -Infinity;
    let maxG = -Infinity;
    let minG = Infinity;
    for (let i = 0; i < this.count; i++) {
      const a = (i - k + this.count) % this.count;
      const b = (i + k) % this.count;
      const g = ((this.ys[b]! - this.ys[a]!) / (2 * k * STEP)) * 100;
      this.grades[i] = g;
      const n = (i + 1) % this.count;
      const p = (i - 1 + this.count) % this.count;
      this.headings[i] = Math.atan2(this.xs[n]! - this.xs[p]!, this.zs[n]! - this.zs[p]!);
      const dy = this.ys[n]! - this.ys[i]!;
      if (dy > 0) gain += dy;
      minE = Math.min(minE, this.ys[i]!);
      maxE = Math.max(maxE, this.ys[i]!);
      maxG = Math.max(maxG, g);
      minG = Math.min(minG, g);
    }
    this.elevationGain = gain;
    this.minElevation = minE;
    this.maxElevation = maxE;
    this.maxGrade = maxG;
    this.minGrade = minG;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      minX = Math.min(minX, xs[i]!);
      maxX = Math.max(maxX, xs[i]!);
      minZ = Math.min(minZ, zs[i]!);
      maxZ = Math.max(maxZ, zs[i]!);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  get id(): string {
    return this.definition.id;
  }

  get name(): string {
    return this.definition.name;
  }

  get segments(): RouteSegment[] {
    return this.definition.segments;
  }

  wrap(distanceM: number): number {
    return ((distanceM % this.length) + this.length) % this.length;
  }

  /** Interpolated position, heading and grade at any distance (wraps around laps). */
  sample(distanceM: number): TrackSample {
    const d = this.wrap(distanceM);
    const f = d / STEP;
    const i = Math.floor(f) % this.count;
    const j = (i + 1) % this.count;
    const t = f - Math.floor(f);
    const x = lerp(this.xs[i]!, this.xs[j]!, t);
    const y = lerp(this.ys[i]!, this.ys[j]!, t);
    const z = lerp(this.zs[i]!, this.zs[j]!, t);
    const heading = lerpAngle(this.headings[i]!, this.headings[j]!, t);
    const gradePercent = lerp(this.grades[i]!, this.grades[j]!, t);
    return { distanceM: d, x, y, z, heading, gradePercent, rightX: Math.cos(heading), rightZ: -Math.sin(heading) };
  }

  /** World position offset sideways from the centre line (positive = right). */
  positionAt(distanceM: number, lateralM = 0): { x: number; y: number; z: number; heading: number; gradePercent: number } {
    const s = this.sample(distanceM);
    return { x: s.x + s.rightX * lateralM, y: s.y, z: s.z + s.rightZ * lateralM, heading: s.heading, gradePercent: s.gradePercent };
  }

  /** Down-sampled elevation profile for charts: `points` pairs of [distance, elevation]. */
  profile(points = 400): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let p = 0; p <= points; p++) {
      const d = (p / points) * this.length;
      out.push([d, this.sample(d === this.length ? 0 : d).y]);
    }
    return out;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}

/** Uniform periodic Catmull-Rom through all points, `perSegment` samples per segment. */
export function sampleClosedCatmullRom(points: Array<[number, number]>, perSegment: number): Array<[number, number]> {
  const n = points.length;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % n]!;
    const p3 = points[(i + 2) % n]!;
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (a: number, b: number, c2: number, d: number) =>
        0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

function polylineLength(pts: Array<[number, number]>, closed: boolean): number {
  let len = 0;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return len;
}

/** Decodes a real-world path into points + elevations (duplicate closing point removed). */
function polylineFromPath(path: RoutePath): { pts: Array<[number, number]>; elev: number[] } {
  const pts: Array<[number, number]> = [];
  const elev: number[] = [];
  for (let i = 0; i < path.x.length; i++) {
    pts.push([path.x[i]!, path.z[i]!]);
    elev.push(path.y[i]!);
  }
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (pts.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) {
    pts.pop();
    elev.pop();
  }
  return { pts, elev };
}

function resampleClosed(
  pts: Array<[number, number]>,
  count: number,
  length: number,
  values?: number[],
): { xs: Float64Array; zs: Float64Array; ys?: Float64Array } {
  const n = pts.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    cum[i + 1] = cum[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = cum[n]!;
  const xs = new Float64Array(count);
  const zs = new Float64Array(count);
  const ys = values ? new Float64Array(count) : undefined;
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (seg < n - 1 && cum[seg + 1]! < target) seg++;
    const a = pts[seg]!;
    const b = pts[(seg + 1) % n]!;
    const segLen = cum[seg + 1]! - cum[seg]!;
    const t = segLen > 0 ? (target - cum[seg]!) / segLen : 0;
    xs[k] = lerp(a[0], b[0], t);
    zs[k] = lerp(a[1], b[1], t);
    if (ys && values) ys[k] = lerp(values[seg]!, values[(seg + 1) % n]!, t);
  }
  void length;
  return { xs, zs, ys };
}

function interpolateKeyframes(keys: Array<[number, number]>, d: number, lengthM: number): number {
  // keys sorted by distance, first at 0; the loop closes back to keys[0] at lengthM.
  for (let i = 0; i < keys.length; i++) {
    const [d0, e0] = keys[i]!;
    const [d1, e1] = i + 1 < keys.length ? keys[i + 1]! : [lengthM, keys[0]![1]];
    if (d >= d0 && d <= d1) return d1 === d0 ? e0 : e0 + ((e1 - e0) * (d - d0)) / (d1 - d0);
  }
  return keys[0]![1];
}

function circularMovingAverage(values: Float64Array, halfWindow: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const w = 2 * halfWindow + 1;
  let sum = 0;
  for (let k = -halfWindow; k <= halfWindow; k++) sum += values[(k + n) % n]!;
  for (let i = 0; i < n; i++) {
    out[i] = sum / w;
    sum += values[(i + halfWindow + 1) % n]! - values[(i - halfWindow + n) % n]!;
  }
  return out;
}
