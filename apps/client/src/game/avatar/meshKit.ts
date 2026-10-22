import { Color3, Mesh, Quaternion, Vector3, VertexData, type Material, type Node, type Scene } from '@babylonjs/core';

/** Colour of a vertex from its position along a loft (0…1) and its angle around it (0…2π, 0 = +side axis). */
export type Paint = Color3 | ((t: number, angle: number) => Color3);

/** Cross-section outline: angle → point on the unit outline (side, normal). */
export type Profile = (angle: number) => [number, number];

export const ROUND: Profile = (a) => [Math.cos(a), Math.sin(a)];

/** Truncated airfoil, rounded leading edge on +normal, Kamm tail on −normal. */
export const AERO: Profile = (a) => {
  const s = Math.sin(a);
  const c = Math.cos(a);
  if (s >= 0) return [c, s];
  const t = -s;
  return [c * (1 - 0.42 * t), s];
};

/** Rounded square, e.g. for chainstays and stems. */
export const SQUIRCLE: Profile = (a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [Math.sign(c) * Math.abs(c) ** 0.6, Math.sign(s) * Math.abs(s) ** 0.6];
};

export interface LoftOptions {
  seg?: number;
  profile?: Profile;
  /** In-plane direction the section's normal axis leans towards (default +z, or +y for tubes along z). */
  hint?: Vector3;
  capStart?: boolean;
  capEnd?: boolean;
  /** Section centre offset along the normal axis, per point. */
  shift?: number[];
  /** Longest distance between rings (default 1.5 cm). */
  step?: number;
  /**
   * Texture coordinate (second uv channel) per ring vertex from the loft position `t` (0…1), the
   * section angle and `arc`, the angle as a share of the section's perimeter (0…1, by length).
   * null leaves the vertex untextured. With a map, every ring gets a seam vertex so u can wrap.
   */
  map?: (t: number, ang: number, arc: number) => [number, number] | null;
}

const tmp = new Vector3();

export function frameAt(t: Vector3, hint: Vector3 | undefined, prev: Vector3 | null): Vector3 {
  const h = hint ?? (Math.abs(t.z) > 0.85 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1));
  let n = h.subtract(t.scale(Vector3.Dot(h, t)));
  if (n.lengthSquared() < 1e-6 && prev) n = prev.subtract(t.scale(Vector3.Dot(prev, t)));
  if (n.lengthSquared() < 1e-6) n = Math.abs(t.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  return n.normalize();
}

/**
 * Collects triangles with vertex colours and emits one mesh per material, so a whole bike costs a
 * handful of draw calls. All shapes are built in the caller's coordinates.
 */
export class MeshKit {
  private readonly p: number[] = [];
  private readonly c: number[] = [];
  private readonly i: number[] = [];
  private readonly mi: number[] = [];
  private readonly mw: number[] = [];
  private readonly uv: number[] = [];
  private readonly uv2: number[] = [];
  private textured = false;
  /** Seam vertex pairs whose normals are averaged at build time (same position, different uv). */
  private readonly welds: Array<[number, number]> = [];
  /** Texture coordinate for vertices added without one (e.g. a whole ellipsoid in one colour of the texture). */
  texAt: [number, number] | null = null;
  /**
   * Skinning: when set, every new vertex is bound to two bones by its position, as
   * [bone A, bone B, weight of B]. Leave unset for rigid meshes.
   */
  skin: ((p: Vector3) => [number, number, number]) | null = null;
  /**
   * Material kind per vertex, written to the uv channel as [kind, 0] (e.g. 0 = skin, 1 = fabric). Leave unset
   * for meshes that need no kind; the uv then stays 1.
   */
  kind: ((col: Color3) => number) | null = null;

  get empty(): boolean {
    return this.i.length === 0;
  }

  private vertex(v: Vector3, col: Color3, tex?: [number, number] | null): number {
    const t = tex ?? this.texAt;
    if (t) this.textured = true;
    this.uv2.push(t ? t[0] : -1, t ? t[1] : -1);
    this.p.push(v.x, v.y, v.z);
    this.c.push(col.r, col.g, col.b, 1);
    this.uv.push(this.kind ? this.kind(col) : 1, 0);
    if (this.skin) {
      const [a, b, w] = this.skin(v);
      this.mi.push(a, b, 0, 0);
      this.mw.push(1 - w, w, 0, 0);
    }
    return this.p.length / 3 - 1;
  }

