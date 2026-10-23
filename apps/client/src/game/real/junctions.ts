/**
 * Junction areas where side roads meet the ride's road or each other (osm2streets style): the edges of
 * neighbouring arms are intersected and the corners rounded, the arms end exactly where the area
 * begins. Planned once per world, before the terrain and the ribbon are built (mouths open walls and
 * guardrails); the meshes come from sideRoads.ts. Babylon-free so the tests can check the outlines.
 */
import { smoothstep } from '../noise';
import { ROW_STRIDE, SHOULDER, VERGE_OUT, type RouteCorridor, type RouteHit } from './corridor';
import { triSample } from './heightField';
import { junctionOutline, selfIntersects, subdivide, triangulate, type Arm, type Vec2 } from './roadGeometry';
import { ringCut } from './roundaboutPlan';
import { ROAD_JOIN, type SideRoad, type WorldGrid } from './worldData';

/** Side roads float this far above the ground they are draped on. */
export const SIDE_LIFT = 0.12;

/** Arms meeting the ride's road at less than this angle (rad) get no mouth (they merge, see the ribbon). */
const MIN_MOUTH_ANGLE = (20 / 180) * Math.PI;
/** The arm's own road starts this far outside the ride's shoulder at the least (its height blend ends there). */
export const MOUTH_OUT = 3;
/** Arms longer than this from a junction are cut at most this far from the node. */
const MAX_CUT = 30;
/** Distance along an arm used for its direction at the node, m. */
const DIR_SPAN = 8;
/** Paved side roads at least this wide get a give-way line at the ride's road. */
export const GIVE_WAY_WIDTH = 4.5;

/** Where a side road meets the ride's road, in lap coordinates of the drawn pass (see `toWorld`). */
export interface Mouth {
  /** Lap distance of the node, m (any lap), and which side of the road (1 right, -1 left). */
  s0: number;
  sg: number;
  row: number;
  /** Half width of the asphalt and the edge of the shoulder at the node. */
  hw: number;
  edge: number;
  /** Outline in local coordinates: x along the lap (away from the node, mirrored on the left), y out from the centre line. */
  poly: Vec2[];
  /** Arms: road index, which end, direction (local), half width, paved. */
  arms: Array<{ road: number; end: 0 | 1; dir: Vec2; hw: number; paved: boolean; cut: number }>;
  /** Per outline point: the exact world x/z of an arm's first cross section (null = mapped from local). */
  fixed: Array<Vec2 | null>;
}

/** Where side roads meet each other: outline around the node in world x/z. */
export interface NodePatch {
  x: number;
  z: number;
  poly: Vec2[];
  paved: boolean;
}

export interface JunctionPlan {
  mouths: Mouth[];
  nodes: NodePatch[];
  /** Per road: metres cut off at its start and its end (the junction area covers them). */
  cuts: Float32Array;
  /** Per road: 1 when an end belongs to a mouth (the arm then gets no flared end of its own). */
  mouthed: Uint8Array;
  /** Per road: direction (x, z along the polyline) of the first and the last cross section where a junction area takes over; NaN = free. */
  tans: Float32Array;
}

/** Cross section of a side road `d` metres from one end: unit tangent along the polyline (start → end) and the corners as sideRoads.ts draws them. */
export function crossSection(road: SideRoad, end: 0 | 1, d: number, len: number): { tx: number; tz: number; left: Vec2; right: Vec2 } {
  const p = alongPolyline(road.pts, end, d);
  let q = alongPolyline(road.pts, end, Math.min(len, d + 2));
  let sgn = 1;
  if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.2) {
    q = alongPolyline(road.pts, end, Math.max(0, d - 2));
    sgn = -1;
  }
  const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  // away from the node, then along the polyline
  const ax = (sgn * (q[0] - p[0])) / l;
  const az = (sgn * (q[1] - p[1])) / l;
  const tx = end === 0 ? ax : -ax;
  const tz = end === 0 ? az : -az;
  const hw = road.width / 2;
  return { tx, tz, left: [p[0] - tz * hw, p[1] + tx * hw], right: [p[0] + tz * hw, p[1] - tx * hw] };
}

