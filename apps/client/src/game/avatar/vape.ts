import { Color4, DynamicTexture, Mesh, ParticleSystem, Quaternion, TransformNode, Vector3, type Scene } from '@babylonjs/core';
import type { Cyclist } from './cyclist';
import { MeshKit, basis, hex } from './meshKit';
import { avatarMaterials } from './materials';

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Length of the device from the bottom of the fist to the mouthpiece tip, metres. */
const LENGTH = 0.095;

interface Key {
  at: number;
  /** Wrist target (null = on the bar) and the elbow's bend direction. */
  wrist: Vector3 | null;
  bend: Vector3;
}

/**
 * A pod vape in the jersey's back pocket. `start()` plays one puff with the right hand: off the bar
 * to the pocket, up to the mouth, a long draw (the LED glows), lowered to the chest while a cloud
 * streams out of the mouth, back into the pocket and onto the bar.
 */
export class VapeAction {
  private readonly device: TransformNode;
  private readonly led: Mesh;
  private readonly smoke: ParticleSystem;
  private readonly keys: Key[];
  private readonly mouth: Vector3;
  private readonly emitter = Vector3.Zero();
  /** Where the rider was last frame, for the speed the breath starts with. */
  private readonly lastPos = Vector3.Zero();
  private readonly vel = Vector3.Zero();
  /** Seconds since the start, or -1 when idle. */
  private t = -1;
  /** Moments the device is in the hand, the draw, and the exhale. */
  private readonly grab: [number, number];
  private readonly draw: [number, number];
  private readonly exhale: [number, number];

  constructor(
    scene: Scene,
    name: string,
    private readonly cyclist: Cyclist,
    private readonly root: TransformNode,
    accent: string,
  ) {
    const pose = cyclist.pose;
    const H = pose.head;
    this.mouth = H.add(v(0, -0.058, 0.088));
    // back pocket: a third of the way up the back, behind the jersey
    const spine = pose.shoulder.subtract(pose.hip).normalize();
    const back = v(0, spine.z, -spine.y);
    const pocket = Vector3.Lerp(pose.hip, pose.shoulder, 0.32).add(back.scale(0.16));
    pocket.x = 0.1;
    const side = Vector3.Lerp(pose.hip, pose.shoulder, 0.45).add(v(0.3, 0, 0.12));
    side.x = 0.3;
    // in front of the face: fist below and ahead of the mouth, the device pointing up at the lips
    const atMouth = this.mouth.add(v(0.035, -0.095, 0.03));
    const chest = this.mouth.add(v(0.1, -0.27, 0.12));
    const rest = v(0.6, -0.5, -0.5);
    const down = v(0.7, -1, -0.1);
    this.keys = [
      { at: 0, wrist: null, bend: rest },
      { at: 0.55, wrist: side, bend: v(0.5, -0.4, -1) },
      { at: 1.0, wrist: pocket, bend: v(0.6, 0.2, -1) },
      { at: 1.25, wrist: pocket, bend: v(0.6, 0.2, -1) },
      { at: 1.75, wrist: side, bend: v(0.5, -0.4, -1) },
      { at: 2.35, wrist: atMouth, bend: down },
      { at: 4.2, wrist: atMouth, bend: down },
      { at: 4.6, wrist: chest, bend: down },
      { at: 6.2, wrist: chest, bend: down },
      { at: 6.9, wrist: side, bend: v(0.5, -0.4, -1) },
      { at: 7.3, wrist: pocket, bend: v(0.6, 0.2, -1) },
      { at: 7.5, wrist: pocket, bend: v(0.6, 0.2, -1) },
      { at: 8.0, wrist: side, bend: v(0.5, -0.4, -1) },
      { at: 8.6, wrist: null, bend: rest },
    ];
    this.grab = [1.15, 7.4];
    this.draw = [2.4, 4.2];
    this.exhale = [4.35, 5.9];

    // --- Device: flat pod body, coloured band, black mouthpiece, LED window --------------------
    // Built along +y from the bottom (origin) to the mouthpiece tip.
    const kit = new MeshKit();
    const bodyCol = hex(accent);
    const band = hex('#d6d9de');
    kit.loft([v(0, 0.002, 0), v(0, 0.012, 0), v(0, 0.058, 0), v(0, 0.07, 0)], [0.011, 0.013, 0.013, 0.012], [0.006, 0.0075, 0.0075, 0.007], (t) => (t > 0.55 && t < 0.72 ? band : bodyCol), { seg: 14 });
    kit.loft([v(0, 0.07, 0), v(0, 0.08, 0), v(0, LENGTH, 0)], [0.012, 0.009, 0.006], [0.007, 0.005, 0.0028], hex('#0d0d0f'), { seg: 14 });
    const device = kit.build(`${name}-vape`, scene, avatarMaterials(scene).gloss, root);
    const ledKit = new MeshKit();
    ledKit.box(v(0, 0.04, 0.0075), v(0.008, 0.012, 0.002), hex('#7fe8ff'));
    this.led = ledKit.build(`${name}-vape-led`, scene, avatarMaterials(scene).gloss, null);
    this.led.parent = device;
    this.device = device;
    device.rotationQuaternion = new Quaternion();
    device.setEnabled(false);

    // --- Vapour: soft white puffs that stay where they were breathed out ------------------------
    const tex = new DynamicTexture(`${name}-vapour`, { width: 64, height: 64 }, scene, false);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    tex.hasAlpha = true;
    tex.update();
    const ps = new ParticleSystem(`${name}-vapour`, 900, scene);
    ps.particleTexture = tex;
    ps.emitter = this.emitter;
    ps.minEmitBox = v(-0.01, -0.01, -0.01);
    ps.maxEmitBox = v(0.01, 0.01, 0.01);
    ps.color1 = new Color4(0.96, 0.97, 1, 0.35);
    ps.color2 = new Color4(0.9, 0.92, 0.95, 0.25);
    ps.colorDead = new Color4(0.9, 0.92, 0.95, 0);
    ps.addSizeGradient(0, 0.04, 0.06);
    ps.addSizeGradient(0.4, 0.22, 0.3);
    ps.addSizeGradient(1, 0.6, 0.8);
    ps.addColorGradient(0, new Color4(1, 1, 1, 0.38));
    ps.addColorGradient(0.5, new Color4(0.95, 0.96, 0.98, 0.18));
    ps.addColorGradient(1, new Color4(0.92, 0.93, 0.95, 0));
    ps.minLifeTime = 1.6;
    ps.maxLifeTime = 2.8;
    ps.minEmitPower = 0.85;
    ps.maxEmitPower = 1.15;
    ps.addVelocityGradient(0, 1);
    ps.addVelocityGradient(0.3, 0.15);
    ps.addVelocityGradient(1, 0.05);
    ps.gravity = v(0, 0.12, 0);
    ps.minAngularSpeed = -0.6;
    ps.maxAngularSpeed = 0.6;
    ps.minInitialRotation = 0;
    ps.maxInitialRotation = Math.PI * 2;
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.emitRate = 0;
    ps.start();
    this.smoke = ps;
  }

