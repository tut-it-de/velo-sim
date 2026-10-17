import { Color3, StandardMaterial, type Scene } from '@babylonjs/core';
import { FabricPlugin } from './fabricPlugin';

export interface AvatarMaterials {
  /** Lacquered paint, helmet shell, lenses. */
  gloss: StandardMaterial;
  /** Carbon, rubber, saddle, tyres. */
  satin: StandardMaterial;
  /** Chain, cassette, rotors. */
  metal: StandardMaterial;
  /** Lycra and skin. */
  cloth: StandardMaterial;
}

const cache = new WeakMap<Scene, AvatarMaterials>();

function make(scene: Scene, name: string, spec: number, power: number): StandardMaterial {
  const m = new StandardMaterial(`avatar-${name}`, scene);
  m.diffuseColor = Color3.White();
  m.specularColor = new Color3(spec, spec, spec);
  m.specularPower = power;
  return m;
}

/** Vertex-coloured materials shared by every avatar in a scene, so riders joining later need no new shaders. */
export function avatarMaterials(scene: Scene): AvatarMaterials {
  let m = cache.get(scene);
  if (!m) {
    m = {
      gloss: make(scene, 'gloss', 0.7, 96),
      satin: make(scene, 'satin', 0.22, 28),
      metal: make(scene, 'metal', 0.85, 48),
      cloth: make(scene, 'cloth', 0.12, 20),
    };
    new FabricPlugin(m.cloth);
    cache.set(scene, m);
  }
  return m;
}
