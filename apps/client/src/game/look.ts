import { resolveLoadout, type Loadout } from '@velo/equipment';
import type { RiderLook } from './rider';

/** Avatar appearance for a set of equipment. */
export function lookFromLoadout(loadout: Loadout): RiderLook {
  const { bike, wheels, jersey } = resolveLoadout(loadout);
  return {
    frame: bike.look.frame,
    frameAccent: bike.look.accent,
    frameStyle: bike.category,
    rim: wheels.look.rim,
    rimDepthMm: wheels.rimDepthMm,
    wheel: wheels.look,
    jersey: jersey.look.jersey,
    jerseyAccent: jersey.look.accent,
    helmet: jersey.look.helmet,
    skinsuit: jersey.cut === 'skinsuit',
    jerseyDesign: jersey.look.design,
  };
}
