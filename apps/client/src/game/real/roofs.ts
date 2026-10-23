/**
 * Roof geometry for map footprints, independent of Babylon so it can be tested:
 * - the smallest oriented rectangle (simple houses keep a classic hip or gable roof over it),
 * - L/T/U footprints split into rectangles, each with its own roof that runs into its neighbours,
 * - a hip roof over any other footprint from its straight skeleton.
 * Footprints are counter-clockwise rings (x east, z north) as in worldData.
 */

export type P3 = [number, number, number];

/** Planar polygon; (ax, az) is the horizontal direction the texture's u axis follows. */
export interface Poly {
  pts: P3[];
  ax: number;
  az: number;
}

export interface RoofGeometry {
  /** Roof planes (eaves included). */
  roof: Poly[];
  /** Gable triangles in the wall material. */
  gables: Poly[];
}

/** Rectangle in a rotated frame: u = x·ax + z·az, v = −x·az + z·ax. */
export interface Rect {
  ax: number;
  az: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export function rectPoint(r: { ax: number; az: number }, u: number, v: number, y: number): P3 {
  return [r.ax * u - r.az * v, y, r.az * u + r.ax * v];
}

/** Signed area, positive for counter-clockwise rings. */
export function ringArea(ring: ArrayLike<number>): number {
  const n = ring.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!;
  }
  return a / 2;
}

export function pointInRing(ring: ArrayLike<number>, x: number, z: number): boolean {
  const n = ring.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]!;
    const zi = ring[i * 2 + 1]!;
    const xj = ring[j * 2]!;
    const zj = ring[j * 2 + 1]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from (x, z) to the ring outline. */
export function distanceToRing(ring: ArrayLike<number>, x: number, z: number): number {
  const n = ring.length / 2;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const x0 = ring[i * 2]!;
    const z0 = ring[i * 2 + 1]!;
    const dx = ring[((i + 1) % n) * 2]! - x0;
    const dz = ring[((i + 1) % n) * 2 + 1]! - z0;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - x0 - dx * t, z - z0 - dz * t));
  }
  return best;
}

/** Smallest bounding rectangle aligned with one of the footprint edges; u runs along the long side. */
export function orientedRect(ring: ArrayLike<number>): Rect {
  const n = ring.length / 2;
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let e = 0; e < n; e++) {
    const dx = ring[((e + 1) % n) * 2]! - ring[e * 2]!;
    const dz = ring[((e + 1) % n) * 2 + 1]! - ring[e * 2 + 1]!;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const ax = dx / len;
    const az = dz / len;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const x = ring[k * 2]!;
      const z = ring[k * 2 + 1]!;
      const u = x * ax + z * az;
      const v = -x * az + z * ax;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea) {
      bestArea = area;
      best = u1 - u0 >= v1 - v0 ? { ax, az, u0, u1, v0, v1 } : { ax: -az, az: ax, u0: v0, u1: v1, v0: -u1, v1: -u0 };
    }
  }
  return best ?? { ax: 1, az: 0, u0: 0, u1: 1, v0: 0, v1: 1 };
}

const rectArea = (r: Rect) => (r.u1 - r.u0) * (r.v1 - r.v0);

// ---------------------------------------------------------------------------------------------
// Rectilinear decomposition (L, T, U, Z footprints)

/** Edges may deviate this much (radians) from the rectangle axes and still count as orthogonal. */
const ORTHO_TOL = 0.21;
/** Coordinates closer than this collapse into one grid line. */
const SNAP = 0.45;

/**
 * Splits a nearly orthogonal footprint into at most `maxPieces` rectangles in the frame of `frame`
 * (largest rectangle first). Null when the footprint has oblique walls, the snapped outline differs
 * from the real one or a piece would be narrower than `minWidth`.
 */
