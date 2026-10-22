import { exportFile } from '../devices/files';
import type { RideResult } from '../ride/rideSession';
import { fitFileName, type StoredActivity } from '../state/activities';
import { fmt, formatDuration } from './components';
import { formatCoins, total } from '@velo/equipment';
import { balance, garageStore } from '../state/garage';
import { activitiesStore } from '../state/activities';
import { StravaStatusLine } from './StravaStatusLine';
import { TestResultCard } from './TestResultCard';
import { isLoggedIn } from '../net/api';
import { useStore } from '../state/store';

export function RideSummary({ result, activity, onClose }: { result: RideResult; activity: StoredActivity; onClose: () => void }) {
  const s = result.summary;
  const garage = useStore(garageStore);
  const live = useStore(activitiesStore).find((a) => a.id === activity.id) ?? activity;
  const earned = total(result.earnings);
  const rows: Array<[string, string]> = [
    ['Zeit (in Bewegung)', formatDuration(s.durationS)],
    ['Distanz', `${(s.distanceM / 1000).toFixed(2)} km`],
    ['Ø Geschwindigkeit', `${fmt(s.avgSpeedMps * 3.6, 1)} km/h`],
    ['Höhenmeter', `${Math.round(s.ascentM)} hm`],
    ['Ø Leistung', `${fmt(s.avgPower)} W`],
    ['Normalized Power', `${fmt(s.normalizedPower)} W`],
    ['Max. Leistung', `${fmt(s.maxPower)} W`],
    ['Intensität (IF)', s.intensityFactor.toFixed(2)],
    ['TSS', fmt(s.tss)],
    ['Arbeit', `${fmt(s.kilojoules)} kJ`],
    ['Ø Kadenz', s.avgCadence ? `${fmt(s.avgCadence)} rpm` : '–'],
    ['Ø / max. Herzfrequenz', s.avgHeartRate ? `${fmt(s.avgHeartRate)} / ${fmt(s.maxHeartRate)} bpm` : '–'],
    ['Runden', String(s.laps.length)],
    ['Beste 20 min', s.best20min ? `${fmt(s.best20min)} W` : '–'],
  ];
  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 'min(560px, calc(100vw - 32px))' }}>
        <h2>Fahrt beendet 🎉</h2>
        <div className="muted small" style={{ marginBottom: 12 }}>
          {activity.title}
          {activity.simulated && ' · mit Simulator gefahren'}
        </div>
        <div className="summary-grid">
          {rows.map(([k, v]) => (
            <div key={k}>
              <div className="muted small">{k}</div>
              <div className="summary-value">{v}</div>
            </div>
          ))}
        </div>
        {result.server && (
          <div className={`notice ${result.server.flagged ? '' : 'info'}`} style={{ marginTop: 12 }}>
            {result.server.flagged
              ? `⚠ Der Server hat die Fahrt markiert (${result.server.reason}) – keine Taler gebucht.`
              : result.server.reason
                ? `🌐 ${result.server.reason}`
                : `🌐 Vom Server gebucht: +${formatCoins(result.server.coins)} Watt-Taler für ${Math.round(result.server.kilojoules)} kJ und ${result.server.laps} Runde(n). Kontostand ${formatCoins(result.server.balance ?? 0)}.`}
          </div>
        )}
        {!result.server && isLoggedIn() && !result.simulated && (
          <div className="notice" style={{ marginTop: 12 }}>
            🪙 Mit Konto bucht der Server die Watt-Taler – diese Fahrt lief ohne Online-Verbindung, deshalb gibt es dafür keine Taler.
            Aktiviere beim Start „Online mit anderen fahren“.
          </div>
        )}
        <div className="earnings" hidden={!!result.server || (isLoggedIn() && !result.simulated)}>
          {result.simulated ? (
            <span className="muted">🪙 Mit dem Simulator gibt es keine Watt-Taler.</span>
          ) : (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>🪙 +{formatCoins(earned)} Watt-Taler</strong>
                <span className="muted small">Kontostand {formatCoins(balance(garage))}</span>
              </div>
              {result.earnings.map((l) => (
                <div key={l.reason} className="row small muted" style={{ justifyContent: 'space-between' }}>
                  <span>{l.label}</span>
                  <span>+{formatCoins(l.amount)}</span>
                </div>
              ))}
            </>
          )}
        </div>
        {result.workout && (
          <div className="notice info" style={{ marginTop: 12 }}>
            Workout „{result.workout.name}“ {result.workout.completed ? 'komplett geschafft' : 'vorzeitig beendet'} · Treffer{' '}
            {Math.round(result.workout.compliance * 100)} % der ERG-Zeit im Zielbereich
          </div>
        )}
        {result.workout?.test && <TestResultCard test={result.workout.test} summary={s} />}
        {result.segments.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="muted small" style={{ marginBottom: 4 }}>
              Segmente & Runden
            </div>
            <table className="segments-table">
              <tbody>
                {result.segments.map((r, i) => (
                  <tr key={i}>
                    <td>{r.segment.name}</td>
                    <td>{formatDuration(r.timeS)}</td>
                    <td className="muted">{r.previousBestS !== undefined ? `PB ${formatDuration(r.previousBestS)}` : ''}</td>
                    <td>{r.isPb ? (r.saved ? 'Bestzeit' : 'Bestzeit (Simulator)') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {s.durationS < 60 && <div className="notice" style={{ marginTop: 12 }}>Sehr kurze Fahrt – wird nicht automatisch zu Strava hochgeladen.</div>}
        {live.strava && (
          <div style={{ marginTop: 12 }}>
            <StravaStatusLine activity={live} />
          </div>
        )}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={() => exportFile(fitFileName(activity), activity.fit)}>FIT-Datei exportieren</button>
          <button className="primary" onClick={onClose}>
            Fertig
          </button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Die Fahrt ist unter „Aktivitäten“ gespeichert. Die FIT-Datei kannst du bei Strava über „Hochladen → Datei“ importieren.
        </p>
      </div>
    </div>
  );
}
