/**
 * Roundabouts: the ring carriageway around a central island, its heights along the ring and the
 * approaches joining it. Each approach is one asphalt area from the joining road(s) into the ring with
 * rounded outer corners (fillets). Paved approaches follow one template: the two-lane road flares round a
 * triangular splitter island (base at the ring, tip out along the road), whose painted outline meets the
 * centre line beyond the tip with hatching between; entry on the island's counter-clockwise side, exit on
 * the other (right-hand traffic). A pair of one-way carriageways (or the lap's split branches) becomes one
 * such approach. Give-way dashes cross the entry, thin dashes carry the outer edge line across the exit.
 * The ride moves right beside the island (laneShifts). The ride's rows on a ring are not drawn
 * (corridor.ts, roadRibbon.ts); side roads end where their approach area begins.
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
/** The splitter island's base lies this far outside the ring's outer edge; it keeps this far from mapped lanes, m. */
const ISLAND_NOSE = 1.5;
const ISLAND_INSET = 0.5;
/** A pair's area (and its splitter island) runs at most this far (m) out along the carriageways. */
const PAIR_REACH = 30;
/** Splitter island: a triangle with its base at the ring (half width) and its tip out along the road, m. */
const ISLAND_LEN = 14;
const ISLAND_HALF = 2.2;
/** Beyond the tip the island's painted outline meets the centre line after this far, the flare of the edges ends after this far again, m. */
const HATCH_LEN = 6;
const FLARE_OUT = 10;
/** Painted outline this far outside the island; hatch stripes spacing and width; centre dashes, m. */
const OUTLINE = 0.3;
const HATCH_STEP = 1.4;
const HATCH_W = 0.3;
const CENTRE_DASH = 3;
const CENTRE_GAP = 3;
/** Side roads narrower than this (half width, m) join without an island. */
const ISLAND_MIN_HALF = 2.4;
/** Edge lines: width and distance of their centre from the asphalt edge, m. */
export const LINE_W = 0.15;
export const LINE_IN = 0.3;
/** Approach areas reach this far (m) past the end of their fillets along the roads. */
const APPROACH_PAST = 1;
/** Inner apron (paved, slightly raised) between the ring carriageway and the island, m. */
export const APRON = 1.2;
/** Riders move back from beside the island to their line over this distance inside the ring, m. */
const SHIFT_IN = 8;

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
  /**
   * Lap ends: rows from the ring outwards (their walls are opened), entering the ring or not, one-way;
   * every pass of the lap along this end (out-and-back roads are passed twice).
   */
  lap: { row: number; step: 1 | -1; entering: boolean; oneWay: boolean; passes: Array<{ row: number; step: 1 | -1 }> } | null;
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
  /** Thin dashes continuing the ring's outer edge line across the exits. */
  exits: Arc[];
  /** Markings on the approach (edge lines, the island's outline, hatching, centre dashes): polylines and their width. */
  paint: Array<{ pts: Vec2[]; w: number }>;
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
  /** How far riders move right on the lap's ends here (they pass beside the splitter island). */
  lanes: LaneShift[];
}

/** Sideways shift of the ride along one pass of the lap out of a ring, per metre from the ring's outer edge. */
export interface LaneShift {
  row: number;
  step: 1 | -1;
  /** Distance of the row's frame from the ring's outer edge, m. */
  d0: number;
  shift: Float32Array;
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
    const step = here ? -1 : 1;
    // the same road passed both ways (out-and-back): one end
    const same = ends.find((e) => e.lap && Math.hypot(e.p[0] - p[0], e.p[1] - p[1]) < 3 && e.t[0] * t[0] + e.t[1] * t[1] > 0.8);
    if (same) {
      same.lap!.passes.push({ row, step });
      continue;
    }
    const oneWay = c.twin[row] === 2;
    ends.push({ p, t, hl, hr, lap: { row, step, entering: here, oneWay, passes: [{ row, step }] }, road: -1, end: 0, cut: 0, track: false, ang: ang(p) });
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

    // the edge of a carriageway s m out from the ring (side > 0: left of the way out)
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

