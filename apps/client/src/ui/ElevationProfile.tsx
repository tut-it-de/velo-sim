import { useMemo, useState, type MouseEvent } from 'react';
import type { Track } from '@velo/routes';

const W = 1000;

interface Props {
  track: Track;
  /** Current position within the lap in metres (omit for a static preview). */
  positionM?: number;
  height?: number;
  showSegments?: boolean;
  /** Other riders' lap positions (pacers, later multiplayer). */
  markers?: Array<{ id: string; positionM: number; color: string }>;
  /** Makes the profile clickable: called with the lap distance under the pointer. */
  onPick?: (distanceM: number) => void;
}

/** Elevation profile of a full lap as SVG, with segment bands and rider markers. */
export function ElevationProfile({ track, positionM, height = 90, showSegments = true, markers = [], onPick }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const { path, area, minE, range } = useMemo(() => {
    const pts = track.profile(300);
    const minE = Math.min(...pts.map((p) => p[1]));
    const maxE = Math.max(...pts.map((p) => p[1]));
    // keep flat routes looking flat: at least 60 m vertical range
    const range = Math.max(60, maxE - minE);
    const toXY = ([d, e]: [number, number]) => [(d / track.length) * W, height - 6 - ((e - minE) / range) * (height - 14)] as const;
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${toXY(p)[0].toFixed(1)},${toXY(p)[1].toFixed(1)}`).join(' ');
    return { path: line, area: `${line} L${W},${height} L0,${height} Z`, minE, range };
  }, [track, height]);

  const x = (d: number) => (d / track.length) * W;
  const yAt = (d: number) => height - 6 - ((track.sample(d).y - minE) / range) * (height - 14);
  const gradId = `elev-${track.id}`;
  const pickAt = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(track.length - 1, Math.max(0, ((e.clientX - r.left) / r.width) * track.length));
  };
  const hs = hover !== null ? track.sample(hover) : null;

  const svg = (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block', cursor: onPick ? 'crosshair' : undefined }}
      onMouseMove={onPick ? (e) => setHover(pickAt(e)) : undefined}
      onMouseLeave={onPick ? () => setHover(null) : undefined}
      onClick={onPick ? (e) => onPick(pickAt(e)) : undefined}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#74c0fc" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#74c0fc" stopOpacity="0.08" />
        </linearGradient>
      </defs>
      {showSegments &&
        track.segments.map((s) => (
          <rect
            key={s.id}
            x={x(s.startM)}
            y={0}
            width={x(s.endM) - x(s.startM)}
            height={height}
            fill={s.type === 'climb' ? '#c62828' : s.type === 'sprint' ? '#2e7d32' : '#1565c0'}
            opacity={0.18}
          />
        ))}
      <path d={area} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke="#a5d8ff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {markers.map((m) => (
        <circle key={m.id} cx={x(m.positionM)} cy={yAt(m.positionM)} r={4} fill={m.color} stroke="#0d1117" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      {positionM !== undefined && (
        <>
          <line x1={x(positionM)} x2={x(positionM)} y1={0} y2={height} stroke="#ffffff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          <circle cx={x(positionM)} cy={yAt(positionM)} r={6} fill="#ffffff" stroke="#74c0fc" strokeWidth={3} vectorEffect="non-scaling-stroke" />
        </>
      )}
      {hover !== null && (
        <>
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} stroke="#58a6ff" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          <circle cx={x(hover)} cy={yAt(hover)} r={5} fill="#58a6ff" stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
  if (!onPick) return svg;
  return (
    <div className="profile-pick">
      {svg}
      {hs && hover !== null && (
        <div className="profile-pick-tip" style={{ left: `${(hover / track.length) * 100}%` }}>
          <strong>{(hover / 1000).toFixed(2)} km</strong>
          <span>{Math.round(hs.y)} m</span>
          <span>{hs.gradePercent.toFixed(1)} %</span>
        </div>
      )}
    </div>
  );
}