/** Replaces the outline points `a` and `b` by the local points `la`/`lb` (whichever pairing is closer), remembering their world positions. */
function stitch(poly: Vec2[], fixed: Array<Vec2 | null>, a: Vec2, b: Vec2, la: Vec2, lb: Vec2, wa: Vec2, wb: Vec2): boolean {
  const ia = poly.findIndex((p) => Math.hypot(p[0] - a[0], p[1] - a[1]) < 1e-6);
  const ib = poly.findIndex((p) => Math.hypot(p[0] - b[0], p[1] - b[1]) < 1e-6);
  if (ia < 0 || ib < 0) return false;
  const d = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const swap = d(la, a) + d(lb, b) > d(lb, a) + d(la, b);
  poly[ia] = swap ? lb : la;
  poly[ib] = swap ? la : lb;
  fixed[ia] = swap ? wb : wa;
  fixed[ib] = swap ? wa : wb;
  return true;
}

/** Arm end corners of an outline (local), as junctionOutline places them: right, left. */
function armEnds(arm: Arm, cut: number): [Vec2, Vec2] {
  const [dx, dz] = arm.dir;
  return [
    [dz * arm.hw + dx * cut, -dx * arm.hw + dz * cut],
    [-dz * arm.hw + dx * cut, dx * arm.hw + dz * cut],
  ];
}

/** Triangles of a mouth in world space (subdivided so the area follows the ground), heights as drawn. */
export function mouthMesh(c: RouteCorridor, ground: (x: number, z: number) => number, m: Mouth): { pts: Array<[number, number, number]>; tris: number[] } {
  const sub = subdivide(m.poly, triangulate(m.poly), 2);
  const pts = sub.pts.map((p, k): [number, number, number] => {
    const f = k < m.fixed.length ? m.fixed[k] : null;
    return f ? [f[0], ground(f[0], f[1]) + SIDE_LIFT, f[1]] : mouthPoint(c, ground, m, p);
  });
  return { pts, tris: sub.tris };
}

/** Triangles of a junction of side roads in world space. */
export function nodeMesh(ground: (x: number, z: number) => number, n: NodePatch): { pts: Array<[number, number, number]>; tris: number[] } {
  const sub = subdivide(n.poly, triangulate(n.poly), 2);
  return {
    pts: sub.pts.map(([px, pz]): [number, number, number] => [n.x + px, ground(n.x + px, n.z + pz) + SIDE_LIFT + 0.02, n.z + pz]),
    tris: sub.tris,
  };
}

/** Point `d` metres along a polyline from its start (end = 0) or from its end (end = 1). */
export function alongPolyline(pts: Float32Array, end: 0 | 1, d: number): Vec2 {
  const n = pts.length / 2;
  const at = (k: number): Vec2 => (end === 0 ? [pts[2 * k]!, pts[2 * k + 1]!] : [pts[2 * (n - 1 - k)]!, pts[2 * (n - 1 - k) + 1]!]);
  let left = d;
  for (let k = 0; k < n - 1; k++) {
    const a = at(k);
    const b = at(k + 1);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len >= left && len > 0) return [a[0] + ((b[0] - a[0]) * left) / len, a[1] + ((b[1] - a[1]) * left) / len];
    left -= len;
  }
  return at(n - 1);
}

export function polylineLength(pts: Float32Array): number {
  let len = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) len += Math.hypot(pts[k + 2]! - pts[k]!, pts[k + 3]! - pts[k + 1]!);
  return len;
}

/** Corner radius of a junction by the arm: forest and field tracks are tight, streets wider (3–8 m). */
function cornerRadius(road: SideRoad): number {
  return road.track ? 3 : Math.min(8, Math.max(4, road.width));
}

/** Local mouth coordinates → lap distance and signed lateral offset. */
export function mouthToLap(m: Mouth, p: Vec2): { s: number; o: number } {
  return { s: m.s0 + m.sg * p[0], o: m.sg * p[1] };
}

