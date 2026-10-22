import {
  Color3,
  Material,
  Matrix,
  MaterialPluginBase,
  Mesh,
  Quaternion,
  StandardMaterial,
  Texture,
  Vector3,
  Vector4,
  VertexBuffer,
  VertexData,
  type MaterialDefines,
  type Scene,
  type ShadowGenerator,
  type UniformBuffer,
} from '@babylonjs/core';
import type { QualityProfile } from '../quality';
import type { NearFade } from '../vegetation';
import { SPECIES } from './species';
import { generateTree } from './treeGen';
import type { GeomPart, SpeciesId, TreeInstance } from './types';
import { WindPlugin } from './windPlugin';

const VARIANTS = 3;
/** Side length of the grid cells that index the placed trees (m). */
const GRID = 32;
/** The near set is rebuilt once the camera has moved this far (m). */
const REBUILD_MOVE = 8;
/** Trees up to this distance beyond `outer` are collected, so the set still covers a camera that has moved on. */
const RING_MARGIN = 15;
/** `inner` lies this far inside `outer` (m). */
const FADE_BAND = 12;
const LIMITS: Record<'ultra' | 'hoch', { max: number; outer: number }> = {
  ultra: { max: 150, outer: 55 },
  hoch: { max: 120, outer: 50 },
};

// Blending hash shared with the billboards (vegetation.ts): both cut by screen position, so they hand over without sorting.
const NEAR_DEFINITIONS = /* glsl */ `
#ifdef VELO_NEAR
varying vec2 veloOrigin;
float veloIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
#endif
`;

// Dropped where the fade is above the dither value. Inside `inner` (fade 0) nothing is dropped, beyond `outer` (fade 1) everything is.
const NEAR_MAIN_BEGIN = /* glsl */ `
#ifdef VELO_NEAR
{
  float veloS = veloNearTree.y > veloNearTree.x
    ? smoothstep(veloNearTree.x, veloNearTree.y, distance(veloOrigin, veloNearTree.zw))
    : 0.0;
  if (veloIgn(gl_FragCoord.xy) < veloS) discard;
}
#endif
`;

/**
 * Fade of the 3D trees: the tree's foot (origin of the thin instance) against the camera, in the same metric and
 * band as the billboard fade. Uniform `veloNearTree` = (inner, outer, camera x, camera z).
 */
class NearPlugin extends MaterialPluginBase {
  constructor(
    material: StandardMaterial,
    private readonly params: Vector4,
  ) {
    super(material, 'VeloNear', 206, { VELO_NEAR: true });
    this._enable(true);
  }

  override getClassName(): string {
    return 'VeloNearPlugin';
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['VELO_NEAR'] = true;
  }

  override getUniforms() {
    return {
      ubo: [{ name: 'veloNearTree', size: 4, type: 'vec4' }],
      vertex: 'uniform vec4 veloNearTree;\n',
      fragment: 'uniform vec4 veloNearTree;\n',
    };
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    ubo.updateVector4('veloNearTree', this.params);
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `#ifdef VELO_NEAR\nvarying vec2 veloOrigin;\n#endif\n`,
        // finalWorld carries the thin-instance matrix; its origin is the tree's foot
        CUSTOM_VERTEX_MAIN_END: `#ifdef VELO_NEAR\nveloOrigin = (finalWorld * vec4(0.0, 0.0, 0.0, 1.0)).xz;\n#endif\n`,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: NEAR_DEFINITIONS,
      CUSTOM_FRAGMENT_MAIN_BEGIN: NEAR_MAIN_BEGIN,
    };
  }
}

