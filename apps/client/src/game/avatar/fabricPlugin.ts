import { MaterialPluginBase, type BaseTexture, type Material, type MaterialDefines, type UniformBuffer } from '@babylonjs/core';

/**
 * Value noise in 3D for the fabric folds and weave (hash after Dave Hoskins, as in terrainMaterial.ts).
 * Kept local so the avatar does not depend on the terrain shaders.
 */
const FABRIC_NOISE = /* glsl */ `
float veloFabHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float veloFabNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  float n0 = mix(mix(veloFabHash(i), veloFabHash(i + vec3(1.0, 0.0, 0.0)), u.x),
                 mix(veloFabHash(i + vec3(0.0, 1.0, 0.0)), veloFabHash(i + vec3(1.0, 1.0, 0.0)), u.x), u.y);
  float n1 = mix(mix(veloFabHash(i + vec3(0.0, 0.0, 1.0)), veloFabHash(i + vec3(1.0, 0.0, 1.0)), u.x),
                 mix(veloFabHash(i + vec3(0.0, 1.0, 1.0)), veloFabHash(i + vec3(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(n0, n1, u.z);
}
`;

/**
 * Surface of the avatar's cloth material: the kind of each vertex comes in the uv channel (1 = Lycra, 0 = skin,
 * written by MeshKit.kind). Lycra gets soft folds, a fine weave and a sheen at grazing angles; skin is left alone.
 * Vertex positions are passed on as the noise space, so the folds move with the rider's limbs.
 */
export class FabricPlugin extends MaterialPluginBase {
  /**
   * `jersey`: optional printed jersey (jerseyArt.ts), sampled through the second uv channel; vertices
   * whose uv2 is negative keep their vertex colour.
   */
  constructor(
    material: Material,
    private readonly jersey: BaseTexture | null = null,
  ) {
    super(material, 'VeloFabric', 200, { VELO_JERSEY: false });
    this._enable(true);
  }

  override prepareDefines(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['VELO_JERSEY'] = !!this.jersey;
  }

  override isReadyForSubMesh(): boolean {
    return !this.jersey || this.jersey.isReady();
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('veloJerseyMap');
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    if (this.jersey) uniformBuffer.setTexture('veloJerseyMap', this.jersey);
  }

  override getActiveTextures(active: BaseTexture[]): void {
    if (this.jersey) active.push(this.jersey);
  }

  override getClassName(): string {
    return 'VeloFabricPlugin';
  }

  /** The uv channel carries the kind, so the attribute has to be declared. */
  override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['_needUVs'] = true;
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: 'varying vec3 vFabP;\nvarying float vFabKind;\n#ifdef VELO_JERSEY\nvarying vec2 vJerUv;\n#endif\n',
        CUSTOM_VERTEX_MAIN_END:
          '#ifdef UV1\nvFabKind = uvUpdated.x;\n#else\nvFabKind = 1.0;\n#endif\nvFabP = positionUpdated;\n' +
          '#ifdef VELO_JERSEY\n#ifdef UV2\nvJerUv = uv2Updated;\n#else\nvJerUv = vec2(-1.0);\n#endif\n#endif\n',
      };
    }
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `varying vec3 vFabP;\nvarying float vFabKind;\n#ifdef VELO_JERSEY\nvarying vec2 vJerUv;\nuniform sampler2D veloJerseyMap;\n#endif\n${FABRIC_NOISE}`,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: /* glsl */ `
if (vFabKind > 0.5) {
#ifdef VELO_JERSEY
  if (vJerUv.x >= 0.0) diffuseColor *= texture2D(veloJerseyMap, vJerUv).rgb;
#endif
  // soft folds, stretched across the body
  float veloFold = veloFabNoise(vec3(vFabP.x * 18.0, vFabP.y * 55.0, vFabP.z * 18.0));
  diffuseColor *= 0.9 + 0.16 * veloFold;
  // fine weave (about 7 mm cells: finer would shimmer, a pixel covers ~3 mm at the chase camera)
  diffuseColor *= 0.97 + 0.06 * veloFabNoise(vFabP * 150.0);
} else {
  // skin: slight colour unevenness, no folds or weave
  diffuseColor *= 0.96 + 0.08 * veloFabNoise(vFabP * 60.0);
}
`,
      CUSTOM_FRAGMENT_BEFORE_FOG: /* glsl */ `
if (vFabKind > 0.5) {
  // sheen at grazing angles, so dark tights get a slight lycra gleam
  float veloRim = pow(1.0 - abs(dot(normalW, viewDirectionW)), 4.0);
  color.rgb += vec3(0.55, 0.58, 0.65) * veloRim * 0.18 * clamp(dot(diffuseBase, vec3(0.333)), 0.0, 1.0);
} else {
  // skin: light passes through, so the shaded side turns warm instead of grey
  float veloLit = clamp(dot(diffuseBase, vec3(0.333)), 0.0, 1.0);
  color.rgb += diffuseColor * vec3(0.16, 0.05, 0.03) * (1.0 - veloLit);
  // warm rim light against the sun
  float veloSkinRim = pow(1.0 - abs(dot(normalW, viewDirectionW)), 3.0);
  color.rgb += vec3(1.0, 0.55, 0.4) * veloSkinRim * 0.08 * veloLit;
}
`,
    };
  }
}
