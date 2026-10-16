import { Color3, Matrix, Mesh, Quaternion, StandardMaterial, Vector3, type Scene } from '@babylonjs/core';
import type { HeightField } from './heightField';
import { MeshData } from './meshData';
import { createRng } from '../noise';
import type { Track } from '@velo/routes';
import type { WorldData } from './worldData';

type Rgb = [number, number, number];
type Pt = [number, number];

/** Candidate spots on a 150 m grid over the lake; a spot is valid when it and 8 points 120 m around it are water. */
const SPOT_STEP = 150;
const SPOT_RING = 120;
/** Only spots this close to the route get traffic. */
const ROUTE_RANGE = 4000;
const RNG_SEED = 777;
const BOAT_COUNT = 24;
const BOAT_SPACING = 250;
/** Constant heel of every boat (wind from one side). */
const HEEL = (8 * Math.PI) / 180;
/** Keel sits this far below the water surface. */
const KEEL_DEPTH = 0.3;
/** Ferry route: two valid spots 2–5 km apart, connected by water every 50 m. */
const FERRY_MIN = 2000;
const FERRY_MAX = 5000;
const FERRY_STEP = 50;
const FERRY_SPEED = 7;
const FERRY_PAUSE = 20;
const FERRY_TURN_RATE = 1.2;

const WHITE: Rgb = [0.92, 0.92, 0.9];
const SAIL: Rgb = [0.96, 0.95, 0.9];
const MAST: Rgb = [0.75, 0.75, 0.75];
const FERRY_WHITE: Rgb = [0.95, 0.95, 0.93];
const FERRY_BLUE: Rgb = [0.1, 0.18, 0.35];
const FERRY_DARK: Rgb = [0.08, 0.1, 0.14];

const tmpQ = new Quaternion();
const tmpP = new Vector3();
const tmpM = new Matrix();
const tmpArr = new Float32Array(16);
const UNIT = Vector3.One();

/** Wrap an angle to [-π, π]. */
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function vert(md: MeshData, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Rgb): number {
  return md.vertex(x, y, z, nx, ny, nz, 0, 0, c[0], c[1], c[2]);
}

/** Extruded convex outline (top view, x/z) from y0 to y1: outward side faces and a top cap. */
function prism(md: MeshData, outline: Pt[], y0: number, y1: number, c: Rgb): void {
  const n = outline.length;
  let cx = 0;
  let cz = 0;
  for (const [x, z] of outline) {
    cx += x;
    cz += z;
  }
  cx /= n;
  cz /= n;
  for (let k = 0; k < n; k++) {
    const [ax, az] = outline[k]!;
    const [bx, bz] = outline[(k + 1) % n]!;
    const mx = (ax + bx) / 2 - cx;
    const mz = (az + bz) / 2 - cz;
    const len = Math.hypot(mx, mz) || 1;
    const nx = mx / len;
    const nz = mz / len;
    const a = vert(md, ax, y0, az, nx, 0, nz, c);
    const b = vert(md, bx, y0, bz, nx, 0, nz, c);
    const cc = vert(md, bx, y1, bz, nx, 0, nz, c);
    const d = vert(md, ax, y1, az, nx, 0, nz, c);
    md.quad(a, b, cc, d, nx, 0, nz);
  }
  const center = vert(md, cx, y1, cz, 0, 1, 0, c);
  for (let k = 0; k < n; k++) {
    const [ax, az] = outline[k]!;
    const [bx, bz] = outline[(k + 1) % n]!;
    const p = vert(md, ax, y1, az, 0, 1, 0, c);
    const q = vert(md, bx, y1, bz, 0, 1, 0, c);
    md.tri(center, p, q, 0, 1, 0);
  }
}

/** Closed polygon approximating a circle. */
function ring(cx: number, cz: number, r: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return out;
}

/** Sail: a triangle in the boat's centre plane (x = 0), drawn from both sides. */
function sail(md: MeshData, pts: Array<[number, number, number]>, c: Rgb): void {
  const ids = pts.map(([x, y, z]) => vert(md, x, y, z, 1, 0, 0, c));
  md.idx.push(ids[0]!, ids[1]!, ids[2]!, ids[0]!, ids[2]!, ids[1]!);
}

/** Sailboat, 8 m long, bow towards +z, keel at y = 0. */
function sailboatMesh(scene: Scene): Mesh | null {
  const md = new MeshData(false, true);
  const hull: Pt[] = [
    [0, 4],
    [1.3, 0.5],
    [1.3, -3.2],
    [-1.3, -3.2],
    [-1.3, 0.5],
  ];
  const deck = 0.9;
  prism(md, hull, 0, deck, WHITE);
  prism(md, ring(0, 0.5, 0.12, 6), deck, deck + 11, MAST);
  // mainsail: tack at the mast foot, head at the masthead, clew at the boom end
  sail(
    md,
    [
      [0, 1.4, 0.5],
      [0, deck + 10.5, 0.5],
      [0, 1.4, -3.0],
    ],
    SAIL,
  );
  // jib: from the forestay near the bow to the masthead
  sail(
    md,
    [
      [0, 1.4, 3.2],
      [0, deck + 8.6, 0.6],
      [0, 1.4, -0.3],
    ],
    SAIL,
  );
  const mesh = md.build(scene, 'lake-sailboats', boatMaterial(scene));
  return mesh;
}

