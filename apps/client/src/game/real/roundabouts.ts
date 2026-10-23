import { Color3, StandardMaterial, VertexBuffer, type Material, type Mesh, type Scene } from '@babylonjs/core';
import { MeshData } from './meshData';
import { inArc, ringHeight, type Arc, type RingPlan } from './roundaboutPlan';
import { asphaltTexture } from './textures';

/** Size of one repeat of the plain asphalt on the ring, m. */
const PATCH_TILE = 6;
/** The ring lies this far above the ride's (plain) rows below it. */
const RING_LIFT = 0.03;
const KERB_H = 0.12;
const KERB_W = 0.25;
/** Edge lines: width and distance of their centre from the asphalt edge, m. */
const LINE_W = 0.15;
const LINE_IN = 0.3;
/** Give-way dashes: length along the ring, gap, width across, m. */
const DASH = 0.5;
const DASH_GAP = 0.3;
const DASH_W = 0.3;
/** The island rises this much towards its middle, m. */
const MOUND = 0.45;

/**
 * Roundabouts: ring carriageway in plain asphalt with edge lines (the outer one open where roads join,
 * give-way dashes across the entering lanes) around a grass island with a kerb. Drawn above the ride's
 * plain ring rows and the side roads' ends.
 */
export function buildRoundabouts(scene: Scene, plans: RingPlan[], grass: Material): Mesh[] {
  const asphalt = new StandardMaterial('ring-asphalt', scene);
  asphalt.diffuseTexture = asphaltTexture(scene);
  asphalt.specularColor = new Color3(0.05, 0.05, 0.05);
  asphalt.zOffset = -2.5;
  const line = new StandardMaterial('ring-lines', scene);
  line.diffuseColor = new Color3(0.86, 0.86, 0.84);
  line.specularColor = new Color3(0.03, 0.03, 0.03);
  line.zOffset = -4;
  const kerb = new StandardMaterial('ring-kerb', scene);
  kerb.diffuseColor = new Color3(0.68, 0.67, 0.64);
  kerb.specularColor = new Color3(0.03, 0.03, 0.03);
  kerb.zOffset = -2.5;

  const meshes: Mesh[] = [];
  plans.forEach((plan, id) => {
    const { rb } = plan;
    const n = plan.ys.length;
    const ri = rb.r - rb.hw;
    const ro = rb.r + rb.hw;
    const at = (t: number, rad: number, dy: number): [number, number, number] => [rb.x + rad * Math.cos(t), ringHeight(plan, t) + RING_LIFT + dy, rb.z + rad * Math.sin(t)];

    // ring carriageway
    const road = new MeshData(true);
    const radii = [ri, rb.r, ro];
    for (let q = 0; q <= n; q++) {
      const t = (Math.PI * 2 * q) / n;
      for (const rad of radii) {
        const p = at(t, rad, 0);
        road.vertex(p[0], p[1], p[2], 0, 1, 0, p[0] / PATCH_TILE, p[2] / PATCH_TILE);
      }
      if (q > 0) {
        const a = (q - 1) * radii.length;
        const b = q * radii.length;
        for (let c = 0; c < radii.length - 1; c++) road.quad(a + c, a + c + 1, b + c + 1, b + c, 0, 1, 0);
      }
    }

    // markings: inner edge line all round, outer edge line open at the arms, dashes at the entries
    const lines = new MeshData();
    const band = (t0: number, t1: number, r0: number, r1: number) => {
      const steps = Math.max(1, Math.ceil(((t1 - t0) * (r0 + r1)) / 2 / 0.8));
      let prev: [number, number] | null = null;
      for (let s = 0; s <= steps; s++) {
        const t = t0 + ((t1 - t0) * s) / steps;
        const a = at(t, r0, 0.005);
        const b = at(t, r1, 0.005);
        const ia = lines.vertex(a[0], a[1], a[2]);
        const ib = lines.vertex(b[0], b[1], b[2]);
        if (prev) lines.quad(prev[0], prev[1], ib, ia, 0, 1, 0);
        prev = [ia, ib];
      }
    };
    band(0, Math.PI * 2, ri + LINE_IN - LINE_W / 2, ri + LINE_IN + LINE_W / 2);
    const outer = ro - LINE_IN;
    const gaps: Arc[] = plan.arms.map((a) => a.gap);
    // a slightly wider opening than the road itself (rounded corners of the mouth)
    const open = (t: number) => gaps.some((g) => inArc({ a: g.a - 1.2 / ro, span: g.span + 2.4 / ro }, t));
    const segs = Math.ceil((Math.PI * 2 * ro) / 0.8);
    let start: number | null = null;
    for (let s = 0; s <= segs; s++) {
      const t = (Math.PI * 2 * s) / segs;
      const on = s < segs && !open(t + Math.PI / segs);
      if (on && start === null) start = t;
      if (!on && start !== null) {
        band(start, t, outer - LINE_W / 2, outer + LINE_W / 2);
        start = null;
      }
    }
    for (const arm of plan.arms) {
      if (!arm.dashes) continue;
      const len = arm.dashes.span * outer;
      const count = Math.floor((len + DASH_GAP) / (DASH + DASH_GAP));
      const pad = (len - count * (DASH + DASH_GAP) + DASH_GAP) / 2;
      for (let d = 0; d < count; d++) {
        const s0 = (pad + d * (DASH + DASH_GAP)) / outer;
        band(arm.dashes.a + s0, arm.dashes.a + s0 + DASH / outer, ro - LINE_IN - DASH_W / 2, ro - LINE_IN + DASH_W / 2);
      }
    }

    // island: kerb (top and face) and a grass mound
    const curb = new MeshData();
    const isle = new MeshData();
    const top = new Float32Array(n);
    let sum = 0;
    for (let q = 0; q < n; q++) {
      sum += plan.ys[q]!;
      top[q] = plan.ys[q]! + RING_LIFT + KERB_H;
    }
    const centre = isle.vertex(rb.x, sum / n + RING_LIFT + KERB_H + MOUND, rb.z);
    let prevK: number[] | null = null;
    let prevI: number | null = null;
    for (let q = 0; q <= n; q++) {
      const t = (Math.PI * 2 * q) / n;
      const foot = at(t, ri, 0);
      const edge = at(t, ri, KERB_H);
      const back = at(t, ri - KERB_W, KERB_H);
      const k = [curb.vertex(...foot), curb.vertex(...edge), curb.vertex(...back)];
      const g = at(t, ri - KERB_W, KERB_H);
      const gi = isle.vertex(g[0], top[q % n]!, g[2]);
      if (prevK) {
        curb.quad(prevK[0]!, prevK[1]!, k[1]!, k[0]!, Math.cos(t), 0, Math.sin(t));
        curb.quad(prevK[1]!, prevK[2]!, k[2]!, k[1]!, 0, 1, 0);
      }
      if (prevI !== null) isle.tri(centre, gi, prevI, 0, 1, 0);
      prevK = k;
      prevI = gi;
    }

    road.computeNormals();
    lines.computeNormals();
    curb.computeNormals();
    isle.computeNormals();
    const m1 = road.build(scene, `ring-${id}`, asphalt);
    const m2 = lines.build(scene, `ring-lines-${id}`, line);
    const m3 = curb.build(scene, `ring-kerb-${id}`, kerb);
    const m4 = isle.build(scene, `ring-island-${id}`, grass);
    if (m4) {
      // no rock on the island (UV2.x is the rock weight of the terrain material)
      m4.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(isle.vertexCount * 2), false, 2);
    }
    for (const m of [m1, m2, m3, m4]) if (m) meshes.push(m);
  });
  return meshes;
}
