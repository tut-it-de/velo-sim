import { Vector3 } from '@babylonjs/core';

/**
 * Bike and rider geometry in the avatar's local frame: +z forward, +y up, +x to the rider's right
 * (drive side), origin on the ground halfway between the axles. All lengths in metres, angles in degrees.
 * The frame numbers are those of a real size-56 road frame; the 3D model and the reference drawing
 * are both built from these points.
 */
export type FrameStyle = 'aero' | 'allround' | 'climber' | 'endurance' | 'recumbent' | 'trike' | 'unicycle';

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
  /**
   * `diamond`: road frame; `recumbent`: high racer, rider lying in a seat shell, cranks on a boom ahead;
   * `trike`: road front end, two rear wheels on a driven axle; `unicycle`: one big wheel, cranks on its hub.
   */
  layout: 'diamond' | 'recumbent' | 'trike' | 'unicycle';
  /** Trike only: distance between the rear wheels' centre planes. */
  rearTrack?: number;
}

export const BASE_SPEC: FrameSpec = {
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
  layout: 'diamond',
};

/**
 * High racer: two 700c wheels, wheelbase 1.12 m, the seat shell above the rear wheel reclined to
 * 32°, the bottom bracket on a boom ahead of the fork high enough for the heels to clear the front
 * tyre, under-seat steering. `seatAngle` is the recline of the seat back above horizontal, `stack`
 * and `reach` the bottom bracket relative to the seat (the hip's support point).
 */
const RECUMBENT_SPEC: FrameSpec = {
  ...BASE_SPEC,
  layout: 'recumbent',
  stack: 0.3,
  reach: 0.78,
  headAngle: 72,
  seatAngle: 32,
  headTube: 0.13,
  chainstay: 0.4,
  forkOffset: 0.05,
  seatTube: 0.62,
  saddleHeight: 0.62,
  tubeDepth: 1.1,
  stayDrop: 0,
  barWidth: 0.5,
};

/**
 * Racing tricycle: a road frame whose stays end at a bracket around a live rear axle; the two rear
 * wheels sit 0.74 m apart, the chain drives a cassette on the axle between the stays.
 */
const TRIKE_SPEC: FrameSpec = { ...BASE_SPEC, layout: 'trike', chainstay: 0.43, tubeDepth: 1.1, rearTrack: 0.74 };

/**
 * Geared 36" unicycle: the cranks turn the wheel through a 1.5:1 hub gear. The crown sits just above
 * the tyre, the saddle straight above the axle (`seatAngle` 90), a T-bar reaches forward from the
 * saddle so the rider can lean onto it like onto the hoods. `stack` is the crown above the axle,
 * `reach` the T-bar ahead of the saddle and `barWidth` its grip width.
 */
const UNICYCLE_SPEC: FrameSpec = {
  ...BASE_SPEC,
  layout: 'unicycle',
  wheelRadius: 0.46,
  tyreWidth: 0.055,
  crank: 0.137,
  seatAngle: 90,
  headAngle: 90,
  saddleHeight: 0.725,
  stack: 0.495,
  reach: 0.34,
  barWidth: 0.3,
  barDrop: 0,
  tubeDepth: 1,
  stayDrop: 0,
};

/** Shape of the frame that changes its geometry: how far the top tube slopes towards the seat. */
export interface FrameShape {
  slope?: number;
  stays?: 'high' | 'dropped' | 'wave';
}

export function frameSpec(style: FrameStyle = 'allround', shape: FrameShape = {}): FrameSpec {
  const base = ((): FrameSpec => {
    switch (style) {
      case 'aero':
        return { ...BASE_SPEC, stack: 0.56, reach: 0.4, tubeDepth: 1.75, stayDrop: 0.13, stemAngle: -15, barWidth: 0.39 };
      case 'climber':
        return { ...BASE_SPEC, tubeDepth: 1.0, seatTube: 0.51 };
      case 'endurance':
        return { ...BASE_SPEC, stack: 0.595, reach: 0.38, headAngle: 72.5, headTube: 0.175, chainstay: 0.418, bbDrop: 0.075, tubeDepth: 1.1, spacers: 0.03, stemAngle: -6, tyreWidth: 0.032, wheelRadius: 0.343 };
      case 'recumbent':
        return RECUMBENT_SPEC;
      case 'trike':
        return TRIKE_SPEC;
      case 'unicycle':
        return UNICYCLE_SPEC;
      default:
        return BASE_SPEC;
    }
  })();
  if (base.layout === 'recumbent' || base.layout === 'unicycle') return base;
  // a sloping top tube meets a shorter seat tube; stays follow the brand's style
  const seatTube = shape.slope === undefined ? base.seatTube : 0.535 - shape.slope;
  const stayDrop = shape.stays === 'high' ? 0.035 : shape.stays === 'dropped' ? Math.max(base.stayDrop, 0.11) : shape.stays === 'wave' ? 0.08 : base.stayDrop;
  return { ...base, seatTube, stayDrop };
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
  /** Extra pitch of the feet and pedals (radians, toes down > 0): recumbent riders push forwards. */
  footTilt: number;
  /** Recumbent only: top of the seat back (headrest) and the under-seat bar's pivot. */
  seatBackTop?: Vector3;
}

const rad = (d: number) => (d * Math.PI) / 180;

