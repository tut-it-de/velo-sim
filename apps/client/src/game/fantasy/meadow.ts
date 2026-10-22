import {
  Color3,
  Color4,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  VertexData,
  type Scene,
} from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { mix, smoothstep } from '../noise';
import { TerrainModel } from '../terrain';
import { at, atmosphere, frames, rng, sweep, type Frame } from './common';

/** Kuhweiden-Ring: sunny rolling meadow with fences, grazing cows, a farm and a windmill. */

const FENCE_LAT = 7;
/** Fence gaps: 20 m out of every 400 m (gate-like breaks for the field entrances). */
const GAP_EVERY = 400;
const GAP_START = 190;
const GAP_END = 210;
const FARM = { d: 1500, lat: 40 };
const MILL = { d: 4000, lat: -80, hill: 16 };
/** Cartoon ground grid spacing (m); coarser than the classic terrain to keep the triangle budget. */
const GRID_M = 24;
/** Ground nodes this close to the road are kept below it (> half the diagonal of a grid cell). */
const ROAD_CLEAR = 18;
const COWS = 150;
const TREES = 900;
const FLOWERS = 2400;
const RAIL_UP = [-0.4, 0.1];

const WHITE = new Color3(1, 1, 1);
const GRASS_A = Color3.FromHexString('#5cc04a');
const GRASS_B = Color3.FromHexString('#7bd45a');
const GRASS_STEEP = Color3.FromHexString('#3f9d3e');
const ASPHALT = Color3.FromHexString('#7d8189');
const SHOULDER = Color3.FromHexString('#cfc39c');
const BARK = Color3.FromHexString('#8a5a34');

/** Road cross-section (left → right): skirt, gravel shoulder, asphalt with white edge lines, mirrored. */
const ROAD: Array<{ lateral: number; up: number; c: Color3 }> = [
  { lateral: -7.5, up: -0.75, c: GRASS_STEEP },
  { lateral: -5.2, up: 0.04, c: SHOULDER },
  { lateral: -4, up: 0.06, c: ASPHALT },
  { lateral: -3.95, up: 0.065, c: WHITE },
  { lateral: -3.6, up: 0.065, c: WHITE },
  { lateral: -3.55, up: 0.06, c: ASPHALT },
  { lateral: 3.55, up: 0.06, c: ASPHALT },
  { lateral: 3.6, up: 0.065, c: WHITE },
  { lateral: 3.95, up: 0.065, c: WHITE },
  { lateral: 4, up: 0.06, c: ASPHALT },
  { lateral: 5.2, up: 0.04, c: SHOULDER },
  { lateral: 7.5, up: -0.75, c: GRASS_STEEP },
];

/** One placed copy of a thin-instanced mesh. */
interface Inst {
  x: number;
  y: number;
  z: number;
  yaw: number;
  s?: number;
}

const tmpQ = new Quaternion();
const tmpM = new Matrix();
const tmpS = new Vector3();
const tmpP = new Vector3();

export async function buildMeadow(scene: Scene, track: Track): Promise<void> {
  atmosphere(scene, {
    top: '#3f8ae0',
    horizon: '#d6ecff',
    fog: 0.00035,
    sunDir: [0.4, -1, 0.3],
    sun: '#fff1d6',
    sunIntensity: 1.1,
    hemi: 0.8,
    ground: '#5d7a3a',
  });
  const model = new TerrainModel(track, 'hills');
  const farm = track.positionAt(FARM.d, FARM.lat);
  const mill = track.positionAt(MILL.d, MILL.lat);
  const farmY = model.heightAt(farm.x, farm.z);
  // Every prop uses this one height function so nothing floats or sinks: terrain, a flat farmyard and a hill.
  const groundY = (x: number, z: number): number => {
    const flat = mix(farmY, model.heightAt(x, z), smoothstep(14, 40, Math.hypot(x - farm.x, z - farm.z)));
    const dm = Math.hypot(x - mill.x, z - mill.z) / 40;
    const y = flat + MILL.hill * Math.exp(-dm * dm);
    // The ground grid is coarse (GRID_M): every node within ROAD_CLEAR of the road stays below it, so no
    // triangle that spans the road can rise through the asphalt between its nodes.
    const road = model.index.nearest(x, z, 120);
    if (road.dist === Infinity) return y;
    return Math.min(y, road.y - 0.6 + 0.25 * Math.max(0, road.dist - ROAD_CLEAR));
  };

  const vcol = vertexMaterial(scene);
  groundMesh(scene, model, groundY, vcol);
  farGround(scene, track);
  roadMesh(scene, track);
  buildFences(scene, track, groundY, vcol);
  buildCows(scene, track, groundY, farm, mill, vcol);
  buildFarm(scene, farm, farmY, vcol);
  buildWindmill(scene, mill, groundY, vcol);
  buildTrees(scene, track, groundY, farm, mill, vcol);
  buildFlowers(scene, track, groundY, vcol);
  buildClouds(scene, track);
}

