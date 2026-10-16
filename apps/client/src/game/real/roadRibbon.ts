import {
  Color3,
  MaterialPluginBase,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
  type Material,
  type Scene,
} from '@babylonjs/core';
import { Noise2D, smoothstep } from '../noise';
import { EDGE, ROW_STRIDE, SHOULDER, VERGE_BLEND, WALL_THICK, type RouteCorridor } from './corridor';
import { SKY, TO_SUN } from './env';
import { applyDetail } from './detailMaps';
import { MeshData } from './meshData';
import { NOISE_GLSL } from './terrainMaterial';
import type { RealTerrain } from './terrain';
import { roadTexture, roadTextureRepeat, stoneTexture } from './textures';
import type { Architecture } from './worldData';

const CHUNK_ROWS = 96;
const VERGE_COLS = 12;
const STONE_REPEAT = 2.5;
/** Asphalt detail tiles across the road: the U range spans roughly 9 m of road and shoulder, one tile per 1.5 m. */
const ROAD_DETAIL_ACROSS = 6;
const PARAPET_H = 0.85;
const PARAPET_W = 0.42;

interface Row {
  /** Corridor row. */
  r: number;
  /** Running distance for texture coordinates. */
  d: number;
}

interface Frame {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
}

const glslColor = (hex: string) => {
  const c = Color3.FromHexString(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

/**
 * Asphalt that is not one flat texture: large patches of older and newer surface, darker strips along
 * the edges, and a Fresnel sheen of sky and sun at grazing angles (the bright road against the light).
 */
class AsphaltPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, 'VeloAsphalt', 200);
    this._enable(true);
  }

  override getClassName(): string {
    return 'VeloAsphaltPlugin';
  }

  override getCustomCode(shaderType: string) {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: NOISE_GLSL,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: /* glsl */ `
{
  vec2 veloP = vPositionW.xz;
  baseColor.rgb *= 0.88 + 0.13 * veloNoise(veloP * 0.045) + 0.09 * veloNoise(veloP * 0.23 + 3.7);
  float veloU = vDiffuseUV.x;
  baseColor.rgb *= 0.86 + 0.14 * smoothstep(0.06, 0.17, veloU) * smoothstep(0.94, 0.83, veloU);
}`,
      CUSTOM_FRAGMENT_BEFORE_FOG: /* glsl */ `
{
  vec3 veloV = normalize(vEyePosition.xyz - vPositionW);
  float veloFres = pow(1.0 - clamp(dot(normalW, veloV), 0.0, 1.0), 5.0);
  float veloGlare = pow(max(dot(reflect(-veloV, normalW), vec3(${TO_SUN.x.toFixed(4)}, ${TO_SUN.y.toFixed(4)}, ${TO_SUN.z.toFixed(4)})), 0.0), 6.0);
  color.rgb += (${glslColor(SKY.horizon)} * 0.1 + ${glslColor(SKY.sun)} * veloGlare * 0.45) * veloFres;
}`,
    };
  }
}

/** Stretches of rows to draw: everything except the second pass of out-and-back sections. */
function drawnRuns(c: RouteCorridor): Row[][] {
  const R = c.rows;
  const cov = c.covered;
  const rowLen = ROW_STRIDE * c.track.step;
  const start = cov.indexOf(1);
  if (start < 0) {
    const all: Row[] = [];
    for (let k = 0; k <= R; k++) all.push({ r: k % R, d: k * rowLen });
    return [all];
  }
  const out: Row[][] = [];
  let k = 0;
  while (k < R) {
    const r = (start + k) % R;
    if (cov[r]) {
      k++;
      continue;
    }
    let len = 0;
    while (len < R && !cov[(r + len) % R]) len++;
    // one extra row at both ends closes the gap to the pass that is drawn instead
    const rows: Row[] = [];
    for (let q = -1; q <= len; q++) rows.push({ r: (r + q + R) % R, d: (start + k + q) * rowLen });
    out.push(rows);
    k += len;
  }
  return out;
}

function chunks(rows: Row[]): Row[][] {
  const out: Row[][] = [];
  for (let s = 0; s < rows.length - 1; s += CHUNK_ROWS) out.push(rows.slice(s, Math.min(rows.length, s + CHUNK_ROWS + 1)));
  return out;
}

