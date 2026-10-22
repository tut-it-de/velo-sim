import { Color3, Quaternion, Vector3 } from '@babylonjs/core';
import type { HelmetItem } from '@velo/equipment';
import { hex, type MeshKit } from './meshKit';

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const X = v(1, 0, 0);
const UP = v(0, 1, 0);

/**
 * Helmet shell on the head centre `H` (rider space: +y up, +z forward, +x to the rider's left/right
 * symmetric). Head ellipsoid radii are about (0.075, 0.095, 0.1); straps and glasses are added by the
 * cyclist afterwards, at fixed positions, so a shell must cover roughly the same region as `road`.
 */
export function buildHelmet(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  switch (look.shape) {
    case 'aero':
      aero(shell, H, look);
      break;
    case 'tt':
      tt(shell, H, look);
      break;
    case 'retro':
      retro(shell, H, look);
      break;
    case 'mtb':
      mtb(shell, H, look);
      break;
    case 'bubble':
      bubble(shell, H, look);
      break;
    case 'space':
      space(shell, H, look);
      break;
    case 'road':
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

/** Aero road helmet: smoother, rounder and a little longer than `road`, with few small vents and an accent stripe. */
function aero(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  const helmetCol = hex(look.shell);
  const accentCol = hex(look.accent);
  const ventCol = hex(look.vents);
  const hRot = Quaternion.RotationAxis(X, -0.22);
  const cut = 0.62;
  shell.ellipsoid(H.add(v(0, 0.02, -0.02)), v(0.104, 0.1, 0.158), (t, th) => {
    const phi = t * Math.PI * cut;
    const lx = Math.sin(phi) * Math.cos(th);
    const lz = Math.sin(phi) * Math.sin(th);
    const ax = Math.abs(lx);
    if (t > 0.93) return helmetCol;
    // four small front vents by the forehead, two exhaust slots at the tail
    const frontSlot = lz > 0.3 && t > 0.2 && t < 0.7 && ((ax > 0.16 && ax < 0.22) || (ax > 0.3 && ax < 0.36));
    const tailSlot = lz < -0.45 && t > 0.2 && t < 0.7 && ax > 0.2 && ax < 0.3;
    if (frontSlot || tailSlot) return ventCol;
    // accent stripe along the centre line, front to back
    if (ax < 0.05 && lz > -0.8 && lz < 0.8) return accentCol;
    return helmetCol;
  }, hRot, 44, 22, cut);
}

interface Teardrop {
  /** Front tip (z of the nose of the shell) and length to the tail tip, both from the head centre. */
  zFront: number;
  length: number;
  halfWidth: number;
  halfHeight: number;
  /** Lower edge of the open sides; the shell closes underneath towards the tail. */
  edge: number;
  /** How far the tail tip sits below the head centre. */
  drop: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Smooth teardrop shell around the head: round in front, widest over the middle of the head, tapering
 * into a tail. `paint` colours a point (relative to H) and knows whether it lies on the open rim.
 * Returns the top line from front to tail, e.g. for a fin.
 */
function teardrop(shell: MeshKit, H: Vector3, d: Teardrop, paint: (p: Vector3, rim: boolean) => Color3): Vector3[] {
  const s0 = 0.3;
  const env = (s: number) => (s < s0 ? Math.sqrt(Math.max(0, 1 - ((s0 - s) / s0) ** 2)) : Math.cos(((s - s0) / (1 - s0)) * Math.PI * 0.5) ** 0.85);
  const tail = (s: number) => Math.max(0, (s - s0) / (1 - s0));
  const centre = (s: number) => -d.drop * tail(s) ** 1.3;
  shell.grid(112, 72, (u, w) => {
    const s = 1 - u; // columns run from the tail tip to the front
    const e = env(s);
    const yc = centre(s);
    const top = d.halfHeight * e;
    const bottom = top * (1 - 0.45 * tail(s));
    // how far round the section goes: down to the edge, closing underneath towards the tail
    const open = bottom > 1e-6 ? (d.edge - yc) / bottom : -2;
    let phiMax = open <= -1 ? Math.PI : Math.acos(open);
    phiMax += (Math.PI - phiMax) * smooth(0.5, 0.68, s);
    const phi = (2 * w - 1) * phiMax;
    const c = Math.cos(phi);
    const p = v(d.halfWidth * e * Math.sin(phi), yc + (c >= 0 ? top : bottom) * c, d.zFront - d.length * s);
    return [H.add(p), paint(p, phiMax < Math.PI - 1e-3 && Math.abs(2 * w - 1) > 0.975)];
  });
  const ridge: Vector3[] = [];
  for (let k = 0; k <= 20; k++) {
    const s = k / 20;
    ridge.push(v(0, centre(s) + d.halfHeight * env(s), d.zFront - d.length * s));
  }
  return ridge;
}

/**
 * Time-trial helmet: one smooth teardrop from the brow to a tail tip on the upper back. It reaches
 * down over the ears, and its front is a dark wrap-around visor flush with the shell, temple to
 * temple and from the brow down to the nose.
 */
function tt(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  const helmetCol = hex(look.shell);
  const accentCol = hex(look.accent);
  const visorTop = hex('#46698f');
  const visorBottom = hex('#080c12');
  const lensTop = 0.03;
  teardrop(shell, H, { zFront: 0.14, length: 0.45, halfWidth: 0.104, halfHeight: 0.12, edge: -0.042, drop: 0.11 }, (p, rim) => {
    if (p.z > 0.024 && p.y < lensTop + 0.008) {
      if (p.z > 0.032 && p.y < lensTop) return Color3.Lerp(visorTop, visorBottom, Math.min(1, Math.max(0, (lensTop - p.y) / 0.07)));
      return accentCol;
    }
    // accent: the rim along the lower edge and a stripe along the top of the tail
    if (rim || (Math.abs(p.x) < 0.006 && p.y > 0 && p.z < -0.03)) return accentCol;
    return helmetCol;
  });
}

/**
 * Futuristic prototype: an oversized pod that closes round the whole head like a full-face helmet,
 * a mirrored visor from brow to chin wrapping round to the cheeks with a glowing edge, and a sharp
 * fin running over the crown into the short tail.
 */
function space(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  const shellCol = hex(look.shell);
  const finCol = hex(look.accent);
  const visorTop = hex('#5a7aa0');
  const visorMid = hex('#151d2a');
  const visorBottom = hex('#3a1a33');
  const lensTop = 0.04;
  const ridge = teardrop(shell, H, { zFront: 0.16, length: 0.42, halfWidth: 0.118, halfHeight: 0.132, edge: -0.105, drop: 0.09 }, (p, rim) => {
    const front = p.z > 0.01 + Math.abs(p.x) * 0.2;
    if (front && p.y < lensTop + 0.009 && p.y > -0.095) {
      if (p.y < lensTop && p.z > 0.02 + Math.abs(p.x) * 0.2) {
        const g = (lensTop - p.y) / 0.13;
        return g < 0.45 ? Color3.Lerp(visorTop, visorMid, g / 0.45) : Color3.Lerp(visorMid, visorBottom, (g - 0.45) / 0.55);
      }
      return finCol;
    }
    return rim ? finCol : shellCol;
  });
  // crown-and-tail fin: thin sharp blade standing on the top line, from the forehead into the tail
  const fin = ridge.slice(5, 20).map((p, k) => H.add(p.add(v(0, 0.008 + 0.012 * Math.sin((k / 14) * Math.PI), 0))));
  shell.loft(fin, 0.003, fin.map((_, k) => 0.006 + 0.014 * Math.sin((k / 14) * Math.PI)), finCol, { seg: 6, hint: UP, step: 0.012 });
}

/**
 * 1980s leather hairnet: a padded headband at forehead height and five strips running over the crown
 * from front to back. The hair stays visible between the strips.
 */
function retro(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  const leatherCol = hex(look.shell);
  const stitchCol = hex(look.accent);
  // headband: closed loop around the head at y = 0.045, with the padding thickness added
  const band: Vector3[] = [];
  for (let k = 0; k <= 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    band.push(H.add(v(Math.sin(a) * 0.072, 0.045, Math.cos(a) * 0.094)));
  }
  shell.loft(band, 0.007, 0.009, leatherCol, { seg: 10, hint: UP, capStart: false, capEnd: false });
  // strips over the crown: each lies on an ellipsoid just outside the head (radii 0.081, 0.101, 0.106)
  for (let k = -2; k <= 2; k++) {
    const x = k * 0.0235;
    const s = Math.sqrt(1 - (x / 0.081) ** 2);
    const path: Vector3[] = [];
    for (let m = 0; m <= 14; m++) {
      const u = 0.5 + ((Math.PI - 1) * m) / 14;
      path.push(H.add(v(x, 0.101 * s * Math.sin(u), 0.106 * s * Math.cos(u))));
    }
    // stitching: dashes along both lateral edges
    const paint = (t: number, ang: number) => (Math.abs(Math.cos(ang)) > 0.9 && Math.floor(t * 16) % 2 === 0 ? stitchCol : leatherCol);
    shell.loft(path, 0.0105, 0.0065, paint, { seg: 10, hint: UP });
  }
}

/** Trail helmet: deeper at the back, fewer and bigger vents, and a peak over the forehead. */
function mtb(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  const helmetCol = hex(look.shell);
  const ventCol = hex(look.vents);
  const accentCol = hex(look.accent);
  const hRot = Quaternion.RotationAxis(X, -0.28);
  const cut = 0.62;
  shell.ellipsoid(H.add(v(0, 0.014, -0.022)), v(0.104, 0.097, 0.156), (t, th) => {
    const phi = t * Math.PI * cut;
    const lx = Math.sin(phi) * Math.cos(th);
    const lz = Math.sin(phi) * Math.sin(th);
    const ax = Math.abs(lx);
    if (t > 0.93) return helmetCol;
    const vent = t > 0.25 && t < 0.6 && ((ax > 0.2 && ax < 0.34 && lz > -0.4 && lz < 0.6) || (ax < 0.07 && lz > 0.35 && lz < 0.75));
    return vent ? ventCol : helmetCol;
  }, hRot, 44, 22, cut);
  // peak: a thin curved plate over the eyes, sticking out ~5 cm and angled slightly up
  const peak: Vector3[] = [];
  for (let k = 0; k <= 8; k++) {
    const x = -0.068 + (0.136 * k) / 8;
    const z = 0.131 + 0.024 * (1 - (x / 0.068) ** 2);
    peak.push(H.add(v(x, 0.064 + 0.5 * (z - 0.131), z)));
  }
  shell.loft(peak, 0.02, 0.0035, accentCol, { seg: 8, hint: UP });
}

/** Smooth round commuter helmet: no vents, taller than road, lower edge down over the ears, accent rim. */
function bubble(shell: MeshKit, H: Vector3, look: HelmetItem['look']): void {
  const helmetCol = hex(look.shell);
  const rimCol = hex(look.accent);
  const hRot = Quaternion.RotationAxis(X, -0.14);
  const cut = 0.68;
  shell.ellipsoid(H.add(v(0, 0.012, -0.012)), v(0.1, 0.105, 0.125), (t) => (t > 0.94 ? rimCol : helmetCol), hRot, 40, 20, cut);
}

