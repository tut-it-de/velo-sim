import { Color3, MeshBuilder, StandardMaterial, Vector3, type LinesMesh, type Mesh, type Scene } from '@babylonjs/core';
import type { HeightField } from './heightField';
import { MeshData } from './meshData';
import type { Landmark, WorldData } from './worldData';

type RGB = [number, number, number];
const RED: RGB = [0.78, 0.16, 0.12];
const WHITE: RGB = [0.93, 0.93, 0.91];
const STEEL: RGB = [0.62, 0.64, 0.66];
const CONCRETE: RGB = [0.76, 0.75, 0.72];
const GLASS: RGB = [0.22, 0.27, 0.31];
const STONE: RGB = [0.6, 0.53, 0.44];
const SLATE: RGB = [0.3, 0.31, 0.34];
/** From this height masts and towers carry the red and white day marking for aircraft. */
const MARKED_FROM = 100;
/** Guy wires are one pixel wide: beyond this they would only flicker. */
const GUY_DISTANCE = 1800;

const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

/** Horizontal disc at height y facing up (dir 1) or down (dir -1). */
function disc(md: MeshData, x: number, z: number, y: number, r: number, seg: number, color: RGB, dir: 1 | -1, phase: number): void {
  const c = md.vertex(x, y, z, 0, dir, 0, 0, 0, ...color);
  const ring: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a = phase + (i / seg) * Math.PI * 2;
    ring.push(md.vertex(x + Math.cos(a) * r, y, z + Math.sin(a) * r, 0, dir, 0, 0, 0, ...color));
  }
  for (let i = 0; i < seg; i++) md.tri(c, ring[i]!, ring[(i + 1) % seg]!, 0, dir, 0);
}

/**
 * Vertical frustum around (x, z) from y0 (radius r0) to y1 (radius r1), r1 = 0 makes a cone or pyramid.
 * Few segments give a flat-shaded prism (4 with phase π/4: a square aligned to the axes).
 */
function frustum(md: MeshData, x: number, z: number, y0: number, y1: number, r0: number, r1: number, seg: number, color: RGB, caps = true, phase = 0): void {
  const flat = seg <= 6;
  const slope = (r0 - r1) / Math.max(0.01, y1 - y0);
  const norm = (a: number): [number, number, number] => {
    const l = Math.hypot(1, slope);
    return [Math.cos(a) / l, slope / l, Math.sin(a) / l];
  };
  for (let i = 0; i < seg; i++) {
    const a0 = phase + (i / seg) * Math.PI * 2;
    const a1 = phase + ((i + 1) / seg) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const n0 = norm(flat ? am : a0);
    const n1 = norm(flat ? am : a1);
    const v0 = md.vertex(x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0, ...n0, 0, 0, ...color);
    const v1 = md.vertex(x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0, ...n1, 0, 0, ...color);
    const v2 = md.vertex(x + Math.cos(a1) * r1, y1, z + Math.sin(a1) * r1, ...n1, 0, 0, ...color);
    const v3 = md.vertex(x + Math.cos(a0) * r1, y1, z + Math.sin(a0) * r1, ...n0, 0, 0, ...color);
    md.quad(v0, v1, v2, v3, Math.cos(am), 0, Math.sin(am));
  }
  if (caps) {
    if (r1 > 0) disc(md, x, z, y1, r1, seg, color, 1, phase);
    disc(md, x, z, y0, r0, seg, color, -1, phase);
  }
}

/** Square steel beam from p0 to p1 (lattice legs and braces). */
function beam(md: MeshData, p0: Vector3, p1: Vector3, w: number, color: RGB): void {
  const d = p1.subtract(p0).normalize();
  const up = Math.abs(d.y) > 0.9 ? Vector3.Right() : Vector3.Up();
  const s = Vector3.Cross(d, up).normalize().scaleInPlace(w / 2);
  const t = Vector3.Cross(d, s).normalize().scaleInPlace(w / 2);
  const corners = [s.add(t), s.subtract(t), s.negate().subtract(t), t.subtract(s)];
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    const n = a.add(b).normalize();
    const v0 = md.vertex(p0.x + a.x, p0.y + a.y, p0.z + a.z, n.x, n.y, n.z, 0, 0, ...color);
    const v1 = md.vertex(p0.x + b.x, p0.y + b.y, p0.z + b.z, n.x, n.y, n.z, 0, 0, ...color);
    const v2 = md.vertex(p1.x + b.x, p1.y + b.y, p1.z + b.z, n.x, n.y, n.z, 0, 0, ...color);
    const v3 = md.vertex(p1.x + a.x, p1.y + a.y, p1.z + a.z, n.x, n.y, n.z, 0, 0, ...color);
    md.quad(v0, v1, v2, v3, n.x, n.y, n.z);
  }
}

