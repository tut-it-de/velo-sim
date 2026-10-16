import { Color3, Matrix, Mesh, MeshBuilder, Quaternion, StandardMaterial, Vector3, type Scene } from '@babylonjs/core';
import { createRng } from '../noise';
import { EDGE, ROW_STRIDE, SHOULDER, type RouteCorridor } from './corridor';
import type { BuildingIndex } from './heightField';
import type { QualityProfile } from './quality';
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
  void quality; // posts and stones are the same on every quality level
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
      if (field.isWater(x, z) || buildings.find(x, z, 0.8) >= 0) continue;
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
  return meshes;
}
