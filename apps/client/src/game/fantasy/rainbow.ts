import {
  Color3,
  Color4,
  Constants,
  GlowLayer,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Sprite,
  SpriteManager,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
  VertexData,
  type Scene,
} from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { at, atmosphere, every, frames, rng, sweep, type ProfilePoint } from './common';

/** Half the road width, m. */
const HALF = 4.8;
/** The arch: semicircle radius and the height of its straight legs, m. */
const ARCH_R = HALF + 1.2;
const ARCH_LEG = 1.0;
/** Where the arches span the road, m: every km, one of them on the summit of the Sternenrampe. */
const ARCH_AT = [500, 1500, 2550, 3500, 4500, 5500, 6500, 7500];

/** A thin-instance placement: world position and heading (yaw). */
interface Spot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

function paint(mesh: Mesh, color: Color3): Mesh {
  const count = mesh.getTotalVertices();
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b, 1], i * 4);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}

/** Merges parts into one mesh; the caller assigns the material. */
function merged(name: string, parts: Mesh[]): Mesh {
  const m = Mesh.MergeMeshes(parts, true, true, undefined, false, false)!;
  m.name = name;
  m.isPickable = false;
  return m;
}

/** Draws one template mesh at every spot (one draw call). */
function instanced(template: Mesh, spots: Spot[], mat: StandardMaterial): Mesh {
  const buf = new Float32Array(spots.length * 16);
  const m = new Matrix();
  const q = new Quaternion();
  const one = Vector3.One();
  spots.forEach((s, i) => {
    Quaternion.RotationYawPitchRollToRef(s.yaw, 0, 0, q);
    Matrix.ComposeToRef(one, q, new Vector3(s.x, s.y, s.z), m);
    m.copyToArray(buf, i * 16);
  });
  template.material = mat;
  template.thinInstanceSetBuffer('matrix', buf, 16, true);
  template.isPickable = false;
  template.alwaysSelectAsActiveMesh = true;
  template.freezeWorldMatrix();
  return template;
}

/** Unlit glowing material: vertex colours show at full brightness (same trick as the sky dome). */
function unlit(name: string, scene: Scene, hex: string, k = 1): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = Color3.FromHexString(hex).scale(k);
  mat.backFaceCulling = false;
  return mat;
}

/** 5-point star in the plane across the road (XY), 0.4 m thick along the travel direction. */
function starTemplate(scene: Scene): Mesh {
  const pos: number[] = [0, 0, 0];
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 1.4 : 3.2;
    const a = Math.PI / 2 + (k * Math.PI) / 5;
    pos.push(r * Math.cos(a), r * Math.sin(a), 0);
  }
  // Back face: same outline pushed 0.4 m along z
  const front = pos.slice();
  for (let i = 0; i < front.length; i += 3) pos.push(front[i]!, front[i + 1]!, 0.4);
  const idx: number[] = [];
  for (let k = 0; k < 10; k++) {
    const a = 1 + k;
    const b = 1 + ((k + 1) % 10);
    idx.push(0, a, b); // front fan (star is star-shaped around its centre)
    idx.push(11, 11 + b, 11 + a); // back fan
    idx.push(a, b, 11 + b, a, 11 + b, 11 + a); // side walls
  }
  const vd = new VertexData();
  vd.positions = new Float32Array(pos);
  vd.indices = new Uint32Array(idx);
  const m = new Mesh('star', scene);
  vd.applyToMesh(m, false);
  return m;
}

/** Full ring across the road (diameter 8 m). */
function ringTemplate(scene: Scene): Mesh {
  const m = MeshBuilder.CreateTorus('ring', { diameter: 8, thickness: 0.5, tessellation: 40 }, scene);
  m.rotation.x = Math.PI / 2;
  m.bakeCurrentTransformIntoVertices();
  return m;
}

/** A flat glowing band over the road: straight legs on both rims and a semicircle on top. */
function archTemplate(scene: Scene): Mesh {
  const path: Vector3[] = [new Vector3(ARCH_R, -0.5, 0)];
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * Math.PI;
    path.push(new Vector3(ARCH_R * Math.cos(a), ARCH_LEG + ARCH_R * Math.sin(a), 0));
  }
  path.push(new Vector3(-ARCH_R, -0.5, 0));
  // a flat band (wide along the road, thin across): an elongated cross-section swept along the arc
  const shape: Vector3[] = [];
  for (let k = 0; k <= 16; k++) {
    const t = (k / 16) * Math.PI * 2;
    shape.push(new Vector3(0.5 * Math.cos(t), 0.85 * Math.sin(t), 0));
  }
  return MeshBuilder.ExtrudeShape('arch', { shape, path, cap: Mesh.CAP_ALL, closeShape: true }, scene);
}

