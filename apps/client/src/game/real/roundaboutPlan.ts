/**
 * Roundabouts: the ring carriageway around a central island, its heights along the ring and the
 * approaches joining it. Each approach is one asphalt area from the joining road(s) into the ring with
 * rounded outer corners (fillets); a pair of one-way carriageways (or the lap's split branches) becomes
 * one approach with a raised splitter island between entry and exit. The outer edge line of the ring
 * is open across each approach, give-way dashes cross the entering lane. The ride's rows on a ring are
 * not drawn (corridor.ts, roadRibbon.ts); side roads end where their approach area begins.
 * Babylon-free so the tests can check the plan; the meshes come from roundabouts.ts.
 */
import { smoothstep } from '../noise';
import { ROW_STRIDE, SHOULDER, type RouteCorridor } from './corridor';
import { SIDE_LIFT, alongPolyline, crossSection, polylineLength, type JunctionPlan } from './junctions';
import { selfIntersects, type Vec2 } from './roadGeometry';
import type { Roundabout, SideRoad } from './worldData';

/** Road ends this far (m) outside the ring's outer edge still belong to the ring. */
const RING_CATCH = 2;
/** Angular step of the ring mesh, m along the centre line. */
const RING_STEP = 1;
/** The ring lies this far above the ride's height. */
export const RING_LIFT = 0.03;
/** Corner radius between an approach and the ring (paved roads / tracks), m. */
const FILLET = 12;
const FILLET_TRACK = 4;
/** Carriageways whose edges are closer than this (m) at the ring form one approach (splitter island between). */
const PAIR_GAP = 9;
/** The splitter island starts this far outside the ring's outer edge and keeps this far from the lanes, m. */
const ISLAND_NOSE = 1.5;
const ISLAND_INSET = 0.5;
/** A pair's area (and its splitter island) runs at most this far (m) out along the carriageways. */
const PAIR_REACH = 30;
/** Splitter islands: length and half width at the widest of the standard teardrop, m. */
const ISLAND_LEN = 14;
const ISLAND_HALF = 1.1;
/** Approach areas reach this far (m) past the end of their fillets along the roads. */
const APPROACH_PAST = 1;
/** Inner apron (paved, slightly raised) between the ring carriageway and the island, m. */
export const APRON = 1.2;

/** Angular interval [a, a + span] (rad, span < 2π). */
export interface Arc {
  a: number;
  span: number;
}

/** One road (the lap or a side road) ending on the ring, at the outer edge. */
export interface RingEnd {
  /** Centre line on the ring's outer edge, outward direction. */
  p: Vec2;
  t: Vec2;
  /** Half widths to the left (counter-clockwise round the ring) and right of `t`, incl. shoulder. */
  hl: number;
  hr: number;
  /** Lap ends: rows from the ring outwards (their walls are opened), entering the ring or not, one-way. */
  lap: { row: number; step: number; entering: boolean; oneWay: boolean } | null;
  road: number;
  end: 0 | 1;
  /** Distance along the side road from its end to the ring's outer edge. */
  cut: number;
  track: boolean;
  ang: number;
}

export interface RingApproach {
  /** Asphalt area (world x/z, counter-clockwise). */
  poly: Vec2[];
  /** Raised splitter islands (world x/z, counter-clockwise). */
  islands: Vec2[][];
  /** Rounded corners: arc polylines from the road edge to the ring, with their centres (kerb strips). */
  fillets: Array<{ pts: Vec2[]; c: Vec2; r: number }>;
  /** Interruption of the ring's outer edge line. */
  gap: Arc;
  /** Give-way dashes across entering lanes. */
  dashes: Arc[];
  /** Approach area height falls back to the joining roads over this distance from the ring, m. */
  reach: number;
}

export interface RingPlan {
  rb: Roundabout;
  /** Ring height per angular step k (angle 2πk/n), m. */
  ys: Float32Array;
  /** Whether the ride runs on the ring at step k. */
  ridden: Uint8Array;
  approaches: RingApproach[];
}

const TAU = Math.PI * 2;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const add = (a: Vec2, b: Vec2, s = 1): Vec2 => [a[0] + b[0] * s, a[1] + b[1] * s];
const left = (t: Vec2): Vec2 => [-t[1], t[0]];
const right = (t: Vec2): Vec2 => [t[1], -t[0]];

