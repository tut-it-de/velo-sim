import { StandardMaterial, type Scene } from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { atmosphere, sweep } from './common';

/** Placeholder world: replaced by the full theme. */
export async function buildLava(scene: Scene, track: Track): Promise<void> {
  atmosphere(scene, { top: '#2a0d0a', horizon: '#6b2414', fog: 0.0004, sunDir: [0.4, -1, 0.3] });
  const road = sweep(scene, 'road', track, [
    { lateral: -5, up: 0.05, u: 0 },
    { lateral: 5, up: 0.05, u: 1 },
  ]);
  const mat = new StandardMaterial('road-mat', scene);
  road.material = mat;
}
