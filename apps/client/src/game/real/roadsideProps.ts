import {
  Color3,
  Material,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Texture,
  VertexBuffer,
  VertexData,
  Vector3,
  type Scene,
} from '@babylonjs/core';
import { createRng } from '../noise';
import { EDGE, ROW_STRIDE, SHOULDER, WALL_THICK, type RouteCorridor } from './corridor';
import type { BuildingIndex } from './heightField';
import type { QualityProfile } from './quality';
import { SPECIES } from './trees/species';
import { generateTree } from './trees/treeGen';
import type { GeomPart } from './trees/types';
import type { Architecture } from './worldData';

type Rgb = [number, number, number];

/** Guide posts every 50 m, every 25 m in bends tighter than BEND_RADIUS. */
const POST_SPACING = 50;
const POST_SPACING_BEND = 25;
const BEND_RADIUS = 150;
/** Foot of a guide post, measured from the shoulder edge. */
const POST_OFFSET = 0.6;
/** Curb stones on the outside of bends tighter than STONE_RADIUS, one per row (4 m). */
const STONE_RADIUS = 70;
const STONE_OFFSET = 0.35;
const STONE_SEED = 4242;
/** Curvature over ±12 m of track, as in corridor.ts. */
const CURVE_HALF = 6;
const CURVE_ARC = 24;
/** Parapets of the lake and mountain roads (roadRibbon.ts); flower boxes stand on top. */
const PARAPET_H = 0.85;
const PARAPET_W = 0.42;
/** Flower boxes on parapets in towns: every 2nd row (8 m). */
const BOX_ROW_STEP = 2;
const BOX_SIZE: Rgb = [0.3, 0.22, 0.9];
const BOX_COLOR: Rgb = [0.62, 0.3, 0.18];
const BOX_SPECULAR = 0.05;
/** Oleander on wall tops in Italian towns: every 3rd row (12 m), OLEANDER_OFFSET behind the wall face. */
const OLEANDER_ROW_STEP = 3;
const OLEANDER_OFFSET = 0.9;
const OLEANDER_SEEDS = [1, 2, 3];
const OLEANDER_SEED = 4343;
/** Scale of each bush: 1 ± 0.15. */
const OLEANDER_SCALE = 0.15;
/** Thin-instance chunks of 100 m and their LOD distance. */
const TREE_CHUNK = 100;
const TREE_LOD = 150;
/** Flower cards: cell 2 of grass.webp (flowers), 0.9 m wide, 0.35 m high. */
const CELL_COUNT = 4;
const FLOWER_CELL = 2;
const FLOWER_WIDTH = 0.9;
const FLOWER_HEIGHT = 0.35;
const CARD_ALPHA_CUT = 0.4;
/** Flower cards are merged per 50 m chunk; LOD distance is padded by the half diagonal, as in roadsideFlora.ts. */
const CARD_CHUNK = 50;
const FLOWER_LOD = 80;

const POST_WHITE: Rgb = [0.92, 0.92, 0.9];
const BAND_BLACK: Rgb = [0.05, 0.05, 0.05];
const REFLECTOR_WHITE: Rgb = [0.95, 0.95, 0.9];
const REFLECTOR_RED: Rgb = [0.8, 0.08, 0.05];
const STONE_COLOR: Rgb = [0.84, 0.82, 0.78];

const tmpQ = new Quaternion();
const tmpP = new Vector3();
const tmpM = new Matrix();
const tmpArr = new Float32Array(16);
const UNIT = Vector3.One();
const tmpS = new Vector3();

/** Wrap an angle to [-π, π] (same as in corridor.ts, which does not export it). */
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Appends one instance matrix: rotation about the up axis, then translation. */
function pushInstance(out: number[], x: number, y: number, z: number, yaw: number): void {
  Quaternion.RotationAxisToRef(Vector3.Up(), yaw, tmpQ);
  Matrix.ComposeToRef(UNIT, tmpQ, tmpP.set(x, y, z), tmpM);
  tmpM.copyToArray(tmpArr);
  for (let k = 0; k < 16; k++) out.push(tmpArr[k]!);
}

