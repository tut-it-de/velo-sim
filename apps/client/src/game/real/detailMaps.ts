import { Texture, type Scene, type StandardMaterial } from '@babylonjs/core';

const detailCache = new WeakMap<Scene, Map<string, Texture>>();

/**
 * Detail map from `public/textures/<name>.webp`, loaded once per scene (wrap, trilinear, anisotropy 8).
 * Channels: R = brightness, G = normal Y, B = roughness, A = normal X; 0.5 is neutral.
 * Use `applyDetail` to lay it over a material; it sets its own tiling.
 */
export function loadDetail(scene: Scene, name: string): Texture {
  let byName = detailCache.get(scene);
  if (!byName) detailCache.set(scene, (byName = new Map()));
  let tex = byName.get(name);
  if (!tex) {
    tex = new Texture(`${import.meta.env.BASE_URL}textures/${name}.webp`, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.anisotropicFilteringLevel = 8;
    tex.name = `detail-${name}`;
    byName.set(name, tex);
  }
  return tex;
}

/**
 * Puts a detail map over a standard material. The tiling belongs to the texture, so each material gets its
 * own clone of the shared texture. `tiling` is the number of tiles per UV unit: the material's UV unit in
 * metres divided by the tile size in metres (e.g. a 7.2 m facade unit with 3 m plaster tiles gives 2.4).
 */
export function applyDetail(
  mat: StandardMaterial,
  scene: Scene,
  name: string,
  tiling: [number, number],
  blend: { diffuse: number; bump: number },
): void {
  const tex = loadDetail(scene, name).clone();
  tex.uScale = tiling[0];
  tex.vScale = tiling[1];
  mat.detailMap.texture = tex;
  mat.detailMap.diffuseBlendLevel = blend.diffuse;
  mat.detailMap.bumpLevel = blend.bump;
  mat.detailMap.isEnabled = true;
}
