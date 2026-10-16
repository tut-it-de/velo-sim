import { Color3, Mesh, Quaternion, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import { BODY, riderPose, solveJoint, type BikePoints, type RiderPose } from './geometry';
import { MeshKit, basis, hex, type Paint } from './meshKit';
import { avatarMaterials } from './materials';

export interface CyclistLook {
  jersey: string;
  jerseyAccent?: string;
  helmet?: string;
  skinsuit?: boolean;
  skin?: string;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const X = v(1, 0, 0);
const Y = v(0, 1, 0);
const Z = v(0, 0, 1);

/** Foot pitch over the pedal stroke (toe down > 0): flat at three o'clock, toes down through the bottom. */
export const footPitch = (crank: number) => 0.2525 - 0.1 * Math.cos(crank) - 0.125 * Math.sin(crank);

interface Leg {
  thigh: TransformNode;
  shin: TransformNode;
  foot: TransformNode;
  side: number;
}

/**
 * Seated road cyclist on the hoods: lofted, muscled limbs, jersey with side panels and pockets,
 * bib shorts, socks and shoes, aero road helmet with vents and wrap-around glasses. Arms, torso and
 * head are one static mesh; each leg segment is a rigid mesh driven by 2-bone IK to the pedals.
 */
export class Cyclist {
  readonly pose: RiderPose;
  private readonly legs: Leg[] = [];

  constructor(
    scene: Scene,
    name: string,
    look: CyclistLook,
    private readonly bike: BikePoints,
    parent: TransformNode,
  ) {
    const mats = avatarMaterials(scene);
    const pose = (this.pose = riderPose(bike));
    const jersey = hex(look.jersey);
    const accent = hex(look.jerseyAccent ?? look.jersey);
    const shorts = look.skinsuit ? jersey : hex('#15161a');
    const skin = hex(look.skin ?? '#d9a383');
    const glove = hex('#1a1a1c');
    const sock = hex('#f1f1f1');
    const shade = (c: Color3, k: number) => new Color3(c.r * k, c.g * k, c.b * k);

    const body = new MeshKit();
    const shell = new MeshKit();

    // --- Torso along the back line, pelvis to neck -----------------------------------------------
    const pelvis = v(0, pose.hip.y + 0.005, pose.hip.z - 0.035);
    const shoulders = v(0, pose.shoulder.y + 0.005, pose.shoulder.z - 0.02);
    const spine = shoulders.subtract(pelvis).normalize();
    const back = v(0, spine.z, -spine.y);
    const along = (t: number, hump: number) => Vector3.Lerp(pelvis, shoulders, t).add(back.scale(hump));
    const torso = [along(-0.08, -0.01), along(0.05, 0.0), along(0.3, 0.012), along(0.55, 0.02), along(0.78, 0.016), along(0.95, 0.0), along(1.04, -0.02), along(1.1, -0.035)];
    const tw = [0.15, 0.165, 0.15, 0.158, 0.175, 0.198, 0.17, 0.09];
    const td = [0.09, 0.105, 0.095, 0.11, 0.118, 0.1, 0.08, 0.06];
    const jerseyPaint: Paint = (t, a) => {
      const flank = Math.abs(Math.cos(a));
      const up = Math.sin(a);
      if (t < 0.1) return shorts;
      if (t < 0.13) return shade(jersey, 0.8);
      if (t > 0.93) return accent;
      if (t > 0.6 && t < 0.66) return accent;
      if (t < 0.3 && up > 0.5) return shade(jersey, Math.abs(Math.cos(a * 3)) < 0.12 || (t > 0.27 && t < 0.29) ? 0.62 : 0.9);
      return jersey;
    };
    body.loft(torso, tw, td, jerseyPaint, { hint: back, seg: 20 });
    // Glutes on the saddle.
    for (const sx of [-1, 1]) body.ellipsoid(v(0.065 * sx, pose.hip.y - 0.025, pose.hip.z - 0.055), v(0.075, 0.07, 0.085), shorts, undefined, 12, 8);

    // --- Neck and head ---------------------------------------------------------------------------
    body.loft([shoulders.add(back.scale(-0.02)), pose.neck, pose.head.add(v(0, -0.06, -0.02))], [0.06, 0.052, 0.05], [0.055, 0.05, 0.048], skin, { seg: 12 });
    const H = pose.head;
    const tilt = Quaternion.RotationAxis(X, 0.12);
    body.ellipsoid(H, v(0.075, 0.095, 0.1), skin, tilt, 16, 12);
    body.ellipsoid(H.add(v(0, -0.052, 0.03)), v(0.056, 0.045, 0.062), skin, undefined, 12, 8);
    body.ellipsoid(H.add(v(0, -0.012, 0.1)), v(0.012, 0.022, 0.016), skin, Quaternion.RotationAxis(X, 0.35), 8, 6);
    for (const sx of [-1, 1]) body.ellipsoid(H.add(v(0.074 * sx, -0.01, -0.006)), v(0.012, 0.026, 0.018), shade(skin, 0.92), undefined, 8, 6);
    body.ellipsoid(H.add(v(0, -0.035, -0.062)), v(0.066, 0.05, 0.045), hex('#3b2a20'), undefined, 10, 8);

    // Helmet: shell over the head, lower at the back, dark vents front to back.
    const helmetCol = hex(look.helmet ?? '#f2f2f2');
    const ventCol = hex('#1e2024');
    const hRot = Quaternion.RotationAxis(X, -0.28);
    const cut = 0.56;
    shell.ellipsoid(H.add(v(0, 0.018, -0.014)), v(0.101, 0.094, 0.146), (t, th) => {
      const phi = t * Math.PI * cut;
      const lx = Math.sin(phi) * Math.cos(th);
      const lz = Math.sin(phi) * Math.sin(th);
      const ax = Math.abs(lx);
      if (t > 0.93) return ventCol;
      const vent = (ax > 0.15 && ax < 0.27) || (ax > 0.43 && ax < 0.53) || (ax < 0.05 && lz > -0.3);
      return vent && lz > -0.75 && lz < 0.82 && t > 0.12 ? ventCol : helmetCol;
    }, hRot, 44, 22, cut);
    // Straps and glasses.
    const strapCol = hex('#202124');
    for (const sx of [-1, 1]) {
      shell.loft([H.add(v(0.088 * sx, -0.005, 0.03)), H.add(v(0.075 * sx, -0.065, 0.0)), H.add(v(0.035 * sx, -0.104, 0.0)), H.add(v(0, -0.11, 0.008))], 0.0012, 0.005, strapCol, { seg: 4 });
      shell.loft([H.add(v(0.088 * sx, -0.005, -0.06)), H.add(v(0.078 * sx, -0.06, 0.01))], 0.0012, 0.006, strapCol, { seg: 4 });
      shell.loft([H.add(v(0.079 * sx, 0.004, 0.06)), H.add(v(0.083 * sx, 0.006, -0.02))], 0.0025, 0.004, strapCol, { seg: 4 });
    }
    const lens: Vector3[] = [];
    for (let k = 0; k <= 12; k++) {
      const a = -1.15 + (2.3 * k) / 12;
      lens.push(H.add(v(Math.sin(a) * 0.085, 0.006 - Math.abs(a) * 0.006, Math.cos(a) * 0.104 - 0.002)));
    }
    shell.loft(lens, 0.003, lens.map((_, k) => 0.024 - Math.abs(k - 6) * 0.0012), (t) => (t < 0.06 || t > 0.94 ? strapCol : hex('#1d2f45')), { hint: Y, seg: 6 });

    // --- Arms ------------------------------------------------------------------------------------
    for (const sx of [-1, 1]) {
      const m = (p: Vector3) => v(p.x * sx, p.y, p.z);
      const S = m(pose.shoulder);
      const E = m(pose.elbow);
      const W = m(pose.wrist);
      body.ellipsoid(S.add(v(-0.004 * sx, 0.004, -0.004)), v(0.052, 0.05, 0.056), accent, undefined, 12, 8);
      const ua = [S, Vector3.Lerp(S, E, 0.3), Vector3.Lerp(S, E, 0.6), Vector3.Lerp(S, E, 0.85), E];
      body.loft(ua, [0.056, 0.05, 0.044, 0.039, 0.035], [0.058, 0.052, 0.047, 0.04, 0.036], (t) => (t < 0.5 ? accent : t < 0.55 ? shade(accent, 0.75) : skin), { seg: 12, hint: Z });
      const fa = [E, Vector3.Lerp(E, W, 0.25), Vector3.Lerp(E, W, 0.7), W];
      body.ellipsoid(E, v(0.037, 0.037, 0.037), skin, undefined, 10, 8);
      body.loft(fa, [0.039, 0.042, 0.032, 0.025], [0.036, 0.039, 0.029, 0.021], (t) => (t > 0.9 ? glove : skin), { seg: 12, hint: Y });
      // Hand wrapped around the hood.
      const hood = m(bike.hood);
      const dir = hood.subtract(W).normalize();
      body.ellipsoid(Vector3.Lerp(W, hood, 0.55).add(v(0.004 * sx, 0.004, 0)), v(0.03, 0.026, 0.052), glove, basis(dir, Y).multiply(Quaternion.RotationAxis(X, Math.PI / 2)), 10, 8);
      body.ellipsoid(hood.add(v(-0.016 * sx, -0.012, 0.014)), v(0.012, 0.02, 0.012), glove, undefined, 8, 6);
    }

    body.build(`${name}-body`, scene, mats.cloth, parent);
    shell.build(`${name}-helmet`, scene, mats.gloss, parent);

    // --- Legs: rigid segments built along +y, origin at the proximal joint -----------------------
    for (const sx of [1, -1]) {
      const thighNode = new TransformNode(`${name}-thigh`, scene);
      const shinNode = new TransformNode(`${name}-shin`, scene);
      const footNode = new TransformNode(`${name}-foot`, scene);
      for (const n of [thighNode, shinNode, footNode]) {
        n.parent = parent;
        n.rotationQuaternion = new Quaternion();
      }
      const L1 = BODY.thigh;
      const L2 = BODY.shin;
      const th = new MeshKit();
      const ty = [0, 0.12, 0.35, 0.6, 0.82, 0.92, 1];
      th.loft(
        ty.map((t) => v(0, t * L1, 0)),
        [0.083, 0.084, 0.076, 0.066, 0.054, 0.05, 0.047],
        [0.084, 0.088, 0.08, 0.068, 0.054, 0.05, 0.048],
        (t) => (t < 0.84 ? shorts : t < 0.89 ? shade(shorts, 1.6) : skin),
        { hint: Z, seg: 14, shift: [0, 0.006, 0.01, 0.008, 0.002, 0, 0] },
      );
      th.build(`${name}-thigh-mesh`, scene, mats.cloth, thighNode);
      const sh = new MeshKit();
      const sy = [0, 0.08, 0.28, 0.5, 0.72, 0.85, 1];
      sh.ellipsoid(Vector3.Zero(), v(0.047, 0.05, 0.05), skin, undefined, 10, 8);
      sh.loft(
        sy.map((t) => v(0, t * L2, 0)),
        [0.045, 0.045, 0.049, 0.042, 0.033, 0.029, 0.027],
        [0.047, 0.05, 0.06, 0.05, 0.036, 0.031, 0.03],
        (t) => (t < 0.8 ? skin : sock),
        { hint: Z, seg: 14, shift: [0, -0.004, -0.012, -0.01, -0.004, 0, 0] },
      );
      sh.build(`${name}-shin-mesh`, scene, mats.cloth, shinNode);
      const ft = new MeshKit();
      ft.ellipsoid(Vector3.Zero(), v(0.032, 0.035, 0.035), sock, undefined, 8, 6);
      const shoe = [v(0, -0.034, -0.07), v(0, -0.03, -0.035), v(0, -0.028, 0.02), v(0, -0.04, 0.08), v(0, -0.05, 0.14), v(0, -0.055, 0.19)];
      const shoeCol = hex('#f4f4f4');
      ft.loft(shoe, [0.034, 0.04, 0.043, 0.046, 0.043, 0.026], [0.04, 0.046, 0.046, 0.034, 0.024, 0.014], (t, a) => {
        if (Math.sin(a) < -0.62) return hex('#202020');
        if (t > 0.25 && t < 0.42 && Math.sin(a) > 0.6) return accent;
        return shoeCol;
      }, { hint: Y, seg: 14 });
      ft.box(v(0, -0.074, 0.105), v(0.05, 0.008, 0.06), hex('#202020'));
      ft.build(`${name}-shoe-mesh`, scene, mats.cloth, footNode);
      this.legs.push({ thigh: thighNode, shin: shinNode, foot: footNode, side: sx });
    }
  }

  /** Places the legs for a crank angle; `pedal(i)` gives the spindle of side i (0 right, 1 left). */
  setCrank(angle: number, pedal: (i: number, a: number) => Vector3): void {
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i]!;
      const a = angle + i * Math.PI;
      const phi = footPitch(a);
      const fwd = v(0, -Math.sin(phi), Math.cos(phi));
      const up = v(0, Math.cos(phi), Math.sin(phi));
      const spindle = pedal(i, angle);
      const ankle = spindle.subtract(fwd.scale(BODY.ankleBack)).add(up.scale(BODY.ankleUp));
      const hip = v(this.pose.hip.x * leg.side, this.pose.hip.y, this.pose.hip.z);
      const knee = solveJoint(hip, ankle, BODY.thigh, BODY.shin, v(0.08 * leg.side, 0.35, 1));
      leg.thigh.position.copyFrom(hip);
      basis(knee.subtract(hip), Z.add(Y.scale(0.3)), leg.thigh.rotationQuaternion!);
      leg.shin.position.copyFrom(knee);
      basis(ankle.subtract(knee), Z, leg.shin.rotationQuaternion!);
      leg.foot.position.copyFrom(ankle);
      basis(up, fwd, leg.foot.rotationQuaternion!);
    }
  }

  get meshes(): Mesh[] {
    const out: Mesh[] = [];
    for (const l of this.legs) for (const n of [l.thigh, l.shin, l.foot]) out.push(...n.getChildMeshes().filter((m): m is Mesh => m instanceof Mesh));
    return out;
  }

  get bikePoints(): BikePoints {
    return this.bike;
  }
}
