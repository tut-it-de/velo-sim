import { resolveLoadout, type Loadout } from '@velo/equipment';
import type { RiderLook } from './rider';

/** Avatar appearance for a set of equipment. */
export function lookFromLoadout(loadout: Loadout): RiderLook {
  const { bike, wheels, jersey, helmet } = resolveLoadout(loadout);
  return {
    frame: bike.look.frame,
    frameAccent: bike.look.accent,
    frameStyle: bike.category,
    build: bike.look.build,
    label: { brand: bike.brand, model: bike.model },
    rim: wheels.look.rim,
    rimDepthMm: wheels.rimDepthMm,
    wheel: wheels.look,
    jersey: jersey.look.jersey,
    jerseyAccent: jersey.look.accent,
    // no helmet bought yet: the starter shape in the jersey's matching colour
    helmet: loadout.helmet ? helmet.look.shell : jersey.look.helmet,
    helmetLook: loadout.helmet ? helmet.look : { ...helmet.look, shell: jersey.look.helmet },
    skinsuit: jersey.cut === 'skinsuit',
    jerseyDesign: jersey.look.design,
  };
}
