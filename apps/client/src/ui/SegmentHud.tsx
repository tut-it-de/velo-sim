import { useEffect, useState } from 'react';
import type { RideSnapshot, SegmentOutcome } from '../ride/rideSession';
import { formatDuration } from './components';

const TYPE_COLOR = { climb: '#c62828', sprint: '#2e7d32', descent: '#1565c0', lap: '#4dabf7' } as const;
const TYPE_LABEL = { climb: 'Bergwertung', sprint: 'Sprint', descent: 'Abfahrt', lap: 'Runde' } as const;

function delta(s: number): string {
  const sign = s < 0 ? '−' : '+';
  const abs = Math.abs(s);
  return abs < 60 ? `${sign}${abs.toFixed(1)} s` : `${sign}${formatDuration(abs)}`;
}

/** Live timing for the segment(s) currently being ridden (climbs can be left to the climb panel). */
export function ActiveSegments({ snapshot, skipClimbs = false }: { snapshot: RideSnapshot; skipClimbs?: boolean }) {
  const list = skipClimbs ? snapshot.activeSegments.filter((a) => a.segment.type !== 'climb') : snapshot.activeSegments;
  if (list.length === 0) return null;
  return (
    <>
      {list.map((a) => {
        const len = a.segment.endM - a.segment.startM;
        // Compare against the PB pro rata — good enough for a live indication.
        const live = a.bestS !== undefined ? a.elapsedS - a.bestS * a.progress : undefined;
        return (
          <div key={a.segment.id} className="segment-live" style={{ borderColor: TYPE_COLOR[a.segment.type] }}>
            <div className="segment-head">
              <span style={{ color: TYPE_COLOR[a.segment.type] }}>{TYPE_LABEL[a.segment.type]}</span> {a.segment.name}
            </div>
            <div className="segment-bar">
              <div style={{ width: `${a.progress * 100}%`, background: TYPE_COLOR[a.segment.type] }} />
            </div>
            <div className="segment-meta">
              <span>{formatDuration(a.elapsedS)}</span>
              <span className="muted">
                {(a.distanceIntoM / 1000).toFixed(2)} / {(len / 1000).toFixed(2)} km
              </span>
              {live !== undefined && <span className={live <= 0 ? 'ahead' : 'behind'}>{delta(live)}</span>}
            </div>
            {a.bestS !== undefined && <div className="muted small">Bestzeit {formatDuration(a.bestS)}</div>}
          </div>
        );
      })}
    </>
  );
}

/** Pops up for a few seconds when a segment or lap is finished. */
export function SegmentToast({ result }: { result?: SegmentOutcome }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!result) return;
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 7000);
    return () => clearTimeout(id);
  }, [result?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!result || !visible) return null;
  const type = result.segment.type;
  const diff = result.previousBestS !== undefined ? result.timeS - result.previousBestS : undefined;
  return (
    <div className={`segment-toast ${result.isPb ? 'pb' : ''}`} style={{ borderColor: TYPE_COLOR[type] }}>
      <div className="small" style={{ color: TYPE_COLOR[type], fontWeight: 700 }}>
        {TYPE_LABEL[type]} · {result.segment.name}
      </div>
      <div className="segment-toast-time">{formatDuration(result.timeS)}</div>
      <div className="small">
        {result.isPb
          ? diff !== undefined
            ? `Neue Bestzeit (${delta(diff)})`
            : 'Erste Zeit – deine neue Bestzeit'
          : `${delta(diff ?? 0)} zur Bestzeit`}
        {result.isPb && !result.saved && ' · Simulator: nicht gespeichert'}
      </div>
    </div>
  );
}
