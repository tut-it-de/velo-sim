import { Color3, StandardMaterial, Texture, VertexBuffer, type Material, type Mesh, type Scene } from '@babylonjs/core';
import { createRng } from '../noise';
import type { RouteCorridor } from './corridor';
import { MeshData } from './meshData';
import { subdivide, triangulate, type Vec2 } from './roadGeometry';
import { SHRUB_DARK, SHRUB_MID, finish, lumpySphere, material as plantMaterial, pushMatrix } from './landscapeScatter';
import { APRON, LINE_IN, LINE_W, RING_LIFT, approachHeight, inArc, ringHeight, type Arc, type RingPlan } from './roundaboutPlan';
import { asphaltTexture, stoneTexture } from './textures';

/** Size of one repeat of the plain asphalt on the ring, m. */
const PATCH_TILE = 6;
const KERB_H = 0.12;
const KERB_W = 0.25;
/** The inner apron (cobbles) is this much higher than the ring, its stones this large per repeat, m. */
const APRON_H = 0.04;
const APRON_TILE = 1.6;
/** Grey shoulder strip along the ring's outer edge and the approaches' corners, m. */
const STRIP_W = 0.35;
/** Give-way dashes: length along the ring, gap, width across; thin dashes across the exits, m. */
const DASH = 0.5;
const DASH_GAP = 0.25;
const DASH_W = 0.45;
const EXIT_DASH = 1;
const EXIT_GAP = 1;
/** Carriageway left beside the apron at least, m. */
const RING_MIN_WIDTH = 4.6;
/** Planting on the central island: shrubs and flower clumps per m², flower colours. */
const SHRUBS_PER_M2 = 0.12;
const FLOWERS_PER_M2 = 0.35;
const FLOWERS: Array<[number, number, number]> = [
  [0.85, 0.2, 0.25],
  [0.95, 0.75, 0.2],
  [0.6, 0.35, 0.75],
  [0.95, 0.93, 0.9],
];
/** The island rises this much towards its middle, m. */
const MOUND = 0.45;

/**
 * Roundabouts: ring carriageway in plain asphalt with solid edge lines, a lighter cobbled apron and a
 * planted island (grass, shrubs, flowers) behind a kerb; approach areas with rounded corners, raised
 * splitter islands and their markings; the outer edge line runs between the approaches, broad give-way
 * dashes cross the entries and thin dashes the exits. Drawn above the ride's road and the side roads' ends.
 */
