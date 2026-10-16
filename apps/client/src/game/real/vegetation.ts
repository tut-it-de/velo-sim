import {
  Color3,
  Material,
  MaterialPluginBase,
  Mesh,
  StandardMaterial,
  Texture,
  Vector4,
  VertexData,
  type Scene,
  type UniformBuffer,
  type Vector3,
  type MaterialDefines,
  type BaseTexture,
} from '@babylonjs/core';
import { createRng } from '../noise';
import { SHOULDER, type RouteCorridor } from './corridor';
import type { BuildingIndex } from './heightField';
import type { QualityProfile } from './quality';
import { LAND_CLASS, type Flora, type WorldData } from './worldData';
import { bakeImpostors, type ImpostorAtlas, type ImpostorUv } from './trees/impostorBake';
import { SPECIES } from './trees/species';
import { WindPlugin } from './trees/windPlugin';
import type { SpeciesId, TreeInstance } from './trees/types';

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
/** Share of the crown width that is filled by the tree (used to keep crowns off the road). */
const CROWN_FILL = 0.85;
/** October: a share of the chestnuts, beeches and planes already turning (share per flora below). */
const AUTUMN: Array<[number, number, number]> = [
  [1, 1, 1],
  [1.18, 1.08, 0.62],
  [1.3, 0.98, 0.55],
  [1.05, 1.04, 0.8],
];
const LARCH: [number, number, number] = [1.45, 1.12, 0.42];
/** Laurel bushes on the drier, greener side of the lake and the alps. */
const GREEN_LAURUS: [number, number, number] = [0.9, 1.06, 0.9];
/** Impostor cell in pixels: [width, height] per tree, by quality. */
const CELL_HIGH: [number, number] = [256, 512];
const CELL_LOW: [number, number] = [128, 256];
/** Alpha cut of the impostor cards, same as the 3D leaves. */
const CARD_ALPHA_CUT = 0.4;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface FloraRules {
  /** Share of conifers in forests at a terrain height. */
  conifer: (h: number) => number;
  /** Share of cypresses among village, garden and single trees below 320 m. */
  cypress: number;
  /** Share of broadleaf trees already turning. */
  autumn: number;
  /** Trees thin out and shrink between these heights (tree line), m. */
  treeLine: [number, number];
  /** Share of conifers above 1500 m that are larches, golden in October. */
  larch: number;
}

const FLORA: Record<Flora, FloraRules> = {
  // Lake Como: chestnut woods, spruce and larch only higher up, cypresses in the villages
  mediterranean: {
    conifer: (h) => (h < 900 ? 0.12 : h < 1300 ? 0.5 : 0.9),
    cypress: 0.28,
    autumn: 0.22,
    treeLine: [1900, 2200],
    larch: 0.15,
  },
  // German low mountains: beech and oak, spruce stands growing more common towards the ridges
  central: {
    conifer: (h) => (h < 350 ? 0.15 : h < 600 ? 0.35 : 0.5),
    cypress: 0,
    autumn: 0.3,
    treeLine: [1500, 1800],
    larch: 0,
  },
  // Alps: mixed forest in the valleys, spruce and larch above, open alpine meadows past the tree line
  alpine: {
    conifer: (h) => (h < 1000 ? 0.45 : h < 1500 ? 0.8 : 0.95),
    cypress: 0,
    autumn: 0.25,
    treeLine: [1900, 2200],
    larch: 0.25,
  },
};

/** Cuts the impostor cards to the 3D trees of the near ring: `inner` … `outer` metres from the card's foot. */
export interface NearFade {
  inner: number;
  outer: number;
}

export interface Vegetation {
  meshes: Mesh[];
  /** Every placed tree, for the near 3D trees (P3.6). */
  instances: TreeInstance[];
  /** Per frame: the camera position and the fade band of the near trees. */
  setNearFade(camera: Vector3, fade: NearFade): void;
  /** The impostor material changes every frame, so it must leave the frozen materials after `scene.freezeMaterials()`. */
  afterFreeze(): void;
}

