import type { Scene } from '@babylonjs/core';
import type { FantasyTheme, Track } from '@velo/routes';
import { buildLava } from './lava';
import { buildMeadow } from './meadow';
import { buildRainbow } from './rainbow';
import { buildSnow } from './snow';

const BUILDERS: Record<FantasyTheme, (scene: Scene, track: Track) => Promise<void>> = {
  rainbow: buildRainbow,
  lava: buildLava,
  meadow: buildMeadow,
  snow: buildSnow,
};

/** Builds the whole world of a fantasy circuit (sky, lights, road, scenery). */
export function buildFantasy(scene: Scene, track: Track, theme: FantasyTheme): Promise<void> {
  return BUILDERS[theme](scene, track);
}