export function buildRoundabouts(scene: Scene, plans: RingPlan[], c: RouteCorridor, ground: (x: number, z: number) => number, grass: Material): Mesh[] {
  const material = (name: string, color: Color3, zOffset: number) => {
    const m = new StandardMaterial(name, scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(0.04, 0.04, 0.04);
    m.zOffset = zOffset;
    return m;
  };
  // ring below the approach areas, both below the markings
  const ringMat = material('ring-asphalt', Color3.White(), -2.5);
  ringMat.diffuseTexture = asphaltTexture(scene);
  const approachMat = material('ring-approach', Color3.White(), -3);
  approachMat.diffuseTexture = ringMat.diffuseTexture;
  const apronMat = material('ring-apron', new Color3(0.95, 0.93, 0.9), -2.5);
  const stones = stoneTexture(scene);
  stones.wrapU = Texture.WRAP_ADDRESSMODE;
  stones.wrapV = Texture.WRAP_ADDRESSMODE;
  apronMat.diffuseTexture = stones;
  const lineMat = material('ring-lines', new Color3(0.86, 0.86, 0.84), -4);
  const kerbMat = material('ring-kerb', new Color3(0.68, 0.67, 0.64), -3.5);

  const meshes: Mesh[] = [];
  const shrubDark: number[] = [];
  const shrubMid: number[] = [];
  const flowers: number[][] = FLOWERS.map(() => []);
  plans.forEach((plan, id) => {
    const { rb } = plan;
    const n = plan.ys.length;
    const apron = Math.min(APRON, Math.max(0, 2 * rb.hw - RING_MIN_WIDTH));
    const ri = rb.r - rb.hw;
    const ro = rb.r + rb.hw;
    const y = (t: number, dy = 0) => ringHeight(plan, t) + RING_LIFT + dy;
    const at = (t: number, rad: number, dy = 0): [number, number, number] => [rb.x + rad * Math.cos(t), y(t, dy), rb.z + rad * Math.sin(t)];

    // ring bands round the centre (carriageway, apron), with planar UVs
    const band = (md: MeshData, t0: number, t1: number, r0: number, r1: number, dy: number, tile: number) => {
      const steps = Math.max(1, Math.ceil(((t1 - t0) * (r0 + r1)) / 2 / 0.8));
      let prev: [number, number] | null = null;
      for (let s = 0; s <= steps; s++) {
        const t = t0 + ((t1 - t0) * s) / steps;
        const a = at(t, r0, dy);
        const b = at(t, r1, dy);
        const ia = md.vertex(a[0], a[1], a[2], 0, 1, 0, a[0] / tile, a[2] / tile);
        const ib = md.vertex(b[0], b[1], b[2], 0, 1, 0, b[0] / tile, b[2] / tile);
        if (prev) md.quad(prev[0], prev[1], ib, ia, 0, 1, 0);
        prev = [ia, ib];
      }
    };
    // the same band only where no approach joins (open = the gaps)
    const banded = (gaps: Arc[], draw: (t0: number, t1: number) => void) => {
      const segs = Math.ceil((Math.PI * 2 * ro) / 0.5);
      let start: number | null = null;
      for (let s = 0; s <= segs; s++) {
        const t = (Math.PI * 2 * s) / segs;
        const on = s < segs && !gaps.some((g) => inArc(g, t + Math.PI / segs));
        if (on && start === null) start = t;
        if (!on && start !== null) {
          draw(start, t);
          start = null;
        }
      }
    };
    const gaps = plan.approaches.map((a) => a.gap);

    const road = new MeshData(true);
    band(road, 0, Math.PI * 2, ri + apron, ro, 0, PATCH_TILE);
    const aprons = new MeshData(true);
    const curb = new MeshData();
    if (apron > 0) {
      band(aprons, 0, Math.PI * 2, ri, ri + apron, APRON_H, APRON_TILE);
      // low face where the apron rises from the carriageway
      for (let q = 0; q < n; q++) {
        const t0 = (Math.PI * 2 * q) / n;
        const t1 = (Math.PI * 2 * (q + 1)) / n;
        const p = [at(t0, ri + apron), at(t0, ri + apron, APRON_H), at(t1, ri + apron, APRON_H), at(t1, ri + apron)];
        const ids = p.map((v) => curb.vertex(v[0], v[1], v[2]));
        curb.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!, Math.cos(t0), 0, Math.sin(t0));
      }
    }

    // markings
    const lines = new MeshData();
    band(lines, 0, Math.PI * 2, ri + apron + LINE_IN - LINE_W / 2, ri + apron + LINE_IN + LINE_W / 2, 0.005, 1);
    banded(gaps, (t0, t1) => band(lines, t0, t1, ro - LINE_IN - LINE_W / 2, ro - LINE_IN + LINE_W / 2, 0.005, 1));
    const dashed = (arc: Arc, dash: number, gap: number, w: number) => {
      const rad = ro - LINE_IN;
      const len = arc.span * rad;
      const count = Math.floor((len + gap) / (dash + gap));
      const pad = (len - count * (dash + gap) + gap) / 2;
      for (let d = 0; d < count; d++) {
        const s0 = (pad + d * (dash + gap)) / rad;
        band(lines, arc.a + s0, arc.a + s0 + dash / rad, rad - w / 2, rad + w / 2, 0.006, 1);
      }
    };
    for (const a of plan.approaches) {
      for (const arc of a.dashes) dashed(arc, DASH, DASH_GAP, DASH_W);
      for (const arc of a.exits) dashed(arc, EXIT_DASH, EXIT_GAP, LINE_W);
    }

    // grey shoulder strip along the outer edge between the approaches and round their corners
    const strips = new MeshData();
    banded(gaps, (t0, t1) => band(strips, t0, t1, ro - 0.02, ro + STRIP_W, 0.004, 1));

    // approach areas, splitter islands
    const approaches = new MeshData(true);
    const isle = new MeshData();
    for (const a of plan.approaches) {
      const h = (p: Vec2) => approachHeight(c, ground, plan, a, p[0], p[1]);
      const sub = subdivide(a.poly, triangulate(a.poly), 2);
      const ids = sub.pts.map((p) => approaches.vertex(p[0], h(p), p[1], 0, 1, 0, p[0] / PATCH_TILE, p[1] / PATCH_TILE));
      for (let k = 0; k < sub.tris.length; k += 3) approaches.tri(ids[sub.tris[k]!]!, ids[sub.tris[k + 1]!]!, ids[sub.tris[k + 2]!]!, 0, 1, 0);
      for (const f of a.fillets) {
        // from the arc towards the corner's centre (the side away from the road)
        let prev: [number, number] | null = null;
        for (const p of f.pts) {
          const dx = f.c[0] - p[0];
          const dz = f.c[1] - p[1];
          const l = Math.hypot(dx, dz) || 1;
          const q: Vec2 = [p[0] + (dx / l) * STRIP_W, p[1] + (dz / l) * STRIP_W];
          const ia = strips.vertex(p[0], h(p) + 0.004, p[1]);
          const ib = strips.vertex(q[0], h(p) + 0.004, q[1]);
          if (prev) strips.quad(prev[0], prev[1], ib, ia, 0, 1, 0);
          prev = [ia, ib];
        }
        // the ring's outer edge line carries on round the corner
        let prevL: [number, number] | null = null;
        for (const p of f.pts) {
          const dx = p[0] - f.c[0];
          const dz = p[1] - f.c[1];
          const l = Math.hypot(dx, dz) || 1;
          const a0: Vec2 = [p[0] + (dx / l) * (LINE_IN - LINE_W / 2), p[1] + (dz / l) * (LINE_IN - LINE_W / 2)];
          const a1: Vec2 = [p[0] + (dx / l) * (LINE_IN + LINE_W / 2), p[1] + (dz / l) * (LINE_IN + LINE_W / 2)];
          const ia = lines.vertex(a0[0], h(a0) + 0.005, a0[1]);
          const ib = lines.vertex(a1[0], h(a1) + 0.005, a1[1]);
          if (prevL) lines.quad(prevL[0], prevL[1], ib, ia, 0, 1, 0);
          prevL = [ia, ib];
        }
      }
      // edge lines, island outlines, hatching, centre dashes: strips along their polylines
      for (const { pts, w } of a.paint) {
        let prev: [number, number] | null = null;
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k]!;
          const pa = pts[Math.max(0, k - 1)]!;
          const pb = pts[Math.min(pts.length - 1, k + 1)]!;
          const dx = pb[0] - pa[0];
          const dz = pb[1] - pa[1];
          const l = Math.hypot(dx, dz) || 1;
          const nx = (-dz / l) * (w / 2);
          const nz = (dx / l) * (w / 2);
          const y = h(p) + 0.006;
          const ia = lines.vertex(p[0] - nx, y, p[1] - nz);
          const ib = lines.vertex(p[0] + nx, y, p[1] + nz);
          if (prev) lines.quad(prev[0], prev[1], ib, ia, 0, 1, 0);
          prev = [ia, ib];
        }
      }
      for (const poly of a.islands) {
        const m = poly.length;
        let cx = 0;
        let cz = 0;
        for (const p of poly) {
          cx += p[0] / m;
          cz += p[1] / m;
        }
        const ys = poly.map((p) => h(p));
        // kerb: face all round and a top band, grass inside
        const inset = poly.map((p): Vec2 => {
          const dx = cx - p[0];
          const dz = cz - p[1];
          const l = Math.hypot(dx, dz) || 1;
          const w = Math.min(KERB_W, l * 0.4);
          return [p[0] + (dx / l) * w, p[1] + (dz / l) * w];
        });
        for (let k = 0; k < m; k++) {
          const j = (k + 1) % m;
          const p = poly[k]!;
          const q = poly[j]!;
          const nx = q[1] - p[1];
          const nz = -(q[0] - p[0]);
          const f = [curb.vertex(p[0], ys[k]!, p[1]), curb.vertex(p[0], ys[k]! + KERB_H, p[1]), curb.vertex(q[0], ys[j]! + KERB_H, q[1]), curb.vertex(q[0], ys[j]!, q[1])];
          curb.quad(f[0]!, f[1]!, f[2]!, f[3]!, nx, 0, nz);
          const tp = [
            curb.vertex(p[0], ys[k]! + KERB_H, p[1]),
            curb.vertex(q[0], ys[j]! + KERB_H, q[1]),
            curb.vertex(inset[j]![0], ys[j]! + KERB_H, inset[j]![1]),
            curb.vertex(inset[k]![0], ys[k]! + KERB_H, inset[k]![1]),
          ];
          curb.quad(tp[0]!, tp[1]!, tp[2]!, tp[3]!, 0, 1, 0);
        }
        const tris = triangulate(inset);
        const gi = inset.map((p, k) => isle.vertex(p[0], ys[k]! + KERB_H + 0.01, p[1]));
        for (let k = 0; k < tris.length; k += 3) isle.tri(gi[tris[k]!]!, gi[tris[k + 1]!]!, gi[tris[k + 2]!]!, 0, 1, 0);
      }
    }

    // central island: kerb (face and top) and a grass mound
    let sum = 0;
    for (let q = 0; q < n; q++) sum += plan.ys[q]!;
    const base = apron > 0 ? APRON_H : 0;
    const centre = isle.vertex(rb.x, sum / n + RING_LIFT + base + KERB_H + MOUND, rb.z);
    let prevK: number[] | null = null;
    let prevI: number | null = null;
    for (let q = 0; q <= n; q++) {
      const t = (Math.PI * 2 * q) / n;
      const k = [curb.vertex(...at(t, ri, base)), curb.vertex(...at(t, ri, base + KERB_H)), curb.vertex(...at(t, ri - KERB_W, base + KERB_H))];
      const g = at(t, ri - KERB_W, base + KERB_H);
      const gi = isle.vertex(g[0], g[1], g[2]);
      if (prevK) {
        curb.quad(prevK[0]!, prevK[1]!, k[1]!, k[0]!, Math.cos(t), 0, Math.sin(t));
        curb.quad(prevK[1]!, prevK[2]!, k[2]!, k[1]!, 0, 1, 0);
      }
      if (prevI !== null) isle.tri(centre, gi, prevI, 0, 1, 0);
      prevK = k;
      prevI = gi;
    }
    // planting: shrubs and flower clumps on the island, on the mound
    const rim = ri - KERB_W - 0.6;
    if (rim > 1) {
      const rng = createRng(0x4b1e + id * 7919);
      const rimY = sum / n + RING_LIFT + base + KERB_H;
      const yAt = (rad: number) => rimY + MOUND * (1 - rad / (ri - KERB_W));
      const spot = () => {
        const rad = rim * Math.sqrt(rng());
        const phi = rng() * Math.PI * 2;
        return { x: rb.x + rad * Math.cos(phi), z: rb.z + rad * Math.sin(phi), y: yAt(rad) };
      };
      const area = Math.PI * rim * rim;
      for (let k = 0; k < Math.round(area * SHRUBS_PER_M2); k++) {
        const p = spot();
        const d = 0.7 + 1.1 * rng();
        const sy = d * 0.7;
        pushMatrix(rng() < 0.5 ? shrubDark : shrubMid, p.x, p.y + sy * 0.35, p.z, rng() * Math.PI * 2, 0, 0, d, sy, d * (0.85 + 0.15 * rng()));
      }
      // flowers in clumps of one colour
      for (let k = 0; k < Math.round((area * FLOWERS_PER_M2) / 5); k++) {
        const c0 = spot();
        const list = flowers[Math.floor(rng() * FLOWERS.length)]!;
        for (let j = 0; j < 5; j++) {
          const x = c0.x + (rng() - 0.5) * 1.2;
          const z = c0.z + (rng() - 0.5) * 1.2;
          if (Math.hypot(x - rb.x, z - rb.z) > rim) continue;
          const d = 0.25 + 0.2 * rng();
          pushMatrix(list, x, yAt(Math.hypot(x - rb.x, z - rb.z)) + d * 0.2, z, rng() * Math.PI * 2, 0, 0, d, d * 0.6, d);
        }
      }
    }

    const out: Array<[MeshData, string, Material, boolean]> = [
      [road, 'ring', ringMat, true],
      [aprons, 'ring-apron', apronMat, true],
      [approaches, 'ring-approach', approachMat, true],
      [strips, 'ring-strip', kerbMat, false],
      [lines, 'ring-lines', lineMat, false],
      [curb, 'ring-kerb', kerbMat, false],
      [isle, 'ring-island', grass, false],
    ];
    for (const [md, name, mat, shadows] of out) {
      md.computeNormals();
      const m = md.build(scene, `${name}-${id}`, mat);
      if (!m) continue;
      // no rock on the islands (UV2.x is the rock weight of the terrain material)
      if (mat === grass) m.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(md.vertexCount * 2), false, 2);
      m.receiveShadows = shadows;
      meshes.push(m);
    }
  });
  const plants: Array<[Mesh, number[], StandardMaterial]> = [
    [lumpySphere(scene, 'ring-shrub-dark', 1, 0x51, 0.14), shrubDark, plantMaterial(scene, 'ring-shrub-dark-mat', SHRUB_DARK)],
    [lumpySphere(scene, 'ring-shrub-mid', 1, 0x52, 0.14), shrubMid, plantMaterial(scene, 'ring-shrub-mid-mat', SHRUB_MID)],
    ...FLOWERS.map((rgb, k): [Mesh, number[], StandardMaterial] => [lumpySphere(scene, `ring-flowers-${k}`, 1, 0x60 + k, 0.3), flowers[k]!, plantMaterial(scene, `ring-flowers-${k}-mat`, rgb)]),
  ];
  for (const [mesh, matrices, mat] of plants) {
    const m = finish(mesh, matrices, mat);
    if (m) meshes.push(m);
  }
  return meshes;
}