function paint(scene: Scene, name: string, color: Rgb, specular: number, emissive = 0): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = Color3.FromArray(color);
  mat.specularColor = new Color3(specular, specular, specular);
  if (emissive > 0) mat.emissiveColor = Color3.FromArray(color).scale(emissive);
  return mat;
}

/** One box as a thin-instance mesh; the matrices are placed in world space. */
function thinBox(scene: Scene, name: string, size: Rgb, matrices: number[], mat: StandardMaterial): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
  mesh.thinInstanceRefreshBoundingInfo();
  return mesh;
}

/**
 * Guide posts (Leitpfosten) on the verges outside towns and curb stones (Begrenzungssteine) on the outside
 * of tight bends. Placed once at load time along the corridor, as thin instances; nothing is done per frame.
 */
export async function buildRoadsideProps(
  scene: Scene,
  corridor: RouteCorridor,
  buildings: BuildingIndex,
  architecture: Architecture,
  quality: QualityProfile,
): Promise<Mesh[]> {
  const track = corridor.track;
  const field = corridor.field;
  const n = track.count;
  const rowLength = ROW_STRIDE * track.step;
  // Red reflectors on the right side only in Italy (the German and alpine posts are white on both sides).
  const redRight = architecture === 'italian';
  const withStones = architecture !== 'german';
  const stoneRng = createRng(STONE_SEED);

  const bodies: number[] = [];
  const bands: number[] = [];
  const whiteReflectors: number[] = [];
  const redReflectors: number[] = [];
  const stones: number[] = [];
  const stoneTints: number[] = [];
  // Distance driven since the last post, per side; starts at the spacing so the first verge row gets a post.
  const since: number[] = [POST_SPACING, POST_SPACING];

  for (let r = 0; r < corridor.rows; r++) {
    const i = corridor.sampleOf(r);
    const h = track.headings[i]!;
    const rx = Math.cos(h);
    const rz = -Math.sin(h);
    const dh = wrapAngle(track.headings[(i + CURVE_HALF) % n]! - track.headings[(i - CURVE_HALF + n) % n]!);
    const radius = CURVE_ARC / Math.max(Math.abs(dh), 1e-3);
    const eligible = !corridor.urban[r] && !corridor.covered[r];
    const postGap = radius < BEND_RADIUS ? POST_SPACING_BEND : POST_SPACING;

    for (let side = 0; side < 2; side++) {
      since[side] = since[side]! + rowLength;
      if (!eligible || corridor.edge[side]![r] !== EDGE.verge || since[side]! < postGap) continue;
      since[side] = 0;
      const sg = side === 0 ? -1 : 1;
      const o = corridor.hw[side]![r]! + SHOULDER + POST_OFFSET;
      const x = track.xs[i]! + sg * rx * o;
      const z = track.zs[i]! + sg * rz * o;
      if (field.isWater(x, z) || buildings.blocked(x, z, 0.8)) continue;
      const y = corridor.surface(x, z);
      // same heading convention as the street lamps in roadRibbon.ts: local x runs across the road
      const yaw = side === 1 ? h + Math.PI : h;
      pushInstance(bodies, x, y + 0.375, z, yaw);
      pushInstance(bands, x, y + 0.875, z, yaw);
      pushInstance(redRight && side === 1 ? redReflectors : whiteReflectors, x, y + 0.86, z, yaw);
    }

    // curb stones: outside of the bend (right turn = left side), only where the verge itself is a grassy cut
    if (withStones && eligible && radius < STONE_RADIUS) {
      const outer = dh > 0 ? 0 : 1;
      if (corridor.edge[outer]![r] === EDGE.verge) {
        const sg = outer === 0 ? -1 : 1;
        const o = corridor.hw[outer]![r]! + SHOULDER + STONE_OFFSET;
        const x = track.xs[i]! + sg * rx * o;
        const z = track.zs[i]! + sg * rz * o;
        if (!field.isWater(x, z) && buildings.find(x, z, 0.8) < 0) {
          const y = corridor.surface(x, z);
          const yaw = h + (stoneRng() * 2 - 1) * 0.08;
          const tint = 1 + (stoneRng() * 2 - 1) * 0.06;
          pushInstance(stones, x, y + 0.2, z, yaw);
          stoneTints.push(tint, tint, tint, 1);
        }
      }
    }
  }

  const meshes: Mesh[] = [];
  if (bodies.length > 0) {
    meshes.push(thinBox(scene, 'guide-post', [0.12, 0.75, 0.12], bodies, paint(scene, 'guide-post-mat', POST_WHITE, 0.15)));
    meshes.push(thinBox(scene, 'guide-band', [0.125, 0.25, 0.125], bands, paint(scene, 'guide-band-mat', BAND_BLACK, 0.05)));
  }
  if (whiteReflectors.length > 0) {
    meshes.push(
      thinBox(scene, 'guide-reflector-white', [0.07, 0.15, 0.13], whiteReflectors, paint(scene, 'guide-reflector-white-mat', REFLECTOR_WHITE, 0.05, 0.3)),
    );
  }
  if (redReflectors.length > 0) {
    meshes.push(thinBox(scene, 'guide-reflector-red', [0.07, 0.15, 0.13], redReflectors, paint(scene, 'guide-reflector-red-mat', REFLECTOR_RED, 0.05, 0.3)));
  }
  if (stones.length > 0) {
    const stone = thinBox(scene, 'curb-stone', [0.25, 0.45, 0.2], stones, paint(scene, 'curb-stone-mat', STONE_COLOR, 0.05));
    stone.thinInstanceSetBuffer('color', new Float32Array(stoneTints), 4, true);
    meshes.push(stone);
  }
  // P4.3: flower boxes on parapets (all levels but niedrig), oleander on wall tops (Italian towns, ultra and hoch)
  if (quality.level !== 'niedrig') meshes.push(...(await buildFlowerBoxes(scene, corridor, buildings)));
  if (architecture === 'italian' && (quality.level === 'ultra' || quality.level === 'hoch')) {
    meshes.push(...buildOleanders(scene, corridor, buildings));
  }
  return meshes;
}