export function decomposeRects(ring: ArrayLike<number>, frame: { ax: number; az: number }, maxPieces = 4, minWidth = 2.2): Rect[] | null {
  const n = ring.length / 2;
  const U: number[] = [];
  const V: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2]!;
    const z = ring[i * 2 + 1]!;
    U.push(x * frame.ax + z * frame.az);
    V.push(-x * frame.az + z * frame.ax);
  }
  // classify edges: 0 = along u (constant v), 1 = along v (constant u); short edges are ignored
  const lines: Array<{ dir: 0 | 1; c: number; w: number }> = [];
  const tan = Math.tan(ORTHO_TOL);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const du = U[j]! - U[i]!;
    const dv = V[j]! - V[i]!;
    const len = Math.hypot(du, dv);
    if (len < 0.35) continue;
    let dir: 0 | 1;
    if (Math.abs(dv) <= Math.abs(du) * tan) dir = 0;
    else if (Math.abs(du) <= Math.abs(dv) * tan) dir = 1;
    else return null;
    const c = dir === 0 ? (V[i]! + V[j]!) / 2 : (U[i]! + U[j]!) / 2;
    const last = lines[lines.length - 1];
    if (last && last.dir === dir) {
      if (Math.abs(last.c - c) > SNAP) return null;
      last.c = (last.c * last.w + c * len) / (last.w + len);
      last.w += len;
    } else lines.push({ dir, c, w: len });
  }
  if (lines.length > 1 && lines[0]!.dir === lines[lines.length - 1]!.dir) {
    const a = lines.pop()!;
    const b = lines[0]!;
    if (Math.abs(a.c - b.c) > SNAP) return null;
    b.c = (a.c * a.w + b.c * b.w) / (a.w + b.w);
    b.w += a.w;
  }
  if (lines.length < 4 || lines.length % 2 !== 0 || lines.length > 16) return null;
  // rectilinear outline: corner k joins line k and line k+1
  const poly: number[] = [];
  for (let k = 0; k < lines.length; k++) {
    const a = lines[k]!;
    const b = lines[(k + 1) % lines.length]!;
    if (a.dir === b.dir) return null;
    const u = a.dir === 1 ? a.c : b.c;
    const v = a.dir === 0 ? a.c : b.c;
    poly.push(u, v);
  }
  const cluster = (vals: number[]): number[] => {
    vals.sort((p, q) => p - q);
    const out: number[] = [];
    for (const x of vals) if (!out.length || x - out[out.length - 1]! > SNAP) out.push(x);
    return out;
  };
  const us = cluster(lines.filter((l) => l.dir === 1).map((l) => l.c));
  const vs = cluster(lines.filter((l) => l.dir === 0).map((l) => l.c));
  const snapTo = (x: number, grid: number[]) => grid.reduce((best, g) => (Math.abs(g - x) < Math.abs(best - x) ? g : best), grid[0]!);
  for (let k = 0; k < poly.length; k += 2) {
    poly[k] = snapTo(poly[k]!, us);
    poly[k + 1] = snapTo(poly[k + 1]!, vs);
  }
  const area = Math.abs(ringArea(ring));
  if (Math.abs(Math.abs(ringArea(poly)) - area) > 0.08 * area) return null;
  const nu = us.length - 1;
  const nv = vs.length - 1;
  if (nu < 1 || nv < 1) return null;
  const free = new Uint8Array(nu * nv);
  let left = 0;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      if (pointInRing(poly, (us[i]! + us[i + 1]!) / 2, (vs[j]! + vs[j + 1]!) / 2)) {
        free[i * nv + j] = 1;
        left++;
      }
    }
  }
  const pieces: Rect[] = [];
  while (left > 0) {
    if (pieces.length === maxPieces) return null;
    let best: [number, number, number, number] | null = null;
    let bestA = 0;
    for (let i0 = 0; i0 < nu; i0++) {
      for (let j0 = 0; j0 < nv; j0++) {
        if (!free[i0 * nv + j0]) continue;
        // grow to the right column by column, keeping the tallest run of free cells
        let jmax = nv;
        for (let i1 = i0; i1 < nu && free[i1 * nv + j0]; i1++) {
          let j1 = j0;
          while (j1 < jmax && free[i1 * nv + j1]) j1++;
          jmax = j1;
          const a = (us[i1 + 1]! - us[i0]!) * (vs[jmax]! - vs[j0]!);
          if (a > bestA) {
            bestA = a;
            best = [i0, i1 + 1, j0, jmax];
          }
        }
      }
    }
    if (!best) return null;
    const [i0, i1, j0, j1] = best;
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) free[i * nv + j] = 0;
    left -= (i1 - i0) * (j1 - j0);
    const r: Rect = { ax: frame.ax, az: frame.az, u0: us[i0]!, u1: us[i1]!, v0: vs[j0]!, v1: vs[j1]! };
    if (Math.min(r.u1 - r.u0, r.v1 - r.v0) < minWidth) return null;
    pieces.push(r);
  }
  return pieces;
}