/** Thousands of tiny points on a sphere that follows the camera (infinite distance). */
function starfield(scene: Scene): Mesh {
  const n = 7000;
  const radius = 6000;
  const rand = rng(4242);
  const tints = [
    [1, 1, 1],
    [0.8, 0.9, 1],
    [0.7, 0.8, 1],
    [1, 0.95, 0.85],
  ];
  const pos = new Float32Array(n * 12);
  const col = new Float32Array(n * 16);
  const idx = new Uint32Array(n * 6);
  const uv = new Float32Array(n * 8);
  for (let s = 0; s < n; s++) {
    const cosP = rand() * 2 - 1;
    const sinP = Math.sqrt(1 - cosP * cosP);
    const phi = rand() * Math.PI * 2;
    const dir = new Vector3(sinP * Math.cos(phi), cosP, sinP * Math.sin(phi));
    // Tangent basis so each quad faces the centre
    const u = Vector3.Cross(dir, Math.abs(cosP) > 0.9 ? Vector3.Right() : Vector3.Up()).normalize();
    const v = Vector3.Cross(dir, u);
    const size = 8 + rand() * rand() * 34;
    const c = dir.scale(radius);
    const us = u.scale(size);
    const vs = v.scale(size);
    const corners = [c.subtract(us).subtract(vs), c.add(us).subtract(vs), c.add(us).add(vs), c.subtract(us).add(vs)];
    const tint = tints[Math.floor(rand() * tints.length)]!;
    const b = 0.45 + 0.55 * rand() * rand();
    corners.forEach((p, k) => {
      pos.set([p.x, p.y, p.z], (s * 4 + k) * 3);
      col.set([tint[0]! * b, tint[1]! * b, tint[2]! * b, 1], (s * 4 + k) * 4);
    });
    idx.set([s * 4, s * 4 + 1, s * 4 + 2, s * 4, s * 4 + 2, s * 4 + 3], s * 6);
    uv.set([0, 0, 1, 0, 1, 1, 0, 1], s * 8);
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  vd.colors = col;
  vd.uvs = uv;
  const mesh = new Mesh('starfield', scene);
  vd.applyToMesh(mesh, false);
  const mat = new StandardMaterial('starfield-mat', scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = Color3.White();
  // round twinkling stars: the flare billboard texture, added onto the sky
  const flare = new Texture(flareTexture(), scene);
  mat.emissiveTexture = flare;
  mat.opacityTexture = flare; // the shape lives in the alpha channel
  mat.alpha = 0.999;
  mat.alphaMode = Constants.ALPHA_ADD;
  mat.disableDepthWrite = true;
  mat.fogEnabled = false;
  mat.backFaceCulling = false;
  mesh.material = mat;
  mesh.infiniteDistance = true;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  return mesh;
}

/** Big planets far away; the lilac one hangs over the summit arch of the Sternenrampe (seen when riding up to it). */
function planets(scene: Scene, track: Track, cx: number, cy: number, cz: number): void {
  const look = track.sample(ARCH_AT[2]! + 40);
  const defs = [
    { az: look.heading + 0.64, el: 0.31, dist: 3000, r: 400, color: '#c9a2dc', from: look },
    { az: look.heading + Math.PI - 0.4, el: 0.18, dist: 4600, r: 900, color: '#a8e6ff', ring: true, from: look },
    { az: look.heading - 1.9, el: 0.36, dist: 3600, r: 320, color: '#ffe9a0', from: look },
  ];
  for (const d of defs) {
    const o = d.from ?? { x: cx, y: cy, z: cz };
    const x = o.x + d.dist * Math.cos(d.el) * Math.sin(d.az);
    const y = o.y + d.dist * Math.sin(d.el);
    const z = o.z + d.dist * Math.cos(d.el) * Math.cos(d.az);
    const base = Color3.FromHexString(d.color);
    const mat = new StandardMaterial(`planet-${d.color}`, scene);
    mat.diffuseColor = base.scale(0.55);
    mat.emissiveColor = base.scale(0.45);
    mat.specularColor = Color3.Black();
    mat.fogEnabled = false;
    const sphere = MeshBuilder.CreateSphere('planet', { diameter: d.r * 2, segments: 32 }, scene);
    sphere.position.set(x, y, z);
    sphere.material = mat;
    sphere.isPickable = false;
    sphere.freezeWorldMatrix();
    if (d.ring) {
      const ringMat = unlit('planet-ring-mat', scene, d.color, 0.75);
      ringMat.fogEnabled = false;
      const ring = MeshBuilder.CreateTorus('planet-ring', { diameter: d.r * 4.2, thickness: d.r * 0.16, tessellation: 96 }, scene);
      ring.position.set(x, y, z);
      ring.rotation.set(1.1, 0, 0.3);
      ring.material = ringMat;
      ring.isPickable = false;
      ring.freezeWorldMatrix();
    }
  }
}

/** Lateral colour stops of the road, left rim (0) to right rim (1): pastel neon bands as in the concept art. */
const BANDS: Array<[number, string]> = [
  [0.0, '#fde6fd'],
  [0.025, '#e85ef4'],
  [0.06, '#e059f4'],
  [0.1, '#f486ed'],
  [0.14, '#fa80c3'],
  [0.18, '#f98eb3'],
  [0.23, '#fb9fa6'],
  [0.27, '#fb9c80'],
  [0.315, '#f98c52'],
  [0.358, '#fbb460'],
  [0.4, '#fce27b'],
  [0.443, '#fdf29a'],
  [0.486, '#ecf573'],
  [0.528, '#7cf088'],
  [0.571, '#51df9e'],
  [0.613, '#4adef0'],
  [0.656, '#43b4f7'],
  [0.7, '#4aa6f8'],
  [0.741, '#3a85f8'],
  [0.784, '#6a85fa'],
  [0.826, '#7653f2'],
  [0.869, '#944af6'],
  [0.912, '#ca5efa'],
  [0.954, '#e25cfa'],
  [0.985, '#f08afb'],
  [1.0, '#fde6fd'],
];
/** Columns across the road: fine enough for glitter specks (≈ 0.2 m). */
const ROAD_COLS = 65;

function bandColor(u: number): Color3 {
  for (let k = 1; k < BANDS.length; k++) {
    const [u1, c1] = BANDS[k]!;
    if (u <= u1) {
      const [u0, c0] = BANDS[k - 1]!;
      return Color3.Lerp(Color3.FromHexString(c0), Color3.FromHexString(c1), (u - u0) / (u1 - u0));
    }
  }
  return Color3.FromHexString(BANDS[BANDS.length - 1]![1]);
}

/** Unlit, additive material: vertex colours add light (black = invisible), for glows and halos. */
function additive(name: string, scene: Scene, k = 1): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = new Color3(k, k, k);
  mat.alpha = 0.999;
  mat.alphaMode = Constants.ALPHA_ADD;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  return mat;
}

/** Glittering pastel rainbow ribbon with glowing rims and a soft halo spilling over both edges. */
function road(scene: Scene, track: Track): Mesh[] {
  const bands = Array.from({ length: ROAD_COLS }, (_, c) => bandColor(c / (ROAD_COLS - 1)));
  const profile: ProfilePoint[] = bands.map((_, c) => ({ lateral: -HALF + (2 * HALF * c) / (ROAD_COLS - 1), up: 0.05, u: c / (ROAD_COLS - 1) }));
  const rand = rng(31337);
  const white = Color3.White();
  const ribbon = sweep(scene, 'road', track, profile, {
    everyM: 2,
    vRepeatM: 20,
    color: (c) => {
      // glitter: a few specks flash towards white, the rest shimmer slightly
      const r = rand();
      const base = bands[c]!;
      const s = r < 0.04 ? Color3.Lerp(base, white, 0.25 + 0.3 * rand()) : base.scale(0.94 + 0.08 * rand());
      return new Color4(s.r, s.g, s.b, 1);
    },
  });
  const mat = new StandardMaterial('road-mat', scene);
  // unlit: the emissive term is multiplied by the vertex colour, so each band shows its own colour
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = new Color3(1, 1, 1);
  mat.backFaceCulling = false;
  ribbon.material = mat;
  // Gentle brightness pulse so the road feels alive
  scene.onBeforeRenderObservable.add(() => {
    const k = 0.97 + 0.03 * Math.sin(performance.now() / 700);
    mat.emissiveColor.copyFromFloats(k, k, k);
  });

  // Dark violet underside and side walls so the road has thickness in space
  const underProfile: ProfilePoint[] = [
    { lateral: -HALF, up: 0.05, u: 0 },
    { lateral: -HALF, up: -0.45, u: 0.33 },
    { lateral: HALF, up: -0.45, u: 0.66 },
    { lateral: HALF, up: 0.05, u: 1 },
  ];
  const under = sweep(scene, 'road-under', track, underProfile, { everyM: 4, vRepeatM: 20 });
  under.material = unlit('road-under-mat', scene, '#3a1a6a', 1);

  // Glowing white-pink rims (low kerbs) on both edges
  const rim = (side: number): ProfilePoint[] => [
    { lateral: side * (HALF - 0.05), up: 0.05, u: 0 },
    { lateral: side * (HALF - 0.05), up: 0.16, u: 0.33 },
    { lateral: side * (HALF + 0.22), up: 0.16, u: 0.66 },
    { lateral: side * (HALF + 0.22), up: 0, u: 1 },
  ];
  const rims = merged('rims', [sweep(scene, 'rim-l', track, rim(-1), { everyM: 2 }), sweep(scene, 'rim-r', track, rim(1), { everyM: 2 })]);
  rims.material = unlit('rim-mat', scene, '#fff0ff', 1);
  rims.freezeWorldMatrix();

  // Halo: additive strips fading out from each rim, across the road edge and out into space
  const pink = Color3.FromHexString('#f070ff');
  const haloCols = [-1.6, -0.6, 0, 0.5, 1.4, 3.2];
  const haloK = [0, 0.35, 0.85, 0.5, 0.18, 0];
  const halos = [-1, 1].map((side) => {
    const prof: ProfilePoint[] = haloCols.map((o, k) => ({ lateral: side * (HALF + 0.1 + o), up: 0.25 + 0.5 * k / haloCols.length, u: k / (haloCols.length - 1) }));
    const ord = side < 0 ? prof.slice().reverse() : prof;
    const ks = side < 0 ? haloK.slice().reverse() : haloK;
    return sweep(scene, `halo-${side}`, track, ord, {
      everyM: 4,
      color: (c) => {
        const s = pink.scale(ks[c]!);
        return new Color4(s.r, s.g, s.b, 1);
      },
    });
  });
  const halo = merged('halo', halos);
  halo.material = additive('halo-mat', scene, 0.45);
  halo.freezeWorldMatrix();
  return [rims];
}

/** Thin lilac lamp posts with glowing cyan bulbs lining both rims from each arch over the summit beyond it. */
function posts(scene: Scene, track: Track): Mesh[] {
  const pole = paint(MeshBuilder.CreateCylinder('post', { diameter: 0.14, height: 2.2, tessellation: 6 }, scene), Color3.FromHexString('#c9b4ff'));
  pole.position.y = 1.1;
  const template = merged('post', [pole]);
  const bulb = MeshBuilder.CreateSphere('bulb', { diameter: 0.55, segments: 6 }, scene);
  bulb.position.y = 2.35;
  bulb.bakeCurrentTransformIntoVertices();
  const spots: Spot[] = [];
  for (const arch of ARCH_AT)
    for (let d = arch; d < arch + 180; d += 10) {
      const s = track.sample(d % track.length);
      for (const side of [-1, 1]) {
        const lat = side * (ARCH_R + 0.3);
        spots.push({ x: s.x + Math.cos(s.heading) * lat, y: s.y, z: s.z - Math.sin(s.heading) * lat, yaw: s.heading });
      }
    }
  instanced(template, spots, unlit('post-mat', scene, '#ffffff', 0.85));
  return [instanced(bulb, spots, unlit('bulb-mat', scene, '#c8fbff'))];
}

/** A billboard texture: soft round glow with a four-pointed star flare. */
function flareTexture(): string {
  const n = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const g = cv.getContext('2d')!;
  const h = n / 2;
  const glow = g.createRadialGradient(h, h, 0, h, h, h);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.12, 'rgba(255,255,255,0.75)');
  glow.addColorStop(0.35, 'rgba(255,255,255,0.12)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, n, n);
  for (const [w, l] of [
    [3, h],
    [1.6, h * 0.55],
  ] as const) {
    const a = l === h ? 0 : Math.PI / 4;
    g.save();
    g.translate(h, h);
    g.rotate(a);
    for (const r of [0, Math.PI / 2]) {
      g.rotate(r);
      const ray = g.createLinearGradient(-l, 0, l, 0);
      ray.addColorStop(0, 'rgba(255,255,255,0)');
      ray.addColorStop(0.5, 'rgba(255,255,255,1)');
      ray.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = ray;
      g.beginPath();
      g.moveTo(-l, 0);
      g.lineTo(0, -w);
      g.lineTo(l, 0);
      g.lineTo(0, w);
      g.fill();
    }
    g.restore();
  }
  return cv.toDataURL();
}

/** Sparkle flares on the road and glittering star dust drifting beside it (additive billboards). */
function sparkles(scene: Scene, track: Track): void {
  const rand = rng(8128);
  const road = Math.round(track.length * 1.6);
  const dust = Math.round(track.length * 1.4);
  const mgr = new SpriteManager('sparkles', flareTexture(), road + dust, 128, scene);
  mgr.blendMode = Constants.ALPHA_ADD;
  mgr.isPickable = false;
  mgr.disableDepthWrite = true;
  const tints = ['#ffffff', '#fff3d6', '#ffd6fb', '#d6f6ff'].map((c) => Color3.FromHexString(c));
  const dustTints = ['#ffb3f5', '#c9a6ff', '#ffe0a8', '#a6e4ff', '#ffffff'].map((c) => Color3.FromHexString(c));
  const fs = frames(track, 2);
  const place = (lateral: number, up: number, size: number, tint: Color3, k: number) => {
    const f = fs[Math.floor(rand() * (fs.length - 1))]!;
    const p = at(f, lateral, up);
    const s = new Sprite('spark', mgr);
    s.position.copyFrom(p);
    s.size = size;
    s.color = new Color4(tint.r * k, tint.g * k, tint.b * k, 1);
  };
  for (let i = 0; i < road; i++) {
    const big = rand() < 0.12;
    place((rand() * 2 - 1) * HALF * 0.96, 0.08 + rand() * 0.4, big ? 0.9 + rand() * 1.1 : 0.12 + rand() * 0.3, tints[Math.floor(rand() * tints.length)]!, big ? 1 : 0.8);
  }
  for (let i = 0; i < dust; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const out = Math.pow(rand(), 1.8) * 22;
    const big = rand() < 0.04;
    place(side * (HALF + 0.6 + out), -4 + rand() * 7 - out * 0.3, big ? 0.8 + rand() * 0.8 : 0.1 + rand() * 0.25, dustTints[Math.floor(rand() * dustTints.length)]!, 0.55 + 0.45 * rand());
  }
}

/** Floating stars and rings beside the road every 150 m, and an arch across it every km. */
function decor(scene: Scene, track: Track): Mesh[] {
  const rand = rng(977);
  const stars: Spot[] = [];
  const rings: Spot[][] = [[], [], []];
  every(track, 150, (f, i) => {
    // keep the view through the arches clear: no props in the 150 m before one
    if (ARCH_AT.some((a) => a - f.d > 0 && a - f.d < 150)) return;
    const side = i % 2 ? 1 : -1;
    const p = at(f, side * (24 + rand() * 18), 6 + rand() * 18);
    const spot: Spot = { x: p.x, y: p.y, z: p.z, yaw: Math.atan2(f.fx, f.fz) };
    if (i % 3 === 1) rings[Math.floor(i / 3) % 3]!.push(spot);
    else stars.push(spot);
  });
  const glowing = [instanced(starTemplate(scene), stars, unlit('star-mat', scene, '#ffd84a'))];
  const ringColors = ['#ff5ccf', '#5cf2ff', '#ffe23b'];
  rings.forEach((spots, k) => {
    if (spots.length) glowing.push(instanced(ringTemplate(scene), spots, unlit(`ring-mat-${k}`, scene, ringColors[k]!)));
  });

  const arches: Spot[] = ARCH_AT.map((d) => {
    const s = track.sample(d);
    return { x: s.x, y: s.y, z: s.z, yaw: s.heading };
  });
  // translucent lavender band; it stays out of the glow layer so it keeps its colour
  const archMat = unlit('arch-mat', scene, '#a77ce8', 0.95);
  archMat.alpha = 0.8;
  instanced(archTemplate(scene), arches, archMat);
  return glowing;
}

export async function buildRainbow(scene: Scene, track: Track): Promise<void> {
  atmosphere(scene, { top: '#020112', horizon: '#1f0e42', fog: 0.00012, sunDir: [0.3, -1, 0.4], sun: '#e8e4ff', sunIntensity: 0.6, hemi: 0.55, ground: '#2a1f55' });
  starfield(scene);
  const cx = (track.bounds.minX + track.bounds.maxX) / 2;
  const cz = (track.bounds.minZ + track.bounds.maxZ) / 2;
  const cy = (track.minElevation + track.maxElevation) / 2;
  planets(scene, track, cx, cy, cz);
  const glowing = [...road(scene, track), ...posts(scene, track), ...decor(scene, track)];
  sparkles(scene, track);
  // Soft bloom around everything that shines (rims, bulbs, arches, stars and rings)
  const glow = new GlowLayer('glow', scene, { mainTextureRatio: 0.5, blurKernelSize: 64 });
  glow.intensity = 0.6;
  for (const m of glowing) glow.addIncludedOnlyMesh(m);
}