// Blending hash shared with the near trees: discards by screen position, so the two blend without sorting.
const FADE_DEFINITIONS = /* glsl */ `
#ifdef VELO_BILLBOARD
varying vec2 veloFoot;
float veloIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
#endif
`;

// Hidden where the near 3D trees stand: the complement of their fade (they drop out where the test is below `fade`).
// Without a near ring (outer <= inner) nothing is cut.
const FADE_MAIN_BEGIN = /* glsl */ `
#ifdef VELO_BILLBOARD
{
  float veloS = veloNearFade.y > veloNearFade.x
    ? smoothstep(veloNearFade.x, veloNearFade.y, distance(veloFoot, veloNearFade.zw))
    : 1.0;
  if (veloIgn(gl_FragCoord.xy) >= veloS) discard;
}
#endif
`;

/**
 * Billboard material pieces: the foot of each tree goes to the fragment shader (uv2), the baked colour is
 * un-premultiplied (the atlas stores colour × coverage), and the near-ring fade cuts the cards.
 * Uniform `veloNearFade` = (inner, outer, camera x, camera z).
 */
/**
 * Lighting normal of a billboard pixel, rebuilt from the baked view-space normal. The baked z points towards the
 * bake camera, i.e. along -forward of the card; it is turned towards the side the viewer is on, so both faces of a
 * card (and both crossed cards) are lit like the tree seen from the front, not like a flat vertical quad.
 * Card frame: forward = vertex normal (horizontal), right = (forward.z, 0, -forward.x), up = world up.
 */
const IMPOSTOR_NORMAL = /* glsl */ `
#ifdef VELO_BILLBOARD
{
  vec3 veloF = normalize(vec3(vNormalW.x, 0.0, vNormalW.z));
  vec3 veloR = vec3(veloF.z, 0.0, -veloF.x);
  float veloSide = dot(veloF, vEyePosition.xyz - vPositionW) >= 0.0 ? 1.0 : -1.0;
  vec3 veloN = texture2D(veloImpNormal, vMainUV1).xyz * 2.0 - 1.0;
  normalW = normalize(veloR * veloN.x + vec3(0.0, 1.0, 0.0) * veloN.y - veloF * veloSide * veloN.z);
}
#endif
`;

class BillboardPlugin extends MaterialPluginBase {
  readonly params = new Vector4(0, 0, 0, 0);

  constructor(
    material: StandardMaterial,
    private readonly normalAtlas: BaseTexture,
  ) {
    super(material, 'VeloBillboard', 205, { VELO_BILLBOARD: true });
    this._enable(true);
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('veloImpNormal');
  }

  override getClassName(): string {
    return 'VeloBillboardPlugin';
  }

  /** uv2 carries the foot position, so the attribute has to be declared. */
  override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['_needUVs'] = true;
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['VELO_BILLBOARD'] = true;
  }

  override getUniforms() {
    return {
      ubo: [{ name: 'veloNearFade', size: 4, type: 'vec4' }],
      vertex: 'uniform vec4 veloNearFade;\n',
      fragment: 'uniform vec4 veloNearFade;\n',
    };
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    ubo.updateVector4('veloNearFade', this.params);
    ubo.setTexture('veloImpNormal', this.normalAtlas);
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `#ifdef VELO_BILLBOARD\nvarying vec2 veloFoot;\n#endif\n`,
        CUSTOM_VERTEX_MAIN_END: `#ifdef VELO_BILLBOARD\nveloFoot = uv2Updated;\n#endif\n`,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `${FADE_DEFINITIONS}#ifdef VELO_BILLBOARD\nuniform sampler2D veloImpNormal;\n#endif\n`,
      CUSTOM_FRAGMENT_MAIN_BEGIN: FADE_MAIN_BEGIN,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `#ifdef VELO_BILLBOARD\nbaseColor.rgb /= max(baseColor.a, 0.001);\n#endif\n`,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: IMPOSTOR_NORMAL,
    };
  }
}

