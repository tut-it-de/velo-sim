import { useEffect, useState } from 'react';
import { ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HemisphericLight, ImageProcessingConfiguration, Scene, Vector3, type AbstractMesh } from '@babylonjs/core';
import { STARTER_LOADOUT, type EquipmentItem } from '@velo/equipment';
import { RiderAvatar } from '../game/rider';
import { lookFromLoadout } from '../game/look';

/**
 * Pictures of the garage items, rendered once with the real 3D models on a hidden canvas:
 * bikes and wheels from the side, helmets and jerseys on the rider.
 */
const W = 360;
const H = 220;
const cache = new Map<string, string>();
let renderer: { engine: Engine; scene: Scene; cam: ArcRotateCamera } | undefined;
let queue: Promise<unknown> = Promise.resolve();

function getRenderer() {
  if (renderer) return renderer;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const engine = new Engine(canvas, true, { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true }, false);
  engine.setSize(W, H);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  scene.imageProcessingConfiguration.exposure = 1.2;
  const cam = new ArcRotateCamera('thumb-cam', 0, 1.3, 3, Vector3.Zero(), scene);
  cam.fov = 0.5;
  cam.minZ = 0.02; // helmets are looked at from closer than the default 1 m
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.85;
  hemi.groundColor = new Color3(0.3, 0.3, 0.33);
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5), scene);
  sun.intensity = 1.5;
  return (renderer = { engine, scene, cam });
}

/** Camera angle per item type: alpha around the bike (0 = right side), beta from above. */
const VIEW: Record<EquipmentItem['type'], { alpha: number; beta: number; fill: number }> = {
  bike: { alpha: 0.12, beta: 1.42, fill: 1.08 },
  wheels: { alpha: 0.12, beta: 1.42, fill: 1.08 },
  helmet: { alpha: 0.75, beta: 1.15, fill: 1.5 },
  jersey: { alpha: -0.9, beta: 1.2, fill: 1.2 },
};

async function render(item: EquipmentItem): Promise<string> {
  const { engine, scene, cam } = getRenderer();
  const withRider = item.type === 'helmet' || item.type === 'jersey';
  const look = lookFromLoadout({ ...STARTER_LOADOUT, [item.type]: item.id });
  const avatar = new RiderAvatar(scene, 'thumb', look, withRider);
  try {
    avatar.blob.setEnabled(false);
    avatar.setCrankAngle(Math.PI / 2);
    const all = avatar.root.getChildMeshes(false).filter((m) => m !== avatar.blob);
    const focus = (prefix: string[]): AbstractMesh[] => all.filter((m) => prefix.some((p) => m.name.startsWith(p)));
    const target = item.type === 'helmet' ? focus(['thumb-helmet']) : item.type === 'jersey' ? focus(['thumb-body', 'thumb-arm']) : all;
    // One render first, so every node (helmet on the head, arms on the bars) sits in its final place.
    await scene.whenReadyAsync();
    scene.render();
    let min = new Vector3(Infinity, Infinity, Infinity);
    let max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const m of target.length ? target : all) {
      m.refreshBoundingInfo({ applySkeleton: true });
      const b = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, b.minimumWorld);
      max = Vector3.Maximize(max, b.maximumWorld);
    }
    const view = VIEW[item.type];
    const size = max.subtract(min);
    // Fit the larger of height and width (the canvas is wider than tall).
    const extent = Math.max(size.y, Math.max(size.x, size.z) * (H / W));
    cam.setTarget(min.add(max).scale(0.5));
    cam.alpha = view.alpha;
    cam.beta = view.beta;
    cam.radius = ((extent / 2) / Math.tan(cam.fov / 2)) * view.fill;
    scene.render();
    scene.render();
    return engine.getRenderingCanvas()!.toDataURL('image/png');
  } finally {
    avatar.dispose();
  }
}

/** Data URL of the item's picture, rendered on first use (one at a time). */
export function useItemThumb(item: EquipmentItem): string | undefined {
  const [url, setUrl] = useState(() => cache.get(item.id));
  useEffect(() => {
    const hit = cache.get(item.id);
    if (hit) return setUrl(hit);
    let alive = true;
    const job = queue.then(async () => {
      const done = cache.get(item.id) ?? (await render(item));
      cache.set(item.id, done);
      if (alive) setUrl(done);
    });
    queue = job.catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [item]);
  return url;
}
