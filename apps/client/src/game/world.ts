import {
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  UniversalCamera,
  Vector3,
} from '@babylonjs/core';
import { getTrack, type RouteStyle, type Track } from '@velo/routes';
import { buildGate, buildProps, buildSegmentGates, skyDome } from './props';
import { RiderAvatar, type RiderLook } from './rider';
import { buildRoadMesh } from './road';
import { TerrainModel, buildTerrainMesh } from './terrain';

export type CameraMode = 'chase' | 'side' | 'top' | 'pov';

export const CAMERA_MODES: Array<{ id: CameraMode; label: string }> = [
  { id: 'chase', label: 'Verfolger' },
  { id: 'side', label: 'TV' },
  { id: 'top', label: 'Vogel' },
  { id: 'pov', label: 'Fahrer' },
];

export interface RiderFrame {
  distanceM: number;
  lateralM: number;
  speedMps: number;
  cadence: number;
}

const ATMOSPHERE: Record<RouteStyle, { top: string; horizon: string; fog: number; sunDir: [number, number, number] }> = {
  coast: { top: '#3d7fd1', horizon: '#cfe3f3', fog: 0.00026, sunDir: [-0.5, -1, 0.35] },
  hills: { top: '#4a86cf', horizon: '#d8e6ef', fog: 0.0003, sunDir: [0.4, -1, 0.3] },
  alpine: { top: '#2f6fc4', horizon: '#dce9f5', fog: 0.00016, sunDir: [-0.3, -1, -0.45] },
  lake: { top: '#2a64b8', horizon: '#cddcea', fog: 0.0002, sunDir: [0.55, -0.62, 0.55] },
};

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Owns the Babylon engine and the 3D representation of one route.
 * The ride logic calls `setFrameProvider` and the world renders whatever the
 * provider returns each frame.
 */
export class GameWorld {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  readonly track: Track;
  readonly rider: RiderAvatar;
  cameraMode: CameraMode = 'chase';
  private readonly others = new Map<string, RiderAvatar>();
  private frameProvider?: (dt: number) => { me: RiderFrame; others: Array<RiderFrame & { id: string }> };
  private camPos?: Vector3;
  private camLook?: Vector3;
  private disposed = false;

