import { Color3, DynamicTexture, Mesh, StandardMaterial, Texture, VertexData, type Scene } from '@babylonjs/core';
import type { Track } from '@velo/routes';

export const ROAD_HALF_WIDTH = 4;
const SHOULDER = 1.2;
const SKIRT = 7.5;
const TEX_REPEAT_M = 24;

/**
 * Road ribbon along the track. Cross-section (left → right):
 * skirt (slopes into the terrain) · gravel shoulder · asphalt with lines · shoulder · skirt.
 */
export function buildRoadMesh(scene: Scene, track: Track): Mesh {
  const stride = 2; // every 2nd sample = 4 m
  const rows = Math.ceil(track.count / stride) + 1;
  const offsets = [-SKIRT, -(ROAD_HALF_WIDTH + SHOULDER), -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + SHOULDER, SKIRT];
  const heights = [-0.75, 0.04, 0.06, 0.06, 0.04, -0.75];
  const total = SKIRT * 2;
  const us = offsets.map((o) => (o + SKIRT) / total);
  const cols = offsets.length;

  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  for (let r = 0; r < rows; r++) {
    const i = (r * stride) % track.count;
    const d = r * stride * track.step;
    const x = track.xs[i]!;
    const y = track.ys[i]!;
    const z = track.zs[i]!;
    const h = track.headings[i]!;
    const rx = Math.cos(h);
    const rz = -Math.sin(h);
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      positions[k * 3] = x + rx * offsets[c]!;
      positions[k * 3 + 1] = y + heights[c]!;
      positions[k * 3 + 2] = z + rz * offsets[c]!;
      uvs[k * 2] = us[c]!;
      uvs[k * 2 + 1] = d / TEX_REPEAT_M;
    }
  }
  const indices = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let p = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const cc = a + cols;
      const d = cc + 1;
      indices[p++] = a;
      indices[p++] = b;
      indices[p++] = cc;
      indices[p++] = b;
      indices[p++] = d;
      indices[p++] = cc;
    }
  }
  const normals = new Float32Array(positions.length);
  VertexData.ComputeNormals(positions, indices, normals);

  const mesh = new Mesh(`road-${track.id}`, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.applyToMesh(mesh, false);

  const mat = new StandardMaterial('road-mat', scene);
  mat.diffuseTexture = roadTexture(scene, us);
  mat.specularColor = new Color3(0.08, 0.08, 0.08);
  mat.zOffset = -2;
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.freezeWorldMatrix();
  return mesh;
}

function roadTexture(scene: Scene, us: number[]): DynamicTexture {
  const w = 512;
  const h = 512;
  const tex = new DynamicTexture('road-tex', { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const px = (u: number) => Math.round(u * w);
  // skirt (grass/dirt)
  ctx.fillStyle = '#5d6b3a';
  ctx.fillRect(0, 0, w, h);
  // gravel shoulders
  ctx.fillStyle = '#8a8172';
  ctx.fillRect(px(us[1]!), 0, px(us[2]!) - px(us[1]!), h);
  ctx.fillRect(px(us[3]!), 0, px(us[4]!) - px(us[3]!), h);
  // asphalt with speckles
  const a0 = px(us[2]!);
  const a1 = px(us[3]!);
  ctx.fillStyle = '#3b3e43';
  ctx.fillRect(a0, 0, a1 - a0, h);
  for (let i = 0; i < 6000; i++) {
    const g = 45 + Math.floor(Math.random() * 40);
    ctx.fillStyle = `rgb(${g},${g},${g + 3})`;
    ctx.fillRect(a0 + Math.random() * (a1 - a0), Math.random() * h, 2, 2);
  }
  // edge lines
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(a0 + 6, 0, 7, h);
  ctx.fillRect(a1 - 13, 0, 7, h);
  // dashed centre line: 2 dashes per 24 m texture repeat
  const mid = (a0 + a1) / 2;
  for (let k = 0; k < 2; k++) ctx.fillRect(mid - 3, k * (h / 2), 6, h / 4);
  tex.update();
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}