/** Tube from y0 to y1, in `bands` alternating red and white bands (red at both ends) or plain. */
function bandedTube(md: MeshData, x: number, z: number, y0: number, y1: number, r: number, bands: number, plain: RGB): void {
  for (let b = 0; b < bands; b++) {
    const color = bands > 1 ? (b % 2 === 0 ? RED : WHITE) : plain;
    frustum(md, x, z, y0 + ((y1 - y0) * b) / bands, y0 + ((y1 - y0) * (b + 1)) / bands, r, r, 10, color, false);
  }
  disc(md, x, z, y1, r, 10, bands > 1 ? RED : plain, 1, 0);
}

/** Guyed steel tube mast (hr-Rohrmast): antenna galleries and three guy directions at three levels. */
function mast(md: MeshData, l: Landmark, ground: number, field: HeightField, guys: Vector3[][]): void {
  const r = Math.min(Math.max(l.r, 0.6), 1.2);
  const top = ground + l.h;
  bandedTube(md, l.x, l.z, ground - 1, top, r, l.h >= MARKED_FROM ? 7 : 1, STEEL);
  for (const f of [0.45, 0.72, 0.93]) frustum(md, l.x, l.z, ground + f * l.h, ground + f * l.h + 0.8, r * 2.6, r * 2.6, 10, STEEL);
  if (l.h < 25) return;
  const phase = (l.x * 0.37 + l.z * 0.11) % (Math.PI * 2);
  for (let k = 0; k < 3; k++) {
    const a = phase + (k * Math.PI * 2) / 3;
    const ax = l.x + Math.cos(a) * l.h * 0.5;
    const az = l.z + Math.sin(a) * l.h * 0.5;
    const anchor = new Vector3(ax, field.dem(ax, az) + 0.3, az);
    for (const f of [0.33, 0.62, 0.9]) guys.push([new Vector3(l.x + Math.cos(a) * r, ground + f * l.h, l.z + Math.sin(a) * r), anchor]);
  }
}

/** Free-standing steel lattice tower, tapering, with X bracing on all four faces. */
function lattice(md: MeshData, l: Landmark, ground: number): void {
  const color = l.h >= MARKED_FROM ? WHITE : STEEL;
  const b0 = Math.max(l.r * 1.2, l.h * 0.055);
  const body = l.h * 0.84;
  const b1 = Math.max(0.9, b0 * 0.22);
  const half = (y: number) => b0 + (b1 - b0) * (y / body);
  const corner = (y: number, k: number) => {
    const s = half(y);
    return new Vector3(l.x + (k === 0 || k === 3 ? -s : s), ground + y, l.z + (k < 2 ? -s : s));
  };
  const leg = Math.max(0.3, b0 * 0.05);
  for (let k = 0; k < 4; k++) beam(md, corner(-1, k), corner(body, k), leg, color);
  const panels = Math.max(4, Math.round(body / (b0 + b1)));
  for (let p = 0; p < panels; p++) {
    const y0 = (body * p) / panels;
    const y1 = (body * (p + 1)) / panels;
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      beam(md, corner(y0, k), corner(y1, n), leg * 0.6, color);
      beam(md, corner(y0, n), corner(y1, k), leg * 0.6, color);
      beam(md, corner(y1, k), corner(y1, n), leg * 0.6, color);
    }
  }
  for (const f of [0.55, 0.72, body / l.h]) {
    const s = half(Math.min(f * l.h, body)) * 1.35;
    frustum(md, l.x, l.z, ground + f * l.h - 0.4, ground + f * l.h, s * Math.SQRT2, s * Math.SQRT2, 4, shade(STEEL, 0.8), true, Math.PI / 4);
  }
  bandedTube(md, l.x, l.z, ground + body, ground + l.h, Math.max(0.35, b1 * 0.4), l.h >= MARKED_FROM ? 5 : 1, STEEL);
}

