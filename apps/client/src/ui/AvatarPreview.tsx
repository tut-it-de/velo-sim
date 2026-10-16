import { useEffect, useRef } from 'react';
import { ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HemisphericLight, ImageProcessingConfiguration, Scene, Vector3 } from '@babylonjs/core';
import { RiderAvatar, type RiderLook } from '../game/rider';

/** Slowly turning 3D view of the rider and bike with the given look (garage "try on"). */
export function AvatarPreview({ look }: { look: RiderLook }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<{ scene: Scene; avatar: RiderAvatar | null } | null>(null);

  useEffect(() => {
    const engine = new Engine(canvasRef.current!, true, { alpha: true, premultipliedAlpha: false }, true);
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 0);
    scene.imageProcessingConfiguration.toneMappingEnabled = true;
    scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    scene.imageProcessingConfiguration.exposure = 1.2;
    const cam = new ArcRotateCamera('cam', 0.9, 1.25, 3.1, new Vector3(0, 0.78, 0), scene);
    cam.fov = 0.6;
    cam.useAutoRotationBehavior = true;
    cam.autoRotationBehavior!.idleRotationSpeed = 0.25;
    cam.autoRotationBehavior!.idleRotationWaitTime = 0;
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.8;
    hemi.groundColor = new Color3(0.3, 0.3, 0.33);
    const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5), scene);
    sun.intensity = 1.5;
    sceneRef.current = { scene, avatar: null };
    engine.runRenderLoop(() => {
      sceneRef.current?.avatar?.animate(engine.getDeltaTime() / 1000, 70, 0);
      scene.render();
    });
    const onResize = () => engine.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      sceneRef.current = null;
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.avatar?.dispose();
    s.avatar = new RiderAvatar(s.scene, 'preview', look);
    s.avatar.blob.setEnabled(false);
  }, [look]);

  return <canvas ref={canvasRef} className="avatar-preview" />;
}
