import { Vector3 } from '@babylonjs/core';

/**
 * Bike and rider geometry in the avatar's local frame: +z forward, +y up, +x to the rider's right
 * (drive side), origin on the ground halfway between the axles. All lengths in metres, angles in degrees.
 * The frame numbers are those of a real size-56 road frame; the 3D model and the reference drawing
 * are both built from these points.
 */
export type FrameStyle = 'aero' | 'allround' | 'climber' | 'endurance';

export interface FrameSpec {
  stack: number;
  reach: number;
  headAngle: number;
  seatAngle: number;
  headTube: number;
  chainstay: number;
  bbDrop: number;
  forkOffset: number;
  /** BB centre to the top-tube junction along the seat tube. */
  seatTube: number;
  /** Outer tyre radius (700c rim, 28 mm tyre). */
  wheelRadius: number;
  tyreWidth: number;
  crank: number;
  /** BB centre to the top of the saddle along the seat tube. */
  saddleHeight: number;
  spacers: number;
  stemLength: number;
  /** Stem rise relative to the perpendicular of the steerer (negative points down). */
  stemAngle: number;
  /** Centre-to-centre at the hoods. */
  barWidth: number;
  barReach: number;
  barDrop: number;
  /** Tube cross-section scale, deep aero profiles are > 1. */
  tubeDepth: number;
  /** Seat stays meet the seat tube this far below the top-tube junction. */
  stayDrop: number;
}

const BASE: FrameSpec = {
  stack: 0.565,
  reach: 0.395,
  headAngle: 73.5,
  seatAngle: 73.5,
  headTube: 0.14,
  chainstay: 0.41,
  bbDrop: 0.072,
  forkOffset: 0.045,
  seatTube: 0.5,
  wheelRadius: 0.339,
  tyreWidth: 0.028,
  crank: 0.1725,
  saddleHeight: 0.75,
  spacers: 0.02,
  stemLength: 0.11,
  stemAngle: -12,
  barWidth: 0.41,
  barReach: 0.08,
  barDrop: 0.125,
  tubeDepth: 1.2,
  stayDrop: 0.035,
};

export function frameSpec(style: FrameStyle = 'allround'): FrameSpec {
  switch (style) {
    case 'aero':
      return { ...BASE, stack: 0.56, reach: 0.4, tubeDepth: 1.75, stayDrop: 0.13, stemAngle: -15, barWidth: 0.39 };
    case 'climber':
      return { ...BASE, tubeDepth: 1.0, seatTube: 0.51 };
    case 'endurance':
      return { ...BASE, stack: 0.595, reach: 0.38, headAngle: 72.5, headTube: 0.175, chainstay: 0.418, bbDrop: 0.075, tubeDepth: 1.1, spacers: 0.03, stemAngle: -6, tyreWidth: 0.032, wheelRadius: 0.343 };
    default:
      return BASE;
  }
}

