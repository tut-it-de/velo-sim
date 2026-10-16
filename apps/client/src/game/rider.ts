import {
  Color3,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Scene,
} from '@babylonjs/core';

export interface RiderLook {
  jersey: string;
  frame: string;
  frameAccent?: string;
  frameStyle?: 'aero' | 'allround' | 'climber' | 'endurance';
  rim?: string;
  rimDepthMm?: number;
  helmet?: string;
  jerseyAccent?: string;
  /** One-piece suit: shorts in jersey colour. */
  skinsuit?: boolean;
  skin?: string;
}

const TUBE_SCALE: Record<NonNullable<RiderLook['frameStyle']>, number> = { aero: 1.75, allround: 1.2, climber: 1.0, endurance: 1.1 };

const WHEEL_RADIUS = 0.34;
const CRANK = 0.17;
const THIGH = 0.46;
const SHIN = 0.47;

const UP = new Vector3(0, 1, 0);

function material(scene: Scene, name: string, hex: string, specular = 0.05): StandardMaterial {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.FromHexString(hex);
  m.specularColor = new Color3(specular, specular, specular);
  return m;
}

/** Positions a unit-height cylinder/capsule so it spans from a to b. */
function span(mesh: Mesh, a: Vector3, b: Vector3): void {
  const dir = b.subtract(a);
  const len = dir.length();
  mesh.position.copyFrom(a.add(b).scaleInPlace(0.5));
  mesh.scaling.y = len;
  dir.normalize();
  mesh.rotationQuaternion ??= new Quaternion();
  Quaternion.FromUnitVectorsToRef(UP, dir, mesh.rotationQuaternion);
}

/** Knee position for a 2-bone leg in the bike's y/z plane (knee points forward). */
function solveKnee(hip: Vector3, foot: Vector3): Vector3 {
  const dy = foot.y - hip.y;
  const dz = foot.z - hip.z;
  let d = Math.hypot(dy, dz);
  d = Math.min(THIGH + SHIN - 1e-3, Math.max(0.05, d));
  const uy = dy / d;
  const uz = dz / d;
  const a = Math.acos(Math.min(1, Math.max(-1, (THIGH * THIGH + d * d - SHIN * SHIN) / (2 * THIGH * d))));
  // perpendicular rotated towards +z (forward)
  const py = uz;
  const pz = -uy;
  const ky = hip.y + THIGH * (Math.cos(a) * uy + Math.sin(a) * py);
  const kz = hip.z + THIGH * (Math.cos(a) * uz + Math.sin(a) * pz);
  return new Vector3(hip.x, ky, kz);
}

/**
 * Low-poly cyclist built from primitives. Local frame: +z forward, y up,
 * origin on the ground between the wheels. Legs follow the cranks via IK.
 */
export class RiderAvatar {
  readonly root: TransformNode;
  /** Soft contact shadow under the bike (the only shadow when shadow maps are off). */
  readonly blob: Mesh;
  private crankAngle = Math.random() * Math.PI * 2;
  private wheelAngle = 0;
  private readonly wheels: TransformNode[] = [];
  private readonly crankArms: Mesh[] = [];
  private readonly legs: Array<{ thigh: Mesh; shin: Mesh; foot: Mesh; x: number }> = [];
  private readonly hipY = 0.98;
  private readonly hipZ = -0.27;
  private readonly bb = new Vector3(0, 0.27, -0.08);