// ---------------------------------------------------------------------------------------------
// Rectangle roofs

export type RoofKind = 'hip' | 'gable';

export interface RoofStyle {
  /** Rise per metre of horizontal run. */
  pitch: number;
  /** Overhang at the eaves, m. */
  eaves: number;
}

/** One rectangle of a roof: ridge along u, optionally extended past an end into the neighbouring piece. */
export interface RoofPiece {
  rect: Rect;
  /** Extension past u0 / u1 into a neighbour (0 = own wall). */
  ext0: number;
  ext1: number;
  /** The end lies inside the house (it runs into a neighbour's roof). */
  inner0: boolean;
  inner1: boolean;
}

/** Same rectangle with u and v swapped (ridge along the old v axis). */
function turned(r: Rect): Rect {
  return { ax: -r.az, az: r.ax, u0: r.v0, u1: r.v1, v0: -r.u1, v1: -r.u0 };
}

const EPS = 0.05;

/**
 * Orients the ridge of every piece and lets roofs run into the piece they are attached to by their end
 * (half their width, at most to the neighbour's far wall), so L/T/U houses get cross gables instead of
 * a valley down to the eaves.
 */
export function planPieces(pieces: Rect[]): RoofPiece[] {
  // sides: 0 = u0, 1 = u1, 2 = v0, 3 = v1. A side is attached when it lies completely on a neighbour's opposite side.
  const attach = (p: Rect, side: number): Rect | null => {
    for (const q of pieces) {
      if (q === p) continue;
      if (side < 2) {
        const c = side === 0 ? p.u0 : p.u1;
        const qc = side === 0 ? q.u1 : q.u0;
        if (Math.abs(c - qc) < EPS && p.v0 >= q.v0 - EPS && p.v1 <= q.v1 + EPS) return q;
      } else {
        const c = side === 2 ? p.v0 : p.v1;
        const qc = side === 2 ? q.v1 : q.v0;
        if (Math.abs(c - qc) < EPS && p.u0 >= q.u0 - EPS && p.u1 <= q.u1 + EPS) return q;
      }
    }
    return null;
  };
  const touches = (p: Rect, side: number): boolean =>
    pieces.some((q) => {
      if (q === p) return false;
      if (side < 2) {
        const c = side === 0 ? p.u0 : p.u1;
        const qc = side === 0 ? q.u1 : q.u0;
        return Math.abs(c - qc) < EPS && Math.min(p.v1, q.v1) - Math.max(p.v0, q.v0) > EPS;
      }
      const c = side === 2 ? p.v0 : p.v1;
      const qc = side === 2 ? q.v1 : q.v0;
      return Math.abs(c - qc) < EPS && Math.min(p.u1, q.u1) - Math.max(p.u0, q.u0) > EPS;
    });
  return pieces.map((p) => {
    const a = [0, 1, 2, 3].map((s) => attach(p, s));
    const lu = p.u1 - p.u0;
    const lv = p.v1 - p.v0;
    // ridge across the attached ends; otherwise along the long side
    const onU = !!(a[0] || a[1]);
    const onV = !!(a[2] || a[3]);
    let alongU = lu >= lv;
    if (onU && !onV && lu + lv / 2 >= lv * 0.8) alongU = true;
    else if (onV && !onU && lv + lu / 2 >= lu * 0.8) alongU = false;
    const rect = alongU ? p : turned(p);
    const half = (rect.v1 - rect.v0) / 2;
    const ext = (side: number, q: Rect | null): number => {
      if (!q) return 0;
      const depth = side < 2 ? q.u1 - q.u0 : q.v1 - q.v0;
      return Math.min(half, depth);
    };
    // turned(): the new u0 end is the old v0 side, the new u1 end the old v1 side
    const e0 = alongU ? ext(0, a[0]!) : ext(2, a[2]!);
    const e1 = alongU ? ext(1, a[1]!) : ext(3, a[3]!);
    return {
      rect,
      ext0: e0,
      ext1: e1,
      inner0: e0 > 0 || touches(p, alongU ? 0 : 2),
      inner1: e1 > 0 || touches(p, alongU ? 1 : 3),
    };
  });
}