function loadTexture(scene: Scene, name: string): Texture {
  // invertY = false: the tree UVs are in image space, as in the studio and the impostor bake
  const tex = new Texture(`${import.meta.env.BASE_URL}textures/${name}.webp`, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

function partMesh(scene: Scene, name: string, part: GeomPart, mat: Material): Mesh {
  const vd = new VertexData();
  vd.positions = part.positions;
  vd.normals = part.normals;
  vd.uvs = part.uvs;
  vd.indices = part.indices;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh);
  mesh.setVerticesData(VertexBuffer.UV2Kind, part.uvs2, false, 2);
  // vertex colour (generator brightness) and instance colour (tint) are both multiplied by Babylon
  mesh.setVerticesData(VertexBuffer.ColorKind, part.colors, false, 4);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  return mesh;
}

const cellKey = (ix: number, iz: number) => `${ix},${iz}`;

/**
 * The trees next to the road as 3D meshes (wood and leaves per species and seed variant, thin instances).
 * `update` picks the nearest trees for the camera; the rest of the vegetation stays billboards (vegetation.ts),
 * which fade out where these trees stand.
 */
export class NearTrees {
  /** Every 3D mesh (wood and leaves), for the shadow casters and the water reflection. */
  readonly meshes: Mesh[] = [];
  private readonly materials: StandardMaterial[] = [];
  private readonly textures: Texture[] = [];
  /** Wood and leaves meshes and the generated height, per `${species}:${variant}`. */
  private readonly parts = new Map<string, { wood: Mesh; leaves: Mesh; height: number }>();
  /** Every placed tree by grid cell. */
  private readonly grid = new Map<string, TreeInstance[]>();
  private readonly limits: { max: number; outer: number };
  /** Read by the shaders: inner, outer, camera x, camera z. */
  private readonly uniform = new Vector4(0, 0, 0, 0);
  private band: NearFade = { inner: 0, outer: 0 };
  private fromX = Number.NaN;
  private fromZ = Number.NaN;

  constructor(scene: Scene, instances: TreeInstance[], quality: QualityProfile, shadow: ShadowGenerator | null) {
    this.limits = quality.level === 'ultra' ? LIMITS.ultra : LIMITS.hoch;
    for (const t of instances) {
      const key = cellKey(Math.floor(t.x / GRID), Math.floor(t.z / GRID));
      const cell = this.grid.get(key);
      if (cell) cell.push(t);
      else this.grid.set(key, [t]);
    }
    if (instances.length === 0) return;

    const bark = loadTexture(scene, 'bark');
    const leafTex = loadTexture(scene, 'leaves');
    // without hasAlpha, Babylon ignores the texture alpha and the cards render as full squares
    leafTex.hasAlpha = true;
    this.textures.push(bark, leafTex);

    const kinds = new Map<string, { species: SpeciesId; variant: number }>();
    for (const t of instances) kinds.set(`${t.species}:${t.variant}`, { species: t.species, variant: t.variant });

    const materials = new Map<SpeciesId, { wood: StandardMaterial; leaves: StandardMaterial }>();
    for (const [key, { species, variant }] of kinds) {
      const p = SPECIES[species]!;
      let mats = materials.get(species);
      if (!mats) {
        const wood = new StandardMaterial(`near-${species}-wood`, scene);
        wood.specularColor = Color3.Black();
        wood.backFaceCulling = false;
        wood.diffuseColor = new Color3(p.barkColor[0], p.barkColor[1], p.barkColor[2]);
        wood.diffuseTexture = bark;
        // light scattered under the canopy: shaded bark stays readable instead of turning black
        wood.emissiveColor = new Color3(0.26 * p.barkColor[0], 0.26 * p.barkColor[1], 0.26 * p.barkColor[2]);
        const leaves = new StandardMaterial(`near-${species}-leaves`, scene);
        leaves.specularColor = Color3.Black();
        leaves.backFaceCulling = false;
        leaves.twoSidedLighting = false;
        leaves.useAlphaFromDiffuseTexture = true;
        leaves.transparencyMode = Material.MATERIAL_ALPHATEST;
        leaves.alphaCutOff = 0.4;
        leaves.diffuseColor = new Color3(p.leafColor[0], p.leafColor[1], p.leafColor[2]);
        leaves.diffuseTexture = leafTex;
        // leaves let light through: the shaded and inner side of the crown glows green instead of going black
        leaves.emissiveColor = new Color3(0.5 * p.leafColor[0], 0.53 * p.leafColor[1], 0.43 * p.leafColor[2]);
        // trees: amplitude 0.15 m at the tips, the stem foot stays fixed (weight from uv2.x)
        new WindPlugin(wood, { strength: 0.15 });
        new WindPlugin(leaves, { strength: 0.15 });
        new NearPlugin(wood, this.uniform);
        new NearPlugin(leaves, this.uniform);
        mats = { wood, leaves };
        materials.set(species, mats);
        this.materials.push(wood, leaves);
      }
      // same seed as the impostor bake (variant + 1), so the 3D tree and its billboard show the same tree
      const g = generateTree(p, variant + 1);
      const wood = partMesh(scene, `near-${key}-wood`, g.wood, mats.wood);
      const leaves = partMesh(scene, `near-${key}-leaves`, g.leaves, mats.leaves);
      wood.setEnabled(false);
      leaves.setEnabled(false);
      this.parts.set(key, { wood, leaves, height: g.height });
      this.meshes.push(wood, leaves);
    }

    // shadows: the 3D trees cast with their leaves (alpha test), like the billboards
    const casters = shadow?.getShadowMap()?.renderList;
    if (casters) casters.push(...this.meshes);
  }

  /**
   * Per frame: the camera position for the shaders. The set of near trees is chosen again after the camera has
   * moved REBUILD_MOVE metres: the nearest trees up to the limit, with `outer` lowered to the last one taken.
   */
  update(camera: Vector3): void {
    this.uniform.set(this.band.inner, this.band.outer, camera.x, camera.z);
    if (Math.hypot(camera.x - this.fromX, camera.z - this.fromZ) < REBUILD_MOVE) return;
    this.fromX = camera.x;
    this.fromZ = camera.z;
    this.select(camera.x, camera.z);
  }

  /** Fade band of the 3D trees; the billboards use the same values. */
  get fade(): NearFade {
    return { inner: this.band.inner, outer: this.band.outer };
  }

  /** The materials change every frame (wind, fade), so they must leave the frozen materials after `scene.freezeMaterials()`. */
  afterFreeze(): void {
    for (const m of this.materials) m.unfreeze();
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.meshes.length = 0;
    this.parts.clear();
  }

  private select(cx: number, cz: number): void {
    const reach = this.limits.outer + RING_MARGIN;
    const candidates: Array<{ t: TreeInstance; d: number }> = [];
    for (let ix = Math.floor((cx - reach) / GRID); ix <= Math.floor((cx + reach) / GRID); ix++) {
      for (let iz = Math.floor((cz - reach) / GRID); iz <= Math.floor((cz + reach) / GRID); iz++) {
        for (const t of this.grid.get(cellKey(ix, iz)) ?? []) {
          const d = Math.hypot(t.x - cx, t.z - cz);
          if (d <= reach) candidates.push({ t, d });
        }
      }
    }
    candidates.sort((a, b) => a.d - b.d);

    // The cap only ever lowers the radius: `outer` becomes the distance of the last tree taken.
    let outer = this.limits.outer;
    let taken = candidates;
    if (candidates.length >= this.limits.max) {
      taken = candidates.slice(0, this.limits.max);
      outer = Math.min(outer, taken[taken.length - 1]!.d);
    }
    this.band = { inner: Math.max(0, outer - FADE_BAND), outer };

    const groups = new Map<string, TreeInstance[]>();
    for (const { t } of taken) {
      const key = `${t.species}:${t.variant}`;
      const list = groups.get(key);
      if (list) list.push(t);
      else groups.set(key, [t]);
    }
    for (const [key, part] of this.parts) {
      const list = groups.get(key);
      if (!list) {
        part.wood.setEnabled(false);
        part.leaves.setEnabled(false);
        continue;
      }
      const matrices = new Float32Array(list.length * 16);
      const colors = new Float32Array(list.length * 4);
      const scale = new Vector3();
      const rotation = new Quaternion();
      const position = new Vector3();
      list.forEach((t, i) => {
        // generated trees are scaled to the instance height; yaw turns the tree's x axis onto the billboard's right vector
        const s = t.height / part.height;
        scale.set(s, s, s);
        Quaternion.RotationYawPitchRollToRef(-t.yaw, 0, 0, rotation);
        position.set(t.x, t.y, t.z);
        Matrix.Compose(scale, rotation, position).copyToArray(matrices, i * 16);
        colors.set([t.tint[0], t.tint[1], t.tint[2], 1], i * 4);
      });
      for (const m of [part.wood, part.leaves]) {
        m.setEnabled(true);
        m.thinInstanceSetBuffer('matrix', matrices, 16, true);
        m.thinInstanceSetBuffer('color', colors, 4, true);
      }
    }
  }
}
