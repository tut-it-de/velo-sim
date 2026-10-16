import {
  Color3,
  MaterialPluginBase,
  RawTexture,
  StandardMaterial,
  Texture,
  Vector4,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
  type UniformBuffer,
} from '@babylonjs/core';
import type { WorldGrid } from './worldData';
import { SKY } from './env';

/** Cheap value noise for shaders (hash after Dave Hoskins, lattice wrapped every 289 cells). */
export const NOISE_GLSL = /* glsl */ `
float veloHash(vec2 p) {
  p = mod(p, 289.0);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float veloNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(veloHash(i), veloHash(i + vec2(1.0, 0.0)), u.x),
             mix(veloHash(i + vec2(0.0, 1.0)), veloHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const UPDATE_DIFFUSE = /* glsl */ `
{
  vec2 veloUv = ((vPositionW.xz - veloMap.xy) * veloMap.z + 0.5) * veloSize.xy;
  vec4 veloCm = texture2D(veloColorMap, veloUv);
  vec3 veloCol = veloCm.rgb;
  float veloForest = veloCm.a;
  float veloDist = distance(vPositionW, vEyePosition.xyz);
  vec2 veloP = vPositionW.xz;
  float veloUp = normalW.y;
  veloCol *= 0.9 + 0.2 * veloNoise(veloP * 0.017);
#ifdef VELO_DETAIL
  float veloF2 = 1.0 - smoothstep(350.0, 1100.0, veloDist);
  if (veloF2 > 0.0) {
    veloCol *= mix(1.0, 0.85 + 0.3 * veloNoise(veloP * 0.11), veloF2);
    float veloF3 = 1.0 - smoothstep(25.0, 130.0, veloDist);
    if (veloF3 > 0.0) veloCol *= mix(1.0, 0.86 + 0.28 * veloNoise(veloP * 0.73), veloF3);
  }
  float veloFc = veloForest * (1.0 - smoothstep(900.0, 3600.0, veloDist));
  if (veloFc > 0.02) {
    vec2 q = veloP * 0.19;
    float c0 = veloNoise(q) * 0.65 + veloNoise(q * 2.7 + 7.1) * 0.35;
    float cx = veloNoise(q + vec2(0.3, 0.0)) * 0.65 + veloNoise((q + vec2(0.3, 0.0)) * 2.7 + 7.1) * 0.35;
    float cz = veloNoise(q + vec2(0.0, 0.3)) * 0.65 + veloNoise((q + vec2(0.0, 0.3)) * 2.7 + 7.1) * 0.35;
    normalW = normalize(normalW + vec3(c0 - cx, 0.0, c0 - cz) * 2.4 * veloFc);
    veloCol *= mix(1.0, 0.62 + 0.72 * c0, veloFc);
  }
  // close up, the ground under the trees is shaded leaf litter, not meadow (from afar the map reads as canopy)
  float veloLitter = veloForest * (1.0 - smoothstep(40.0, 240.0, veloDist));
  if (veloLitter > 0.01) {
    vec3 veloFloor = vec3(0.2, 0.165, 0.105) * (0.75 + 0.5 * veloNoise(veloP * 0.45));
    veloCol = mix(veloCol, veloFloor, veloLitter * 0.6);
  }
#else
  veloCol *= mix(1.0, 0.92, veloForest);
#endif
  // veloCut: road verges in a cutting (uv2.x from roadRibbon.ts) are rock as well
  float veloRock = max(smoothstep(0.3, 0.55, 1.0 - veloUp) * (1.0 - 0.7 * veloForest), veloCut);
  veloCol = mix(veloCol, vec3(0.47, 0.45, 0.42) * (0.85 + 0.3 * veloNoise(veloP * 0.05)), veloRock);
#ifdef VELO_DETAIL
  // detail maps near the camera: R = brightness (applied as a multiplier around 0.5), A/G = normal X/Y (0.5 neutral)
  float veloDetailFade = 1.0 - smoothstep(60.0, 120.0, veloDist);
  if (veloDetailFade > 0.0) {
    float veloRockW = veloRock * veloDetailFade;
    float veloLitterW = veloForest * (1.0 - smoothstep(40.0, 240.0, veloDist)) * veloDetailFade;
    // rock: triplanar brightness, so steep faces show the layering too
    vec3 veloTw = pow(abs(normalW), vec3(4.0));
    veloTw /= (veloTw.x + veloTw.y + veloTw.z);
    float veloRockR = texture2D(veloRockMap, vPositionW.zy / 3.0).r * veloTw.x
      + texture2D(veloRockMap, vPositionW.xz / 3.0).r * veloTw.y
      + texture2D(veloRockMap, vPositionW.xy / 3.0).r * veloTw.z;
    veloCol *= mix(1.0, 2.0 * veloRockR, veloRockW);
    // leaf litter: planar on the ground
    float veloLeafR = texture2D(veloFloorMap, vPositionW.xz / 3.0).r;
    veloCol *= mix(1.0, 2.0 * veloLeafR, veloLitterW);
    // light normal disturbance from the same maps (planar, strength 0.6)
    vec4 veloRockN = texture2D(veloRockMap, vPositionW.xz / 3.0);
    vec4 veloLeafN = texture2D(veloFloorMap, vPositionW.xz / 3.0);
    normalW = normalize(normalW
      + vec3((veloRockN.a - 0.5) * 2.0, 0.0, (veloRockN.g - 0.5) * 2.0) * 0.6 * veloRockW
      + vec3((veloLeafN.a - 0.5) * 2.0, 0.0, (veloLeafN.g - 0.5) * 2.0) * 0.6 * veloLitterW);
  }
#endif
  veloCol *= 1.0 - 0.32 * (1.0 - smoothstep(veloMap.w - 0.6, veloMap.w + 0.35, vPositionW.y));
  baseColor.rgb = veloCol;
}
`;

/** Haze colour as a GLSL constant. Gamma space on purpose: StandardMaterial mixes the scene fog in gamma space too. */
const SKY_FOG_GLSL = (() => {
  const c = Color3.FromHexString(SKY.fog);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
})();

/**
 * Valley haze before fog: thickens with distance and towards the lake level (fading out 900 m above it), so the
 * far valley sides go pale and warm while peaks and the near meadow stay as they are.
 */
const HAZE_BEFORE_FOG = /* glsl */ `
{
  float veloD = distance(vPositionW, vEyePosition.xyz);
  float veloLow = 1.0 - smoothstep(veloMap.w + 50.0, veloMap.w + 900.0, vPositionW.y);
  float veloHaze = (1.0 - exp(-veloD * 0.00012)) * veloLow * 0.55;
  color.rgb = mix(color.rgb, ${SKY_FOG_GLSL}, veloHaze);
}
`;

/** Detail maps of the terrain (rock layering and forest floor, see tools/texgen). */
interface DetailMaps {
  rock: Texture;
  floor: Texture;
}

const detailMapCache = new WeakMap<Scene, DetailMaps>();

/** Loads the rock and forest-floor detail maps once per scene (tiling, trilinear, anisotropy 8). */
function loadDetailMaps(scene: Scene): DetailMaps {
  const cached = detailMapCache.get(scene);
  if (cached) return cached;
  const load = (name: string): Texture => {
    const tex = new Texture(`${import.meta.env.BASE_URL}textures/${name}.webp`, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8;
    return tex;
  };
  const maps = { rock: load('rock'), floor: load('forestfloor') };
  detailMapCache.set(scene, maps);
  return maps;
}

/**
 * Colours the terrain from a world-space colour map (one texel per grid vertex: land-cover albedo with
 * baked mountain shadows, alpha = forest cover) plus procedural detail, canopy relief and rock on
 * steep slopes. The road verges use the same material so they blend seamlessly into the ground.
 */
export class TerrainPlugin extends MaterialPluginBase {
  private readonly map: Vector4;
  private readonly size: Vector4;
  private readonly detail: boolean;

  constructor(
    material: Material,
    private readonly texture: Texture,
    grid: WorldGrid,
    waterLevel: number,
    private readonly detailMaps: DetailMaps | null,
  ) {
    super(material, 'VeloTerrain', 200, { VELO_DETAIL: false });
    this.detail = detailMaps !== null;
    this.map = new Vector4(grid.x0, grid.z0, 1 / grid.step, waterLevel);
    this.size = new Vector4(1 / grid.nx, 1 / grid.nz, 0, 0);
    this._enable(true);
  }

  override getClassName(): string {
    return 'VeloTerrainPlugin';
  }

  /** uv2 carries the rock weight of the cut verges, so the attribute has to be declared (as in BillboardPlugin). */
  override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['_needUVs'] = true;
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['VELO_DETAIL'] = this.detail;
  }

  override getUniforms() {
    return {
      ubo: [
        { name: 'veloMap', size: 4, type: 'vec4' },
        { name: 'veloSize', size: 4, type: 'vec4' },
      ],
      fragment: 'uniform vec4 veloMap;\nuniform vec4 veloSize;\n',
    };
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('veloColorMap');
    if (this.detail) samplers.push('veloRockMap', 'veloFloorMap');
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    ubo.updateVector4('veloMap', this.map);
    ubo.updateVector4('veloSize', this.size);
    ubo.setTexture('veloColorMap', this.texture);
    if (this.detailMaps) {
      ubo.setTexture('veloRockMap', this.detailMaps.rock);
      ubo.setTexture('veloFloorMap', this.detailMaps.floor);
    }
  }

  override getActiveTextures(active: BaseTexture[]): void {
    active.push(this.texture);
    if (this.detailMaps) active.push(this.detailMaps.rock, this.detailMaps.floor);
  }

  override hasTexture(texture: BaseTexture): boolean {
    return texture === this.texture || (this.detailMaps !== null && (texture === this.detailMaps.rock || texture === this.detailMaps.floor));
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: 'varying float veloCut;\n',
        // meshes without uv2 (the ground) get 0
        CUSTOM_VERTEX_MAIN_END: '#ifdef UV2\nveloCut = uv2Updated.x;\n#else\nveloCut = 0.0;\n#endif\n',
      };
    }
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `varying float veloCut;\nuniform sampler2D veloColorMap;\n#ifdef VELO_DETAIL\nuniform sampler2D veloRockMap;\nuniform sampler2D veloFloorMap;\n#endif\n${NOISE_GLSL}`,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: UPDATE_DIFFUSE,
      CUSTOM_FRAGMENT_BEFORE_FOG: HAZE_BEFORE_FOG,
    };
  }
}

export function createTerrainMaterial(scene: Scene, name: string, grid: WorldGrid, colors: Uint8Array, waterLevel: number, detail: boolean): StandardMaterial {
  const tex = RawTexture.CreateRGBATexture(colors, grid.nx, grid.nz, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 4;
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = new Color3(0.02, 0.02, 0.02);
  mat.specularPower = 8;
  new TerrainPlugin(mat, tex, grid, waterLevel, detail ? loadDetailMaps(scene) : null);
  return mat;
}