/**
 * Roof over one piece: planes through the wall tops at `top` with overhang `eaves` along the sides.
 * Hip ends slope from the (extended) end wall; gable ends get a gable triangle and a smaller overhang.
 * Inner gable ends (inside the house) have no overhang.
 */
export function pieceRoof(piece: RoofPiece, top: number, kind: RoofKind, style: RoofStyle, out: RoofGeometry): { ridge: number } {
  const { rect: r, ext0, ext1, inner0, inner1 } = piece;
  const { pitch } = style;
  const e = style.eaves;
  const eave = top - e * pitch + 0.03;
  const w0 = r.u0 - ext0;
  const w1 = r.u1 + ext1;
  const v0 = r.v0 - e;
  const v1 = r.v1 + e;
  const half = (v1 - v0) / 2;
  const vm = (r.v0 + r.v1) / 2;
  const ridgeY = eave + half * pitch;
  if (kind === 'hip') {
    const u0 = w0 - e;
    const u1 = w1 + e;
    const ra = Math.min(u0 + half, (u0 + u1) / 2);
    const rb = Math.max(u1 - half, (u0 + u1) / 2);
    const A = rectPoint(r, u0, v0, eave);
    const B = rectPoint(r, u1, v0, eave);
    const C = rectPoint(r, u1, v1, eave);
    const D = rectPoint(r, u0, v1, eave);
    const R1 = rectPoint(r, ra, vm, ridgeY);
    const R2 = rectPoint(r, rb, vm, ridgeY);
    if (rb - ra > 0.05) {
      out.roof.push({ pts: [A, B, R2, R1], ax: r.ax, az: r.az }, { pts: [C, D, R1, R2], ax: r.ax, az: r.az });
    } else {
      out.roof.push({ pts: [A, B, R1], ax: r.ax, az: r.az }, { pts: [C, D, R1], ax: r.ax, az: r.az });
    }
    out.roof.push({ pts: [D, A, R1], ax: r.az, az: -r.ax }, { pts: [B, C, R2], ax: r.az, az: -r.ax });
    return { ridge: ridgeY };
  }
  const u0 = w0 - (inner0 ? 0 : e * 0.6);
  const u1 = w1 + (inner1 ? 0 : e * 0.6);
  const A = rectPoint(r, u0, v0, eave);
  const B = rectPoint(r, u1, v0, eave);
  const C = rectPoint(r, u1, v1, eave);
  const D = rectPoint(r, u0, v1, eave);
  const Ra = rectPoint(r, u0, vm, ridgeY);
  const Rb = rectPoint(r, u1, vm, ridgeY);
  out.roof.push({ pts: [A, B, Rb, Ra], ax: r.ax, az: r.az }, { pts: [C, D, Ra, Rb], ax: r.ax, az: r.az });
  // gable walls in the (extended) end wall plane, up to just under the roof
  const apex = ridgeY - 0.05;
  // inner ends sit inside the neighbour's roof: closed anyway, so no gap shows below the ridge.
  // Wound so the face normal (right-hand rule) points out of the house.
  out.gables.push(
    { pts: [rectPoint(r, w0, r.v0, top), rectPoint(r, w0, r.v1, top), rectPoint(r, w0, vm, apex)], ax: r.az, az: -r.ax },
    { pts: [rectPoint(r, w1, r.v1, top), rectPoint(r, w1, r.v0, top), rectPoint(r, w1, vm, apex)], ax: r.az, az: -r.ax },
  );
  return { ridge: ridgeY };
}

