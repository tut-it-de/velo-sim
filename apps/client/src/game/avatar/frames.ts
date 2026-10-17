import { Color3, Curve3, Quaternion, Vector3 } from '@babylonjs/core';
import type { FrameBuild } from '@velo/equipment';
import type { BikePoints, FrameSpec, FrameStyle } from './geometry';
import { AERO, MeshKit, ROUND, SQUIRCLE, frameAt, hex, type LoftOptions, type Paint, type Profile } from './meshKit';
import { brandMark, decalUv, modelMark, type DecalMark, type DecalSlot, type FrameRow, type MarkStyle } from './frameArt';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const lerp = (a: Vector3, b: Vector3, t: number) => Vector3.Lerp(a, b, t);
const smooth = (pts: Vector3[], n = 6) => Curve3.CreateCatmullRomSpline(pts, n, false).getPoints();

/** 12-speed 11–30 cassette. */
export const SPROCKETS = [11, 12, 13, 14, 15, 16, 17, 19, 21, 24, 27, 30];
export const pitchRadius = (teeth: number) => (teeth * 0.0127) / (2 * Math.PI);
export const RING_X = 0.045;
export const SPROCKET_X = (i: number) => 0.064 - i * 0.0036;
const GEAR = 6;

/** Build of bikes that have none in the catalogue (bots, studio): the category's typical frame. */
export function defaultBuild(style: FrameStyle = 'allround'): FrameBuild {
  const b: FrameBuild = { material: 'carbon', tubes: 'squircle', slope: 0.03, stays: 'dropped', fork: 'straight', cockpit: 'classic', seatpost: 'round', paint: 'solid' };
  if (style === 'aero') return { ...b, tubes: 'aero', cockpit: 'integrated', seatpost: 'aero', slope: 0.05 };
  if (style === 'climber') return { ...b, tubes: 'round', stays: 'high' };
  if (style === 'endurance') return { ...b, slope: 0.07, stays: 'high' };
  if (style === 'recumbent') return { ...b, tubes: 'round', stays: 'high' };
  return b;
}

/** What a frame builder gets: the points, the build and the three mesh kits (paint, parts, metal). */
export interface FrameKit {
  P: BikePoints;
  spec: FrameSpec;
  build: FrameBuild;
  paint: MeshKit;
  parts: MeshKit;
  metal: MeshKit;
  frame: Color3;
  accent: Color3;
  /** Brand and model for the lettering; none prints nothing. */
  label?: { brand: string; model: string };
  /** Filled by the builders: the decorated tubes, painted into the frame's decal texture. */
  decals: DecalSlot[];
}

const carbon = hex('#1b1c1f');
const rubber = hex('#141414');
const darkAlloy = hex('#55585e');

/** Colours of a frame: the base colour at a point (fade and split schemes) and lettering on top. */
function scheme(k: FrameKit) {
  const { P, build, frame, accent } = k;
  const zFront = P.headTop.z;
  const zRear = P.rearAxle.z;
  const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  /** Base colour at z; `rear` marks stays and fork for the split scheme. */
  const base = (z: number, rear: boolean): Color3 => {
    if (build.paint === 'fade') return Color3.Lerp(frame, accent, smoothstep(0.3, 0.95, (zFront - z) / (zFront - zRear)));
    if (build.paint === 'split' && rear) return accent;
    return frame;
  };
  const mark = (rear: boolean) => (build.paint === 'split' && rear ? frame : accent);
  /** Paint for a tube from p0 to p1: the base colour, following the scheme along z. */
  const tube = (p0: Vector3, p1: Vector3, rear = false): Paint => (t) => base(p0.z + (p1.z - p0.z) * t, rear);
  return { base, tube, mark };
}

function profileOf(build: FrameBuild): Profile {
  return build.tubes === 'aero' ? AERO : build.tubes === 'squircle' ? SQUIRCLE : ROUND;
}

/** A wordmark to print: style, centre along the tube, cap height as a share of the tube depth, longest run. */
interface Print {
  style: MarkStyle;
  at: number;
  cap: number;
  len: number;
}

/**
 * Prints marks on a tube lofted through `pts` with mid-section half width `w`, half depth `d`:
 * registers the tube's texture row and returns the loft's uv map. Flank lettering is
 * `cap × d` high (d is the half depth across the flank) and turned to read along the tube from
 * either side. The ink is the accent, white or black, whichever stands out most on the paint.
 */
