import { Color3, DynamicTexture, Mesh, StandardMaterial, VertexData, type Scene } from '@babylonjs/core';
import type { RouteStyle, Track } from '@velo/routes';
import { Noise2D, mix, smoothstep } from './noise';
import { RoadIndex } from './roadIndex';

const MARGIN = 1500;
const COARSE = 100;
const CORRIDOR = 6.5;
const BLEND_END = 90;

/**
 * Pure height model (no Babylon): terrain hugs the road inside a corridor and
 * blends into style-specific relief further away. Also used to place props.
 */
export class TerrainModel {
  readonly index: RoadIndex;
  readonly noise: Noise2D;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly seaLevel: number | null;
  private readonly cnx: number;
  private readonly cnz: number;
  private readonly coarseElev: Float32Array;
  private readonly coarseDist: Float32Array;
  private readonly nearRoadCells: Set<number>;

  constructor(
    readonly track: Track,
    readonly style: RouteStyle,
  ) {
    this.index = new RoadIndex(track);
    this.noise = new Noise2D(hash(track.id));
    const b = track.bounds;
    this.minX = b.minX - MARGIN;
    this.maxX = b.maxX + MARGIN;
    this.minZ = b.minZ - MARGIN;
    this.maxZ = b.maxZ + MARGIN;
    this.seaLevel = style === 'coast' ? 0 : null;

    // Coarse field: smooth road-elevation interpolation + distance to road.
    this.cnx = Math.ceil((this.maxX - this.minX) / COARSE) + 1;
    this.cnz = Math.ceil((this.maxZ - this.minZ) / COARSE) + 1;
    this.coarseElev = new Float32Array(this.cnx * this.cnz);
    this.coarseDist = new Float32Array(this.cnx * this.cnz);
    const every = Math.max(1, Math.round(50 / track.step));
    const sx: number[] = [];
    const sz: number[] = [];
    const sy: number[] = [];
    for (let i = 0; i < track.count; i += every) {
      sx.push(track.xs[i]!);
      sz.push(track.zs[i]!);
      sy.push(track.ys[i]!);
    }
    for (let j = 0; j < this.cnz; j++) {
      for (let i = 0; i < this.cnx; i++) {
        const x = this.minX + i * COARSE;
        const z = this.minZ + j * COARSE;
        let wsum = 0;
        let esum = 0;
        let best = Infinity;
        for (let k = 0; k < sx.length; k++) {
          const d2 = (sx[k]! - x) ** 2 + (sz[k]! - z) ** 2;
          if (d2 < best) best = d2;
          const w = 1 / (d2 + 250 * 250);
          wsum += w;
          esum += w * sy[k]!;
        }
        this.coarseElev[j * this.cnx + i] = esum / wsum;
        this.coarseDist[j * this.cnx + i] = Math.sqrt(best);
      }
    }

    // Cells (40 m) close enough to the road to need the exact query.
    this.nearRoadCells = new Set();
    const reach = Math.ceil(BLEND_END / 40) + 1;
    for (let i = 0; i < track.count; i += 5) {
      const cx = Math.floor(track.xs[i]! / 40);
      const cz = Math.floor(track.zs[i]! / 40);
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) this.nearRoadCells.add(cellKey(cx + dx, cz + dz));
    }
  }

  private coarse(x: number, z: number): { elev: number; dist: number } {
    const fx = Math.min(this.cnx - 1.001, Math.max(0, (x - this.minX) / COARSE));
    const fz = Math.min(this.cnz - 1.001, Math.max(0, (z - this.minZ) / COARSE));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = j * this.cnx + i;
    const bl = (arr: Float32Array) =>
      mix(mix(arr[a]!, arr[a + 1]!, tx), mix(arr[a + this.cnx]!, arr[a + this.cnx + 1]!, tx), tz);
    return { elev: bl(this.coarseElev), dist: bl(this.coarseDist) };
  }

  /** Terrain height ignoring the road (style relief on top of the smoothed road elevation). */
  naturalHeight(x: number, z: number): number {
    const { elev, dist } = this.coarse(x, z);
    const n = this.noise;
    switch (this.style) {
      case 'coast': {
        const land = elev + 6 + n.fbm(x / 900, z / 900, 4) * 22 + smoothstep(200, 900, dist) * 25 * (0.5 + 0.5 * n.fbm(x / 2000, z / 2000, 3));
        const coastZ = this.track.bounds.maxZ - 120 + 260 * n.noise(x / 1600, 3.7);
        const sea = smoothstep(coastZ - 60, coastZ + 420, z);
        return mix(land, -22, sea);
      }
      case 'hills':
      case 'lake':
        return elev + 12 + n.fbm(x / 700, z / 700, 5) * 45 + smoothstep(150, 800, dist) * 70 * (0.6 + 0.4 * n.fbm(x / 1500, z / 1500, 3));
      case 'alpine': {
        const mountains = smoothstep(120, 1000, dist) * (260 + 760 * n.ridged(x / 2300, z / 2300, 5));
        return elev + n.fbm(x / 600, z / 600, 4) * 35 + mountains;
      }
    }
  }

  /** Final terrain height: road corridor flattened just below the road surface. */
  heightAt(x: number, z: number): number {
    const natural = this.naturalHeight(x, z);
    if (!this.nearRoadCells.has(cellKey(Math.floor(x / 40), Math.floor(z / 40)))) return natural;
    const near = this.index.nearest(x, z, BLEND_END);
    if (near.dist === Infinity) return natural;
    const w = smoothstep(CORRIDOR, BLEND_END, near.dist);
    return mix(near.y - 0.8, natural, w);
  }

  roadDistance(x: number, z: number, maxDist = 200): number {
    return this.index.nearest(x, z, maxDist).dist;
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const PALETTE: Record<RouteStyle, { grass: Color3; grass2: Color3; rock: Color3; snowLine: number }> = {
  coast: { grass: new Color3(0.45, 0.6, 0.3), grass2: new Color3(0.6, 0.62, 0.35), rock: new Color3(0.55, 0.52, 0.46), snowLine: Infinity },
  hills: { grass: new Color3(0.34, 0.55, 0.22), grass2: new Color3(0.5, 0.6, 0.26), rock: new Color3(0.5, 0.47, 0.42), snowLine: Infinity },
  alpine: { grass: new Color3(0.3, 0.47, 0.2), grass2: new Color3(0.42, 0.5, 0.28), rock: new Color3(0.47, 0.45, 0.43), snowLine: 1050 },
  lake: { grass: new Color3(0.32, 0.5, 0.21), grass2: new Color3(0.45, 0.55, 0.26), rock: new Color3(0.5, 0.48, 0.44), snowLine: Infinity },
};

const SAND = new Color3(0.86, 0.8, 0.6);
const SEABED = new Color3(0.5, 0.48, 0.38);
const SNOW = new Color3(0.95, 0.96, 0.98);

/** Builds the terrain mesh (~12 m grid) with vertex colours by height and slope. */
export function buildTerrainMesh(scene: Scene, model: TerrainModel, spacing = 12): Mesh {
  const nx = Math.ceil((model.maxX - model.minX) / spacing) + 1;
  const nz = Math.ceil((model.maxZ - model.minZ) / spacing) + 1;
  const positions = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = model.minX + i * spacing;
      const z = model.minZ + j * spacing;
      const k = j * nx + i;
      positions[k * 3] = x;
      positions[k * 3 + 1] = model.heightAt(x, z);
      positions[k * 3 + 2] = z;
      uvs[k * 2] = x / 9;
      uvs[k * 2 + 1] = z / 9;
    }
  }
  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let p = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Winding chosen so faces point up in Babylon's left-handed system.
      indices[p++] = a;
      indices[p++] = b;
      indices[p++] = c;
      indices[p++] = b;
      indices[p++] = d;
      indices[p++] = c;
    }
  }
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);

  const pal = PALETTE[model.style];
  const colors = new Float32Array(nx * nz * 4);
  const n = model.noise;
  for (let k = 0; k < nx * nz; k++) {
    const x = positions[k * 3]!;
    const y = positions[k * 3 + 1]!;
    const z = positions[k * 3 + 2]!;
    const slope = 1 - normals[k * 3 + 1]!;
    const v = 0.5 + 0.5 * n.noise(x / 180, z / 180);
    let c = Color3.Lerp(pal.grass, pal.grass2, v);
    if (model.seaLevel !== null) {
      if (y < model.seaLevel - 0.5) c = SEABED;
      else if (y < model.seaLevel + 2.5) c = Color3.Lerp(SAND, c, smoothstep(model.seaLevel + 1, model.seaLevel + 2.5, y));
    }
    c = Color3.Lerp(c, pal.rock, smoothstep(0.22, 0.42, slope));
    if (y > pal.snowLine + n.noise(x / 300, z / 300) * 90) c = Color3.Lerp(c, SNOW, 1 - smoothstep(0.45, 0.6, slope) * 0.7);
    const shade = 0.92 + 0.08 * n.noise(x / 37, z / 37);
    colors[k * 4] = c.r * shade;
    colors[k * 4 + 1] = c.g * shade;
    colors[k * 4 + 2] = c.b * shade;
    colors[k * 4 + 3] = 1;
  }

  const mesh = new Mesh(`terrain-${model.track.id}`, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.colors = colors;
  vd.uvs = uvs;
  vd.applyToMesh(mesh, false);

  const mat = new StandardMaterial('terrain-mat', scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  mat.diffuseTexture = detailTexture(scene);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  return mesh;
}

/** Subtle grain so large terrain areas do not look flat-shaded. */
function detailTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture('terrain-detail', { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  const noise = new Noise2D(7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // tileable: sample a torus-ish combination
      const v = 0.86 + 0.14 * (0.5 + 0.5 * noise.fbm((x / size) * 8, (y / size) * 8, 3));
      const g = Math.round(255 * Math.min(1, v + (Math.random() - 0.5) * 0.06));
      const i = (y * size + x) * 4;
      img.data[i] = g;
      img.data[i + 1] = g;
      img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update();
  tex.wrapU = tex.wrapV = 1; // WRAP
  return tex;
}
