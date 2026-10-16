import { Bone, BoundingInfo, Color3, Matrix, Mesh, Quaternion, Skeleton, TransformNode, Vector3, type Scene } from '@babylonjs/core';
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

/** Spindle position as BikeModel.pedal computes it, available before the bike mesh exists. */
function restPedal(bike: BikePoints, i: number, angle: number): Vector3 {
  const s = i === 0 ? 1 : -1;
  return new Vector3(0.105 * s, bike.bb.y + Math.cos(angle) * bike.spec.crank * s, bike.bb.z + Math.sin(angle) * bike.spec.crank * s);
}

/** Rounds a joint: quadratic Bézier from a over the corner b to c, radii interpolated through the three values. */
function bend(a: Vector3, b: Vector3, c: Vector3, w: number[], d: number[], add: (p: Vector3, w: number, d: number) => void): void {
  const n = 6;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const p = a.scale((1 - t) ** 2).add(b.scale(2 * t * (1 - t))).add(c.scale(t * t));
    const lerp3 = (q: number[]) => (t < 0.5 ? q[0]! + (q[1]! - q[0]!) * t * 2 : q[1]! + (q[2]! - q[1]!) * (t - 0.5) * 2);
    add(p, lerp3(w), lerp3(d));
  }
}

function cumulative(pts: Vector3[]): number[] {
  const out = [0];
  for (let k = 1; k < pts.length; k++) out.push(out[k - 1]! + Vector3.Distance(pts[k]!, pts[k - 1]!));
  return out;
}

interface Leg {
  thigh: TransformNode;
  shin: TransformNode;
  foot: TransformNode;
  side: number;
}

/**
 * Seated road cyclist on the hoods: lofted, muscled limbs, jersey with side panels and pockets,
 * bib shorts, socks and shoes, aero road helmet with vents and wrap-around glasses. Arms, torso and
 * head are one static mesh; both legs are one skinned mesh whose bones follow 2-bone IK to the pedals.
 */