/** Width over which the profiles of two passes are blended at the line halfway between them. */
const PASS_BLEND = 6;
/** The ride's verge fades into the elevation model over the last metres of its reach. */
const FADE_OUT = 4;

/**
 * Ground under side roads: the ride's verge profile near the lap, the elevation model elsewhere.
 * Continuous everywhere, so side roads and junction areas built on it have no steps.
 */
export function sideRoadGround(c: RouteCorridor, g: WorldGrid): (x: number, z: number) => number {
  const R = c.rows;
  // only drawn passes: where the lap runs twice, the covered pass may have a wall on this side
  const drawn = (i: number) => !c.covered[Math.round(i / ROW_STRIDE) % R];
  const along = (x: number, z: number, hit: RouteHit, dem: number) => {
    const side = hit.offset >= 0 ? 1 : 0;
    const o = Math.abs(hit.offset);
    // between the two neighbouring rows, as the ribbon's verge quads do (profiles change per row,
    // e.g. from an embankment to a cut, which would otherwise be a step halfway between them)
    const u = c.lapCoords(x, z, hit.i).s / c.rowLength;
    const r0 = Math.floor(u);
    const ra = ((r0 % R) + R) % R;
    const rb = (ra + 1) % R;
    let y: number;
    if (c.covered[ra] || c.covered[rb]) y = c.profile(hit.row, side, o, dem, hit.y);
    else {
      const t = Math.min(1, Math.max(0, u - r0));
      y = c.profile(ra, side, o, dem, hit.y) * (1 - t) + c.profile(rb, side, o, dem, hit.y) * t;
    }
    return y + (dem - y) * smoothstep(VERGE_OUT - FADE_OUT, VERGE_OUT, hit.dist);
  };
  return (x, z) => {
    const dem = triSample(g.heights, g.nx, (x - g.x0) / g.step, (z - g.z0) / g.step);
    const hit = c.nearest(x, z, VERGE_OUT, drawn);
    if (!hit) return dem;
    const y = along(x, z, hit, dem);
    // another pass of the lap close by: blend towards its profile near the line halfway between them
    const other = c.nearest(x, z, Math.min(VERGE_OUT, hit.dist + PASS_BLEND), (i) => drawn(i) && c.lapGap(hit.i, i) > 30);
    if (!other) return y;
    const w = 0.5 * (1 - smoothstep(0, PASS_BLEND, other.dist - hit.dist));
    return y + (along(x, z, other, dem) - y) * w;
  };
}

/**
 * World position of a point of a mouth (local coordinates): on the asphalt just above the ride's road,
 * outside its edge blending into the side road's own height (complete MOUTH_OUT beyond the shoulder).
 */
export function mouthPoint(c: RouteCorridor, ground: (x: number, z: number) => number, m: Mouth, p: Vec2, dy = 0): [number, number, number] {
  const { s, o } = mouthToLap(m, p);
  const at = c.pointAt(s, o);
  const lo = p[1];
  const yr = at.y + 0.035 * (1 - Math.min(1, (lo / m.hw) ** 2)) + 0.025;
  const ys = ground(at.x, at.z) + SIDE_LIFT;
  return [at.x, yr + (ys - yr) * smoothstep(m.hw, m.edge + MOUTH_OUT, lo) + dy, at.z];
}

