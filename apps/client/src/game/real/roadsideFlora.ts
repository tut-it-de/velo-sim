import { Color3, Material, Mesh, StandardMaterial, Texture, VertexData, type Scene } from '@babylonjs/core';
import { createRng } from '../noise';
import { EDGE, ROW_STRIDE, SHOULDER, type RouteCorridor } from './corridor';
import type { BuildingIndex } from './heightField';
import type { QualityLevel, QualityProfile } from './quality';
import { LAND_CLASS } from './worldData';
import { WindPlugin } from './trees/windPlugin';

/** Bushes per metre and side, and the distance at which their meshes stop being drawn, by quality. */
const SETTINGS: Partial<Record<QualityLevel, { density: number; lod: number }>> = {
  ultra: { density: 1.4, lod: 80 },
  hoch: { density: 1.4, lod: 60 },
  mittel: { density: 0.7, lod: 40 },
};
/**
 * Meshes cover 50 m × 50 m each, so the culling works per stretch of road. LOD distance is measured from the
 * chunk centre, so it is padded by the half diagonal (see addLODLevel below); otherwise the near tufts of a
 * 100 m chunk would vanish while the chunk centre is still beyond the radius.
 */
const CHUNK = 50;
/** Cells of grass.webp (4 × 1, left to right): 0 green, 1 dry, 2 flowers, 3 fern. */
const CELL_COUNT = 4;
const BUSH_WIDTH: [number, number] = [0.6, 1.0];
const BUSH_HEIGHT: [number, number] = [0.35, 0.7];
/** Distance from the road edge (beyond the shoulder), metres. */
const EDGE_NEAR = 0.2;
const EDGE_FAR = 2.8;
/** Alpha cut of the grass cards, same as the 3D leaves. */
const CARD_ALPHA_CUT = 0.4;

export interface RoadsideFlora {
  meshes: Mesh[];
  /** The wind material changes every frame, so it must leave the frozen materials after `scene.freezeMaterials()`. */
  afterFreeze(): void;
}

const NO_FLORA: RoadsideFlora = { meshes: [], afterFreeze: () => {} };

/** Grass cell by the land class: 60 % green, 25 % dry, 10 % flowers, 5 % fern; in forest 30 % fern. */
function pickCell(rng: () => number, forest: boolean): number {
  const r = rng();
  if (forest) {
    if (r < 0.3) return 3;
    const q = rng();
    return q < 0.6 ? 0 : q < 0.85 ? 1 : 2;
  }
  return r < 0.6 ? 0 : r < 0.85 ? 1 : r < 0.95 ? 2 : 3;
}

/** One bush part: three crossed cards with the grass cell, foot at y = 0, v = 1 at the foot and v = 0 at the top. */
interface BushChunk {
  pos: number[];
  nor: number[];
  uv: number[];
  col: number[];
  idx: number[];
}

