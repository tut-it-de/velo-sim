import {
  Color3,
  Color4,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
  type Scene,
} from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { layoutBanner, planGates, type BannerLayout, type GateSpec, type Measure } from './gatePlan';
import { createRng } from './noise';
import type { TerrainModel } from './terrain';

function paint(mesh: Mesh, color: Color3): Mesh {
  const count = mesh.getTotalVertices();
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b, 1], i * 4);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}

function merged(name: string, parts: Mesh[], scene: Scene): Mesh {
  const m = Mesh.MergeMeshes(parts, true, true, undefined, false, false)!;
  m.name = name;
  const mat = new StandardMaterial(`${name}-mat`, scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  m.material = mat;
  m.isPickable = false;
  return m;
}

function pineMesh(scene: Scene): Mesh {
  const trunk = paint(MeshBuilder.CreateCylinder('t', { height: 2.2, diameter: 0.45, tessellation: 5 }, scene), new Color3(0.36, 0.25, 0.16));
  trunk.position.y = 1.1;
  const low = paint(MeshBuilder.CreateCylinder('c1', { height: 6, diameterTop: 0, diameterBottom: 4.4, tessellation: 7 }, scene), new Color3(0.13, 0.32, 0.17));
  low.position.y = 4.5;
  const high = paint(MeshBuilder.CreateCylinder('c2', { height: 4.5, diameterTop: 0, diameterBottom: 3, tessellation: 7 }, scene), new Color3(0.16, 0.38, 0.2));
  high.position.y = 7.6;
  return merged('pine', [trunk, low, high], scene);
}

function broadleafMesh(scene: Scene, leaf: Color3): Mesh {
  const trunk = paint(MeshBuilder.CreateCylinder('t', { height: 3, diameter: 0.5, tessellation: 5 }, scene), new Color3(0.38, 0.28, 0.18));
  trunk.position.y = 1.5;
  const crown = paint(MeshBuilder.CreateIcoSphere('c', { radius: 2.8, subdivisions: 1, flat: true }, scene), leaf);
  crown.position.y = 4.8;
  crown.scaling.y = 0.85;
  return merged('broadleaf', [trunk, crown], scene);
}

function rockMesh(scene: Scene): Mesh {
  const r = paint(MeshBuilder.CreateIcoSphere('r', { radius: 1.6, subdivisions: 1, flat: true }, scene), new Color3(0.5, 0.48, 0.45));
  r.scaling.set(1.4, 0.7, 1);
  r.position.y = 0.3;
  return merged('rock', [r], scene);
}

function houseMesh(scene: Scene, wall: Color3, roof: Color3): Mesh {
  const body = paint(MeshBuilder.CreateBox('b', { width: 8, height: 5, depth: 6 }, scene), wall);
  body.position.y = 2.5;
  const top = paint(MeshBuilder.CreateCylinder('roof', { height: 8.6, diameter: 7.4, tessellation: 3 }, scene), roof);
  top.rotation.z = Math.PI / 2;
  top.rotation.x = Math.PI / 2;
  top.rotation.y = Math.PI / 2;
  top.position.y = 6.2;
  top.scaling.set(1, 1, 0.6);
  return merged('house', [body, top], scene);
}

interface Placement {
  x: number;
  y: number;
  z: number;
  scale: number;
  rot: number;
}

function applyInstances(mesh: Mesh, placements: Placement[]): void {
  const buf = new Float32Array(placements.length * 16);
  const m = new Matrix();
  const q = new Quaternion();
  placements.forEach((p, i) => {
    Quaternion.RotationYawPitchRollToRef(p.rot, 0, 0, q);
    Matrix.ComposeToRef(new Vector3(p.scale, p.scale, p.scale), q, new Vector3(p.x, p.y, p.z), m);
    m.copyToArray(buf, i * 16);
  });
  mesh.thinInstanceSetBuffer('matrix', buf, 16, true);
  mesh.freezeWorldMatrix();
  mesh.alwaysSelectAsActiveMesh = true;
}

const DENSITY = {
  coast: { trees: 2600, rocks: 300 },
  hills: { trees: 7000, rocks: 250 },
  alpine: { trees: 7500, rocks: 1400 },
  lake: { trees: 7000, rocks: 300 },
} as const;

/** Scatters trees, rocks and villages over the terrain (deterministic per route). */
export function buildProps(scene: Scene, model: TerrainModel): Mesh[] {
  const rng = createRng(1234 + model.track.length);
  const { style } = model;
  const trees: Placement[] = [];
  const trees2: Placement[] = [];
  const rocks: Placement[] = [];
  const want = DENSITY[style];
  const width = model.maxX - model.minX;
  const depth = model.maxZ - model.minZ;

  let attempts = 0;
  while (trees.length + trees2.length < want.trees && attempts++ < want.trees * 6) {
    // Cluster trees: pick a random point, biased towards the road so riders see them.
    const nearRoad = rng() < 0.65;
    let x: number;
    let z: number;
    if (nearRoad) {
      const s = model.track.sample(rng() * model.track.length);
      const side = rng() < 0.5 ? -1 : 1;
      const off = 14 + rng() * 260;
      x = s.x + s.rightX * off * side + (rng() - 0.5) * 30;
      z = s.z + s.rightZ * off * side + (rng() - 0.5) * 30;
    } else {
      x = model.minX + rng() * width;
      z = model.minZ + rng() * depth;
    }
    const forest = model.noise.noise(x / 500, z / 500);
    if (forest < (style === 'coast' ? 0.05 : -0.15)) continue;
    if (model.roadDistance(x, z, 14) < 14) continue;
    const y = model.heightAt(x, z);
    if (model.seaLevel !== null && y < model.seaLevel + 3) continue;
    if (style === 'alpine' && y > 980) continue;
    const slope = Math.abs(model.heightAt(x + 4, z) - y) + Math.abs(model.heightAt(x, z + 4) - y);
    if (slope > 4.5) continue;
    const p = { x, y: y - 0.3, z, scale: 0.7 + rng() * 0.8, rot: rng() * Math.PI * 2 };
    if (style === 'alpine' || (style === 'hills' && rng() < 0.3)) trees.push(p);
    else trees2.push(p);
  }

  attempts = 0;
  while (rocks.length < want.rocks && attempts++ < want.rocks * 8) {
    const x = model.minX + rng() * width;
    const z = model.minZ + rng() * depth;
    if (model.roadDistance(x, z, 10) < 10) continue;
    const y = model.heightAt(x, z);
    if (model.seaLevel !== null && y < model.seaLevel - 1) continue;
    rocks.push({ x, y: y - 0.2, z, scale: 0.5 + rng() * (style === 'alpine' ? 3 : 1.2), rot: rng() * Math.PI * 2 });
  }

  const meshes: Mesh[] = [];
  if (trees.length) {
    const m = pineMesh(scene);
    applyInstances(m, trees);
    meshes.push(m);
  }
  if (trees2.length) {
    const m = broadleafMesh(scene, style === 'coast' ? new Color3(0.36, 0.52, 0.22) : new Color3(0.27, 0.48, 0.2));
    applyInstances(m, trees2);
    meshes.push(m);
  }
  if (rocks.length) {
    const m = rockMesh(scene);
    applyInstances(m, rocks);
    meshes.push(m);
  }
  meshes.push(...buildVillages(scene, model, rng));
  return meshes;
}

/** Small clusters of houses next to the road at a few fixed spots per route. */
function buildVillages(scene: Scene, model: TerrainModel, rng: () => number): Mesh[] {
  const track = model.track;
  const spots: number[] =
    model.style === 'coast'
      ? [track.length * 0.9, track.length * 0.93, track.length * 0.45]
      : model.style === 'hills'
        ? [track.length * 0.96, track.length * 0.25, track.length * 0.6]
        : [track.length * 0.42, track.length * 0.93, track.length * 0.75];
  const houses: Placement[] = [];
  for (const d0 of spots) {
    for (let k = 0; k < 9; k++) {
      const d = d0 + (rng() - 0.5) * 500;
      const s = track.sample(d);
      const side = rng() < 0.5 ? -1 : 1;
      const off = 18 + rng() * 45;
      const x = s.x + s.rightX * off * side;
      const z = s.z + s.rightZ * off * side;
      if (model.roadDistance(x, z, 16) < 16) continue;
      const y = model.heightAt(x, z);
      if (model.seaLevel !== null && y < model.seaLevel + 2) continue;
      houses.push({ x, y: y - 0.5, z, scale: 0.9 + rng() * 0.4, rot: s.heading + (rng() < 0.5 ? 0 : Math.PI / 2) });
    }
  }
  if (!houses.length) return [];
  const wall = model.style === 'alpine' ? new Color3(0.62, 0.45, 0.3) : new Color3(0.92, 0.9, 0.84);
  const roof = model.style === 'coast' ? new Color3(0.7, 0.32, 0.22) : new Color3(0.35, 0.3, 0.3);
  const m = houseMesh(scene, wall, roof);
  applyInstances(m, houses);
  return [m];
}

/** Where the arch legs stand: lateral offsets of the left and right leg and the ground under them. */
export interface GateSite {
  legs(d: number): [number, number];
  /** Ground height; road height when missing. */
  ground?(x: number, z: number): number;
}

const TUBE_R = 0.42;
const CORNER_R = 1.0;
/** Height of the tube centre above the road. */
const ARCH_H = 6.9;
const BANNER_DEPTH = 0.34;
const PX_PER_M = 150;
const TITLE_FONT = '"Barlow Condensed", "Arial Narrow", system-ui, sans-serif';

function fontOf(font: 'title' | 'kicker', px: number): string {
  return font === 'title' ? `italic 700 ${px}px ${TITLE_FONT}` : `600 ${px}px ${TITLE_FONT}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
const measure: Measure = (text, font, px) => {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = fontOf(font, px);
  if (font === 'kicker') (measureCtx as { letterSpacing?: string }).letterSpacing = `${px * 0.12}px`;
  else (measureCtx as { letterSpacing?: string }).letterSpacing = '0px';
  return measureCtx.measureText(text).width;
};

/** Wait (briefly) for the banner font so the layout measures the real glyphs. */
async function bannerFontReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000));
  await Promise.race([Promise.all([document.fonts.load(fontOf('title', 64)), document.fonts.load(fontOf('kicker', 64))]).then(() => undefined), timeout]).catch(() => undefined);
}

function bannerTexture(scene: Scene, layout: BannerLayout, widthM: number, color: string): DynamicTexture {
  const w = Math.min(2048, Math.max(512, Math.round(widthM * PX_PER_M)));
  const px = w / widthM;
  const h = Math.round(layout.heightM * px);
  const tex = new DynamicTexture(`banner-${layout.lines.join(' ')}`, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  tex.anisotropicFilteringLevel = 8;
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#272b33');
  bg.addColorStop(1, '#14161b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  // segment colour as a bar along the bottom edge and thin side caps
  const bar = Math.round(0.13 * px);
  ctx.fillStyle = color;
  ctx.fillRect(0, h - bar, w, bar);
  ctx.fillRect(0, 0, Math.round(0.08 * px), h);
  ctx.fillRect(w - Math.round(0.08 * px), 0, Math.round(0.08 * px), h);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const spacing = ctx as { letterSpacing?: string };
  const kickerPx = layout.kickerM * px;
  const titlePx = layout.titleM * px;
  // vertical rhythm: kicker cap height, gap, title lines; centred in the space above the bar
  const capK = kickerPx * 0.7;
  const capT = titlePx * 0.7;
  const lineGap = titlePx * 0.22;
  const gap = layout.kicker ? kickerPx * 0.55 : 0;
  const block = (layout.kicker ? capK + gap : 0) + layout.lines.length * capT + (layout.lines.length - 1) * lineGap;
  let y = (h - bar - block) / 2;
  if (layout.kicker) {
    y += capK;
    ctx.font = fontOf('kicker', kickerPx);
    spacing.letterSpacing = `${kickerPx * 0.12}px`;
    ctx.fillStyle = Color3.Lerp(Color3.FromHexString(color), Color3.White(), 0.45).toHexString();
    ctx.fillText(layout.kicker, w / 2, y);
    y += gap;
  }
  ctx.font = fontOf('title', titlePx);
  spacing.letterSpacing = '0px';
  ctx.fillStyle = '#ffffff';
  for (const line of layout.lines) {
    y += capT;
    ctx.fillText(line, w / 2, y);
    y += lineGap;
  }
  tex.update(true);
  return tex;
}

interface GateMaterials {
  dark: StandardMaterial;
  ballast: StandardMaterial;
  tube: Map<string, StandardMaterial>;
}

function tubeMaterial(scene: Scene, mats: GateMaterials, color: string): StandardMaterial {
  let m = mats.tube.get(color);
  if (!m) {
    m = new StandardMaterial(`gate-tube-${color}`, scene);
    m.diffuseColor = Color3.FromHexString(color);
    // inflated nylon: soft broad sheen
    m.specularColor = new Color3(0.32, 0.32, 0.32);
    m.specularPower = 18;
    m.emissiveColor = Color3.FromHexString(color).scale(0.2);
    mats.tube.set(color, m);
  }
  return m;
}

/** An inflatable arch across the road with a banner readable from both directions. */
function buildArch(scene: Scene, track: Track, gate: GateSpec, site: GateSite | undefined, mats: GateMaterials): Mesh {
  const s = track.sample(gate.d);
  const [left, right] = site?.legs(gate.d) ?? [4.6, 4.6];
  const groundAt = (lateral: number) => {
    if (!site?.ground) return 0;
    const g = site.ground(s.x + s.rightX * lateral, s.z + s.rightZ * lateral) - s.y;
    return Math.min(1.5, Math.max(-4, g));
  };
  const gl = groundAt(-left);
  const gr = groundAt(right);
  const xl = -left;
  const xr = right;
  const top = Math.max(0, gl, gr) + ARCH_H;

  const path: Vector3[] = [];
  path.push(new Vector3(xl, gl - 0.25, 0), new Vector3(xl, top - CORNER_R, 0));
  const arc = (cx: number, from: number, to: number) => {
    for (let k = 1; k <= 7; k++) {
      const a = from + ((to - from) * k) / 7;
      path.push(new Vector3(cx + Math.cos(a) * CORNER_R, top - CORNER_R + Math.sin(a) * CORNER_R, 0));
    }
  };
  arc(xl + CORNER_R, Math.PI, Math.PI / 2);
  path.push(new Vector3(xr - CORNER_R, top, 0));
  arc(xr - CORNER_R, Math.PI / 2, 0);
  path.push(new Vector3(xr, gr - 0.25, 0));
  const parts: Mesh[] = [];
  const tube = MeshBuilder.CreateTube('gate-tube', { path, radius: TUBE_R, tessellation: 16, cap: Mesh.CAP_ALL }, scene);
  tube.material = tubeMaterial(scene, mats, gate.color);
  parts.push(tube);

  // ballast blocks holding the legs down, sunk a little into the ground
  for (const [x, g] of [
    [xl, gl],
    [xr, gr],
  ] as const) {
    const b = MeshBuilder.CreateBox('gate-ballast', { width: 1.1, height: 0.75, depth: 1.25 }, scene);
    b.position.set(x, g + 0.08, 0);
    b.material = mats.ballast;
    parts.push(b);
  }

  // banner panel hung between the legs, tucked under the top tube
  const bw = xr - xl - 2 * TUBE_R + 0.1;
  const layout = layoutBanner(measure, gate.kicker, gate.title, bw);
  const bh = layout.heightM;
  const cy = top - TUBE_R * 0.75 - bh / 2;
  const cx = (xl + xr) / 2;
  const panel = MeshBuilder.CreateBox('gate-panel', { width: bw, height: bh, depth: BANNER_DEPTH }, scene);
  panel.position.set(cx, cy, 0);
  panel.material = mats.dark;
  parts.push(panel);
  const bm = new StandardMaterial(`gate-banner-${gate.d}`, scene);
  const tex = bannerTexture(scene, layout, bw, gate.color);
  bm.diffuseColor = Color3.Black();
  bm.specularColor = Color3.Black();
  bm.emissiveTexture = tex;
  bm.disableLighting = true;
  // pulled forward in depth: with a 16-bit depth buffer (some iPads) the face would flicker against the panel
  bm.zOffset = -2;
  for (const side of [-1, 1]) {
    // the plane faces −z; the back one is turned round so its text reads correctly from behind
    const face = MeshBuilder.CreatePlane('gate-banner', { width: bw - 0.02, height: bh - 0.02 }, scene);
    face.position.set(cx, cy, side * (BANNER_DEPTH / 2 + 0.04));
    if (side > 0) face.rotation.y = Math.PI;
    face.material = bm;
    parts.push(face);
  }

  const root = new Mesh(`gate-${gate.d}`, scene);
  for (const p of parts) {
    p.parent = root;
    p.isPickable = false;
  }
  root.position.set(s.x, s.y, s.z);
  root.rotation.y = s.heading;
  return root;
}

/**
 * All race arches of a lap: start/finish and the start and end of every segment (arches that would
 * stand within a few metres of each other are merged). `site` places the legs at the road edge
 * of this world and on its ground; without one they stand 4.6 m from the centre line at road height.
 */
export async function buildRaceGates(scene: Scene, track: Track, site?: GateSite): Promise<Mesh[]> {
  await bannerFontReady();
  const dark = new StandardMaterial('gate-dark', scene);
  dark.diffuseColor = new Color3(0.08, 0.09, 0.1);
  dark.specularColor = Color3.Black();
  const ballast = new StandardMaterial('gate-ballast', scene);
  ballast.diffuseColor = new Color3(0.42, 0.42, 0.4);
  ballast.specularColor = Color3.Black();
  const mats: GateMaterials = { dark, ballast, tube: new Map() };
  return planGates(track.length, track.name, track.segments).map((g) => buildArch(scene, track, g, site, mats));
}

export function skyDome(scene: Scene, top: Color3, horizon: Color3): Mesh {
  const sky = MeshBuilder.CreateSphere('sky', { diameter: 20000, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
  const positions = sky.getVerticesData(VertexBuffer.PositionKind)!;
  const colors = new Float32Array((positions.length / 3) * 4);
  for (let i = 0; i < positions.length / 3; i++) {
    const y = positions[i * 3 + 1]! / 10000;
    const t = Math.min(1, Math.max(0, y * 2.2));
    const c = Color3.Lerp(horizon, top, Math.sqrt(t));
    colors.set([c.r, c.g, c.b, 1], i * 4);
  }
  sky.setVerticesData(VertexBuffer.ColorKind, colors);
  const mat = new StandardMaterial('sky-mat', scene);
  mat.disableLighting = true;
  mat.emissiveColor = Color3.White();
  mat.diffuseColor = Color3.Black();
  mat.fogEnabled = false;
  mat.backFaceCulling = false;
  sky.material = mat;
  sky.infiniteDistance = true;
  sky.isPickable = false;
  sky.applyFog = false;
  return sky;
}

export { Color4 };
