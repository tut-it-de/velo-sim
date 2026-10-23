import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, VertexData, Vector3, type Scene } from '@babylonjs/core';
import { createRng, Noise2D } from '../noise';
import type { RouteCorridor } from './corridor';
import type { BuildingIndex } from './heightField';
import type { QualityProfile } from './quality';
import { LAND_CLASS, type WorldData } from './worldData';

/**
 * Scenery on open land that the map data does not contain: boulders and scree on alpine meadows,
 * shrubs on grass, hedges, fences and hay bales on farmland. Placed in a band around the route.
 * Everything is thin instances of a few meshes, so the whole set costs a handful of draw calls.
 */

/** Band around the centre line in which scenery is placed (m). */
const NEAR = 6;
const FAR = 250;
/** Candidate points are sampled every SAMPLE_M along the track, three per sample. */
const SAMPLE_M = 6;
const CANDIDATES = 3;
/** Above this altitude grass is alpine meadow: more boulders and shrubs. */
const HIGH_ALT = 1200;
/** Probability per sample and side (structures) and per candidate (groups). */
const HEDGE_P = 0.04;
const FENCE_P = 0.01;
const HAY_P = 0.012;
const SCREE_P = 0.04;
/** Hedge and fence pieces, m. */
const PIECE = 2.6;
const POST_SPACING = 2.5;
const SEED = 0x5ce7a1;

const TMP_Q = new Quaternion();
const TMP_M = new Matrix();
const TMP_P = new Vector3();
const TMP_S = new Vector3();
const TMP_ARR = new Float32Array(16);

const DIRT: [number, number, number] = [0.5, 0.5, 0.47];
export const SHRUB_DARK: [number, number, number] = [0.16, 0.3, 0.13];
export const SHRUB_MID: [number, number, number] = [0.3, 0.46, 0.2];
const HEDGE_GREEN: [number, number, number] = [0.18, 0.34, 0.14];
const WOOD: [number, number, number] = [0.45, 0.34, 0.24];
const STRAW: [number, number, number] = [0.85, 0.7, 0.32];

interface Spot {
  x: number;
  z: number;
  y: number;
  cls: number;
}

/** Appends one instance matrix: scale, then tilt (pitch, roll), then yaw, then translation. */
export function pushMatrix(out: number[], x: number, y: number, z: number, yaw: number, pitch: number, roll: number, sx: number, sy: number, sz: number): void {
  Quaternion.RotationYawPitchRollToRef(yaw, pitch, roll, TMP_Q);
  Matrix.ComposeToRef(TMP_S.set(sx, sy, sz), TMP_Q, TMP_P.set(x, y, z), TMP_M);
  TMP_M.copyToArray(TMP_ARR);
  for (let k = 0; k < 16; k++) out.push(TMP_ARR[k]!);
}

export function material(scene: Scene, name: string, rgb: [number, number, number]): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = Color3.FromArray(rgb);
  mat.specularColor = new Color3(0.03, 0.03, 0.03);
  // a floor of light so nothing turns black in shade
  mat.emissiveColor = Color3.FromArray(rgb).scale(0.14);
  return mat;
}

/** Thin-instance mesh with the given matrices; an empty list gives no mesh. */
export function finish(mesh: Mesh, matrices: number[], mat: StandardMaterial): Mesh | null {
  if (matrices.length === 0) {
    mesh.dispose();
    return null;
  }
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
  mesh.thinInstanceRefreshBoundingInfo();
  mesh.freezeWorldMatrix();
  return mesh;
}

/** Icosphere of radius 0.5 with a lumpy surface; the displacement depends on position only, so shared vertices stay joined. */
export function lumpySphere(scene: Scene, name: string, subdivisions: number, seed: number, amp: number): Mesh {
  const mesh = MeshBuilder.CreateIcoSphere(name, { radius: 0.5, subdivisions, flat: false }, scene);
  const vd = VertexData.ExtractFromMesh(mesh);
  const pos = vd.positions!;
  const noise = new Noise2D(seed);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]!;
    const y = pos[i + 1]!;
    const z = pos[i + 2]!;
    const k = 1 + amp * noise.noise(x * 3.1 + z * 1.7, y * 3.1 - z * 0.9);
    pos[i] = x * k;
    pos[i + 1] = y * k;
    pos[i + 2] = z * k;
  }
  const nor = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, vd.indices!, nor);
  vd.normals = nor;
  vd.applyToMesh(mesh, true);
  return mesh;
}