  constructor(
    private readonly scene: Scene,
    name: string,
    look: RiderLook,
  ) {
    this.root = new TransformNode(name, scene);
    const jersey = material(scene, `${name}-jersey`, look.jersey);
    const sleeves = material(scene, `${name}-sleeves`, look.jerseyAccent ?? look.jersey);
    const shorts = material(scene, `${name}-shorts`, look.skinsuit ? look.jersey : '#16181c');
    const skin = material(scene, `${name}-skin`, look.skin ?? '#e0ac8a');
    const helmet = material(scene, `${name}-helmet`, look.helmet ?? '#f2f2f2', 0.3);
    const frameMat = material(scene, `${name}-frame`, look.frame, 0.4);
    const accentMat = material(scene, `${name}-frame-accent`, look.frameAccent ?? look.frame, 0.4);
    const tubeScale = TUBE_SCALE[look.frameStyle ?? 'allround'];
    const rimDepth = Math.min(0.08, Math.max(0.018, (look.rimDepthMm ?? 25) / 1000));
    const tire = material(scene, `${name}-tire`, '#141414');
    const rim = material(scene, `${name}-rim`, look.rim ?? '#2a2d33', 0.4);
    const metal = material(scene, `${name}-metal`, '#9aa0a6', 0.5);

    const tube = (n: string, d: number, mat: StandardMaterial) => {
      const m = MeshBuilder.CreateCylinder(n, { height: 1, diameter: d, tessellation: 8 }, scene);
      m.material = mat;
      m.parent = this.root;
      m.isPickable = false;
      return m;
    };

    // Wheels
    for (const z of [-0.5, 0.5]) {
      const node = new TransformNode(`${name}-wheel`, scene);
      node.parent = this.root;
      node.position.set(0, WHEEL_RADIUS, z);
      const t = MeshBuilder.CreateTorus('tire', { diameter: WHEEL_RADIUS * 2 - 0.03, thickness: 0.035, tessellation: 28 }, scene);
      t.rotation.z = Math.PI / 2;
      t.material = tire;
      t.parent = node;
      // Rim as a lathed ring: its radial depth shows the rim height (22 mm alloy … 65 mm deep carbon).
      const outer = WHEEL_RADIUS - 0.03;
      const inner = outer - rimDepth;
      const w = 0.012;
      const r = MeshBuilder.CreateLathe(
        'rim',
        {
          shape: [new Vector3(inner, -w, 0), new Vector3(outer, -w * 1.4, 0), new Vector3(outer, w * 1.4, 0), new Vector3(inner, w, 0), new Vector3(inner, -w, 0)],
          tessellation: 32,
          sideOrientation: Mesh.DOUBLESIDE,
        },
        scene,
      );
      r.rotation.z = Math.PI / 2;
      r.material = rim;
      r.parent = node;
      const spokes: Mesh[] = [];
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const sp = MeshBuilder.CreateCylinder('spoke', { height: inner - 0.03, diameter: 0.004, tessellation: 3 }, scene);
        sp.position.set(0, Math.cos(a) * (inner / 2 + 0.015), Math.sin(a) * (inner / 2 + 0.015));
        sp.rotation.x = a;
        spokes.push(sp);
      }
      const hub = MeshBuilder.CreateCylinder('hub', { height: 0.09, diameter: 0.04, tessellation: 10 }, scene);
      hub.rotation.z = Math.PI / 2;
      spokes.push(hub);
      const spokeMesh = Mesh.MergeMeshes(spokes, true, true)!;
      spokeMesh.material = metal;
      spokeMesh.parent = node;
      this.wheels.push(node);
    }

    // Frame
    const rearAxle = new Vector3(0, WHEEL_RADIUS, -0.5);
    const frontAxle = new Vector3(0, WHEEL_RADIUS, 0.5);
    const seatCluster = new Vector3(0, 0.82, -0.25);
    const headTop = new Vector3(0, look.frameStyle === 'endurance' ? 0.9 : 0.85, 0.36);
    const headBottom = new Vector3(0, 0.68, 0.41);
    span(tube('toptube', 0.04 * tubeScale, frameMat), seatCluster, headTop);
    span(tube('downtube', 0.05 * tubeScale, frameMat), this.bb, headBottom);
    span(tube('seattube', 0.04 * tubeScale, accentMat), this.bb, seatCluster);
    span(tube('headtube', 0.045 * tubeScale, frameMat), headBottom, headTop);
    span(tube('fork', 0.03 * tubeScale, frameMat), headBottom, frontAxle);
    // Aero frames have dropped seat stays.
    const stayTop = look.frameStyle === 'aero' ? seatCluster.add(new Vector3(0, -0.14, 0.02)) : seatCluster.add(new Vector3(0, -0.03, 0));
    for (const x of [-0.055, 0.055]) {
      span(tube('chainstay', 0.025 * tubeScale, frameMat), this.bb.add(new Vector3(x, 0, 0)), rearAxle.add(new Vector3(x, 0, 0)));
      span(tube('seatstay', 0.02 * tubeScale, frameMat), stayTop.add(new Vector3(x, 0, 0)), rearAxle.add(new Vector3(x, 0, 0)));
    }
    span(tube('seatpost', 0.028, metal), seatCluster, new Vector3(0, 0.93, -0.29));
    const saddle = MeshBuilder.CreateBox('saddle', { width: 0.12, height: 0.04, depth: 0.26 }, scene);
    saddle.position.set(0, 0.94, -0.28);
    saddle.material = shorts;
    saddle.parent = this.root;
    span(tube('stem', 0.03, metal), headTop, new Vector3(0, 0.88, 0.45));
    const bar = tube('bar', 0.026, metal);
    span(bar, new Vector3(-0.21, 0.88, 0.45), new Vector3(0.21, 0.88, 0.45));
    for (const x of [-0.21, 0.21]) span(tube('drop', 0.026, metal), new Vector3(x, 0.88, 0.45), new Vector3(x, 0.78, 0.5));

    // Cranks
    for (let i = 0; i < 2; i++) this.crankArms.push(tube('crank', 0.025, metal));

