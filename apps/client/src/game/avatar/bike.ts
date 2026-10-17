import { Curve3, Mesh, Quaternion, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import { bikePoints, frameSpec, type BikePoints, type FrameStyle } from './geometry';
import { AERO, MeshKit, ROUND, SQUIRCLE, basis, hex, type Paint } from './meshKit';
import { avatarMaterials } from './materials';
import { buildRim } from './rimMesh';
import type { WheelLook } from './wheelArt';

export interface BikeLook {
  frame: string;
  frameAccent?: string;
  frameStyle?: FrameStyle;
  rim?: string;
  rimDepthMm?: number;
  /** Full wheel design (finish, decals, hub and spokes); without it the rim is plain `rim`. */
  wheel?: WheelLook;
}

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const lerp = (a: Vector3, b: Vector3, t: number) => Vector3.Lerp(a, b, t);
const smooth = (pts: Vector3[], n = 6) => Curve3.CreateCatmullRomSpline(pts, n, false).getPoints();

/** 12-speed 11–30 cassette. */
const SPROCKETS = [11, 12, 13, 14, 15, 16, 17, 19, 21, 24, 27, 30];
const pitchRadius = (teeth: number) => (teeth * 0.0127) / (2 * Math.PI);
const RING_X = 0.045;
const SPROCKET_X = (i: number) => 0.064 - i * 0.0036;
const GEAR = 6;

/**
 * Procedural road bike: carbon frame with real geometry, deep-section wheels with bladed spokes,
 * 2×12 drivetrain with chain and derailleurs, disc brakes, integrated-looking cockpit, saddle and
 * bottles. The frame, components and wheels are merged per material (≈ 10 draw calls).
 */
export class BikeModel {
  readonly points: BikePoints;
  readonly root: TransformNode;
  readonly wheels: TransformNode[] = [];
  private readonly crank: TransformNode;
  private readonly pedals: TransformNode[] = [];

  constructor(scene: Scene, name: string, look: BikeLook, parent: TransformNode) {
    const spec = frameSpec(look.frameStyle);
    const P = (this.points = bikePoints(spec));
    const mats = avatarMaterials(scene);
    this.root = new TransformNode(`${name}-bike`, scene);
    this.root.parent = parent;

    const paint = new MeshKit();
    const parts = new MeshKit();
    const metal = new MeshKit();
    const frame = hex(look.frame);
    const accent = hex(look.frameAccent ?? look.frame);
    const carbon = hex('#1b1c1f');
    const rubber = hex('#141414');
    const alloy = hex('#a9adb3');
    const darkAlloy = hex('#55585e');
    const dk = spec.tubeDepth;
    const aero = dk > 1.5;
    const prof = aero ? AERO : ROUND;

    /** Frame colour with an accent logo band on both flanks between t0 and t1. */
    const logo = (t0: number, t1: number, base = frame, mark = accent): Paint => (t, a) => {
      const flank = Math.abs(Math.cos(a)) > 0.7;
      if (!flank || t <= t0 || t >= t1) return base;
      // Letter-like blocks of a wordmark.
      const u = (t - t0) / (t1 - t0);
      return (u * 9) % 1 < 0.72 ? mark : base;
    };

    // --- Frame -----------------------------------------------------------------------------------
    const up = P.steerUp;
    const htBot = P.headBottom.subtract(up.scale(0.014));
    const htTop = P.headTop.add(up.scale(0.006));
    paint.loft([htBot, lerp(htBot, htTop, 0.5), htTop], [0.025, 0.022, 0.021], [0.026 * Math.sqrt(dk), 0.024 * Math.sqrt(dk), 0.023 * Math.sqrt(dk)], logo(0.25, 0.75, frame, accent), { profile: prof, seg: 16 });
    // Head-tube badge.
    paint.ellipsoid(lerp(htBot, htTop, 0.55).add(Z.scale(0.022 * Math.sqrt(dk))), v(0.012, 0.022, 0.006), accent);

    const seatTop = P.seatCluster.add(P.seatUp.scale(0.045));
    const stFront = P.seatCluster.add(P.seatUp.scale(-0.01)).add(Z.scale(0.004));
    const ttFront = P.headTop.subtract(up.scale(0.03));
    paint.loft([ttFront, lerp(ttFront, stFront, 0.5), stFront], [0.02, 0.017, 0.015], [0.018, 0.016, 0.014], logo(0.15, 0.3, frame, accent), { hint: Y, seg: 14 });

    const dtTop = P.headBottom.add(up.scale(0.03));
    const dtBot = P.bb.add(v(0, 0.012, 0.012));
    paint.loft([dtBot, lerp(dtBot, dtTop, 0.15), lerp(dtBot, dtTop, 0.6), dtTop], [0.034, 0.03, 0.025, 0.024], [0.026 * dk, 0.024 * dk, 0.022 * dk, 0.022 * dk], logo(0.3, 0.82, frame, accent), { profile: prof, seg: 16 });

    const stBot = P.bb.add(P.seatUp.scale(0.01));
    paint.loft([stBot, lerp(stBot, seatTop, 0.3), seatTop], [0.024, 0.017, 0.016], [0.022 * Math.sqrt(dk), 0.018 * dk, 0.017 * dk], logo(0.62, 0.8, frame, accent), { profile: prof, seg: 14 });
    // Seat clamp collar.
    parts.disc(seatTop.subtract(P.seatUp.scale(0.006)), P.seatUp, 0.019 * Math.max(1, dk * 0.8), 0.014, carbon, 16);

    paint.disc(P.bb, X, 0.024, 0.088, frame, 20);

    for (const side of [-1, 1]) {
      const sx = side;
      // Chain stays: wide at the shell, splay out around the tyre, taper into the dropouts.
      const cs0 = P.bb.add(v(0.032 * sx, 0.004, -0.018));
      const cs1 = lerp(P.bb, P.rearAxle, 0.45).add(v(0.052 * sx, side > 0 ? -0.006 : 0.004, 0));
      const cs2 = P.rearAxle.add(v(0.062 * sx, 0.01, 0.022));
      paint.loft(smooth([cs0, cs1, cs2], 4), [0.015, 0.013, 0.011, 0.01, 0.009, 0.008, 0.0075, 0.007, 0.0068], [0.021, 0.019, 0.017, 0.015, 0.013, 0.012, 0.011, 0.01, 0.0095], frame, { profile: SQUIRCLE, seg: 10 });
      // Seat stays (dropped on aero frames).
      const ss0 = P.seatCluster.subtract(P.seatUp.scale(spec.stayDrop)).add(v(0.012 * sx, 0, -0.012));
      const ss2 = P.rearAxle.add(v(0.06 * sx, 0.02, 0.006));
      const ss1 = lerp(ss0, ss2, 0.35).add(v(0.03 * sx, 0, 0));
      paint.loft(smooth([ss0, ss1, ss2], 4), [0.0095, 0.009, 0.0085, 0.008, 0.0075, 0.007, 0.0065, 0.0062, 0.006], aero ? 0.012 : 0.0095, logo(0.82, 1.01, frame, accent), { hint: Z, seg: 10 });
      // Dropout.
      paint.box(P.rearAxle.add(v(0.062 * sx, 0.006, 0.006)), v(0.008, 0.03, 0.034), frame);
      // Fork blade: straight leg, offset forward near the axle.
      const crownSide = P.headBottom.subtract(up.scale(0.035)).add(v(0.047 * sx, 0, 0));
      const axleSide = P.frontAxle.add(v(0.053 * sx, 0, 0));
      const onAxis = P.frontAxle.subtract(v(0, Math.cos((spec.headAngle * Math.PI) / 180), Math.sin((spec.headAngle * Math.PI) / 180)).scale(spec.forkOffset)).add(v(0.052 * sx, 0, 0));
      const blade = smooth([crownSide, lerp(crownSide, onAxis, 0.55), lerp(crownSide, onAxis, 0.88), axleSide], 4);
      const bn = blade.length;
      paint.loft(blade, blade.map((_, i) => 0.0135 - (0.005 * i) / (bn - 1)), blade.map((_, i) => (0.022 - (0.009 * i) / (bn - 1)) * Math.sqrt(dk)), logo(0.6, 0.93, frame, accent), { profile: prof, hint: Z, seg: 12 });
      paint.box(P.frontAxle.add(v(0.053 * sx, 0.004, 0)), v(0.008, 0.026, 0.026), frame);
    }
    // Fork crown.
    const crown = P.headBottom.subtract(up.scale(0.022));
    paint.loft([crown.add(v(-0.058, 0, 0)), crown, crown.add(v(0.058, 0, 0))], [0.016, 0.02, 0.016], [0.026 * Math.sqrt(dk), 0.032 * Math.sqrt(dk), 0.026 * Math.sqrt(dk)], frame, { hint: Z, profile: prof, seg: 12 });

    // --- Cockpit ---------------------------------------------------------------------------------
    parts.disc(lerp(P.headTop, P.steererTop, 0.45), up, 0.0185, spec.spacers + 0.01, carbon, 16);
    parts.disc(P.steererTop.subtract(up.scale(0.021)), up, 0.0205, 0.042, carbon, 16);
    parts.disc(P.steererTop.add(up.scale(0.002)), up, 0.016, 0.006, darkAlloy, 16);
    const stemStart = P.steererTop.subtract(up.scale(0.021));
    parts.loft([stemStart, P.barClamp], [0.017, 0.0165], [0.019, 0.0175], carbon, { profile: SQUIRCLE, seg: 12, hint: Y });
    parts.disc(P.barClamp.add(Z.scale(0.008)), X, 0.0215, 0.044, carbon, 16);

    const c = P.barClamp;
    const hw = spec.barWidth / 2 / 0.205;
    const barPts = (sx: number) =>
      smooth(
        [
          v(0, 0, 0), v(0.06, 0, 0.001), v(0.14, 0, 0.006), v(0.176, 0.002, 0.03), v(0.195, 0.004, 0.064), v(0.203, -0.006, 0.086),
          v(0.205, -0.042, 0.098), v(0.207, -0.086, 0.086), v(0.208, -0.114, 0.05), v(0.208, -0.125, 0.004), v(0.207, -0.121, -0.03),
        ].map((q) => c.add(v(q.x * hw * sx, q.y * (spec.barDrop / 0.125), q.z * (spec.barReach / 0.08)))),
        5,
      );
    for (const sx of [-1, 1]) {
      const pts = barPts(sx);
      const n = pts.length;
      const tops = (i: number) => Math.abs(pts[i]!.x - c.x) < 0.07;
      const w = pts.map((_, i) => (tops(i) ? (aero ? 0.02 : 0.0158) : 0.0125));
      const d = pts.map((_, i) => (tops(i) ? (aero ? 0.0085 : 0.0158) : 0.0125));
      parts.loft(pts, w, d, (t) => (t < 0.18 ? carbon : rubber), { hint: Y, seg: 10, capStart: false });
      // Bar-end plug.
      parts.disc(pts[n - 1]!, pts[n - 1]!.subtract(pts[n - 2]!), 0.0128, 0.004, darkAlloy, 10);
      // Shifter/brake hood and lever.
      const h0 = c.add(v(0.199 * hw * sx, 0.004, 0.064 * (spec.barReach / 0.08)));
      const hood = smooth([h0, h0.add(v(0.002 * sx, 0.014, 0.03)), h0.add(v(0.004 * sx, 0.026, 0.055)), h0.add(v(0.004 * sx, 0.034, 0.068))], 3);
      parts.loft(hood, hood.map((_, i) => 0.017 - i * 0.0006), hood.map((_, i) => 0.021 - i * 0.0008), rubber, { hint: Y, seg: 12 });
      const lv0 = h0.add(v(0.004 * sx, 0.012, 0.06));
      const lever = smooth([lv0, lv0.add(v(0.002 * sx, -0.05, 0.012)), lv0.add(v(0.006 * sx, -0.1, -0.004)), lv0.add(v(0.008 * sx, -0.12, -0.022))], 3);
      parts.loft(lever, lever.map((_, i) => 0.0075 - i * 0.0003), lever.map((_, i) => 0.013 - i * 0.0005), carbon, { hint: Z, seg: 8 });
    }

    // --- Saddle and post -------------------------------------------------------------------------
    const clamp = P.saddleTop.subtract(P.seatUp.scale(0.05));
    parts.loft([seatTop.subtract(P.seatUp.scale(0.02)), clamp], aero ? 0.011 : 0.0136, aero ? 0.019 : 0.0136, carbon, { profile: prof, seg: 12 });
    parts.box(clamp.add(P.seatUp.scale(0.012)), v(0.03, 0.02, 0.05), darkAlloy);
    const sy = P.saddleTop.y - 0.018;
    const sz = P.saddleTop.z + 0.005;
    const saddle = smooth([v(0, sy + 0.006, sz - 0.115), v(0, sy, sz - 0.08), v(0, sy - 0.002, sz), v(0, sy - 0.002, sz + 0.07), v(0, sy - 0.006, sz + 0.15)], 4);
    const sw = (z: number) => {
      const t = (z - (sz - 0.115)) / 0.265;
      return t < 0.15 ? 0.05 + t * 0.12 : t < 0.4 ? 0.068 - (t - 0.15) * 0.06 : Math.max(0.017, 0.053 - (t - 0.4) * 0.15);
    };
    parts.loft(saddle, saddle.map((q) => sw(q.z)), saddle.map((_, i) => (i === 0 ? 0.012 : 0.02)), (t, a) => (t < 0.1 && Math.sin(a) > 0.2 ? accent : carbon), { hint: Y, seg: 16, profile: (a) => [Math.cos(a), Math.sin(a) > 0 ? Math.sin(a) * 0.9 : Math.sin(a) * 0.5] });
    for (const sx of [-1, 1]) metal.loft([v(0.03 * sx, sy - 0.022, sz - 0.08), v(0.02 * sx, sy - 0.034, sz - 0.02), v(0.02 * sx, sy - 0.034, sz + 0.05), v(0.01 * sx, sy - 0.024, sz + 0.12)], 0.0035, 0.0035, darkAlloy, { seg: 6 });

    // --- Drivetrain ------------------------------------------------------------------------------
    const ringR = pitchRadius(52);
    const sprR = pitchRadius(SPROCKETS[GEAR]!);
    const sprX = SPROCKET_X(GEAR);
    // Front derailleur cage above the big ring.
    const fd = P.bb.add(P.seatUp.scale(0.135));
    parts.box(fd.add(v(0.034, -0.012, 0.03)), v(0.02, 0.032, 0.07), carbon, Quaternion.RotationAxis(X, -0.25));
    parts.box(fd.add(v(0.018, 0.01, 0.006)), v(0.028, 0.03, 0.026), carbon);
    // Rear derailleur: body from the hanger, cage with two jockey wheels.
    const ra = P.rearAxle;
    const uj = ra.add(v(0.07, -0.058, 0.012));
    const lj = ra.add(v(0.07, -0.128, 0.034));
    parts.box(ra.add(v(0.077, -0.028, -0.004)), v(0.016, 0.05, 0.03), carbon, Quaternion.RotationAxis(X, 0.35));
    parts.loft([uj.add(v(0.008, 0, 0)), lj.add(v(0.008, 0, 0))], 0.0025, 0.016, accent, { hint: Z, seg: 8 });
    metal.disc(uj, X, 0.019, 0.007, darkAlloy, 24);
    metal.disc(lj, X, 0.019, 0.007, darkAlloy, 24);
    // Chain: top run, around the big ring, bottom run through the jockey wheels, around the sprocket.
    const arc = (cy: number, cz: number, r: number, a0: number, a1: number, x: number, n = 10) => {
      const out: Vector3[] = [];
      for (let k = 0; k <= n; k++) {
        const a = a0 + ((a1 - a0) * k) / n;
        out.push(v(x, cy + Math.sin(a) * r, cz + Math.cos(a) * r));
      }
      return out;
    };
    const chain = [
      ...arc(P.bb.y, P.bb.z, ringR, Math.PI / 2, -Math.PI / 2, RING_X, 16),
      ...arc(lj.y, lj.z, 0.021, -Math.PI / 2, -Math.PI * 1.15, sprX, 6),
      ...arc(uj.y, uj.z, 0.021, Math.PI * 0.8, 0.1, sprX, 6),
      ...arc(ra.y, ra.z, sprR, -Math.PI * 0.55, -Math.PI * 1.5, sprX, 10),
    ];
    chain.push(chain[0]!.clone());
    metal.loft(chain, 0.0045, 0.0034, hex('#3f4146'), { seg: 6, capStart: false, capEnd: false });
    // Disc-brake calipers.
    parts.box(P.frontAxle.add(v(-0.062, 0.05, -0.04)), v(0.024, 0.05, 0.07), carbon, Quaternion.RotationAxis(X, -0.3));
    parts.box(P.rearAxle.add(v(-0.064, 0.05, 0.05)), v(0.024, 0.045, 0.07), carbon, Quaternion.RotationAxis(X, 0.15));

    // Bottles and cages on the down and seat tube.
    const dtDir = dtTop.subtract(dtBot).normalize();
    const dtUp = v(0, dtDir.z, -dtDir.y);
    const stFwd = v(0, -P.seatUp.z, P.seatUp.y);
    const bottle = (base: Vector3, axis: Vector3, off: Vector3) => {
      const b0 = base.add(off);
      parts.lathe(b0, axis, [[0.001, 0], [0.034, 0.002], [0.037, 0.02], [0.036, 0.08], [0.033, 0.1], [0.037, 0.12], [0.037, 0.17], [0.03, 0.195], [0.016, 0.205], [0.012, 0.225], [0.001, 0.228]], (t) => (t > 0.3 && t < 0.55 ? accent : t > 0.75 ? carbon : hex('#e9eaec')), 18);
      for (const sx of [-1, 1]) parts.loft([b0.add(axis.scale(0.01)).add(v(0.033 * sx, 0, 0)).subtract(off.normalizeToNew().scale(0.02)), b0.add(axis.scale(0.15)).add(v(0.035 * sx, 0, 0))], 0.003, 0.004, carbon, { seg: 5 });
    };
    bottle(lerp(dtBot, dtTop, 0.2), dtDir, dtUp.scale(0.026 * dk + 0.04));
    bottle(lerp(stBot, seatTop, 0.17), P.seatUp, stFwd.scale(0.018 * dk + 0.041));

    paint.build(`${name}-frame`, scene, mats.gloss, this.root);
    parts.build(`${name}-parts`, scene, mats.satin, this.root);
    metal.build(`${name}-metal`, scene, mats.metal, this.root);

    // --- Crankset (rotates about the BB axis) ----------------------------------------------------
    this.crank = new TransformNode(`${name}-crank`, scene);
    this.crank.parent = this.root;
    this.crank.position.copyFrom(P.bb);
    const ck = new MeshKit();
    const o = Vector3.Zero();
    ck.lathe(o.add(v(RING_X, 0, 0)), X, [[ringR - 0.026, -0.002], [ringR + 0.003, -0.002], [ringR + 0.003, 0.002], [ringR - 0.026, 0.002], [ringR - 0.026, -0.002]], hex('#2b2d31'), 32, 52);
    const smallR = pitchRadius(36);
    ck.lathe(o.add(v(RING_X - 0.0075, 0, 0)), X, [[smallR - 0.012, -0.002], [smallR + 0.003, -0.002], [smallR + 0.003, 0.002], [smallR - 0.012, 0.002], [smallR - 0.012, -0.002]], hex('#3a3c41'), 32, 36);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const dir = v(0, Math.cos(a), Math.sin(a));
      ck.loft([v(0.05, 0, 0).add(dir.scale(0.012)), v(RING_X + 0.001, 0, 0).add(dir.scale(ringR - 0.022))], 0.004, 0.009, carbon, { hint: X, seg: 6 });
    }
    ck.disc(o, X, 0.012, 0.138, darkAlloy, 12);
    for (const sx of [-1, 1]) {
      const end = v(0.07 * sx, spec.crank * sx, 0);
      ck.loft([v(0.06 * sx, 0, 0), v(0.064 * sx, 0.06 * sx, 0), end], [0.009, 0.0085, 0.008], [0.021, 0.017, 0.013], carbon, { hint: Z, seg: 10, profile: SQUIRCLE });
      ck.disc(end, X, 0.012, 0.016, carbon, 12);
    }
    ck.build(`${name}-crankset`, scene, mats.satin, this.crank);

    // Pedals (kept level by the rider's feet through setCrank).
    for (const sx of [1, -1]) {
      const node = new TransformNode(`${name}-pedal`, scene);
      node.parent = this.root;
      const pk = new MeshKit();
      pk.disc(v(0.022 * sx, 0, 0), X, 0.005, 0.05, darkAlloy, 8);
      pk.box(v(0.038 * sx, -0.002, 0.004), v(0.064, 0.016, 0.085), carbon);
      pk.box(v(0.038 * sx, 0.007, 0.03), v(0.05, 0.004, 0.03), accent);
      pk.build(`${name}-pedal-mesh`, scene, mats.satin, node);
      this.pedals.push(node);
    }

    // --- Wheels ----------------------------------------------------------------------------------
    const depth = Math.min(0.085, Math.max(0.02, (look.rimDepthMm ?? 30) / 1000));
    const rimCol = hex(look.rim ?? '#1d1f22');
    const hubCol = look.wheel ? hex(look.wheel.hub) : carbon;
    const spokeCol = hex(look.wheel?.spoke ?? '#151515');
    for (const front of [false, true]) {
      const node = new TransformNode(`${name}-wheel`, scene);
      node.parent = this.root;
      node.position.copyFrom(front ? P.frontAxle : P.rearAxle);
      const wk = new MeshKit();
      const mk = new MeshKit();
      const R = spec.wheelRadius;
      const tw = spec.tyreWidth / 2;
      const tyre: Array<[number, number]> = [];
      for (let k = 0; k <= 18; k++) {
        const a = (k / 18) * Math.PI * 2;
        tyre.push([R - tw + Math.cos(a) * tw, Math.sin(a) * tw * 0.98]);
      }
      wk.lathe(o, X, tyre, (t) => (Math.abs(t - 0.5) > 0.4 ? hex('#1f1f1f') : hex('#2a2a2b')), 48);
      const bead = R - spec.tyreWidth + 0.003;
      const inner = bead - depth;
      const hwR = 0.0125;
      const rim: Array<[number, number]> = [
        [bead, hwR], [bead - depth * 0.45, hwR * 1.12], [inner + 0.006, hwR * 0.7], [inner, 0],
        [inner + 0.006, -hwR * 0.7], [bead - depth * 0.45, -hwR * 1.12], [bead, -hwR], [bead, hwR],
      ];
      if (look.wheel) buildRim(scene, `${name}-rim`, node, look.wheel, bead, depth);
      else wk.lathe(o, X, rim, rimCol, 48);
      // Hub shell, flanges, end caps.
      const half = front ? 0.05 : 0.071;
      const flL = -0.034;
      const flR = front ? 0.034 : 0.021;
      wk.lathe(o, X, [[0.006, -half], [0.011, -half], [0.011, flL - 0.004], [0.024, flL - 0.002], [0.024, flL + 0.002], [0.012, flL + 0.004], [0.012, flR - 0.004], [0.024, flR - 0.002], [0.024, flR + 0.002], [0.011, flR + 0.004], [0.011, half], [0.006, half]], hubCol, 16);
      // Spokes: radial front, two-cross rear; bladed.
      const count = 24;
      for (let k = 0; k < count; k++) {
        const left = k % 2 === 0;
        const a = (k / count) * Math.PI * 2;
        const ar = front ? a : a + (Math.floor(k / 2) % 2 === 0 ? 0.42 : -0.42);
        const fx = left ? flL : flR;
        const h = v(fx, Math.sin(a) * 0.022, Math.cos(a) * 0.022);
        const rr = v(left ? -0.003 : 0.003, Math.sin(ar) * (inner + 0.002), Math.cos(ar) * (inner + 0.002));
        wk.loft([h, rr], 0.0022, 0.0009, spokeCol, { seg: 4, capStart: false, capEnd: false, step: 1 });
      }
      // Rotor on the left.
      const rotorR = front ? 0.08 : 0.07;
      mk.lathe(v(-0.054, 0, 0), X, [[rotorR - 0.016, -0.0009], [rotorR, -0.0009], [rotorR, 0.0009], [rotorR - 0.016, 0.0009], [rotorR - 0.016, -0.0009]], (_, a) => (Math.floor((a / (Math.PI * 2)) * 36) % 2 ? alloy : hex('#c3c7cc')), 36);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        wk.loft([v(-0.054, Math.sin(a) * 0.018, Math.cos(a) * 0.018), v(-0.054, Math.sin(a + 0.3) * (rotorR - 0.014), Math.cos(a + 0.3) * (rotorR - 0.014))], 0.002, 0.005, carbon, { hint: X, seg: 4 });
      }
      if (!front) {
        SPROCKETS.forEach((teeth, i) => {
          const r = pitchRadius(teeth);
          mk.lathe(v(SPROCKET_X(i), 0, 0), X, [[0.017, -0.0009], [r + 0.002, -0.0009], [r + 0.002, 0.0009], [0.017, 0.0009]], i % 3 === 0 ? alloy : hex('#8d9197'), 24, teeth);
        });
      }
      wk.build(`${name}-wheel-mesh`, scene, mats.satin, node);
      mk.build(`${name}-wheel-metal`, scene, mats.metal, node);
      this.wheels.push(node);
    }
  }

  /** Crank angle (0 = right crank up, increasing forwards) and the pedal pitch of each foot (radians, toe down > 0). */
  setCrank(angle: number, pitchRight: number, pitchLeft: number): void {
    const dir = new Vector3(0, Math.cos(angle), Math.sin(angle));
    this.crank.rotationQuaternion = basis(dir, new Vector3(0, -Math.sin(angle), Math.cos(angle)), this.crank.rotationQuaternion ?? undefined);
    const spec = this.points.spec;
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1;
      const node = this.pedals[i]!;
      node.position.set(0.07 * s, this.points.bb.y + Math.cos(angle) * spec.crank * s, this.points.bb.z + Math.sin(angle) * spec.crank * s);
      node.rotation.x = i === 0 ? pitchRight : pitchLeft;
    }
  }

  /** Pedal spindle of the right (0) or left (1) side. */
  pedal(i: number, angle: number): Vector3 {
    const s = i === 0 ? 1 : -1;
    const spec = this.points.spec;
    return new Vector3(0.105 * s, this.points.bb.y + Math.cos(angle) * spec.crank * s, this.points.bb.z + Math.sin(angle) * spec.crank * s);
  }

  get meshes(): Mesh[] {
    return this.root.getChildMeshes(false).filter((m): m is Mesh => m instanceof Mesh);
  }
}