/** Shortest arc between two angles. */
export function arcBetween(a: number, b: number): Arc {
  const d = norm(b - a);
  return d <= Math.PI ? { a: norm(a), span: d } : { a: norm(b), span: TAU - d };
}

export function inArc(arc: Arc, t: number): boolean {
  return norm(t - arc.a) <= arc.span;
}

/** Roundabout whose ring a side road end lies on, with the distance (m) along the road to the ring's outer edge. */
export function ringCut(c: RouteCorridor, road: SideRoad, end: 0 | 1): { k: number; cut: number } | null {
  const p = alongPolyline(road.pts, end, 0);
  const len = polylineLength(road.pts);
  for (let k = 0; k < c.roundabouts.length; k++) {
    const rb = c.roundabouts[k]!;
    const out = rb.r + rb.hw;
    if (Math.hypot(p[0] - rb.x, p[1] - rb.z) > out + RING_CATCH) continue;
    // walk out along the road until it leaves the ring
    let d = 0;
    while (d < len) {
      const q = alongPolyline(road.pts, end, d);
      if (Math.hypot(q[0] - rb.x, q[1] - rb.z) >= out) break;
      d += 0.25;
    }
    return { k, cut: Math.min(d, len) };
  }
  return null;
}

/** Ring heights: the ride's height where it runs on the ring, elsewhere the ground as a tilted plane, smoothly joined. */
function ringHeights(c: RouteCorridor, k: number, ground: (x: number, z: number) => number): { ys: Float32Array; ridden: Uint8Array } {
  const rb = c.roundabouts[k]!;
  const R = c.rows;
  const n = Math.max(48, Math.ceil((TAU * rb.r) / RING_STEP));
  const ys = new Float32Array(n);
  const ridden = new Uint8Array(n);
  const onRing = (i: number) => c.ring[Math.round(i / ROW_STRIDE) % R] === k + 1;
  const own = new Float32Array(n);
  for (let q = 0; q < n; q++) {
    const t = (TAU * q) / n;
    const x = rb.x + rb.r * Math.cos(t);
    const z = rb.z + rb.r * Math.sin(t);
    const hit = c.nearest(x, z, rb.hw, onRing);
    own[q] = ground(x, z) + SIDE_LIFT;
    if (hit) {
      // two passes of the lap on the same part of the ring: halfway between them
      const other = c.nearest(x, z, rb.hw, (i) => onRing(i) && c.lapGap(hit.i, i) > 30);
      ys[q] = other ? (hit.y + other.y) / 2 : hit.y;
      ridden[q] = 1;
    }
  }
  // the ground as a tilted plane (first harmonic round the ring): a ring is never bumpy
  let a0 = 0;
  let a1 = 0;
  let b1 = 0;
  for (let q = 0; q < n; q++) {
    const t = (TAU * q) / n;
    a0 += own[q]! / n;
    a1 += (2 * own[q]! * Math.cos(t)) / n;
    b1 += (2 * own[q]! * Math.sin(t)) / n;
  }
  for (let q = 0; q < n; q++) own[q] = a0 + a1 * Math.cos((TAU * q) / n) + b1 * Math.sin((TAU * q) / n);
  if (!ridden.some((v) => v)) ys.set(own);
  else {
    // between two ridden stretches: straight from one to the other (the ground there follows the ride's road)
    for (let q = 0; q < n; q++) {
      if (ridden[q]) continue;
      let a = q;
      while (!ridden[a]) a = (a - 1 + n) % n;
      let b = q;
      while (!ridden[b]) b = (b + 1) % n;
      const da = (q - a + n) % n;
      const db = (b - q + n) % n;
      ys[q] = ys[a]! + ((ys[b]! - ys[a]!) * da) / (da + db);
    }
  }
  // smooth all round: the free stretches meet the ridden ones without a kink, and where passes of
  // the lap at slightly different heights touch the ring they are evened out (a few cm)
  for (let pass = 0; pass < 6; pass++) {
    const prev = ys.slice();
    for (let q = 0; q < n; q++) ys[q] = (prev[(q - 1 + n) % n]! + 2 * prev[q]! + prev[(q + 1) % n]!) / 4;
  }
  return { ys, ridden };
}

