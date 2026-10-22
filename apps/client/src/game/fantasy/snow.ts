import {
  Color3,
  Color4,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  Quaternion,
  StandardMaterial,
  Vector3,
  Vector4,
  VertexBuffer,
  VertexData,
  type Scene,
} from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { Noise2D, smoothstep } from '../noise';
import { buildRoadMesh } from '../road';
import { TerrainModel, buildTerrainMesh } from '../terrain';
import { at, atmosphere, every, frames, rng, sweep, type Frame } from './common';

type V3 = [number, number, number];

const SNOW = new Color3(0.94, 0.96, 0.99);
const SNOW_SHADE = new Color3(0.72, 0.8, 0.9);
const ROCK = new Color3(0.54, 0.55, 0.58);
const HORIZON = Color3.FromHexString('#e6eef8');

/**
 * Unindexed triangles with per-vertex colours. Each triangle is wound so its normal faces `out`,
 * which keeps hand-built shapes (roofs, peaks) visible and lit from outside.
 */
class Soup {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];

  tri(a: V3, b: V3, c: V3, out: V3, color: Color3): void {
    const n = cross(sub(c, a), sub(b, a));
    const flip = dot(n, out) < 0;
    const pts = flip ? [a, c, b] : [a, b, c];
    for (const p of pts) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(color.r, color.g, color.b, 1);
    }
  }

  /** Quad given in order around its outline. */
  quad(a: V3, b: V3, c: V3, d: V3, out: V3, color: Color3): void {
    this.tri(a, b, c, out, color);
    this.tri(a, c, d, out, color);
  }

  mesh(scene: Scene, name: string): Mesh {
    const pos = Float32Array.from(this.pos);
    const idx = new Uint32Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    const nor = new Float32Array(pos.length);
    VertexData.ComputeNormals(pos, idx, nor);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.normals = nor;
    vd.colors = Float32Array.from(this.col);
    const m = new Mesh(name, scene);
    vd.applyToMesh(m, false);
    m.isPickable = false;
    return m;
  }
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function paint(mesh: Mesh, color: Color3): Mesh {
  const count = mesh.getTotalVertices();
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b, 1], i * 4);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}

