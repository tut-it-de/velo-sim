import { StandardMaterial, type Scene } from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { atmosphere, sweep } from './common';

/** Placeholder world: replaced by the full theme. */
export async function buildMeadow(scene: Scene, track: Track): Promise<void> {
  atmosphere(scene, { top: '#3f8ae0', horizon: '#d6ecff', fog: 0.0004, sunDir: [0.4, -1, 0.3] });
  const road = sweep(scene, 'road', track, [
    { lateral: -5, up: 0.05, u: 0 },
    { lateral: 5, up: 0.05, u: 1 },
  ]);
  const mat = new StandardMaterial('road-mat', scene);
  road.material = mat;
}
