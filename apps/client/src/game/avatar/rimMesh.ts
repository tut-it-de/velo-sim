import { Color3, DynamicTexture, Mesh, StandardMaterial, VertexData, type Node, type Scene } from '@babylonjs/core';
import { RIM_H, RIM_W, paintRim, type WheelLook } from './wheelArt';

const cache = new WeakMap<Scene, Map<string, StandardMaterial>>();

/** One material per rim design and depth, shared by every wheel in the scene that uses it. */
function rimMaterial(scene: Scene, look: WheelLook, depth: number, circ: number): StandardMaterial {
  let byKey = cache.get(scene);
  if (!byKey) cache.set(scene, (byKey = new Map()));
  const key = `${JSON.stringify(look)}|${depth.toFixed(3)}`;
  let m = byKey.get(key);
  if (m) return m;
  const tex = new DynamicTexture(`rim-tex-${byKey.size}`, { width: RIM_W, height: RIM_H }, scene, true);
  paintRim(tex.getContext() as unknown as CanvasRenderingContext2D, look, depth, circ);
  tex.update();
  tex.anisotropicFilteringLevel = 8;
  m = new StandardMaterial(`rim-${byKey.size}`, scene);
  m.diffuseTexture = tex;
  const [spec, power] = look.finish === 'gloss' ? [0.75, 110] : look.finish === 'alu' ? [0.55, 40] : [0.28, 22];
  m.specularColor = new Color3(spec, spec, spec);
  m.specularPower = power;
  byKey.set(key, m);
  return m;
}

/**
 * The rim of one wheel, lying in the wheel's y/z plane around the x axis: both sidewalls carry the
 * decal texture (u mirrored on the left so the lettering reads forwards from either side), the bead
 * and the spoke bed take the plain top and bottom rows.
 */
export function buildRim(scene: Scene, name: string, parent: Node, look: WheelLook, bead: number, depth: number): Mesh {
  const inner = bead - depth;
  const hw = 0.0125;
  const seg = 96;
  const circ = 2 * Math.PI * (bead - depth / 2);
  // sidewall profile from the bead (texture top) to the spoke bed (texture bottom): [radius, x]
  const side: Array<[number, number]> = [
    [bead, hw],
    [bead - depth * 0.2, hw * 1.08],
    [bead - depth * 0.45, hw * 1.12],
    [bead - depth * 0.7, hw * 0.98],
    [inner + 0.006, hw * 0.7],
    [inner, 0.0004],
  ];
  const p: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const ring = (profile: Array<[number, number]>, sx: number, vOf: (r: number, j: number) => number, flip: boolean) => {
    const start = p.length / 3;
    profile.forEach(([r, x], j) => {
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        p.push(x * sx, Math.sin(a) * r, Math.cos(a) * r);
        // u runs with the wheel's forward direction on the drive side; mirrored on the other side
        const u = sx > 0 ? k / seg : 1 - k / seg;
        uv.push(u, vOf(r, j));
      }
    });
    const n = seg + 1;
    for (let j = 0; j + 1 < profile.length; j++) {
      for (let k = 0; k < seg; k++) {
        const a = start + j * n + k;
        const b = a + n;
        if (flip) idx.push(a, a + 1, b, a + 1, b + 1, b);
        else idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  };
  const vSide = (r: number) => 1 - Math.min(1, Math.max(0, (bead - r) / depth));
  ring(side, 1, vSide, false);
  ring(side, -1, vSide, true);
  // flat bead face where the tyre sits: the top row of the texture
  ring([[bead, -hw], [bead, hw]], 1, () => 0.995, false);
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = p;
  vd.indices = idx;
  vd.uvs = uv;
  const normals: number[] = [];
  VertexData.ComputeNormals(p, idx, normals);
  vd.normals = normals;
  vd.applyToMesh(mesh);
  mesh.material = rimMaterial(scene, look, depth, circ);
  mesh.parent = parent;
  mesh.isPickable = false;
  return mesh;
}