/** Merges parts into one static mesh with a plain material (vertex colours, no specular). */
function merged(name: string, parts: Mesh[], scene: Scene, emissive?: Color3): Mesh {
  const m = Mesh.MergeMeshes(parts, true, true, undefined, false, false)!;
  m.name = name;
  const mat = new StandardMaterial(`${name}-mat`, scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  if (emissive) {
    mat.emissiveColor = emissive;
    mat.disableLighting = true;
  }
  m.material = mat;
  m.isPickable = false;
  return m;
}

/** Thin instances of one mesh; the matrices are static, so the mesh is frozen. */
function instance(mesh: Mesh, mats: Matrix[]): void {
  const buf = new Float32Array(mats.length * 16);
  mats.forEach((m, i) => m.copyToArray(buf, i * 16));
  mesh.thinInstanceSetBuffer('matrix', buf, 16, true);
  mesh.freezeWorldMatrix();
  mesh.alwaysSelectAsActiveMesh = true;
}

function place(p: Vector3, yaw: number, scale = 1): Matrix {
  return Matrix.Compose(new Vector3(scale, scale, scale), Quaternion.RotationYawPitchRoll(yaw, 0, 0), p);
}

/** Snow-covered fir: dark green tiers, each with a white cap on top. */
function firMesh(scene: Scene): Mesh {
  const green = new Color3(0.1, 0.27, 0.17);
  const snow = new Color3(0.97, 0.98, 1);
  const trunk = paint(MeshBuilder.CreateCylinder('trunk', { height: 2, diameter: 0.45, tessellation: 5 }, scene), new Color3(0.3, 0.2, 0.13));
  trunk.position.y = 1;
  const parts: Mesh[] = [trunk];
  // base height, tier height, base diameter
  const tiers: Array<[number, number, number]> = [
    [1.4, 3.4, 4],
    [3.3, 3, 3.2],
    [4.9, 2.6, 2.4],
  ];
  for (const [y, h, d] of tiers) {
    const cone = paint(MeshBuilder.CreateCylinder('tier', { height: h, diameterTop: 0, diameterBottom: d, tessellation: 8 }, scene), green);
    cone.position.y = y + h / 2;
    // the cap sits on the upper 42 % of the tier and ends exactly at the tip
    const cap = paint(MeshBuilder.CreateCylinder('cap', { height: h * 0.42, diameterTop: 0, diameterBottom: d * 0.46, tessellation: 8 }, scene), snow);
    cap.position.y = y + h * 0.79;
    parts.push(cone, cap);
  }
  return merged('snow-fir', parts, scene);
}

/** A wooden chalet with a steep roof, thick snow on top and lit windows (local front = +z). */
function chalet(): { body: Soup; windows: Soup } {
  const W = 6.4;
  const D = 5.6;
  const Hw = 3.4;
  const o = 0.45;
  const hw = W / 2 + o;
  const L = D / 2 + o;
  const rY = Hw + 3.1;
  const wood = new Color3(0.46, 0.32, 0.2);
  const door = new Color3(0.25, 0.16, 0.1);
  const roof = new Color3(0.2, 0.2, 0.24);
  const snow = new Color3(0.97, 0.98, 1);
  const body = new Soup();
  body.quad([-W / 2, 0, D / 2], [W / 2, 0, D / 2], [W / 2, Hw, D / 2], [-W / 2, Hw, D / 2], [0, 0, 1], wood);
  body.quad([W / 2, 0, -D / 2], [-W / 2, 0, -D / 2], [-W / 2, Hw, -D / 2], [W / 2, Hw, -D / 2], [0, 0, -1], wood);
  body.quad([-W / 2, 0, -D / 2], [-W / 2, 0, D / 2], [-W / 2, Hw, D / 2], [-W / 2, Hw, -D / 2], [-1, 0, 0], wood);
  body.quad([W / 2, 0, D / 2], [W / 2, 0, -D / 2], [W / 2, Hw, -D / 2], [W / 2, Hw, D / 2], [1, 0, 0], wood);
  body.quad([-0.55, 0, D / 2 + 0.02], [0.55, 0, D / 2 + 0.02], [0.55, 2.3, D / 2 + 0.02], [-0.55, 2.3, D / 2 + 0.02], [0, 0, 1], door);
  // roof slopes and gable ends
  body.quad([-hw, Hw, -L], [-hw, Hw, L], [0, rY, L], [0, rY, -L], [-1, 1, 0], roof);
  body.quad([hw, Hw, L], [hw, Hw, -L], [0, rY, -L], [0, rY, L], [1, 1, 0], roof);
  body.tri([-hw, Hw, L], [hw, Hw, L], [0, rY, L], [0, 0, 1], roof);
  body.tri([hw, Hw, -L], [-hw, Hw, -L], [0, rY, -L], [0, 0, -1], roof);
  // snow lies on the slopes: thicker towards the ridge
  body.quad([-hw - 0.05, Hw + 0.25, -L - 0.05], [-hw - 0.05, Hw + 0.25, L + 0.05], [-0.05, rY + 0.55, L + 0.05], [-0.05, rY + 0.55, -L - 0.05], [-1, 1, 0], snow);
  body.quad([hw + 0.05, Hw + 0.25, L + 0.05], [hw + 0.05, Hw + 0.25, -L - 0.05], [0.05, rY + 0.55, -L - 0.05], [0.05, rY + 0.55, L + 0.05], [1, 1, 0], snow);

  const windows = new Soup();
  const lit = new Color3(1, 0.8, 0.4);
  const z = D / 2 + 0.04;
  windows.quad([-2.3, 1.1, z], [-1, 1.1, z], [-1, 2.2, z], [-2.3, 2.2, z], [0, 0, 1], lit);
  windows.quad([1, 1.1, z], [2.3, 1.1, z], [2.3, 2.2, z], [1, 2.2, z], [0, 0, 1], lit);
  const x = W / 2 + 0.04;
  windows.quad([x, 1.1, -1.4], [x, 1.1, -0.2], [x, 2.2, -0.2], [x, 2.2, -1.4], [1, 0, 0], lit);
  return { body, windows };
}

/** Three-ball snowman with a carrot nose and coal eyes (nose = +z). */
function snowmanMesh(scene: Scene): Mesh {
  const white = new Color3(0.96, 0.97, 1);
  const parts: Mesh[] = [];
  for (const [y, d] of [
    [0.95, 1.9],
    [2.5, 1.4],
    [3.7, 1.0],
  ] as const) {
    const s = paint(MeshBuilder.CreateSphere('ball', { diameter: d, segments: 6 }, scene), white);
    s.position.y = y;
    parts.push(s);
  }
  const nose = paint(MeshBuilder.CreateCylinder('nose', { height: 0.5, diameterTop: 0, diameterBottom: 0.22, tessellation: 6 }, scene), new Color3(0.95, 0.5, 0.1));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 3.7, 0.55);
  parts.push(nose);
  for (const ex of [-0.18, 0.18]) {
    const eye = paint(MeshBuilder.CreateSphere('eye', { diameter: 0.13, segments: 4 }, scene), new Color3(0.06, 0.06, 0.07));
    eye.position.set(ex, 3.88, 0.45);
    parts.push(eye);
  }
  return merged('snowman', parts, scene);
}