function vertexMaterial(scene: Scene): StandardMaterial {
  const m = new StandardMaterial('meadow-vcol', scene);
  m.diffuseColor = Color3.White();
  m.specularColor = Color3.Black();
  return m;
}

function tint(mesh: Mesh, c: Color3): Mesh {
  const n = mesh.getTotalVertices();
  const cols = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b, 1], i * 4);
  mesh.setVerticesData(VertexBuffer.ColorKind, cols);
  return mesh;
}

/** Merges parts into one static mesh that uses the shared vertex-colour material. */
function bake(name: string, parts: Mesh[], mat: StandardMaterial): Mesh {
  const m = Mesh.MergeMeshes(parts, true, true, undefined, false, false)!;
  m.name = name;
  m.material = mat;
  m.isPickable = false;
  return m;
}

function box(scene: Scene, w: number, h: number, d: number, x: number, y: number, z: number, c: Color3, rz = 0): Mesh {
  const m = MeshBuilder.CreateBox('b', { width: w, height: h, depth: d }, scene);
  m.position.set(x, y, z);
  m.rotation.z = rz;
  return tint(m, c);
}

function cyl(
  scene: Scene,
  o: { height: number; diameter?: number; diameterTop?: number; diameterBottom?: number; tessellation: number },
  x: number,
  y: number,
  z: number,
  c: Color3,
  rz = 0,
): Mesh {
  const m = MeshBuilder.CreateCylinder('c', o, scene);
  m.position.set(x, y, z);
  m.rotation.z = rz;
  return tint(m, c);
}

/** Low-poly ball (icosphere, like the props): subdivisions 0 = 20 triangles, 1 = 80. */
function sphere(scene: Scene, diameter: number, x: number, y: number, z: number, c: Color3, subdivisions = 1): Mesh {
  const m = MeshBuilder.CreateIcoSphere('s', { radius: diameter / 2, subdivisions, flat: false }, scene);
  m.position.set(x, y, z);
  return tint(m, c);
}

/** Flat two-sided triangle (gable walls of the barn). */
function gable(scene: Scene, pts: number[][], c: Color3): Mesh {
  const m = new Mesh('gable', scene);
  const vd = new VertexData();
  const pos = new Float32Array([...pts[0]!, ...pts[1]!, ...pts[2]!, ...pts[0]!, ...pts[1]!, ...pts[2]!]);
  const idx = new Uint32Array([0, 1, 2, 3, 5, 4]);
  const nor = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, idx, nor);
  const col = new Float32Array(6 * 4);
  for (let i = 0; i < 6; i++) col.set([c.r, c.g, c.b, 1], i * 4);
  vd.positions = pos;
  vd.indices = idx;
  vd.normals = nor;
  vd.colors = col;
  // UVs keep the attribute set equal to the boxes, so the farm parts can merge.
  vd.uvs = new Float32Array(6 * 2);
  vd.applyToMesh(m, false);
  return m;
}