export class Cyclist {
  readonly pose: RiderPose;
  private readonly legs: Leg[] = [];
  private legMesh!: Mesh;

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
      // One skin from the shoulder over a rounded elbow to the wrist, so the joint has no seam.
      const pts: Vector3[] = [];
      const rw: number[] = [];
      const rd: number[] = [];
      const add = (p: Vector3, w: number, d: number) => {
        pts.push(p);
        rw.push(w);
        rd.push(d);
      };
      const u1 = E.subtract(S).normalize();
      const u2 = W.subtract(E).normalize();
      const r = 0.055;
      add(S, 0.056, 0.058);
      add(Vector3.Lerp(S, E, 0.3), 0.05, 0.052);
      add(Vector3.Lerp(S, E, 0.6), 0.044, 0.047);
      bend(E.subtract(u1.scale(r)), E, E.add(u2.scale(r)), [0.039, 0.036, 0.039], [0.04, 0.037, 0.038], add);
      add(Vector3.Lerp(E, W, 0.42), 0.04, 0.037);
      add(Vector3.Lerp(E, W, 0.75), 0.031, 0.028);
      add(W, 0.025, 0.021);
      const len = cumulative(pts);
      const total = len[len.length - 1]!;
      const sleeve = (0.5 * BODY.upperArm) / total;
      const cuff = 1 - (0.08 * BODY.forearm) / total;
      body.loft(pts, rw, rd, (t) => (t < sleeve ? accent : t < sleeve + 0.03 ? shade(accent, 0.75) : t > cuff ? glove : skin), { seg: 14, hint: Y });
      // Hand wrapped around the hood.
      const hood = m(bike.hood);
      const dir = hood.subtract(W).normalize();
      body.ellipsoid(Vector3.Lerp(W, hood, 0.55).add(v(0.004 * sx, 0.004, 0)), v(0.03, 0.026, 0.052), glove, basis(dir, Y).multiply(Quaternion.RotationAxis(X, Math.PI / 2)), 10, 8);
      body.ellipsoid(hood.add(v(-0.016 * sx, -0.012, 0.014)), v(0.012, 0.02, 0.012), glove, undefined, 8, 6);
    }

    body.build(`${name}-body`, scene, mats.cloth, parent);
    shell.build(`${name}-helmet`, scene, mats.gloss, parent);

    // --- Legs: one skinned mesh, bones at pelvis, hips, knees and ankles -----------------------
    // Built around a mid-stroke rest pose (crank at half past one), so the knee bends both ways from it and
    // the skin stretches evenly; weights blend over a few centimetres at every joint.
    const legs = new MeshKit();
    const skeleton = new Skeleton(`${name}-legs`, `${name}-legs`, scene);
    new Bone(`${name}-pelvis`, skeleton, null, Matrix.Identity());
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    for (const sx of [1, -1]) {
      const i = sx === 1 ? 0 : 1;
      const rest = this.legPose(i, Math.PI / 4 - i * Math.PI, (k, a) => restPedal(bike, k, a));
      const nodes = [`thigh`, `shin`, `foot`].map((part, k) => {
        const n = new TransformNode(`${name}-${part}`, scene);
        n.parent = parent;
        n.rotationQuaternion = new Quaternion();
        const q = [rest.qThigh, rest.qShin, rest.qFoot][k]!;
        const pos = [rest.hip, rest.knee, rest.ankle][k]!;
        const bone = new Bone(`${name}-${part}-${i}`, skeleton, null, Matrix.Compose(Vector3.One(), q, pos));
        bone.linkTransformNode(n);
        return n;
      });
      const b0 = 1 + i * 3;
      const { hip, knee, ankle } = rest;
      const t1 = knee.subtract(hip).normalize();
      const t2 = ankle.subtract(knee).normalize();
      const nk = t1.add(t2).normalize();
      // Front of the leg: away from the inside of the knee bend.
      const front = t1.subtract(t2).normalize();
      legs.skin = (p) => {
        const dk = Vector3.Dot(p.subtract(knee), nk);
        if (dk > 0) {
          const da = Vector3.Dot(p.subtract(ankle), t2);
          return da > -0.035 ? [b0 + 1, b0 + 2, smooth(-0.035, 0.015, da)] : [b0, b0 + 1, smooth(-0.07, 0.07, dk)];
        }
        if (dk > -0.07) return [b0, b0 + 1, smooth(-0.07, 0.07, dk)];
        return [0, b0, smooth(-0.04, 0.06, Vector3.Dot(p.subtract(hip), t1))];
      };
      const L1 = BODY.thigh;
      const L2 = BODY.shin;
      const pts: Vector3[] = [];
      const rw: number[] = [];
      const rd: number[] = [];
      const sh: number[] = [];
      const add = (p: Vector3, w: number, d: number, f = 0) => {
        pts.push(p);
        rw.push(w);
        rd.push(d);
        sh.push(f);
      };
      const T = (f: number) => hip.add(t1.scale(f * L1));
      const S = (f: number) => knee.add(t2.scale(f * L2));
      add(T(-0.1), 0.078, 0.078, -0.004);
      add(T(0), 0.083, 0.084, 0.004);
      add(T(0.12), 0.084, 0.088, 0.008);
      add(T(0.35), 0.076, 0.08, 0.01);
      add(T(0.6), 0.066, 0.068, 0.008);
      add(T(0.78), 0.056, 0.056, 0.004);
      const r = 0.1;
      bend(knee.subtract(t1.scale(r)), knee, knee.add(t2.scale(r)), [0.052, 0.05, 0.047], [0.053, 0.052, 0.05], (p, w, d) => add(p, w, d, 0.012));
      add(S(0.28), 0.049, 0.06, -0.012);
      add(S(0.5), 0.042, 0.05, -0.01);
      add(S(0.72), 0.033, 0.036, -0.004);
      add(S(0.85), 0.029, 0.031);
      add(S(1), 0.027, 0.03);
      const len = cumulative(pts);
      const total = len[len.length - 1]!;
      const shortsEnd = (0.1 + 0.72) * L1 / total;
      const sockStart = 1 - (0.2 * L2) / total;
      legs.loft(pts, rw, rd, (t) => (t < shortsEnd ? shorts : t < shortsEnd + 0.035 ? shade(shorts, 1.6) : t < sockStart ? skin : sock), {
        hint: front,
        seg: 18,
        shift: sh,
        capStart: false,
      });

      // Foot: built in the foot's frame (y up, z toes) and moved to the rest pose; only the foot bone moves it.
      legs.skin = () => [b0 + 2, b0 + 2, 0];
      const F = (x: number, y: number, z: number) => v(x, y, z).applyRotationQuaternion(rest.qFoot).addInPlace(ankle);
      const up = Y.applyRotationQuaternion(rest.qFoot);
      legs.ellipsoid(ankle, v(0.032, 0.035, 0.035), sock, rest.qFoot, 10, 8);
      const shoe = [F(0, -0.034, -0.07), F(0, -0.03, -0.035), F(0, -0.028, 0.02), F(0, -0.04, 0.08), F(0, -0.05, 0.14), F(0, -0.055, 0.19)];
      const shoeCol = hex('#f4f4f4');
      legs.loft(shoe, [0.034, 0.04, 0.043, 0.046, 0.043, 0.026], [0.04, 0.046, 0.046, 0.034, 0.024, 0.014], (t, a) => {
        if (Math.sin(a) < -0.62) return hex('#202020');
        if (t > 0.25 && t < 0.42 && Math.sin(a) > 0.6) return accent;
        return shoeCol;
      }, { hint: up, seg: 14 });
      legs.box(F(0, -0.074, 0.105), v(0.05, 0.008, 0.06), hex('#202020'), rest.qFoot);
      this.legs.push({ thigh: nodes[0]!, shin: nodes[1]!, foot: nodes[2]!, side: sx });
    }
    const legMesh = legs.build(`${name}-legs`, scene, mats.cloth, parent);
    legMesh.skeleton = skeleton;
    legMesh.numBoneInfluencers = 2;
    // The skin moves away from its rest pose: give culling a box around the whole pedal stroke.
    const hy = pose.hip.y;
    legMesh.setBoundingInfo(new BoundingInfo(v(-0.3, bike.bb.y - 0.3, bike.bb.z - 0.35), v(0.3, hy + 0.15, bike.bb.z + 0.45)));
    legMesh.onDisposeObservable.addOnce(() => skeleton.dispose());
    this.legMesh = legMesh;
  }

  /** Hip, knee, ankle and segment orientations of leg i (0 right, 1 left) for a crank angle. */
  private legPose(i: number, angle: number, pedal: (i: number, a: number) => Vector3) {
    const side = i === 0 ? 1 : -1;
    const phi = footPitch(angle + i * Math.PI);
    const fwd = v(0, -Math.sin(phi), Math.cos(phi));
    const up = v(0, Math.cos(phi), Math.sin(phi));
    const spindle = pedal(i, angle);
    const ankle = spindle.subtract(fwd.scale(BODY.ankleBack)).add(up.scale(BODY.ankleUp));
    const hip = v(this.pose.hip.x * side, this.pose.hip.y, this.pose.hip.z);
    const knee = solveJoint(hip, ankle, BODY.thigh, BODY.shin, v(0.08 * side, 0.35, 1));
    return {
      hip,
      knee,
      ankle,
      qThigh: basis(knee.subtract(hip), Z.add(Y.scale(0.3))),
      qShin: basis(ankle.subtract(knee), Z),
      qFoot: basis(up, fwd),
    };
  }

  /** Places the legs for a crank angle; `pedal(i)` gives the spindle of side i (0 right, 1 left). */
  setCrank(angle: number, pedal: (i: number, a: number) => Vector3): void {
    for (let i = 0; i < 2; i++) {
      const leg = this.legs[i]!;
      const p = this.legPose(i, angle, pedal);
      leg.thigh.position.copyFrom(p.hip);
      leg.thigh.rotationQuaternion!.copyFrom(p.qThigh);
      leg.shin.position.copyFrom(p.knee);
      leg.shin.rotationQuaternion!.copyFrom(p.qShin);
      leg.foot.position.copyFrom(p.ankle);
      leg.foot.rotationQuaternion!.copyFrom(p.qFoot);
    }
  }

  get meshes(): Mesh[] {
    return [this.legMesh];
  }

  get bikePoints(): BikePoints {
    return this.bike;
  }
}