/** Roadside marker post: dark shaft with a red cap. */
function postMesh(scene: Scene): Mesh {
  const shaft = paint(MeshBuilder.CreateCylinder('shaft', { height: 1.7, diameter: 0.14, tessellation: 5 }, scene), new Color3(0.24, 0.2, 0.17));
  shaft.position.y = 0.85;
  const cap = paint(MeshBuilder.CreateBox('cap', { width: 0.36, height: 0.4, depth: 0.1 }, scene), new Color3(0.85, 0.12, 0.1));
  cap.position.y = 1.7;
  return merged('marker', [shaft, cap], scene);
}

/** Distant jagged peaks as one soup: a fan of rings per peak, apex at the top. */
function peaksMesh(scene: Scene, cx: number, cz: number, baseY: number): Mesh {
  const r = rng(2024);
  const noise = new Noise2D(77);
  const soup = new Soup();
  const rings = 6;
  const segs = 12;
  for (let p = 0; p < 44; p++) {
    const a0 = (p / 44) * Math.PI * 2 + (r() - 0.5) * 0.12;
    const dist = 3600 + r() * 2600;
    const px = cx + Math.cos(a0) * dist;
    const pz = cz + Math.sin(a0) * dist;
    const R = 900 + r() * 1000;
    const H = 550 + r() * 950;
    // aerial perspective: far peaks drift towards the horizon colour
    const haze = 0.1 + 0.35 * ((dist - 3600) / 2600);
    const tint = Color3.Lerp(new Color3(0.86, 0.9, 0.96), HORIZON, haze);
    const grid: V3[][] = [];
    for (let k = 0; k <= rings; k++) {
      const t = k / rings;
      const row: V3[] = [];
      for (let s = 0; s < segs; s++) {
        const th = (s / segs) * Math.PI * 2;
        const jag = noise.noise(Math.cos(th) * 1.4 + p * 3.1, Math.sin(th) * 1.4 + t * 2.2);
        const rad = R * t * (1 + 0.3 * jag);
        const y = baseY + H * Math.pow(1 - t, 1.25) * (1 + 0.1 * noise.noise(th * 2 + p, t * 3));
        row.push([px + Math.cos(th) * rad, y, pz + Math.sin(th) * rad]);
      }
      grid.push(row);
    }
    for (let k = 0; k < rings; k++) {
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        const a = grid[k]![s]!;
        const b = grid[k]![s1]!;
        const c = grid[k + 1]![s1]!;
        const d = grid[k + 1]![s]!;
        const mid = (s + 0.5) / segs;
        const th = mid * Math.PI * 2;
        const out: V3 = [Math.cos(th) * 0.8, 0.6, Math.sin(th) * 0.8];
        // snow on the upper part, grey-blue rock lower down
        const hf = (grid[k]![s]![1] - baseY) / H + 0.12 * noise.noise(a[0] / 400, a[2] / 400);
        const snowiness = smoothstep(0.42, 0.7, hf);
        const col = Color3.Lerp(new Color3(0.5, 0.56, 0.66), new Color3(1, 1, 1), snowiness);
        soup.quad(a, d, c, b, out, Color3.Lerp(col, tint, 0.15));
      }
    }
  }
  const m = soup.mesh(scene, 'snow-peaks');
  const mat = new StandardMaterial('snow-peaks-mat', scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  mat.fogEnabled = false;
  m.material = mat;
  return m;
}