// ---------------------------------------------------------------------------------------------
// Straight skeleton

interface SVert {
  /** Position at time 0 (extrapolated) and velocity: p(t) = p0 + v·t. */
  px: number;
  pz: number;
  vx: number;
  vz: number;
  /** Skeleton node the vertex started from. */
  node: number;
  /** Incoming and outgoing original edge. */
  eL: number;
  eR: number;
  /** Stationary: its two edges are antiparallel (zero-width strip). */
  flat: boolean;
}

export interface SkeletonFace {
  /** Original edge index (from vertex i to i+1). */
  edge: number;
  /** Counter-clockwise polygon: x, z and the time (inset distance) at which the wavefront passed. */
  pts: Array<[number, number, number]>;
}

/**
 * Straight skeleton of a simple counter-clockwise polygon by wavefront simulation (edge and split
 * events, recomputed every step: fine for the 4–30 vertices of a house). Returns one face per edge,
 * or null for degenerate input the simulation cannot resolve.
 */
export function straightSkeleton(ring: ArrayLike<number>): SkeletonFace[] | null {
  const n = ring.length / 2;
  if (n < 3) return null;
  const X = (i: number) => ring[i * 2]!;
  const Z = (i: number) => ring[i * 2 + 1]!;
  // edges: unit direction, inward normal, line offset c (n·p = c + t at time t)
  const dx: number[] = [];
  const dz: number[] = [];
  const nx: number[] = [];
  const nz: number[] = [];
  const c: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = X(j) - X(i);
    const ez = Z(j) - Z(i);
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) return null;
    dx.push(ex / len);
    dz.push(ez / len);
    nx.push(-ez / len);
    nz.push(ex / len);
    c.push((-ez / len) * X(i) + (ex / len) * Z(i));
  }
  const nodes: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) nodes.push([X(i), Z(i), 0]);
  const arcs: Array<{ a: number; b: number; f: number[] }> = [];

  /** Vertex between edges a and b that is at (x, z) at time t. */
  const makeVert = (a: number, b: number, x: number, z: number, t: number, node: number): SVert => {
    const det = nx[a]! * nz[b]! - nz[a]! * nx[b]!;
    const dot = nx[a]! * nx[b]! + nz[a]! * nz[b]!;
    if (Math.abs(det) < 1e-7) {
      if (dot > 0) return { px: x - nx[a]! * t, pz: z - nz[a]! * t, vx: nx[a]!, vz: nz[a]!, node, eL: a, eR: b, flat: false };
      return { px: x, pz: z, vx: 0, vz: 0, node, eL: a, eR: b, flat: true };
    }
    // n_a·v = 1, n_b·v = 1
    const vx = (nz[b]! - nz[a]!) / det;
    const vz = (nx[a]! - nx[b]!) / det;
    return { px: x - vx * t, pz: z - vz * t, vx, vz, node, eL: a, eR: b, flat: false };
  };
  const pos = (v: SVert, t: number): [number, number] => (v.flat ? [v.px, v.pz] : [v.px + v.vx * t, v.pz + v.vz * t]);
  const reflex = (v: SVert) => !v.flat && dx[v.eL]! * dz[v.eR]! - dz[v.eL]! * dx[v.eR]! < -1e-9;
  const addNode = (x: number, z: number, t: number) => nodes.push([x, z, t]) - 1;
  const end = (v: SVert, node: number) => {
    if (node !== v.node) arcs.push({ a: v.node, b: node, f: [v.eL, v.eR] });
  };

  let lavs: SVert[][] = [Array.from({ length: n }, (_, i) => makeVert((i + n - 1) % n, i, X(i), Z(i), 0, i))];
  let now = 0;
  const TOL = 1e-7;

  /** Resolves stationary vertices (zero-width spikes) and tiny loops; returns the cleaned LAVs. */
  const settle = (lav: SVert[], t: number): SVert[] | null => {
    for (let guard = 0; guard < 64; guard++) {
      if (lav.length <= 2) {
        if (lav.length === 2) {
          const [a, b] = lav as [SVert, SVert];
          const pa = pos(a, t);
          const pb = pos(b, t);
          const na = addNode(pa[0], pa[1], t);
          const nb = addNode(pb[0], pb[1], t);
          end(a, na);
          end(b, nb);
          arcs.push({ a: na, b: nb, f: [a.eR, b.eR] });
        }
        return null;
      }
      const k = lav.findIndex((v) => v.flat);
      if (k < 0) return lav;
      const v = lav[k]!;
      const prev = lav[(k + lav.length - 1) % lav.length]!;
      const next = lav[(k + 1) % lav.length]!;
      const pp = pos(prev, t);
      const pn = pos(next, t);
      const dp = Math.hypot(pp[0] - v.px, pp[1] - v.pz);
      const dn = Math.hypot(pn[0] - v.px, pn[1] - v.pz);
      if (Math.abs(dp - dn) < 1e-5) {
        const node = addNode(pp[0], pp[1], t);
        end(v, node);
        end(prev, node);
        end(next, node);
        const m = makeVert(prev.eL, next.eR, pp[0], pp[1], t, node);
        lav = replace(lav, [prev, v, next], m);
      } else if (dp < dn) {
        const node = addNode(pp[0], pp[1], t);
        end(v, node);
        end(prev, node);
        const m = makeVert(prev.eL, v.eR, pp[0], pp[1], t, node);
        lav = replace(lav, [prev, v], m);
      } else {
        const node = addNode(pn[0], pn[1], t);
        end(v, node);
        end(next, node);
        const m = makeVert(v.eL, next.eR, pn[0], pn[1], t, node);
        lav = replace(lav, [v, next], m);
      }
    }
    return null;
  };
  /** Replaces consecutive vertices `gone` (in order) by m. */
  const replace = (lav: SVert[], gone: SVert[], m: SVert): SVert[] => {
    const i = lav.indexOf(gone[0]!);
    const out: SVert[] = [];
    for (let k = 0; k < lav.length; k++) {
      const v = lav[(i + k) % lav.length]!;
      if (k === 0) out.push(m);
      else if (!gone.includes(v)) out.push(v);
    }
    return out;
  };
  for (let iter = 0; iter < 20 * n && lavs.length; iter++) {
    let best = Infinity;
    let ev: { kind: 0 | 1; lav: number; a: number; b: number; x: number; z: number } | null = null;
    lavs.forEach((lav, li) => {
      const m = lav.length;
      for (let i = 0; i < m; i++) {
        const a = lav[i]!;
        const b = lav[(i + 1) % m]!;
        const e = a.eR;
        const ddx = dx[e]!;
        const ddz = dz[e]!;
        const pa = pos(a, 0);
        const pb = pos(b, 0);
        const va = a.flat ? 0 : a.vx * ddx + a.vz * ddz;
        const vb = b.flat ? 0 : b.vx * ddx + b.vz * ddz;
        const den = va - vb;
        let t: number;
        if (a.flat || b.flat) {
          // flat vertices are resolved by settle(); never here
          continue;
        }
        if (den > 1e-9) t = ((pb[0] - pa[0]) * ddx + (pb[1] - pa[1]) * ddz) / den;
        else continue;
        if (t < now - 1e-6 || t >= best - TOL) continue;
        t = Math.max(t, now);
        const p = pos(a, t);
        best = t;
        ev = { kind: 0, lav: li, a: i, b: (i + 1) % m, x: p[0], z: p[1] };
      }
      for (let i = 0; i < m; i++) {
        const v = lav[i]!;
        if (!reflex(v)) continue;
        for (let j = 0; j < m; j++) {
          const y = lav[j]!;
          const zv = lav[(j + 1) % m]!;
          if (y === v || zv === v) continue;
          const e = y.eR;
          const den = nx[e]! * v.vx + nz[e]! * v.vz - 1;
          if (den > -1e-9) continue;
          let t = (c[e]! - nx[e]! * v.px - nz[e]! * v.pz) / den;
          if (t < now - 1e-6 || t >= best - TOL) continue;
          t = Math.max(t, now);
          const p = pos(v, t);
          const py = pos(y, t);
          const pz = pos(zv, t);
          const s = (p[0] - py[0]) * dx[e]! + (p[1] - py[1]) * dz[e]!;
          const s2 = (pz[0] - p[0]) * dx[e]! + (pz[1] - p[1]) * dz[e]!;
          if (s < -1e-6 || s2 < -1e-6) continue;
          best = t;
          ev = { kind: 1, lav: li, a: i, b: j, x: p[0], z: p[1] };
        }
      }
    });
    const event = ev as { kind: 0 | 1; lav: number; a: number; b: number; x: number; z: number } | null;
    if (!event) return null;
    now = best;
    const lav = lavs[event.lav]!;
    const others = lavs.filter((_, i) => i !== event.lav);
    const node = addNode(event.x, event.z, now);
    const next: SVert[][] = [];
    if (event.kind === 0) {
      const a = lav[event.a]!;
      const b = lav[event.b]!;
      end(a, node);
      end(b, node);
      if (lav.length === 3) {
        const o = lav.find((v) => v !== a && v !== b)!;
        end(o, node);
      } else {
        const m = makeVert(a.eL, b.eR, event.x, event.z, now, node);
        next.push(replace(lav, [a, b], m));
      }
    } else {
      const v = lav[event.a]!;
      const y = lav[event.b]!;
      end(v, node);
      const e = y.eR;
      const v1 = makeVert(v.eL, e, event.x, event.z, now, node);
      const v2 = makeVert(e, v.eR, event.x, event.z, now, node);
      const m = lav.length;
      const iv = event.a;
      const iy = event.b;
      // loop 1: v1, y+1 ... v-1 ; loop 2: v2, v+1 ... y
      const l1: SVert[] = [v1];
      for (let k = (iy + 1) % m; k !== iv; k = (k + 1) % m) l1.push(lav[k]!);
      const l2: SVert[] = [v2];
      for (let k = (iv + 1) % m; k !== (iy + 1) % m; k = (k + 1) % m) l2.push(lav[k]!);
      next.push(l1, l2);
    }
    lavs = others;
    for (const l of next) {
      const s = settle(l, now);
      if (s) lavs.push(s);
    }
  }
  if (lavs.length) return null;

  // merge coincident nodes
  const canon: number[] = nodes.map((_, i) => i);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = 0; j < i; j++) {
      if (canon[j] !== j) continue;
      if (Math.abs(nodes[i]![0] - nodes[j]![0]) < 1e-4 && Math.abs(nodes[i]![1] - nodes[j]![1]) < 1e-4) {
        canon[i] = j;
        break;
      }
    }
  }
  const faces: SkeletonFace[] = [];
  let total = 0;
  for (let e = 0; e < n; e++) {
    const own = arcs
      .filter((a) => a.f.includes(e))
      .map((a) => ({ a: canon[a.a]!, b: canon[a.b]! }))
      .filter((a) => a.a !== a.b);
    const start = canon[e]!;
    let prev = start;
    let cur = canon[(e + 1) % n]!;
    const loop = [start, cur];
    const used = new Set<number>();
    let ok = false;
    for (let guard = 0; guard < own.length + 2; guard++) {
      const p = nodes[prev]!;
      const q = nodes[cur]!;
      const inx = q[0] - p[0];
      const inz = q[1] - p[1];
      let pick = -1;
      let pickTurn = Infinity;
      own.forEach((arc, k) => {
        if (used.has(k)) return;
        const other = arc.a === cur ? arc.b : arc.b === cur ? arc.a : -1;
        if (other < 0) return;
        const r = nodes[other]!;
        const ox = r[0] - q[0];
        const oz = r[1] - q[1];
        // rightmost turn keeps the face (on the left) on the inside
        const turn = Math.atan2(inx * oz - inz * ox, inx * ox + inz * oz);
        if (turn < pickTurn) {
          pickTurn = turn;
          pick = k;
        }
      });
      if (pick < 0) break;
      used.add(pick);
      const arc = own[pick]!;
      const other = arc.a === cur ? arc.b : arc.a;
      if (other === start) {
        ok = true;
        break;
      }
      loop.push(other);
      prev = cur;
      cur = other;
    }
    if (!ok) return null;
    const pts = loop.map((k) => [nodes[k]![0], nodes[k]![1], nodes[k]![2]] as [number, number, number]);
    const flat: number[] = [];
    for (const p of pts) flat.push(p[0], p[1]);
    const a = ringArea(flat);
    if (a < -1e-6) return null;
    total += a;
    faces.push({ edge: e, pts });
  }
  const area = ringArea(ring);
  if (Math.abs(total - area) > 0.01 * area + 1e-6) return null;
  return faces;
}

