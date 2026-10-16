import { createRng } from '../../noise';
import type { CrownShape, GeomPart, SpeciesParams, TreeGeometry } from './types';

/** Procedural tree: wood tubes and leaf cards from one species table. No Babylon dependency, so it is testable. */

type V3 = [number, number, number];

/** Triangle budget per tree (near trees, see docs/REALISM_PLAN.md P3.2). */
export const MAX_TRIANGLES = 6000;
const SEG_TRUNK = 0.6;
const SEG_BRANCH = 0.35;
const TAU = Math.PI * 2;
const DOWN: V3 = [0, -1, 0];
/** Branches around the trunk follow the golden angle, so no two neighbours point the same way. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** Most segments per branch tube by level: thin twigs need few, the budget goes to the leaves. */
const MAX_SEGMENTS = [0, 5, 3, 2];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const fract = (x: number): number => x - Math.floor(x);

/** Accumulates vertex data for one part. */
class Builder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly uv2: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vertex(p: V3, n: V3, u: number, v: number, wind: number, phase: number, brightness: number): void {
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.uv2.push(clamp01(wind), phase);
    this.col.push(brightness, brightness, brightness, 1);
  }

  get count(): number {
    return this.pos.length / 3;
  }

  toPart(): GeomPart {
    return {
      positions: Float32Array.from(this.pos),
      normals: Float32Array.from(this.nor),
      uvs: Float32Array.from(this.uv),
      uvs2: Float32Array.from(this.uv2),
      colors: Float32Array.from(this.col),
      indices: Uint32Array.from(this.idx),
    };
  }
}

/** Wind weight: 0 at the foot, rising with distance from the foot; `level` adds a little for branches. */
function windWeight(p: V3, H: number, level: number, levels: number): number {
  return clamp01(0.8 * Math.pow(clamp01(len(p) / H), 1.5) + (0.2 * level) / Math.max(1, levels));
}

