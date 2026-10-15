import { powerZone } from '@velo/metrics';
import { cadenceRange, formatCadence, segmentPowerAt } from '@velo/workouts';
import type { RideSession, RideSnapshot } from '../ride/rideSession';
import { formatDuration } from './components';
import { WorkoutChart } from './WorkoutChart';

function cadenceStatus(cadence: number, target: ReturnType<typeof cadenceRange>): 'ok' | 'low' | 'high' | null {
  if (!target) return null;
  if (cadence < target[0]) return 'low';
  if (cadence > target[1]) return 'high';
  return 'ok';
}

export function WorkoutHud({ session, snapshot, ftp }: { session: RideSession; snapshot: RideSnapshot; ftp: number }) {
  const w = snapshot.workout;
  const player = session.player;
  if (!w || !player) return null;

  if (w.finished) {
    return (
      <div className="hud-panel workout-hud">
        <div className="workout-done">
          ✅ Workout „{w.name}“ geschafft – Treffer {Math.round(w.compliance * 100)} %. Du fährst jetzt frei weiter (SIM-Modus).
        </div>
      </div>
    );
  }

  const seg = w.segment;
  const next = w.next;
  const cad = cadenceStatus(snapshot.cadence, cadenceRange(w.cadenceTarget));
  const zone = w.targetFraction !== undefined ? powerZone(w.targetFraction, 1) : undefined;
  const delta = w.targetWatts !== undefined ? snapshot.power3s - w.targetWatts : 0;
  const onTarget = w.targetWatts !== undefined && Math.abs(delta) <= Math.max(10, w.targetWatts * 0.1);

  const nextLabel = next
    ? `${next.label} · ${formatDuration(next.durationS)}${
        next.mode === 'erg' ? ` @ ${Math.round(segmentPowerAt(next, next.startS) * ftp * w.intensity)} W` : next.kind === 'maxeffort' ? ' · Vollgas' : ' · frei'
      }`
    : 'Ende';

  return (
    <div className="hud-panel workout-hud">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="hud-label">{w.name}</div>
          <div className="workout-seg">{seg?.label ?? '–'}</div>
        </div>
        <div className="workout-remaining">{formatDuration(Math.ceil(w.segmentRemainingS))}</div>
      </div>
      <div className="row workout-targets">
        <div className="workout-target" style={{ borderColor: zone?.color ?? '#5b6472' }}>
          {w.mode === 'erg' && w.targetWatts !== undefined ? (
            <>
              <span className="big">{w.targetWatts}</span>
              <span className="unit">W</span>
              <span className={`delta ${onTarget ? 'ok' : 'off'}`}>
                {onTarget ? '✓' : `${delta > 0 ? '+' : ''}${Math.round(delta)}`}
              </span>
            </>
          ) : (
            <span className="big">{seg?.kind === 'maxeffort' ? 'VOLLGAS' : 'FREI'}</span>
          )}
        </div>
        {w.cadenceTarget !== undefined && (
          <div className={`workout-cadence ${cad ?? ''}`}>
            {formatCadence(w.cadenceTarget)}
            <span>{cad === 'low' ? '↑ schneller' : cad === 'high' ? '↓ langsamer' : '✓'}</span>
          </div>
        )}
        <div className="muted small" style={{ flex: 1, textAlign: 'right' }}>
          Als Nächstes: {nextLabel}
          <br />
          Rest {formatDuration(w.totalS - w.elapsedS)} · Treffer {Math.round(w.compliance * 100)} %
        </div>
      </div>
      <WorkoutChart workout={player.workout} height={48} elapsedS={w.elapsedS} trace={session.workoutTrace} ftp={ftp} />
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 6 }}>
        <div className="row" style={{ gap: 4 }}>
          <button onClick={() => session.setIntensity(w.intensity - 0.05)} aria-label="Intensität verringern">
            −
          </button>
          <span className="small" style={{ minWidth: 92, textAlign: 'center' }}>
            Intensität {Math.round(w.intensity * 100)} %
          </span>
          <button onClick={() => session.setIntensity(w.intensity + 0.05)} aria-label="Intensität erhöhen">
            +
          </button>
        </div>
        <button onClick={() => session.skipSegment()}>⏭ Block überspringen</button>
      </div>
      {w.relief && <div className="workout-relief">ERG entlastet – Kadenz erhöhen, dann geht’s mit dem Ziel weiter.</div>}
      {w.activeText && <div className="workout-text">{w.activeText}</div>}
    </div>
  );
}
