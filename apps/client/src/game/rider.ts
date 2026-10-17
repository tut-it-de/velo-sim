import { Color3, Mesh, MeshBuilder, StandardMaterial, TransformNode, type Scene } from '@babylonjs/core';
import { BikeModel, type BikeLook } from './avatar/bike';
import { Cyclist, footPitch, type CyclistLook } from './avatar/cyclist';
import { VapeAction } from './avatar/vape';

export interface RiderLook extends BikeLook, CyclistLook {}

/**
 * Cyclist on a road bike, both built procedurally from real frame geometry and body proportions.
 * Local frame: +z forward, y up, origin on the ground between the wheels. Legs follow the cranks via IK.
 */
export class RiderAvatar {
  readonly root: TransformNode;
  /** Soft contact shadow under the bike (the only shadow when shadow maps are off). */
  readonly blob: Mesh;
  readonly bike: BikeModel;
  readonly cyclist: Cyclist | null;
  private crankAngle = Math.random() * Math.PI * 2;
  private wheelAngle = 0;
  private vapeAction: VapeAction | null = null;

  constructor(
    scene: Scene,
    name: string,
    private readonly look: RiderLook,
    withRider = true,
  ) {
    this.root = new TransformNode(name, scene);
    this.bike = new BikeModel(scene, name, look, this.root);
    this.cyclist = withRider ? new Cyclist(scene, name, look, this.bike.points, this.root) : null;

    const shadow = MeshBuilder.CreateDisc('shadow', { radius: 0.6, tessellation: 24 }, scene);
    shadow.rotation.x = Math.PI / 2;
    // stretched under the wheels: wide under a trike, round under a unicycle
    const layout = this.bike.points.spec.layout;
    shadow.scaling.set(layout === 'trike' ? 1 : 0.5, layout === 'unicycle' ? 0.6 : 1.2, 1);
    shadow.position.y = 0.03;
    const sm = new StandardMaterial(`${name}-shadow`, scene);
    sm.diffuseColor = Color3.Black();
    sm.specularColor = Color3.Black();
    sm.alpha = 0.28;
    sm.zOffset = -4;
    shadow.material = sm;
    shadow.parent = this.root;
    this.blob = shadow;

    for (const m of this.root.getChildMeshes()) {
      m.isPickable = false;
      // Small parts vanish with distance: chain, cassette, rotors, cranks and pedals.
      if (m instanceof Mesh && /-(metal|wheel-metal|crankset|pedal-mesh)$/.test(m.name)) m.addLODLevel(m.name.endsWith('pedal-mesh') ? 25 : 45, null);
    }
    this.updatePose();
  }

  /** Takes the vape out of the back pocket for a puff (built on first use). */
  vape(): void {
    if (!this.cyclist) return;
    this.vapeAction ??= new VapeAction(this.root.getScene(), this.root.name, this.cyclist, this.root, this.look.jerseyAccent ?? this.look.jersey);
    this.vapeAction.start();
  }

  /** Holds the puff at `t` seconds (previews). */
  freezeVape(t: number): void {
    this.vape();
    this.vapeAction?.freeze(t);
  }

  private updatePose(): void {
    const a = this.crankAngle;
    const tilt = this.bike.points.footTilt;
    this.bike.setCrank(a, footPitch(a) + tilt, footPitch(a + Math.PI) + tilt);
    this.cyclist?.setCrank(a, (i, ang) => this.bike.pedal(i, ang));
  }

  /** Advance animation: cadence in rpm, speed in m/s. */
  animate(dt: number, cadence: number, speedMps: number): void {
    this.crankAngle = (this.crankAngle + (cadence / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    this.wheelAngle = (this.wheelAngle + (speedMps / this.bike.points.spec.wheelRadius) * dt) % (Math.PI * 2);
    for (const w of this.bike.wheels) w.rotation.x = this.wheelAngle;
    this.updatePose();
    this.vapeAction?.update(dt);
  }

  /** Fixed crank angle (0 = right crank up), e.g. for previews. */
  setCrankAngle(angle: number): void {
    this.crankAngle = angle;
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

  /** Materials are shared between avatars; only the blob's own material goes with the rider. */
  dispose(): void {
    this.vapeAction?.dispose();
    this.blob.material?.dispose();
    this.root.dispose(false, false);
  }
}