    // room between the inner edges of a pair of carriageways
    const across = (a: RingEnd, b: RingEnd, s: number) => {
      const pa = at(a, 1, s);
      const pb = at(b, -1, s);
      const n0 = left(a.t);
      return (pb[0] - pa[0]) * n0[0] + (pb[1] - pa[1]) * n0[1];
    };

    // every approach after the same template: the road's edges flare round a triangular splitter island
    // (base at the ring, tip out along the road), entry on its left (counter-clockwise side), exit on its right
    const tpls = groups.map((g) => {
      const a = g[0]!;
      const b = g[g.length - 1]!;
      const avail = Math.min(...g.map((e) => (e.lap ? Infinity : lengths[e.road]! - e.cut - 1)));
      // a pair: the width of one carriageway; one road: its lanes keep their width beside the island
      const lane = g.length === 2 ? (a.hl + a.hr + b.hl + b.hr) / 2 : 0;
      // the template shrinks on small rings and short side roads; too small, no island
      const k = Math.min(1, ro / ISLAND_LEN, (avail - APPROACH_PAST - ISLAND_NOSE) / (ISLAND_LEN + HATCH_LEN + FLARE_OUT));
      const len = ISLAND_LEN * k;
      const s1 = ISLAND_NOSE + len;
      const sH = s1 + HATCH_LEN * k;
      const sF = sH + FLARE_OUT * k;
      const paved = !g.some((e) => e.track);
      const wide = g.length === 2 || (!a.lap?.oneWay && Math.min(a.hl, a.hr) >= ISLAND_MIN_HALF);
      const half = paved && wide && k >= 0.4 ? Math.min(ISLAND_HALF, 0.12 * ro, ISLAND_HALF * (0.4 + k) / 1.4) : 0;
      // a pair: where its carriageways meet (from there on one road with two lanes)
      let meet = Infinity;
      if (g.length === 2) {
        const cap = Math.min(avail, PAIR_REACH);
        for (let s = ISLAND_NOSE; s <= cap; s += 0.5) {
          if (across(a, b, s) < 0.4) {
            meet = s;
            break;
          }
        }
      }
      return { a, b, avail, lane, len, s1, sH, sF, half, paved, meet };
    });
    type Tpl = (typeof tpls)[number];
    // arm frame s m out: middle between the outer edges, unit vector across (towards the entry side), half width
    const frame = (t: Tpl, s: number) => {
      const r = at(t.a, -1, s);
      const l = at(t.b, 1, s);
      const dx = l[0] - r[0];
      const dz = l[1] - r[1];
      const d = Math.hypot(dx, dz);
      const C: Vec2 = [(r[0] + l[0]) / 2, (r[1] + l[1]) / 2];
      const N: Vec2 = d > 0.05 ? [dx / d, dz / d] : left(t.a.t);
      return { C, N, h: d / 2 };
    };
    // room the island takes in the middle of the road, and the flared half width
    const flare = (t: Tpl, s: number) => t.half * (1 - smoothstep(t.s1, t.sF, s));
    const halfWidth = (t: Tpl, s: number, h: number) => (t.lane && s < t.meet ? Math.max(h, flare(t, s) + t.lane) : h + flare(t, s));
    const edge = (t: Tpl, s: number, side: 1 | -1): Vec2 => {
      const f = frame(t, s);
      return add(f.C, f.N, side * halfWidth(t, s, f.h));
    };
    const point = (t: Tpl, s: number, x: number): Vec2 => {
      const f = frame(t, s);
      return add(f.C, f.N, x);
    };