/** Point where the line p + s·t crosses the circle of radius `rad` round o (the crossing nearest p). */
function onCircle(o: Vec2, rad: number, p: Vec2, t: Vec2): Vec2 {
  const qx = p[0] - o[0];
  const qz = p[1] - o[1];
  const b = qx * t[0] + qz * t[1];
  const disc = b * b - (qx * qx + qz * qz - rad * rad);
  if (disc < 0) return p;
  const s1 = -b + Math.sqrt(disc);
  const s2 = -b - Math.sqrt(disc);
  return add(p, t, Math.abs(s1) < Math.abs(s2) ? s1 : s2);
}

/**
 * Corner between an edge line (p + s·t, s ≥ 0, road on the side opposite `out`) and the ring's outer
 * circle: a circle of radius `r` touching both. Null when the edge does not reach out of the ring.
 */
function fillet(o: Vec2, ro: number, p: Vec2, t: Vec2, out: Vec2, r: number): { s: number; c: Vec2; onEdge: Vec2; onRing: Vec2 } | null {
  const q: Vec2 = [p[0] + out[0] * r - o[0], p[1] + out[1] * r - o[1]];
  const b = q[0] * t[0] + q[1] * t[1];
  const disc = b * b - (q[0] * q[0] + q[1] * q[1]) + (ro + r) * (ro + r);
  if (disc < 0) return null;
  const s = -b + Math.sqrt(disc);
  if (s < 0) return null;
  const c: Vec2 = [o[0] + q[0] + t[0] * s, o[1] + q[1] + t[1] * s];
  const d = Math.hypot(c[0] - o[0], c[1] - o[1]);
  return { s, c, onEdge: add(p, t, s), onRing: [o[0] + ((c[0] - o[0]) * ro) / d, o[1] + ((c[1] - o[1]) * ro) / d] };
}

/** Points on the arc round c from a to b (shorter way), both included. */
function arcPts(c: Vec2, r: number, a: Vec2, b: Vec2): Vec2[] {
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let d = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  const steps = Math.max(2, Math.ceil((Math.abs(d) * r) / 0.8));
  const out: Vec2[] = [a];
  for (let k = 1; k < steps; k++) out.push([c[0] + r * Math.cos(a0 + (d * k) / steps), c[1] + r * Math.sin(a0 + (d * k) / steps)]);
  out.push(b);
  return out;
}

