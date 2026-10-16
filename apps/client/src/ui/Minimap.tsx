import { useMemo } from 'react';
import type { Track } from '@velo/routes';
import type { MinimapData } from '../game/real/realWorld';

const W = 240;
const H = 190;
const PAD = 12;
const MAX_LABELS = 5;

interface Dot {
  id: string;
  positionM: number;
  color: string;
}

/**
 * North-up map of the lap: the lake (for real-world routes), the route, a few villages along it and
 * every rider as a dot. The static layer is built once per track; only the dots move.
 */
export function Minimap({ track, map, positionM, others }: { track: Track; map: MinimapData | null; positionM: number; others: Dot[] }) {
  const view = useMemo(() => {
    const { minX, maxX, minZ, maxZ } = track.bounds;
    // fit the lap into the box, keeping the aspect ratio
    const scale = Math.min((W - 2 * PAD) / Math.max(1, maxX - minX), (H - 2 * PAD) / Math.max(1, maxZ - minZ));
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const px = (x: number) => W / 2 + (x - cx) * scale;
    const py = (z: number) => H / 2 - (z - cz) * scale; // north up
    const path = (pts: ArrayLike<readonly [number, number]>, close: boolean) => {
      let d = '';
      for (let i = 0; i < pts.length; i++) d += `${i ? 'L' : 'M'}${px(pts[i]![0]).toFixed(1)},${py(pts[i]![1]).toFixed(1)}`;
      return close ? `${d}Z` : d;
    };
    const route: Array<[number, number]> = [];
    const every = Math.max(1, Math.floor(track.count / 600));
    for (let i = 0; i < track.count; i += every) route.push([track.xs[i]!, track.zs[i]!]);
    route.push([track.xs[0]!, track.zs[0]!]);

    // villages close to the lap, spread out so labels don't overlap
    const labels: Array<{ name: string; x: number; y: number }> = [];
    if (map) {
      const near = map.places
        .map((p) => {
          let best = Infinity;
          for (let i = 0; i < track.count; i += 10) best = Math.min(best, Math.hypot(track.xs[i]! - p.x, track.zs[i]! - p.z));
          return { p, best };
        })
        .filter((c) => c.best < 350)
        .sort((a, b) => a.best - b.best);
      for (const { p } of near) {
        const x = px(p.x);
        const y = py(p.z);
        if (x < PAD || x > W - PAD || y < PAD || y > H - PAD) continue;
        if (labels.some((l) => Math.abs(l.x - x) < 70 && Math.abs(l.y - y) < 16)) continue;
        labels.push({ name: p.name, x, y });
        if (labels.length >= MAX_LABELS) break;
      }
    }
    return {
      px,
      py,
      lake: map?.lake.map((ring) => path(ring, true)) ?? [],
      route: path(route, false),
      labels,
      start: [px(track.xs[0]!), py(track.zs[0]!)] as const,
    };
  }, [track, map]);

  const at = (d: number) => {
    const s = track.sample(d);
    return [view.px(s.x), view.py(s.z), s.heading] as const;
  };
  const [mx, my, heading] = at(positionM);

  return (
    <div className="hud-panel hud-minimap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Karte">
        {view.lake.map((d, i) => (
          <path key={i} d={d} className="mm-lake" />
        ))}
        <path d={view.route} className="mm-route-casing" />
        <path d={view.route} className="mm-route" />
        {view.labels.map((l) => (
          <g key={l.name}>
            <circle cx={l.x} cy={l.y} r={1.8} className="mm-place-dot" />
            <text x={l.x + 4} y={l.y - 3} className="mm-place">
              {l.name}
            </text>
          </g>
        ))}
        <rect x={view.start[0] - 3} y={view.start[1] - 3} width={6} height={6} className="mm-start" />
        {others.map((o) => {
          const [x, y] = at(o.positionM);
          return <circle key={o.id} cx={x} cy={y} r={3.4} fill={o.color} className="mm-rider" />;
        })}
        {/* me: an arrow pointing along the road (heading 0 = north, clockwise) */}
        <g transform={`translate(${mx.toFixed(1)},${my.toFixed(1)}) rotate(${((heading * 180) / Math.PI).toFixed(1)})`}>
          <path d="M0,-7 L5,5 L0,2.4 L-5,5 Z" className="mm-me" />
        </g>
        <g transform={`translate(${W - 16},18)`} className="mm-north">
          <circle r={11} />
          <path d="M0,-9 L3.5,-1.5 L0,-3.2 L-3.5,-1.5 Z" />
          <text y={8} textAnchor="middle">
            N
          </text>
        </g>
      </svg>
      {map && (
        <div className="mm-attribution" title={map.attribution}>
          {map.attribution.split(';')[0]}
        </div>
      )}
    </div>
  );
}
