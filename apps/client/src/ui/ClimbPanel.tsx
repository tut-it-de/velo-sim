import { useMemo } from 'react';
import type { RouteSegment, Track } from '@velo/routes';
import type { RideSnapshot } from '../ride/rideSession';
import { formatDuration } from './components';

/** How far ahead of a climb the panel appears. */
const LOOKAHEAD_M = 1500;
const W = 260;
const H = 64;

export function gradeColor(g: number): string {
  if (g >= 10) return '#b91c1c';
  if (g >= 8) return '#ef4444';
  if (g >= 5) return '#f97316';
  if (g >= 2) return '#eab308';
  if (g <= -2) return '#3b82f6';
  return '#8b949e';
}

interface ClimbInfo {
  segment: RouteSegment;
  lengthM: number;
  avgGrade: number;
  topM: number;
  bars: Array<{ d: string; color: string }>;
  outline: string;
}

function describe(track: Track, seg: RouteSegment): ClimbInfo {
  const len = seg.endM - seg.startM;
  const y0 = track.sample(seg.startM).y;
  const y1 = track.sample(seg.endM).y;
  const n = Math.max(12, Math.min(40, Math.round(len / 150)));
  const ys: number[] = [];
  for (let i = 0; i <= n; i++) ys.push(track.sample(seg.startM + (len * i) / n).y);
  const lo = Math.min(...ys) - 4;
  const range = Math.max(30, Math.max(...ys) - lo);
  const x = (i: number) => (W * i) / n;
  const y = (e: number) => H - 2 - ((e - lo) / range) * (H - 8);
  const bars = [];
  for (let i = 0; i < n; i++) {
    const g = ((ys[i + 1]! - ys[i]!) / (len / n)) * 100;
    bars.push({
      d: `M${x(i).toFixed(1)},${H} L${x(i).toFixed(1)},${y(ys[i]!).toFixed(1)} L${x(i + 1).toFixed(1)},${y(ys[i + 1]!).toFixed(1)} L${x(i + 1).toFixed(1)},${H} Z`,
      color: gradeColor(g),
    });
  }
  const outline = ys.map((e, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(e).toFixed(1)}`).join(' ');
  return { segment: seg, lengthM: len, avgGrade: ((y1 - y0) / len) * 100, topM: Math.max(...ys), bars, outline };
}

/**
 * The climb being ridden (or coming up): length, average gradient, a profile coloured by gradient,
 * distance to the top and the live segment time.
 */
export function ClimbPanel({ track, snapshot }: { track: Track; snapshot: RideSnapshot }) {
  const climbs = useMemo(() => track.segments.filter((s) => s.type === 'climb').map((s) => describe(track, s)), [track]);
  const pos = snapshot.lapDistanceM;
  let climb: ClimbInfo | undefined;
  let ahead = 0;
  for (const c of climbs) {
    if (pos >= c.segment.startM && pos <= c.segment.endM) {
      climb = c;
      ahead = 0;
      break;
    }
    const until = (c.segment.startM - pos + track.length) % track.length;
    if (until <= LOOKAHEAD_M && (!climb || until < ahead)) {
      climb = c;
      ahead = until;
    }
  }
  if (!climb) return null;

  const into = ahead > 0 ? 0 : pos - climb.segment.startM;
  const live = snapshot.activeSegments.find((a) => a.segment.id === climb.segment.id);
  const delta = live?.bestS !== undefined ? live.elapsedS - live.bestS * live.progress : undefined;

  return (
    <div className="hud-panel hud-climb">
      <div className="climb-head">
        <div>
          <div className="hud-label">Anstieg</div>
          <div className="climb-name">{climb.segment.name}</div>
        </div>
        <div className="climb-stats">
          <span>{(climb.lengthM / 1000).toFixed(1)} km</span>
          <span>Ø {climb.avgGrade.toFixed(1)} %</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="climb-profile">
        {climb.bars.map((b, i) => (
          <path key={i} d={b.d} fill={b.color} />
        ))}
        <path d={climb.outline} className="climb-outline" />
        {ahead === 0 && <rect x={(into / climb.lengthM) * W - 1} y={0} width={2} height={H} className="climb-marker" />}
      </svg>
      <div className="climb-foot">
        {ahead > 0 ? (
          <span>Start in {ahead >= 1000 ? `${(ahead / 1000).toFixed(1)} km` : `${Math.round(ahead / 10) * 10} m`}</span>
        ) : (
          <span>
            noch <strong>{((climb.lengthM - into) / 1000).toFixed(1)} km</strong>
          </span>
        )}
        {ahead === 0 ? (
          <span className="climb-now" style={{ background: gradeColor(snapshot.gradePercent) }}>
            {snapshot.gradePercent.toFixed(1)} %
          </span>
        ) : (
          <span className="muted">Gipfel {Math.round(climb.topM)} m</span>
        )}
      </div>
      {live && (
        <div className="climb-foot small">
          <span>⏱ {formatDuration(live.elapsedS)}</span>
          {delta !== undefined && (
            <span className={delta <= 0 ? 'good' : 'bad'}>
              {delta <= 0 ? '−' : '+'}
              {formatDuration(Math.abs(delta))} zur Bestzeit
            </span>
          )}
        </div>
      )}
    </div>
  );
}
