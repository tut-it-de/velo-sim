import {
  Color3,
  Color4,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  Quaternion,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
  type Scene,
} from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { at, atmosphere, every, rng, sweep, type Frame, type ProfilePoint } from './common';

/** The lava sea lies this far under the lowest point of the road, so the causeway always rises over it. */
const LAVA_DROP = 25;
/** Walls run this far down; the lava plane hides the rest. */
const WALL_DEPTH = 160;
/** Distance of the fortress gate along the lap, m. */
const GATE_D = 150;
/** Braziers every this many metres, alternating sides. */
const BRAZIER_EVERY = 200;

const BASALT = new Color3(0.2, 0.18, 0.18);
const ROOF = new Color3(0.2, 0.07, 0.05);
const TRIM = new Color3(0.28, 0.22, 0.2);
const IRON = new Color3(0.12, 0.08, 0.06);
const PILLAR = new Color3(0.22, 0.19, 0.18);
const ASH = new Color3(0.1, 0.05, 0.04);

/** Fortress around the start and the gate: [distance, lateral, radius, height above road, m]. */
const FORTRESS: [number, number, number, number][] = [
  [25, -38, 9, 52],
  [95, 30, 7, 36],
  [230, -55, 8, 48],
  [290, 42, 6, 32],
  [GATE_D, -12, 5, 30],
  [GATE_D, 12, 5, 30],
];

/** Volcano silhouettes: [angle, distance from the centre, base radius, height] (m). */
const VOLCANOES: [number, number, number, number][] = [
  [0.7, 3100, 1000, 700],
  [2.5, 2600, 650, 420],
  [4.3, 3900, 1150, 780],
];

/** Lava fountains: [distance along the lap, lateral offset] — 60 to 150 m from the road. */
const FOUNTAINS: [number, number][] = [
  [1200, 90],
  [2900, -110],
  [4700, 80],
  [6100, -130],
];

/** Frame at an arbitrary distance on the lap (the sweep frames are too dense for sparse props). */
function frameAt(track: Track, d: number): Frame {
  const k = ((Math.round(d / track.step) % track.count) + track.count) % track.count;
  const h = track.headings[k]!;
  return { x: track.xs[k]!, y: track.ys[k]!, z: track.zs[k]!, fx: Math.sin(h), fz: Math.cos(h), rx: Math.cos(h), rz: -Math.sin(h), d };
}

/** Yaw that turns a box's local x to the rider's right and its local z to the direction of travel. */
function yawOf(f: Frame): number {
  return Math.atan2(f.fx, f.fz);
}

function paint(mesh: Mesh, color: Color3): Mesh {
  const count = mesh.getTotalVertices();
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b, 1], i * 4);
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  return mesh;
}

function mergeParts(name: string, parts: Mesh[], mat: StandardMaterial): Mesh {
  const m = Mesh.MergeMeshes(parts, true, true, undefined, false, false)!;
  m.name = name;
  m.material = mat;
  m.isPickable = false;
  m.freezeWorldMatrix();
  return m;
}

/** Cross-section of one side: a stone skirt down into the lava, then the parapet with its inner face. */
function sideProfile(side: number): ProfilePoint[] {
  const pts: [number, number][] = [
    [5.5, -WALL_DEPTH],
    [5.2, -3],
    [5.2, 0.9],
    [4.65, 0.9],
    [4.65, 0],
    [4.5, 0],
  ];
  return pts.map(([l, up], i) => ({ lateral: side * l, up, u: i / (pts.length - 1) }));
}