function ccw(poly: Vec2[]): Vec2[] {
  let a = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!;
    const q = poly[(k + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a < 0 ? poly.slice().reverse() : poly;
}

/** The roads ending on ring k: the lap where it enters or leaves it, and side roads. */
export function ringEnds(c: RouteCorridor, k: number, roads: SideRoad[], lengths: number[]): RingEnd[] {
  const rb = c.roundabouts[k]!;
  const o: Vec2 = [rb.x, rb.z];
  const ro = rb.r + rb.hw;
  const R = c.rows;
  const ends: RingEnd[] = [];
  const ang = (p: Vec2) => Math.atan2(p[1] - o[1], p[0] - o[0]);
  for (let r = 0; r < R; r++) {
    const here = c.ring[r] === k + 1;
    const before = c.ring[(r - 1 + R) % R] === k + 1;
    if (here === before) continue;
    // the last row off the ring, and the lap's direction away from the ring
    const row = here ? (r - 1 + R) % R : r;
    const f = c.frames[row]!;
    const fwd: Vec2 = [-f.rz, f.rx];
    const t: Vec2 = here ? [-fwd[0], -fwd[1]] : fwd;
    // left of the way out is the right of the lap when it enters
    const hl = c.hw[here ? 1 : 0]![row]! + SHOULDER;
    const hr = c.hw[here ? 0 : 1]![row]! + SHOULDER;
    const p = onCircle(o, ro, [f.x, f.z], t);
    // the same road passed both ways (out-and-back): one end
    if (ends.some((e) => e.lap && Math.hypot(e.p[0] - p[0], e.p[1] - p[1]) < 3 && e.t[0] * t[0] + e.t[1] * t[1] > 0.8)) continue;
    const oneWay = c.twin[row] === 2;
    ends.push({ p, t, hl, hr, lap: { row, step: here ? -1 : 1, entering: here, oneWay }, road: -1, end: 0, cut: 0, track: false, ang: ang(p) });
  }
  roads.forEach((road, ri) => {
    for (const end of [0, 1] as const) {
      const hit = ringCut(c, road, end);
      if (!hit || hit.k !== k || hit.cut >= lengths[ri]! - 1) continue;
      const cs = crossSection(road, end, hit.cut, lengths[ri]!);
      const p = alongPolyline(road.pts, end, hit.cut);
      // a side road along the lap's own approach is part of it
      if (ends.some((e) => e.lap && Math.hypot(e.p[0] - p[0], e.p[1] - p[1]) < e.hl + e.hr)) continue;
      // crossSection's tangent runs along the polyline: outwards is against it at the polyline's end
      const t: Vec2 = end === 0 ? [cs.tx, cs.tz] : [-cs.tx, -cs.tz];
      ends.push({ p, t, hl: road.width / 2, hr: road.width / 2, lap: null, road: ri, end, cut: hit.cut, track: road.track, ang: ang(p) });
    }
  });
  return ends;
}

/**
 * Plans every roundabout (heights, approaches) and fits the side roads to it: their ends are cut back to
 * where the approach areas begin, and walls or rails on the ride's road open where it joins a ring.
 */
export function planRoundabouts(c: RouteCorridor, roads: SideRoad[], ground: (x: number, z: number) => number, plan?: JunctionPlan): RingPlan[] {
  const lengths = roads.map((r) => polylineLength(r.pts));
  return c.roundabouts.map((rb, k) => {
    const { ys, ridden } = ringHeights(c, k, ground);
    const o: Vec2 = [rb.x, rb.z];
    const ro = rb.r + rb.hw;
    const ang = (p: Vec2) => Math.atan2(p[1] - o[1], p[0] - o[0]);
    const ends = ringEnds(c, k, roads, lengths).sort((a, b) => a.ang - b.ang);

    // group neighbouring carriageways into approaches (counter-clockwise order inside a group)
    const groups: RingEnd[][] = [];
    const n = ends.length;
    if (n > 0) {
      // start after the widest angular gap, so no group wraps over the start
      let first = 0;
      let widest = -1;
      for (let q = 0; q < n; q++) {
        const g = norm(ends[q]!.ang - ends[(q - 1 + n) % n]!.ang) || TAU;
        if (g > widest) [widest, first] = [g, q];
      }
      for (let q = 0; q < n; q++) {
        const e = ends[(first + q) % n]!;
        const g = groups[groups.length - 1];
        const prev = g?.[g.length - 1];
        if (prev && g.length < 2) {
          const edgeGap = norm(e.ang - prev.ang) * ro - prev.hl - e.hr;
          const sameWay = prev.t[0] * e.t[0] + prev.t[1] * e.t[1] > 0.5;
          const bothLap = !!prev.lap === !!e.lap;
          if (edgeGap < PAIR_GAP && sameWay && bothLap) {
            g.push(e);
            continue;
          }
        }
        groups.push([e]);
      }
    }

    // fillets per group; shrunk where two groups' corners would overlap
    // small rings get tighter corners (the openings would otherwise take the whole outer edge)
    const radius: number[] = groups.map((g) => Math.min(g.some((e) => e.track) ? FILLET_TRACK : FILLET, 0.5 * ro));
    const corners = (gi: number) => {
      const g = groups[gi]!;
      const a = g[0]!;
      const b = g[g.length - 1]!;
      const r = radius[gi]!;
      const cw = fillet(o, ro, add(a.p, right(a.t), a.hr), a.t, right(a.t), r);
      const cc = fillet(o, ro, add(b.p, left(b.t), b.hl), b.t, left(b.t), r);
      return { cw, cc };
    };
    for (let it = 0; it < 4 && groups.length > 1; it++) {
      let changed = false;
      for (let gi = 0; gi < groups.length; gi++) {
        const gj = (gi + 1) % groups.length;
        const a = corners(gi).cc;
        const b = corners(gj).cw;
        if (!a || !b) continue;
        const aa = ang(a.onRing);
        const bb = ang(b.onRing);
        // the corner of one ends before the next one's starts (counter-clockwise)
        const room = norm(bb - aa);
        const span = norm(ang(groups[gj]![0]!.p) - ang(groups[gi]![groups[gi]!.length - 1]!.p));
        if (room > span) {
          radius[gi] = radius[gi]! * 0.6;
          radius[gj] = radius[gj]! * 0.6;
          changed = true;
        }
      }
      if (!changed) break;
    }

    const approaches: RingApproach[] = [];
    groups.forEach((g, gi) => {
      const a = g[0]!;
      const b = g[g.length - 1]!;
      // the area reaches past both corners along every carriageway of the approach: tighter corners
      // where a side road is too short for that
      const avail = Math.min(...g.map((e) => (e.lap ? Infinity : lengths[e.road]! - e.cut - 1)));
      let { cw, cc } = corners(gi);
      while (Math.max(cw?.s ?? 0, cc?.s ?? 0) + APPROACH_PAST > avail && radius[gi]! > 1.5) {
        radius[gi] = radius[gi]! * 0.7;
        ({ cw, cc } = corners(gi));
      }
      if (Math.max(cw?.s ?? 0, cc?.s ?? 0) + APPROACH_PAST > avail) {
        cw = null;
        cc = null;
      }
      const r = radius[gi]!;
      const at = (e: RingEnd, side: 1 | -1, s: number): Vec2 => {
        if (!e.lap) {
          const cs = crossSection(roads[e.road]!, e.end, Math.min(e.cut + s, lengths[e.road]! - 0.5), lengths[e.road]!);
          // cs.left is left of the polyline's direction, i.e. right of the way out at the polyline's end
          return side > 0 === (e.end === 0) ? cs.left : cs.right;
        }
        // the lap: along its rows (the branches curve), the left of the way out is the right of an entry
        const f0 = c.frames[e.lap.row]!;
        const d0 = (f0.x - e.p[0]) * e.t[0] + (f0.z - e.p[1]) * e.t[1];
        const u = (s - d0) / c.rowLength;
        if (u <= 0) return add(add(e.p, e.t, s), side > 0 ? left(e.t) : right(e.t), side > 0 ? e.hl : e.hr);
        const q0 = Math.floor(u);
        const w = u - q0;
        const R = c.rows;
        const point = (q: number): Vec2 => {
          const row = (((e.lap!.row + e.lap!.step * q) % R) + R) % R;
          const f = c.frames[row]!;
          const sideIdx = side > 0 === e.lap!.entering ? 1 : 0;
          const o = (c.hw[sideIdx]![row]! + SHOULDER) * (sideIdx === 1 ? 1 : -1);
          return [f.x + f.rx * o, f.z + f.rz * o];
        };
        const pa = point(q0);
        const pb = point(q0 + 1);
        return [pa[0] + (pb[0] - pa[0]) * w, pa[1] + (pb[1] - pa[1]) * w];
      };
      let end = Math.max(0.3, Math.min(avail, Math.max(cw?.s ?? 0, cc?.s ?? 0) + APPROACH_PAST));
      // a pair of carriageways: one area up to where they meet (the splitter island fills the wedge)
      const across = (s: number) => {
        const pa = at(a, 1, s);
        const pb = at(b, -1, s);
        const n0 = left(a.t);
        return (pb[0] - pa[0]) * n0[0] + (pb[1] - pa[1]) * n0[1];
      };
      let meet = Infinity;
      if (g.length === 2) {
        const cap = Math.min(avail, PAIR_REACH);
        for (let s = end; s <= cap; s += 0.5) {
          if (across(s) < 0.4) {
            meet = s;
            break;
          }
        }
        // room for a standard island beyond where the mapped ways meet
        end = Math.max(end, Math.min(meet + ISLAND_LEN * 0.5, cap));
      }
      const poly: Vec2[] = [];
      const fillets: RingApproach['fillets'] = [];
      // clockwise corner: from the ring out to the road edge
      const cwRing = cw ? cw.onRing : onCircle(o, ro, add(a.p, right(a.t), a.hr), a.t);
      if (cw) {
        const pts = arcPts(cw.c, r, cw.onRing, cw.onEdge);
        fillets.push({ pts, c: cw.c, r });
        poly.push(...pts);
      } else poly.push(cwRing);
      // out along the outer edges and across the road ends
      for (let s = (cw?.s ?? 0) + 2; s < end - 1; s += 2) poly.push(at(a, -1, s));
      for (const e of g) poly.push(at(e, -1, end), at(e, 1, end));
      const back: Vec2[] = [];
      for (let s = (cc?.s ?? 0) + 2; s < end - 1; s += 2) back.push(at(b, 1, s));
      poly.push(...back.reverse());
      const ccRing = cc ? cc.onRing : onCircle(o, ro, add(b.p, left(b.t), b.hl), b.t);
      if (cc) {
        const pts = arcPts(cc.c, r, cc.onEdge, cc.onRing);
        fillets.push({ pts: pts.slice().reverse(), c: cc.c, r });
        poly.push(...pts);
      } else poly.push(ccRing);
      // back along the inside of the ring's outer edge (the area tucks under the ring)
      const a0 = ang(ccRing);
      const span = norm(a0 - ang(cwRing));
      const steps = Math.max(2, Math.ceil((span * ro) / 0.8));
      for (let s = 0; s <= steps; s++) {
        const t = a0 - (span * s) / steps;
        poly.push([o[0] + (ro - 0.4) * Math.cos(t), o[1] + (ro - 0.4) * Math.sin(t)]);
      }
      const area = ccw(poly);
      if (selfIntersects(area)) return;

      // splitter island between the two carriageways of a pair: between their inner edges, at least a
      // teardrop of standard size on the line halfway between them (the mapped ways often touch)
      const islands: Vec2[][] = [];
      let entryInner: Vec2 | null = null;
      if (g.length === 2) {
        const s0 = ISLAND_NOSE;
        const s1 = Math.min(end, meet + ISLAND_LEN) - 0.5;
        const len = Math.min(ISLAND_LEN, s1 - s0);
        if (len > 2) {
          const sideA: Vec2[] = [];
          const sideB: Vec2[] = [];
          const steps2 = Math.max(4, Math.ceil((s1 - s0) / 1.0));
          let last = steps2;
          for (let q = 0; q <= steps2; q++) {
            const s = s0 + ((s1 - s0) * q) / steps2;
            const pa = at(a, 1, s);
            const pb = at(b, -1, s);
            const m: Vec2 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
            const tx = pb[0] - pa[0];
            const tz = pb[1] - pa[1];
            const tl = Math.hypot(tx, tz);
            // across the pair, from a's side to b's side (a's left as fallback where the edges cross)
            const n0: Vec2 = tl > 0.05 && across(s) > 0 ? [tx / tl, tz / tl] : left(a.t);
            const u = (s - s0) / len;
            const tear = u < 1 ? ISLAND_HALF * Math.sqrt(Math.min(1, u * 4 + 0.15)) * (1 - u * u) : 0;
            const half = Math.max(across(s) / 2 - ISLAND_INSET, tear);
            if (half < 0.08) {
              last = q;
              sideA.push(m);
              break;
            }
            sideA.push(add(m, n0, -half));
            sideB.push(add(m, n0, half));
          }
          if (last > 1 && sideB.length > 1) {
            const m0: Vec2 = [(sideA[0]![0] + sideB[0]![0]) / 2, (sideA[0]![1] + sideB[0]![1]) / 2];
            const tm: Vec2 = [(a.t[0] + b.t[0]) / 2, (a.t[1] + b.t[1]) / 2];
            const tl = Math.hypot(tm[0], tm[1]) || 1;
            const w0 = Math.hypot(sideB[0]![0] - sideA[0]![0], sideB[0]![1] - sideA[0]![1]) / 2;
            // rounded nose towards the ring
            const nose: Vec2[] = [];
            for (let q = 1; q < 6; q++) {
              const phi = (Math.PI * q) / 6;
              const along = -Math.sin(phi) * w0;
              const acr = -Math.cos(phi) * w0;
              const nx = (sideB[0]![0] - sideA[0]![0]) / (2 * w0 || 1);
              const nz = (sideB[0]![1] - sideA[0]![1]) / (2 * w0 || 1);
              nose.push([m0[0] + (tm[0] / tl) * along + nx * acr, m0[1] + (tm[1] / tl) * along + nz * acr]);
            }
            const isle = ccw([...sideA, ...sideB.slice().reverse(), ...nose.reverse()]);
            if (!selfIntersects(isle)) {
              islands.push(isle);
              entryInner = sideB[0]!;
            }
          }
        }
      }
      // give-way dashes across the lanes entering the ring
      const dashes: Arc[] = [];
      const lane = (e: RingEnd, l0: number, l1: number) => {
        const pa = onCircle(o, ro, add(e.p, left(e.t), l0), e.t);
        const pb = onCircle(o, ro, add(e.p, left(e.t), l1), e.t);
        dashes.push(arcBetween(ang(pa), ang(pb)));
      };
      for (const e of g) {
        if (e.track) continue;
        const inner = e.lap ? SHOULDER : 0;
        const oneWay = e.lap ? e.lap.oneWay || g.length === 2 : g.length === 2;
        // a pair of one-way carriageways: traffic enters on the counter-clockwise one (right-hand traffic)
        const entering = e.lap ? e.lap.entering : e === b;
        if (oneWay) {
          if (!entering) continue;
          if (entryInner && g.length === 2) {
            // from the splitter island's edge to the lane's outer edge
            const pa = onCircle(o, ro, entryInner, e.t);
            const pb = onCircle(o, ro, add(e.p, left(e.t), e.hl - inner), e.t);
            dashes.push(arcBetween(ang(pa), ang(pb)));
          } else lane(e, -e.hr + inner, e.hl - inner);
        } else lane(e, 0.2, e.hl - inner);
      }
      if (plan) {
        for (const e of g) {
          if (e.lap) continue;
          const cut = Math.min(e.cut + end, lengths[e.road]! - 0.5);
          const cs = crossSection(roads[e.road]!, e.end, cut, lengths[e.road]!);
          plan.cuts[e.road * 2 + e.end] = cut;
          plan.tans[e.road * 4 + e.end * 2] = cs.tx;
          plan.tans[e.road * 4 + e.end * 2 + 1] = cs.tz;
          plan.mouthed[e.road] = 1;
        }
      }
      // no wall or rail where the lap's road widens into the approach
      for (const e of g) {
        if (!e.lap) continue;
        const rows = Math.ceil(end / c.rowLength) + 2;
        for (let q = 0; q <= rows; q++) {
          const row = (((e.lap.row + e.lap.step * q) % c.rows) + c.rows) % c.rows;
          c.openEdge(0, row, row);
          c.openEdge(1, row, row);
        }
      }
      approaches.push({ poly: area, islands, fillets, gap: arcBetween(ang(cwRing), ang(ccRing)), dashes, reach: end });
    });
    return { rb, ys, ridden, approaches };
  });
}

/** Ring height at angle t (interpolated between the planned steps). */
export function ringHeight(plan: RingPlan, t: number): number {
  const n = plan.ys.length;
  const u = (norm(t) / TAU) * n;
  const q = Math.floor(u) % n;
  const w = u - Math.floor(u);
  return plan.ys[q]! * (1 - w) + plan.ys[(q + 1) % n]! * w;
}

/**
 * Height of an approach area: the ring's at its outer edge, the joining roads' (the ride's road, or a
 * side road lying SIDE_LIFT above the ground) where the area ends.
 */
export function approachHeight(c: RouteCorridor, ground: (x: number, z: number) => number, plan: RingPlan, a: RingApproach, x: number, z: number): number {
  const { rb } = plan;
  const d = Math.hypot(x - rb.x, z - rb.z);
  const t = Math.atan2(z - rb.z, x - rb.x);
  const ring = ringHeight(plan, t) + RING_LIFT;
  const hit = c.nearest(x, z, 10);
  // on the ride's road the area lies on its asphalt, beside it on the side roads' level
  const gap = hit ? Math.abs(hit.offset) - c.hw[hit.offset >= 0 ? 1 : 0]![hit.row]! - SHOULDER : Infinity;
  const road = ground(x, z) + 0.02 + (SIDE_LIFT - 0.02) * smoothstep(0, 1.5, gap);
  const w = smoothstep(0, Math.max(1, a.reach), d - rb.r - rb.hw);
  return ring + (road - ring) * w;
}
