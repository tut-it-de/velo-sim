/**
 * Tree studio (dev page, treestudio.html): procedural trees from trees/species.ts in the ride lighting.
 * Query: species=<id> (one species, with seed=<n>), seed=<n> (default 1), wind=0|1 (1: wood and leaves sway in the wind).
 * Without species: every species of the table side by side, three seeds each.
 * mode=atlas: the impostor atlas of all species (colour left, normals right), baked at load time.
 */
import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  ImageProcessingConfiguration,
  Mesh,
  MeshBuilder,
  RenderTargetTexture,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
  VertexData,
} from '@babylonjs/core';
import { SUN_DIR } from '../game/real/env';
import { SPECIES } from '../game/real/trees/species';
import { bakeImpostors } from '../game/real/trees/impostorBake';
import { generateTree, triangleCount } from '../game/real/trees/treeGen';
import type { GeomPart, SpeciesId, SpeciesParams } from '../game/real/trees/types';
import { WindPlugin } from '../game/real/trees/windPlugin';

const q = new URLSearchParams(location.search);
const oneSpecies = q.get('species');
const seed = Number(q.get('seed') ?? 1);
const wind = q.get('wind') === '1';
const atlasMode = q.get('mode') === 'atlas';
const SEEDS = [1, 2, 3];
const SPACING = 34;

const canvas = document.createElement('canvas');
canvas.id = 'c';
document.body.appendChild(canvas);
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.9, 0.91, 0.93, 1);
scene.imageProcessingConfiguration.toneMappingEnabled = true;
scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
scene.imageProcessingConfiguration.exposure = 1.1;

// Lighting as in realWorld.ts: sky hemisphere plus warm sun from SUN_DIR.
const hemi = new HemisphericLight('sky-light', new Vector3(0, 1, 0), scene);
hemi.intensity = 0.7;
hemi.diffuse = new Color3(0.64, 0.76, 1);
hemi.groundColor = new Color3(0.36, 0.3, 0.22);
hemi.specular = Color3.Black();
const sun = new DirectionalLight('sun', SUN_DIR.clone(), scene);
sun.intensity = 1.55;
sun.diffuse = new Color3(1, 0.84, 0.64);
sun.specular = new Color3(1, 0.84, 0.64);
sun.position = SUN_DIR.scale(-120);
const shadows = new ShadowGenerator(2048, sun);
shadows.useBlurExponentialShadowMap = true;
shadows.blurKernel = 8;

const ground = MeshBuilder.CreateGround('ground', { width: 400, height: 400 }, scene);
const groundMat = new StandardMaterial('ground-mat', scene);
groundMat.diffuseColor = new Color3(0.5, 0.5, 0.48);
groundMat.specularColor = Color3.Black();
ground.material = groundMat;
ground.receiveShadows = true;

// Textures are optional: while P3.1 is missing, the species colour alone is shown.
const base = import.meta.env.BASE_URL;
const loadTexture = (name: string, onError: () => void): Texture => {
  // invertY = false: the generator's UVs are in image space (v = 0 is the top row of the atlas)
  const tex = new Texture(`${base}textures/${name}.webp`, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE, undefined, onError);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
};
const materials: { wood: StandardMaterial[]; leaves: StandardMaterial[] } = { wood: [], leaves: [] };
const barkTex = loadTexture('bark', () => materials.wood.forEach((m) => (m.diffuseTexture = null)));
const leafTex = loadTexture('leaves', () => materials.leaves.forEach((m) => (m.diffuseTexture = null)));
// without hasAlpha, Babylon ignores the texture alpha and the cards render as full squares
leafTex.hasAlpha = true;

/** One wood and one leaf material per species, tinted with the species colours from species.ts. */
function speciesMaterials(id: SpeciesId, p: SpeciesParams): { wood: StandardMaterial; leaves: StandardMaterial } {
  const wood = new StandardMaterial(`${id}-wood`, scene);
  wood.specularColor = Color3.Black();
  wood.backFaceCulling = false;
  wood.diffuseColor = new Color3(p.barkColor[0], p.barkColor[1], p.barkColor[2]);
  wood.diffuseTexture = barkTex;
  const leaves = new StandardMaterial(`${id}-leaves`, scene);
  leaves.specularColor = Color3.Black();
  leaves.backFaceCulling = false;
  // no two-sided lighting: the card normals already point out of the crown, flipping them darkens half the cards
  leaves.twoSidedLighting = false;
  leaves.useAlphaFromDiffuseTexture = true;
  leaves.transparencyMode = StandardMaterial.MATERIAL_ALPHATEST;
  leaves.alphaCutOff = 0.4;
  leaves.diffuseColor = new Color3(p.leafColor[0], p.leafColor[1], p.leafColor[2]);
  leaves.diffuseTexture = leafTex;
  if (wind) {
    // trees: amplitude 0.15 m at the tips, the stem foot stays fixed (weight from uv2.x)
    new WindPlugin(wood, { strength: 0.15 });
    new WindPlugin(leaves, { strength: 0.15 });
  }
  materials.wood.push(wood);
  materials.leaves.push(leaves);
  return { wood, leaves };
}

