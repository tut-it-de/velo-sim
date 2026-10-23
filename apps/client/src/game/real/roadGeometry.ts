/**
 * Plain 2D geometry for roads (no Babylon): offset curves without swallowtails, junction outlines
 * with rounded corners, polygon triangulation. Shared by the ribbon, the junctions and the tests.
 */

export type Vec2 = [number, number];

/** Intersection parameter of segments a→b and c→d (null when they do not cross). */
export function segmentHit(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax;
  const qz = cz - az;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
  return [t, u];
}

/**
 * Removes the swallowtails of an offset curve in place: where the polyline (points `from`…`to`-1,
 * stride 1 in the separate x/z/y arrays) crosses itself within `window` points – the inner edge of a
 * bend tighter than its offset – every point of the loop moves to the crossing, so the edge runs
 * into a corner and out again instead of folding back over itself. Heights of the collapsed points
 * are averaged so the collapsed triangles have no area. `accept` can veto a crossing (one that is not
 * a swallowtail but the centre line itself crossing, like a teardrop loop). Returns the indices that moved.
 */
export function untangle(
  xs: Float32Array,
  zs: Float32Array,
  ys: Float32Array | null,
  from: number,
  to: number,
  window = 40,
  accept?: (k: number, j: number, x: number, z: number) => boolean,
): number[] {
  const moved: number[] = [];
  let k = from;
  while (k < to - 2) {
    let hit = -1;
    let hx = 0;
    let hz = 0;
    // the farthest crossing first: one collapse covers nested loops
    for (let j = Math.min(to - 2, k + window); j >= k + 2; j--) {
      const p = segmentHit(xs[k]!, zs[k]!, xs[k + 1]!, zs[k + 1]!, xs[j]!, zs[j]!, xs[j + 1]!, zs[j + 1]!);
      if (p) {
        const x = xs[k]! + (xs[k + 1]! - xs[k]!) * p[0];
        const z = zs[k]! + (zs[k + 1]! - zs[k]!) * p[0];
        if (accept && !accept(k, j, x, z)) continue;
        hit = j;
        hx = x;
        hz = z;
        break;
      }
    }
    if (hit < 0) {
      k++;
      continue;
    }
    let y = 0;
    for (let q = k + 1; q <= hit; q++) {
      xs[q] = hx;
      zs[q] = hz;
      if (ys) y += ys[q]!;
      moved.push(q);
    }
    if (ys) for (let q = k + 1; q <= hit; q++) ys[q] = y / (hit - k);
    k = hit;
  }
  return moved;
}

/** Signed area of a polygon (positive = counter-clockwise with x right, y up). */
export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** True when two non-adjacent edges of the polygon cross. */
export function selfIntersects(poly: Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = poly[j]!;
      const d = poly[(j + 1) % n]!;
      if (segmentHit(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return true;
    }
  }
  return false;
}

/** Ear clipping of a simple polygon (either orientation); returns index triples, counter-clockwise. */
export function triangulate(poly: Vec2[]): number[] {
  const ccw = polygonArea(poly) > 0;
  const idx = poly.map((_, i) => i);
  if (!ccw) idx.reverse();
  const out: number[] = [];
  const cross = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) => cross(a, b, p) >= -1e-9 && cross(b, c, p) >= -1e-9 && cross(c, a, p) >= -1e-9;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length]!;
      const ib = idx[k]!;
      const ic = idx[(k + 1) % idx.length]!;
      const a = poly[ia]!;
      const b = poly[ib]!;
      const c = poly[ic]!;
      const area = cross(a, b, c);
      if (area < -1e-9) continue;
      if (area <= 1e-9) {
        // collinear point: drop it without a triangle
        idx.splice(k, 1);
        clipped = true;
        break;
      }
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = poly[j]!;
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (inside(p, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(ia, ib, ic);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not simple: give up on the rest
  }
  if (idx.length === 3 && Math.abs(cross(poly[idx[0]!]!, poly[idx[1]!]!, poly[idx[2]!]!)) > 1e-9) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}

/** Splits every triangle into four, `levels` times (shared edge midpoints are shared vertices). */
export function subdivide(pts: Vec2[], tris: number[], levels: number): { pts: Vec2[]; tris: number[] } {
  let p = pts.slice();
  let t = tris;
  for (let l = 0; l < levels; l++) {
    const mids = new Map<number, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let m = mids.get(key);
      if (m === undefined) {
        m = p.length;
        p.push([(p[a]![0] + p[b]![0]) / 2, (p[a]![1] + p[b]![1]) / 2]);
        mids.set(key, m);
      }
      return m;
    };
    const next: number[] = [];
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k]!;
      const b = t[k + 1]!;
      const c = t[k + 2]!;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    t = next;
  }
  return { pts: p, tris: t };
}

/** A road leaving a junction node: unit direction, half width, preferred corner radius. */
export interface Arm {
  dir: Vec2;
  hw: number;
  radius: number;
  /** Arms that only bound the junction (the ride's own road): no cut, no end across them. */
  through?: boolean;
  /** The arm's own road starts at least this far from the node. */
  minCut?: number;
}

export interface JunctionOutline {
  /** Counter-clockwise outline around the node at the origin. */
  poly: Vec2[];
  /** Per arm: distance from the node where the arm's own road starts (0 for through arms). */
  cut: number[];
}