function roadMaterial(scene: Scene): StandardMaterial {
  const w = 256;
  const h = 512;
  const tex = new DynamicTexture('snow-road-tex', { width: w, height: h }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  // texture u spans the 15 m skirt (-7.5 .. 7.5 m); the asphalt-width part is the road itself
  const px = (lat: number) => ((lat + 7.5) / 15) * w;
  ctx.fillStyle = '#dde5ee';
  ctx.fillRect(0, 0, w, h);
  const rnd = rng(31);
  for (let i = 0; i < 2200; i++) {
    const g = 198 + Math.floor(rnd() * 40);
    ctx.fillStyle = `rgba(${g},${g + 4},${g + 12},0.55)`;
    ctx.fillRect(rnd() * w, rnd() * h, 2, 2);
  }
  // skirts under the snow banks: greyer
  ctx.fillStyle = 'rgba(150,164,184,0.7)';
  ctx.fillRect(0, 0, px(-4.6), h);
  ctx.fillRect(px(4.6), 0, w - px(4.6), h);
  // two compacted wheel tracks, slightly blue
  for (const lat of [-1.2, 1.2]) {
    ctx.fillStyle = 'rgba(132,150,178,0.55)';
    ctx.fillRect(px(lat) - 9, 0, 18, h);
    ctx.fillStyle = 'rgba(120,138,166,0.8)';
    ctx.fillRect(px(lat) - 5, 0, 10, h);
  }
  tex.update();
  const mat = new StandardMaterial('snow-road-mat', scene);
  mat.diffuseTexture = tex;
  mat.specularColor = new Color3(0.12, 0.13, 0.15);
  return mat;
}

function flakeTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture('snow-flake', { width: 32, height: 32 }, scene, false);
  tex.hasAlpha = true;
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  tex.update();
  return tex;
}

/** Falling snow around the camera: ~1500 flakes, slow fall with a gentle sideways drift. */
function fallingSnow(scene: Scene): void {
  const emitter = new Vector3();
  const ps = new ParticleSystem('snowfall', 1500, scene);
  ps.particleTexture = flakeTexture(scene);
  ps.emitter = emitter;
  ps.createBoxEmitter(new Vector3(-0.1, -1, -0.1), new Vector3(0.1, -1, 0.1), new Vector3(-60, 6, -60), new Vector3(60, 24, 60));
  ps.emitRate = 210;
  ps.minLifeTime = 5;
  ps.maxLifeTime = 8;
  ps.minSize = 0.12;
  ps.maxSize = 0.3;
  ps.minEmitPower = 0.5;
  ps.maxEmitPower = 0.8;
  ps.minAngularSpeed = -1;
  ps.maxAngularSpeed = 1;
  ps.gravity = new Vector3(0.12, -0.12, 0.04);
  ps.color1 = new Color4(1, 1, 1, 0.95);
  ps.color2 = new Color4(0.92, 0.95, 1, 0.85);
  ps.colorDead = new Color4(1, 1, 1, 0);
  ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
  ps.start();
  // the flakes follow the camera, so the snow is always around the rider
  scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera;
    if (cam) emitter.copyFrom(cam.position);
  });
}