/** Like pushInstance, with a uniform scale. */
function pushScaledInstance(out: number[], x: number, y: number, z: number, yaw: number, scale: number): void {
  Quaternion.RotationAxisToRef(Vector3.Up(), yaw, tmpQ);
  Matrix.ComposeToRef(tmpS.set(scale, scale, scale), tmpQ, tmpP.set(x, y, z), tmpM);
  tmpM.copyToArray(tmpArr);
  for (let k = 0; k < 16; k++) out.push(tmpArr[k]!);
}

/** Vertex data of the flower cards of one 50 m chunk. */
interface CardChunk {
  pos: number[];
  nor: number[];
  uv: number[];
  idx: number[];
}

function cardChunk(chunks: Map<string, CardChunk>, x: number, z: number): CardChunk {
  const key = `${Math.floor(x / CARD_CHUNK)},${Math.floor(z / CARD_CHUNK)}`;
  let c = chunks.get(key);
  if (!c) chunks.set(key, (c = { pos: [], nor: [], uv: [], idx: [] }));
  return c;
}

/** Two crossed vertical cards with the flower cell, foot at y: one across the road, one along it. */
function addFlowerCards(c: CardChunk, x: number, y: number, z: number, h: number): void {
  const u0 = FLOWER_CELL / CELL_COUNT;
  const u1 = (FLOWER_CELL + 1) / CELL_COUNT;
  for (const yaw of [h, h + Math.PI / 2]) {
    // horizontal half-width vector of the card, same frame as pushInstance
    const ax = Math.cos(yaw) * (FLOWER_WIDTH / 2);
    const az = -Math.sin(yaw) * (FLOWER_WIDTH / 2);
    const base = c.pos.length / 3;
    const corners: Array<[number, number, number, number]> = [
      [-ax, 0, -az, u0],
      [ax, 0, az, u1],
      [ax, FLOWER_HEIGHT, az, u1],
      [-ax, FLOWER_HEIGHT, -az, u0],
    ];
    for (const [dx, dy, dz, u] of corners) {
      c.pos.push(x + dx, y + dy, z + dz);
      c.nor.push(0, 1, 0);
      // v = 1 at the foot, v = 0 at the top (invertY = false, as in roadsideFlora.ts)
      c.uv.push(u, dy > 0 ? 0 : 1);
    }
    c.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** grass.webp as in roadsideFlora.ts (its loader is not exported there). */
function loadGrass(scene: Scene): Promise<Texture> {
  return new Promise((resolve, reject) => {
    const tex: Texture = new Texture(
      `${import.meta.env.BASE_URL}textures/grass.webp`,
      scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => resolve(tex),
      (message) => reject(new Error(`Textur grass fehlt: ${message ?? ''}`)),
    );
    tex.hasAlpha = true;
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  });
}

/** Flower boxes on the parapets of towns (urban rows) and by the lake: box plus flower cards. */
async function buildFlowerBoxes(scene: Scene, corridor: RouteCorridor, buildings: BuildingIndex): Promise<Mesh[]> {
  const track = corridor.track;
  const boxes: number[] = [];
  const cards = new Map<string, CardChunk>();
  for (let r = 0; r < corridor.rows; r += BOX_ROW_STEP) {
    if (!corridor.urban[r] || corridor.covered[r]) continue;
    const i = corridor.sampleOf(r);
    const h = track.headings[i]!;
    const rx = Math.cos(h);
    const rz = -Math.sin(h);
    for (let side = 0; side < 2; side++) {
      const edge = corridor.edge[side]![r]!;
      if (edge !== EDGE.parapet && edge !== EDGE.lake) continue;
      const sg = side === 0 ? -1 : 1;
      const o = corridor.hw[side]![r]! + SHOULDER + PARAPET_W / 2;
      const x = track.xs[i]! + sg * rx * o;
      const z = track.zs[i]! + sg * rz * o;
      if (buildings.blocked(x, z, 0.8)) continue;
      // the parapet top is PARAPET_H above the road; the box sits on it, the flowers on the box
      const top = track.ys[i]! + PARAPET_H + BOX_SIZE[1];
      pushInstance(boxes, x, top - BOX_SIZE[1] / 2, z, h);
      addFlowerCards(cardChunk(cards, x, z), x, top, z, h);
    }
  }
  if (boxes.length === 0) return [];

  const grass = await loadGrass(scene);
  const meshes: Mesh[] = [thinBox(scene, 'flower-box', BOX_SIZE, boxes, paint(scene, 'flower-box-mat', BOX_COLOR, BOX_SPECULAR))];
  const cardMat = new StandardMaterial('flower-cards', scene);
  cardMat.diffuseTexture = grass;
  cardMat.transparencyMode = Material.MATERIAL_ALPHATEST;
  cardMat.useAlphaFromDiffuseTexture = true;
  cardMat.alphaCutOff = CARD_ALPHA_CUT;
  cardMat.backFaceCulling = false;
  cardMat.specularColor = Color3.Black();
  for (const [key, c] of cards) {
    const vd = new VertexData();
    vd.positions = new Float32Array(c.pos);
    vd.normals = new Float32Array(c.nor);
    vd.uvs = new Float32Array(c.uv);
    vd.indices = new Uint32Array(c.idx);
    const m = new Mesh(`flower-cards-${key}`, scene);
    vd.applyToMesh(m, false);
    m.material = cardMat;
    m.isPickable = false;
    m.receiveShadows = true;
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    m.addLODLevel(FLOWER_LOD + CARD_CHUNK * Math.SQRT1_2, null);
    meshes.push(m);
  }
  return meshes;
}

/** Bark or leaf texture as in nearTrees.ts (its loader is not exported there). */
function loadTreeTexture(scene: Scene, name: string): Texture {
  // invertY = false: the tree UVs are in image space, as in the studio and the impostor bake
  const tex = new Texture(`${import.meta.env.BASE_URL}textures/${name}.webp`, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** One tree part as a thin-instance mesh per 100 m chunk; static, so no wind. */
function treeMesh(scene: Scene, name: string, part: GeomPart, mat: Material, matrices: number[]): Mesh {
  const vd = new VertexData();
  vd.positions = part.positions;
  vd.normals = part.normals;
  vd.uvs = part.uvs;
  vd.indices = part.indices;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh);
  // vertex colour (generator brightness), as in nearTrees.ts
  mesh.setVerticesData(VertexBuffer.ColorKind, part.colors, false, 4);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
  mesh.thinInstanceRefreshBoundingInfo();
  mesh.addLODLevel(TREE_LOD, null);
  return mesh;
}

/** Oleander bushes on the wall tops of Italian towns, three seed variants, thin instances per 100 m chunk. */
function buildOleanders(scene: Scene, corridor: RouteCorridor, buildings: BuildingIndex): Mesh[] {
  const species = SPECIES.oleander;
  if (!species) return [];
  const track = corridor.track;
  const rng = createRng(OLEANDER_SEED);
  const groups = new Map<string, { variant: number; matrices: number[] }>();
  for (let r = 0; r < corridor.rows; r += OLEANDER_ROW_STEP) {
    if (!corridor.urban[r] || corridor.covered[r]) continue;
    const i = corridor.sampleOf(r);
    const h = track.headings[i]!;
    const rx = Math.cos(h);
    const rz = -Math.sin(h);
    for (let side = 0; side < 2; side++) {
      if (corridor.edge[side]![r]! !== EDGE.wall) continue;
      const sg = side === 0 ? -1 : 1;
      const o = corridor.hw[side]![r]! + SHOULDER + WALL_THICK + OLEANDER_OFFSET;
      const x = track.xs[i]! + sg * rx * o;
      const z = track.zs[i]! + sg * rz * o;
      if (buildings.blocked(x, z, 1.5)) continue;
      const y = track.ys[i]! + corridor.wallH[side]![r]!;
      const variant = Math.floor(rng() * OLEANDER_SEEDS.length);
      const key = `${variant}:${Math.floor(x / TREE_CHUNK)},${Math.floor(z / TREE_CHUNK)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { variant, matrices: [] }));
      pushScaledInstance(g.matrices, x, y, z, rng() * Math.PI * 2, 1 + (rng() * 2 - 1) * OLEANDER_SCALE);
    }
  }
  if (groups.size === 0) return [];

  const variants = OLEANDER_SEEDS.map((seed) => generateTree(species, seed));
  const bark = loadTreeTexture(scene, 'bark');
  const leafTex = loadTreeTexture(scene, 'leaves');
  // without hasAlpha, Babylon ignores the texture alpha and the leaves render as full squares
  leafTex.hasAlpha = true;
  const woodMat = new StandardMaterial('oleander-wood', scene);
  woodMat.specularColor = Color3.Black();
  woodMat.backFaceCulling = false;
  woodMat.diffuseColor = new Color3(species.barkColor[0], species.barkColor[1], species.barkColor[2]);
  woodMat.diffuseTexture = bark;
  const leafMat = new StandardMaterial('oleander-leaves', scene);
  leafMat.specularColor = Color3.Black();
  leafMat.backFaceCulling = false;
  leafMat.useAlphaFromDiffuseTexture = true;
  leafMat.transparencyMode = Material.MATERIAL_ALPHATEST;
  leafMat.alphaCutOff = CARD_ALPHA_CUT;
  leafMat.diffuseColor = new Color3(species.leafColor[0], species.leafColor[1], species.leafColor[2]);
  leafMat.diffuseTexture = leafTex;

  const meshes: Mesh[] = [];
  for (const [key, { variant, matrices }] of groups) {
    const g = variants[variant]!;
    meshes.push(treeMesh(scene, `oleander-${key}-wood`, g.wood, woodMat, matrices));
    meshes.push(treeMesh(scene, `oleander-${key}-leaves`, g.leaves, leafMat, matrices));
  }
  return meshes;
}
