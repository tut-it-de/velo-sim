import type { Track } from '@velo/routes';

/**
 * Spatial hash over road samples: answers "how far is the nearest road and how
 * high is it there?" quickly for terrain generation and prop placement.
 */
export class RoadIndex {
  private readonly cell: number;
  private readonly cells = new Map<number, number[]>();
  private readonly xs: Float64Array;
  private readonly zs: Float64Array;
  private readonly ys: Float64Array;

  constructor(
    private readonly track: Track,
    cellSize = 40,
    sampleEvery = 2,
  ) {
    this.cell = cellSize;
    const n = Math.ceil(track.count / sampleEvery);
    this.xs = new Float64Array(n);
    this.zs = new Float64Array(n);
    this.ys = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const i = k * sampleEvery;
      this.xs[k] = track.xs[i]!;
      this.zs[k] = track.zs[i]!;
      this.ys[k] = track.ys[i]!;
      const key = this.key(Math.floor(this.xs[k]! / cellSize), Math.floor(this.zs[k]! / cellSize));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(k);
    }
  }

  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  /** Nearest road sample within `maxDist`; `dist` is Infinity when none. */
  nearest(x: number, z: number, maxDist: number): { dist: number; y: number } {
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = maxDist * maxDist;
    let bestY = 0;
    let found = false;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const list = this.cells.get(this.key(cx + dx, cz + dz));
        if (!list) continue;
        for (const k of list) {
          const ex = this.xs[k]! - x;
          const ez = this.zs[k]! - z;
          const d2 = ex * ex + ez * ez;
          if (d2 < best) {
            best = d2;
            bestY = this.ys[k]!;
            found = true;
          }
        }
      }
    }
    return found ? { dist: Math.sqrt(best), y: bestY } : { dist: Infinity, y: 0 };
  }

  get trackRef(): Track {
    return this.track;
  }
}