/** Grey-brown rectangular paving with staggered joints; tiles every 8 m along the road. */
function roadTexture(scene: Scene): DynamicTexture {
  const S = 512;
  const tex = new DynamicTexture('lava-road-tex', { width: S, height: S }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const rand = rng(91);
  ctx.fillStyle = '#211c18';
  ctx.fillRect(0, 0, S, S);
  const rows = 4;
  const cols = 4;
  const rh = S / rows;
  const cw = S / cols;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * (cw / 2);
    for (let c = -1; c <= cols; c++) {
      const shade = 0.75 + rand() * 0.4;
      ctx.fillStyle = `rgb(${Math.round(92 * shade)},${Math.round(82 * shade)},${Math.round(72 * shade)})`;
      ctx.fillRect(c * cw + off + 4, r * rh + 4, cw - 8, rh - 8);
    }
  }
  for (let i = 0; i < 1500; i++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(20,16,14,0.35)' : 'rgba(170,160,150,0.18)';
    ctx.fillRect(rand() * S, rand() * S, 2, 2);
  }
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.update();
  return tex;
}

/** Molten crust: dark red mottling and bright orange cracks that wrap seamlessly. */
function lavaTexture(scene: Scene): DynamicTexture {
  const S = 1024;
  const tex = new DynamicTexture('lava-tex', { width: S, height: S }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const rand = rng(77);
  const offsets = [-S, 0, S];
  ctx.fillStyle = '#2a0703';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const r = 30 + rand() * 90;
    ctx.fillStyle = rand() < 0.5 ? 'rgba(70,10,2,0.35)' : 'rgba(150,30,4,0.25)';
    for (const dx of offsets)
      for (const dy of offsets) {
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
  }
  // Random-walk cracks; each is drawn at the wrap offsets so the tile has no seams.
  const strokeWalk = (pts: [number, number][], color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    for (const dx of offsets)
      for (const dy of offsets) {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x + dx, y + dy) : ctx.moveTo(x + dx, y + dy)));
        ctx.stroke();
      }
  };
  for (let w = 0; w < 150; w++) {
    let x = rand() * S;
    let y = rand() * S;
    let a = rand() * Math.PI * 2;
    const pts: [number, number][] = [[x, y]];
    const steps = 20 + Math.floor(rand() * 40);
    for (let s = 0; s < steps; s++) {
      a += (rand() - 0.5) * 0.9;
      const len = 6 + rand() * 10;
      x += Math.cos(a) * len;
      y += Math.sin(a) * len;
      pts.push([x, y]);
    }
    strokeWalk(pts, 'rgba(255,90,20,0.35)', 9);
    strokeWalk(pts, 'rgba(255,150,40,0.9)', 3.5);
    strokeWalk(pts, 'rgba(255,230,140,1)', 1.2);
  }
  // Grain so the glow is not a flat gradient.
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 16;
    d[i] = d[i]! + n;
    d[i + 1] = d[i + 1]! + n * 0.5;
    d[i + 2] = d[i + 2]! + n * 0.3;
  }
  ctx.putImageData(img, 0, 0);
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.uScale = 40;
  tex.vScale = 40;
  tex.update();
  return tex;
}

/** Soft round sprite for the lava fountains. */
function puffTexture(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture('lava-puff', { width: 64, height: 64 }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  tex.update();
  return tex;
}

interface Fortress {
  /** Dark stone parts, merged into one mesh. */
  stone: Mesh[];
  /** Glowing window slits, merged into one emissive mesh. */
  glow: Mesh[];
}

/** A round tower standing in the lava, its top `h` metres above the road at distance `d`. */
function addTower(out: Fortress, scene: Scene, track: Track, lavaY: number, d: number, lateral: number, r: number, h: number, spin: number): void {
  const base = at(frameAt(track, d), lateral, 0);
  const top = base.y + h;
  const foot = lavaY - 2; // the tower's foot is buried in the lava and never seen
  const body = paint(MeshBuilder.CreateCylinder('tower', { height: top - foot, diameter: 2 * r, tessellation: 14 }, scene), BASALT);
  body.position.set(base.x, (top + foot) / 2, base.z);
  const ring = paint(MeshBuilder.CreateCylinder('tower-ring', { height: 1.4, diameter: 2 * r + 1.4, tessellation: 14 }, scene), TRIM);
  ring.position.set(base.x, top - 5, base.z);
  const roofH = r * 1.8;
  const roof = paint(MeshBuilder.CreateCylinder('tower-roof', { height: roofH, diameterTop: 0, diameterBottom: 2.5 * r, tessellation: 14 }, scene), ROOF);
  roof.position.set(base.x, top + roofH / 2, base.z);
  out.stone.push(body, ring, roof);
  // Slits in four directions and three rows: boxes whose depth points radially outwards.
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + spin;
    for (let j = 0; j < 3; j++) {
      const y = top - 8 - j * 11;
      if (y < base.y + 4) continue;
      const slit = MeshBuilder.CreateBox('slit', { width: 0.4, height: 2.6, depth: 0.5 }, scene);
      slit.position.set(base.x + Math.cos(a) * (r + 0.05), y, base.z + Math.sin(a) * (r + 0.05));
      slit.rotation.y = Math.PI / 2 - a;
      out.glow.push(slit);
    }
  }
}