/** Tube along a path with one ring of `sides + 1` vertices per point (the last column repeats the seam). */
function addTube(
  b: Builder,
  path: V3[],
  radius: number[],
  sides: number,
  bark: { col: number; row: number },
  tube: { H: number; level: number; levels: number; phase: number; brightness: number },
  cap = false,
): void {
  const n = path.length;
  const ring = sides + 1;
  const base = b.count;
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1]! + len(sub(path[i]!, path[i - 1]!)));
  for (let i = 0; i < n; i++) {
    const t = norm(sub(path[Math.min(i + 1, n - 1)]!, path[Math.max(i - 1, 0)]!));
    const ref: V3 = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const s1 = norm(cross(t, ref));
    const s2 = cross(t, s1);
    const r = radius[i]!;
    const v = (bark.row + fract(arc[i]! / 2.5)) / 2;
    for (let j = 0; j <= sides; j++) {
      const a = (j / sides) * TAU;
      const dir = add(mul(s1, Math.cos(a)), mul(s2, Math.sin(a)));
      const p = add(path[i]!, mul(dir, r));
      b.vertex(p, dir, (bark.col + j / sides) / 2, v, windWeight(p, tube.H, tube.level, tube.levels), tube.phase, tube.brightness);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a = base + i * ring + j;
      const c = a + ring;
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
  // Cap at the tip only (trunk); the foot stays open, branch tips hide in the leaves.
  if (!cap) return;
  const last = path[n - 1]!;
  const tip = norm(sub(last, path[Math.max(n - 2, 0)]!));
  const centre = b.count;
  b.vertex(last, tip, (bark.col + 0.5) / 2, (bark.row + 0.5) / 2, windWeight(last, tube.H, tube.level, tube.levels), tube.phase, tube.brightness);
  const lastRing = base + (n - 1) * ring;
  for (let j = 0; j < sides; j++) b.idx.push(lastRing + j, lastRing + j + 1, centre);
}

/** Leaf quad. Corners in strip order (a, b, c, d) with a–b and d–c as the two edges. */
interface Quad {
  p: [V3, V3, V3, V3];
  uv: [[number, number], [number, number], [number, number], [number, number]];
  normal: V3;
  phase: number;
  brightness: number;
}

function addQuads(b: Builder, quads: Quad[], H: number): void {
  if (quads.length === 0) return;
  // Crown centre: mean of all corners; the normals bend towards it.
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const q of quads) for (const p of q.p) {
    sx += p[0];
    sy += p[1];
    sz += p[2];
  }
  const corners = 4 * quads.length;
  const centre: V3 = [sx / corners, sy / corners, sz / corners];
  for (const q of quads) {
    const base = b.count;
    for (let k = 0; k < 4; k++) {
      const p = q.p[k]!;
      const blend = norm(add(mul(q.normal, 0.3), mul(norm(sub(p, centre)), 0.7)));
      b.vertex(p, blend, q.uv[k]![0], q.uv[k]![1], 0.5 + 0.5 * (len(p) / H), q.phase, q.brightness);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Trunk centre line: straight up with a lean and a slight wobble. */
function trunkPath(p: SpeciesParams, H: number, rng: () => number, az: number): V3[] {
  const N = Math.max(4, Math.ceil((H * 0.95) / SEG_TRUNK));
  const dx = Math.cos(az);
  const dz = Math.sin(az);
  const lean = Math.sin(p.trunkLean) * H;
  const phase = rng() * TAU;
  const wobble = p.gnarl * 0.04 * H;
  const out: V3[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const off = lean * t * t + wobble * Math.sin(t * 5 + phase) * t;
    out.push([dx * off, t * H * 0.95, dz * off]);
  }
  return out;
}

/** Branch centre line from `start` in direction `dir0`; droop bends it downward towards its tip. */
function branchPath(start: V3, dir0: V3, length: number, droop: number, gnarl: number, rng: () => number, maxSeg = 8): V3[] {
  const n = Math.max(2, Math.min(maxSeg, Math.ceil(length / SEG_BRANCH)));
  const seg = length / n;
  const bend = Math.tan(Math.min(droop, 1.4));
  const out: V3[] = [start];
  let p = start;
  for (let k = 1; k <= n; k++) {
    const d = norm(add(dir0, mul(DOWN, bend * (k / n))));
    const wob = gnarl * 0.06 * seg;
    p = add(add(p, mul(d, seg)), [(rng() - 0.5) * wob, (rng() - 0.5) * wob * 0.5, (rng() - 0.5) * wob]);
    out.push(p);
  }
  return out;
}

/** Shape-dependent branch angle (from the vertical) and length factor, given the position along the crown (0…1). */
function shapeAngle(shape: CrownShape, angle: number): number {
  switch (shape) {
    case 'column':
      return angle * 0.3;
    case 'umbrella':
      return Math.min(1.45, angle * 1.3);
    case 'bush':
      return angle * 1.1;
    default:
      return angle;
  }
}

function shapeLength(shape: CrownShape, h: number): number {
  switch (shape) {
    case 'cone':
      return 1.05 - 0.95 * h;
    case 'column':
      return 0.55;
    case 'bush':
      return 0.8;
    case 'umbrella':
      return 1;
    default:
      return 0.85 + 0.3 * Math.sin(Math.PI * h);
  }
}

interface Branch {
  path: V3[];
  radius: number[];
  level: number;
  length: number;
  phase: number;
}

/** Generates one tree. Same `seed` gives identical arrays; the result is scaled to a height in `p.height`. */
export function generateTree(p: SpeciesParams, seed: number): TreeGeometry {
  const rng = createRng(seed);
  const H = p.height[0] + (p.height[1] - p.height[0]) * rng();
  const levels = Math.min(3, Math.max(1, Math.round(p.levels)));
  const crownR = (p.crownWidth * H) / 2;
  const topS = 0.95;
  const wood = new Builder();
  const quads: Quad[] = [];

  // Trunk
  const trunk = trunkPath(p, H, rng, rng() * TAU);
  const R0 = p.trunkRadius * H;
  const trunkRadius = trunk.map((_, i) => R0 * (1 - (0.85 * i) / (trunk.length - 1)));
  const barkCol = p.barkCell % 2;
  const barkRow = Math.floor(p.barkCell / 2);
  const leafCol = p.leafCell % 4;
  const leafRow = Math.floor(p.leafCell / 4);
  const leafQuad = (c: V3, u: V3, v: V3, size: number, n: V3, phase: number, brightness: number): Quad => {
    const h = size / 2;
    const at = (su: number, sv: number): V3 => add(c, add(mul(u, su * h), mul(v, sv * h)));
    const uv = (lu: number, lv: number): [number, number] => [(leafCol + 0.02 + 0.96 * lu) / 4, (leafRow + 0.02 + 0.96 * lv) / 4];
    return {
      p: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)],
      uv: [uv(0, 0), uv(1, 0), uv(1, 1), uv(0, 1)],
      normal: n,
      phase,
      brightness,
    };
  };
  const randomUnit = (): V3 => {
    const z = 2 * rng() - 1;
    const a = rng() * TAU;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), z, r * Math.sin(a)];
  };
  const cardAxes = (n: V3): [V3, V3] => {
    const u = norm(cross(n, Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]));
    return [u, cross(n, u)];
  };

  // Palm: no branches, a crown of fronds that arch outwards from the top of the trunk.
  if (p.crownShape === 'palm') {
    addTube(wood, trunk, trunkRadius, p.sides[0], { col: barkCol, row: barkRow }, { H, level: 0, levels: 1, phase: 0, brightness: 1 }, true);
    const top = trunk[trunk.length - 1]!;
    const count = 12 + Math.floor(rng() * 5);
    const frondLen = Math.max(1.8, p.crownWidth * H * 0.5);
    for (let k = 0; k < count; k++) {
      const az = (k / count) * TAU + (rng() - 0.5) * 0.3;
      const dir0 = norm([Math.cos(az), 0.45 + 0.2 * rng(), Math.sin(az)]);
      const path = branchPath(top, dir0, frondLen, p.branchDroop, p.gnarl, rng);
      const m = path.length;
      const side = norm(cross(dir0, [0, 1, 0]));
      const phase = rng() * TAU;
      for (let j = 0; j < m - 1; j++) {
        const wa = p.leafSize * (1 - 0.6 * (j / (m - 1)));
        const wb = p.leafSize * (1 - 0.6 * ((j + 1) / (m - 1)));
        const a = path[j]!;
        const bb = path[j + 1]!;
        const v0 = (leafRow + 0.02 + 0.96 * (j / (m - 1))) / 4;
        const v1 = (leafRow + 0.02 + 0.96 * ((j + 1) / (m - 1))) / 4;
        const u0 = (leafCol + 0.02) / 4;
        const u1 = (leafCol + 0.98) / 4;
        const dirSeg = norm(sub(bb, a));
        quads.push({
          p: [add(a, mul(side, -wa / 2)), add(a, mul(side, wa / 2)), add(bb, mul(side, wb / 2)), add(bb, mul(side, -wb / 2))],
          uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
          normal: norm(cross(side, dirSeg)),
          phase,
          brightness: 0.92 + 0.16 * rng(),
        });
      }
    }
  } else {
    addTube(wood, trunk, trunkRadius, p.sides[0], { col: barkCol, row: barkRow }, { H, level: 0, levels, phase: 0, brightness: 0.92 + 0.16 * rng() }, true);

    // Branches, level by level. Each level-1 branch is placed in its own slot along the crown height.
    const branches: Branch[] = [];
    const grow = (parent: Branch, level: number): void => {
      if (level > levels) return;
      const count = p.branches[level - 1]!;
      for (let k = 0; k < count; k++) {
        const s = 0.35 + 0.6 * ((k + rng()) / count);
        const idx = Math.min(parent.path.length - 1, Math.round(s * (parent.path.length - 1)));
        const az = rng() * TAU + k * GOLDEN;
        const angle = p.branchAngle * (0.9 + 0.2 * rng());
        const alpha = shapeAngle(p.crownShape, angle) + (rng() - 0.5) * 0.3;
        const dir: V3 = [Math.sin(alpha) * Math.cos(az), Math.cos(alpha), Math.sin(alpha) * Math.sin(az)];
        const length = parent.length * 0.55 * (0.7 + 0.3 * rng()) * shapeLength(p.crownShape, s);
        const path = branchPath(parent.path[idx]!, dir, length, p.branchDroop, p.gnarl, rng, MAX_SEGMENTS[level]);
        const r0 = parent.radius[idx]! * 0.6;
        const radius = path.map((_, j) => r0 * (1 - (0.75 * j) / (path.length - 1)));
        const branch: Branch = { path, radius, level, length, phase: rng() * TAU };
        branches.push(branch);
        grow(branch, level + 1);
      }
    };
    const first = p.branches[0];
    for (let k = 0; k < first; k++) {
      const h = (k + rng()) / first;
      const s = p.crownStart + (topS - p.crownStart) * h;
      const idx = Math.min(trunk.length - 1, Math.round(s * (trunk.length - 1)));
      const az = k * GOLDEN + (rng() - 0.5) * 0.4;
      const alpha = shapeAngle(p.crownShape, p.branchAngle * (0.9 + 0.2 * rng())) + (rng() - 0.5) * 0.3;
      const dir: V3 = [Math.sin(alpha) * Math.cos(az), Math.cos(alpha), Math.sin(alpha) * Math.sin(az)];
      const length = crownR * (0.65 + 0.35 * rng()) * shapeLength(p.crownShape, h);
      const path = branchPath(trunk[idx]!, dir, length, p.branchDroop, p.gnarl, rng, MAX_SEGMENTS[1]);
      const r0 = trunkRadius[idx]! * 0.6;
      const radius = path.map((_, j) => r0 * (1 - (0.75 * j) / (path.length - 1)));
      const branch: Branch = { path, radius, level: 1, length, phase: rng() * TAU };
      branches.push(branch);
      if (levels > 1) grow(branch, 2);
    }

    for (const b of branches) {
      addTube(wood, b.path, b.radius, b.level > 1 ? 3 : p.sides[1], { col: barkCol, row: barkRow }, {
        H,
        level: b.level,
        levels,
        phase: b.phase,
        brightness: 0.92 + 0.16 * rng(),
      });
    }

    // Leaf cards along the outer part of the branches of the last two levels (the last level alone
    // leaves the crown hollow and patchy).
    const tips = branches.filter((b) => b.level >= Math.max(1, levels - 1));
    for (const b of tips) {
      const n = b.path.length;
      const from = b.level === levels ? 1 : Math.max(1, Math.floor(n * 0.5));
      for (let i = from; i < n; i++) {
        for (let c = 0; c < Math.round(p.leavesPerTip); c++) {
          const jitter = mul(randomUnit(), p.leafSize * 0.6 * rng());
          const at = add(b.path[i]!, jitter);
          const nCard = norm(add(randomUnit(), [0, 0.3, 0]));
          const [u, v] = cardAxes(nCard);
          const size = p.leafSize * (0.7 + 0.6 * rng());
          quads.push(leafQuad(at, u, v, size, nCard, b.phase, 0.92 + 0.16 * rng()));
        }
      }
    }
  }

  // Triangle budget: wood always stays, leaf quads are thinned deterministically.
  const woodTris = wood.idx.length / 3;
  const maxQuads = Math.max(0, Math.floor((MAX_TRIANGLES - woodTris) / 2));
  let kept = quads;
  if (quads.length > maxQuads) {
    const order = quads.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    kept = order.slice(0, maxQuads).sort((a, b) => a - b).map((i) => quads[i]!);
  }
  const leaves = new Builder();
  addQuads(leaves, kept, H);

  // Scale the whole tree so its bounding box is exactly H tall, with the foot at y = 0.
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const part of [wood, leaves]) {
    for (let i = 1; i < part.pos.length; i += 3) {
      ymin = Math.min(ymin, part.pos[i]!);
      ymax = Math.max(ymax, part.pos[i]!);
    }
  }
  const extent = ymax - ymin || 1;
  const sc = H / extent;
  let radius = 0;
  for (const part of [wood, leaves]) {
    for (let i = 0; i < part.pos.length; i += 3) {
      part.pos[i] = part.pos[i]! * sc;
      part.pos[i + 1] = (part.pos[i + 1]! - ymin) * sc;
      part.pos[i + 2] = part.pos[i + 2]! * sc;
      radius = Math.max(radius, Math.hypot(part.pos[i]!, part.pos[i + 2]!));
    }
  }
  return { wood: wood.toPart(), leaves: leaves.toPart(), height: H, radius };
}

/** Triangles of both parts together (the budget counted by the tests and the studio). */
export function triangleCount(g: TreeGeometry): number {
  return (g.wood.indices.length + g.leaves.indices.length) / 3;
}