/** Key points of the bike, all with x = 0 unless noted. */
export interface BikePoints {
  spec: FrameSpec;
  rearAxle: Vector3;
  frontAxle: Vector3;
  bb: Vector3;
  headTop: Vector3;
  headBottom: Vector3;
  /** Unit vector up along the steering axis. */
  steerUp: Vector3;
  /** Unit vector up along the seat tube. */
  seatUp: Vector3;
  steererTop: Vector3;
  seatCluster: Vector3;
  saddleTop: Vector3;
  barClamp: Vector3;
  /** Right-hand hood, where the palm rests. */
  hood: Vector3;
  wheelbase: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

export function bikePoints(spec: FrameSpec): BikePoints {
  const r = spec.wheelRadius;
  const ha = rad(spec.headAngle);
  const sa = rad(spec.seatAngle);
  const steerUp = new Vector3(0, Math.sin(ha), -Math.cos(ha));
  const seatUp = new Vector3(0, Math.sin(sa), -Math.cos(sa));
  const csHoriz = Math.sqrt(spec.chainstay ** 2 - spec.bbDrop ** 2);
  // Rear axle at z = 0 first, centred on the wheelbase afterwards.
  const bb0 = new Vector3(0, r - spec.bbDrop, csHoriz);
  const headTop0 = bb0.add(new Vector3(0, spec.stack, spec.reach));
  // Front axle: on the steering axis plus the fork offset (perpendicular, forward), at axle height.
  const perp = new Vector3(0, Math.cos(ha), Math.sin(ha));
  const s = (headTop0.y + spec.forkOffset * perp.y - r) / steerUp.y;
  const front0 = headTop0.subtract(steerUp.scale(s)).add(perp.scale(spec.forkOffset));
  const wheelbase = front0.z;
  const shift = new Vector3(0, 0, -wheelbase / 2);
  const bb = bb0.add(shift);
  const headTop = headTop0.add(shift);
  const headBottom = headTop.subtract(steerUp.scale(spec.headTube));
  const steererTop = headTop.add(steerUp.scale(spec.spacers + 0.012));
  const stemDir = perp.clone();
  const sr = rad(spec.stemAngle);
  // rotate perp by the stem angle in the y/z plane
  const stem = new Vector3(0, stemDir.y * Math.cos(sr) + stemDir.z * Math.sin(sr), stemDir.z * Math.cos(sr) - stemDir.y * Math.sin(sr));
  const barClamp = steererTop.subtract(steerUp.scale(0.02)).add(stem.scale(spec.stemLength));
  return {
    spec,
    rearAxle: new Vector3(0, r, -wheelbase / 2),
    frontAxle: new Vector3(0, r, wheelbase / 2),
    bb,
    headTop,
    headBottom,
    steerUp,
    seatUp,
    steererTop,
    seatCluster: bb.add(seatUp.scale(spec.seatTube)),
    saddleTop: bb.add(seatUp.scale(spec.saddleHeight)),
    barClamp,
    hood: barClamp.add(new Vector3(spec.barWidth / 2, 0.028, spec.barReach + 0.012)),
    wheelbase,
  };
}

/** Segment lengths of a 1.80 m rider. */
export const BODY = {
  thigh: 0.44,
  shin: 0.44,
  /** Ankle joint relative to the pedal spindle in the foot's frame (behind, above). */
  ankleBack: 0.105,
  ankleUp: 0.085,
  torso: 0.54,
  upperArm: 0.31,
  forearm: 0.275,
  /** Wrist to the centre of the grip. */
  hand: 0.075,
  hipWidth: 0.18,
  shoulderWidth: 0.38,
  neck: 0.11,
} as const;

export interface RiderPose {
  /** Right hip joint. */
  hip: Vector3;
  /** Right shoulder joint. */
  shoulder: Vector3;
  elbow: Vector3;
  wrist: Vector3;
  /** Base of the neck (C7) and head centre. */
  neck: Vector3;
  head: Vector3;
  /** Torso angle above horizontal. */
  torsoAngle: number;
}

/** Elbow of a 2-bone chain bending towards `bend`. */
export function solveJoint(a: Vector3, c: Vector3, l1: number, l2: number, bend: Vector3): Vector3 {
  const ac = c.subtract(a);
  const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, ac.length()));
  const dir = ac.normalize();
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const side = bend.subtract(dir.scale(Vector3.Dot(bend, dir)));
  if (side.lengthSquared() < 1e-9) side.set(0, 1, 0);
  side.normalize();
  return a.add(dir.scale(x)).add(side.scale(h));
}

/** Seated riding position on the hoods with slightly bent elbows; the torso angle follows the bike's reach. */
export function riderPose(p: BikePoints): RiderPose {
  const hip = p.saddleTop.add(new Vector3(BODY.hipWidth / 2, 0.075, 0.045));
  const wrist = p.hood.add(new Vector3(0.005, 0.02, -0.05));
  const arm = BODY.upperArm + BODY.forearm;
  const target = arm * 0.9;
  const shoulderAt = (angle: number) => {
    const a = rad(angle);
    return new Vector3(BODY.shoulderWidth / 2, hip.y + Math.sin(a) * BODY.torso, hip.z + Math.cos(a) * BODY.torso);
  };
  let lo = 15;
  let hi = 70;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    // A more upright torso brings the shoulder further from the hoods.
    if (Vector3.Distance(shoulderAt(mid), wrist) > target) hi = mid;
    else lo = mid;
  }
  const torsoAngle = (lo + hi) / 2;
  const shoulder = shoulderAt(torsoAngle);
  const elbow = solveJoint(shoulder, wrist, BODY.upperArm, BODY.forearm, new Vector3(0.6, -0.5, -0.5));
  const a = rad(torsoAngle);
  const back = new Vector3(0, Math.sin(a), Math.cos(a));
  const neck = new Vector3(0, shoulder.y + 0.035, shoulder.z + 0.02).add(back.scale(0.03));
  // Head raised to look up the road: the neck tilts well above the back line.
  const head = neck.add(new Vector3(0, 0.08, 0.09));
  return { hip, shoulder, elbow, wrist, neck, head, torsoAngle };
}
