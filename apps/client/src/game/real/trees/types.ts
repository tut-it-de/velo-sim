/** Tree species of the near (3D) and far (impostor) vegetation. */
export type SpeciesId = 'chestnut' | 'beech' | 'plane' | 'olive' | 'palm' | 'spruce' | 'larch' | 'cypress' | 'oleander' | 'laurel';

/** Overall crown silhouette; decides branch direction and length in treeGen.ts. */
export type CrownShape = 'round' | 'cone' | 'column' | 'umbrella' | 'palm' | 'bush';

/** One placed tree in the world. `y` is the base point, `height` in metres. */
export interface TreeInstance {
  x: number;
  y: number;
  z: number;
  species: SpeciesId;
  /** Index of the seed variant, 0–2. */
  variant: number;
  height: number;
  yaw: number;
  tint: [number, number, number];
}

/** Generator input for one species. All lengths are relative to the tree height unless noted. */
export interface SpeciesParams {
  /** Height range in metres [min, max]. */
  height: [number, number];
  /** Trunk radius at the foot, relative to the height. */
  trunkRadius: number;
  /** Lean of the trunk in radians. */
  trunkLean: number;
  /** Fraction of the height at which the first branches start. */
  crownStart: number;
  crownShape: CrownShape;
  /** Crown diameter relative to the height. */
  crownWidth: number;
  /** Number of branch levels, 1–3. */
  levels: number;
  /** Child branches per parent for each level (level 1: total count from the trunk). */
  branches: [number, number, number];
  /** Angle from the vertical in radians. */
  branchAngle: number;
  /** Downward bend of a branch in radians over its length. */
  branchDroop: number;
  /** Irregularity of trunk and branches, 0–1. */
  gnarl: number;
  /** Cell of the leaf atlas (4×4 grid, 0–15). */
  leafCell: number;
  /** Size of one leaf card in metres. */
  leafSize: number;
  /** Leaf cards per branch tip. */
  leavesPerTip: number;
  /** Cell of the bark atlas (2×2 grid, 0–3). */
  barkCell: number;
  /** Multiplied with the leaf texture, RGB 0–1. */
  leafColor: [number, number, number];
  /** Multiplied with the bark texture, RGB 0–1. */
  barkColor: [number, number, number];
  /** Corners of the wood tubes: [trunk, branch]. */
  sides: [number, number];
}

/** Vertex data of one mesh part. Colors are RGBA. */
export interface GeomPart {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** x = wind weight (0 at the foot, 1 at the tips), y = phase per branch (0…2π). */
  uvs2: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface TreeGeometry {
  wood: GeomPart;
  leaves: GeomPart;
  /** Bounding-box height in metres, after scaling. */
  height: number;
  /** Largest horizontal distance from the trunk axis in metres. */
  radius: number;
}
