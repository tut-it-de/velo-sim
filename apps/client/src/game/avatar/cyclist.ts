import { Bone, BoundingInfo, Color3, Matrix, Mesh, Quaternion, Skeleton, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import { BODY, riderPose, solveJoint, type BikePoints, type RiderPose } from './geometry';
import { MeshKit, basis, hex, type Paint } from './meshKit';
import type { JerseyDesign } from '@velo/equipment';
import { avatarMaterials, jerseyMaterial } from './materials';
import { sleeveUv, torsoUv } from './jerseyArt';

export interface CyclistLook {
  jersey: string;
  jerseyAccent?: string;
  helmet?: string;
  skinsuit?: boolean;
  skin?: string;
  /** Printed jersey (pattern, colours, lettering); without it the jersey is plain `jersey`/`jerseyAccent`. */
  jerseyDesign?: JerseyDesign;
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

/** Same hue as `ref`: the RGB shares, normalised to sum 1, agree within 0.02 (shaded skin counts as skin). */
function sameHue(c: Color3, ref: Color3): boolean {
  const share = (x: Color3) => {
    const s = x.r + x.g + x.b || 1;
    return [x.r / s, x.g / s, x.b / s];
  };
  const a = share(c);
  const b = share(ref);
  return Math.abs(a[0]! - b[0]!) <= 0.02 && Math.abs(a[1]! - b[1]!) <= 0.02 && Math.abs(a[2]! - b[2]!) <= 0.02;
}

function cumulative(pts: Vector3[]): number[] {
  const out = [0];
  for (let k = 1; k < pts.length; k++) out.push(out[k - 1]! + Vector3.Distance(pts[k]!, pts[k - 1]!));
  return out;
}

/** Bones of the right arm, which can leave the bar (e.g. to reach a pocket). */
interface Arm {
  upper: TransformNode;
  elbow: TransformNode;
  fore: TransformNode;
  shoulder: Vector3;
  l1: number;
  l2: number;
  /** Rest pose: elbow, wrist, forearm rotation and the centre of the fist. */
  restElbow: Vector3;
  restWrist: Vector3;
  restFore: Quaternion;
  hand: Vector3;
}

/** Upper arm and forearm rotations sharing one hinge axis at the elbow (x = u1 × u2). */
function armFrames(S: Vector3, E: Vector3, W: Vector3): [Quaternion, Quaternion] {
  const u1 = E.subtract(S);
  const u2 = W.subtract(E);
  return [basis(u1, u2), basis(u2, u1.negate())];
}

interface Leg {
  thigh: TransformNode;
  /** Helper bone at the knee, turned half-way between thigh and shin. */
  knee: TransformNode;
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
  private arm!: Arm;
  private armMesh!: Mesh;

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

    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const body = new MeshKit();
    const shell = new MeshKit();
    // Kind for the fabric shader: 0 = skin, 1 = cloth (see fabricPlugin.ts).
    body.kind = (c) => (sameHue(c, skin) ? 0 : 1);

    // --- Torso along the back line, pelvis to neck -----------------------------------------------
    const pelvis = v(0, pose.hip.y + 0.005, pose.hip.z - 0.035);
    const shoulders = v(0, pose.shoulder.y + 0.005, pose.shoulder.z - 0.02);
    const spine = shoulders.subtract(pelvis).normalize();
    const back = v(0, spine.z, -spine.y);
    const along = (t: number, hump: number) => Vector3.Lerp(pelvis, shoulders, t).add(back.scale(hump));
    // The first two rings round off the seat instead of ending in a flat cap.
    const torso = [along(-0.17, -0.03), along(-0.13, -0.018), along(-0.08, -0.01), along(0.05, 0.0), along(0.3, 0.012), along(0.55, 0.02), along(0.78, 0.016), along(0.95, 0.0), along(1.04, -0.02), along(1.1, -0.035)];
    const tw = [0.07, 0.135, 0.172, 0.178, 0.148, 0.152, 0.152, 0.132, 0.1, 0.07];
    const td = [0.045, 0.078, 0.09, 0.105, 0.095, 0.11, 0.118, 0.1, 0.08, 0.06];
    const tl = cumulative(torso);
    const seat = tl[2]!;
    const tTotal = tl[tl.length - 1]!;
    const design = look.jerseyDesign;
    const white = Color3.White();
    const jerseyT = (tRaw: number) => (tRaw * tTotal - seat) / (tTotal - seat);
    const jerseyPaint: Paint = (tRaw, a) => {
      const t = jerseyT(tRaw);
      if (design) return t < 0.1 ? shorts : white;
      const flank = Math.abs(Math.cos(a));
      const up = Math.sin(a);
      if (t < 0.1) return shorts;
      if (t < 0.13) return shade(jersey, 0.8);
      if (t > 0.93) return accent;
      if (t > 0.6 && t < 0.66) return accent;
      if (t < 0.3 && up > 0.5) return shade(jersey, Math.abs(Math.cos(a * 3)) < 0.12 || (t > 0.27 && t < 0.29) ? 0.62 : 0.9);
      return jersey;
    };
    // printed jersey: u around by arc length (0 right seam, 0.25 chest, 0.75 back), s from hem to collar
    const torsoMap = (tRaw: number, _a: number, arc: number): [number, number] | null => {
      const t = jerseyT(tRaw);
      return t < 0.1 ? null : torsoUv(1 - arc, (t - 0.1) / 0.9);
    };
    body.loft(torso, tw, td, jerseyPaint, { hint: back, seg: design ? 48 : 24, map: design ? torsoMap : undefined });
    // Glutes on the saddle.
    for (const sx of [-1, 1]) body.ellipsoid(v(0.065 * sx, pose.hip.y - 0.025, pose.hip.z - 0.055), v(0.075, 0.07, 0.085), shorts, undefined, 20, 14);

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
    // The right arm is its own skinned mesh (upper arm, elbow helper, forearm with the hand).
    const armKit = new MeshKit();
    armKit.kind = body.kind;
    const armSkel = new Skeleton(`${name}-arm`, `${name}-arm`, scene);
    new Bone(`${name}-arm-root`, armSkel, null, Matrix.Identity());
    for (const sx of [-1, 1]) {
      const m = (p: Vector3) => v(p.x * sx, p.y, p.z);
      const S = m(pose.shoulder);
      const E = m(pose.elbow);
      const W = m(pose.wrist);
      if (design) body.texAt = sleeveUv(0.25, 0.03);
      body.ellipsoid(S.add(v(-0.004 * sx, 0.002, -0.004)), v(0.048, 0.047, 0.052), design ? white : accent, undefined, 14, 10);
      body.texAt = null;
      const kit = sx > 0 ? armKit : body;
      // One skin from the shoulder over a rounded elbow to the wrist, so the joint has no seam.
      const pts: Vector3[] = [];
      const rw: number[] = [];
      const rd: number[] = [];
      const add = (p: Vector3, w: number, d: number) => {
        pts.push(p);
        rw.push(w);
        rd.push(d);
      };
      // Straight upper arm and forearm meeting in a mitred joint: the section at the elbow lies on
      // the bisecting plane, the elbow point (olecranon) shows at the back, a crease in the crook.
      // The section's normal axis points to the elbow point: shift > 0 is triceps side, < 0 biceps side.
      const u1 = E.subtract(S).normalize();
      const u2 = W.subtract(E).normalize();
      const elbowOut = u1.subtract(u2);
      const hint = elbowOut.length() > 0.1 ? elbowOut.normalize() : v(0, 0.3, -1).normalize();
      const sh: number[] = [];
      const add2 = (p: Vector3, w: number, d: number, f: number) => {
        add(p, w, d);
        sh.push(f);
      };
      // The arm grows out of the torso: the tube starts inside the upper back, runs out along the
      // sloping shoulder line and bends down into the upper arm, so there is no edge between them.
      const inner = Vector3.Lerp(shoulders, S, 0.3).add(v(0, 0.008, -0.012));
      add2(inner, 0.058, 0.058, 0);
      add2(Vector3.Lerp(shoulders, S, 0.65).add(v(0, 0.008, -0.008)), 0.054, 0.055, 0);
      add2(S, 0.05, 0.052, 0);
      add2(Vector3.Lerp(S, E, 0.25), 0.045, 0.048, 0);
      add2(Vector3.Lerp(S, E, 0.5), 0.046, 0.05, -0.002);
      add2(Vector3.Lerp(S, E, 0.75), 0.042, 0.044, 0);
      add2(E.subtract(u1.scale(0.045)), 0.04, 0.038, 0.003);
      add2(E, 0.041, 0.037, 0.009);
      add2(E.add(u2.scale(0.045)), 0.043, 0.036, 0.003);
      add2(Vector3.Lerp(E, W, 0.25), 0.043, 0.037, -0.002);
      add2(Vector3.Lerp(E, W, 0.55), 0.035, 0.03, 0);
      add2(Vector3.Lerp(E, W, 0.85), 0.027, 0.021, 0);
      add2(W, 0.025, 0.02, 0);
      const len = cumulative(pts);
      const total = len[len.length - 1]!;
      // the sleeve seam sits on the shoulder joint; inwards it is part of the jersey body
      const seam = len[2]! / total;
      const sleeve = (len[2]! + 0.5 * BODY.upperArm) / total;
      const cuff = 1 - (0.08 * BODY.forearm) / total;
      const hem = sleeve + 0.03;
      // sleeve print: u around the arm from its seam (mirrored on the left so lettering reads the same
      // way), s shoulder → cuff; u 0.25 / 0.75 (where the sleeve marks sit) face the elbow point and the crook
      const sleeveMap = (t: number, _a: number, arc: number): [number, number] | null => (t > hem || t < seam ? null : sleeveUv(sx > 0 ? arc : 1 - arc, (t - seam) / (hem - seam)));
      const hood = m(bike.hood);
      if (sx > 0) {
        const [qU, qF] = armFrames(S, E, W);
        const nodes = ([['upper', qU, S], ['elbow', Quaternion.Slerp(qU, qF, 0.5), E], ['fore', qF, E]] as const).map(([part, q, pos]) => {
          const n = new TransformNode(`${name}-arm-${part}`, scene);
          n.parent = parent;
          n.position.copyFrom(pos);
          n.rotationQuaternion = q.clone();
          new Bone(`${name}-arm-${part}`, armSkel, null, Matrix.Compose(Vector3.One(), q, pos)).linkTransformNode(n);
          return n;
        });
        // weights across the plane bisecting the elbow, like the knee
        const bis = u1.add(u2).normalize();
        // the part inside the torso stays with the body (root bone) and blends into the upper arm at the joint
        const outward = S.subtract(inner).normalize();
        armKit.skin = (p) => {
          const d = Vector3.Dot(p.subtract(S), outward);
          if (d < -0.012) return [0, 1, smooth(-0.08, -0.012, d)];
          const s = Vector3.Dot(p.subtract(E), bis);
          if (s < -0.004) return [1, 2, smooth(-0.04, -0.004, s)];
          return [2, 3, smooth(0.004, 0.04, s)];
        };
        this.arm = {
          upper: nodes[0]!, elbow: nodes[1]!, fore: nodes[2]!, shoulder: S,
          l1: Vector3.Distance(S, E), l2: Vector3.Distance(E, W),
          restElbow: E, restWrist: W, restFore: qF, hand: Vector3.Lerp(W, hood, 0.55),
        };
      }
      kit.loft(
        pts,
        rw,
        rd,
        (t) => (t < seam ? (design ? white : jersey) : t < sleeve ? (design ? white : accent) : t < hem ? (design ? white : shade(accent, 0.75)) : t > cuff ? glove : skin),
        { seg: design ? 24 : 16, hint, shift: sh, step: 0.025, map: design ? sleeveMap : undefined },
      );
      // Hand wrapped around the hood.
      const dir = hood.subtract(W).normalize();
      kit.ellipsoid(Vector3.Lerp(W, hood, 0.55).add(v(0.004 * sx, 0.004, 0)), v(0.03, 0.026, 0.052), glove, basis(dir, Y).multiply(Quaternion.RotationAxis(X, Math.PI / 2)), 10, 8);
      kit.ellipsoid(hood.add(v(-0.016 * sx, -0.012, 0.014)), v(0.012, 0.02, 0.012), glove, undefined, 8, 6);
    }

    const bodyMat = design ? jerseyMaterial(scene, design) : mats.cloth;
    body.build(`${name}-body`, scene, bodyMat, parent);
    const armMesh = (this.armMesh = armKit.build(`${name}-arm`, scene, bodyMat, parent));
    armMesh.skeleton = armSkel;
    armMesh.numBoneInfluencers = 2;
    const sh = this.arm.shoulder;
    armMesh.setBoundingInfo(new BoundingInfo(sh.subtract(v(0.7, 0.7, 0.7)), sh.add(v(0.7, 0.7, 0.7))));
    armMesh.onDisposeObservable.addOnce(() => armSkel.dispose());
    shell.build(`${name}-helmet`, scene, mats.gloss, parent);

    // --- Legs: one skinned mesh, bones at pelvis, hips, knees and ankles -----------------------
    // Each leg is modelled straight (thigh and shin on one axis, front = +z of the thigh bone) and
    // bent by the bones. A helper bone at the knee always turns by half the knee angle, so the
    // section at the joint stays on the bisecting plane: the front folds into a tight, rounded knee
    // over the kneecap and the back closes into a crease where hamstrings meet the calf, instead of
    // the thigh thinning out the way plain two-bone blending does.
    const legs = new MeshKit();
    legs.kind = (c) => (sameHue(c, skin) ? 0 : 1);
    const skeleton = new Skeleton(`${name}-legs`, `${name}-legs`, scene);
    new Bone(`${name}-pelvis`, skeleton, null, Matrix.Identity());
    const L1 = BODY.thigh;
    const L2 = BODY.shin;
    for (const sx of [1, -1]) {
      const i = sx === 1 ? 0 : 1;
      // Orientation of the thigh and of the foot relative to the shin from a mid-stroke pose.
      const mid = this.legPose(i, Math.PI / 4 - i * Math.PI, (k, a) => restPedal(bike, k, a));
      const R = mid.qThigh;
      const footRel = Quaternion.Inverse(mid.qShin).multiply(mid.qFoot);
      const qFoot = R.multiply(footRel);
      const hip = mid.hip;
      const axis = Y.applyRotationQuaternion(R);
      const front = Z.applyRotationQuaternion(R);
      const knee = hip.add(axis.scale(L1));
      const ankle = knee.add(axis.scale(L2));
      const parts: Array<[string, Quaternion, Vector3]> = [
        ['thigh', R, hip],
        ['knee', R, knee],
        ['shin', R, knee],
        ['foot', qFoot, ankle],
      ];
      const nodes = parts.map(([part, q, pos]) => {
        const n = new TransformNode(`${name}-${part}`, scene);
        n.parent = parent;
        n.rotationQuaternion = new Quaternion();
        const bone = new Bone(`${name}-${part}-${i}`, skeleton, null, Matrix.Compose(Vector3.One(), q, pos));
        bone.linkTransformNode(n);
        return n;
      });
      const b0 = 1 + i * 4; // thigh, knee helper, shin, foot
      legs.skin = (p) => {
        const sy = Vector3.Dot(p.subtract(hip), axis);
        if (sy < 0.07) return [0, b0, smooth(-0.04, 0.07, sy)];
        if (sy < L1) return [b0, b0 + 1, smooth(L1 - 0.04, L1 - 0.004, sy)];
        if (sy < L1 + L2 - 0.04) return [b0 + 1, b0 + 2, smooth(L1 + 0.004, L1 + 0.04, sy)];
        return [b0 + 2, b0 + 3, smooth(L1 + L2 - 0.035, L1 + L2 + 0.015, sy)];
      };
      // Sections along the leg: [distance from the hip, half-width, half-depth, forward shift].
      const prof: Array<[number, number, number, number]> = [
        // starts inside the pelvis so the open end never shows behind the seat
        [-0.05 * L1, 0.058, 0.06, 0],
        // flatter on top at the hip joint, so the thigh flows into the pelvis instead of bulging out
        [0, 0.083, 0.07, -0.012],
        [0.12 * L1, 0.084, 0.08, -0.002],
        [0.35 * L1, 0.077, 0.08, 0.01],
        [0.6 * L1, 0.066, 0.068, 0.008],
        [0.8 * L1, 0.057, 0.057, 0.006],
        // knee: bony and a little narrower, kneecap in front
        [L1 - 0.045, 0.052, 0.054, 0.008],
        [L1 - 0.015, 0.05, 0.054, 0.012],
        [L1 + 0.015, 0.048, 0.052, 0.009],
        [L1 + 0.045, 0.046, 0.051, 0.0],
        [L1 + 0.28 * L2, 0.049, 0.06, -0.012],
        [L1 + 0.5 * L2, 0.042, 0.05, -0.01],
        [L1 + 0.72 * L2, 0.033, 0.036, -0.004],
        [L1 + 0.85 * L2, 0.029, 0.031, 0],
        [L1 + L2, 0.027, 0.03, 0],
      ];
      const total = prof[prof.length - 1]![0] - prof[0]![0];
      const at = (sy: number) => (sy - prof[0]![0]) / total;
      const shortsEnd = at(0.72 * L1);
      const sockStart = at(L1 + 0.8 * L2);
      legs.loft(
        prof.map(([sy]) => hip.add(axis.scale(sy))),
        prof.map((q) => q[1]),
        prof.map((q) => q[2]),
        (t) => (t < shortsEnd ? shorts : t < shortsEnd + 0.035 ? shade(shorts, 1.6) : t < sockStart ? skin : sock),
        { hint: front, seg: 18, shift: prof.map((q) => q[3]), capStart: false, step: 0.01 },
      );

      // Foot: built in the foot's frame (y up, z toes) at its rest place; only the foot bone moves it.
      legs.skin = () => [b0 + 3, b0 + 3, 0];
      const F = (x: number, y: number, z: number) => v(x, y, z).applyRotationQuaternion(qFoot).addInPlace(ankle);
      const up = Y.applyRotationQuaternion(qFoot);
      legs.ellipsoid(ankle, v(0.032, 0.035, 0.035), sock, qFoot, 10, 8);
      const shoe = [F(0, -0.034, -0.07), F(0, -0.03, -0.035), F(0, -0.028, 0.02), F(0, -0.04, 0.08), F(0, -0.05, 0.14), F(0, -0.055, 0.19)];
      const shoeCol = hex('#f4f4f4');
      legs.loft(shoe, [0.034, 0.04, 0.043, 0.046, 0.043, 0.026], [0.04, 0.046, 0.046, 0.034, 0.024, 0.014], (t, a) => {
        if (Math.sin(a) < -0.62) return hex('#202020');
        if (t > 0.25 && t < 0.42 && Math.sin(a) > 0.6) return accent;
        return shoeCol;
      }, { hint: up, seg: 14 });
      legs.box(F(0, -0.074, 0.105), v(0.05, 0.008, 0.06), hex('#202020'), qFoot);
      this.legs.push({ thigh: nodes[0]!, knee: nodes[1]!, shin: nodes[2]!, foot: nodes[3]!, side: sx });
    }
    const legMesh = legs.build(`${name}-legs`, scene, mats.cloth, parent);
    legMesh.skeleton = skeleton;
    legMesh.numBoneInfluencers = 2;
    // The skin moves away from its rest pose: give culling a box around the whole pedal stroke.
    const hy = pose.hip.y;
    legMesh.setBoundingInfo(new BoundingInfo(v(-0.3, Math.min(bike.bb.y, hy) - 0.3, Math.min(bike.bb.z, pose.hip.z) - 0.35), v(0.3, Math.max(hy, bike.bb.y) + 0.3, bike.bb.z + 0.45)));
    legMesh.onDisposeObservable.addOnce(() => skeleton.dispose());
    this.legMesh = legMesh;
  }

  /** Hip, knee, ankle and segment orientations of leg i (0 right, 1 left) for a crank angle. */
  private legPose(i: number, angle: number, pedal: (i: number, a: number) => Vector3) {
    const side = i === 0 ? 1 : -1;
    const phi = footPitch(angle + i * Math.PI) + this.bike.footTilt;
    // lying back, the legs reach forwards: knees bow upwards and the kneecaps face the sky
    const lying = this.bike.spec.layout === 'recumbent';
    const fwd = v(0, -Math.sin(phi), Math.cos(phi));
    const up = v(0, Math.cos(phi), Math.sin(phi));
    const spindle = pedal(i, angle);
    const ankle = spindle.subtract(fwd.scale(BODY.ankleBack)).add(up.scale(BODY.ankleUp));
    const hip = v(this.pose.hip.x * side, this.pose.hip.y, this.pose.hip.z);
    const knee = solveJoint(hip, ankle, BODY.thigh, BODY.shin, lying ? v(0.08 * side, 1, 0.2) : v(0.08 * side, 0.35, 1));
    return {
      hip,
      knee,
      ankle,
      qThigh: basis(knee.subtract(hip), lying ? Y.subtract(Z.scale(0.3)) : Z.add(Y.scale(0.3))),
      qShin: basis(ankle.subtract(knee), lying ? Y : Z),
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
      leg.knee.position.copyFrom(p.knee);
      Quaternion.SlerpToRef(p.qThigh, p.qShin, 0.5, leg.knee.rotationQuaternion!);
      leg.foot.position.copyFrom(p.ankle);
      leg.foot.rotationQuaternion!.copyFrom(p.qFoot);
    }
  }

  /**
   * Moves the right hand: the wrist goes to `wrist` (or back to the bar for null), the elbow bends
   * towards `bend`. Returns the centre of the fist.
   */
  setRightHand(wrist: Vector3 | null, bend = v(0.6, -0.5, -0.5)): Vector3 {
    const a = this.arm;
    const target = wrist ?? a.restWrist;
    const E = wrist ? solveJoint(a.shoulder, target, a.l1, a.l2, bend) : a.restElbow;
    const W = wrist ? E.add(target.subtract(E).normalize().scale(a.l2)) : a.restWrist;
    const [qU, qF] = armFrames(a.shoulder, E, W);
    a.upper.rotationQuaternion!.copyFrom(qU);
    a.elbow.position.copyFrom(E);
    Quaternion.SlerpToRef(qU, qF, 0.5, a.elbow.rotationQuaternion!);
    a.fore.position.copyFrom(E);
    a.fore.rotationQuaternion!.copyFrom(qF);
    // fist: rest offset from the elbow, turned with the forearm
    const turn = qF.multiply(Quaternion.Inverse(a.restFore));
    return E.add(a.hand.subtract(a.restElbow).applyRotationQuaternion(turn));
  }

  get restWrist(): Vector3 {
    return this.arm.restWrist;
  }

  /** Forearm rotation relative to its rest pose (to hold things in the hand). */
  get rightForearmTurn(): Quaternion {
    return this.arm.fore.rotationQuaternion!.multiply(Quaternion.Inverse(this.arm.restFore));
  }

  get meshes(): Mesh[] {
    return [this.legMesh, this.armMesh];
  }

  get bikePoints(): BikePoints {
    return this.bike;
  }
}