  private constructor(canvas: HTMLCanvasElement, track: Track, look: RiderLook) {
    this.track = track;
    this.engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }, false);
    const ratio = Math.min(window.devicePixelRatio || 1, 1.75);
    this.engine.setHardwareScalingLevel(1 / ratio);
    this.scene = new Scene(this.engine);
    this.scene.skipPointerMovePicking = true;
    this.camera = new UniversalCamera('cam', new Vector3(0, 10, -10), this.scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 22000;
    this.camera.fov = 1.0;
    this.camera.inputs.clear();
    this.rider = new RiderAvatar(this.scene, 'me', look);
  }

  static async create(canvas: HTMLCanvasElement, routeId: string, look: RiderLook, onProgress?: (msg: string) => void): Promise<GameWorld> {
    const track = getTrack(routeId);
    const world = new GameWorld(canvas, track, look);
    const scene = world.scene;
    const style = track.definition.style;
    const atmo = ATMOSPHERE[style];

    const horizon = Color3.FromHexString(atmo.horizon);
    scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = atmo.fog;
    scene.fogColor = horizon;
    skyDome(scene, Color3.FromHexString(atmo.top), horizon);

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.72;
    hemi.groundColor = new Color3(0.32, 0.34, 0.3);
    const sun = new DirectionalLight('sun', new Vector3(...atmo.sunDir), scene);
    sun.intensity = 1.05;
    sun.diffuse = new Color3(1, 0.96, 0.88);

    onProgress?.('Gelände wird erzeugt …');
    await nextFrame();
    const model = new TerrainModel(track, style);
    buildTerrainMesh(scene, model);

    onProgress?.('Straße und Landschaft …');
    await nextFrame();
    buildRoadMesh(scene, track);
    if (model.seaLevel !== null) {
      const sea = MeshBuilder.CreateGround('sea', { width: 60000, height: 60000, subdivisions: 1 }, scene);
      sea.position.y = model.seaLevel;
      const sm = new StandardMaterial('sea-mat', scene);
      sm.diffuseColor = new Color3(0.1, 0.36, 0.52);
      sm.specularColor = new Color3(0.5, 0.5, 0.5);
      sm.specularPower = 64;
      sm.alpha = 0.92;
      sea.material = sm;
      sea.isPickable = false;
    } else {
      // A far ground plane hides the edge of the terrain behind the fog.
      const ground = MeshBuilder.CreateGround('far-ground', { width: 60000, height: 60000, subdivisions: 1 }, scene);
      ground.position.y = track.minElevation - 40;
      const gm = new StandardMaterial('far-ground-mat', scene);
      gm.diffuseColor = new Color3(0.3, 0.42, 0.24);
      gm.specularColor = Color3.Black();
      ground.material = gm;
      ground.isPickable = false;
    }
    buildProps(scene, model);
    buildGate(scene, track, 0, 'START · ZIEL', '#ff7a1a');
    buildSegmentGates(scene, track, track.segments);

    onProgress?.('Shader werden kompiliert …');
    await nextFrame();
    await scene.whenReadyAsync();
    scene.freezeMaterials();

    world.engine.runRenderLoop(() => world.renderFrame());
    window.addEventListener('resize', world.onResize);
    return world;
  }

  private onResize = () => this.engine.resize();

  setFrameProvider(provider: GameWorld['frameProvider']): void {
    this.frameProvider = provider;
  }

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode;
    this.camPos = undefined; // snap instead of flying across the map
  }

  /** Other riders (bots now, multiplayer later). */
  ensureRider(id: string, look: RiderLook): RiderAvatar {
    let r = this.others.get(id);
    if (!r) {
      r = new RiderAvatar(this.scene, `rider-${id}`, look);
      this.others.set(id, r);
    }
    return r;
  }

  removeRider(id: string): void {
    this.others.get(id)?.dispose();
    this.others.delete(id);
  }

  private renderFrame(): void {
    if (this.disposed) return;
    const dt = Math.min(0.1, this.engine.getDeltaTime() / 1000);
    const frame = this.frameProvider?.(dt);
    if (frame) {
      const me = frame.me;
      const p = this.track.positionAt(me.distanceM, me.lateralM);
      this.rider.setPose(p.x, p.y, p.z, p.heading, p.gradePercent);
      this.rider.animate(dt, me.cadence, me.speedMps);
      for (const o of frame.others) {
        const avatar = this.others.get(o.id);
        if (!avatar) continue;
        const q = this.track.positionAt(o.distanceM, o.lateralM);
        avatar.setPose(q.x, q.y, q.z, q.heading, q.gradePercent);
        avatar.animate(dt, o.cadence, o.speedMps);
      }
      this.updateCamera(dt, me);
    }
    this.scene.render();
  }

  private updateCamera(dt: number, me: RiderFrame): void {
    const t = this.track;
    const p = t.positionAt(me.distanceM, me.lateralM);
    const fx = Math.sin(p.heading);
    const fz = Math.cos(p.heading);
    let pos: Vector3;
    let look: Vector3;
    switch (this.cameraMode) {
      case 'side': {
        const ahead = t.positionAt(me.distanceM + 3, me.lateralM + 7);
        pos = new Vector3(ahead.x, ahead.y + 1.6, ahead.z);
        look = new Vector3(p.x, p.y + 0.9, p.z);
        break;
      }
      case 'top': {
        const behind = t.positionAt(me.distanceM - 28, me.lateralM);
        pos = new Vector3(behind.x, behind.y + 32, behind.z);
        look = new Vector3(p.x + fx * 12, p.y, p.z + fz * 12);
        break;
      }
      case 'pov': {
        const eye = t.positionAt(me.distanceM + 0.35, me.lateralM);
        const ahead = t.positionAt(me.distanceM + 25, me.lateralM);
        pos = new Vector3(eye.x, eye.y + 1.55, eye.z);
        look = new Vector3(ahead.x, ahead.y + 1.2, ahead.z);
        break;
      }
      default: {
        const behind = t.positionAt(me.distanceM - 7, me.lateralM - 0.4);
        const ahead = t.positionAt(me.distanceM + 8, me.lateralM);
        pos = new Vector3(behind.x, Math.max(behind.y, p.y) + 2.5, behind.z);
        look = new Vector3(ahead.x, ahead.y + 0.9, ahead.z);
      }
    }
    // Smooth the camera offset relative to the rider (not the absolute position),
    // so turns and hills are eased without the camera falling behind at speed.
    const anchor = new Vector3(p.x, p.y, p.z);
    const relPos = pos.subtract(anchor);
    const relLook = look.subtract(anchor);
    if (!this.camPos || !this.camLook) {
      this.camPos = relPos;
      this.camLook = relLook;
    } else {
      const k = 1 - Math.exp(-dt * (this.cameraMode === 'pov' ? 14 : 4));
      this.camPos = Vector3.Lerp(this.camPos, relPos, k);
      this.camLook = Vector3.Lerp(this.camLook, relLook, k);
    }
    this.camera.position.copyFrom(anchor.add(this.camPos));
    this.camera.setTarget(anchor.add(this.camLook));
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }
}