export interface RibbonMeshes {
  /** Asphalt — receives rider shadows. */
  road: Mesh[];
  other: Mesh[];
}

/**
 * Road surface, verges (cut and fill slopes that blend into the terrain), lake walls with parapets,
 * retaining walls, guardrails and street lamps along the lap.
 */
export function buildRouteRibbon(
  scene: Scene,
  c: RouteCorridor,
  terrain: RealTerrain,
  markings: Architecture = 'italian',
  detail = false,
): RibbonMeshes {
  const texRepeat = roadTextureRepeat(markings);
  const t = c.track;
  const field = c.field;
  const frame = (r: number): Frame => {
    const i = c.sampleOf(r);
    const h = t.headings[i]!;
    return { x: t.xs[i]!, y: t.ys[i]!, z: t.zs[i]!, rx: Math.cos(h), rz: -Math.sin(h) };
  };

  const openMat = new StandardMaterial('road-open', scene);
  openMat.diffuseTexture = roadTexture(scene, false, markings);
  const townMat = new StandardMaterial('road-town', scene);
  townMat.diffuseTexture = roadTexture(scene, true);
  for (const m of [openMat, townMat]) {
    // across the road the texture ends at the shoulders; along the road it repeats (dynamic textures default to clamp)
    (m.diffuseTexture as Texture).wrapU = Texture.CLAMP_ADDRESSMODE;
    (m.diffuseTexture as Texture).wrapV = Texture.WRAP_ADDRESSMODE;
    m.specularColor = new Color3(0.07, 0.07, 0.07);
    m.specularPower = 24;
    new AsphaltPlugin(m);
  }
  const stoneMat = new StandardMaterial('stone', scene);
  stoneMat.diffuseTexture = stoneTexture(scene);
  stoneMat.specularColor = new Color3(0.03, 0.03, 0.03);
  if (detail) {
    // fine asphalt grain and stone courses on top of the base textures (one tile per 1.5 m along the lap, 2 m for stone)
    for (const m of [openMat, townMat]) applyDetail(m, scene, 'asphalt', [ROAD_DETAIL_ACROSS, texRepeat / 1.5], { diffuse: 0.45, bump: 0.5 });
    applyDetail(stoneMat, scene, 'drystone', [STONE_REPEAT / 2, STONE_REPEAT / 2], { diffuse: 0.6, bump: 1 });
  }
  const railMat = new StandardMaterial('guardrail', scene);
  railMat.diffuseColor = new Color3(0.66, 0.68, 0.7);
  railMat.specularColor = new Color3(0.55, 0.55, 0.55);
  railMat.specularPower = 40;
  railMat.backFaceCulling = false;

  const road: Mesh[] = [];
  const other: Mesh[] = [];
  const posts: number[] = [];
  const lamps: number[] = [];
  const nTmp: [number, number, number] = [0, 0, 0];
  // roughness of the cut slopes (P4.2), one noise field per build
  const noise = new Noise2D(9137);
  let chunkId = 0;

  for (const run of drawnRuns(c)) {
    for (const rows of chunks(run)) {
      const id = chunkId++;
      const frames = rows.map((row) => frame(row.r));

      // --- asphalt (open road / town) ---
      const open = new MeshData(true);
      const town = new MeshData(true);
      const emitted = [new Map<number, number>(), new Map<number, number>()];
      const roadRow = (md: MeshData, k: number) => {
        const f = frames[k]!;
        const r = rows[k]!.r;
        const hl = c.hw[0][r]!;
        const hr = c.hw[1][r]!;
        const offs = [-(hl + SHOULDER), -hl, 0, hr, hr + SHOULDER];
        const dy = [-0.05, 0, 0.035, 0, -0.05];
        const us = [0, 0.06, 0.5, 0.94, 1];
        const base = md.vertexCount;
        for (let q = 0; q < 5; q++) md.vertex(f.x + f.rx * offs[q]!, f.y + dy[q]!, f.z + f.rz * offs[q]!, 0, 1, 0, us[q]!, rows[k]!.d / texRepeat);
        return base;
      };
      for (let k = 0; k < rows.length - 1; k++) {
        const which = c.urban[rows[k]!.r] ? 1 : 0;
        const md = which ? town : open;
        const map = emitted[which]!;
        let a = map.get(k);
        if (a === undefined) map.set(k, (a = roadRow(md, k)));
        let b = map.get(k + 1);
        if (b === undefined) map.set(k + 1, (b = roadRow(md, k + 1)));
        for (let q = 0; q < 4; q++) md.stripQuad(a + q, a + q + 1, b + q, b + q + 1);
      }
      for (const [md, mat, name] of [
        [open, openMat, 'road'],
        [town, townMat, 'road-town'],
      ] as const) {
        md.computeNormals();
        const m = md.build(scene, `${name}-${id}`, mat);
        if (m) road.push(m);
      }

      // --- verges, blending from the road edge into the natural terrain ---
      const verge = new MeshData();
      const blend: number[] = [];
      const rock: number[] = [];
      const cols = VERGE_COLS + 2;
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? -1 : 1;
        const bases: number[] = [];
        for (let k = 0; k < rows.length; k++) {
          const f = frames[k]!;
          const r = rows[k]!.r;
          const hw = c.hw[side]![r]!;
          const edge0 = c.edge[side]![r]!;
          const edge = edge0 === EDGE.lake ? EDGE.verge : edge0;
          const o0 = hw + SHOULDER + (edge === EDGE.wall ? WALL_THICK : 0);
          const ext = Math.max(o0 + 1, c.ext[side]![r]!);
          const mid = c.mid[side]![r]!;
          // [x, y, z, blend, rock]; rock marks the cut slopes (only real verges, not lake shores)
          const verts: Array<[number, number, number, number, number]> = [];
          let prevO = 0;
          let prevY = 0;
          for (let q = 0; q <= VERGE_COLS; q++) {
            const o = o0 + (ext - o0) * Math.pow(q / VERGE_COLS, 1.4);
            let x = f.x + sg * f.rx * o;
            let z = f.z + sg * f.rz * o;
            const sink = 0.15 * smoothstep(o0 + 2, ext, o);
            const y = c.profile(r, side, o, field.dem(x, z), f.y, edge) - sink;
            const w = Number.isNaN(mid) ? smoothstep(o0 + 1, o0 + VERGE_BLEND, o) : 0;
            // cut weight: a few metres into a cutting, fading out where the verge blends into the terrain
            const cut = edge0 === EDGE.verge
              ? smoothstep(1.2, 3.5, y - f.y) * smoothstep(o0 + 2.5, o0 + 4, o) * (1 - smoothstep(o0 + 0.6 * VERGE_BLEND, o0 + VERGE_BLEND, o))
              : 0;
            const slope = q === 0 ? 0 : (y - prevY) / (o - prevO);
            prevO = o;
            prevY = y;
            // rough cut face: push the point sideways (layered by height, so the bands run horizontally)
            const d = cut * 0.45 * noise.fbm((x + z) * 0.12, y * 0.7, 3);
            x += sg * f.rx * d;
            z += sg * f.rz * d;
            verts.push([x, y, z, w, cut * smoothstep(0.35, 0.8, slope)]);
          }
          const last = verts[verts.length - 1]!;
          verts.push([last[0], last[1] - 3, last[2], 0, 0]);
          if (side === 0) verts.reverse();
          bases.push(verge.vertexCount);
          for (const v of verts) {
            verge.vertex(v[0], v[1], v[2]);
            blend.push(v[3]);
            rock.push(v[4]);
          }
        }
        for (let k = 0; k < rows.length - 1; k++) {
          const lakeA = c.edge[side]![rows[k]!.r] === EDGE.lake;
          const lakeB = c.edge[side]![rows[k + 1]!.r] === EDGE.lake;
          if (lakeA && lakeB) continue;
          const a = bases[k]!;
          const b = bases[k + 1]!;
          for (let q = 0; q < cols - 1; q++) verge.stripQuad(a + q, a + q + 1, b + q, b + q + 1);
        }
      }
      verge.computeNormals();
      for (let v = 0; v < verge.vertexCount; v++) {
        const w = blend[v]!;
        if (w <= 0) continue;
        terrain.normalAt(verge.pos[v * 3]!, verge.pos[v * 3 + 2]!, nTmp);
        const nx = verge.nor[v * 3]! + (nTmp[0] - verge.nor[v * 3]!) * w;
        const ny = verge.nor[v * 3 + 1]! + (nTmp[1] - verge.nor[v * 3 + 1]!) * w;
        const nz = verge.nor[v * 3 + 2]! + (nTmp[2] - verge.nor[v * 3 + 2]!) * w;
        const len = Math.hypot(nx, ny, nz) || 1;
        verge.nor[v * 3] = nx / len;
        verge.nor[v * 3 + 1] = ny / len;
        verge.nor[v * 3 + 2] = nz / len;
      }
      const vm = verge.build(scene, `verge-${id}`, terrain.nearMaterial);
      if (vm) {
        // rock weight per vertex in UV2.x, read by TerrainPlugin (terrainMaterial.ts)
        const uv2 = new Float32Array(verge.vertexCount * 2);
        for (let v = 0; v < verge.vertexCount; v++) uv2[v * 2] = rock[v]!;
        vm.setVerticesData(VertexBuffer.UV2Kind, uv2, false, 2);
        other.push(vm);
      }

      // --- lake walls with parapet, retaining walls, guardrails ---
      const walls = new MeshData(true);
      const rail = new MeshData();
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? -1 : 1;
        // profile points (lateral offset, height) per row, each consecutive pair is one face
        const profileOf = (k: number): Array<[number, number]> | null => {
          const r = rows[k]!.r;
          const f = frames[k]!;
          const o = c.hw[side]![r]! + SHOULDER;
          const edge = c.edge[side]![r]!;
          if (edge === EDGE.lake) {
            return [
              [o, f.y - 0.05],
              [o, f.y + PARAPET_H],
              [o + PARAPET_W, f.y + PARAPET_H],
              [o + PARAPET_W, field.waterLevel - 1.5],
            ];
          }
          if (edge === EDGE.parapet) {
            // low stone wall above a drop, its outer face reaches down into the slope
            return [
              [o, f.y - 0.05],
              [o, f.y + PARAPET_H],
              [o + PARAPET_W, f.y + PARAPET_H],
              [o + PARAPET_W, f.y - 2.5],
            ];
          }
          if (edge === EDGE.wall) {
            const top = f.y + c.wallH[side]![r]!;
            return [
              [o, f.y - 0.05],
              [o, top],
              [o + WALL_THICK, top],
            ];
          }
          return null;
        };
        for (let k = 0; k < rows.length - 1; k++) {
          const pa = profileOf(k);
          const pb = profileOf(k + 1);
          const r = rows[k]!.r;
          if (pa && pb && pa.length === pb.length) {
            const fa = frames[k]!;
            const fb = frames[k + 1]!;
            for (let q = 0; q < pa.length - 1; q++) {
              const vertical = Math.abs(pa[q]![0] - pa[q + 1]![0]) < 1e-3;
              const facing = vertical ? (pa[q + 1]![1] > pa[q]![1] ? -sg : sg) : 0;
              const pt = (fr: Frame, d: number, p: [number, number]) => {
                const x = fr.x + sg * fr.rx * p[0];
                const z = fr.z + sg * fr.rz * p[0];
                const nx = facing * fr.rx;
                const nz = facing * fr.rz;
                const u = d / STONE_REPEAT;
                const v = vertical ? p[1] / STONE_REPEAT : p[0] / STONE_REPEAT;
                return walls.vertex(x, p[1], z, nx, vertical ? 0 : 1, nz, u, v);
              };
              const a0 = pt(fa, rows[k]!.d, pa[q]!);
              const a1 = pt(fa, rows[k]!.d, pa[q + 1]!);
              const b0 = pt(fb, rows[k + 1]!.d, pb[q]!);
              const b1 = pt(fb, rows[k + 1]!.d, pb[q + 1]!);
              walls.quad(a0, a1, b1, b0, facing * fa.rx, vertical ? 0 : 1, facing * fa.rz);
            }
          }
          if (c.edge[side]![r] === EDGE.rail && c.edge[side]![rows[k + 1]!.r] === EDGE.rail) {
            const fa = frames[k]!;
            const fb = frames[k + 1]!;
            const oa = c.hw[side]![r]! + SHOULDER + 0.3;
            const ob = c.hw[side]![rows[k + 1]!.r]! + SHOULDER + 0.3;
            const v = (fr: Frame, o: number, dy: number) => rail.vertex(fr.x + sg * fr.rx * o, fr.y + dy, fr.z + sg * fr.rz * o, -sg * fr.rx, 0, -sg * fr.rz);
            const a0 = v(fa, oa, 0.45);
            const a1 = v(fa, oa, 0.78);
            const b0 = v(fb, ob, 0.45);
            const b1 = v(fb, ob, 0.78);
            rail.quad(a0, a1, b1, b0, -sg * fa.rx, 0, -sg * fa.rz);
            posts.push(fa.x + sg * fa.rx * (oa + 0.1), fa.y + 0.38, fa.z + sg * fa.rz * (oa + 0.1));
          }
          // street lamps in towns, every 32 m on alternating sides
          if (side === 0 && c.urban[r] && r % 8 === 0) {
            const lampSide = (r / 8) % 2 === 0 ? 1 : 0;
            const ls = lampSide === 0 ? -1 : 1;
            const f = frames[k]!;
            if (c.edge[lampSide]![r] !== EDGE.lake) {
              const o = c.hw[lampSide]![r]! + SHOULDER + 0.35;
              const heading = t.headings[c.sampleOf(r)]!;
              lamps.push(f.x + ls * f.rx * o, f.y, f.z + ls * f.rz * o, ls > 0 ? heading + Math.PI : heading);
            }
          }
        }
      }
      const wm = walls.build(scene, `walls-${id}`, stoneMat);
      if (wm) other.push(wm);
      const rm = rail.build(scene, `rail-${id}`, railMat);
      if (rm) other.push(rm);
    }
  }

  if (posts.length > 0) {
    const post = MeshBuilder.CreateBox('rail-post', { width: 0.1, height: 0.76, depth: 0.1 }, scene);
    post.material = railMat;
    post.isPickable = false;
    const buf = new Float32Array((posts.length / 3) * 16);
    for (let p = 0; p < posts.length / 3; p++) {
      Matrix.TranslationToRef(posts[p * 3]!, posts[p * 3 + 1]!, posts[p * 3 + 2]!, tmpMatrix);
      tmpMatrix.copyToArray(buf, p * 16);
    }
    post.thinInstanceSetBuffer('matrix', buf, 16, true);
    other.push(post);
  }
  if (lamps.length > 0) other.push(streetLamps(scene, lamps));
  return { road, other };
}

