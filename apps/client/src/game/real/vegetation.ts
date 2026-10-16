import { Color3, Material, StandardMaterial, type Mesh, type Scene } from '@babylonjs/core';
import { createRng } from '../noise';
import { SHOULDER, type RouteCorridor } from './corridor';
import type { BuildingIndex } from './heightField';
import { MeshData } from './meshData';
import type { QualityProfile } from './quality';
import { TREE, TREE_TYPES, treeAtlas } from './textures';
import { LAND_CLASS, type WorldData } from './worldData';

const CHUNK = 1024;
/** Trees per 12 m × 12 m cell by land class. */
const DENSITY: Record<number, number> = {
  [LAND_CLASS.forest]: 2.6,
  [LAND_CLASS.shrub]: 0.6,
  [LAND_CLASS.orchard]: 0.8,
  [LAND_CLASS.garden]: 0.5,
  [LAND_CLASS.park]: 0.5,
  [LAND_CLASS.urban]: 0.12,
  [LAND_CLASS.grass]: 0.04,
  [LAND_CLASS.farmland]: 0.03,
};
/** Width relative to height per sprite. */
const ASPECT = [0.95, 0.56, 0.26, 0.95];
/** October: a share of the chestnuts and beeches already turning. */
const AUTUMN: Array<[number, number, number]> = [
  [1, 1, 1],
  [1.18, 1.08, 0.62],
  [1.3, 0.98, 0.55],
  [1.05, 1.04, 0.8],
];

/**
 * Billboard trees (two crossed quads each) planted from the land-cover classes within the quality
 * profile's radius of the road — never on the road, in the lake or inside houses. One mesh per
 * 1 km chunk, all types share a single alpha-tested atlas material.
 */
export function buildVegetation(scene: Scene, data: WorldData, corridor: RouteCorridor, buildings: BuildingIndex, quality: QualityProfile): Mesh[] {
  const g = data.near;
  const field = corridor.field;
  const wl = data.waterLevel;
  const track = corridor.track;
  const radius = quality.treeRadius;
  const rng = createRng(2024);

  // distance to the road per near-grid cell
  const dist = corridor.routeDistanceGrid();

  const chunks = new Map<string, MeshData>();
  const plant = (x: number, z: number, type: number, height: number, d: number) => {
    const hit = corridor.nearest(x, z, 9);
    if (hit && Math.abs(hit.offset) < corridor.hw[hit.offset >= 0 ? 1 : 0][hit.row]! + SHOULDER + 1.6) return;
    if (field.isWater(x, z) || buildings.find(x, z, 1.2) >= 0) return;
    const y = (d < 48 ? corridor.surface(x, z) : field.dem(x, z)) - 0.3;
    if (y < wl + 0.2) return;
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let md = chunks.get(key);
    if (!md) chunks.set(key, (md = new MeshData(true, true)));
    const w = height * ASPECT[type]! * 0.5;
    const yaw = rng() * Math.PI;
    const tint = type === TREE.broadleaf && rng() < 0.22 ? AUTUMN[1 + Math.floor(rng() * 3)]! : AUTUMN[0]!;
    const shade = 0.85 + rng() * 0.25;
    const u0 = type / TREE_TYPES + 0.004;
    const u1 = (type + 1) / TREE_TYPES - 0.004;
    // the atlas canvas is uploaded top row first: v = 0 is the crown's top
    for (let q = 0; q < 2; q++) {
      const a = yaw + q * (Math.PI / 2);
      const dx = Math.cos(a) * w;
      const dz = Math.sin(a) * w;
      const bottom = shade * 0.62;
      const top = shade * 1.06;
      const v0 = md.vertex(x - dx, y, z - dz, 0, 1, 0, u0, 1, tint[0] * bottom, tint[1] * bottom, tint[2] * bottom);
      const v1 = md.vertex(x + dx, y, z + dz, 0, 1, 0, u1, 1, tint[0] * bottom, tint[1] * bottom, tint[2] * bottom);
      const v2 = md.vertex(x + dx, y + height, z + dz, 0, 1, 0, u1, 0, tint[0] * top, tint[1] * top, tint[2] * top);
      const v3 = md.vertex(x - dx, y + height, z - dz, 0, 1, 0, u0, 0, tint[0] * top, tint[1] * top, tint[2] * top);
      md.idx.push(v0, v1, v2, v0, v2, v3);
    }
  };

  for (let j = 0; j < g.nz; j++) {
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      const d = dist[k]!;
      if (d > radius) continue;
      const cls = g.classes[k]!;
      const density = (DENSITY[cls] ?? 0) * (1 - 0.45 * Math.max(0, (d - radius * 0.5) / (radius * 0.5)));
      let count = Math.floor(density);
      if (rng() < density - count) count++;
      const h = g.heights[k]!;
      for (let n = 0; n < count; n++) {
        const x = g.x0 + (i - 0.5 + rng()) * g.step;
        const z = g.z0 + (j - 0.5 + rng()) * g.step;
        let type: number = TREE.broadleaf;
        let height = 9 + rng() * 9;
        if (cls === LAND_CLASS.forest) {
          const coniferShare = h < 900 ? 0.12 : h < 1300 ? 0.5 : 0.9;
          if (rng() < coniferShare) {
            type = TREE.conifer;
            height = 12 + rng() * 12;
          }
        } else if (cls === LAND_CLASS.urban || cls === LAND_CLASS.garden || cls === LAND_CLASS.park) {
          if (h < 320 && rng() < 0.28) {
            type = TREE.cypress;
            height = 8 + rng() * 7;
          } else {
            type = TREE.garden;
            height = 6 + rng() * 8;
          }
        } else if (cls === LAND_CLASS.orchard) {
          type = TREE.garden;
          height = 4 + rng() * 3;
        } else if (cls === LAND_CLASS.shrub) {
          height = 3 + rng() * 4;
        }
        plant(x, z, type, height, d);
      }
    }
  }
  // single trees mapped in OpenStreetMap (villa gardens, promenades)
  for (let p = 0; p < data.trees.length; p += 2) {
    const x = data.trees[p]!;
    const z = data.trees[p + 1]!;
    const d = corridor.routeDistance(x, z);
    if (d > radius) continue;
    const cypress = field.dem(x, z) < 320 && rng() < 0.3;
    plant(x, z, cypress ? TREE.cypress : TREE.garden, cypress ? 9 + rng() * 6 : 8 + rng() * 8, d);
  }

  const mat = new StandardMaterial('trees', scene);
  const atlas = treeAtlas(scene);
  mat.diffuseTexture = atlas;
  mat.transparencyMode = Material.MATERIAL_ALPHATEST;
  // with an explicit transparency mode Babylon tests the final alpha, which must come from the atlas
  mat.useAlphaFromDiffuseTexture = true;
  mat.alphaCutOff = 0.45;
  mat.backFaceCulling = false;
  mat.specularColor = Color3.Black();
  mat.diffuseColor = new Color3(0.95, 0.95, 0.95);

  const meshes: Mesh[] = [];
  for (const [key, md] of chunks) {
    const m = md.build(scene, `trees-${key}`, mat);
    if (!m) continue;
    m.addLODLevel(quality.treeDistance, null);
    meshes.push(m);
  }
  return meshes;
}
