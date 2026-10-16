import { Mesh, VertexData, type Material, type Scene } from '@babylonjs/core';

/**
 * Small growable vertex/index buffer. Triangles are oriented by an explicit outward normal, so callers
 * never have to think about Babylon's winding order.
 */
export class MeshData {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  constructor(
    private readonly withUv = false,
    private readonly withColor = false,
  ) {}

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vertex(x: number, y: number, z: number, nx = 0, ny = 1, nz = 0, u = 0, v = 0, r = 1, g = 1, b = 1): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    if (this.withUv) this.uv.push(u, v);
    if (this.withColor) this.col.push(r, g, b, 1);
    return this.pos.length / 3 - 1;
  }

  /** Triangle whose front face points along (nx, ny, nz). */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    orientedTri(this.idx, this.pos, a, b, c, nx, ny, nz);
  }

  /** Quad a-b-c-d (in loop order) facing (nx, ny, nz). */
  quad(a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
    this.tri(a, b, c, nx, ny, nz);
    this.tri(a, c, d, nx, ny, nz);
  }

  /** Grid-strip quad with a/b on one row (b to the right of a) and c/d on the next row: faces up. */
  stripQuad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, b, d, c);
  }

  computeNormals(): void {
    const n = new Float32Array(this.pos.length);
    VertexData.ComputeNormals(this.pos, this.idx, n);
    for (let i = 0; i < n.length; i++) this.nor[i] = n[i]!;
  }

  toVertexData(): VertexData | null {
    if (this.idx.length === 0) return null;
    const vd = new VertexData();
    vd.positions = new Float32Array(this.pos);
    vd.normals = new Float32Array(this.nor);
    if (this.withUv) vd.uvs = new Float32Array(this.uv);
    if (this.withColor) vd.colors = new Float32Array(this.col);
    vd.indices = this.vertexCount > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx);
    return vd;
  }

  build(scene: Scene, name: string, material: Material): Mesh | null {
    const vd = this.toVertexData();
    if (!vd) return null;
    const m = new Mesh(name, scene);
    vd.applyToMesh(m, false);
    m.material = material;
    m.isPickable = false;
    m.freezeWorldMatrix();
    m.doNotSyncBoundingInfo = true;
    return m;
  }
}

/** Babylon draws (a, b, c) front-facing towards N when cross(c - a, b - a) · N > 0. */
export function orientedTri(idx: number[], pos: ArrayLike<number>, a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
  const ux = pos[c * 3]! - pos[a * 3]!;
  const uy = pos[c * 3 + 1]! - pos[a * 3 + 1]!;
  const uz = pos[c * 3 + 2]! - pos[a * 3 + 2]!;
  const vx = pos[b * 3]! - pos[a * 3]!;
  const vy = pos[b * 3 + 1]! - pos[a * 3 + 1]!;
  const vz = pos[b * 3 + 2]! - pos[a * 3 + 2]!;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  if (cx * nx + cy * ny + cz * nz >= 0) idx.push(a, b, c);
  else idx.push(a, c, b);
}