const MAX_TANGENT = 12;
const ARC_STEP = 0.8;

/**
 * Outline of a junction area around a node at the origin, in the style of osm2streets: the edges of
 * neighbouring arms are intersected and the corner between them rounded with a fillet arc. Arms must
 * be sorted counter-clockwise by direction. Gaps of more than ~165° (straight through, or the open
 * side of a T) get no corner. Through arms (the ride's road at a turn-off) bound the area without an
 * end: the outline starts and ends on their edge lines, `inner` lateral metres from their centre line.
 */
export function junctionOutline(arms: Arm[], inner = 0): JunctionOutline {
  const n = arms.length;
  const left = (a: Arm, t: number): Vec2 => [-a.dir[1] * a.hw + a.dir[0] * t, a.dir[0] * a.hw + a.dir[1] * t];
  const right = (a: Arm, t: number): Vec2 => [a.dir[1] * a.hw + a.dir[0] * t, -a.dir[0] * a.hw + a.dir[1] * t];
  const angle = (a: Arm) => Math.atan2(a.dir[1], a.dir[0]);
  // corners between arm j (its left edge) and arm j+1 (its right edge)
  const corners: Array<{ ta: number; tb: number; arc: Vec2[] } | null> = [];
  const need = arms.map(() => 0);
  const wraps = !arms.some((a) => a.through);
  for (let j = 0; j < n; j++) {
    if (!wraps && j === n - 1) {
      corners.push(null);
      break;
    }
    const a = arms[j]!;
    const b = arms[(j + 1) % n]!;
    let gap = angle(b) - angle(a);
    while (gap <= 0) gap += Math.PI * 2;
    if (gap > (165 / 180) * Math.PI) {
      corners.push(null);
      continue;
    }
    // edge lines: left of a = La + s·da, right of b = Rb + t·db
    const la = left(a, 0);
    const rb = right(b, 0);
    const den = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0];
    const qx = rb[0] - la[0];
    const qz = rb[1] - la[1];
    const s = (qx * b.dir[1] - qz * b.dir[0]) / den;
    const t = (qx * a.dir[1] - qz * a.dir[0]) / den;
    const half = gap / 2;
    let r = Math.min(a.radius, b.radius);
    r = Math.min(r, MAX_TANGENT * Math.tan(half));
    const T = r / Math.tan(half);
    const ta = Math.max(0, s + T);
    const tb = Math.max(0, t + T);
    const kx = la[0] + a.dir[0] * s;
    const kz = la[1] + a.dir[1] * s;
    // fillet centre on the bisector, the arc runs from the edge of a to the edge of b
    const bx = a.dir[0] + b.dir[0];
    const bz = a.dir[1] + b.dir[1];
    const bl = Math.hypot(bx, bz) || 1;
    const dc = r / Math.sin(half);
    const cx = kx + (bx / bl) * dc;
    const cz = kz + (bz / bl) * dc;
    const pa = left(a, ta);
    const pb = right(b, tb);
    let a0 = Math.atan2(pa[1] - cz, pa[0] - cx);
    let a1 = Math.atan2(pb[1] - cz, pb[0] - cx);
    // the arc turns clockwise (it is concave seen from the junction)
    while (a1 > a0) a1 -= Math.PI * 2;
    while (a0 - a1 > Math.PI * 2) a1 += Math.PI * 2;
    const steps = Math.max(2, Math.ceil((r * (a0 - a1)) / ARC_STEP));
    const arc: Vec2[] = [];
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + ((a1 - a0) * k) / steps;
      arc.push(k === 0 ? pa : k === steps ? pb : [cx + Math.cos(ang) * r, cz + Math.sin(ang) * r]);
    }
    corners.push({ ta, tb, arc });
    need[j] = Math.max(need[j]!, ta);
    need[(j + 1) % n] = Math.max(need[(j + 1) % n]!, tb);
  }
  const cut = arms.map((a, j) => (a.through ? 0 : Math.max(need[j]! + 0.5, a.minCut ?? 0)));
  const poly: Vec2[] = [];
  if (!wraps) {
    // through arms bound the area: start on the first one's edge line, end on the last one's
    const a = arms[0]!;
    const c = corners[0];
    const t0 = c ? c.ta : a.hw;
    const off = left(a, t0);
    poly.push([off[0] + a.dir[1] * (a.hw - inner), off[1] - a.dir[0] * (a.hw - inner)]);
  }
  for (let j = 0; j < n; j++) {
    const a = arms[j]!;
    if (!a.through) {
      const prev = corners[(j + n - 1) % n];
      if (!prev) poly.push(right(a, 0));
      poly.push(right(a, cut[j]!), left(a, cut[j]!));
    }
    const c = corners[j];
    if (c) poly.push(...c.arc);
    else if (!a.through) poly.push(left(a, 0));
  }
  if (!wraps) {
    const a = arms[n - 1]!;
    const c = corners[n - 2];
    const t0 = c ? c.tb : a.hw;
    const off = right(a, t0);
    poly.push([off[0] - a.dir[1] * (a.hw - inner), off[1] + a.dir[0] * (a.hw - inner)]);
  }
  return { poly: dedupe(poly), cut };
}

function dedupe(poly: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) < 1e-4) out.pop();
  return out;
}