/** One mesh part of the billboards (positions, normals, atlas uv, foot in uv2, tint). */
interface CardChunk {
  pos: number[];
  nor: number[];
  uv: number[];
  uv2: number[];
  col: number[];
  idx: number[];
}

/**
 * Two crossed cards per tree, textured with its baked impostor. The card frame is (right, up, forward) of the
 * bake camera: right = (cos a, 0, sin a), forward = (−sin a, 0, cos a), so the baked normals map onto it
 * directly. Every vertex carries the card's forward direction as its normal.
 */
function addCard(c: CardChunk, t: TreeInstance, halfW: number, uv: ImpostorUv): void {
  const rx = Math.cos(t.yaw) * halfW;
  const rz = Math.sin(t.yaw) * halfW;
  const fx = -Math.sin(t.yaw);
  const fz = Math.cos(t.yaw);
  const base = c.pos.length / 3;
  const corners: Array<[number, number, number, number, number]> = [
    [-rx, 0, -rz, uv.u0, uv.v0],
    [rx, 0, rz, uv.u1, uv.v0],
    [rx, t.height, rz, uv.u1, uv.v1],
    [-rx, t.height, -rz, uv.u0, uv.v1],
  ];
  for (const [dx, dy, dz, u, v] of corners) {
    c.pos.push(t.x + dx, t.y + dy, t.z + dz);
    c.nor.push(fx, 0, fz);
    c.uv.push(u, v);
    c.uv2.push(t.x, t.z);
    // alpha = wind weight: 0 at the foot, 1 at the top (the material ignores vertex alpha otherwise)
    c.col.push(t.tint[0], t.tint[1], t.tint[2], dy > 0 ? 1 : 0);
  }
  c.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function loadTexture(scene: Scene, name: string): Promise<Texture> {
  return new Promise((resolve, reject) => {
    // invertY = false: the atlas UVs are in image space, as in the impostor bake
    const tex: Texture = new Texture(
      `${import.meta.env.BASE_URL}textures/${name}.webp`,
      scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      () => resolve(tex),
      (message) => reject(new Error(`Textur ${name} fehlt: ${message ?? ''}`)),
    );
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
  });
}

/**
 * Trees near the road are planted as 3D instances (P3.6); the rest of the vegetation is billboards baked
 * from the same 3D trees at load time (colour and normals). Planted from the land-cover classes within the
 * quality profile's radius of the road — never on the road, in the lake or inside houses.
 */
export async function buildVegetation(
  scene: Scene,
  data: WorldData,
  corridor: RouteCorridor,
  buildings: BuildingIndex,
  quality: QualityProfile,
): Promise<Vegetation> {
  const g = data.near;
  const field = corridor.field;
  const wl = data.waterLevel;
  const track = corridor.track;
  const radius = quality.treeRadius;
  const rng = createRng(2024);
  const flora = FLORA[data.look.flora];


  // distance to the road per near-grid cell
  const dist = corridor.routeDistanceGrid();

  const instances: TreeInstance[] = [];
  const speciesHeight = (id: SpeciesId): number => {
    const p = SPECIES[id]!;
    return p.height[0] + rng() * (p.height[1] - p.height[0]);
  };
  const plant = (x: number, z: number, species: SpeciesId, height: number, d: number, larch = false) => {
    // The crown must not reach over the road: on a slope below the road it would stand right in the
    // lane at wheel height. Trees close to the edge are planted smaller, or not at all.
    // The crown width is approximated by the species' crownWidth (the impostor aspect is only known after the bake).
    const aspect = SPECIES[species]!.crownWidth;
    const hit = corridor.nearest(x, z, 16);
    if (hit) {
      const gap = Math.abs(hit.offset) - corridor.hw[hit.offset >= 0 ? 1 : 0][hit.row]! - SHOULDER;
      if (gap < 1.6) return;
      const fit = gap / (CROWN_FILL * aspect * 0.5);
      if (fit < height) {
        if (fit < 3.5) return;
        height = fit;
      }
    }
    if (field.isWater(x, z) || buildings.find(x, z, 1.2) >= 0) return;
    const y = (d < 48 ? corridor.surface(x, z) : field.dem(x, z)) - 0.3;
    if (y < wl + 0.2) return;
    const yaw = rng() * Math.PI;
    const variant = Math.floor(rng() * 3);
    const broadleaf = species === 'chestnut' || species === 'beech' || species === 'plane';
    let base: [number, number, number] = AUTUMN[0]!;
    if (larch) base = LARCH;
    else if (broadleaf && rng() < flora.autumn) base = AUTUMN[1 + Math.floor(rng() * 3)]!;
    else if (species === 'laurel' && data.look.flora !== 'mediterranean') base = GREEN_LAURUS;
    const shade = 0.85 + rng() * 0.25;
    instances.push({
      x,
      y,
      z,
      species,
      variant,
      height,
      yaw,
      tint: [base[0] * shade, base[1] * shade, base[2] * shade],
    });
  };

  for (let j = 0; j < g.nz; j++) {
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      const d = dist[k]!;
      if (d > radius) continue;
      const cls = g.classes[k]!;
      const h = g.heights[k]!;
      // towards the tree line the forest opens up and the trees get smaller
      const alpine = smoothstep(flora.treeLine[0], flora.treeLine[1], h);
      const density = (DENSITY[cls] ?? 0) * (1 - 0.45 * Math.max(0, (d - radius * 0.5) / (radius * 0.5))) * (1 - alpine);
      let count = Math.floor(density);
      if (rng() < density - count) count++;
      for (let n = 0; n < count; n++) {
        const x = g.x0 + (i - 0.5 + rng()) * g.step;
        const z = g.z0 + (j - 0.5 + rng()) * g.step;
        if (cls === LAND_CLASS.forest) {
          if (rng() < flora.conifer(h)) {
            const larch = h > 1500 && rng() < flora.larch;
            const species: SpeciesId = larch ? 'larch' : 'spruce';
            plant(x, z, species, speciesHeight(species) * (1 - 0.5 * alpine), d, larch);
          } else {
            const species: SpeciesId = data.look.flora === 'mediterranean' ? 'chestnut' : 'beech';
            plant(x, z, species, speciesHeight(species) * (1 - 0.5 * alpine), d);
          }
        } else if (cls === LAND_CLASS.urban || cls === LAND_CLASS.garden || cls === LAND_CLASS.park) {
          if (h < 320 && rng() < flora.cypress) {
            plant(x, z, 'cypress', speciesHeight('cypress'), d);
          } else if (data.look.flora === 'mediterranean' && h < 260) {
            const r = rng();
            if (r < 0.08) plant(x, z, 'palm', speciesHeight('palm'), d);
            else if (r < 0.23) plant(x, z, 'oleander', speciesHeight('oleander'), d);
            else plant(x, z, 'plane', speciesHeight('plane'), d);
          } else {
            plant(x, z, 'plane', speciesHeight('plane'), d);
          }
        } else if (cls === LAND_CLASS.orchard) {
          const species: SpeciesId = data.look.flora === 'mediterranean' ? 'olive' : 'plane';
          plant(x, z, species, 4 + rng() * 3, d);
        } else if (cls === LAND_CLASS.shrub) {
          plant(x, z, 'laurel', speciesHeight('laurel'), d);
        } else {
          // open land: the sparse broadleaf trees of the valley floor
          const species: SpeciesId = data.look.flora === 'mediterranean' ? 'chestnut' : 'beech';
          plant(x, z, species, speciesHeight(species), d);
        }
      }
    }
  }
  // single trees mapped in OpenStreetMap (villa gardens, promenades)
  for (let p = 0; p < data.trees.length; p += 2) {
    const x = data.trees[p]!;
    const z = data.trees[p + 1]!;
    const d = corridor.routeDistance(x, z);
    if (d > radius) continue;
    const cypress = field.dem(x, z) < 320 && rng() < flora.cypress * 1.07;
    if (cypress) plant(x, z, 'cypress', speciesHeight('cypress'), d);
    else plant(x, z, 'plane', speciesHeight('plane'), d);
  }

  const noFade: NearFade = { inner: 0, outer: 0 };
  if (instances.length === 0) {
    return { meshes: [], instances, setNearFade: () => {}, afterFreeze: () => {} };
  }

  // Impostors of the species that are actually planted; the atlas is baked once, at load time.
  const species = [...new Set(instances.map((t) => t.species))];
  const [bark, leaves] = await Promise.all([loadTexture(scene, 'bark'), loadTexture(scene, 'leaves')]);
  leaves.hasAlpha = true;
  const cell = quality.level === 'mittel' || quality.level === 'niedrig' ? CELL_LOW : CELL_HIGH;
  const atlas: ImpostorAtlas = await bakeImpostors(scene, species, cell, { bark, leaves });
  atlas.color.hasAlpha = true;
  atlas.color.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);
  atlas.normal.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);

  const mat = new StandardMaterial('trees', scene);
  mat.diffuseTexture = atlas.color;
  // No bumpTexture: the plugin rebuilds the normal from atlas.normal (see IMPOSTOR_NORMAL).
  mat.transparencyMode = Material.MATERIAL_ALPHATEST;
  // with an explicit transparency mode Babylon tests the final alpha, which must come from the atlas
  mat.useAlphaFromDiffuseTexture = true;
  mat.alphaCutOff = CARD_ALPHA_CUT;
  mat.backFaceCulling = false;
  mat.specularColor = Color3.Black();
  mat.diffuseColor = new Color3(0.95, 0.95, 0.95);
  const plugin = new BillboardPlugin(mat, atlas.normal);
  if (quality.level !== 'niedrig') {
    new WindPlugin(mat, { card: true, weight: 'colorAlpha', strength: 0.25 });
    scene.onBeforeRenderObservable.add(() => WindPlugin.update(scene, scene.getEngine().getDeltaTime() / 1000));
  }
  plugin.params.set(noFade.inner, noFade.outer, 0, 0);

  const chunks = new Map<string, CardChunk>();
  for (const t of instances) {
    const key = `${Math.floor(t.x / CHUNK)},${Math.floor(t.z / CHUNK)}`;
    const cellKey = `${t.species}:${t.variant}`;
    const uv = atlas.cells.get(cellKey);
    const aspect = atlas.aspect.get(cellKey);
    if (!uv || aspect === undefined) continue;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = { pos: [], nor: [], uv: [], uv2: [], col: [], idx: [] }));
    addCard(c, t, (t.height * aspect) / 2, uv);
  }

  const meshes: Mesh[] = [];
  for (const [key, c] of chunks) {
    const vd = new VertexData();
    vd.positions = new Float32Array(c.pos);
    vd.normals = new Float32Array(c.nor);
    vd.uvs = new Float32Array(c.uv);
    vd.uvs2 = new Float32Array(c.uv2);
    vd.colors = new Float32Array(c.col);
    vd.indices = new Uint32Array(c.idx);
    const m = new Mesh(`trees-${key}`, scene);
    vd.applyToMesh(m, false);
    m.material = mat;
    m.isPickable = false;
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    m.addLODLevel(quality.treeDistance, null);
    meshes.push(m);
  }

  return {
    meshes,
    instances,
    setNearFade(camera, fade) {
      plugin.params.set(fade.inner, fade.outer, camera.x, camera.z);
    },
    afterFreeze() {
      mat.unfreeze();
    },
  };
}