/** Volcano body (dark) plus a glowing crater lid, both in fog-free silhouette mode. */
function addVolcano(vol: Mesh[], craters: Mesh[], scene: Scene, lavaY: number, angle: number, dist: number, r: number, h: number): void {
  const x = Math.cos(angle) * dist;
  const z = Math.sin(angle) * dist;
  const base = lavaY - 5;
  const cone = paint(MeshBuilder.CreateCylinder('volcano', { height: h, diameterTop: r * 0.16, diameterBottom: 2 * r, tessellation: 24 }, scene), ASH);
  cone.position.set(x, base + h / 2, z);
  vol.push(cone);
  const crater = MeshBuilder.CreateCylinder('crater', { height: h * 0.06, diameter: r * 0.2, tessellation: 12 }, scene);
  crater.position.set(x, base + h, z);
  craters.push(crater);
}

/** Fortress, gate, braziers and volcanoes around a 7 km lava circuit. */
export async function buildLava(scene: Scene, track: Track): Promise<void> {
  atmosphere(scene, {
    top: '#1a0606',
    horizon: '#5a1a0c',
    fog: 0.0011,
    sunDir: [-0.3, -1, 0.2],
    sun: '#ffb27a',
    sunIntensity: 0.7,
    hemi: 0.6,
    ground: '#ff5a1a',
  });
  const lavaY = track.minElevation - LAVA_DROP;

  // Lava sea: a huge emissive plane whose crust scrolls slowly.
  const lavaTex = lavaTexture(scene);
  const lavaMat = new StandardMaterial('lava-sea-mat', scene);
  lavaMat.diffuseTexture = lavaTex;
  lavaMat.diffuseColor = new Color3(0.3, 0.1, 0.05);
  lavaMat.emissiveTexture = lavaTex;
  lavaMat.emissiveColor = new Color3(1, 0.55, 0.25);
  lavaMat.specularColor = Color3.Black();
  const sea = MeshBuilder.CreateGround('lava-sea', { width: 8000, height: 8000, subdivisions: 64 }, scene);
  sea.position.y = lavaY;
  sea.material = lavaMat;
  sea.isPickable = false;
  sea.freezeWorldMatrix();

  // Causeway: paved deck plus basalt walls and parapets that drop into the lava.
  const roadMat = new StandardMaterial('lava-road-mat', scene);
  roadMat.diffuseTexture = roadTexture(scene);
  roadMat.specularColor = Color3.Black();
  roadMat.emissiveColor = new Color3(0.06, 0.03, 0.02);
  const road = sweep(scene, 'lava-road', track, [
    { lateral: -4.5, up: 0.05, u: 0 },
    { lateral: 4.5, up: 0.05, u: 1 },
  ], { vRepeatM: 8 });
  road.material = roadMat;
  road.isPickable = false;

  const wallMat = new StandardMaterial('lava-wall-mat', scene);
  wallMat.diffuseColor = BASALT;
  wallMat.specularColor = Color3.Black();
  wallMat.backFaceCulling = false;
  const walls = mergeParts(
    'lava-walls',
    [sweep(scene, 'wall-l', track, sideProfile(-1), { vRepeatM: 8 }), sweep(scene, 'wall-r', track, sideProfile(1), { vRepeatM: 8 })],
    wallMat,
  );

  // Merlons: one box, thin-instanced on both parapets. Spacing follows the 2 m sample grid.
  const merlon = MeshBuilder.CreateBox('merlon', { width: 0.5, height: 0.6, depth: 0.8 }, scene);
  merlon.material = wallMat;
  merlon.isPickable = false;
  const merlonRows: { p: Vector3; yaw: number }[] = [];
  every(track, 1.6, (f) => {
    for (const side of [-1, 1]) merlonRows.push({ p: at(f, side * 4.925, 1.2), yaw: yawOf(f) });
  });
  const merlonBuf = new Float32Array(merlonRows.length * 16);
  const m = new Matrix();
  const q = new Quaternion();
  const one = Vector3.One();
  merlonRows.forEach((row, i) => {
    Quaternion.RotationYawPitchRollToRef(row.yaw, 0, 0, q);
    Matrix.ComposeToRef(one, q, row.p, m);
    m.copyToArray(merlonBuf, i * 16);
  });
  merlon.thinInstanceSetBuffer('matrix', merlonBuf, 16, true);
  merlon.freezeWorldMatrix();
  merlon.alwaysSelectAsActiveMesh = true;

  // Fortress: towers, gate lintel, braziers. Everything dark stone goes into one vertex-coloured mesh.
  const fort: Fortress = { stone: [], glow: [] };
  for (const [d, lateral, r, h] of FORTRESS) addTower(fort, scene, track, lavaY, d, lateral, r, h, d * 0.01);
  // Towers every ~800 m, alternating sides, further out than the fortress.
  const far = rng(4242);
  for (let i = 0; i < 8; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const lateral = side * (40 + far() * 80);
    addTower(fort, scene, track, lavaY, 1000 + i * 800, lateral, 7 + far() * 2, 40 + far() * 15, far() * Math.PI);
  }
  // Gate lintel: a bridge across the road at 12 m, between the two gate towers.
  const gf = frameAt(track, GATE_D);
  const lintel = paint(MeshBuilder.CreateBox('lintel', { width: 24, height: 2.6, depth: 2.4 }, scene), BASALT);
  lintel.position.copyFrom(at(gf, 0, 12.3));
  lintel.rotation.y = yawOf(gf);
  fort.stone.push(lintel);

  // Braziers: short stone pillars at the road edge with a bowl on top.
  const flamePos: Vector3[] = [];
  for (let i = 0; i * BRAZIER_EVERY + 50 < track.length; i++) {
    const f = frameAt(track, i * BRAZIER_EVERY + 50);
    const p = at(f, (i % 2 === 0 ? -1 : 1) * 7, 0);
    const top = p.y + 1.2;
    const foot = lavaY - 2;
    const pillar = paint(MeshBuilder.CreateBox('pillar', { width: 1.2, height: top - foot, depth: 1.2 }, scene), PILLAR);
    pillar.position.set(p.x, (top + foot) / 2, p.z);
    const bowl = paint(MeshBuilder.CreateCylinder('bowl', { height: 0.5, diameterTop: 2.2, diameterBottom: 1.6, tessellation: 12 }, scene), IRON);
    bowl.position.set(p.x, top + 0.25, p.z);
    fort.stone.push(pillar, bowl);
    flamePos.push(new Vector3(p.x, top + 1.6, p.z));
  }

  const stoneMat = new StandardMaterial('lava-stone-mat', scene);
  stoneMat.diffuseColor = Color3.White();
  stoneMat.specularColor = Color3.Black();
  stoneMat.emissiveColor = new Color3(0.04, 0.015, 0.01);
  mergeParts('lava-fortress', fort.stone, stoneMat);

  const glowMat = new StandardMaterial('lava-glow-mat', scene);
  glowMat.disableLighting = true;
  glowMat.diffuseColor = Color3.Black();
  glowMat.specularColor = Color3.Black();
  glowMat.emissiveColor = new Color3(1, 0.42, 0.1);
  mergeParts('lava-slits', fort.glow, glowMat);

  // Flames: one emissive cone, thin-instanced per brazier and flickered every frame.
  const flameMat = new StandardMaterial('lava-flame-mat', scene);
  flameMat.disableLighting = true;
  flameMat.diffuseColor = Color3.Black();
  flameMat.specularColor = Color3.Black();
  flameMat.emissiveColor = new Color3(1, 0.6, 0.18);
  const flame = MeshBuilder.CreateCylinder('flame', { height: 2.2, diameterTop: 0, diameterBottom: 1.3, tessellation: 7 }, scene);
  flame.material = flameMat;
  flame.isPickable = false;
  const flameBuf = new Float32Array(flamePos.length * 16);
  flame.thinInstanceSetBuffer('matrix', flameBuf, 16, false);
  flame.alwaysSelectAsActiveMesh = true;

  // Distant volcanoes: fog-free silhouettes with glowing craters.
  const volMat = new StandardMaterial('lava-volcano-mat', scene);
  volMat.diffuseColor = Color3.White();
  volMat.specularColor = Color3.Black();
  volMat.fogEnabled = false;
  const volGlowMat = new StandardMaterial('lava-crater-mat', scene);
  volGlowMat.disableLighting = true;
  volGlowMat.diffuseColor = Color3.Black();
  volGlowMat.specularColor = Color3.Black();
  volGlowMat.emissiveColor = new Color3(1, 0.5, 0.15);
  volGlowMat.fogEnabled = false;
  const vol: Mesh[] = [];
  const craters: Mesh[] = [];
  for (const [angle, dist, r, h] of VOLCANOES) addVolcano(vol, craters, scene, lavaY, angle, dist, r, h);
  mergeParts('lava-volcanoes', vol, volMat);
  mergeParts('lava-craters', craters, volGlowMat);

  // Lava fountains: four particle plumes from the sea beside the causeway.
  const puff = puffTexture(scene);
  for (const [d, lateral] of FOUNTAINS) {
    const p = at(frameAt(track, d), lateral, 0);
    const ps = new ParticleSystem('lava-fountain', 500, scene);
    ps.particleTexture = puff;
    ps.emitter = new Vector3(p.x, lavaY + 0.5, p.z);
    ps.minEmitBox = new Vector3(-3, 0, -3);
    ps.maxEmitBox = new Vector3(3, 0, 3);
    ps.direction1 = new Vector3(-0.35, 1, -0.35);
    ps.direction2 = new Vector3(0.35, 1, 0.35);
    ps.minEmitPower = 16;
    ps.maxEmitPower = 24;
    ps.minLifeTime = 2.2;
    ps.maxLifeTime = 3.4;
    ps.emitRate = 160;
    ps.minSize = 3;
    ps.maxSize = 8;
    ps.gravity = new Vector3(0, -9.8, 0);
    ps.color1 = new Color4(1, 0.8, 0.35, 1);
    ps.color2 = new Color4(1, 0.35, 0.05, 1);
    ps.colorDead = new Color4(0.3, 0.05, 0, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.start();
  }

  // Animation: the lava crust scrolls and the flames flicker out of phase.
  scene.onBeforeRenderObservable.add(() => {
    const t = performance.now() / 1000;
    lavaTex.uOffset = (t * 0.004) % 1;
    lavaTex.vOffset = (t * 0.0025) % 1;
    flamePos.forEach((p, i) => {
      const sy = 0.85 + 0.25 * Math.sin(t * 9 + i * 1.7) + 0.12 * Math.sin(t * 21 + i * 3.1);
      const sxz = 0.95 + 0.1 * Math.sin(t * 13 + i * 2.3);
      Matrix.ComposeToRef(new Vector3(sxz, sy, sxz), Quaternion.Identity(), p, m);
      m.copyToArray(flameBuf, i * 16);
    });
    flame.thinInstanceBufferUpdated('matrix');
  });
}