function print(k: FrameKit, row: FrameRow, pts: Vector3[], w: number, d: number, profile: Profile, hint: Vector3 | undefined, prints: Print[], rear = false): LoftOptions['map'] {
  if (!k.label) return undefined;
  const map: LoftOptions['map'] = (t, _a, arc) => decalUv(row, t, arc);
  if (k.decals.some((s) => s.row === row)) return map;
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Vector3.Distance(pts[i]!, pts[i - 1]!);
  let perimeter = 0;
  for (let i = 0; i < 64; i++) {
    const [a0, b0] = profile((i / 64) * Math.PI * 2);
    const [a1, b1] = profile(((i + 1) / 64) * Math.PI * 2);
    perimeter += Math.hypot((a1 - a0) * w, (b1 - b0) * d);
  }
  const T = pts[pts.length - 1]!.subtract(pts[0]!).normalize();
  const side = Vector3.Cross(frameAt(T, hint, null), T).normalize();
  // read left to right: along +T when the screen's right (forwards from the drive side) agrees
  const turn = (out: Vector3) => (Vector3.Dot(out.x > 0 ? Z : Z.negate(), T) >= 0 ? 0 : Math.PI);
  const { base, mark } = scheme(k);
  const along = [0, 0.25, 0.5, 0.75, 1].map((t) => base(pts[0]!.z + (pts[pts.length - 1]!.z - pts[0]!.z) * t, rear));
  const color = ink(along, mark(rear));
  const marks: DecalMark[] = prints.map((p) => ({ style: p.style, at: p.at, cap: p.cap * d, maxLen: p.len * length, color }));
  k.decals.push({ row, length, perimeter, turn: [turn(side), turn(side.negate())], marks });
  return map;
}

/** Lettering colour that stands out on every paint colour of the tube; the accent when it does. */
function ink(paint: Color3[], accent: Color3): string {
  const lum = (c: Color3) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const score = (c: Color3) => Math.min(...paint.map((p) => Math.abs(lum(c) - lum(p)) + 0.35 * Math.hypot(c.r - p.r, c.g - p.g, c.b - p.b)));
  if (score(accent) > 0.32) return accent.toHexString();
  const white = hex('#f4f4f2');
  const black = hex('#141416');
  return (score(white) >= score(black) ? white : black).toHexString();
}