const tmpMatrix = new Matrix();

/** Classic lakeside street lamp: dark green pole with a curved arm reaching over the road. */
function streetLamps(scene: Scene, lamps: number[]): Mesh {
  const pole = MeshBuilder.CreateCylinder('lamp-pole', { height: 5.4, diameterTop: 0.09, diameterBottom: 0.16, tessellation: 8 }, scene);
  pole.position.y = 2.7;
  const arm = MeshBuilder.CreateBox('lamp-arm', { width: 1.2, height: 0.07, depth: 0.07 }, scene);
  arm.position.set(0.55, 5.3, 0);
  const head = MeshBuilder.CreateCylinder('lamp-head', { height: 0.22, diameterTop: 0.18, diameterBottom: 0.42, tessellation: 10 }, scene);
  head.position.set(1.12, 5.15, 0);
  const lamp = Mesh.MergeMeshes([pole, arm, head], true, true)!;
  lamp.name = 'street-lamps';
  const mat = new StandardMaterial('lamp-mat', scene);
  mat.diffuseColor = new Color3(0.13, 0.17, 0.15);
  mat.specularColor = new Color3(0.25, 0.25, 0.25);
  lamp.material = mat;
  lamp.isPickable = false;
  const n = lamps.length / 4;
  const buf = new Float32Array(n * 16);
  const q = new Quaternion();
  const s = Vector3.One();
  const p = new Vector3();
  for (let i = 0; i < n; i++) {
    Quaternion.RotationAxisToRef(Vector3.Up(), lamps[i * 4 + 3]!, q);
    p.set(lamps[i * 4]!, lamps[i * 4 + 1]!, lamps[i * 4 + 2]!);
    Matrix.ComposeToRef(s, q, p, tmpMatrix);
    tmpMatrix.copyToArray(buf, i * 16);
  }
  lamp.thinInstanceSetBuffer('matrix', buf, 16, true);
  return lamp;
}