  /** Triangle strip between two rings of equal size. */
  private bridge(a: number, b: number, n: number): void {
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      this.i.push(a + k, b + k, a + k1, a + k1, b + k, b + k1);
    }
  }

  private cap(ring: number, n: number, centre: Vector3, col: Color3, flip: boolean, tex: [number, number] | null = null): void {
    const start = this.p.length / 3;
    for (let k = 0; k < n; k++) this.vertex(new Vector3(this.p[(ring + k) * 3]!, this.p[(ring + k) * 3 + 1]!, this.p[(ring + k) * 3 + 2]!), col, tex);
    const ci = this.vertex(centre, col, tex);
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      if (flip) this.i.push(ci, start + k, start + k1);
      else this.i.push(ci, start + k1, start + k);
    }
  }

  /**
   * Sweeps a cross-section along a polyline. `w` is the half-width along the side axis, `d` the
   * half-depth along the normal axis (both per point or constant).
   */
  loft(points: Vector3[], w: number | number[], d: number | number[], paint: Paint, o: LoftOptions = {}): void {
    // Resample to rings at most `step` apart so colour bands stay crisp along the loft.
    const step = o.step ?? 0.015;
    const P: Vector3[] = [points[0]!];
    const W: number[] = [typeof w === 'number' ? w : w[0]!];
    const D: number[] = [typeof d === 'number' ? d : d[0]!];
    const S: number[] = [o.shift?.[0] ?? 0];
    for (let j = 1; j < points.length; j++) {
      const k = Math.max(1, Math.ceil(Vector3.Distance(points[j - 1]!, points[j]!) / step));
      for (let m = 1; m <= k; m++) {
        const f = m / k;
        const mix = (q: number | number[] | undefined, def: number) => (q === undefined ? def : typeof q === 'number' ? q : q[j - 1]! + (q[j]! - q[j - 1]!) * f);
        P.push(Vector3.Lerp(points[j - 1]!, points[j]!, f));
        W.push(mix(w, 0));
        D.push(mix(d, 0));
        S.push(mix(o.shift, 0));
      }
    }
    this.loftRings(P, W, D, S, paint, o);
  }

  private loftRings(points: Vector3[], w: number[], d: number[], shift: number[], paint: Paint, o: LoftOptions): void {
    const n = o.seg ?? 12;
    const profile = o.profile ?? ROUND;
    const count = points.length;
    const lens = [0];
    for (let j = 1; j < count; j++) lens.push(lens[j - 1]! + Vector3.Distance(points[j]!, points[j - 1]!));
    const total = lens[count - 1]! || 1;
    let prevN: Vector3 | null = null;
    const rings: number[] = [];
    const map = o.map;
    const ringPts: Vector3[] = Array.from({ length: n }, () => new Vector3());
    const arc: number[] = new Array(n + 1).fill(0);
    for (let j = 0; j < count; j++) {
      const a = points[Math.max(0, j - 1)]!;
      const b = points[Math.min(count - 1, j + 1)]!;
      const t = b.subtract(a).normalize();
      const nrm = frameAt(t, o.hint, prevN);
      prevN = nrm;
      const side = Vector3.Cross(nrm, t).normalize();
      const ww = w[j]!;
      const dd = d[j]!;
      const centre = shift[j] ? points[j]!.add(nrm.scale(shift[j]!)) : points[j]!;
      const tt = lens[j]! / total;
      rings.push(this.p.length / 3);
      for (let k = 0; k < n; k++) {
        const [ps, pn] = profile((k / n) * Math.PI * 2);
        ringPts[k]!.copyFrom(centre).addInPlace(side.scale(ps * ww)).addInPlace(nrm.scale(pn * dd));
      }
      if (map) {
        for (let k = 1; k <= n; k++) arc[k] = arc[k - 1]! + Vector3.Distance(ringPts[k - 1]!, ringPts[k % n]!);
        for (let k = 1; k <= n; k++) arc[k] = arc[k]! / (arc[n]! || 1);
      }
      for (let k = 0; k < (map ? n + 1 : n); k++) {
        const ang = (k / n) * Math.PI * 2;
        this.vertex(ringPts[k % n]!, typeof paint === 'function' ? paint(tt, ang) : paint, map ? map(tt, ang, arc[k]!) : null);
      }
      if (map) this.welds.push([rings[j]!, rings[j]! + n]);
    }
    if (map) {
      for (let j = 0; j + 1 < count; j++) {
        const ra = rings[j]!;
        const rb = rings[j + 1]!;
        for (let k = 0; k < n; k++) this.i.push(ra + k, rb + k, ra + k + 1, ra + k + 1, rb + k, rb + k + 1);
      }
    } else for (let j = 0; j + 1 < count; j++) this.bridge(rings[j]!, rings[j + 1]!, n);
    const capCol = (t: number) => (typeof paint === 'function' ? paint(t, 0) : paint);
    const capTex = (t: number) => (map ? map(t, 0, 0) : null);
    if (o.capStart ?? true) this.cap(rings[0]!, n, points[0]!, capCol(0), true, capTex(0));
    if (o.capEnd ?? true) this.cap(rings[count - 1]!, n, points[count - 1]!, capCol(1), false, capTex(1));
  }

  /** Straight tube from a to b. */
  tube(a: Vector3, b: Vector3, r: number, paint: Paint, seg = 10): void {
    this.loft([a, b], r, r, paint, { seg });
  }

  /**
   * Surface of revolution around `axis` through `centre`: profile points are [radius, offset along axis].
   * `teeth` adds a toothed outer edge (chainrings, sprockets).
   */
  lathe(centre: Vector3, axis: Vector3, profile: Array<[number, number]>, paint: Paint, seg = 32, teeth = 0): void {
    const ax = axis.clone().normalize();
    const u = Math.abs(ax.y) < 0.9 ? Vector3.Cross(ax, new Vector3(0, 1, 0)).normalize() : Vector3.Cross(ax, new Vector3(1, 0, 0)).normalize();
    const v = Vector3.Cross(ax, u).normalize();
    const n = teeth > 0 ? teeth * 2 : seg;
    const maxR = Math.max(...profile.map((q) => q[0]));
    const rings: number[] = [];
    profile.forEach(([r, off], j) => {
      rings.push(this.p.length / 3);
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const rr = teeth > 0 && r >= maxR - 1e-6 && k % 2 === 1 ? r - 0.0045 : r;
        tmp.copyFrom(centre).addInPlace(ax.scale(off)).addInPlace(u.scale(Math.cos(ang) * rr)).addInPlace(v.scale(Math.sin(ang) * rr));
        this.vertex(tmp, typeof paint === 'function' ? paint(j / Math.max(1, profile.length - 1), ang) : paint);
      }
    });
    for (let j = 0; j + 1 < profile.length; j++) this.bridge(rings[j]!, rings[j + 1]!, n);
  }

  /** Flat-ended cylinder along `axis` (closed). */
  disc(centre: Vector3, axis: Vector3, r: number, width: number, paint: Paint, seg = 24, rInner = 0): void {
    const h = width / 2;
    const prof: Array<[number, number]> = rInner > 0
      ? [[rInner, -h], [r, -h], [r, h], [rInner, h], [rInner, -h]]
      : [[1e-4, -h], [r, -h], [r, h], [1e-4, h]];
    this.lathe(centre, axis, prof, paint, seg);
  }

  /** Ellipsoid with radii along the given axes (default world axes); `cut` < 1 keeps only the top part (a shell). */
  ellipsoid(centre: Vector3, radii: Vector3, paint: Paint, rot?: Quaternion, seg = 14, rings = 10, cut = 1): void {
    const start = this.p.length / 3;
    const m = rot ?? Quaternion.Identity();
    for (let j = 0; j <= rings; j++) {
      const phi = (j / rings) * Math.PI * cut;
      for (let k = 0; k <= seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        const local = new Vector3(Math.sin(phi) * Math.cos(th) * radii.x, Math.cos(phi) * radii.y, Math.sin(phi) * Math.sin(th) * radii.z);
        const world = local.applyRotationQuaternion(m).addInPlace(centre);
        this.vertex(world, typeof paint === 'function' ? paint(j / rings, th) : paint);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let k = 0; k < seg; k++) {
        const a = start + j * (seg + 1) + k;
        const b = a + seg + 1;
        this.i.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  /**
   * Free-form surface patch: `at(u, v)` gives the point and its colour for u, v in 0…1. Rows run along v,
   * columns along u, wound like `ellipsoid` (rows ≈ latitude, columns ≈ longitude).
   */
  grid(cols: number, rows: number, at: (u: number, v: number) => [Vector3, Color3]): void {
    const start = this.p.length / 3;
    for (let j = 0; j <= rows; j++) {
      for (let k = 0; k <= cols; k++) {
        const [p, col] = at(k / cols, j / rows);
        this.vertex(p, col);
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let k = 0; k < cols; k++) {
        const a = start + j * (cols + 1) + k;
        const b = a + cols + 1;
        this.i.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  /** Axis-aligned box rotated by `rot` around its centre. */
  box(centre: Vector3, size: Vector3, paint: Color3, rot?: Quaternion): void {
    const m = rot ?? Quaternion.Identity();
    const h = size.scale(0.5);
    const faces: Array<[Vector3, Vector3, Vector3]> = [
      [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
      [new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 1, 0)],
      [new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)],
      [new Vector3(0, -1, 0), new Vector3(1, 0, 0), new Vector3(0, 0, 1)],
      [new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 1, 0)],
      [new Vector3(0, 0, -1), new Vector3(0, 1, 0), new Vector3(1, 0, 0)],
    ];
    for (const [nrm, a, b] of faces) {
      const s = this.p.length / 3;
      for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const v = new Vector3(nrm.x * h.x + a.x * sa * h.x + b.x * sb * h.x, nrm.y * h.y + a.y * sa * h.y + b.y * sb * h.y, nrm.z * h.z + a.z * sa * h.z + b.z * sb * h.z);
        this.vertex(v.applyRotationQuaternion(m).addInPlace(centre), paint);
      }
      this.i.push(s, s + 2, s + 1, s, s + 3, s + 2);
    }
  }

  /** Builds the mesh (smooth normals over shared vertices) and resets nothing: call once. */
  build(name: string, scene: Scene, material: Material, parent: Node | null): Mesh {
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = this.p;
    vd.indices = this.i;
    vd.colors = this.c;
    vd.uvs = this.uv;
    const normals: number[] = [];
    VertexData.ComputeNormals(this.p, this.i, normals);
    // seam vertices share one normal so the uv seam does not show in the shading
    for (const [a, b] of this.welds) {
      const m = [0, 1, 2].map((c) => normals[a * 3 + c]! + normals[b * 3 + c]!);
      const l = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
      for (let c = 0; c < 3; c++) normals[a * 3 + c] = normals[b * 3 + c] = m[c]! / l;
    }
    vd.normals = normals;
    if (this.textured) vd.uvs2 = this.uv2;
    if (this.mi.length) {
      vd.matricesIndices = this.mi;
      vd.matricesWeights = this.mw;
    }
    vd.applyToMesh(mesh);
    mesh.material = material;
    mesh.parent = parent;
    mesh.isPickable = false;
    return mesh;
  }
}

/** Rotation whose +y axis points along `dir` and whose +z axis leans towards `forward`. */
export function basis(dir: Vector3, forward: Vector3, out?: Quaternion): Quaternion {
  const y = dir.clone().normalize();
  let z = forward.subtract(y.scale(Vector3.Dot(forward, y)));
  if (z.lengthSquared() < 1e-8) z = new Vector3(0, 0, 1);
  z.normalize();
  const x = Vector3.Cross(y, z).normalize();
  const q = out ?? new Quaternion();
  Quaternion.RotationQuaternionFromAxisToRef(x, y, z, q);
  return q;
}

export const hex = (h: string) => Color3.FromHexString(h);