/** Builds the terrain with snow colours and fades its outer ring down to a valley floor. */
function snowTerrain(scene: Scene, track: Track): { mesh: Mesh; ground: (x: number, z: number) => number } {
  const model = new TerrainModel(track, track.definition.style);
  const spacing = Math.max(16, Math.ceil(Math.max(model.maxX - model.minX, model.maxZ - model.minZ) / 250));
  const mesh = buildTerrainMesh(scene, model, spacing);
  const nx = Math.ceil((model.maxX - model.minX) / spacing) + 1;
  const nz = Math.ceil((model.maxZ - model.minZ) / spacing) + 1;
  const floorY = track.minElevation - 60;
  const noise = new Noise2D(track.count);

  const pos = mesh.getVerticesData(VertexBuffer.PositionKind) as Float32Array;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3 + 1;
      // The coarse grid cannot show the 8 m road corridor: near the road, cap each node at road level
      // plus a gentle rise, so the snow never covers the asphalt between two grid nodes.
      const near = model.index.nearest(model.minX + i * spacing, model.minZ + j * spacing, 200);
      if (near.dist < Infinity) pos[k] = Math.min(pos[k]!, near.y - 0.6 + Math.max(0, near.dist - spacing) * 0.8);
      // the far edge of the grid drops out of sight; distant peaks take over there
      const edge = Math.min(i, nx - 1 - i, j, nz - 1 - j) * spacing;
      pos[k] = floorY + (pos[k]! - floorY) * smoothstep(0, 900, edge);
    }
  }
  const idx = mesh.getIndices()!;
  const nor = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, idx, nor);

  const col = new Float32Array((pos.length / 3) * 4);
  for (let k = 0; k < pos.length / 3; k++) {
    const x = pos[k * 3]!;
    const z = pos[k * 3 + 2]!;
    const ny = nor[k * 3 + 1]!;
    // steep faces show rock, flatter ground is snow; soft drifts vary the snow tone
    const rock = 1 - smoothstep(0.6, 0.8, ny);
    const drift = 0.5 + 0.5 * noise.noise(x / 160, z / 160);
    let c = Color3.Lerp(SNOW_SHADE, SNOW, smoothstep(0.5, 0.85, ny) * (0.55 + 0.45 * drift));
    c = Color3.Lerp(c, ROCK, rock);
    const shade = 0.95 + 0.05 * noise.noise(x / 37, z / 37);
    col.set([c.r * shade, c.g * shade, c.b * shade, 1], k * 4);
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, pos, false);
  mesh.setVerticesData(VertexBuffer.NormalKind, nor, false);
  mesh.setVerticesData(VertexBuffer.ColorKind, col, false);

  // height of the rendered triangles (same split as buildTerrainMesh), so props sit exactly on the snow
  const ground = (x: number, z: number): number => {
    const gx = Math.min(nx - 1.001, Math.max(0, (x - model.minX) / spacing));
    const gz = Math.min(nz - 1.001, Math.max(0, (z - model.minZ) / spacing));
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const a = j * nx + i;
    const b = a + 1;
    const c = a + nx;
    const d = c + 1;
    const H = (q: number) => pos[q * 3 + 1]!;
    return fx + fz <= 1 ? H(a) + fx * (H(b) - H(a)) + fz * (H(c) - H(a)) : H(d) + (1 - fx) * (H(c) - H(d)) + (1 - fz) * (H(b) - H(d));
  };
  return { mesh, ground };
}

