import {
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
  type Mesh,
  type Scene,
} from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { buildGate, buildSegmentGates } from '../props';
import type { RiderAvatar } from '../rider';
import { buildBuildings } from './buildings';
import { RouteCorridor } from './corridor';
import { FOG_DENSITY, SKY, SUN_DIR } from './env';
import { fitGroundModel } from './ground';
import { BuildingIndex, HeightField } from './heightField';
import type { QualityProfile } from './quality';
import { buildRouteRibbon } from './roadRibbon';
import { buildSideRoads } from './sideRoads';
import { SkyDome } from './sky';
import { RealTerrain } from './terrain';
import { buildVegetation } from './vegetation';
import { LakeWater } from './water';
import { loadWorldData, type Place, type WorldData } from './worldData';

export const REAL_CAMERA_MAX_Z = 60000;

/** What the HUD minimap needs from a real-world map. */
export interface MinimapData {
  lake: Array<Array<[number, number]>>;
  places: Place[];
  attribution: string;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Excludes the lower-detail stand-ins of LOD meshes (Babylon picks them through their master mesh). */
function lodMasters(meshes: Mesh[]): Mesh[] {
  const children = new Set<AbstractMesh>();
  for (const m of meshes) for (const l of m.getLODLevels()) if (l.mesh) children.add(l.mesh);
  return meshes.filter((m) => !children.has(m));
}

/**
 * The real-world scene for a route with map data (terrain from elevation models, OpenStreetMap
 * buildings, trees and streets, the lake with reflections, sky with clouds and rider shadows).
 */
export class RealWorld {
  private shadow: ShadowGenerator | null = null;
  private readonly casters = new Set<Mesh>();

  private constructor(
    private readonly scene: Scene,
    readonly data: WorldData,
    readonly corridor: RouteCorridor,
    private readonly sun: DirectionalLight,
    private readonly water: LakeWater,
    private readonly sky: SkyDome,
  ) {}

  static async build(scene: Scene, track: Track, quality: QualityProfile, onProgress?: (msg: string) => void): Promise<RealWorld> {
    const step = async (msg: string) => {
      onProgress?.(msg);
      await nextFrame();
    };
    const id = track.definition.world;
    if (!id) throw new Error(`Strecke ${track.definition.id} hat keine Kartendaten`);
    await step('Kartendaten werden geladen …');
    const data = await loadWorldData(id);

    await step('Straßenverlauf wird analysiert …');
    fitGroundModel(data, track);
    const field = new HeightField(data);
    const buildingIndex = new BuildingIndex(data.buildings);
    const corridor = new RouteCorridor(track, field, buildingIndex);

    const fog = Color3.FromHexString(SKY.fog);
    scene.clearColor = new Color4(fog.r, fog.g, fog.b, 1);
    scene.fogMode = 2; // Scene.FOGMODE_EXP2
    scene.fogDensity = FOG_DENSITY;
    scene.fogColor = fog;
    scene.ambientColor = Color3.Black();

    const hemi = new HemisphericLight('sky-light', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.58;
    hemi.diffuse = new Color3(0.86, 0.92, 1);
    hemi.groundColor = new Color3(0.3, 0.29, 0.25);
    hemi.specular = Color3.Black();
    const sun = new DirectionalLight('sun', SUN_DIR.clone(), scene);
    sun.intensity = 1.08;
    sun.diffuse = new Color3(1, 0.95, 0.86);
    sun.specular = new Color3(1, 0.95, 0.86);

    const terrain = await RealTerrain.build(scene, data, field, corridor, quality, step);

    await step('Straße, Mauern und Leitplanken …');
    const ribbon = buildRouteRibbon(scene, corridor, terrain);

    await step('Häuser und Kirchen …');
    const buildings = buildBuildings(scene, data.buildings, corridor, quality);

    await step('Kastanien, Zypressen und Wälder …');
    const trees = buildVegetation(scene, data, corridor, buildingIndex, quality);

    await step('Dorfstraßen und Feldwege …');
    buildSideRoads(scene, data, corridor, quality);

    buildGate(scene, track, 0, 'START · ZIEL', '#ff7a1a');
    buildSegmentGates(scene, track, track.segments);

    await step('See und Himmel …');
    const water = new LakeWater(scene, data, quality);
    // Created last: drawn after the landscape, so the depth test skips most sky pixels.
    const sky = new SkyDome(scene, REAL_CAMERA_MAX_Z * 0.85);
    water.setReflected([
      ...lodMasters(terrain.meshes),
      ...buildings,
      ...(quality.level === 'hoch' ? trees : []),
      sky.mesh,
    ]);

    const world = new RealWorld(scene, data, corridor, sun, water, sky);
    if (quality.shadowMap > 0) {
      const sg = new ShadowGenerator(quality.shadowMap, sun);
      sg.usePercentageCloserFiltering = true;
      sg.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
      sg.bias = 0.002;
      sg.normalBias = 0.015;
      sg.darkness = 0.25;
      sun.autoUpdateExtends = false;
      sun.autoCalcShadowZBounds = false;
      sun.shadowFrustumSize = 22;
      sun.shadowMinZ = 1;
      sun.shadowMaxZ = 140;
      for (const m of ribbon.road) m.receiveShadows = true;
      world.shadow = sg;
    }
    return world;
  }

  get minimap(): MinimapData {
    return { lake: this.data.lake, places: this.data.places, attribution: this.data.attribution };
  }

  /** Riders cast real shadows when the quality profile has shadow maps; the blob stays as contact shadow. */
  addRider(avatar: RiderAvatar): void {
    if (!this.shadow) return;
    (avatar.blob.material as { alpha: number }).alpha = 0.16;
    const map = this.shadow.getShadowMap();
    for (const m of avatar.bodyMeshes) {
      if (this.casters.has(m)) continue;
      this.casters.add(m);
      map?.renderList?.push(m);
    }
  }

  removeRider(avatar: RiderAvatar): void {
    const list = this.shadow?.getShadowMap()?.renderList;
    for (const m of avatar.bodyMeshes) {
      this.casters.delete(m);
      if (list) {
        const k = list.indexOf(m);
        if (k >= 0) list.splice(k, 1);
      }
    }
  }

  /** Per frame: animated water and clouds, shadow frustum follows the rider. */
  update(dt: number, camera: Vector3, rider: Vector3): void {
    this.water.update(dt);
    this.sky.update(dt, camera.x, camera.z);
    if (this.shadow) this.sun.position.copyFrom(rider).subtractInPlace(SUN_DIR.scale(70));
  }

  /** Materials that animate every frame must not stay frozen after `scene.freezeMaterials()`. */
  afterFreeze(): void {
    this.water.material.unfreeze();
    this.sky.material.unfreeze();
  }

  dispose(): void {
    this.water.dispose();
    this.shadow?.dispose();
  }
}
