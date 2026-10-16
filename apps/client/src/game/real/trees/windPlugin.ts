import { MaterialPluginBase, type Material, type MaterialDefines, type Scene, type UniformBuffer, Vector4 } from '@babylonjs/core';

/** Shared wind clock per scene: every wind material of the scene reads the same time value. */
const windClocks = new WeakMap<Scene, { time: number }>();

function clockOf(scene: Scene): { time: number } {
  let clock = windClocks.get(scene);
  if (!clock) {
    clock = { time: 0 };
    windClocks.set(scene, clock);
  }
  return clock;
}

export interface WindOptions {
  /** Billboards and grass: the weight comes from the texture v coordinate instead of uv2. */
  card?: boolean;
  /**
   * Cards only: where the weight comes from. 'uv' (default): 1 − v, for cards whose texture spans v = 0 (top)
   * … 1 (foot), like grass. 'colorAlpha': vertex colour alpha (0 at the foot, 1 at the top) with the phase from
   * uv2 (the foot position), for atlas billboards whose cell covers only part of v.
   */
  weight?: 'uv' | 'colorAlpha';
  /** Amplitude in metres at the tips (weight 1). */
  strength?: number;
  /** Horizontal wind direction (x, z); normalised internally. */
  direction?: [number, number];
}

/** Hash for the per-card phase of billboards and grass (no uv2 there). */
const WIND_DEFINITIONS = /* glsl */ `
float veloWindHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/**
 * Moves the vertices of trees, billboards and grass in the wind. The weight `w` is 0 at the stem foot and 1 at
 * the branch tips, so the foot stays fixed. The offset is added in world space (after the thin-instance matrix).
 * Shadows are not moved on purpose: the depth pass does not use this plugin.
 */
const WIND_WORLDPOS = /* glsl */ `
#ifdef VELO_WIND
{
  float veloW = 0.0;
  float veloPh = 0.0;
#ifdef VELO_WIND_CARD
  #ifdef VELO_WIND_COLOR_W
    #ifdef VERTEXCOLOR
  veloW = colorUpdated.a;
    #endif
    #ifdef UV2
  veloPh = veloWindHash(uv2Updated) * 6.2831853;
    #endif
  #else
    #ifdef UV1
  veloW = 1.0 - uvUpdated.y;
    #endif
  veloPh = veloWindHash(positionUpdated.xz) * 6.2831853;
  #endif
#else
  #ifdef UV2
  veloW = uv2Updated.x;
  veloPh = uv2Updated.y;
  #endif
#endif
  float veloT = veloWind.w;
  float veloOff = veloWind.z * veloW * veloW
    * (0.6 * sin(veloT * 1.3 + veloPh) + 0.25 * sin(veloT * 3.1 + veloPh * 2.3));
  worldPos.x += veloWind.x * veloOff;
  worldPos.z += veloWind.y * veloOff;
  if (veloW > 0.6) {
    worldPos.y += 0.02 * sin(veloT * 7.0 + dot(positionUpdated, vec3(3.1)));
  }
}
#endif
`;

/**
 * Vertex-shader wind for StandardMaterial. Uniform `veloWind` = (dir x, dir z, strength, time).
 * Create one per material (wood and leaves separately), then call `WindPlugin.update(scene, dt)` once per frame.
 */
export class WindPlugin extends MaterialPluginBase {
  private readonly card: boolean;
  private readonly colorWeight: boolean;
  private readonly params: Vector4;
  private readonly clock: { time: number };

  constructor(material: Material, options: WindOptions = {}) {
    const card = options.card ?? false;
    const colorWeight = card && options.weight === 'colorAlpha';
    super(material, 'VeloWind', 210, { VELO_WIND: true, VELO_WIND_CARD: card, VELO_WIND_COLOR_W: colorWeight });
    this.card = card;
    this.colorWeight = colorWeight;
    const [dx, dz] = options.direction ?? [1, 0.35];
    const len = Math.hypot(dx, dz) || 1;
    this.params = new Vector4(dx / len, dz / len, options.strength ?? 0.15, 0);
    this.clock = clockOf(material.getScene());
    this._enable(true);
  }

  /** Advances the wind clock of a scene by `dt` seconds. */
  static update(scene: Scene, dt: number): void {
    clockOf(scene).time += dt;
  }

  override getClassName(): string {
    return 'VeloWindPlugin';
  }

  /** The UV set is needed for the weight (uv2 for trees, uv for cards), so the attribute gets declared. */
  override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['_needUVs'] = true;
  }

  override prepareDefines(defines: MaterialDefines): void {
    const d = defines as unknown as Record<string, boolean>;
    d['VELO_WIND'] = true;
    d['VELO_WIND_CARD'] = this.card;
    d['VELO_WIND_COLOR_W'] = this.colorWeight;
  }

  override getUniforms() {
    return {
      ubo: [{ name: 'veloWind', size: 4, type: 'vec4' }],
      vertex: 'uniform vec4 veloWind;\n',
    };
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    this.params.w = this.clock.time;
    ubo.updateVector4('veloWind', this.params);
  }

  override getCustomCode(shaderType: string) {
    if (shaderType !== 'vertex') return null;
    return {
      CUSTOM_VERTEX_DEFINITIONS: `#ifdef VELO_WIND\n${WIND_DEFINITIONS}#endif\n`,
      CUSTOM_VERTEX_UPDATE_WORLDPOS: WIND_WORLDPOS,
    };
  }
}
