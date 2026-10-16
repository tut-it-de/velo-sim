/**
 * Real-world map data produced by tools/geo (terrain rasters, buildings, trees, side roads).
 * Served as static files next to the app: ./worlds/<id>/world.json + terrain.bin.
 */

export type GridName = 'near' | 'far' | 'horizon';

/** Regular raster in local metres (x = east, z = north), row-major from (x0, z0). */
export interface WorldGrid {
  name: GridName;
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  /** Metres above sea level. */
  heights: Float32Array;
  /** Land class per cell, see LAND_CLASS. */
  classes: Uint8Array;
}

export const LAND_CLASS = {
  grass: 0,
  forest: 1,
  shrub: 2,
  urban: 3,
  garden: 4,
  farmland: 5,
  rock: 6,
  water: 7,
  sand: 8,
  park: 9,
  orchard: 10,
  snow: 11,
} as const;

export type BuildingKind = 0 | 1 | 2; // flat | hip roof | church

export interface Building {
  height: number;
  kind: BuildingKind;
  /** Footprint (x, z pairs), counter-clockwise seen from above with north up. */
  ring: Float32Array;
}

export interface SideRoad {
  width: number;
  track: boolean;
  pts: Float32Array;
}

export interface Place {
  name: string;
  x: number;
  z: number;
}

export interface WorldData {
  id: string;
  name: string;
  attribution: string;
  origin: [number, number];
  waterLevel: number;
  near: WorldGrid;
  far: WorldGrid;
  horizon: WorldGrid;
  /** Lake outline(s) for the minimap, local metres. */
  lake: Array<Array<[number, number]>>;
  places: Place[];
  buildings: Building[];
  /** Single trees (x, z pairs). */
  trees: Float32Array;
  roads: SideRoad[];
}

interface GridJson {
  x0: number;
  z0: number;
  step: number;
  nx: number;
  nz: number;
  heightOffset: number;
  classOffset: number;
}

interface WorldJson {
  version: number;
  name: string;
  attribution: string;
  origin: [number, number];
  waterLevel: number;
  grids: Record<GridName, GridJson>;
  terrainBytes: number;
  lake: Array<Array<[number, number]>>;
  places: Place[];
  buildings: number[][];
  trees: number[];
  roads: number[][];
}

/** Undoes the generator's delta encoding: absolute first pair, then deltas, all in decimetres. */
function decodeRing(values: number[], from: number): Float32Array {
  const n = (values.length - from) >> 1;
  const out = new Float32Array(n * 2);
  let x = 0;
  let z = 0;
  for (let k = 0; k < n; k++) {
    x += values[from + 2 * k]!;
    z += values[from + 2 * k + 1]!;
    out[2 * k] = x / 10;
    out[2 * k + 1] = z / 10;
  }
  return out;
}

const cache = new Map<string, Promise<WorldData>>();

function worldUrl(id: string, file: string): string {
  return new URL(`worlds/${id}/${file}`, document.baseURI).toString();
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kartendaten fehlen (${res.status}): ${url}`);
  return res;
}

async function load(id: string): Promise<WorldData> {
  const [json, bin] = await Promise.all([
    fetchOk(worldUrl(id, 'world.json')).then((r) => r.json() as Promise<WorldJson>),
    fetchOk(worldUrl(id, 'terrain.bin')).then((r) => r.arrayBuffer()),
  ]);
  if (bin.byteLength !== json.terrainBytes) throw new Error('terrain.bin passt nicht zu world.json');

  const grid = (name: GridName): WorldGrid => {
    const g = json.grids[name];
    const n = g.nx * g.nz;
    const raw = new Uint16Array(bin, g.heightOffset, n);
    const heights = new Float32Array(n);
    for (let i = 0; i < n; i++) heights[i] = raw[i]! / 10;
    return { name, x0: g.x0, z0: g.z0, step: g.step, nx: g.nx, nz: g.nz, heights, classes: new Uint8Array(bin, g.classOffset, n) };
  };

  return {
    id,
    name: json.name,
    attribution: json.attribution,
    origin: json.origin,
    waterLevel: json.waterLevel,
    near: grid('near'),
    far: grid('far'),
    horizon: grid('horizon'),
    lake: json.lake,
    places: json.places,
    buildings: json.buildings.map((b) => ({ height: b[0]! / 10, kind: b[1] as BuildingKind, ring: decodeRing(b, 2) })),
    trees: Float32Array.from(json.trees, (v) => v / 10),
    roads: json.roads.map((r) => ({ width: r[0]! / 10, track: r[1] === 1, pts: decodeRing(r, 2) })),
  };
}

/** Loads (once per session) and decodes a world. */
export function loadWorldData(id: string): Promise<WorldData> {
  let p = cache.get(id);
  if (!p) {
    p = load(id);
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}