/** Rear derailleur, disc calipers and the chain path from the big ring over `via` to the sprocket. */
function drivetrain(k: FrameKit, topRun: (ringTop: Vector3) => Vector3[]): void {
  const { P, parts, metal, accent } = k;
  const ringR = pitchRadius(52);
  const sprR = pitchRadius(SPROCKETS[GEAR]!);
  const sprX = SPROCKET_X(GEAR);
  const ra = P.rearAxle;
  const uj = ra.add(v(0.07, -0.058, 0.012));
  const lj = ra.add(v(0.07, -0.128, 0.034));
  parts.box(ra.add(v(0.077, -0.028, -0.004)), v(0.016, 0.05, 0.03), carbon, Quaternion.RotationAxis(X, 0.35));
  parts.loft([uj.add(v(0.008, 0, 0)), lj.add(v(0.008, 0, 0))], 0.0025, 0.016, accent, { hint: Z, seg: 8 });
  metal.disc(uj, X, 0.019, 0.007, darkAlloy, 24);
  metal.disc(lj, X, 0.019, 0.007, darkAlloy, 24);
  // Chain: around the big ring, bottom run through the jockey wheels, around the sprocket, top run back.
  const arc = (cy: number, cz: number, r: number, a0: number, a1: number, x: number, n = 10) => {
    const out: Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
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
  chain.push(...topRun(chain[0]!));
  chain.push(chain[0]!.clone());
  metal.loft(chain, 0.0045, 0.0034, hex('#3f4146'), { seg: 6, capStart: false, capEnd: false });
  // Disc-brake calipers.
  parts.box(P.frontAxle.add(v(-0.062, 0.05, -0.04)), v(0.024, 0.05, 0.07), carbon, Quaternion.RotationAxis(X, -0.3));
  parts.box(P.rearAxle.add(v(-0.064, 0.05, 0.05)), v(0.024, 0.045, 0.07), carbon, Quaternion.RotationAxis(X, 0.15));
}

/** Fork blades and crown under the head tube; `wave` bends the blades like Pinarello's Onda fork. */
function fork(k: FrameKit, dk: number, paintAt: (p0: Vector3, p1: Vector3) => Paint): void {
  const { P, spec, paint, build, frame } = k;
  const prof = profileOf(build);
  const up = P.steerUp;
  const ha = (spec.headAngle * Math.PI) / 180;
  for (const sx of [-1, 1]) {
    const crownSide = P.headBottom.subtract(up.scale(0.035)).add(v(0.047 * sx, 0, 0));
    const axleSide = P.frontAxle.add(v(0.053 * sx, 0, 0));
    const onAxis = P.frontAxle.subtract(v(0, Math.cos(ha), Math.sin(ha)).scale(spec.forkOffset)).add(v(0.052 * sx, 0, 0));
    const ctrl =
      build.fork === 'wave'
        ? [crownSide, lerp(crownSide, onAxis, 0.3).add(Z.scale(0.014)), lerp(crownSide, onAxis, 0.62).subtract(Z.scale(0.012)), lerp(crownSide, onAxis, 0.88), axleSide]
        : [crownSide, lerp(crownSide, onAxis, 0.55), lerp(crownSide, onAxis, 0.88), axleSide];
    const blade = smooth(ctrl, 4);
    const bn = blade.length;
    const map = k.label && print(k, 'fork', blade, 0.011, 0.018 * Math.sqrt(dk), prof, Z, [{ style: brandMark(k.label.brand), at: 0.5, cap: 0.75, len: 0.46 }], true);
    paint.loft(blade, blade.map((_, i) => 0.0135 - (0.005 * i) / (bn - 1)), blade.map((_, i) => (0.022 - (0.009 * i) / (bn - 1)) * Math.sqrt(dk)), paintAt(crownSide, axleSide), { profile: prof, hint: Z, seg: 12, map: map || undefined });
    paint.box(P.frontAxle.add(v(0.053 * sx, 0.004, 0)), v(0.008, 0.026, 0.026), frame);
  }
  const crown = P.headBottom.subtract(up.scale(0.022));
  paint.loft([crown.add(v(-0.058, 0, 0)), crown, crown.add(v(0.058, 0, 0))], [0.016, 0.02, 0.016], [0.026 * Math.sqrt(dk), 0.032 * Math.sqrt(dk), 0.026 * Math.sqrt(dk)], paintAt(crown, crown), { hint: Z, profile: prof, seg: 12 });
}

/**
 * Road frame in the brand's build: tube shapes, sloping top tube, stays, fork, cockpit, seat post,
 * paint scheme; alloy frames get round tubes with weld beads.
 */
export function diamondFrame(k: FrameKit): void {
  const { P, spec, build, paint, parts, metal, frame, accent } = k;
  const alu = build.material === 'alu';
  const aero = build.tubes === 'aero';
  const dk = alu ? 1.0 : aero ? Math.max(spec.tubeDepth, 1.6) : build.tubes === 'round' ? Math.min(spec.tubeDepth, 1.05) : spec.tubeDepth;
  const fat = alu ? 1.15 : 1;
  const prof = profileOf(build);
  const { tube, base } = scheme(k);
  const up = P.steerUp;

  // --- Main triangle ---------------------------------------------------------------------------
  const htBot = P.headBottom.subtract(up.scale(0.014));
  const htTop = P.headTop.add(up.scale(0.006));
  paint.loft([htBot, lerp(htBot, htTop, 0.5), htTop], [0.025 * fat, 0.022 * fat, 0.021 * fat], [0.026 * Math.sqrt(dk), 0.024 * Math.sqrt(dk), 0.023 * Math.sqrt(dk)], tube(htBot, htTop), { profile: prof, seg: 16 });
  // Head-tube badge.
  paint.ellipsoid(lerp(htBot, htTop, 0.55).add(Z.scale(0.022 * Math.sqrt(dk))), v(0.012, 0.022, 0.006), accent);

  const seatTop = P.seatCluster.add(P.seatUp.scale(0.045));
  const stFront = P.seatCluster.add(P.seatUp.scale(-0.01)).add(Z.scale(0.004));
  const ttFront = P.headTop.subtract(up.scale(0.03));
  const ttProf = build.tubes === 'round' || alu ? ROUND : SQUIRCLE;
  const ttPts = [ttFront, lerp(ttFront, stFront, 0.5), stFront];
  const label = k.label;
  const ttMap = label && print(k, 'top', ttPts, 0.017 * fat, 0.016 * fat, ttProf, Y, [{ style: modelMark(label.model), at: 0.5, cap: 0.85, len: 0.4 }]);
  paint.loft(ttPts, [0.02 * fat, 0.017 * fat, 0.015 * fat], [0.018 * fat, 0.016 * fat, 0.014 * fat], tube(ttFront, stFront), { hint: Y, seg: 14, profile: ttProf, map: ttMap || undefined });

  const dtTop = P.headBottom.add(up.scale(0.03));
  const dtBot = P.bb.add(v(0, 0.012, 0.012));
  const dtPts = [dtBot, lerp(dtBot, dtTop, 0.15), lerp(dtBot, dtTop, 0.6), dtTop];
  const dtMap = label && print(k, 'down', dtPts, 0.027 * fat, 0.023 * dk * fat, prof, undefined, [{ style: brandMark(label.brand), at: 0.5, cap: 1.05, len: 0.6 }]);
  paint.loft(dtPts, [0.034 * fat, 0.03 * fat, 0.025 * fat, 0.024 * fat], [0.026 * dk * fat, 0.024 * dk * fat, 0.022 * dk * fat, 0.022 * dk * fat], tube(dtBot, dtTop), { profile: prof, seg: 16, map: dtMap || undefined });

  const stBot = P.bb.add(P.seatUp.scale(0.01));
  const mastTop = P.saddleTop.subtract(P.seatUp.scale(0.11));
  const stEnd = build.seatpost === 'mast' ? mastTop : seatTop;
  const stPts = [stBot, lerp(stBot, seatTop, 0.3), seatTop, ...(build.seatpost === 'mast' ? [stEnd] : [])];
  const stMap = label && print(k, 'seat', stPts, 0.017 * fat, 0.018 * dk * fat, prof, undefined, [{ style: brandMark(label.brand), at: build.seatpost === 'mast' ? 0.4 : 0.48, cap: 0.75, len: 0.44 }]);
  paint.loft(stPts, [0.024 * fat, 0.017 * fat, 0.016 * fat, ...(build.seatpost === 'mast' ? [0.016] : [])], [0.022 * Math.sqrt(dk) * fat, 0.018 * dk * fat, 0.017 * dk * fat, ...(build.seatpost === 'mast' ? [0.017 * dk] : [])], tube(stBot, stEnd), { profile: prof, seg: 14, map: stMap || undefined });
  if (build.seatpost !== 'mast') parts.disc(seatTop.subtract(P.seatUp.scale(0.006)), P.seatUp, 0.019 * Math.max(1, dk * 0.8), 0.014, carbon, 16);

  paint.disc(P.bb, X, 0.024 * fat, 0.088, base(P.bb.z, false), 20);

  // --- Rear triangle ---------------------------------------------------------------------------
  const ssTop = P.seatCluster.subtract(P.seatUp.scale(spec.stayDrop));
  for (const sx of [-1, 1]) {
    const cs0 = P.bb.add(v(0.032 * sx, 0.004, -0.018));
    const cs1 = lerp(P.bb, P.rearAxle, 0.45).add(v(0.052 * sx, sx > 0 ? -0.006 : 0.004, 0));
    const cs2 = P.rearAxle.add(v(0.062 * sx, 0.01, 0.022));
    paint.loft(smooth([cs0, cs1, cs2], 4), [0.015, 0.013, 0.011, 0.01, 0.009, 0.008, 0.0075, 0.007, 0.0068].map((x) => x * fat), [0.021, 0.019, 0.017, 0.015, 0.013, 0.012, 0.011, 0.01, 0.0095].map((x) => x * fat), tube(cs0, cs2, true), { profile: alu ? ROUND : SQUIRCLE, seg: 10 });
    const ss0 = ssTop.add(v(0.012 * sx, 0, -0.012));
    const ss2 = P.rearAxle.add(v(0.06 * sx, 0.02, 0.006));
    const ctrl =
      build.stays === 'wave'
        ? [ss0, lerp(ss0, ss2, 0.3).add(v(0.034 * sx, 0.018, 0)), lerp(ss0, ss2, 0.62).add(v(0.04 * sx, -0.016, 0)), ss2]
        : [ss0, lerp(ss0, ss2, 0.35).add(v(0.03 * sx, 0, 0)), ss2];
    paint.loft(smooth(ctrl, 4), smooth(ctrl, 4).map((_, i, all) => (0.0095 - (0.0035 * i) / (all.length - 1)) * fat), aero ? 0.012 : 0.0095 * fat, tube(ss0, ss2, true), { hint: Z, seg: 10 });
    paint.box(P.rearAxle.add(v(0.062 * sx, 0.006, 0.006)), v(0.008, 0.03, 0.034), base(P.rearAxle.z, true));
  }
  if (build.window) {
    // the top tube carries on behind the seat tube and curves down into the stays around an opening
    const back = P.seatCluster.subtract(Z.scale(0.075)).subtract(P.seatUp.scale(0.02));
    const pts = smooth([stFront.subtract(Z.scale(0.01)), back, lerp(back, ssTop.subtract(Z.scale(0.012)), 0.6), ssTop.subtract(Z.scale(0.012))], 4);
    paint.loft(pts, 0.014, 0.013, tube(stFront, ssTop, true), { hint: Z, seg: 12, profile: SQUIRCLE });
  }
  fork(k, dk, (p0, p1) => tube(p0, p1, true));

  if (alu) {
    // weld beads where the tubes meet
    const bead = (at: Vector3, axis: Vector3, r: number) => paint.disc(at, axis, r, 0.009, Color3.Lerp(base(at.z, false), Color3.Black(), 0.08), 16);
    bead(ttFront.add(stFront.subtract(ttFront).normalize().scale(0.012)), stFront.subtract(ttFront), 0.022);
    bead(dtTop.subtract(dtTop.subtract(dtBot).normalize().scale(0.012)), dtTop.subtract(dtBot), 0.03);
    bead(dtBot.add(dtTop.subtract(dtBot).normalize().scale(0.03)), dtTop.subtract(dtBot), 0.04);
    bead(P.seatCluster.subtract(P.seatUp.scale(0.02)), P.seatUp, 0.02);
  }

  // --- Cockpit ---------------------------------------------------------------------------------
  parts.disc(lerp(P.headTop, P.steererTop, 0.45), up, 0.0185, spec.spacers + 0.01, carbon, 16);
  parts.disc(P.steererTop.subtract(up.scale(0.021)), up, 0.0205, 0.042, carbon, 16);
  parts.disc(P.steererTop.add(up.scale(0.002)), up, 0.016, 0.006, darkAlloy, 16);
  const stemStart = P.steererTop.subtract(up.scale(0.021));
  const c = P.barClamp;
  if (build.cockpit === 'vstem') {
    // two arms splaying from the steerer to the bar
    for (const sx of [-1, 1]) parts.loft([stemStart.add(v(0.008 * sx, 0, 0)), c.add(v(0.045 * sx, 0, 0))], 0.0075, 0.016, carbon, { profile: SQUIRCLE, seg: 10, hint: Y });
  } else {
    parts.loft([stemStart, c], [0.017, 0.0165], build.cockpit === 'integrated' ? [0.02, 0.018] : [0.019, 0.0175], carbon, { profile: SQUIRCLE, seg: 12, hint: Y });
    if (build.cockpit === 'classic') parts.disc(c.add(Z.scale(0.008)), X, 0.0215, 0.044, carbon, 16);
  }
  const flatTops = build.cockpit !== 'classic';
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
    const w = pts.map((_, i) => (tops(i) ? (flatTops ? 0.022 : 0.0158) : 0.0125));
    const d = pts.map((_, i) => (tops(i) ? (flatTops ? 0.0085 : 0.0158) : 0.0125));
    parts.loft(pts, w, d, (t) => (t < 0.18 ? carbon : rubber), { hint: Y, seg: 10, capStart: false });
    parts.disc(pts[n - 1]!, pts[n - 1]!.subtract(pts[n - 2]!), 0.0128, 0.004, darkAlloy, 10);
    const h0 = c.add(v(0.199 * hw * sx, 0.004, 0.064 * (spec.barReach / 0.08)));
    const hood = smooth([h0, h0.add(v(0.002 * sx, 0.014, 0.03)), h0.add(v(0.004 * sx, 0.026, 0.055)), h0.add(v(0.004 * sx, 0.034, 0.068))], 3);
    parts.loft(hood, hood.map((_, i) => 0.017 - i * 0.0006), hood.map((_, i) => 0.021 - i * 0.0008), rubber, { hint: Y, seg: 12 });
    const lv0 = h0.add(v(0.004 * sx, 0.012, 0.06));
    const lever = smooth([lv0, lv0.add(v(0.002 * sx, -0.05, 0.012)), lv0.add(v(0.006 * sx, -0.1, -0.004)), lv0.add(v(0.008 * sx, -0.12, -0.022))], 3);
    parts.loft(lever, lever.map((_, i) => 0.0075 - i * 0.0003), lever.map((_, i) => 0.013 - i * 0.0005), carbon, { hint: Z, seg: 8 });
  }

  // --- Saddle and post -------------------------------------------------------------------------
  const clamp = P.saddleTop.subtract(P.seatUp.scale(0.05));
  if (build.seatpost === 'mast') {
    // seat mast topper over the frame's mast
    parts.loft([mastTop.subtract(P.seatUp.scale(0.03)), clamp], 0.019, 0.021, carbon, { profile: SQUIRCLE, seg: 12 });
  } else {
    const aeroPost = build.seatpost === 'aero';
    parts.loft([seatTop.subtract(P.seatUp.scale(0.02)), clamp], aeroPost ? 0.011 : 0.0136, aeroPost ? 0.019 : 0.0136, carbon, { profile: aeroPost ? AERO : ROUND, seg: 12 });
  }
  parts.box(clamp.add(P.seatUp.scale(0.012)), v(0.03, 0.02, 0.05), darkAlloy);
  saddle(k);

  // --- Drivetrain ------------------------------------------------------------------------------
  const fd = P.bb.add(P.seatUp.scale(0.135));
  parts.box(fd.add(v(0.034, -0.012, 0.03)), v(0.02, 0.032, 0.07), carbon, Quaternion.RotationAxis(X, -0.25));
  parts.box(fd.add(v(0.018, 0.01, 0.006)), v(0.028, 0.03, 0.026), carbon);
  drivetrain(k, () => []);

  // Bottles and cages on the down and seat tube.
  const dtDir = dtTop.subtract(dtBot).normalize();
  const dtUp = v(0, dtDir.z, -dtDir.y);
  const stFwd = v(0, -P.seatUp.z, P.seatUp.y);
  const bottle = (at: Vector3, axis: Vector3, off: Vector3) => {
    const b0 = at.add(off);
    parts.lathe(b0, axis, [[0.001, 0], [0.034, 0.002], [0.037, 0.02], [0.036, 0.08], [0.033, 0.1], [0.037, 0.12], [0.037, 0.17], [0.03, 0.195], [0.016, 0.205], [0.012, 0.225], [0.001, 0.228]], (t) => (t > 0.3 && t < 0.55 ? accent : t > 0.75 ? carbon : hex('#e9eaec')), 18);
    for (const sx of [-1, 1]) parts.loft([b0.add(axis.scale(0.01)).add(v(0.033 * sx, 0, 0)).subtract(off.normalizeToNew().scale(0.02)), b0.add(axis.scale(0.15)).add(v(0.035 * sx, 0, 0))], 0.003, 0.004, carbon, { seg: 5 });
  };
  bottle(lerp(dtBot, dtTop, 0.2), dtDir, dtUp.scale(0.026 * dk * fat + 0.04));
  bottle(lerp(stBot, seatTop, 0.17), P.seatUp, stFwd.scale(0.018 * dk * fat + 0.041));
  void frame;
  void metal;
}

