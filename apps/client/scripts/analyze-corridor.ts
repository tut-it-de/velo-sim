/**
 * Prints statistics about a real-world route corridor (road edges, walls, widths) without a browser:
 *   npx tsx apps/client/scripts/analyze-corridor.ts lago-di-como
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTrack, ROUTES } from '@velo/routes';
import { EDGE, RouteCorridor } from '../src/game/real/corridor';
import { fitGroundModel } from '../src/game/real/ground';
import { BuildingIndex, HeightField } from '../src/game/real/heightField';
import type { BuildingKind, GridName, WorldData, WorldGrid } from '../src/game/real/worldData';

const id = process.argv[2] ?? 'lago-di-como';
const dir = resolve(import.meta.dirname, '../public/worlds', id);
const json = JSON.parse(readFileSync(resolve(dir, 'world.json'), 'utf8'));
const bin = readFileSync(resolve(dir, 'terrain.bin'));
const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
const ring = (v: number[], from: number) => {
  const n = (v.length - from) >> 1;
  const out = new Float32Array(n * 2);
  let x = 0;
  let z = 0;
  for (let k = 0; k < n; k++) {
    x += v[from + 2 * k]!;
    z += v[from + 2 * k + 1]!;
    out[2 * k] = x / 10;
    out[2 * k + 1] = z / 10;
  }
  return out;
};
const grid = (name: GridName): WorldGrid => {
  const g = json.grids[name];
  const raw = new Uint16Array(buf, g.heightOffset, g.nx * g.nz);
  return { name, x0: g.x0, z0: g.z0, step: g.step, nx: g.nx, nz: g.nz, heights: Float32Array.from(raw, (v) => v / 10), classes: new Uint8Array(buf, g.classOffset, g.nx * g.nz) };
};
const data: WorldData = {
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
  buildings: json.buildings.map((b: number[]) => ({ height: b[0]! / 10, kind: b[1] as BuildingKind, ring: ring(b, 2) })),
  trees: Float32Array.from(json.trees, (v: number) => v / 10),
  roads: json.roads.map((r: number[]) => ({ width: r[0]! / 10, track: r[1] === 1, pts: ring(r, 2) })),
};
const route = ROUTES.find((r) => r.world === id)!;
const track = getTrack(route.id);
const tg = performance.now();
if (!process.argv.includes('--raw')) fitGroundModel(data, track);
console.log(`ground model ${(performance.now() - tg).toFixed(0)} ms`);
const field = new HeightField(data);
const t0 = performance.now();
const c = new RouteCorridor(track, field, new BuildingIndex(data.buildings));
console.log(`corridor ${(performance.now() - t0).toFixed(0)} ms, rows ${c.rows}`);
const t1 = performance.now();
c.routeDistanceGrid();
console.log(`distance grid ${(performance.now() - t1).toFixed(0)} ms`);

const names = Object.fromEntries(Object.entries(EDGE).map(([k, v]) => [v, k]));
const count: Record<string, number> = {};
let both = 0;
let urbanRows = 0;
let covered = 0;
const bothAt: number[] = [];
for (let r = 0; r < c.rows; r++) {
  const e0 = names[c.edge[0][r]!]!;
  const e1 = names[c.edge[1][r]!]!;
  count[`L:${e0}`] = (count[`L:${e0}`] ?? 0) + 1;
  count[`R:${e1}`] = (count[`R:${e1}`] ?? 0) + 1;
  if (e0 === 'wall' && e1 === 'wall') {
    both++;
    bothAt.push(r * 4);
  }
  urbanRows += c.urban[r]!;
  covered += c.covered[r]!;
}
console.log(count, { bothWalls: both, urbanRows, covered });
// runs of both-side walls (metres along the lap)
const runs: string[] = [];
for (let k = 0; k < bothAt.length; k++) {
  let e = k;
  while (e + 1 < bothAt.length && bothAt[e + 1]! - bothAt[e]! <= 8) e++;
  runs.push(`${bothAt[k]}–${bothAt[e]}`);
  k = e;
}
console.log('both-side wall runs:', runs.join(', '));

// how the natural ground sits relative to the road
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)]!.toFixed(1);
const centre: number[] = [];
const up: number[] = [];
const lo: number[] = [];
const water: number[] = [];
for (let r = 0; r < c.rows; r++) {
  const i = c.sampleOf(r);
  const x = track.xs[i]!;
  const z = track.zs[i]!;
  const y = track.ys[i]!;
  const rx = Math.cos(track.headings[i]!);
  const rz = -Math.sin(track.headings[i]!);
  centre.push(field.dem(x, z) - y);
  const a = field.dem(x - rx * 7.3, z - rz * 7.3) - y;
  const b = field.dem(x + rx * 7.3, z + rz * 7.3) - y;
  up.push(Math.max(a, b));
  lo.push(Math.min(a, b));
  let wd = 99;
  for (let o = 0; o <= 60; o += 2) {
    if (field.isWater(x + rx * o, z + rz * o) || field.isWater(x - rx * o, z - rz * o)) {
      wd = o;
      break;
    }
  }
  water.push(wd);
}
for (const [name, a] of [['dem-road centre', centre], ['higher side', up], ['lower side', lo], ['water distance', water]] as const) {
  console.log(name, 'p10', pct(a, 0.1), 'p50', pct(a, 0.5), 'p90', pct(a, 0.9));
}
console.log('rows with water within 20 m:', water.filter((w) => w <= 20).length, 'within 40 m:', water.filter((w) => w <= 40).length);

// water distance along the lap (250 m bins): nearest water cell on either side, and to the lake outline
if (process.argv.includes('--water')) {
  const segDist = (px: number, pz: number) => {
    let best = Infinity;
    for (const ringPts of data.lake) {
      for (let k = 0; k < ringPts.length; k++) {
        const [ax, az] = ringPts[k]!;
        const [bx, bz] = ringPts[(k + 1) % ringPts.length]!;
        const abx = bx - ax;
        const abz = bz - az;
        const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz || 1)));
        best = Math.min(best, Math.hypot(ax + t * abx - px, az + t * abz - pz));
      }
    }
    return best;
  };
  const line: string[] = [];
  for (let m = 0; m < track.length; m += 250) {
    const i = Math.round(m / track.step);
    const x = track.xs[i]!;
    const z = track.zs[i]!;
    const rx = Math.cos(track.headings[i]!);
    const rz = -Math.sin(track.headings[i]!);
    let wd = '-';
    for (let o = 0; o <= 80; o += 2) {
      if (field.isWater(x + rx * o, z + rz * o)) { wd = `R${o}`; break; }
      if (field.isWater(x - rx * o, z - rz * o)) { wd = `L${o}`; break; }
    }
    line.push(`${(m / 1000).toFixed(2)}km y${track.ys[i]!.toFixed(0)} w:${wd} lake:${segDist(x, z).toFixed(0)}`);
  }
  console.log(line.join('\n'));
}

// per-row detail: --rows from-to (metres)
const rowsArg = process.argv.indexOf('--rows');
if (rowsArg > 0) {
  const [from, to] = process.argv[rowsArg + 1]!.split('-').map(Number) as [number, number];
  for (let r = Math.floor(from / 4); r <= Math.floor(to / 4); r += 2) {
    const i = c.sampleOf(r);
    const x = track.xs[i]!;
    const z = track.zs[i]!;
    const y = track.ys[i]!;
    const rx = Math.cos(track.headings[i]!);
    const rz = -Math.sin(track.headings[i]!);
    const demC = field.dem(x, z);
    const side = (s: number) => {
      const sg = s === 0 ? -1 : 1;
      const hw = c.hw[s][r]!;
      const d4 = field.dem(x + sg * rx * (hw + 4), z + sg * rz * (hw + 4));
      const d12 = field.dem(x + sg * rx * (hw + 12), z + sg * rz * (hw + 12));
      return `${names[c.edge[s][r]!]!.padEnd(7)} up${(d4 - y).toFixed(1).padStart(5)} rise${(d4 - demC).toFixed(1).padStart(5)} up12${(d12 - y).toFixed(1).padStart(5)} hw${hw.toFixed(1)}`;
    };
    console.log(`${(i * track.step).toString().padStart(6)}m urban${c.urban[r]} demC-y${(demC - y).toFixed(1).padStart(5)} | L ${side(0)} | R ${side(1)}`);
  }
}