/**
 * Hip roof over any footprint from its straight skeleton, with mitred eaves. Null when the skeleton
 * fails or the roof would rise higher than `maxRise` (very deep buildings get a flat roof instead).
 */
export function skeletonRoof(ring: ArrayLike<number>, top: number, style: RoofStyle, maxRise = 6.5): RoofGeometry | null {
  const faces = straightSkeleton(ring);
  if (!faces) return null;
  const { pitch, eaves: e } = style;
  let maxT = 0;
  for (const f of faces) for (const p of f.pts) maxT = Math.max(maxT, p[2]);
  if (maxT * pitch > maxRise) return null;
  const n = ring.length / 2;
  const out: RoofGeometry = { roof: [], gables: [] };
  const dir = (i: number): [number, number] => {
    const j = (i + 1) % n;
    const ex = ring[j * 2]! - ring[i * 2]!;
    const ez = ring[j * 2 + 1]! - ring[i * 2 + 1]!;
    const l = Math.hypot(ex, ez) || 1;
    return [ex / l, ez / l];
  };
  for (const f of faces) {
    const [ax, az] = dir(f.edge);
    out.roof.push({ pts: f.pts.map(([x, z, t]) => [x, top + t * pitch + 0.03, z] as P3), ax, az });
  }
  // eaves: each edge's plane continued outward by e, mitred at the corners
  const miter: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const [ax0, az0] = dir((i + n - 1) % n);
    const [ax1, az1] = dir(i);
    // outward normals
    const n0x = az0;
    const n0z = -ax0;
    const n1x = az1;
    const n1z = -ax1;
    const k = 1 + n0x * n1x + n0z * n1z;
    let mx = (n0x + n1x) / Math.max(k, 1e-6);
    let mz = (n0z + n1z) / Math.max(k, 1e-6);
    const len = Math.hypot(mx, mz);
    if (len > 2.5) {
      mx *= 2.5 / len;
      mz *= 2.5 / len;
    }
    miter.push([ring[i * 2]! + mx * e, ring[i * 2 + 1]! + mz * e]);
  }
  const eave = top - e * pitch + 0.03;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ax, az] = dir(i);
    out.roof.push({
      pts: [
        [ring[i * 2]!, top + 0.03, ring[i * 2 + 1]!],
        [ring[j * 2]!, top + 0.03, ring[j * 2 + 1]!],
        [miter[j]![0], eave, miter[j]![1]],
        [miter[i]![0], eave, miter[i]![1]],
      ],
      ax,
      az,
    });
  }
  return out;
}