/** Road saddle on its rails at the saddle top. */
function saddle(k: FrameKit): void {
  const { P, parts, metal, accent } = k;
  const sy = P.saddleTop.y - 0.018;
  const sz = P.saddleTop.z + 0.005;
  const line = smooth([v(0, sy + 0.006, sz - 0.115), v(0, sy, sz - 0.08), v(0, sy - 0.002, sz), v(0, sy - 0.002, sz + 0.07), v(0, sy - 0.006, sz + 0.15)], 4);
  const sw = (z: number) => {
    const t = (z - (sz - 0.115)) / 0.265;
    return t < 0.15 ? 0.05 + t * 0.12 : t < 0.4 ? 0.068 - (t - 0.15) * 0.06 : Math.max(0.017, 0.053 - (t - 0.4) * 0.15);
  };
  parts.loft(line, line.map((q) => sw(q.z)), line.map((_, i) => (i === 0 ? 0.012 : 0.02)), (t, a) => (t < 0.1 && Math.sin(a) > 0.2 ? accent : carbon), { hint: Y, seg: 16, profile: (a) => [Math.cos(a), Math.sin(a) > 0 ? Math.sin(a) * 0.9 : Math.sin(a) * 0.5] });
  for (const sx of [-1, 1]) metal.loft([v(0.03 * sx, sy - 0.022, sz - 0.08), v(0.02 * sx, sy - 0.034, sz - 0.02), v(0.02 * sx, sy - 0.034, sz + 0.05), v(0.01 * sx, sy - 0.024, sz + 0.12)], 0.0035, 0.0035, darkAlloy, { seg: 6 });
}

