import { useState } from 'react';
import { exportFile } from '../devices/files';
import { settingsStore, updateSettings } from '../state/settings';
import type { RideResult } from '../ride/rideSession';
import { fitFileName, type StoredActivity } from '../state/activities';
import { fmt, formatDuration } from './components';
import { formatCoins, total } from '@velo/equipment';
import { balance, garageStore } from '../state/garage';
import { useStore } from '../state/store';

export function RideSummary({ result, activity, onClose }: { result: RideResult; activity: StoredActivity; onClose: () => void }) {
  const s = result.summary;
  const [ftpApplied, setFtpApplied] = useState(false);
  const newFtp = result.workout?.rampTestFtp;
  const garage = useStore(garageStore);
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
        <div className="earnings" hidden={!!result.server}>
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
        {newFtp !== undefined && (
          <div className="notice row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
            <span>
              Rampentest: beste Minute {Math.round(s.best1min)} W → <strong>neue FTP {newFtp} W</strong> (bisher {settingsStore.get().ftp} W)
            </span>
            <button
              className="primary"
              disabled={ftpApplied}
              onClick={() => {
                updateSettings({ ftp: newFtp });
                setFtpApplied(true);
              }}
            >
              {ftpApplied ? 'Übernommen ✓' : 'FTP übernehmen'}
            </button>
          </div>
        )}
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
                    <td>{r.isPb ? (r.saved ? '🏆 Bestzeit' : '🏆 (Simulator)') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {s.durationS < 60 && <div className="notice" style={{ marginTop: 12 }}>Sehr kurze Fahrt – Strava ignoriert Aktivitäten unter einer Minute.</div>}
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
