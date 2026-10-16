import { Color3, Mesh, MeshBuilder, ShaderMaterial, Vector4, type Scene } from '@babylonjs/core';
import { SKY, TO_SUN } from './env';
import { shaderImageProcessing } from './grading';
import { NOISE_GLSL } from './terrainMaterial';

const glslColor = (hex: string) => {
  const c = Color3.FromHexString(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

const VERTEX = /* glsl */ `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = viewProjection * world * vec4(position, 1.0);
}
`;

/**
 * Sky gradient, sun with glow, a deck of fair-weather cumulus 1.8 km up and high stretched cirrus
 * at 7 km. The view ray is intersected with each layer and fractal noise decides coverage. Layers
 * scroll with the camera position and the wind, so clouds keep their place in the world while
 * slowly drifting. Thin cumulus edges glow towards the sun.
 */
const FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec4 veloSky;    // time, camera x, camera z, cloud cover
uniform vec4 veloSunDir;
#include<helperFunctions>
#include<imageProcessingDeclaration>
#include<imageProcessingFunctions>
${NOISE_GLSL}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * veloNoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3;
    a *= 0.5;
  }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  vec3 sun = veloSunDir.xyz;
  float up = d.y;
  vec3 col = mix(${glslColor(SKY.horizon)}, ${glslColor(SKY.mid)}, smoothstep(0.0, 0.18, up));
  col = mix(col, ${glslColor(SKY.zenith)}, smoothstep(0.15, 0.85, up));
  float mu = max(dot(d, sun), 0.0);
  col += vec3(1.0, 0.92, 0.75) * (pow(mu, 8.0) * 0.18 + pow(mu, 64.0) * 0.25);

  if (up > 0.0) {
    vec2 wind = vec2(4.0, 1.5) * veloSky.x;

    // high cirrus at 7 km, stretched and slanted; mixed first so the cumulus deck sits in front
    vec2 pc = d.xz * (7000.0 / max(up, 0.035));
    vec2 qc = (pc + veloSky.yz * 0.3 + wind * 3.0);
    qc = vec2(qc.x * 0.00011 + qc.y * 0.00004, qc.y * 0.00042 - qc.x * 0.00012);
    float ci = fbm(qc);
    float cir = smoothstep(0.55, 0.85, ci) * 0.35 * smoothstep(0.03, 0.3, up);
    vec3 cirCol = vec3(1.0, 0.98, 0.95) + vec3(1.0, 0.85, 0.6) * pow(mu, 6.0) * 0.5;
    col = mix(col, cirCol, cir);

    vec2 p = d.xz * (1800.0 / max(up, 0.035));
    vec2 q = (p + veloSky.yz + wind) * 0.00045;
    float n = fbm(q);
    float cover = smoothstep(1.0 - veloSky.w, 1.0 - veloSky.w + 0.28, n);
    // self-shadowing: density a little towards the sun
    float n2 = fbm(q + sun.xz * 0.08);
    float shade = clamp(0.62 + (n - n2) * 2.6, 0.45, 1.05);
    // darker base for low clouds near the horizon
    shade *= mix(0.82, 1.0, smoothstep(0.0, 0.25, up));
    vec3 cloud = mix(vec3(0.66, 0.7, 0.77), vec3(1.0, 0.99, 0.96), shade);
    cloud += vec3(1.0, 0.9, 0.7) * pow(mu, 12.0) * 0.35;
    // rim light: thin edges of the cumulus glow towards the sun
    float edge = cover * (1.0 - cover) * 4.0;
    cloud += vec3(1.0, 0.85, 0.6) * edge * pow(mu, 4.0) * 0.9;
    float fade = smoothstep(0.02, 0.22, up);
    col = mix(col, cloud, cover * fade * 0.92);
  }

  // sun disc on top of everything (thin clouds let it through)
  col = mix(col, ${glslColor(SKY.sun)} * 1.4, smoothstep(0.99993, 0.99997, mu));
  // haze band: below the horizon the sky is the fog colour so distant mountains melt into it
  col = mix(${glslColor(SKY.fog)}, col, smoothstep(-0.03, 0.06, up));
  vec4 color = vec4(toLinearSpace(col), 1.0);
#if defined(IMAGEPROCESSING) && !defined(IMAGEPROCESSINGPOSTPROCESS)
  color = applyImageProcessing(color);
#endif
  gl_FragColor = color;
}
`;

export class SkyDome {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly params = new Vector4(0, 0, 0, 0.42);
  private time = 0;

  constructor(scene: Scene, radius: number) {
    this.mesh = MeshBuilder.CreateSphere('sky', { diameter: radius * 2, segments: 20, sideOrientation: Mesh.BACKSIDE }, scene);
    this.mesh.infiniteDistance = true;
    this.mesh.isPickable = false;
    this.mesh.applyFog = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    // the sky goes through the same tone mapping and grading as the lit materials
    const ip = shaderImageProcessing(scene);
    this.material = new ShaderMaterial(
      'sky',
      scene,
      { vertexSource: VERTEX, fragmentSource: FRAGMENT },
      { attributes: ['position'], uniforms: ['world', 'viewProjection', 'veloSky', 'veloSunDir', ...ip.uniforms], defines: ip.defines },
    );
    this.material.onBindObservable.add(() => {
      const effect = this.material.getEffect();
      if (effect) ip.bind(effect);
    });
    this.material.backFaceCulling = false;
    this.material.setVector4('veloSunDir', new Vector4(TO_SUN.x, TO_SUN.y, TO_SUN.z, 0));
    this.material.setVector4('veloSky', this.params);
    this.mesh.material = this.material;
  }

  update(dt: number, cameraX: number, cameraZ: number): void {
    this.time += dt;
    this.params.set(this.time % 7200, cameraX, cameraZ, this.params.w);
    this.material.setVector4('veloSky', this.params);
  }
}