/**
 * High racer: a carbon main beam from the head tube under the seat into the rear stays, a boom up to
 * the bottom bracket over the front wheel, a reclined seat shell with headrest, under-seat steering
 * linked to the fork and a long chain over an idler under the seat.
 */
export function recumbentFrame(k: FrameKit): void {
  const { P, paint, parts, metal, frame, accent } = k;
  const { tube } = scheme(k);
  const S = P.saddleTop;
  const up = P.seatUp;
  const n = v(0, -up.z, up.y); // seat normal, towards the rider

  // --- Head tube, fork, main beam, boom ----------------------------------------------------------
  const htBot = P.headBottom.subtract(P.steerUp.scale(0.014));
  const htTop = P.headTop.add(P.steerUp.scale(0.01));
  paint.loft([htBot, htTop], 0.026, 0.028, frame, { seg: 16 });
  fork(k, 1.1, (p0, p1) => tube(p0, p1));
  paint.disc(P.steererTop.add(P.steerUp.scale(0.004)), P.steerUp, 0.017, 0.008, darkAlloy, 16);

  const under = v(0, S.y - 0.13, S.z - 0.02);
  const beam = smooth([lerp(htBot, htTop, 0.55), v(0, 0.66, 0.28), v(0, 0.58, 0.08), under], 5);
  const label = k.label;
  const beamMap = label && print(k, 'down', beam, 0.026, 0.035, SQUIRCLE, Y, [{ style: brandMark(label.brand), at: 0.5, cap: 0.75, len: 0.42 }]);
  paint.loft(beam, beam.map((_, i) => 0.03 - (0.008 * i) / (beam.length - 1)), beam.map((_, i) => 0.04 - (0.01 * i) / (beam.length - 1)), tube(beam[0]!, under), { hint: Y, seg: 16, profile: SQUIRCLE, map: beamMap || undefined });
  const boomStart = lerp(htBot, htTop, 0.9).subtract(Z.scale(0.01));
  const boom = smooth([boomStart, lerp(boomStart, P.bb, 0.5).add(Z.scale(-0.015)), P.bb.subtract(v(0, 0.01, 0.01))], 4);
  const boomMap = label && print(k, 'top', boom, 0.021, 0.024, ROUND, Z, [{ style: modelMark(label.model), at: 0.42, cap: 0.6, len: 0.5 }]);
  paint.loft(boom, 0.021, 0.024, tube(boomStart, P.bb), { hint: Z, seg: 14, map: boomMap || undefined });
  paint.disc(P.bb, X, 0.024, 0.088, frame, 20);
  // front derailleur on the boom below the rings
  const fd = lerp(P.bb, boomStart, 0.32);
  parts.box(fd.add(v(0.034, 0.012, 0.03)), v(0.02, 0.032, 0.06), carbon, Quaternion.RotationAxis(X, 0.6));
  parts.box(fd.add(v(0.018, 0, 0.006)), v(0.028, 0.03, 0.026), carbon);

  // --- Rear end ------------------------------------------------------------------------------------
  const stayTop = S.add(up.scale(0.3)).subtract(n.scale(0.05));
  for (const sx of [-1, 1]) {
    const cs0 = under.add(v(0.022 * sx, 0, -0.01));
    const cs2 = P.rearAxle.add(v(0.062 * sx, 0.01, 0.02));
    paint.loft(smooth([cs0, lerp(cs0, cs2, 0.5).add(v(0.04 * sx, 0, 0)), cs2], 4), [0.016, 0.014, 0.012, 0.011, 0.01, 0.0095, 0.009, 0.0085, 0.008], [0.022, 0.02, 0.018, 0.016, 0.014, 0.012, 0.011, 0.01, 0.01], tube(cs0, cs2, true), { profile: SQUIRCLE, seg: 10 });
    const ss0 = stayTop.add(v(0.05 * sx, 0, 0));
    const ss2 = P.rearAxle.add(v(0.06 * sx, 0.02, 0.006));
    paint.loft(smooth([ss0, lerp(ss0, ss2, 0.4).add(v(0.02 * sx, 0, 0)), ss2], 4), 0.009, 0.011, tube(ss0, ss2, true), { hint: Z, seg: 10 });
    paint.box(P.rearAxle.add(v(0.062 * sx, 0.006, 0.006)), v(0.008, 0.03, 0.034), frame);
  }

  // --- Seat shell, pad, headrest -----------------------------------------------------------------
  const seatLine = [
    S.add(v(0, 0.015, 0.17)),
    S.add(v(0, -0.02, 0.08)),
    S.subtract(n.scale(0.02)),
    S.add(up.scale(0.2)).subtract(n.scale(0.02)),
    S.add(up.scale(0.42)).subtract(n.scale(0.02)),
    S.add(up.scale(0.62)).subtract(n.scale(0.02)),
  ];
  const shell = smooth(seatLine, 5);
  const widths = [0.13, 0.17, 0.19, 0.2, 0.19, 0.15];
  const at = (i: number, all: Vector3[], arr: number[]) => {
    const f = (i / (all.length - 1)) * (arr.length - 1);
    const j = Math.min(arr.length - 2, Math.floor(f));
    return arr[j]! + (arr[j + 1]! - arr[j]!) * (f - j);
  };
  // a bucket: the flanks rise towards the rider
  const bucket: Profile = (a) => [Math.cos(a), Math.sin(a) + 2.4 * Math.cos(a) ** 4];
  // the seat's normal axis points at the rider all along the shell
  parts.loft(shell, shell.map((_, i, all) => at(i, all, widths)), 0.014, (t, a) => (Math.abs(Math.cos(a)) > 0.93 ? accent : carbon), { hint: n, seg: 20, profile: bucket });
  const pad = smooth([seatLine[1]!, seatLine[2]!, seatLine[3]!, seatLine[4]!].map((p) => p.add(n.scale(0.016))), 4);
  parts.loft(pad, pad.map((_, i, all) => at(i, all, [0.13, 0.15, 0.15, 0.14])), 0.008, hex('#2a2d33'), { hint: n, seg: 16 });
  const headrest = S.add(up.scale(0.64)).add(n.scale(0.035));
  parts.ellipsoid(headrest, v(0.075, 0.035, 0.05), hex('#2a2d33'), Quaternion.RotationAxis(X, -(P.spec.seatAngle * Math.PI) / 180), 14, 10);
  // seat mounts on the beam and the stays
  for (const sx of [-1, 1]) {
    parts.loft([under.add(v(0.03 * sx, 0.02, 0.04)), S.add(v(0.06 * sx, -0.02, 0.03))], 0.006, 0.01, carbon, { seg: 8 });
    parts.loft([stayTop.add(v(0.05 * sx, 0, 0)), stayTop.add(v(0.06 * sx, 0, 0)).add(n.scale(0.03))], 0.006, 0.008, carbon, { seg: 8 });
  }

  // --- Under-seat steering -----------------------------------------------------------------------
  const c = P.barClamp;
  const bw = P.spec.barWidth / 2;
  parts.loft([v(0, under.y, c.z), c], 0.012, 0.012, carbon, { seg: 10 });
  parts.loft([c.add(v(-bw, 0, 0)), c, c.add(v(bw, 0, 0))], 0.011, 0.011, carbon, { hint: Y, seg: 10 });
  for (const sx of [-1, 1]) {
    const grip = P.hood;
    const g = v(grip.x * sx, grip.y, grip.z);
    const riser = smooth([c.add(v(bw * sx, 0, 0)), c.add(v((bw + 0.012) * sx, 0.06, 0)), g.subtract(v(0, 0.02, 0.06))], 4);
    parts.loft(riser, 0.011, 0.011, carbon, { seg: 10 });
    parts.loft([g.subtract(Z.scale(0.075)), g.add(Z.scale(0.05))], 0.016, 0.016, (t) => (t < 0.06 || t > 0.94 ? darkAlloy : rubber), { seg: 12 });
    // brake lever and shifter ahead of the grip
    parts.loft([g.add(v(0, 0.012, 0.05)), g.add(v(0.035 * sx, 0.018, 0.09))], 0.005, 0.009, carbon, { seg: 6 });
  }
  // linkage rod from the steering pivot to the fork's steering arm
  const arm = P.headBottom.subtract(P.steerUp.scale(0.03)).add(v(0.06, 0, -0.05));
  parts.loft([P.headBottom.subtract(P.steerUp.scale(0.03)).add(v(0.02, 0, -0.01)), arm], 0.006, 0.012, carbon, { seg: 6 });
  metal.loft([c.add(v(0.06, -0.01, 0.01)), arm], 0.0045, 0.0045, darkAlloy, { seg: 6 });

  // --- Chain over an idler under the seat ---------------------------------------------------------
  const idler = v(0.044, under.y - 0.05, under.z + 0.16);
  metal.disc(idler, X, 0.032, 0.012, darkAlloy, 24);
  parts.loft([idler.add(v(0, 0.02, 0)), idler.subtract(v(0, 0.012, 0)).add(v(-0.018, 0, 0))], 0.004, 0.014, carbon, { seg: 6 });
  drivetrain(k, (ringTop) => {
    const r = 0.034;
    const out: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI - (Math.PI * i) / 8;
      out.push(v(idler.x, idler.y + Math.sin(a) * r, idler.z + Math.cos(a) * r));
    }
    // chain tube over the top run between the idler and the rings
    parts.loft([out[out.length - 1]!.add(Z.scale(0.05)), ringTop.subtract(Z.scale(0.07)).add(Y.scale(-0.012))], 0.009, 0.009, hex('#202125'), { seg: 8 });
    return out;
  });
}