    // fillets per group; shrunk where two groups' corners would overlap
    // small rings get tighter corners (the openings would otherwise take the whole outer edge)
    const radius: number[] = groups.map((g) => Math.min(g.some((e) => e.track) ? FILLET_TRACK : FILLET, 0.5 * ro));
    const corners = (gi: number) => {
      const t = tpls[gi]!;
      const r = radius[gi]!;
      const cw = fillet(o, ro, edge(t, 0, -1), t.a.t, right(t.a.t), r);
      const cc = fillet(o, ro, edge(t, 0, 1), t.b.t, left(t.b.t), r);
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
    const lanes: LaneShift[] = [];
    const ringPlan: RingPlan = { rb, ys, ridden, approaches, lanes };
    groups.forEach((g, gi) => {
      const t = tpls[gi]!;
      const { a, b, avail } = t;
      // the area reaches past both corners along every carriageway of the approach: tighter corners
      // where a side road is too short for that
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
      let end = Math.max(0.3, Math.min(avail, Math.max(cw?.s ?? 0, cc?.s ?? 0, t.half > 0 ? t.sF : 0) + APPROACH_PAST));
      // a pair of carriageways: one area up to where they meet (the splitter island fills the wedge)
      const { meet } = t;
      if (g.length === 2) end = Math.max(end, Math.min(Math.max(meet, t.s1) + ISLAND_LEN * 0.5, avail, PAIR_REACH));
      const poly: Vec2[] = [];
      const fillets: RingApproach['fillets'] = [];
      // clockwise corner: from the ring out to the road edge
      const cwRing = cw ? cw.onRing : onCircle(o, ro, edge(t, 0, -1), a.t);
      if (cw) {
        const pts = arcPts(cw.c, r, cw.onRing, cw.onEdge);
        fillets.push({ pts, c: cw.c, r });
        poly.push(...pts);
      } else poly.push(cwRing);
      // out along the (flared) outer edges and across the road ends
      for (let s = (cw?.s ?? 0) + 1; s < end - 0.5; s += 1) poly.push(edge(t, s, -1));
      poly.push(edge(t, end, -1));
      if (g.length === 2 && across(a, b, end) > 0.5) poly.push(at(a, 1, end), at(b, -1, end));
      poly.push(edge(t, end, 1));
      const back: Vec2[] = [];
      for (let s = (cc?.s ?? 0) + 1; s < end - 0.5; s += 1) back.push(edge(t, s, 1));
      poly.push(...back.reverse());
      const ccRing = cc ? cc.onRing : onCircle(o, ro, edge(t, 0, 1), b.t);
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
        const u = a0 - (span * s) / steps;
        poly.push([o[0] + (ro - 0.4) * Math.cos(u), o[1] + (ro - 0.4) * Math.sin(u)]);
      }
      const area = ccw(poly);
      if (selfIntersects(area)) return;

      // splitter island: the template's triangle, for a pair at least the room between its carriageways
      const tri = (s: number) => t.half * Math.max(0, Math.min(1, (t.s1 - s) / t.len));
      const isleHalf = (s: number) => (g.length === 2 ? Math.max(tri(s), Math.min(across(a, b, s), 2 * PAIR_GAP) / 2 - ISLAND_INSET) : tri(s));
      const islands: Vec2[][] = [];
      const sI = g.length === 2 ? Math.min(end - 0.5, Math.max(t.s1, meet)) : t.s1;
      // no sliver between two mapped carriageways: an island at least as wide as a kerb on both sides
      if (isleHalf(ISLAND_NOSE) > 0.6) {
        const sideR: Vec2[] = [];
        const sideL: Vec2[] = [];
        let tip: Vec2 | null = null;
        for (let s = ISLAND_NOSE; s <= sI + 1e-6; s += 0.5) {
          const w = isleHalf(s);
          if (w < 0.08) {
            tip = point(t, s, 0);
            break;
          }
          sideR.push(point(t, s, -w));
          sideL.push(point(t, s, w));
        }
        if (!tip && isleHalf(sI) < 0.08) tip = point(t, sI, 0);
        const isle = ccw([...sideR, ...(tip ? [tip] : []), ...sideL.reverse()]);
        if (sideR.length > 1 && !selfIntersects(isle)) islands.push(isle);
      }
      const isle0 = islands.length ? isleHalf(ISLAND_NOSE) : 0;

      // markings on the approach
      const paint: RingApproach['paint'] = [];
      if (t.paved) {
        // edge lines along the flared edges, on from the corners' edge lines
        for (const side of [-1, 1] as const) {
          const pts: Vec2[] = [];
          for (let s = (side < 0 ? cw?.s : cc?.s) ?? 0; s <= end; s += 1) {
            const f = frame(t, s);
            pts.push(add(f.C, f.N, side * (halfWidth(t, s, f.h) - LINE_IN)));
          }
          if (pts.length > 1) paint.push({ pts, w: LINE_W });
        }
      }
      // white outline round the island; where it ends in a tip (one road, or a pair whose carriageways
      // meet) the outline meets on the centre line beyond it, hatching between, the centre line dashed on
      if (islands.length) {
        const closed = g.length === 1 || meet < end - 1;
        const sA = Math.min(end - 0.5, Math.max(t.sH, sI + t.sH - t.s1));
        const line = (s: number) => (closed ? (Math.max(t.half, isle0) + OUTLINE) * Math.max(0, (sA - s) / (sA - ISLAND_NOSE)) : 0);
        const outline = (s: number) => (s >= sA ? 0 : Math.max(line(s), s <= sI ? isleHalf(s) + OUTLINE : 0));
        const sideR: Vec2[] = [];
        const sideL: Vec2[] = [];
        const last = closed ? sA : sI;
        for (let s = ISLAND_NOSE; s < last; s += 0.5) {
          sideR.push(point(t, s, -outline(s)));
          sideL.push(point(t, s, outline(s)));
        }
        if (closed) paint.push({ pts: [...sideR, point(t, sA, 0), ...sideL.reverse()], w: LINE_W });
        else paint.push({ pts: sideR, w: LINE_W }, { pts: sideL, w: LINE_W });
        if (closed) {
          // diagonal stripes in the outline beyond the island's tip
          const wide = Math.max(t.half, isle0) + OUTLINE;
          for (let sk = sI - 2 - wide; sk < sA + wide; sk += HATCH_STEP) {
            let run: Vec2[] = [];
            const flush = () => {
              if (run.length > 1) paint.push({ pts: [run[0]!, run[run.length - 1]!], w: HATCH_W });
              run = [];
            };
            for (let x = -wide; x <= wide; x += 0.05) {
              const s = sk + 0.9 * x;
              if (s >= Math.max(ISLAND_NOSE, sI - 2) && s < sA && Math.abs(x) < outline(s) - 0.12) run.push(point(t, s, x));
              else flush();
            }
            flush();
          }
          for (let s = sA + 0.5; s + 0.5 < end; s += CENTRE_DASH + CENTRE_GAP) {
            const s2 = Math.min(end, s + CENTRE_DASH);
            paint.push({ pts: [point(t, s, 0), point(t, (s + s2) / 2, 0), point(t, s2, 0)], w: LINE_W });
          }
        }
      }

      // give-way dashes across the entering lanes, thin dashes across the exits (the outer edge line goes on)
      const dashes: Arc[] = [];
      const exits: Arc[] = [];
      const T0 = add(a.t, b.t);
      const tl = Math.hypot(T0[0], T0[1]) || 1;
      const T: Vec2 = [T0[0] / tl, T0[1] / tl];
      const w0 = frame(t, 0);
      const W0 = halfWidth(t, 0, w0.h) - LINE_IN;
      const mouth = (x0: number, x1: number): Arc | null => {
        if (x1 - x0 < 0.3) return null;
        return arcBetween(ang(onCircle(o, ro, add(w0.C, w0.N, x0), T)), ang(onCircle(o, ro, add(w0.C, w0.N, x1), T)));
      };
      // only within the opening of the outer edge line (oblique or curving arms reach a little past it)
      const gap = arcBetween(ang(cwRing), ang(ccRing));
      const push = (list: Arc[], arc: Arc | null) => {
        if (!arc) return;
        let d0 = norm(arc.a - gap.a);
        if (d0 > gap.span) d0 -= TAU;
        const lo = Math.max(0, d0);
        const hi = Math.min(gap.span, d0 + arc.span);
        if ((hi - lo) * ro > 0.3) list.push({ a: norm(gap.a + lo), span: hi - lo });
      };
      if (t.paved) {
        const oneWay = g.length === 1 && a.lap?.oneWay;
        if (oneWay) push(a.lap!.entering ? dashes : exits, mouth(-W0, W0));
        else {
          // right-hand traffic: entry on the counter-clockwise side, unless the lap's own pair says otherwise
          const entry = g.length === 2 && a.lap?.entering && !b.lap?.entering ? -1 : 1;
          const inner = Math.max(isle0, 0.2);
          push(dashes, entry > 0 ? mouth(inner, W0) : mouth(-W0, -inner));
          push(exits, entry > 0 ? mouth(-W0, -inner) : mouth(inner, W0));
        }
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
      for (const e of g) {
        if (!e.lap) continue;
        // no wall or rail where the lap's road widens into the approach
        for (const pass of e.lap.passes) {
          const rows = Math.ceil(end / c.rowLength) + 2;
          for (let q = 0; q <= rows; q++) {
            const row = (((pass.row + pass.step * q) % c.rows) + c.rows) % c.rows;
            c.openEdge(0, row, row);
            c.openEdge(1, row, row);
          }
        }
        // the ride keeps right of the island: as far right as the edges flare
        if (!islands.length) continue;
        const shift = new Float32Array(Math.ceil(end) + 1);
        for (let s = 0; s < shift.length; s++) {
          const f = frame(t, s);
          if (g.length === 1) shift[s] = halfWidth(t, s, f.h) - f.h;
          else {
            // one carriageway of a pair: the ride (0.4 m right of its line at least) clear of the island
            const l = at(e, 1, s);
            const r = at(e, -1, s);
            const side = e === a ? -1 : 1;
            const xc = side * (((l[0] + r[0]) / 2 - f.C[0]) * f.N[0] + ((l[1] + r[1]) / 2 - f.C[1]) * f.N[1]);
            shift[s] = s > sI ? 0 : Math.max(0, isleHalf(s) + OUTLINE - (xc + 0.4));
          }
        }
        for (const pass of e.lap.passes) {
          const f0 = c.frames[pass.row]!;
          lanes.push({ row: pass.row, step: pass.step, d0: (f0.x - e.p[0]) * e.t[0] + (f0.z - e.p[1]) * e.t[1], shift });
        }
      }
      const approach: RingApproach = { poly: area, islands, fillets, gap, dashes, exits, paint, reach: end };
      approaches.push(approach);
      // the terrain lies under the area (it is wider than the roads joining it)
      c.addFloor(area, (x, z) => approachHeight(c, ground, ringPlan, approach, x, z));
    });
    return ringPlan;
  });
}

