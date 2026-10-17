import { MaterialPluginBase, type BaseTexture, type Material, type MaterialDefines, type UniformBuffer } from '@babylonjs/core';

/**
 * Printed decals over vertex-coloured paint (frameArt.ts): the texture is sampled through the second
 * uv channel and blended over the paint by its alpha; vertices whose uv2 is negative stay plain.
 */
export class DecalPlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private readonly decals: BaseTexture,
  ) {
    super(material, 'VeloDecal', 210, {});
    this._enable(true);
  }

  override isReadyForSubMesh(): boolean {
    return this.decals.isReady();
  }

  override getSamplers(samplers: string[]): void {
    samplers.push('veloDecalMap');
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.setTexture('veloDecalMap', this.decals);
  }

  override getActiveTextures(active: BaseTexture[]): void {
    active.push(this.decals);
  }

  override getClassName(): string {
    return 'VeloDecalPlugin';
  }

  override prepareDefinesBeforeAttributes(defines: MaterialDefines): void {
    (defines as unknown as Record<string, boolean>)['_needUVs'] = true;
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: 'varying vec2 vDecUv;\n',
        CUSTOM_VERTEX_MAIN_END: '#ifdef UV2\nvDecUv = uv2Updated;\n#else\nvDecUv = vec2(-1.0);\n#endif\n',
      };
    }
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: 'varying vec2 vDecUv;\nuniform sampler2D veloDecalMap;\n',
      // after the vertex colour went into baseColor, so the print keeps its own colour
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: /* glsl */ `
if (vDecUv.x >= 0.0) {
  vec4 veloDecal = texture2D(veloDecalMap, vDecUv);
  baseColor.rgb = mix(baseColor.rgb, veloDecal.rgb, veloDecal.a);
}
`,
    };
  }
}