export async function buildSnow(scene: Scene, track: Track): Promise<void> {
  atmosphere(scene, { top: '#5f92d6', horizon: '#e6eef8', fog: 0.00045, sunDir: [-0.4, -1, 0.35], sun: '#fff6e8', sunIntensity: 1.0, hemi: 0.85, ground: '#c9d6e8' });
  const L = track.length;
  const fs = frames(track, 4);
  const stride = Math.max(1, Math.round(4 / track.step));
  // frame of the road at a track distance (wraps around the loop)
  const frameAt = (d: number): Frame => fs[Math.round((((d % L) + L) % L) / (stride * track.step)) % (fs.length - 1)]!;
  const { mesh: terrain, ground } = snowTerrain(scene, track);
  terrain.freezeWorldMatrix();

  // far white ground under the terrain edge, hidden by fog
  const floor = MeshBuilder.CreateGround('snow-floor', { width: 40000, height: 40000, subdivisions: 1 }, scene);
  floor.position.y = track.minElevation - 61.5;
  const floorMat = new StandardMaterial('snow-floor-mat', scene);
  floorMat.diffuseColor = new Color3(0.84, 0.88, 0.94);
  floorMat.specularColor = Color3.Black();
  floor.material = floorMat;
  floor.isPickable = false;

  // packed road and white snow banks along both edges
  buildRoadMesh(scene, track).material = roadMaterial(scene);
  const bankMat = new StandardMaterial('snow-bank-mat', scene);
  bankMat.diffuseColor = new Color3(0.97, 0.98, 1);
  bankMat.specularColor = Color3.Black();
  for (const side of [-1, 1]) {
    const bank = sweep(scene, 'snow-bank', track, [
      { lateral: side * 4.4, up: 0.05, u: 0 },
      { lateral: side * 5.0, up: 0.55, u: 0.3 },
      { lateral: side * 5.6, up: 0.7, u: 0.5 },
      { lateral: side * 6.5, up: 0.3, u: 0.8 },
      { lateral: side * 7.2, up: -0.3, u: 1 },
    ].sort((p, q) => p.lateral - q.lateral), { everyM: 12 });
    bank.material = bankMat;
    bank.freezeWorldMatrix();
  }

  // fir trees in clusters, 10 to 150 m from the road
  const r = rng(4242);
  const firs: Matrix[] = [];
  for (let c = 0; c < 46; c++) {
    const d0 = r() * L;
    const side = r() < 0.5 ? -1 : 1;
    const lat0 = 12 + Math.pow(r(), 1.6) * 130;
    for (let t = 0; t < 9; t++) {
      const d = d0 + (r() - 0.5) * 36;
      const lat = clampLat(lat0 + (r() - 0.5) * 26) * side;
      // keep the ski jump clear
      if (d > 4500 && d < 5600 && Math.abs(lat) > 45) continue;
      const p = at(frameAt(d), lat);
      firs.push(place(new Vector3(p.x, ground(p.x, p.z) - 0.35, p.z), r() * Math.PI * 2, 0.8 + r() * 0.9));
    }
  }
  instance(firMesh(scene), firs);

  // chalets: three at the start, four around the summit; front faces the road
  const chaletSites: Array<[number, number]> = [
    [320, -21],
    [540, 27],
    [760, -33],
    [4790, 24],
    [4950, -29],
    [5160, 31],
    [5380, -27],
  ];
  const chaletMats: Matrix[] = [];
  for (const [d, lat] of chaletSites) {
    const f = frameAt(d);
    const p = at(f, lat);
    const s = Math.sign(lat);
    chaletMats.push(place(new Vector3(p.x, ground(p.x, p.z) - 0.2, p.z), Math.atan2(-s * f.rx, -s * f.rz)));
  }
  const { body, windows } = chalet();
  const chaletMesh = body.mesh(scene, 'chalet');
  const chaletMat = new StandardMaterial('chalet-mat', scene);
  chaletMat.diffuseColor = Color3.White();
  chaletMat.specularColor = Color3.Black();
  chaletMesh.material = chaletMat;
  instance(chaletMesh, chaletMats);
  const windowMesh = windows.mesh(scene, 'chalet-windows');
  const windowMat = new StandardMaterial('chalet-window-mat', scene);
  windowMat.emissiveColor = new Color3(1, 0.8, 0.4);
  windowMat.disableLighting = true;
  windowMesh.material = windowMat;
  instance(windowMesh, chaletMats);

  // snowmen beside the road at the summit
  const snowmen: Matrix[] = [];
  for (const [d, lat] of [
    [4760, -10.5],
    [4840, 10],
    [5010, -11],
    [5240, 9.8],
    [5330, -10],
  ] as Array<[number, number]>) {
    const f = frameAt(d);
    const p = at(f, lat);
    const s = Math.sign(lat);
    snowmen.push(place(new Vector3(p.x, ground(p.x, p.z) - 0.1, p.z), Math.atan2(-s * f.rx, -s * f.rz)));
  }
  instance(snowmanMesh(scene), snowmen);

  // roadside markers every 100 m
  const posts: Matrix[] = [];
  every(track, 100, (f) => {
    for (const side of [-1, 1]) {
      const p = at(f, side * 8.6);
      posts.push(place(new Vector3(p.x, ground(p.x, p.z) - 0.1, p.z), 0));
    }
  });
  instance(postMesh(scene), posts);

  // ski jump on the right of the road, take-off high above the landing
  const rf = frameAt(4880);
  const p0 = at(rf, 61);
  const p1 = at(rf, 90);
  const top = new Vector3(p0.x, ground(p0.x, p0.z) + 13, p0.z);
  const end = new Vector3(p1.x, ground(p1.x, p1.z) + 1.2, p1.z);
  const rampParts: Mesh[] = [];
  const deck = paint(MeshBuilder.CreateBox('deck', { width: 3.2, height: 0.5, depth: Vector3.Distance(top, end) }, scene), new Color3(0.6, 0.63, 0.68));
  deck.position = Vector3.Center(top, end);
  deck.lookAt(end);
  rampParts.push(deck);
  for (const t of [0.12, 0.5, 0.88]) {
    const q = Vector3.Lerp(top, end, t);
    const g = ground(q.x, q.z);
    const leg = paint(MeshBuilder.CreateCylinder('leg', { height: q.y - g + 0.3, diameter: 0.5, tessellation: 6 }, scene), new Color3(0.5, 0.53, 0.58));
    leg.position.set(q.x, (q.y + g) / 2 - 0.15, q.z);
    rampParts.push(leg);
  }
  const ramp = merged('ski-jump', rampParts, scene);
  ramp.freezeWorldMatrix();

  // finish banner over the road at the summit: "GIPFEL 1195 m"
  const bf = frameAt(5000);
  const bannerParts: Mesh[] = [];
  for (const side of [-1, 1]) {
    const p = at(bf, side * 7.6);
    const post = paint(MeshBuilder.CreateBox('post', { width: 0.6, height: 7.2, depth: 0.6 }, scene), new Color3(0.14, 0.22, 0.34));
    post.position.set(p.x, ground(p.x, p.z) + 3.6, p.z);
    bannerParts.push(post);
  }
  const arch = merged('banner-posts', bannerParts, scene);
  arch.freezeWorldMatrix();
  const banner = MeshBuilder.CreatePlane('summit-banner', { width: 16.4, height: 1.8, sideOrientation: Mesh.DOUBLESIDE, frontUVs: new Vector4(0, 0, 1, 1), backUVs: new Vector4(1, 0, 0, 1) }, scene);
  const bc = at(bf, 0, 6.4);
  banner.position.set(bc.x, bc.y, bc.z);
  banner.rotation.y = Math.atan2(bf.fx, bf.fz);
  const bannerTex = new DynamicTexture('summit-banner-tex', { width: 1152, height: 128 }, scene, true);
  const bctx = bannerTex.getContext() as CanvasRenderingContext2D;
  bctx.fillStyle = '#1d3c64';
  bctx.fillRect(0, 0, 1152, 128);
  bctx.strokeStyle = '#f2f7ff';
  bctx.lineWidth = 8;
  bctx.strokeRect(8, 8, 1136, 112);
  bctx.fillStyle = '#ffffff';
  bctx.font = 'bold 80px system-ui, sans-serif';
  bctx.textAlign = 'center';
  bctx.textBaseline = 'middle';
  bctx.fillText('GIPFEL 1195 m', 576, 68);
  bannerTex.update();
  const bannerMat = new StandardMaterial('summit-banner-mat', scene);
  bannerMat.diffuseTexture = bannerTex;
  bannerMat.emissiveColor = new Color3(0.3, 0.3, 0.3);
  bannerMat.specularColor = Color3.Black();
  banner.material = bannerMat;
  banner.isPickable = false;
  banner.freezeWorldMatrix();

  // distant jagged peaks around the valley, on the horizon
  const cx = track.xs.reduce((s, v) => s + v, 0) / track.count;
  const cz = track.zs.reduce((s, v) => s + v, 0) / track.count;
  const peaks = peaksMesh(scene, cx, cz, track.minElevation - 120);
  peaks.freezeWorldMatrix();

  fallingSnow(scene);
}

function clampLat(v: number): number {
  return Math.min(150, Math.max(10, v));
}