/** Sideways shift (m, to the right) of the ride per corridor row: beside the splitter islands of the roundabouts. */
export function laneShifts(c: RouteCorridor, plans: RingPlan[]): Float32Array {
  const R = c.rows;
  const out = new Float32Array(R);
  for (const p of plans) {
    const { rb } = p;
    const ro = rb.r + rb.hw;
    // on the ring the shifted ride must not leave it between the approaches
    const offRing = (x: number, z: number) => {
      const d = Math.hypot(x - rb.x, z - rb.z);
      if (d < ro - 0.3 || d > ro + 3) return false;
      const t = Math.atan2(z - rb.z, x - rb.x);
      return !p.approaches.some((a) => inArc(a.gap, t));
    };
    for (const l of p.lanes) {
      const n = l.shift.length;
      for (let s = -SHIFT_IN; s < n - 1; s += c.rowLength / 2) {
        const row = (((Math.round(l.row + (l.step * (s - l.d0)) / c.rowLength)) % R) + R) % R;
        let v = s < 0 ? l.shift[0]! * smoothstep(-SHIFT_IN, 0, s) : l.shift[Math.floor(s)]! + (l.shift[Math.floor(s) + 1]! - l.shift[Math.floor(s)]!) * (s - Math.floor(s));
        if (s < 3) {
          // every rider (0.4–3 m right of the line) stays on the ring or in an approach
          const off = (lat: number) => {
            const q = c.track.positionAt(row * c.rowLength, lat + v);
            return offRing(q.x, q.z);
          };
          while (v > 0 && (off(0.4) || off(1.4) || off(3))) v -= 0.1;
          v = Math.max(0, v);
        }
        out[row] = Math.max(out[row]!, v);
      }
    }
  }
  return out;
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
