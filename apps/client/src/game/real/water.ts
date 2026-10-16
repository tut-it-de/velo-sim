import {
  Color3,
  Constants,
  MaterialPluginBase,
  MirrorTexture,
  Plane,
  StandardMaterial,
  Texture,
  Vector4,
  type AbstractMesh,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Mesh,
  type Scene,
  type UniformBuffer,
} from '@babylonjs/core';
import { TO_SUN, SKY } from './env';
import { MeshData } from './meshData';
import type { QualityProfile } from './quality';
import { NOISE_GLSL } from './terrainMaterial';
import type { WorldData, WorldGrid } from './worldData';

const glslColor = (hex: string) => {
  const c = Color3.FromHexString(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

/**
 * Wind ripples as a sum of travelling waves (analytic slopes), each faded out once a pixel covers
 * more than a fraction of its wavelength — no shimmering in the distance. Low-frequency noise makes
 * calm and rippled patches ("cat's paws") that drift slowly across the lake.
 */
const BEFORE_FOG = /* glsl */ `
{
  vec3 veloP = vPositionW;
  float veloT = veloParams.x;
  vec3 veloV = normalize(vEyePosition.xyz - veloP);
  float veloDist = distance(vEyePosition.xyz, veloP);
  float veloFoot = length(fwidth(veloP.xz));
  float veloWind = 0.45 + 0.9 * veloNoise(veloP.xz * 0.0035 + vec2(veloT * 0.012, veloT * 0.004));
  vec2 veloSlope = vec2(0.0);
  // direction (x, z), wavelength m, slope amplitude, speed m/s
  vec4 veloW[6];
  veloW[0] = vec4(0.94, 0.34, 11.0, 0.050);
  veloW[1] = vec4(0.71, 0.70, 6.3, 0.055);
  veloW[2] = vec4(0.98, -0.20, 3.7, 0.060);
  veloW[3] = vec4(0.45, 0.89, 2.1, 0.065);
  veloW[4] = vec4(0.85, -0.53, 1.25, 0.070);
  veloW[5] = vec4(0.60, 0.80, 0.72, 0.070);
  for (int i = 0; i < 6; i++) {
    vec4 w = veloW[i];
    float k = 6.2831853 / w.z;
    float fade = 1.0 - smoothstep(0.2 * w.z, 0.55 * w.z, veloFoot);
    if (fade <= 0.0) continue;
    float phase = k * dot(w.xy, veloP.xz) - sqrt(9.81 * k) * veloT + float(i) * 1.7;
    veloSlope += w.xy * (w.w * fade * cos(phase));
  }
  float veloFine = 1.0 - smoothstep(0.08, 0.3, veloFoot);
  if (veloFine > 0.0) {
    vec2 q = veloP.xz * 2.3 + vec2(veloT * 0.35, veloT * 0.2);
    float n0 = veloNoise(q);
    veloSlope += vec2(veloNoise(q + vec2(0.4, 0.0)) - n0, veloNoise(q + vec2(0.0, 0.4)) - n0) * 0.35 * veloFine;
  }
#ifdef VELO_RIPPLES
  // fine ripples from the baked normal map: two scales, drifting in different directions
  float veloMid = smoothstep(0.15, 0.6, veloFoot) * (1.0 - smoothstep(6.0, 25.0, veloFoot));
  if (veloMid > 0.0) {
    vec2 r1 = texture2D(veloRipples, veloP.xz / 9.0 + vec2(veloT * 0.02, veloT * 0.008)).rg;
    vec2 r2 = texture2D(veloRipples, veloP.zx / 23.0 - vec2(veloT * 0.011, veloT * 0.017)).rg;
    veloSlope += (r1 + r2 - 1.0) * 0.12 * veloMid;
  }
#endif
  veloSlope *= veloWind;
  vec3 veloN = normalize(vec3(-veloSlope.x, 1.0, -veloSlope.y));

  float veloCos = clamp(dot(veloN, veloV), 0.0, 1.0);
  float veloF = 0.02 + 0.98 * pow(1.0 - veloCos, 5.0);
  vec3 veloR = reflect(-veloV, veloN);
  veloR.y = abs(veloR.y);

#ifdef VELO_MIRROR
  vec2 veloUv = gl_FragCoord.xy * veloParams.yz + veloN.xz * 0.06 * veloParams.w;
  vec3 veloRefl = texture2D(veloMirror, clamp(veloUv, vec2(0.001), vec2(0.999))).rgb;
#ifdef IMAGEPROCESSINGPOSTPROCESS
  // the HDR pipeline renders the mirror in linear space; this shader mixes in gamma space
  veloRefl = toGammaSpace(veloRefl);
#endif
#else
  float veloEl = clamp(veloR.y, 0.0, 1.0);
  vec3 veloRefl = mix(${glslColor(SKY.fog)}, mix(${glslColor(SKY.mid)}, ${glslColor(SKY.zenith)}, smoothstep(0.25, 0.9, veloEl)), smoothstep(0.0, 0.25, veloEl));
  // far shore: a dark band of mountains reflected near the horizon
  veloRefl = mix(veloRefl, vec3(0.16, 0.2, 0.18), (1.0 - smoothstep(0.0, 0.12, veloEl)) * 0.75);
#endif

  vec3 veloDeep = vec3(0.045, 0.13, 0.15) * (0.85 + 0.3 * veloWind);
  vec3 veloCol = mix(veloDeep, veloRefl, veloF);
  float veloSun = pow(max(dot(veloR, veloSunDir.xyz), 0.0), 600.0) * 5.0 + pow(max(dot(veloR, veloSunDir.xyz), 0.0), 60.0) * 0.12;
  veloCol += ${glslColor(SKY.sun)} * veloSun * (0.4 + 0.6 * veloWind);
#ifdef VELO_RIPPLES
  // sun glints: a random subset of small cells lights up where the reflection hits the sun
  vec2 veloCell = floor(veloP.xz * 1.5) + floor(veloT * 3.0);
  float veloHash = fract(sin(dot(veloCell, vec2(12.9898, 78.233))) * 43758.5453);
  float veloSpark = step(0.97, veloHash) * pow(max(dot(veloR, veloSunDir.xyz), 0.0), 25.0)
    * (1.0 - smoothstep(0.3, 1.5, veloFoot)) * 6.0;
  veloCol += ${glslColor(SKY.sun)} * veloSpark * veloWind;
#endif
  color.rgb = veloCol;
  color.a = 1.0;
}
`;

class WaterPlugin extends MaterialPluginBase {
  readonly params = new Vector4(0, 1, 1, 1);
  private readonly sun = new Vector4(TO_SUN.x, TO_SUN.y, TO_SUN.z, 0);

  constructor(
    material: Material,
    private readonly mirror: MirrorTexture | null,
    private readonly ripples: Texture | null,
  ) {
    super(material, 'VeloWater', 200, { VELO_MIRROR: false, VELO_RIPPLES: false });
    this._enable(true);
  }

  override getClassName(): string {
    return 'VeloWaterPlugin';
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['VELO_MIRROR'] = this.mirror !== null;
    (defines as unknown as Record<string, boolean>)['VELO_RIPPLES'] = this.ripples !== null;
  }

  override getUniforms() {
    return {
      ubo: [
        { name: 'veloParams', size: 4, type: 'vec4' },
        { name: 'veloSunDir', size: 4, type: 'vec4' },
      ],
      fragment: 'uniform vec4 veloParams;\nuniform vec4 veloSunDir;\n',
    };
  }

  override getSamplers(samplers: string[]): void {
    if (this.mirror) samplers.push('veloMirror');
    if (this.ripples) samplers.push('veloRipples');
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    ubo.updateVector4('veloParams', this.params);
    ubo.updateVector4('veloSunDir', this.sun);
    if (this.mirror) ubo.setTexture('veloMirror', this.mirror);
    if (this.ripples) ubo.setTexture('veloRipples', this.ripples);
  }

  override getActiveTextures(active: BaseTexture[]): void {
    if (this.mirror) active.push(this.mirror);
    if (this.ripples) active.push(this.ripples);
  }

  override hasTexture(texture: BaseTexture): boolean {
    return texture === this.mirror || texture === this.ripples;
  }

  override getCustomCode(shaderType: string) {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `${this.mirror ? 'uniform sampler2D veloMirror;\n' : ''}${this.ripples ? 'uniform sampler2D veloRipples;\n' : ''}${NOISE_GLSL}`,
      CUSTOM_FRAGMENT_BEFORE_FOG: BEFORE_FOG,
    };
  }
}

/**
 * Cells of the horizon raster (250 m) where any terrain mesh — near, far or horizon level — dips
 * below the lake level. Only these get a water surface: no huge plane shading invisible pixels
 * underneath the mountains.
 */
function waterMask(data: WorldData): Uint8Array {
  const hz = data.horizon;
  const wl = data.waterLevel + 0.5;
  const mask = new Uint8Array(hz.nx * hz.nz);
  const mark = (x: number, z: number) => {
    const i = Math.floor((x - hz.x0) / hz.step);
    const j = Math.floor((z - hz.z0) / hz.step);
    if (i >= 0 && j >= 0 && i < hz.nx - 1 && j < hz.nz - 1) mask[j * hz.nx + i] = 1;
  };
  const scan = (g: WorldGrid) => {
    const h = g.heights;
    for (let j = 0; j < g.nz - 1; j++) {
      for (let i = 0; i < g.nx - 1; i++) {
        const a = j * g.nx + i;
        if (Math.min(h[a]!, h[a + 1]!, h[a + g.nx]!, h[a + g.nx + 1]!) < wl) mark(g.x0 + (i + 0.5) * g.step, g.z0 + (j + 0.5) * g.step);
      }
    }
  };
  scan(data.near);
  scan(data.far);
  scan(hz);
  // grow by one cell: shore triangles of the finer grids may reach into the neighbour cell
  const out = new Uint8Array(mask.length);
  for (let j = 0; j < hz.nz - 1; j++) {
    for (let i = 0; i < hz.nx - 1; i++) {
      if (!mask[j * hz.nx + i]) continue;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii >= 0 && jj >= 0 && ii < hz.nx - 1 && jj < hz.nz - 1) out[jj * hz.nx + ii] = 1;
        }
      }
    }
  }
  return out;
}

