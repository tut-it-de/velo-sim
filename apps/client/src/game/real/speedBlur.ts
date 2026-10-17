import { Effect, PostProcess, Texture, type Camera } from '@babylonjs/core';

const SHADER = 'veloSpeedBlur';

// Radial blur towards the picture edge: the centre (rider and road ahead) stays sharp, the trees and
// the guard rail at the sides smear along the direction to the centre. Eight taps are enough for a
// soft smear at this strength.
Effect.ShadersStore[`${SHADER}FragmentShader`] = `
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform float aspect;
uniform float strength;
void main(void) {
  vec2 d = vUV - vec2(0.5, 0.58);
  float r = length(d * vec2(aspect, 1.0));
  float w = smoothstep(0.32, 0.85, r) * strength;
  vec3 c = vec3(0.0);
  for (int i = 0; i < 8; i++) c += texture2D(textureSampler, vUV - d * w * float(i) / 7.0).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}
`;

/** Speed in km/h where the blur starts and where it reaches full strength. */
const BLUR_FROM_KMH = 40;
const BLUR_FULL_KMH = 70;
/** Blur reach at full strength (fraction of the blur direction per tap). */
const MAX_STRENGTH = 0.035;

/**
 * Wind blur at the picture edges for fast descents. Only used on 'ultra'. The post-process is attached to
 * the camera while it is needed and detached at low speed, so it costs nothing on the flat.
 */
export class SpeedBlur {
  private readonly camera: Camera;
  private readonly post: PostProcess;
  private strength = 0;
  private attached = false;

  constructor(camera: Camera) {
    this.camera = camera;
    const engine = camera.getEngine();
    this.post = new PostProcess('speed-blur', SHADER, ['aspect', 'strength'], null, 1, camera, Texture.BILINEAR_SAMPLINGMODE, engine, false);
    this.post.onApply = (effect) => {
      const h = engine.getRenderHeight();
      effect.setFloat('aspect', h > 0 ? engine.getRenderWidth() / h : 1);
      effect.setFloat('strength', this.strength);
    };
    // The constructor attaches the post-process; it stays off until the rider is fast enough.
    camera.detachPostProcess(this.post);
  }

  /** Sets the blur from the rider's speed in metres per second. */
  setSpeed(mps: number): void {
    const kmh = mps * 3.6;
    const t = Math.min(1, Math.max(0, (kmh - BLUR_FROM_KMH) / (BLUR_FULL_KMH - BLUR_FROM_KMH)));
    this.strength = t * MAX_STRENGTH;
    if (this.strength > 0 && !this.attached) {
      this.camera.attachPostProcess(this.post);
      this.attached = true;
    } else if (this.strength === 0 && this.attached) {
      this.camera.detachPostProcess(this.post);
      this.attached = false;
    }
  }

  dispose(): void {
    if (this.attached) this.camera.detachPostProcess(this.post);
    this.attached = false;
    this.post.dispose(this.camera);
  }
}