function boatMaterial(scene: Scene): StandardMaterial {
  const mat = new StandardMaterial('lake-sailboat-mat', scene);
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  mat.backFaceCulling = false;
  mat.twoSidedLighting = true;
  return mat;
}

/** Ferry, 35 m long, bow towards +z, keel at y = 0: white hull with blue band, two decks and a bridge. */
function ferryMesh(scene: Scene): Mesh | null {
  const md = new MeshData(false, true);
  const hull: Pt[] = [
    [-4, -17.5],
    [4, -17.5],
    [4, 13.5],
    [0, 17.5],
    [-4, 13.5],
  ];
  prism(md, hull, 0, 2.6, FERRY_WHITE);
  // blue stripe at the waterline, just outside the hull
  prism(
    md,
    hull.map(([x, z]): Pt => [x * 1.01, z * 1.01]),
    0.7,
    1.0,
    FERRY_BLUE,
  );
  // main deck and passenger deck
  prism(
    md,
    [
      [-3.6, -15],
      [3.6, -15],
      [3.6, 11],
      [-3.6, 11],
    ],
    2.6,
    4.6,
    FERRY_WHITE,
  );
  // bridge with dark window band on its front
  prism(
    md,
    [
      [-3.2, 5],
      [3.2, 5],
      [3.2, 11],
      [-3.2, 11],
    ],
    4.6,
    6.9,
    FERRY_WHITE,
  );
  prism(
    md,
    [
      [-2.4, 11],
      [2.4, 11],
      [2.4, 11.12],
      [-2.4, 11.12],
    ],
    5.4,
    6.4,
    FERRY_DARK,
  );
  // dark passenger windows along both sides
  for (const s of [1, -1]) {
    const x0 = s > 0 ? 3.6 : -3.66;
    const x1 = s > 0 ? 3.66 : -3.6;
    prism(
      md,
      [
        [x0, -13],
        [x1, -13],
        [x1, 9],
        [x0, 9],
      ],
      3.0,
      3.8,
      FERRY_DARK,
    );
  }
  return md.build(scene, 'lake-ferry', ferryMaterial(scene));
}

function ferryMaterial(scene: Scene): StandardMaterial {
  const mat = new StandardMaterial('lake-ferry-mat', scene);
  mat.specularColor = new Color3(0.05, 0.05, 0.05);
  return mat;
}

/** Within ROUTE_RANGE of any route sample (checked directly: a grid query per spot would be too slow). */
function nearRoute(track: Track, x: number, z: number): boolean {
  const limit = ROUTE_RANGE * ROUTE_RANGE;
  for (let i = 0; i < track.count; i++) {
    const dx = track.xs[i]! - x;
    const dz = track.zs[i]! - z;
    if (dx * dx + dz * dz <= limit) return true;
  }
  return false;
}

/** Candidate spots: water on the lake, within ROUTE_RANGE of the route. */
function lakeSpots(data: WorldData, field: HeightField, track: Track): Pt[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const lakeRing of data.lake) {
    for (const [x, z] of lakeRing) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  const spots: Pt[] = [];
  for (let x = minX; x <= maxX; x += SPOT_STEP) {
    for (let z = minZ; z <= maxZ; z += SPOT_STEP) {
      if (!field.isWater(x, z)) continue;
      let wet = true;
      for (let k = 0; k < 8 && wet; k++) {
        const a = (k / 8) * Math.PI * 2;
        wet = field.isWater(x + SPOT_RING * Math.cos(a), z + SPOT_RING * Math.sin(a));
      }
      if (!wet) continue;
      if (!nearRoute(track, x, z)) continue;
      spots.push([x, z]);
    }
  }
  return spots;
}