/** Concrete telecommunication tower: shaft, a glazed operations floor, antenna platforms, antenna mast. */
function telecom(md: MeshData, l: Landmark, ground: number): void {
  const r0 = Math.min(Math.max(l.r * 0.5, 2.5), 6);
  const h = l.h;
  const at = (f: number) => ground + f * h;
  frustum(md, l.x, l.z, ground - 2, at(0.55), r0, r0 * 0.78, 16, CONCRETE);
  frustum(md, l.x, l.z, at(0.55), at(0.565), r0 * 1.9, r0 * 1.9, 20, CONCRETE);
  frustum(md, l.x, l.z, at(0.565), at(0.605), r0 * 1.8, r0 * 1.8, 20, GLASS, false);
  frustum(md, l.x, l.z, at(0.605), at(0.62), r0 * 1.92, r0 * 1.9, 20, CONCRETE);
  frustum(md, l.x, l.z, at(0.62), at(0.77), r0 * 0.74, r0 * 0.62, 16, CONCRETE);
  frustum(md, l.x, l.z, at(0.69), at(0.7), r0 * 1.5, r0 * 1.5, 20, shade(CONCRETE, 0.9));
  frustum(md, l.x, l.z, at(0.76), at(0.77), r0 * 1.3, r0 * 1.3, 20, shade(CONCRETE, 0.9));
  bandedTube(md, l.x, l.z, at(0.77), at(1), Math.max(0.5, r0 * 0.16), 5, STEEL);
}

/** Square stone observation tower with a viewing platform and a pyramid roof. */
function observation(md: MeshData, l: Landmark, ground: number): void {
  const hw = Math.min(Math.max(l.r * 0.72, 2.5), 6);
  const r = hw * Math.SQRT2;
  const at = (f: number) => ground + f * l.h;
  const q = Math.PI / 4;
  frustum(md, l.x, l.z, ground - 1.5, at(0.78), r, r * 0.92, 4, STONE, true, q);
  frustum(md, l.x, l.z, at(0.78), at(0.8), r * 1.12, r * 1.12, 4, shade(STONE, 0.8), true, q);
  frustum(md, l.x, l.z, at(0.8), at(0.88), r * 0.8, r * 0.8, 4, shade(STONE, 1.08), false, q);
  frustum(md, l.x, l.z, at(0.88), at(1), r * 0.95, 0, 4, SLATE, true, q);
}

/**
 * Masts and towers of the world as one mesh (they are seen from kilometres away, so no level of
 * detail) plus their guy wires as lines, hidden beyond GUY_DISTANCE.
 */
export function buildLandmarks(scene: Scene, data: WorldData, field: HeightField): { solid: Mesh | null; guys: LinesMesh | null } {
  if (data.landmarks.length === 0) return { solid: null, guys: null };
  const md = new MeshData(false, true);
  const guys: Vector3[][] = [];
  for (const l of data.landmarks) {
    // lowest point of the footprint, so the base never floats on a slope
    let ground = field.dem(l.x, l.z);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      ground = Math.min(ground, field.dem(l.x + Math.cos(a) * l.r, l.z + Math.sin(a) * l.r));
    }
    if (l.kind === 'mast') mast(md, l, ground, field, guys);
    else if (l.kind === 'lattice') lattice(md, l, ground);
    else if (l.kind === 'telecom') telecom(md, l, ground);
    else observation(md, l, ground);
  }
  const mat = new StandardMaterial('landmarks', scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = new Color3(0.08, 0.08, 0.08);
  let lines: LinesMesh | null = null;
  if (guys.length > 0) {
    lines = MeshBuilder.CreateLineSystem('landmark-guys', { lines: guys }, scene);
    lines.color = new Color3(0.3, 0.31, 0.33);
    lines.alpha = 0.7;
    lines.isPickable = false;
    lines.addLODLevel(GUY_DISTANCE, null);
  }
  return { solid: md.build(scene, 'landmarks', mat), guys: lines };
}
