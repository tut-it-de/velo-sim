import type { Mesh, Scene } from '@babylonjs/core';
import type { RouteCorridor } from './corridor';
import type { BuildingIndex } from './heightField';
import type { QualityProfile } from './quality';
import type { WorldData } from './worldData';

/**
 * Scenery on open land that the map data does not contain: boulders and scree on alpine meadows,
 * hedges, fences, hay bales and field stripes on farmland, shrubs and single trees on grass, so the
 * country between the road and the forest does not look bare. Placed in a band around the route.
 */
export async function buildLandscapeScatter(
  _scene: Scene,
  _data: WorldData,
  _corridor: RouteCorridor,
  _buildings: BuildingIndex,
  _quality: QualityProfile,
): Promise<Mesh[]> {
  return [];
}
