import { Color3, Color4, DirectionalLight, HemisphericLight, Mesh, Scene, Vector3, VertexData } from '@babylonjs/core';
import type { Track } from '@velo/routes';
import { skyDome } from '../props';

/** One cross-section of the track: centre, forward and right unit vectors (horizontal), distance. */
export interface Frame {
  x: number;
  y: number;
  z: number;
  /** Forward (direction of travel). */
  fx: number;
  fz: number;
  /** Rider's right. */
  rx: number;
  rz: number;
  /** Distance along the lap, m. */
  d: number;
}

/** Cross-sections every `everyM` metres around the lap; the last one repeats the first so loops close. */
export function frames(track: Track, everyM = 4): Frame[] {
  const stride = Math.max(1, Math.round(everyM / track.step));
  const out: Frame[] = [];
  for (let i = 0; i <= track.count; i += stride) {
    const k = i % track.count;
    const h = track.headings[k]!;
    out.push({ x: track.xs[k]!, y: track.ys[k]!, z: track.zs[k]!, fx: Math.sin(h), fz: Math.cos(h), rx: Math.cos(h), rz: -Math.sin(h), d: i * track.step });
  }
  if (out[out.length - 1]!.d < track.length) {
    const f = out[0]!;
    out.push({ ...f, d: track.length });
  }
  return out;
}

/** World position `lateral` metres right of the centre (negative = left), `up` metres above the road. */
export function at(f: Frame, lateral: number, up = 0): Vector3 {
  return new Vector3(f.x + f.rx * lateral, f.y + up, f.z + f.rz * lateral);
}

/** A point of a ribbon cross-section: lateral offset (m, + = right), height above the road (m), texture u. */
export interface ProfilePoint {
  lateral: number;
  up: number;
  u: number;
}

/**
 * A strip swept along the track through the given cross-section (left → right). UV: u from the profile,
 * v = distance / `vRepeatM`. Normals are computed; the caller assigns the material. Optional vertex colours
 * per (profile point, frame).
 */
export function sweep(
  scene: Scene,
  name: string,
  track: Track,
  profile: ProfilePoint[],
  opts: { everyM?: number; vRepeatM?: number; color?: (p: number, f: Frame) => Color4 } = {},
): Mesh {
  const fs = frames(track, opts.everyM ?? 4);
  const cols = profile.length;
  const rows = fs.length;
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const col = opts.color ? new Float32Array(rows * cols * 4) : null;
  const vRep = opts.vRepeatM ?? 20;
  for (let r = 0; r < rows; r++) {
    const f = fs[r]!;
    for (let c = 0; c < cols; c++) {
      const p = profile[c]!;
      const k = r * cols + c;
      pos[k * 3] = f.x + f.rx * p.lateral;
      pos[k * 3 + 1] = f.y + p.up;
      pos[k * 3 + 2] = f.z + f.rz * p.lateral;
      uv[k * 2] = p.u;
      uv[k * 2 + 1] = f.d / vRep;
      if (col) {
        const c4 = opts.color!(c, f);
        col.set([c4.r, c4.g, c4.b, c4.a], k * 4);
      }
    }
  }
  const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let n = 0;
  for (let r = 0; r < rows - 1; r++)
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      idx[n++] = a;
      idx[n++] = a + 1;
      idx[n++] = a + cols;
      idx[n++] = a + 1;
      idx[n++] = a + cols + 1;
      idx[n++] = a + cols;
    }
  const nor = new Float32Array(pos.length);
  VertexData.ComputeNormals(pos, idx, nor);
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  vd.normals = nor;
  vd.uvs = uv;
  if (col) vd.colors = col;
  const mesh = new Mesh(name, scene);
  vd.applyToMesh(mesh, false);
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  return mesh;
}

/** Calls `fn` every `everyM` metres around the lap (deterministic positions for props). */
export function every(track: Track, everyM: number, fn: (f: Frame, i: number) => void): void {
  frames(track, everyM).slice(0, -1).forEach(fn);
}

/** Sky gradient, fog, a hemispheric fill and a sun. Returns the sun for shadows if a theme wants them. */
export function atmosphere(
  scene: Scene,
  o: { top: string; horizon: string; fog: number; sunDir: [number, number, number]; sun?: string; sunIntensity?: number; hemi?: number; ground?: string },
): DirectionalLight {
  const horizon = Color3.FromHexString(o.horizon);
  scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = o.fog;
  scene.fogColor = horizon;
  skyDome(scene, Color3.FromHexString(o.top), horizon);
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = o.hemi ?? 0.75;
  hemi.groundColor = Color3.FromHexString(o.ground ?? '#4a4a44');
  const sun = new DirectionalLight('sun', new Vector3(...o.sunDir), scene);
  sun.intensity = o.sunIntensity ?? 1.05;
  sun.diffuse = Color3.FromHexString(o.sun ?? '#fff4e0');
  return sun;
}

/** Deterministic random numbers in [0, 1) for prop placement. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