    // Rider body
    const pelvis = new Vector3(0, this.hipY, this.hipZ);
    const shoulders = new Vector3(0, 1.36, 0.17);
    const torso = MeshBuilder.CreateCapsule('torso', { height: 1, radius: 0.15, tessellation: 10 }, scene);
    torso.material = jersey;
    torso.parent = this.root;
    span(torso, pelvis, shoulders);
    torso.scaling.x = 1.25;
    torso.scaling.z = 0.8;
    const head = MeshBuilder.CreateSphere('head', { diameter: 0.21, segments: 10 }, scene);
    head.position.set(0, 1.48, 0.31);
    head.material = skin;
    head.parent = this.root;
    const lid = MeshBuilder.CreateSphere('helmet', { diameter: 0.27, segments: 10, slice: 0.55 }, scene);
    lid.position.set(0, 1.5, 0.29);
    lid.scaling.set(0.95, 0.85, 1.25);
    lid.rotation.x = -0.35;
    lid.material = helmet;
    lid.parent = this.root;
    for (const x of [-0.17, 0.17]) {
      const s = new Vector3(x, 1.34, 0.15);
      const e = new Vector3(x * 1.1, 1.1, 0.33);
      const h = new Vector3(x * 1.2, 0.89, 0.46);
      const upper = MeshBuilder.CreateCapsule('upperarm', { height: 1, radius: 0.045, tessellation: 8 }, scene);
      upper.material = sleeves;
      upper.parent = this.root;
      span(upper, s, e);
      const fore = MeshBuilder.CreateCapsule('forearm', { height: 1, radius: 0.038, tessellation: 8 }, scene);
      fore.material = skin;
      fore.parent = this.root;
      span(fore, e, h);
    }
    for (const x of [-0.1, 0.1]) {
      const thigh = MeshBuilder.CreateCapsule('thigh', { height: 1, radius: 0.065, tessellation: 8 }, scene);
      thigh.material = shorts;
      thigh.parent = this.root;
      const shin = MeshBuilder.CreateCapsule('shin', { height: 1, radius: 0.048, tessellation: 8 }, scene);
      shin.material = skin;
      shin.parent = this.root;
      const foot = MeshBuilder.CreateBox('foot', { width: 0.08, height: 0.06, depth: 0.24 }, scene);
      foot.material = shorts;
      foot.parent = this.root;
      this.legs.push({ thigh, shin, foot, x });
    }

    // Blob shadow
    const shadow = MeshBuilder.CreateDisc('shadow', { radius: 0.6, tessellation: 24 }, scene);
    shadow.rotation.x = Math.PI / 2;
    shadow.scaling.set(0.5, 1.2, 1);
    shadow.position.y = 0.03;
    const sm = new StandardMaterial(`${name}-shadow`, scene);
    sm.diffuseColor = Color3.Black();
    sm.specularColor = Color3.Black();
    sm.alpha = 0.28;
    sm.zOffset = -4;
    shadow.material = sm;
    shadow.parent = this.root;
    this.blob = shadow;

    for (const m of this.root.getChildMeshes()) m.isPickable = false;
    this.updatePose();
  }

  private updatePose(): void {
    for (let i = 0; i < 2; i++) {
      const a = this.crankAngle + i * Math.PI;
      const x = i === 0 ? -0.1 : 0.1;
      const pedal = new Vector3(x, this.bb.y + Math.cos(a) * CRANK, this.bb.z + Math.sin(a) * CRANK);
      span(this.crankArms[i]!, new Vector3(x * 0.7, this.bb.y, this.bb.z), pedal);
      const leg = this.legs[i]!;
      const hip = new Vector3(leg.x, this.hipY, this.hipZ);
      const ankle = pedal.add(new Vector3(0, 0.07, -0.02));
      const knee = solveKnee(hip, ankle);
      span(leg.thigh, hip, knee);
      span(leg.shin, knee, ankle);
      leg.foot.position.set(leg.x, pedal.y + 0.03, pedal.z + 0.03);
    }
  }

  /** Advance animation: cadence in rpm, speed in m/s. */
  animate(dt: number, cadence: number, speedMps: number): void {
    this.crankAngle = (this.crankAngle + (cadence / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    this.wheelAngle = (this.wheelAngle + (speedMps / WHEEL_RADIUS) * dt) % (Math.PI * 2);
    for (const w of this.wheels) w.rotation.x = this.wheelAngle;
    this.updatePose();
  }

  setPose(x: number, y: number, z: number, heading: number, gradePercent: number): void {
    this.root.position.set(x, y + 0.06, z);
    this.root.rotation.set(-Math.atan(gradePercent / 100), heading, 0);
  }

  /** Meshes that cast a real shadow (everything but the blob). */
  get bodyMeshes(): Mesh[] {
    return this.root.getChildMeshes(false).filter((m): m is Mesh => m !== this.blob && m instanceof Mesh);
  }

  dispose(): void {
    this.root.dispose(false, true);
  }

  get scene_(): Scene {
    return this.scene;
  }
}
