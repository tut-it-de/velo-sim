import {
  Camera,
  Color4,
  FreeCamera,
  Mesh,
  RenderTargetTexture,
  Scene,
  ShaderMaterial,
  Texture,
  VertexData,
  Vector3,
  Viewport,
  type AbstractEngine,
} from '@babylonjs/core';
import { SPECIES } from './species';
import { generateTree } from './treeGen';
import type { GeomPart, SpeciesId } from './types';

/** Texture rectangle of one impostor cell, in UV space (v = 0 is the bottom row, as in the render target). */
export interface ImpostorUv {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Colour (albedo, alpha = leaf coverage) and normal (view space, n * 0.5 + 0.5, alpha = coverage) atlases. */
export interface ImpostorAtlas {
  color: RenderTargetTexture;
  normal: RenderTargetTexture;
  /** Key `${species}:${variant}`. */
  cells: Map<string, ImpostorUv>;
  /** Width / height of the tree inside its cell, for the billboard quad. Key as in `cells`. */
  aspect: Map<string, number>;
  /** Time the bake took in milliseconds (budget 400 ms). */
  bakeMs: number;
}

/** Layer no main camera sees, so the baked trees stay out of the ride scene. */
const BAKE_LAYER = 0x10000000;
/** Cells per row of the atlas. */
const COLUMNS = 16;
/** Seed variants per species; variant v uses seed v + 1. */
const VARIANTS = 3;
/** Transparent border in pixels around each tree, so mip levels do not bleed. */
const PAD = 4;
/** Alpha cut of the leaf cards, same as in the studio materials. */
const ALPHA_CUT = 0.4;
/** Extra room around the bounding box, in percent. */
const MARGIN = 1.02;

const COLOR_VS = /* glsl */ `
attribute vec3 position;
attribute vec2 uv;
attribute vec4 color;
uniform mat4 world;
uniform mat4 viewProjection;
varying vec2 vUv;
varying vec4 vColor;
void main(void) {
  gl_Position = viewProjection * world * vec4(position, 1.0);
  vUv = uv;
  vColor = color;
}
`;

// Unlit albedo times tint times vertex colour. Leaves are cut at ALPHA_CUT; covered pixels get alpha 1 on a
// (0, 0, 0, 0) background, so every mip level is premultiplied and the billboard recovers the colour as rgb / a.
const COLOR_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec4 vColor;
uniform sampler2D tex;
uniform vec3 tint;
uniform float alphaCut;
void main(void) {
  vec4 c = texture2D(tex, vUv);
  if (c.a < alphaCut) discard;
  gl_FragColor = vec4(c.rgb * tint * vColor.rgb, 1.0);
}
`;

const NORMAL_VS = /* glsl */ `
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
varying vec2 vUv;
varying vec3 vN;
void main(void) {
  gl_Position = viewProjection * world * vec4(position, 1.0);
  vUv = uv;
  // view space, so the normal is stored relative to the bake camera
  vN = (view * (world * vec4(normal, 0.0))).xyz;
}
`;

const NORMAL_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vN;
uniform sampler2D tex;
uniform float alphaCut;
void main(void) {
  if (alphaCut > 0.0 && texture2D(tex, vUv).a < alphaCut) discard;
  vec3 n = normalize(vN);
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

/** Waits until the material can draw the mesh (parallel shader compilation). */
async function untilReady(material: ShaderMaterial, mesh: Mesh): Promise<void> {
  const started = performance.now();
  while (!material.isReady(mesh)) {
    if (performance.now() - started > 5000) throw new Error(`impostor shader ${material.name} did not compile`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function partMesh(name: string, part: GeomPart, scene: Scene): Mesh {
  const vd = new VertexData();
  vd.positions = part.positions;
  vd.normals = part.normals;
  vd.uvs = part.uvs;
  vd.colors = part.colors;
  vd.indices = part.indices;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh);
  mesh.layerMask = BAKE_LAYER;
  mesh.isPickable = false;
  return mesh;
}

/**
 * Bakes one impostor per species and seed variant (3 each) at load time. Each tree is rendered from the side
 * with an orthographic camera into its cell of the atlas: colour (unlit, texture × tint) and view-space normals.
 * The render targets are filled once and not re-rendered; they are not in `scene.customRenderTargets`.
 *
 * `cell` is the nominal cell size in pixels, e.g. [256, 512]. A tree is scaled to fit its cell, keeping its
 * proportions, and sits bottom-aligned in the cell; `aspect` gives its width / height.
 * The textures must be loaded before the call (`bark` and `leaves` with invertY = false, `leaves.hasAlpha = true`).
 * Async because the shaders compile in parallel: a render is skipped until its material is ready.
 */
export async function bakeImpostors(
  scene: Scene,
  species: SpeciesId[],
  cell: [number, number],
  textures: { bark: Texture; leaves: Texture },
): Promise<ImpostorAtlas> {
  const t0 = performance.now();
  const engine: AbstractEngine = scene.getEngine();
  const [cw, ch] = cell;

  const jobs: { key: string; id: SpeciesId; variant: number }[] = [];
  for (const id of species) for (let v = 0; v < VARIANTS; v++) jobs.push({ key: `${id}:${v}`, id, variant: v });

  const width = COLUMNS * cw;
  const height = nextPow2(Math.ceil(jobs.length / COLUMNS) * ch);

  const color = new RenderTargetTexture('impostor-color', { width, height }, scene, false, true);
  const normal = new RenderTargetTexture('impostor-normal', { width, height }, scene, false, true);

  // Each render clears only its own cell (scissor); the first render clears the whole target.
  let clearRect = { x: 0, y: 0, w: width, h: height };
  const clearWith = (value: Color4) => (eng: AbstractEngine) => {
    eng.enableScissor(clearRect.x, clearRect.y, clearRect.w, clearRect.h);
    eng.clear(value, true, true, true);
    eng.disableScissor();
  };
  color.onClearObservable.add(clearWith(new Color4(0, 0, 0, 0)));
  normal.onClearObservable.add(clearWith(new Color4(0.5, 0.5, 0.5, 0)));

  const camera = new FreeCamera('impostor-bake-cam', new Vector3(0, 0, -1000), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.layerMask = BAKE_LAYER;
  camera.minZ = 1;
  camera.maxZ = 4000;

  const cells = new Map<string, { u0: number; v0: number; u1: number; v1: number }>();
  const aspect = new Map<string, number>();

  // Materials per species (tint from the table), shared normal materials.
  const shared: ShaderMaterial[] = [];
  const makeColor = (name: string, tex: Texture, tint: [number, number, number], cut: number): ShaderMaterial => {
    const m = new ShaderMaterial(name, scene, { vertexSource: COLOR_VS, fragmentSource: COLOR_FS }, {
      attributes: ['position', 'uv', 'color'],
      uniforms: ['world', 'viewProjection', 'tint', 'alphaCut'],
      samplers: ['tex'],
    });
    m.setTexture('tex', tex);
    m.setVector3('tint', new Vector3(tint[0], tint[1], tint[2]));
    m.setFloat('alphaCut', cut);
    m.backFaceCulling = false;
    shared.push(m);
    return m;
  };
  const makeNormal = (name: string, tex: Texture, cut: number): ShaderMaterial => {
    const m = new ShaderMaterial(name, scene, { vertexSource: NORMAL_VS, fragmentSource: NORMAL_FS }, {
      attributes: ['position', 'normal', 'uv'],
      uniforms: ['world', 'view', 'viewProjection', 'alphaCut'],
      samplers: ['tex'],
    });
    m.setTexture('tex', tex);
    m.setFloat('alphaCut', cut);
    m.backFaceCulling = false;
    shared.push(m);
    return m;
  };
  const normalWood = makeNormal('impostor-normal-wood', textures.bark, 0);
  const normalLeaves = makeNormal('impostor-normal-leaves', textures.leaves, ALPHA_CUT);

  // Clear the whole target once (no meshes in this render).
  color.renderList = [];
  normal.renderList = [];
  color.activeCamera = camera;
  normal.activeCamera = camera;
  color.render();
  normal.render();

  const speciesMats = new Map<SpeciesId, { wood: ShaderMaterial; leaves: ShaderMaterial }>();
  for (const id of species) {
    const p = SPECIES[id];
    if (!p) continue;
    speciesMats.set(id, {
      wood: makeColor(`impostor-color-${id}-wood`, textures.bark, p.barkColor, 0),
      leaves: makeColor(`impostor-color-${id}-leaves`, textures.leaves, p.leafColor, ALPHA_CUT),
    });
  }

  for (let index = 0; index < jobs.length; index++) {
    const job = jobs[index]!;
    const p = SPECIES[job.id];
    const mats = speciesMats.get(job.id);
    if (!p || !mats) continue;

    const g = generateTree(p, job.variant + 1);
    const worldW = 2 * g.radius * MARGIN;
    const worldH = g.height * MARGIN;
    // Scale into the cell; the bounding box is the billboard.
    const s = Math.min((cw - 2 * PAD) / worldW, (ch - 2 * PAD) / worldH);
    const vw = Math.max(1, Math.floor(worldW * s));
    const vh = Math.max(1, Math.floor(worldH * s));

    const col = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const cellX = col * cw;
    const cellTop = row * ch;
    const px = cellX + Math.floor((cw - vw) / 2);
    const pyTop = cellTop + ch - PAD - vh; // bottom-aligned, image rows from the top
    const pyBottom = height - (pyTop + vh); // GL rows from the bottom

    clearRect = { x: cellX, y: height - (cellTop + ch), w: cw, h: ch };

    camera.orthoLeft = -worldW / 2;
    camera.orthoRight = worldW / 2;
    camera.orthoBottom = -worldH / 2;
    camera.orthoTop = worldH / 2;
    camera.position.set(0, g.height / 2, -1000);
    camera.setTarget(new Vector3(0, g.height / 2, 0));
    camera.viewport = new Viewport(px / width, pyBottom / height, vw / width, vh / height);

    const wood = partMesh(`impostor-${job.key}-wood`, g.wood, scene);
    const leaves = partMesh(`impostor-${job.key}-leaves`, g.leaves, scene);

    // Colour pass
    wood.material = mats.wood;
    leaves.material = mats.leaves;
    await untilReady(mats.wood, wood);
    await untilReady(mats.leaves, leaves);
    color.renderList = [wood, leaves];
    color.activeCamera = camera;
    color.render();

    // Normal pass, same meshes
    wood.material = normalWood;
    leaves.material = normalLeaves;
    await untilReady(normalWood, wood);
    await untilReady(normalLeaves, leaves);
    normal.renderList = [wood, leaves];
    normal.activeCamera = camera;
    normal.render();

    wood.dispose();
    leaves.dispose();

    cells.set(job.key, {
      u0: px / width,
      v0: pyBottom / height,
      u1: (px + vw) / width,
      v1: (pyBottom + vh) / height,
    });
    aspect.set(job.key, worldW / worldH);
  }

  color.renderList = [];
  normal.renderList = [];
  color.activeCamera = null;
  normal.activeCamera = null;

  // Mip levels once, after all cells are in place.
  engine.generateMipMapsFramebuffer(color.renderTarget!);
  engine.generateMipMapsFramebuffer(normal.renderTarget!);

  for (const m of shared) m.dispose();
  camera.dispose();

  return { color, normal, cells, aspect, bakeMs: performance.now() - t0 };
}
