/**
 * Roundabouts: the ring carriageway around a central island, its heights along the ring and where roads
 * join it (gaps in the outer edge line, give-way dashes across the entering lanes). The ride's rows on
 * a ring are drawn as plain asphalt under the ring (corridor.ts); side roads end at its outer edge.
 * Babylon-free so the tests can check the plan; the meshes come from roundabouts.ts.
 */
import { SIDE_LIFT, alongPolyline, crossSection, polylineLength } from './junctions';
import { ROW_STRIDE, type RouteCorridor } from './corridor';
import type { Vec2 } from './roadGeometry';
import type { Roundabout, SideRoad } from './worldData';

/** Side roads end this far inside the ring's outer edge (tucked under the ring). */
export const RING_TUCK = 0.3;
/** Road ends this far (m) outside the outer edge still belong to the ring. */
const RING_CATCH = 2;
/** Angular step of the ring mesh, m along the centre line. */
const RING_STEP = 1;

/** Angular interval [a, a + span] (rad, span < 2π). */
export interface Arc {
  a: number;
  span: number;
}

export interface RingArm {
  /** Interruption of the outer edge line (the whole width of the joining road). */
  gap: Arc;
  /** Give-way dashes across the lane entering the ring (null = exit only). */
  dashes: Arc | null;
}

export interface RingPlan {
  rb: Roundabout;
  /** Ring height per angular step k (angle 2πk/n), m. */
  ys: Float32Array;
  /** Whether the ride runs on the ring at step k. */
  ridden: Uint8Array;
  arms: RingArm[];
}

const TAU = Math.PI * 2;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

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
    const out = rb.r + rb.hw - RING_TUCK;
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

/**
 * Plans every roundabout: heights (the ride's height where it runs on the ring, elsewhere the ground
 * the side roads lie on, smoothly joined) and the arms joining it, from the lap and the side roads.
 */
export function planRoundabouts(c: RouteCorridor, roads: SideRoad[], ground: (x: number, z: number) => number): RingPlan[] {
  const R = c.rows;
  return c.roundabouts.map((rb, k) => {
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
    const anchors = [...ridden.keys()].filter((q) => ridden[q]);
    if (anchors.length === 0) ys.set(own);
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
        const lin = ys[a]! + ((ys[b]! - ys[a]!) * da) / (da + db);
        ys[q] = lin;
      }
    }
    // smooth all round: the free stretches meet the ridden ones without a kink, and where passes of
    // the lap at slightly different heights touch the ring they are evened out (a few cm)
    for (let pass = 0; pass < 6; pass++) {
      const prev = ys.slice();
      for (let q = 0; q < n; q++) ys[q] = (prev[(q - 1 + n) % n]! + 2 * prev[q]! + prev[(q + 1) % n]!) / 4;
    }

    const ang = (p: Vec2) => Math.atan2(p[1] - rb.z, p[0] - rb.x);
    const arms: RingArm[] = [];
    // the ride entering and leaving the ring
    for (let r = 0; r < R; r++) {
      const here = c.ring[r] === k + 1;
      const before = c.ring[(r - 1 + R) % R] === k + 1;
      if (here === before) continue;
      // the last row off the ring
      const f = c.frames[here ? (r - 1 + R) % R : r]!;
      const at = (o: number): Vec2 => [f.x + f.rx * o, f.z + f.rz * o];
      const left = ang(at(-c.hw[0]![r]!));
      const right = ang(at(c.hw[1]![r]!));
      const mid = ang(at(0));
      const split = c.twin[r] === 2 || c.twin[(r - 1 + R) % R] === 2;
      arms.push({
        gap: arcBetween(left, right),
        // entering: the right-hand lane; leaving: the other direction's lane, which enters here
        dashes: split ? (here ? arcBetween(left, right) : null) : here ? arcBetween(mid, right) : arcBetween(left, mid),
      });
    }
    // side roads ending on the ring
    roads.forEach((road) => {
      for (const end of [0, 1] as const) {
        const hit = ringCut(c, road, end);
        if (!hit || hit.k !== k) continue;
        const cs = crossSection(road, end, hit.cut, polylineLength(road.pts));
        const p = alongPolyline(road.pts, end, hit.cut);
        const t = ang(p);
        // already part of the ride's arm (the side road runs along the lap)
        if (arms.some((a) => inArc(a.gap, t))) continue;
        // left of the way out = right of the way in
        arms.push({ gap: arcBetween(ang(cs.left), ang(cs.right)), dashes: road.track ? null : arcBetween(ang(p), ang(cs.left)) });
      }
    });
    return { rb, ys, ridden, arms };
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