export function bikePoints(spec: FrameSpec): BikePoints {
  if (spec.layout === 'recumbent') return recumbentPoints(spec);
  if (spec.layout === 'unicycle') return unicyclePoints(spec);
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
    footTilt: 0,
  };
}

/**
 * High racer key points. `saddleTop` is where the hips rest in the seat shell, `seatUp` runs up the
 * seat back, `seatCluster` is the shell's lowest point, `barClamp` the under-seat bar's centre
 * (below the seat) and `hood` the right grip beside the hip. Head tube and fork sit over the front
 * axle as on a road bike; the bottom bracket is `reach` ahead of and `stack` above the hips.
 */
function recumbentPoints(spec: FrameSpec): BikePoints {
  const r = spec.wheelRadius;
  const wheelbase = 1.12;
  const rearAxle = new Vector3(0, r, -wheelbase / 2);
  const frontAxle = new Vector3(0, r, wheelbase / 2);
  const seatRecline = rad(spec.seatAngle);
  const seatUp = new Vector3(0, Math.sin(seatRecline), -Math.cos(seatRecline));
  const saddleTop = new Vector3(0, 0.66, -0.17);
  const bb = saddleTop.add(new Vector3(0, spec.stack, spec.reach));
  const ha = rad(spec.headAngle);
  const steerUp = new Vector3(0, Math.sin(ha), -Math.cos(ha));
  const perp = new Vector3(0, Math.cos(ha), Math.sin(ha));
  // steering axis through the fork crown, offset behind the axle like a road fork
  const crownAt = frontAxle.subtract(perp.scale(spec.forkOffset));
  const headBottom = crownAt.add(steerUp.scale((0.62 - crownAt.y) / steerUp.y));
  const headTop = headBottom.add(steerUp.scale(spec.headTube));
  const steererTop = headTop.add(steerUp.scale(0.012));
  // under-seat steering: a cross bar below the seat front, grips beside the hips
  const barClamp = saddleTop.add(new Vector3(0, -0.12, -0.05));
  const hood = new Vector3(spec.barWidth / 2, saddleTop.y + 0.02, saddleTop.z - 0.06);
  return {
    spec,
    rearAxle,
    frontAxle,
    bb,
    headTop,
    headBottom,
    steerUp,
    seatUp,
    steererTop,
    seatCluster: saddleTop.add(new Vector3(0, -0.05, 0.08)),
    saddleTop,
    barClamp,
    hood,
    wheelbase,
    footTilt: -1.2,
    seatBackTop: saddleTop.add(seatUp.scale(spec.seatTube)),
  };
}

/**
 * Unicycle key points: both axles are the one hub (also the bottom bracket), `seatCluster` the crown
 * above the tyre, `saddleTop` straight above the hub, `barClamp` the T-bar's cross piece ahead of the
 * saddle and `hood` its right grip. The steering points collapse onto the crown.
 */
function unicyclePoints(spec: FrameSpec): BikePoints {
  const r = spec.wheelRadius;
  const axle = new Vector3(0, r, 0);
  const up = new Vector3(0, 1, 0);
  const crown = axle.add(new Vector3(0, spec.stack, 0));
  const saddleTop = axle.add(new Vector3(0, spec.saddleHeight, 0));
  const barClamp = saddleTop.add(new Vector3(0, 0.03, spec.reach));
  return {
    spec,
    rearAxle: axle.clone(),
    frontAxle: axle.clone(),
    bb: axle.clone(),
    headTop: crown.clone(),
    headBottom: crown.clone(),
    steerUp: up.clone(),
    seatUp: up.clone(),
    steererTop: crown.clone(),
    seatCluster: crown,
    saddleTop,
    barClamp,
    hood: barClamp.add(new Vector3(spec.barWidth / 2, 0.01, 0)),
    wheelbase: 0,
    footTilt: 0,
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
  shoulderWidth: 0.33,
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
  if (p.spec.layout === 'recumbent') return recumbentPose(p);
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

/**
 * Lying in the seat shell: hips on the seat, the back along the reclined seat, head lifted to look
 * ahead over the feet, hands on the under-seat grips beside the hips with the elbows bent back.
 */
function recumbentPose(p: BikePoints): RiderPose {
  // the seat's normal: the hips and the back lie this far in front of the shell
  const n = new Vector3(0, -p.seatUp.z, p.seatUp.y);
  const hip = p.saddleTop.add(new Vector3(BODY.hipWidth / 2, 0, 0)).add(n.scale(0.09));
  const torsoAngle = p.spec.seatAngle + 4;
  const a = rad(torsoAngle);
  const shoulder = new Vector3(BODY.shoulderWidth / 2, hip.y + Math.sin(a) * BODY.torso, hip.z - Math.cos(a) * BODY.torso);
  const wrist = p.hood.add(new Vector3(0.01, 0.03, -0.03));
  const elbow = solveJoint(shoulder, wrist, BODY.upperArm, BODY.forearm, new Vector3(0.7, -0.3, -0.6));
  const back = new Vector3(0, Math.sin(a), -Math.cos(a));
  const neck = new Vector3(0, shoulder.y + 0.04, shoulder.z + 0.03).add(back.scale(0.03));
  // the head lifts off the headrest towards the road ahead
  const head = neck.add(new Vector3(0, 0.1, 0.07));
  return { hip, shoulder, elbow, wrist, neck, head, torsoAngle };
}