/** Sets the thin-instance matrices (and optional per-instance colours) of a mesh and freezes it. */
function thin(mesh: Mesh, items: Inst[], colors?: Color3[]): void {
  const buf = new Float32Array(items.length * 16);
  items.forEach((it, i) => {
    const s = it.s ?? 1;
    Quaternion.RotationYawPitchRollToRef(it.yaw, 0, 0, tmpQ);
    Matrix.ComposeToRef(tmpS.set(s, s, s), tmpQ, tmpP.set(it.x, it.y, it.z), tmpM);
    tmpM.copyToArray(buf, i * 16);
  });
  mesh.thinInstanceSetBuffer('matrix', buf, 16, true);
  if (colors) {
    const cb = new Float32Array(colors.length * 4);
    colors.forEach((c, i) => cb.set([c.r, c.g, c.b, 1], i * 4));
    mesh.thinInstanceSetBuffer('color', cb, 4, true);
  }
  mesh.freezeWorldMatrix();
  mesh.alwaysSelectAsActiveMesh = true;
}

function wrap(d: number, length: number): number {
  return ((d % length) + length) % length;
}

function near(p: { x: number; z: number }, c: { x: number; z: number }, r: number): boolean {
  return Math.hypot(p.x - c.x, p.z - c.z) < r;
}

/** Rolling bright-green ground on a regular grid; heights come from the shared height function. */
function groundMesh(scene: Scene, model: TerrainModel, groundY: (x: number, z: number) => number, mat: StandardMaterial): void {
  const nx = Math.ceil((model.maxX - model.minX) / GRID_M) + 1;
  const nz = Math.ceil((model.maxZ - model.minZ) / GRID_M) + 1;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = model.minX + i * GRID_M;
      const z = model.minZ + j * GRID_M;
      pos[k * 3] = x;
      pos[k * 3 + 1] = groundY(x, z);
      pos[k * 3 + 2] = z;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let p = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[p++] = a;
      idx[p++] = b;
      idx[p++] = c;
      idx[p++] = b;
      idx[p++] = d;
      idx[p++] = c;
    }
  }
  const nor = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, idx, nor);
  const col = new Float32Array(nx * nz * 4);
  const n = model.noise;
  for (let k = 0; k < nx * nz; k++) {
    const x = pos[k * 3]!;
    const z = pos[k * 3 + 2]!;
    const slope = 1 - nor[k * 3 + 1]!;
    let c = Color3.Lerp(GRASS_A, GRASS_B, 0.5 + 0.5 * n.noise(x / 150, z / 150));
    c = Color3.Lerp(c, GRASS_STEEP, smoothstep(0.15, 0.35, slope) * 0.6);
    const shade = 0.96 + 0.04 * n.noise(x / 29, z / 29);
    col.set([c.r * shade, c.g * shade, c.b * shade, 1], k * 4);
  }
  const mesh = new Mesh('meadow-ground', scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  vd.normals = nor;
  vd.colors = col;
  vd.applyToMesh(mesh, false);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
}

/** Flat green plane below the terrain edge so the horizon never shows a hole. */
function farGround(scene: Scene, track: Track): void {
  const g = MeshBuilder.CreateGround('meadow-far', { width: 60000, height: 60000, subdivisions: 1 }, scene);
  g.position.y = track.minElevation - 60;
  const m = new StandardMaterial('meadow-far-mat', scene);
  m.diffuseColor = GRASS_A;
  m.specularColor = Color3.Black();
  g.material = m;
  g.isPickable = false;
}