/** Unit box whose top is uneven (a clipped hedge); the bumps depend on x and z only. */
function hedgeBlock(scene: Scene, name: string, seed: number): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
  const vd = VertexData.ExtractFromMesh(mesh);
  const pos = vd.positions!;
  const noise = new Noise2D(seed);
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 1]! <= 0) continue;
    pos[i + 1] = pos[i + 1]! + 0.2 * noise.noise(pos[i]! * 2.6 + 7, pos[i + 2]! * 2.6);
  }
  const nor = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, vd.indices!, nor);
  vd.normals = nor;
  vd.applyToMesh(mesh, true);
  return mesh;
}

/**
 * Scatters boulders, scree, shrubs, hedges, fences and hay bales on open land around the route.
 * Every object stands on the final ground (`corridor.surface`) and is kept off the road, houses and water.
 */
export async function buildLandscapeScatter(
  scene: Scene,
  data: WorldData,
  corridor: RouteCorridor,
  buildings: BuildingIndex,
  quality: QualityProfile,
): Promise<Mesh[]> {
  if (quality.level === 'niedrig') return [];
  // Mittel shows half of the scenery; the sample order and the random sequence stay the same.
  const share = quality.level === 'mittel' ? 0.5 : 1;
  const field = corridor.field;
  const track = corridor.track;
  const n = track.count;
  const stride = Math.max(1, Math.round(SAMPLE_M / track.step));
  const rng = createRng(SEED);
  const alpine = data.look.flora === 'alpine';
  const central = data.look.flora === 'central';

  const rocks: number[] = [];
  const scree: number[] = [];
  const shrubDark: number[] = [];
  const shrubMid: number[] = [];
  const hedges: number[] = [];
  const posts: number[] = [];
  const rails: number[] = [];
  const bales: number[] = [];

  /** Open ground at (x, z): not on the road, not in houses, water, woods or towns; flat enough to stand on. */
  const spotAt = (x: number, z: number): Spot | null => {
    if (corridor.routeDistance(x, z) < NEAR) return null;
    const cls = field.classAt(x, z);
    if (cls === LAND_CLASS.water || cls === LAND_CLASS.urban || cls === LAND_CLASS.forest) return null;
    if (field.isWater(x, z) || buildings.blocked(x, z, 2)) return null;
    const y = corridor.surface(x, z);
    // walls, embankments and cuts are not open ground
    if (Math.abs(y - field.dem(x, z)) > 2.5) return null;
    return { x, z, y, cls };
  };

  /**
   * Ground under an object of the given height and footprint radius r: the lowest point of the footprint, so the
   * object never floats; buried at most 40 % of its height, so a drop next to it does not swallow it.
   */
  const settle = (x: number, z: number, r: number, height: number): number => {
    const low = Math.min(corridor.surface(x + r, z), corridor.surface(x - r, z), corridor.surface(x, z + r), corridor.surface(x, z - r));
    return Math.max(Math.min(low, corridor.surface(x, z)), corridor.surface(x, z) - 0.4 * height);
  };

  const boulder = (x: number, z: number): void => {
    const d = 0.4 + 2.1 * Math.pow(rng(), 2.2);
    const sy = d * (0.45 + 0.25 * rng());
    const g = settle(x, z, d * 0.25, sy);
    // 0.3·height above the ground puts the bottom 20 % of the height underground
    pushMatrix(rocks, x, g + sy * 0.3, z, rng() * Math.PI * 2, (rng() - 0.5) * 0.3, (rng() - 0.5) * 0.3, d, sy, d * (0.75 + 0.25 * rng()));
  };

  const stone = (x: number, z: number): void => {
    const d = 0.12 + 0.23 * rng();
    const sy = d * 0.55;
    const g = settle(x, z, d * 0.3, sy);
    pushMatrix(scree, x, g + sy * 0.3, z, rng() * Math.PI * 2, (rng() - 0.5) * 0.4, (rng() - 0.5) * 0.4, d, sy, d * (0.8 + 0.2 * rng()));
  };

  /** Lying bale: 1.3 m across, the bottom 0.05 m buried. */
  const haybale = (x: number, z: number): void => {
    pushMatrix(bales, x, settle(x, z, 0.6, 1.3) + 0.6, z, rng() * Math.PI * 2, 0, 0, 1, 1, 1);
  };

  const shrub = (x: number, z: number, dark: boolean): void => {
    const d = 0.8 + 1.7 * rng();
    const sy = d * 0.65;
    const g = settle(x, z, d * 0.25, sy);
    // 0.4·height above the ground: the bottom 10 % is buried
    pushMatrix(dark ? shrubDark : shrubMid, x, g + sy * 0.4, z, rng() * Math.PI * 2, 0, 0, d, sy, d * (0.85 + 0.15 * rng()));
  };

  /** A hedge of pieces along the road heading, starting at (x0, z0). */
  const hedge = (x0: number, z0: number, h: number, length: number): void => {
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const pieces = Math.round(length / PIECE);
    for (let p = 0; p < pieces; p++) {
      const t = (p + 0.5) * PIECE;
      const x = x0 + fx * t;
      const z = z0 + fz * t;
      const s = spotAt(x, z);
      if (!s || (s.cls !== LAND_CLASS.grass && s.cls !== LAND_CLASS.farmland)) continue;
      const ya = corridor.surface(x - fx * PIECE * 0.5, z - fz * PIECE * 0.5);
      const yb = corridor.surface(x + fx * PIECE * 0.5, z + fz * PIECE * 0.5);
      const height = 1.1 + 0.7 * rng();
      pushMatrix(hedges, x, (ya + yb) / 2 + height * 0.5 - 0.15, z, h, -Math.atan2(yb - ya, PIECE), 0, 0.9, height, PIECE + 0.1);
    }
  };

  /** A post-and-rail fence along the road heading; a rail is only drawn between two standing posts. */
  const fence = (x0: number, z0: number, h: number, length: number): void => {
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    const count = Math.round(length / POST_SPACING);
    let prev: { x: number; y: number; z: number } | null = null;
    for (let p = 0; p <= count; p++) {
      const t = p * POST_SPACING;
      const x = x0 + fx * t;
      const z = z0 + fz * t;
      const s = spotAt(x, z);
      if (!s || (s.cls !== LAND_CLASS.grass && s.cls !== LAND_CLASS.farmland)) {
        prev = null;
        continue;
      }
      // post: 1.1 m tall, 0.1 m of it buried
      pushMatrix(posts, x, s.y + 0.45, z, h, 0, 0, 0.1, 1.1, 0.1);
      if (prev) {
        const dy = s.y - prev.y;
        const mx = (x + prev.x) / 2;
        const mz = (z + prev.z) / 2;
        const my = (s.y + prev.y) / 2;
        const pitch = -Math.atan2(dy, POST_SPACING);
        const len = Math.hypot(POST_SPACING, dy) + 0.05;
        // two rails, 0.55 m and 0.9 m above the ground
        pushMatrix(rails, mx, my + 0.55, mz, h, pitch, 0, 0.06, 0.08, len);
        pushMatrix(rails, mx, my + 0.9, mz, h, pitch, 0, 0.06, 0.08, len);
      }
      prev = { x, y: s.y, z };
    }
  };

  for (let i = 0; i < n; i += stride) {
    const h = track.headings[i]!;
    const rx = Math.cos(h);
    const rz = -Math.sin(h);
    const cx = track.xs[i]!;
    const cz = track.zs[i]!;

    // Structures run parallel to the road, one roll per side.
    for (const sg of [-1, 1]) {
      const sideR = rng();
      const d0 = 15 + 45 * rng();
      const length = 10 + 30 * rng();
      if (central && sideR < HEDGE_P * share) hedge(cx + sg * rx * d0, cz + sg * rz * d0, h, length);
      const fenceR = rng();
      const fd = 10 + 70 * rng();
      const fl = 40 + 80 * rng();
      if ((alpine || central) && fenceR < FENCE_P * share) fence(cx + sg * rx * fd, cz + sg * rz * fd, h, fl);
    }

    for (let k = 0; k < CANDIDATES; k++) {
      const sg = rng() < 0.5 ? -1 : 1;
      // denser close to the road
      const d = NEAR + (FAR - NEAR) * Math.pow(rng(), 1.7);
      const x = cx + sg * rx * d;
      const z = cz + sg * rz * d;
      const s = spotAt(x, z);
      if (!s) continue;
      const roll = rng();
      const cls = s.cls;
      const high = s.y >= HIGH_ALT;
      // Alpine meadows are mapped as farmland as often as grass.
      const meadow = cls === LAND_CLASS.grass || cls === LAND_CLASS.farmland;

      // Boulders: rock always, alpine meadows often, lowland grass rarely.
      let rockP = 0;
      if (cls === LAND_CLASS.rock) rockP = 0.5;
      else if (meadow && high) rockP = 0.35;
      else if (meadow) rockP = alpine ? 0.08 : 0.03;
      else if (cls === LAND_CLASS.shrub || cls === LAND_CLASS.sand) rockP = 0.08;
      if (roll < rockP * share) {
        boulder(s.x, s.z);
        if (rng() < 0.35) {
          const extra = 1 + Math.floor(rng() * 2);
          for (let e = 0; e < extra; e++) {
            const a = rng() * Math.PI * 2;
            const r = 0.8 + 1.7 * rng();
            const q = spotAt(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r);
            if (q) boulder(q.x, q.z);
          }
        }
      }

      // Shrubs: dense on shrub land, scattered on grass, park and garden.
      let shrubP = 0;
      if (cls === LAND_CLASS.shrub) shrubP = 0.4;
      else if (cls === LAND_CLASS.park || cls === LAND_CLASS.garden) shrubP = 0.15;
      else if (meadow && alpine) shrubP = high ? 0.12 : 0.07;
      else if (cls === LAND_CLASS.grass) shrubP = 0.06;
      else if (cls === LAND_CLASS.orchard) shrubP = 0.05;
      else if (cls === LAND_CLASS.farmland) shrubP = 0.02;
      const shrubRoll = rng();
      const dark = rng() < 0.5;
      if (shrubRoll < shrubP * share) {
        shrub(s.x, s.z, dark);
        if (rng() < 0.4) {
          const extra = 1 + Math.floor(rng() * 2);
          for (let e = 0; e < extra; e++) {
            const a = rng() * Math.PI * 2;
            const r = 1.5 + 2.5 * rng();
            const q = spotAt(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r);
            if (q) shrub(q.x, q.z, rng() < 0.5);
          }
        }
      }

      // Scree: a few steep grassy spots in the alpine zone, or rock, get a patch of small stones.
      if (alpine || high) {
        const slope = Math.abs(field.dem(s.x + 4, s.z) - field.dem(s.x - 4, s.z)) / 8;
        const steep = slope > 0.35 && (meadow || cls === LAND_CLASS.rock);
        const screeRoll = rng();
        const count = 10 + Math.floor(rng() * 11);
        if (steep && screeRoll < SCREE_P * share) {
          for (let e = 0; e < count; e++) {
            const a = rng() * Math.PI * 2;
            const r = 3.5 * Math.sqrt(rng());
            const q = spotAt(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r);
            if (q) stone(q.x, q.z);
          }
        }
      }

      // Hay bales: a small group on farmland or meadow in the central zone.
      const hayRoll = rng();
      const hayCount = 2 + Math.floor(rng() * 3);
      if (central && (cls === LAND_CLASS.farmland || cls === LAND_CLASS.grass) && hayRoll < HAY_P * share) {
        haybale(s.x, s.z);
        for (let e = 1; e < hayCount; e++) {
          const a = rng() * Math.PI * 2;
          const r = 2 + 3 * rng();
          const q = spotAt(s.x + Math.cos(a) * r, s.z + Math.sin(a) * r);
          if (q) haybale(q.x, q.z);
        }
      }
    }
  }

  const meshes: Array<Mesh | null> = [];
  const rockMat = material(scene, 'scatter-boulder-mat', DIRT);
  meshes.push(finish(lumpySphere(scene, 'scatter-boulder', 0, SEED + 1, 0.22), rocks, rockMat));
  meshes.push(finish(lumpySphere(scene, 'scatter-scree', 0, SEED + 2, 0.22), scree, rockMat));
  meshes.push(finish(lumpySphere(scene, 'scatter-shrub-dark', 1, SEED + 3, 0.12), shrubDark, material(scene, 'scatter-shrub-dark-mat', SHRUB_DARK)));
  meshes.push(finish(lumpySphere(scene, 'scatter-shrub-mid', 1, SEED + 4, 0.12), shrubMid, material(scene, 'scatter-shrub-mid-mat', SHRUB_MID)));
  meshes.push(finish(hedgeBlock(scene, 'scatter-hedge', SEED + 5), hedges, material(scene, 'scatter-hedge-mat', HEDGE_GREEN)));
  const woodMat = material(scene, 'scatter-wood-mat', WOOD);
  meshes.push(finish(MeshBuilder.CreateBox('scatter-post', { size: 1 }, scene), posts, woodMat));
  meshes.push(finish(MeshBuilder.CreateBox('scatter-rail', { size: 1 }, scene), rails, woodMat));
  const bale = MeshBuilder.CreateCylinder('scatter-bale', { height: 1.2, diameter: 1.3, tessellation: 14 }, scene);
  bale.rotation.z = Math.PI / 2;
  bale.bakeCurrentTransformIntoVertices();
  meshes.push(finish(bale, bales, material(scene, 'scatter-bale-mat', STRAW)));

  return meshes.filter((m): m is Mesh => m !== null);
}
