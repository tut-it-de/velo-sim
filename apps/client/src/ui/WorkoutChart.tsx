import { useMemo } from 'react';
import { powerZone } from '@velo/metrics';
import { buildTimeline, type Workout } from '@velo/workouts';

const W = 1000;
const MAX_FRACTION = 1.6;

interface Props {
  workout: Workout;
  height?: number;
  /** Current workout time in seconds (draws a cursor). */
  elapsedS?: number;
  /** [workout second, watts] — actual power overlay. */
  trace?: Array<[number, number]>;
  ftp?: number;
}

/** Workout profile: one block per timeline segment, coloured by power zone. */
export function WorkoutChart({ workout, height = 80, elapsedS, trace, ftp = 200 }: Props) {
  const timeline = useMemo(() => buildTimeline(workout), [workout]);
  const total = timeline.reduce((a, s) => a + s.durationS, 0) || 1;
  const x = (t: number) => (t / total) * W;
  const y = (f: number) => height - (Math.min(MAX_FRACTION, f) / MAX_FRACTION) * (height - 4);

  const tracePath = useMemo(() => {
    if (!trace || trace.length < 2) return '';
    // downsample to ~600 points
    const step = Math.max(1, Math.floor(trace.length / 600));
    let d = '';
    for (let i = 0; i < trace.length; i += step) {
      const [t, p] = trace[i]!;
      d += `${d ? 'L' : 'M'}${x(t).toFixed(1)},${y(p / ftp).toFixed(1)}`;
    }
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace?.length, ftp, total, height]);

  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      {timeline.map((s) => {
        const x0 = x(s.startS);
        const x1 = x(s.startS + s.durationS);
        if (s.mode === 'free') {
          const top = s.kind === 'maxeffort' ? y(MAX_FRACTION) : y(0.6);
          return (
            <g key={s.index}>
              <rect x={x0} y={top} width={Math.max(0.5, x1 - x0)} height={height - top} fill={s.kind === 'maxeffort' ? '#ef4444' : '#5b6472'} opacity={0.85} />
            </g>
          );
        }
        const avg = (s.powerStart + s.powerEnd) / 2;
        const color = powerZone(avg, 1).color;
        return (
          <polygon
            key={s.index}
            points={`${x0},${height} ${x0},${y(s.powerStart)} ${x1},${y(s.powerEnd)} ${x1},${height}`}
            fill={color}
            stroke="#0d1117"
            strokeWidth={0.6}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      <line x1={0} x2={W} y1={y(1)} y2={y(1)} stroke="#ffffff" strokeOpacity={0.35} strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
      {tracePath && <path d={tracePath} fill="none" stroke="#ffffff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      {elapsedS !== undefined && <rect x={x(elapsedS) - 1} y={0} width={2.5} height={height} fill="#ffffff" />}
    </svg>
  );
}