export class LakeWater {
  readonly mesh: Mesh | null;
  readonly material: StandardMaterial;
  readonly mirror: MirrorTexture | null;
  private readonly ripples: Texture | null;
  private readonly plugin: WaterPlugin;
  private time = 0;

  constructor(
    private readonly scene: Scene,
    data: WorldData,
    quality: QualityProfile,
  ) {
    const wl = data.waterLevel;
    const hz = data.horizon;
    const mask = waterMask(data);
    // worlds without a lake (mountain roads): no water mesh and no mirror pass
    const hasWater = mask.some((v) => v !== 0);
    if (hasWater && quality.mirror > 0) {
      // linear HDR colour with the post-process pipeline: half float keeps dark shores free of banding
      const hdr = quality.postProcess && scene.getEngine().getCaps().textureHalfFloatRender;
      const type = hdr ? Constants.TEXTURETYPE_HALF_FLOAT : undefined;
      const mirror = new MirrorTexture('lake-mirror', { ratio: quality.mirror }, scene, false, type, Texture.BILINEAR_SAMPLINGMODE);
      mirror.mirrorPlane = new Plane(0, -1, 0, wl);
      mirror.refreshRate = quality.level === 'hoch' || quality.level === 'ultra' ? 1 : 2;
      mirror.clearColor = Color3.FromHexString(SKY.fog).toColor4(1);
      mirror.wrapU = Texture.CLAMP_ADDRESSMODE;
      mirror.wrapV = Texture.CLAMP_ADDRESSMODE;
      scene.customRenderTargets.push(mirror);
      this.mirror = mirror;
    } else {
      this.mirror = null;
    }

    const mat = new StandardMaterial('lake', scene);
    mat.disableLighting = true;
    mat.specularColor = Color3.Black();
    // Shore terrain that lies within depth-buffer precision of the water wins: a stable shoreline.
    mat.zOffset = 1;
    // ripple normal map (rg = slope, tileable): only with the detail quality, its own texture per lake
    let ripples: Texture | null = null;
    if (hasWater && quality.detail) {
      ripples = new Texture(`${import.meta.env.BASE_URL}textures/ripples.webp`, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      ripples.wrapU = Texture.WRAP_ADDRESSMODE;
      ripples.wrapV = Texture.WRAP_ADDRESSMODE;
      ripples.anisotropicFilteringLevel = 4;
      ripples.name = 'lake-ripples';
    }
    this.ripples = ripples;
    this.plugin = new WaterPlugin(mat, this.mirror, ripples);
    this.material = mat;

    // greedy rectangles over the mask
    const md = new MeshData(false);
    const used = new Uint8Array(mask.length);
    for (let j = 0; j < hz.nz - 1; j++) {
      for (let i = 0; i < hz.nx - 1; i++) {
        if (!mask[j * hz.nx + i] || used[j * hz.nx + i]) continue;
        let i1 = i;
        while (i1 + 1 < hz.nx - 1 && mask[j * hz.nx + i1 + 1] && !used[j * hz.nx + i1 + 1]) i1++;
        let j1 = j;
        grow: while (j1 + 1 < hz.nz - 1) {
          for (let k = i; k <= i1; k++) if (!mask[(j1 + 1) * hz.nx + k] || used[(j1 + 1) * hz.nx + k]) break grow;
          j1++;
        }
        for (let jj = j; jj <= j1; jj++) for (let k = i; k <= i1; k++) used[jj * hz.nx + k] = 1;
        const x0 = hz.x0 + i * hz.step;
        const x1 = hz.x0 + (i1 + 1) * hz.step;
        const z0 = hz.z0 + j * hz.step;
        const z1 = hz.z0 + (j1 + 1) * hz.step;
        const a = md.vertex(x0, wl, z0, 0, 1, 0);
        const b = md.vertex(x1, wl, z0, 0, 1, 0);
        const c = md.vertex(x0, wl, z1, 0, 1, 0);
        const d = md.vertex(x1, wl, z1, 0, 1, 0);
        md.stripQuad(a, b, c, d);
      }
    }
    this.mesh = md.build(scene, 'lake', mat);
    if (this.mesh) {
      this.mesh.receiveShadows = false;
      this.mesh.alwaysSelectAsActiveMesh = true;
    }
  }

  /** Meshes the lake reflects. */
  setReflected(meshes: AbstractMesh[]): void {
    if (this.mirror) this.mirror.renderList = meshes;
  }

  update(dt: number): void {
    this.time += dt;
    const engine = this.scene.getEngine();
    const p = this.plugin.params;
    p.x = this.time % 3600;
    p.y = 1 / engine.getRenderWidth();
    p.z = 1 / engine.getRenderHeight();
  }

  dispose(): void {
    this.mirror?.dispose();
    this.ripples?.dispose();
  }
}