export function planJunctions(roads: SideRoad[], c: RouteCorridor): JunctionPlan {
  const cuts = new Float32Array(roads.length * 2);
  const mouthed = new Uint8Array(roads.length);
  const tans = new Float32Array(roads.length * 4).fill(NaN);
  const lengths = roads.map((r) => polylineLength(r.pts));
  const drawn = (j: number) => !c.covered[Math.round(j / ROW_STRIDE) % c.rows];

  // ---- side roads meeting the ride's road
  interface Pending { s0: number; sg: number; row: number; arms: Mouth['arms'] }
  const groups: Pending[] = [];
  roads.forEach((road, ri) => {
    for (const end of [0, 1] as const) {
      // ends on a roundabout stop at its outer edge (the ring is drawn by roundabouts.ts)
      const ring = ringCut(c, road, end);
      if (ring) {
        const cs = crossSection(road, end, ring.cut, lengths[ri]!);
        cuts[ri * 2 + end] = ring.cut;
        tans[ri * 4 + end * 2] = cs.tx;
        tans[ri * 4 + end * 2 + 1] = cs.tz;
        mouthed[ri] = 1;
        continue;
      }
      if (!(road.joins & (end === 0 ? ROAD_JOIN.lapStart : ROAD_JOIN.lapEnd))) continue;
      const len = lengths[ri]!;
      if (len < 2) continue;
      const p = alongPolyline(road.pts, end, 0);
      const q = alongPolyline(road.pts, end, Math.min(DIR_SPAN, len / 2));
      const hit = c.nearest(p[0], p[1], 6, drawn);
      if (!hit) continue;
      const a = c.lapCoords(p[0], p[1], hit.i);
      const b = c.lapCoords(q[0], q[1], hit.i);
      const ds = b.s - a.s;
      const dov = b.o - a.o;
      const dl = Math.hypot(ds, dov);
      if (dl < 1e-3) continue;
      const sg = dov >= 0 ? 1 : -1;
      // local frame: x along the lap (mirrored on the left side), y outwards
      const dir: Vec2 = [(sg * ds) / dl, Math.abs(dov) / dl];
      if (Math.asin(Math.min(1, dir[1])) < MIN_MOUTH_ANGLE) continue;
      const s0 = a.s;
      const arm = { road: ri, end, dir, hw: road.width / 2, paved: !road.track, cut: 0 };
      const g = groups.find((x) => x.sg === sg && Math.abs(x.s0 - s0) < 3);
      if (g) g.arms.push(arm);
      else groups.push({ s0, sg, row: hit.row, arms: [arm] });
    }
  });

  const mouths: Mouth[] = [];
  for (const g of groups) {
    const side = g.sg > 0 ? 1 : 0;
    const hw = c.hw[side]![g.row]!;
    const edge = hw + SHOULDER;
    const radius = Math.max(...g.arms.map((a) => cornerRadius(roads[a.road]!)));
    g.arms.sort((a, b) => Math.atan2(a.dir[1], a.dir[0]) - Math.atan2(b.dir[1], b.dir[0]));
    const arms: Arm[] = [
      { dir: [1, 0], hw: edge, radius, through: true },
      ...g.arms.map((a) => ({
        dir: a.dir,
        hw: a.hw,
        radius: cornerRadius(roads[a.road]!),
        // the arm's own road starts outside the shoulder, where the mouth's height blend is complete
        minCut: (edge + MOUTH_OUT + a.hw * Math.abs(a.dir[0])) / a.dir[1],
      })),
      { dir: [-1, 0], hw: edge, radius, through: true },
    ];
    const out = junctionOutline(arms, 0.92 * hw);
    if (out.poly.length < 4 || selfIntersects(out.poly)) continue;
    // an arm too short for its share of the area (or a very flat one) keeps its plain end
    if (g.arms.some((a, k) => out.cut[k + 1]! > Math.min(MAX_CUT, lengths[a.road]! - 0.5))) continue;
    // the arms end in their real cross sections (they curve, the lap curves): stitch those into the outline
    const fixed: Array<Vec2 | null> = out.poly.map(() => null);
    const toLocal = (w: Vec2, guess: Vec2): Vec2 => {
      const l = c.lapCoordsAt(w[0], w[1], g.s0 + g.sg * guess[0], g.sg * guess[1]);
      return [g.sg * (l.s - g.s0), g.sg * l.o];
    };
    const stitched = g.arms.every((a, k) => {
      const cut = out.cut[k + 1]!;
      const cs = crossSection(roads[a.road]!, a.end, cut, lengths[a.road]!);
      const [ea, eb] = armEnds(arms[k + 1]!, cut);
      return stitch(out.poly, fixed, ea, eb, toLocal(cs.right, ea), toLocal(cs.left, eb), cs.right, cs.left);
    });
    if (!stitched || selfIntersects(out.poly)) continue;
    g.arms.forEach((a, k) => {
      a.cut = out.cut[k + 1]!;
      cuts[a.road * 2 + a.end] = a.cut;
      const cs = crossSection(roads[a.road]!, a.end, a.cut, lengths[a.road]!);
      tans[a.road * 4 + a.end * 2] = cs.tx;
      tans[a.road * 4 + a.end * 2 + 1] = cs.tz;
      mouthed[a.road] = 1;
    });
    const m: Mouth = { s0: g.s0, sg: g.sg, row: g.row, hw, edge, poly: out.poly, arms: g.arms, fixed };
    mouths.push(m);
    // no wall, rail or parapet across the mouth
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of out.poly) {
      const s = mouthToLap(m, p).s;
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    c.openEdge(side, Math.floor(lo / c.rowLength) - 1, Math.ceil(hi / c.rowLength) + 1);
  }

  // ---- side roads meeting each other
  const ends = new Map<string, Array<{ road: number; end: 0 | 1 }>>();
  roads.forEach((road, ri) => {
    for (const end of [0, 1] as const) {
      if (!(road.joins & (end === 0 ? ROAD_JOIN.roadStart : ROAD_JOIN.roadEnd))) continue;
      const p = alongPolyline(road.pts, end, 0);
      const key = `${Math.round(p[0] * 5)},${Math.round(p[1] * 5)}`;
      let list = ends.get(key);
      if (!list) ends.set(key, (list = []));
      list.push({ road: ri, end });
    }
  });
  const nodes: NodePatch[] = [];
  for (const list of ends.values()) {
    if (list.length < 3) continue;
    const first = list[0]!;
    const [x, z] = alongPolyline(roads[first.road]!.pts, first.end, 0);
    // close to the ride's road the mouths take over
    if (c.nearest(x, z, 12)) continue;
    if (list.some((e) => cuts[e.road * 2 + e.end]! > 0)) continue;
    const arms = list
      .map((e) => {
        const road = roads[e.road]!;
        const q = alongPolyline(road.pts, e.end, Math.min(DIR_SPAN, lengths[e.road]! / 2));
        const l = Math.hypot(q[0] - x, q[1] - z) || 1;
        return { e, arm: { dir: [(q[0] - x) / l, (q[1] - z) / l] as Vec2, hw: road.width / 2, radius: road.track ? 2 : 3 } as Arm };
      })
      .sort((a, b) => Math.atan2(a.arm.dir[1], a.arm.dir[0]) - Math.atan2(b.arm.dir[1], b.arm.dir[0]));
    const out = junctionOutline(arms.map((a) => a.arm));
    if (out.poly.length < 4 || selfIntersects(out.poly)) continue;
    // both ends of a short road may end in junctions: each gets at most half of it
    if (arms.some((a, k) => out.cut[k]! > lengths[a.e.road]! / 2 - 0.25 || cuts[a.e.road * 2 + a.e.end]! > 0)) continue;
    const fixed: Array<Vec2 | null> = out.poly.map(() => null);
    const rel = (w: Vec2): Vec2 => [w[0] - x, w[1] - z];
    const stitched = arms.every((a, k) => {
      const cs = crossSection(roads[a.e.road]!, a.e.end, out.cut[k]!, lengths[a.e.road]!);
      const [ea, eb] = armEnds(a.arm, out.cut[k]!);
      return stitch(out.poly, fixed, ea, eb, rel(cs.right), rel(cs.left), cs.right, cs.left);
    });
    if (!stitched || selfIntersects(out.poly)) continue;
    arms.forEach((a, k) => {
      const cs = crossSection(roads[a.e.road]!, a.e.end, out.cut[k]!, lengths[a.e.road]!);
      cuts[a.e.road * 2 + a.e.end] = out.cut[k]!;
      tans[a.e.road * 4 + a.e.end * 2] = cs.tx;
      tans[a.e.road * 4 + a.e.end * 2 + 1] = cs.tz;
    });
    nodes.push({ x, z, poly: out.poly, paved: list.some((e) => !roads[e.road]!.track) });
  }
  return { mouths, nodes, cuts, mouthed, tans };
}