function roadMesh(scene: Scene, track: Track): void {
  const colors = ROAD.map((r) => new Color4(r.c.r, r.c.g, r.c.b, 1));
  const road = sweep(scene, 'meadow-road', track, ROAD.map((r) => ({ lateral: r.lateral, up: r.up, u: 0 })), {
    everyM: 4,
    color: (p) => colors[p]!,
  });
  const mat = new StandardMaterial('meadow-road-mat', scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  road.material = mat;
}

/** Wooden posts (instanced) and two rails per side (beams), with a 20 m gap every 400 m. */
function buildFences(scene: Scene, track: Track, groundY: (x: number, z: number) => number, vcol: StandardMaterial): void {
  const gap = (d: number): boolean => {
    const m = d % GAP_EVERY;
    return m >= GAP_START && m < GAP_END;
  };
  const posts: Inst[] = [];
  for (const f of frames(track, 3)) {
    if (gap(f.d)) continue;
    for (const side of [-1, 1]) {
      const p = at(f, side * FENCE_LAT);
      posts.push({ x: p.x, y: groundY(p.x, p.z) - 0.15, z: p.z, yaw: Math.atan2(f.fx, f.fz) });
    }
  }
  const postMesh = bake('fence-post', [box(scene, 0.2, 1.2, 0.2, 0, 0.6, 0, Color3.FromHexString('#b57a45'))], vcol);
  thin(postMesh, posts);

  // Runs of rail beams between the gaps (one beam per side and height, swept along the track).
  const runs: Frame[][] = [];
  let run: Frame[] = [];
  for (const f of frames(track, 6)) {
    if (gap(f.d)) {
      if (run.length > 1) runs.push(run);
      run = [];
    } else run.push(f);
  }
  if (run.length > 1) runs.push(run);
  const railMat = vertexMaterial(scene);
  railMat.backFaceCulling = false;
  railMat.twoSidedLighting = true;
  fenceRails(scene, runs, railMat);
}

function fenceRails(scene: Scene, runs: Frame[][], mat: StandardMaterial): void {
  // Square-ish beam profile (lateral, up) around the rail centre line.
  const ring: Array<[number, number]> = [
    [-0.04, 0],
    [0.04, 0],
    [0.04, 0.14],
    [-0.04, 0.14],
    [-0.04, 0],
  ];
  const cols = ring.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const col: number[] = [];
  const wood = Color3.FromHexString('#d49a5c');
  for (const r of runs) {
    for (const side of [-1, 1]) {
      for (const up of RAIL_UP) {
        const base = pos.length / 3;
        for (const f of r) {
          for (const [dl, du] of ring) {
            const p = at(f, side * FENCE_LAT + dl, up + du);
            pos.push(p.x, p.y, p.z);
            col.push(wood.r, wood.g, wood.b, 1);
          }
        }
        for (let i = 0; i < r.length - 1; i++) {
          for (let c = 0; c < cols - 1; c++) {
            const a = base + i * cols + c;
            const e = a + cols;
            idx.push(a, a + 1, e, a + 1, e + 1, e);
          }
        }
      }
    }
  }
  const mesh = new Mesh('fence-rails', scene);
  const nor = new Float32Array(pos.length);
  const indices = new Uint32Array(idx);
  const positions = new Float32Array(pos);
  VertexData.ComputeNormals(positions, indices, nor);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = nor;
  vd.colors = new Float32Array(col);
  vd.applyToMesh(mesh, false);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
}

/** A cute low-poly cow facing +z: white body, black patches, pink snout, legs, horns and tail. */
function cowMesh(scene: Scene, mat: StandardMaterial): Mesh {
  const white = new Color3(0.98, 0.97, 0.94);
  const spot = new Color3(0.12, 0.11, 0.11);
  const pink = new Color3(1, 0.66, 0.72);
  const ivory = new Color3(0.96, 0.92, 0.8);
  const parts: Mesh[] = [
    box(scene, 0.8, 0.8, 1.4, 0, 1.0, 0, white),
    box(scene, 0.56, 0.6, 0.62, 0, 1.35, 1.0, white),
    box(scene, 0.4, 0.26, 0.22, 0, 1.2, 1.37, pink),
    box(scene, 0.12, 0.12, 0.04, -0.16, 1.44, 1.33, spot),
    box(scene, 0.12, 0.12, 0.04, 0.16, 1.44, 1.33, spot),
    box(scene, 0.07, 0.22, 0.07, -0.22, 1.68, 0.95, ivory),
    box(scene, 0.07, 0.22, 0.07, 0.22, 1.68, 0.95, ivory),
    box(scene, 0.07, 0.6, 0.07, 0, 1.0, -0.8, white),
    box(scene, 0.12, 0.16, 0.12, 0, 0.7, -0.8, spot),
    box(scene, 0.04, 0.42, 0.5, -0.41, 1.1, 0.1, spot),
    box(scene, 0.04, 0.42, 0.5, 0.41, 1.1, -0.2, spot),
    box(scene, 0.3, 0.04, 0.42, 0.14, 1.42, -0.1, spot),
    box(scene, 0.18, 0.62, 0.18, -0.26, 0.31, 0.5, white),
    box(scene, 0.18, 0.62, 0.18, 0.26, 0.31, 0.5, white),
    box(scene, 0.18, 0.62, 0.18, -0.26, 0.31, -0.5, white),
    box(scene, 0.18, 0.62, 0.18, 0.26, 0.31, -0.5, white),
  ];
  return bake('cow', parts, mat);
}

/** Grazing herds spread along the lap, always on the grass 12–60 m beside the road. */
function buildCows(
  scene: Scene,
  track: Track,
  groundY: (x: number, z: number) => number,
  farm: { x: number; z: number },
  mill: { x: number; z: number },
  mat: StandardMaterial,
): void {
  const rnd = rng(42);
  const len = track.length;
  const items: Inst[] = [];
  const herds = 28;
  const latOf = (l: number, side: number): number => side * Math.min(60, Math.max(12, Math.abs(l)));
  for (let h = 0; h < herds && items.length < COWS; h++) {
    const d0 = ((h + 0.2 + rnd() * 0.6) / herds) * len;
    const side = h % 2 === 0 ? -1 : 1;
    const lat0 = side * (16 + rnd() * 30);
    const size = 3 + Math.floor(rnd() * 6);
    for (let i = 0; i < size && items.length < COWS; i++) {
      const p = track.positionAt(wrap(d0 + (rnd() - 0.5) * 16, len), latOf(lat0 + (rnd() - 0.5) * 14, side));
      if (near(p, farm, 30) || near(p, mill, 40)) continue;
      items.push({ x: p.x, y: groundY(p.x, p.z) - 0.05, z: p.z, yaw: rnd() * Math.PI * 2, s: 1.2 });
    }
  }
  const cows = cowMesh(scene, mat);
  thin(cows, items);
}

/** Red barn with gable roof, silo with dome and yellow hay bales, built around the farm centre. */
function buildFarm(scene: Scene, c: { x: number; z: number; heading: number }, y: number, mat: StandardMaterial): void {
  const red = Color3.FromHexString('#d8452f');
  const trim = new Color3(0.98, 0.97, 0.94);
  const roof = Color3.FromHexString('#4f4a52');
  const door = Color3.FromHexString('#7e2a24');
  const silo = Color3.FromHexString('#e4e9ec');
  const dome = Color3.FromHexString('#b9c6cf');
  const hay = Color3.FromHexString('#f7c948');
  const slope = Math.atan2(4, 5.6);
  const parts: Mesh[] = [
    box(scene, 10, 7, 12, 0, 3.5, 0, red),
    box(scene, 0.4, 7.05, 0.4, -5, 3.5, 6, trim),
    box(scene, 0.4, 7.05, 0.4, 5, 3.5, 6, trim),
    box(scene, 0.4, 7.05, 0.4, -5, 3.5, -6, trim),
    box(scene, 0.4, 7.05, 0.4, 5, 3.5, -6, trim),
    gable(scene, [[-5, 7, 6.02], [5, 7, 6.02], [0, 11, 6.02]], trim),
    gable(scene, [[-5, 7, -6.02], [5, 7, -6.02], [0, 11, -6.02]], trim),
    box(scene, 7.1, 0.35, 12.6, 2.8, 9, 0, roof, -slope),
    box(scene, 7.1, 0.35, 12.6, -2.8, 9, 0, roof, slope),
    box(scene, 4.2, 4.4, 0.25, 0, 2.2, 6.1, door),
    box(scene, 4.6, 0.3, 0.35, 0, 4.55, 6.15, trim),
    box(scene, 0.3, 4.7, 0.35, -2.25, 2.3, 6.15, trim),
    box(scene, 0.3, 4.7, 0.35, 2.25, 2.3, 6.15, trim),
    box(scene, 4.2, 0.22, 0.3, 0, 2.2, 6.2, trim),
    cyl(scene, { height: 11, diameter: 3.6, tessellation: 16 }, -8.5, 5.5, 2.5, silo),
    sphere(scene, 3.6, -8.5, 11, 2.5, dome, 1),
  ];
  // Hay bales lie on their side (axis along x).
  for (const [x, z] of [
    [8, 4],
    [8.4, 6.2],
    [6.2, 8.8],
    [-8, -6],
    [-7.5, -8.6],
    [-10, -4],
  ] as const) {
    parts.push(cyl(scene, { height: 1.8, diameter: 1.7, tessellation: 14 }, x, 0.85, z, hay, Math.PI / 2));
  }
  parts.push(cyl(scene, { height: 1.8, diameter: 1.7, tessellation: 14 }, 6.6, 2.55, -5.3, hay, Math.PI / 2));

  const farmMesh = bake('farm', parts, mat);
  // Local +z (door side) faces the road, which lies on the -right side of the farm.
  farmMesh.position.set(c.x, y, c.z);
  farmMesh.rotation.y = c.heading - Math.PI / 2;
  farmMesh.freezeWorldMatrix();
}

/** Windmill on a hill: tower and nacelle are static, the four blades turn around the hub. */
function buildWindmill(scene: Scene, c: { x: number; z: number; heading: number }, groundY: (x: number, z: number) => number, mat: StandardMaterial): void {
  const cream = Color3.FromHexString('#fff4df');
  const red = Color3.FromHexString('#e0412f');
  // Local frame: blades face the road (local +z). Yaw turns the local frame; spin turns the blades around it.
  const yaw = c.heading + Math.PI / 2;
  const base = groundY(c.x, c.z);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // Local (x, y, z) offset -> world position on the hill, so no parent transform is needed.
  const world = (lx: number, ly: number, lz: number): Vector3 =>
    new Vector3(c.x + cosY * lx + sinY * lz, base + ly, c.z - sinY * lx + cosY * lz);

  const tower = bake(
    'windmill-tower',
    [
      cyl(scene, { height: 15, diameterTop: 1.8, diameterBottom: 3.2, tessellation: 12 }, 0, 7.5, 0, cream),
      box(scene, 1.8, 1.6, 2.4, 0, 16, 0.6, red),
    ],
    mat,
  );
  tower.position.set(c.x, base, c.z);
  tower.rotation.y = yaw;
  tower.freezeWorldMatrix();

  const blades: Mesh[] = [sphere(scene, 0.9, 0, 0, 0, red, 1)];
  for (let k = 0; k < 4; k++) {
    const t = (k * Math.PI) / 2;
    blades.push(box(scene, 0.5, 4.8, 0.14, -Math.sin(t) * 2.6, Math.cos(t) * 2.6, 0, WHITE, t));
  }
  const rotor = bake('windmill-blades', blades, mat);
  // Hub sits at the nacelle front; the mesh origin is the hub so it spins about its own axis.
  const hub = world(0, 16, 1.95);
  rotor.position.copyFrom(hub);
  rotor.rotation.set(0, yaw, 0);
  scene.onBeforeRenderObservable.add(() => {
    rotor.rotation.z += scene.getEngine().getDeltaTime() * 0.0012;
  });
}

/** Round cartoon trees in small groups on the hills, 30–200 m from the road. */
function buildTrees(
  scene: Scene,
  track: Track,
  groundY: (x: number, z: number) => number,
  farm: { x: number; z: number },
  mill: { x: number; z: number },
  mat: StandardMaterial,
): void {
  const rnd = rng(77);
  const len = track.length;
  const placed: Array<{ item: Inst; crown: number }> = [];
  for (let g = 0; g < 170 && placed.length < TREES; g++) {
    const d0 = rnd() * len;
    const side = rnd() < 0.5 ? -1 : 1;
    const lat0 = side * (22 + rnd() * rnd() * 150);
    const n = 4 + Math.floor(rnd() * 5);
    for (let i = 0; i < n && placed.length < TREES; i++) {
      // crowns stay clear of the road and its fences
      const p = track.positionAt(wrap(d0 + (rnd() - 0.5) * 40, len), side * Math.max(16, Math.abs(lat0 + (rnd() - 0.5) * 30)));
      if (near(p, farm, 50) || near(p, mill, 45)) continue;
      const s = 0.8 + rnd() * 0.6;
      // A non-finite position in merged geometry breaks the whole frame, so such a tree is skipped.
      if (!Number.isFinite(p.x + p.z + groundY(p.x, p.z))) continue;
      placed.push({ item: { x: p.x, y: groundY(p.x, p.z) - 0.3, z: p.z, yaw: rnd() * Math.PI * 2, s }, crown: rnd() < 0.5 ? 0 : 1 });
    }
  }
  // Baked into one mesh (no thin instances): each tree is a copy with its own transform.
  const variants = [
    [Color3.FromHexString('#3fb24a'), Color3.FromHexString('#6cc852')],
    [Color3.FromHexString('#8ed24e'), Color3.FromHexString('#b5dd5c')],
  ] as const;
  const parts: Mesh[] = [];
  for (const { item, crown } of placed) {
    const [dark, light] = variants[crown]!;
    for (const m of treeParts(scene, dark, light)) {
      m.position.set(item.x, item.y, item.z);
      m.rotation.y = item.yaw;
      m.scaling.setAll(item.s ?? 1);
      parts.push(m);
    }
  }
  bake('trees', parts, mat);
}

/** One tree in local coordinates (trunk and two crown balls). */
function treeParts(scene: Scene, crown: Color3, light: Color3): Mesh[] {
  const parts = [
    cyl(scene, { height: 2.6, diameter: 0.6, tessellation: 6 }, 0, 1.3, 0, BARK),
    sphere(scene, 5.4, 0, 4.4, 0, crown, 1),
    sphere(scene, 3.4, 1.2, 6, 0.4, light, 1),
  ];
  // the local offsets go into the vertices, so placing the tree does not drop trunk and crowns to the ground
  for (const m of parts) m.bakeCurrentTransformIntoVertices();
  return parts;
}

/** Clusters of yellow, white and pink flowers in the grass just outside the fences. */
function buildFlowers(scene: Scene, track: Track, groundY: (x: number, z: number) => number, mat: StandardMaterial): void {
  const rnd = rng(99);
  const len = track.length;
  const palette = ['#ffd23f', '#ffffff', '#ff7eb6', '#ffe066'].map((h) => Color3.FromHexString(h));
  const items: Inst[] = [];
  const colors: Color3[] = [];
  for (let i = 0; i < FLOWERS / 3; i++) {
    const d = rnd() * len;
    const side = rnd() < 0.5 ? -1 : 1;
    const lat = side * (8.6 + rnd() * 3.2);
    const c = palette[Math.floor(rnd() * palette.length)]!;
    for (let k = 0; k < 3; k++) {
      const p = track.positionAt(wrap(d + (rnd() - 0.5) * 2.5, len), lat + (rnd() - 0.5) * 1.2);
      items.push({ x: p.x, y: groundY(p.x, p.z) + 0.12, z: p.z, yaw: 0 });
      colors.push(c);
    }
  }
  const flower = bake('flower', [sphere(scene, 0.36, 0, 0, 0, WHITE, 0)], mat);
  thin(flower, items, colors);
}

/** Puffy cloud clusters high above the meadow, unaffected by fog. */
function buildClouds(scene: Scene, track: Track): void {
  const rnd = rng(5);
  const cx = (track.bounds.minX + track.bounds.maxX) / 2;
  const cz = (track.bounds.minZ + track.bounds.maxZ) / 2;
  const cloudWhite = new Color3(0.97, 0.98, 1);
  const parts: Mesh[] = [];
  for (let k = 0; k < 14; k++) {
    const a = rnd() * Math.PI * 2;
    const r = 1700 + rnd() * 1300;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const y = 420 + rnd() * 140;
    const n = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const s = sphere(scene, (28 + rnd() * 26) * 2, x + (rnd() - 0.5) * 110, y + (rnd() - 0.5) * 18, z + (rnd() - 0.5) * 90, cloudWhite, 1);
      s.scaling.y = 0.8;
      parts.push(s);
    }
  }
  const mat = new StandardMaterial('meadow-cloud-mat', scene);
  mat.disableLighting = true;
  mat.emissiveColor = Color3.White();
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.fogEnabled = false;
  bake('meadow-clouds', parts, mat);
}
