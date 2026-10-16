import {
  Color3,
  Color4,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Vector3,
  Vector4,
  VertexBuffer,
  type Scene,
} from '@babylonjs/core';
import type { RouteSegment, Track } from '@velo/routes';
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

function bannerTexture(scene: Scene, text: string, bg: string, fg = '#ffffff'): DynamicTexture {
  const tex = new DynamicTexture(`banner-${text}`, { width: 1024, height: 128 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = fg;
  ctx.font = 'bold 76px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 68);
  tex.update();
  return tex;
}

/** An arch across the road with a text banner (start/finish, segment start/end). */
export function buildGate(scene: Scene, track: Track, distanceM: number, text: string, color: string): Mesh {
  const s = track.sample(distanceM);
  const half = 6.2;
  const height = 6.5;
  const pillarMat = new StandardMaterial(`gate-pillar-${text}`, scene);
  pillarMat.diffuseColor = Color3.FromHexString(color).scale(0.7);
  pillarMat.specularColor = Color3.Black();
  const parts: Mesh[] = [];
  for (const side of [-1, 1]) {
    const p = MeshBuilder.CreateBox('pillar', { width: 0.5, height, depth: 0.5 }, scene);
    p.position.set(side * half, height / 2, 0);
    p.material = pillarMat;
    parts.push(p);
  }
  // back side mirrored in u so the text reads correctly from both directions
  const banner = MeshBuilder.CreatePlane(
    'banner',
    { width: half * 2 + 0.5, height: 1.4, sideOrientation: Mesh.DOUBLESIDE, frontUVs: new Vector4(0, 0, 1, 1), backUVs: new Vector4(1, 0, 0, 1) },
    scene,
  );
  banner.position.set(0, height - 0.4, 0);
  const bm = new StandardMaterial(`gate-banner-${text}`, scene);
  bm.diffuseTexture = bannerTexture(scene, text, color);
  bm.emissiveColor = new Color3(0.35, 0.35, 0.35);
  bm.specularColor = Color3.Black();
  banner.material = bm;
  parts.push(banner);

  const root = new Mesh(`gate-${text}`, scene);
  for (const p of parts) p.parent = root;
  root.position.set(s.x, s.y, s.z);
  root.rotation.y = s.heading;
  return root;
}

export function buildSegmentGates(scene: Scene, track: Track, segments: RouteSegment[]): Mesh[] {
  const colors: Record<RouteSegment['type'], string> = { climb: '#c62828', sprint: '#2e7d32', descent: '#1565c0' };
  const label: Record<RouteSegment['type'], string> = { climb: 'BERGWERTUNG', sprint: 'SPRINT', descent: 'ABFAHRT' };
  const out: Mesh[] = [];
  for (const seg of segments) {
    out.push(buildGate(scene, track, seg.startM, `${label[seg.type]} · ${seg.name.toUpperCase()}`, colors[seg.type]));
    out.push(buildGate(scene, track, seg.endM, `${seg.name.toUpperCase()} · ZIEL`, colors[seg.type]));
  }
  return out;
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