function addBush(c: BushChunk, x: number, y: number, z: number, cell: number, width: number, height: number, shade: number): void {
  const u0 = cell / CELL_COUNT;
  const u1 = (cell + 1) / CELL_COUNT;
  for (const yaw of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
    const cs = Math.cos(yaw) * (width / 2);
    const sn = Math.sin(yaw) * (width / 2);
    const base = c.pos.length / 3;
    // left/right in the card's own frame, top and foot
    const corners: Array<[number, number, number, number]> = [
      [-cs, 0, -sn, u0],
      [cs, 0, sn, u1],
      [cs, height, sn, u1],
      [-cs, height, -sn, u0],
    ];
    for (const [dx, dy, dz, u] of corners) {
      c.pos.push(x + dx, y + dy, z + dz);
      c.nor.push(0, 1, 0);
      c.uv.push(u, dy > 0 ? 0 : 1);
      c.col.push(shade, shade, shade, 1);
    }
    c.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function loadGrass(scene: Scene): Promise<Texture> {
  return new Promise((resolve, reject) => {
    // invertY = false: v = 0 is the top row of the image, v = 1 the foot (the wind weight is 1 − v)
    const tex: Texture = new Texture(
      `${import.meta.env.BASE_URL}textures/grass.webp`,
      scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => resolve(tex),
      (message) => reject(new Error(`Textur grass fehlt: ${message ?? ''}`)),
    );
    // the silhouette lives in the alpha channel; without hasAlpha Babylon ignores it
    tex.hasAlpha = true;
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  });
}

/**
 * Grass, flowers and fern tufts along the verges of the route (P3.8). Placed once at load time along the
 * corridor, on both sides, only where the verge is a plain grassy cut and the road is not in a town.
 */
export async function buildRoadsideFlora(
  scene: Scene,
  corridor: RouteCorridor,
  buildings: BuildingIndex,
  quality: QualityProfile,
): Promise<RoadsideFlora> {
  const setting = SETTINGS[quality.level];
  if (!setting) return NO_FLORA;
  const field = corridor.field;
  const track = corridor.track;
  const rng = createRng(2025);
  const rowLength = ROW_STRIDE * track.step;

  const chunks = new Map<string, BushChunk>();
  let bushes = 0;
  for (let r = 0; r < corridor.rows; r++) {
    // out-and-back sections are already planted by their first pass
    if (corridor.urban[r] || corridor.covered[r]) continue;
    const i = corridor.sampleOf(r);
    const h = track.headings[i]!;
    // forward along the track and lateral (right) direction, as in the corridor analysis
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const lx = Math.cos(h);
    const lz = -Math.sin(h);
    for (let side = 0; side < 2; side++) {
      if (corridor.edge[side]![r] !== EDGE.verge) continue;
      const sg = side === 0 ? -1 : 1;
      const roadEdge = corridor.hw[side]![r]! + SHOULDER;
      const expected = setting.density * rowLength;
      let count = Math.floor(expected);
      if (rng() < expected - count) count++;
      for (let n = 0; n < count; n++) {
        const along = (rng() - 0.5) * rowLength;
        const o = roadEdge + EDGE_NEAR + rng() * (EDGE_FAR - EDGE_NEAR);
        const x = track.xs[i]! + fx * along + sg * lx * o;
        const z = track.zs[i]! + fz * along + sg * lz * o;
        if (field.isWater(x, z) || buildings.find(x, z, 0.8) >= 0) continue;
        const y = corridor.surface(x, z);
        const forest = field.classAt(x, z) === LAND_CLASS.forest;
        const cell = pickCell(rng, forest);
        const width = BUSH_WIDTH[0] + rng() * (BUSH_WIDTH[1] - BUSH_WIDTH[0]);
        const height = BUSH_HEIGHT[0] + rng() * (BUSH_HEIGHT[1] - BUSH_HEIGHT[0]);
        const shade = 0.9 + rng() * 0.2;
        const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
        let c = chunks.get(key);
        if (!c) chunks.set(key, (c = { pos: [], nor: [], uv: [], col: [], idx: [] }));
        addBush(c, x, y, z, cell, width, height, shade);
        bushes++;
      }
    }
  }
  if (bushes === 0) return NO_FLORA;

  const grass = await loadGrass(scene);
  const mat = new StandardMaterial('roadside-flora', scene);
  mat.diffuseTexture = grass;
  mat.transparencyMode = Material.MATERIAL_ALPHATEST;
  mat.useAlphaFromDiffuseTexture = true;
  mat.alphaCutOff = CARD_ALPHA_CUT;
  mat.backFaceCulling = false;
  mat.specularColor = Color3.Black();
  // darker than the texture: the grass cells are brighter and greener than the terrain they stand on
  mat.diffuseColor = new Color3(0.72, 0.72, 0.64);
  new WindPlugin(mat, { card: true, strength: 0.06 });

  const meshes: Mesh[] = [];
  for (const [key, c] of chunks) {
    const vd = new VertexData();
    vd.positions = new Float32Array(c.pos);
    vd.normals = new Float32Array(c.nor);
    vd.uvs = new Float32Array(c.uv);
    vd.colors = new Float32Array(c.col);
    vd.indices = new Uint32Array(c.idx);
    const m = new Mesh(`roadside-flora-${key}`, scene);
    vd.applyToMesh(m, false);
    m.material = mat;
    m.isPickable = false;
    // tufts take shadows from trees and walls, but do not cast them
    m.receiveShadows = true;
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    m.addLODLevel(setting.lod + CHUNK * Math.SQRT1_2, null);
    meshes.push(m);
  }

  return {
    meshes,
    afterFreeze() {
      mat.unfreeze();
    },
  };
}