/** True when the straight line from a to b lies on water every FERRY_STEP metres. */
function crossingIsWet(field: HeightField, a: Pt, b: Pt, len: number): boolean {
  const steps = Math.ceil(len / FERRY_STEP);
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    if (!field.isWater(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
  }
  return true;
}

/** Appends one instance matrix: heel about the forward axis, then yaw, then translation. */
function pushBoat(out: number[], x: number, y: number, z: number, yaw: number): void {
  Quaternion.RotationYawPitchRollToRef(yaw, 0, HEEL, tmpQ);
  Matrix.ComposeToRef(UNIT, tmpQ, tmpP.set(x, y, z), tmpM);
  tmpM.copyToArray(tmpArr);
  for (let k = 0; k < 16; k++) out.push(tmpArr[k]!);
}

/**
 * Sailing boats on the lake (thin instances, static) and one ferry that shuttles between two shores.
 * Meshes are created once at load time; only the ferry moves, in `update`.
 */
export class LakeTraffic {
  readonly meshes: Mesh[] = [];
  private ferry: Mesh | null = null;
  private clock = 0;
  private yaw = 0;
  private from: Pt = [0, 0];
  private to: Pt = [0, 0];
  private length = 0;
  private trip = 0;
  private period = 0;
  private forward = 0;
  private backward = 0;
  private readonly keelY: number;

  constructor(scene: Scene, data: WorldData, field: HeightField, track: Track) {
    this.keelY = field.waterLevel - KEEL_DEPTH;
    const t0 = performance.now();
    const spots = lakeSpots(data, field, track);

    // Sailing boats: random spots with minimum spacing, at most BOAT_COUNT.
    const rng = createRng(RNG_SEED);
    const shuffled = spots.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const boats: Pt[] = [];
    for (const s of shuffled) {
      if (boats.length >= BOAT_COUNT) break;
      if (boats.every((b) => Math.hypot(b[0] - s[0], b[1] - s[1]) >= BOAT_SPACING)) boats.push(s);
    }
    const boatMatrices: number[] = [];
    for (const [x, z] of boats) pushBoat(boatMatrices, x, this.keelY, z, rng() * Math.PI * 2);
    if (boats.length > 0) {
      const mesh = sailboatMesh(scene);
      if (mesh) {
        mesh.thinInstanceSetBuffer('matrix', new Float32Array(boatMatrices), 16, true);
        mesh.thinInstanceRefreshBoundingInfo();
        this.meshes.push(mesh);
      }
    }

    // Ferry: the longest wet crossing between two spots 2–5 km apart.
    const pairs: Array<{ a: Pt; b: Pt; len: number }> = [];
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const a = spots[i]!;
        const b = spots[j]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len >= FERRY_MIN && len <= FERRY_MAX) pairs.push({ a, b, len });
      }
    }
    pairs.sort((p, q) => q.len - p.len);
    const crossing = pairs.find((p) => crossingIsWet(field, p.a, p.b, p.len)) ?? null;
    if (crossing) {
      this.from = crossing.a;
      this.to = crossing.b;
      this.length = crossing.len;
      this.trip = crossing.len / FERRY_SPEED;
      this.period = 2 * this.trip + 2 * FERRY_PAUSE;
      this.forward = Math.atan2(this.to[0] - this.from[0], this.to[1] - this.from[1]);
      this.backward = this.forward + Math.PI;
      this.yaw = this.forward;
      this.ferry = ferryMesh(scene);
      if (this.ferry) {
        // moves every frame: keep the world matrix live; the bounds do not follow the moving mesh reliably
        // (the ferry vanished at some camera angles), so it is always drawn, as the lake itself is in water.ts
        this.ferry.unfreezeWorldMatrix();
        this.ferry.doNotSyncBoundingInfo = false;
        this.ferry.alwaysSelectAsActiveMesh = true;
        this.meshes.push(this.ferry);
        this.placeFerry(0);
      }
    }

    console.info(
      `[lake] ${boats.length} Segelboote (${spots.length} Plätze, ${Math.round(performance.now() - t0)} ms); ` +
        (this.ferry
          ? `Fähre fährt von (${this.from[0].toFixed(0)}, ${this.from[1].toFixed(0)}) nach (${this.to[0].toFixed(0)}, ${this.to[1].toFixed(0)}), ${Math.round(this.length)} m`
          : 'keine Fähre'),
    );
  }

  /** Ferry position and heading for the current clock; yaw turns smoothly towards the next direction of travel. */
  update(dt: number): void {
    if (!this.ferry) return;
    this.clock = (this.clock + dt) % this.period;
    this.placeFerry(dt);
  }

  private placeFerry(dt: number): void {
    const ferry = this.ferry;
    if (!ferry) return;
    const t = this.clock;
    let s: number;
    let target: number;
    if (t < this.trip) {
      s = FERRY_SPEED * t;
      target = this.forward;
    } else if (t < this.trip + FERRY_PAUSE) {
      s = this.length;
      target = this.backward;
    } else if (t < 2 * this.trip + FERRY_PAUSE) {
      s = this.length - FERRY_SPEED * (t - this.trip - FERRY_PAUSE);
      target = this.backward;
    } else {
      s = 0;
      target = this.forward;
    }
    const k = Math.min(1, Math.max(0, s / this.length));
    const x = this.from[0] + (this.to[0] - this.from[0]) * k;
    const z = this.from[1] + (this.to[1] - this.from[1]) * k;
    // dt = 0 on the first placement: the ferry starts already facing forward
    const turn = dt > 0 ? 1 - Math.exp(-dt * FERRY_TURN_RATE) : 1;
    this.yaw += wrapAngle(target - this.yaw) * turn;
    ferry.position.set(x, this.keelY, z);
    ferry.rotation.y = this.yaw;
  }
}
