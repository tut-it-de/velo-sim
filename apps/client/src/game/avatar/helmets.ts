import { Quaternion, Vector3 } from '@babylonjs/core';
import type { HelmetItem } from '@velo/equipment';
import { hex, type MeshKit } from './meshKit';

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const X = v(1, 0, 0);

/**
 * Helmet shell on the head centre `H` (rider space: +y up, +z forward, +x to the rider's left/right
 * symmetric). Head ellipsoid radii are about (0.075, 0.095, 0.1); straps and glasses are added by the
 * cyclist afterwards, at fixed positions, so a shell must cover roughly the same region as `road`.
 */
export function buildHelmet(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  switch (look.shape) {
    default:
      road(shell, H, look);
  }
}

/** Classic vented road helmet: shell over the head, lower at the back, dark vents front to back. */
function road(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  const helmetCol = hex(look.shell);
  const ventCol = hex(look.vents);
  const hRot = Quaternion.RotationAxis(X, -0.28);
  const cut = 0.56;
  shell.ellipsoid(H.add(v(0, 0.018, -0.014)), v(0.101, 0.094, 0.146), (t, th) => {
    const phi = t * Math.PI * cut;
    const lx = Math.sin(phi) * Math.cos(th);
    const lz = Math.sin(phi) * Math.sin(th);
    const ax = Math.abs(lx);
    if (t > 0.93) return ventCol;
    const vent = (ax > 0.15 && ax < 0.27) || (ax > 0.43 && ax < 0.53) || (ax < 0.05 && lz > -0.3);
    return vent && lz > -0.75 && lz < 0.82 && t > 0.12 ? ventCol : helmetCol;
  }, hRot, 44, 22, cut);
}
