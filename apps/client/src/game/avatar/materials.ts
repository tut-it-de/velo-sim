import { Color3, DynamicTexture, StandardMaterial, type Scene } from '@babylonjs/core';
import type { JerseyDesign } from '@velo/equipment';
import { JERSEY_TEX, paintJersey } from './jerseyArt';
import { FabricPlugin } from './fabricPlugin';
import { DecalPlugin } from './decalPlugin';
import { FRAME_TEX_H, FRAME_TEX_W, decalFontsReady, paintFrameDecals, type DecalSlot } from './frameArt';

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

const jerseys = new WeakMap<Scene, Map<string, StandardMaterial>>();

/** Cloth material with a printed jersey; one per design and scene, shared by every rider wearing it. */
export function jerseyMaterial(scene: Scene, design: JerseyDesign): StandardMaterial {
  let byKey = jerseys.get(scene);
  if (!byKey) jerseys.set(scene, (byKey = new Map()));
  const key = JSON.stringify(design);
  let m = byKey.get(key);
  if (!m) {
    const tex = new DynamicTexture(`jersey-tex-${byKey.size}`, { width: JERSEY_TEX, height: JERSEY_TEX }, scene, true);
    paintJersey(tex.getContext() as unknown as CanvasRenderingContext2D, design);
    tex.update();
    tex.anisotropicFilteringLevel = 8;
    m = make(scene, `jersey-${byKey.size}`, 0.12, 20);
    new FabricPlugin(m, tex);
    byKey.set(key, m);
  }
  return m;
}

const frames = new WeakMap<Scene, Map<string, StandardMaterial>>();

/** Frame paint with printed decals, one material per distinct set of decals (lacquered or satin). */
export function frameMaterial(scene: Scene, finish: 'gloss' | 'satin', slots: DecalSlot[]): StandardMaterial {
  let byKey = frames.get(scene);
  if (!byKey) frames.set(scene, (byKey = new Map()));
  const key = `${finish}|${JSON.stringify(slots)}`;
  let m = byKey.get(key);
  if (!m) {
    const tex = new DynamicTexture(`frame-tex-${byKey.size}`, { width: FRAME_TEX_W, height: FRAME_TEX_H }, scene, true);
    tex.hasAlpha = true;
    const paint = () => {
      paintFrameDecals(tex.getContext() as unknown as CanvasRenderingContext2D, slots);
      tex.update();
    };
    paint();
    // the wordmark fonts load lazily: repaint once they are there
    void decalFontsReady(slots).then(() => tex.getInternalTexture() && paint());
    tex.anisotropicFilteringLevel = 16;
    m = finish === 'gloss' ? make(scene, `frame-${byKey.size}`, 0.7, 96) : make(scene, `frame-${byKey.size}`, 0.22, 28);
    new DecalPlugin(m, tex);
    byKey.set(key, m);
  }
  return m;
}