function partMesh(name: string, part: GeomPart, mat: StandardMaterial): Mesh {
  const vd = new VertexData();
  vd.positions = part.positions;
  vd.normals = part.normals;
  vd.uvs = part.uvs;
  vd.indices = part.indices;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh);
  mesh.setVerticesData(VertexBuffer.UV2Kind, part.uvs2, false, 2);
  mesh.setVerticesData(VertexBuffer.ColorKind, part.colors, false, 4);
  mesh.material = mat;
  shadows.addShadowCaster(mesh);
  return mesh;
}

/** Places the species trees (table or one species) and runs the render loop. */
function showTrees(): void {
  const placed: { species: SpeciesId; seed: number; triangles: number; height: number; x: number }[] = [];
  const mats = new Map<SpeciesId, { wood: StandardMaterial; leaves: StandardMaterial }>();

  function place(id: SpeciesId, s: number, x: number, z: number): void {
    const p = SPECIES[id]!;
    if (!mats.has(id)) mats.set(id, speciesMaterials(id, p));
    const m = mats.get(id)!;
    const g = generateTree(p, s);
    const wood = partMesh(`${id}-${s}-wood`, g.wood, m.wood);
    const leaves = partMesh(`${id}-${s}-leaves`, g.leaves, m.leaves);
    for (const mesh of [wood, leaves]) mesh.position.set(x, 0, z);
    placed.push({ species: id, seed: s, triangles: triangleCount(g), height: g.height, x });
  }

  const ids = (Object.keys(SPECIES) as SpeciesId[]).filter((id) => SPECIES[id]);
  if (oneSpecies && SPECIES[oneSpecies as SpeciesId]) {
    place(oneSpecies as SpeciesId, seed, 0, 0);
  } else {
    ids.forEach((id, col) => {
      SEEDS.forEach((s, row) => place(id, s, (col - (ids.length - 1) / 2) * SPACING, (row - 1) * SPACING));
    });
  }

  const info = document.getElementById('info');
  if (info) {
    info.textContent = placed.map((t) => `${t.species} seed ${t.seed}: ${t.triangles} Dreiecke, ${t.height.toFixed(1)} m`).join('\n');
  }
  (window as unknown as { __trees: unknown }).__trees = placed;

  // Camera: one tree is framed by its own height, the whole table by the spread of the grid.
  const tallest = Math.max(...placed.map((t) => t.height));
  const spread = ids.length * SPACING * 0.5 + 10;
  const camera = oneSpecies
    ? new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2.4, tallest * 1.9, new Vector3(0, tallest * 0.45, 0), scene)
    : new ArcRotateCamera('cam', -Math.PI / 2, 1.2, spread * 1.9, new Vector3(0, tallest * 0.4, 0), scene);
  camera.lowerRadiusLimit = 4;
  camera.upperRadiusLimit = 400;
  camera.wheelPrecision = 20;
  camera.attachControl(canvas, true);
  camera.minZ = 0.5;

  engine.runRenderLoop(() => {
    scene.render();
  });
}

/** Atlas view: the impostor atlas of all species, colour and normals side by side. */
async function showAtlas(): Promise<void> {
  ground.setEnabled(false);
  scene.imageProcessingConfiguration.toneMappingEnabled = false;
  // The textures load asynchronously; the bake samples them, so wait (with a timeout for failed loads).
  const started = performance.now();
  while (!(barkTex.isReady() && leafTex.isReady()) && performance.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const ids = (Object.keys(SPECIES) as SpeciesId[]).filter((id) => SPECIES[id]);
  const atlas = await bakeImpostors(scene, ids, [256, 512], { bark: barkTex, leaves: leafTex });
  const size = atlas.color.getSize();


  const PLANE_W = 40;
  const planeH = (PLANE_W * size.height) / size.width;
  const plane = (name: string, tex: RenderTargetTexture, x: number): void => {
    const mesh = MeshBuilder.CreatePlane(name, { width: PLANE_W, height: planeH }, scene);
    mesh.position.set(x, planeH / 2, 0);
    const mat = new StandardMaterial(`${name}-mat`, scene);
    // unlit display: the atlas is the diffuse texture, its alpha is the cut-out
    tex.hasAlpha = true;
    mat.disableLighting = true;
    mat.emissiveColor = Color3.White();
    mat.diffuseTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
    mat.backFaceCulling = false;
    mesh.material = mat;
  };
  plane('atlas-color', atlas.color, -PLANE_W / 2 - 4);
  plane('atlas-normal', atlas.normal, PLANE_W / 2 + 4);

  const info = document.getElementById('info');
  if (info) {
    const lines = [
      `impostor atlas ${size.width}x${size.height}, ${atlas.cells.size} cells, bake ${atlas.bakeMs.toFixed(0)} ms`,
      ...[...atlas.cells.keys()].map((k) => `${k}  aspect ${atlas.aspect.get(k)!.toFixed(2)}`),
    ];
    info.textContent = lines.join('\n');
  }
  (window as unknown as { __atlas: unknown }).__atlas = { bakeMs: atlas.bakeMs, cells: Object.fromEntries(atlas.cells) };

  const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 110, new Vector3(0, planeH / 2, 0), scene);
  camera.lowerRadiusLimit = 10;
  camera.upperRadiusLimit = 400;
  camera.wheelPrecision = 5;
  camera.attachControl(canvas, true);
  camera.minZ = 0.5;
  engine.runRenderLoop(() => scene.render());
}

if (atlasMode) {
  void showAtlas();
} else {
  showTrees();
}
window.addEventListener('resize', () => engine.resize());