  get active(): boolean {
    return this.t >= 0;
  }

  /** Starts a puff (ignored while one is playing). */
  start(): void {
    if (this.t >= 0) return;
    this.t = 0;
    this.lastPos.copyFrom(this.root.getAbsolutePosition());
    this.vel.setAll(0);
  }

  /** Shows the moment `t` seconds into the puff (previews). */
  freeze(t: number): void {
    this.t = t;
    this.apply(0);
  }

  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    if (dt > 0) {
      const p = this.root.getAbsolutePosition();
      Vector3.LerpToRef(this.vel, p.subtract(this.lastPos).scaleInPlace(1 / dt), Math.min(1, dt * 5), this.vel);
      this.lastPos.copyFrom(p);
    }
    if (this.t >= this.keys[this.keys.length - 1]!.at) {
      this.t = -1;
      this.cyclist.setRightHand(null);
      this.device.setEnabled(false);
      this.smoke.emitRate = 0;
      return;
    }
    this.apply(dt);
  }

  private apply(_dt: number): void {
    const t = this.t;
    const ks = this.keys;
    let i = 0;
    while (i + 2 < ks.length && ks[i + 1]!.at <= t) i++;
    const a = ks[i]!;
    const b = ks[i + 1]!;
    const k = smoothstep(Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))));
    const cy = this.cyclist;
    let fist: Vector3;
    if (!a.wrist && !b.wrist) fist = cy.setRightHand(null);
    else {
      // the bar end of a move starts from the resting wrist
      const wa = a.wrist ?? cy.restWrist;
      const wb = b.wrist ?? cy.restWrist;
      fist = cy.setRightHand(Vector3.Lerp(wa, wb, k), Vector3.Lerp(a.bend, b.bend, k));
    }

    // --- device in the fist: pointing at the lips near the mouth, otherwise along the forearm ---
    const inHand = t >= this.grab[0] && t <= this.grab[1];
    this.device.setEnabled(inHand);
    if (inHand) {
      const toMouth = this.mouth.subtract(fist);
      const near = 1 - Math.min(1, Math.max(0, (toMouth.length() - 0.12) / 0.12));
      const along = v(0, 1, 0).applyRotationQuaternion(cy.rightForearmTurn).applyRotationQuaternion(Quaternion.RotationAxis(v(1, 0, 0), -0.6));
      const up = Vector3.Lerp(along.normalize(), toMouth.normalize(), near).normalize();
      basis(up, v(0, 0, 1), this.device.rotationQuaternion!);
      this.device.position.copyFrom(fist.subtract(up.scale(0.012)));
    }
    const drawing = t >= this.draw[0] && t <= this.draw[1];
    this.led.scaling.setAll(drawing ? 1 : 0.001);

    // --- vapour from the mouth, blown forwards and down, strongest at the start of the breath ---
    const breathing = t >= this.exhale[0] && t <= this.exhale[1];
    if (breathing) {
      const w = this.root.getWorldMatrix();
      Vector3.TransformCoordinatesToRef(this.mouth.add(v(0, -0.01, 0.03)), w, this.emitter);
      // the breath starts with most of the riding speed and is slowed down by the air, so the cloud
      // hangs by the rider for a moment before it drops back
      const dir = Vector3.TransformNormal(v(0.15, -0.35, 1), w).normalize().scale(0.8).add(this.vel.scale(0.85));
      this.smoke.direction1 = dir.add(v(-0.25, -0.15, -0.25));
      this.smoke.direction2 = dir.add(v(0.25, 0.2, 0.25));
      const p = (t - this.exhale[0]) / (this.exhale[1] - this.exhale[0]);
      this.smoke.emitRate = 150 * (1 - p) ** 1.5;
    } else this.smoke.emitRate = 0;
  }

  dispose(): void {
    this.smoke.particleTexture?.dispose();
    this.smoke.dispose();
  }
}
