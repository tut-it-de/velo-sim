import { Mesh, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import type { FrameBuild } from '@velo/equipment';
import { bikePoints, frameSpec, type BikePoints, type FrameStyle } from './geometry';
import { RING_X, SPROCKETS, SPROCKET_X, defaultBuild, diamondFrame, pitchRadius, recumbentFrame, unicycleFrame, type FrameKit } from './frames';
import { MeshKit, SQUIRCLE, basis, hex } from './meshKit';
import { avatarMaterials, frameMaterial } from './materials';
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
  /** Brand-specific frame build; without it the category's typical frame. */
  build?: FrameBuild;
  /** Brand and model printed on the frame. */
  label?: { brand: string; model: string };
}

const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);
const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const ringR = pitchRadius(52);

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
    const spec = frameSpec(look.frameStyle, look.build ?? {});
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
    const alloy = hex('#a9adb3');
    const darkAlloy = hex('#55585e');
    const build = look.build ?? defaultBuild(look.frameStyle);
    const kit: FrameKit = { P, spec, build, paint, parts, metal, frame, accent, label: look.label, decals: [] };
    if (spec.layout === 'recumbent') recumbentFrame(kit);
    else if (spec.layout === 'unicycle') unicycleFrame(kit);
    else diamondFrame(kit);
    // alloy frames are satin, carbon ones lacquered
    const finish = build.material === 'alu' ? 'satin' : 'gloss';
    paint.build(`${name}-frame`, scene, kit.decals.length ? frameMaterial(scene, finish, kit.decals) : mats[finish], this.root);
    parts.build(`${name}-parts`, scene, mats.satin, this.root);
    metal.build(`${name}-metal`, scene, mats.metal, this.root);


    // --- Crankset (rotates about the BB axis) ----------------------------------------------------
    this.crank = new TransformNode(`${name}-crank`, scene);
    this.crank.parent = this.root;
    this.crank.position.copyFrom(P.bb);
    const ck = new MeshKit();
    const o = Vector3.Zero();
    // a unicycle's cranks go straight into the hub gear: no chainrings
    const uni = spec.layout === 'unicycle';
    if (!uni) {
    ck.lathe(o.add(v(RING_X, 0, 0)), X, [[ringR - 0.026, -0.002], [ringR + 0.003, -0.002], [ringR + 0.003, 0.002], [ringR - 0.026, 0.002], [ringR - 0.026, -0.002]], hex('#2b2d31'), 32, 52);
    const smallR = pitchRadius(36);
    ck.lathe(o.add(v(RING_X - 0.0075, 0, 0)), X, [[smallR - 0.012, -0.002], [smallR + 0.003, -0.002], [smallR + 0.003, 0.002], [smallR - 0.012, 0.002], [smallR - 0.012, -0.002]], hex('#3a3c41'), 32, 36);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const dir = v(0, Math.cos(a), Math.sin(a));
      ck.loft([v(0.05, 0, 0).add(dir.scale(0.012)), v(RING_X + 0.001, 0, 0).add(dir.scale(ringR - 0.022))], 0.004, 0.009, carbon, { hint: X, seg: 6 });
    }
    }
    ck.disc(o, X, 0.012, uni ? 0.15 : 0.138, darkAlloy, 12);
    for (const sx of [-1, 1]) {
      const end = v(0.07 * sx, spec.crank * sx, 0);
      ck.loft([v(0.06 * sx, 0, 0), v(0.064 * sx, Math.min(0.06, spec.crank * 0.4) * sx, 0), end], [0.009, 0.0085, 0.008], [0.021, 0.017, 0.013], carbon, { hint: Z, seg: 10, profile: SQUIRCLE });
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
    // Wheel set: front and rear; a trike's rear axle carries cassette and rotor between two rear
    // wheels; a unicycle has one big wheel with a gear hub.
    type WheelSpec = { at: Vector3; front: boolean; hubOnly?: boolean; cassette: boolean; rotor: boolean };
    const wheelSet: WheelSpec[] =
      spec.layout === 'unicycle'
        ? [{ at: P.rearAxle, front: true, cassette: false, rotor: false }]
        : spec.layout === 'trike'
          ? [
              { at: P.rearAxle, front: false, hubOnly: true, cassette: true, rotor: true },
              ...[-1, 1].map((sx) => ({ at: P.rearAxle.add(v((sx * (spec.rearTrack ?? 0.74)) / 2, 0, 0)), front: true, cassette: false, rotor: false })),
              { at: P.frontAxle, front: true, cassette: false, rotor: true },
            ]
          : [
              { at: P.rearAxle, front: false, cassette: true, rotor: true },
              { at: P.frontAxle, front: true, cassette: false, rotor: true },
            ];
    for (const { at, front, hubOnly, cassette, rotor } of wheelSet) {
      const node = new TransformNode(`${name}-wheel`, scene);
      node.parent = this.root;
      node.position.copyFrom(at);
      const wk = new MeshKit();
      const mk = new MeshKit();
      const R = spec.wheelRadius;
      const tw = spec.tyreWidth / 2;
      const tyre: Array<[number, number]> = [];
      for (let k = 0; k <= 18; k++) {
        const a = (k / 18) * Math.PI * 2;
        tyre.push([R - tw + Math.cos(a) * tw, Math.sin(a) * tw * 0.98]);
      }
      if (hubOnly) {
        // live axle: shaft between the two rear wheels
        mk.loft([v(-(spec.rearTrack ?? 0.74) / 2, 0, 0), v((spec.rearTrack ?? 0.74) / 2, 0, 0)], 0.009, 0.009, darkAlloy, { seg: 10 });
      } else {
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
      // Hub shell, flanges, end caps; the unicycle's gear hub is a fat drum.
      const half = uni ? 0.04 : front ? 0.05 : 0.071;
      const flL = uni ? -0.033 : -0.034;
      const flR = uni ? 0.033 : front ? 0.034 : 0.021;
      const shell = uni ? 0.036 : 0.011;
      wk.lathe(o, X, [[0.006, -half], [shell, -half], [shell, flL - 0.004], [0.024 + (uni ? 0.024 : 0), flL - 0.002], [0.024 + (uni ? 0.024 : 0), flL + 0.002], [shell + 0.001, flL + 0.004], [shell + 0.001, flR - 0.004], [0.024 + (uni ? 0.024 : 0), flR - 0.002], [0.024 + (uni ? 0.024 : 0), flR + 0.002], [shell, flR + 0.004], [shell, half], [0.006, half]], hubCol, 20);
      // Spokes: radial front, two-cross rear (and on the unicycle, 36 of them); bladed.
      const count = uni ? 36 : 24;
      const hubR = uni ? 0.045 : 0.022;
      for (let k = 0; k < count; k++) {
        const left = k % 2 === 0;
        const a = (k / count) * Math.PI * 2;
        const ar = front && !uni ? a : a + (Math.floor(k / 2) % 2 === 0 ? 0.42 : -0.42) * (uni ? 0.6 : 1);
        const fx = left ? flL : flR;
        const h = v(fx, Math.sin(a) * hubR, Math.cos(a) * hubR);
        const rr = v(left ? -0.003 : 0.003, Math.sin(ar) * (inner + 0.002), Math.cos(ar) * (inner + 0.002));
        wk.loft([h, rr], 0.0022, 0.0009, spokeCol, { seg: 4, capStart: false, capEnd: false, step: 1 });
      }
      }
      // Rotor on the left.
      if (rotor) {
      const rotorR = front ? 0.08 : 0.07;
      mk.lathe(v(-0.054, 0, 0), X, [[rotorR - 0.016, -0.0009], [rotorR, -0.0009], [rotorR, 0.0009], [rotorR - 0.016, 0.0009], [rotorR - 0.016, -0.0009]], (_, a) => (Math.floor((a / (Math.PI * 2)) * 36) % 2 ? alloy : hex('#c3c7cc')), 36);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        wk.loft([v(-0.054, Math.sin(a) * 0.018, Math.cos(a) * 0.018), v(-0.054, Math.sin(a + 0.3) * (rotorR - 0.014), Math.cos(a + 0.3) * (rotorR - 0.014))], 0.002, 0.005, carbon, { hint: X, seg: 4 });
      }
      }
      if (cassette) {
        SPROCKETS.forEach((teeth, i) => {
          const r = pitchRadius(teeth);
          mk.lathe(v(SPROCKET_X(i), 0, 0), X, [[0.017, -0.0009], [r + 0.002, -0.0009], [r + 0.002, 0.0009], [0.017, 0.0009]], i % 3 === 0 ? alloy : hex('#8d9197'), 24, teeth);
        });
      }
      if (!wk.empty) wk.build(`${name}-wheel-mesh`, scene, mats.satin, node);
      if (!mk.empty) mk.build(`${name}-wheel-metal`, scene, mats.metal, node);
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

