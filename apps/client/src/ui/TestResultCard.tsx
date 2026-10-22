import { useState } from 'react';
import type { ActivitySummary } from '@velo/metrics';
import { zoneWatts, type TestResult } from '@velo/workouts';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { fmt } from './components';

const CONFIDENCE: Record<NonNullable<TestResult['confidence']>, string> = {
  hoch: 'Zuverlässigkeit hoch',
  mittel: 'Zuverlässigkeit mittel',
  schätzung: 'Schätzung',
};

/** End-of-ride evaluation of an FTP test (also for tests stopped early). */
export function TestResultCard({ test, summary }: { test: TestResult; summary: ActivitySummary }) {
  const settings = useStore(settingsStore);
  // Remember the FTP before applying, so the comparison stays meaningful afterwards.
  const [oldFtp] = useState(settings.ftp);
  const applied = test.ftp !== undefined && settings.ftp === test.ftp && oldFtp !== test.ftp;
  const ftp = test.ftp;
  const diff = ftp !== undefined ? ftp - oldFtp : 0;
  const bests: Array<[string, number]> = [
    ['Max.', summary.maxPower],
    ['1 min', summary.best1min],
    ['5 min', summary.best5min],
    ['20 min', summary.best20min],
  ];

  return (
    <div className="test-result">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="muted small">{test.kind === 'ramp' ? 'Rampentest' : '20-Minuten-Test'} · Auswertung</div>
          {ftp !== undefined ? (
            <div className="test-ftp">
              <span className="big">{ftp}</span> W FTP
              <span className={`test-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`}>
                {diff === 0 ? '±0' : `${diff > 0 ? '+' : ''}${diff} W (${diff > 0 ? '+' : ''}${fmt((diff / oldFtp) * 100, 1)} %)`}
              </span>
            </div>
          ) : (
            <div className="test-ftp">Keine FTP ermittelt</div>
          )}
          <div className="muted small">
            {test.basis}
            {ftp !== undefined && ` · ${fmt(ftp / settings.weightKg, 2)} W/kg · bisher ${oldFtp} W`}
          </div>
        </div>
        {test.confidence && <span className={`badge test-conf ${test.confidence === 'hoch' ? 'ok' : ''}`}>{CONFIDENCE[test.confidence]}</span>}
      </div>

      <div className="test-bests">
        {bests.map(([k, v]) => (
          <div key={k}>
            <div className="muted small">Beste {k}</div>
            <strong>{v > 0 ? `${Math.round(v)} W` : '–'}</strong>
          </div>
        ))}
      </div>

      {ftp !== undefined && (
        <table className="zone-table">
          <tbody>
            {zoneWatts(ftp).map((z) => (
              <tr key={z.zone}>
                <td>
                  <span className={`zone-dot z${z.zone}`} />Z{z.zone}
                </td>
                <td>{z.name}</td>
                <td className="num">{z.to !== undefined ? `${z.from}–${z.to} W` : `ab ${z.from} W`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ul className="test-notes">
        {test.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
        {ftp !== undefined && <li>Gönn dir jetzt 1–2 lockere Tage (z. B. „Erholung 45“), bevor du wieder hart trainierst.</li>}
      </ul>

      {ftp !== undefined && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="primary" disabled={applied} onClick={() => updateSettings({ ftp })}>
            {applied ? 'Übernommen ✓' : `FTP ${ftp} W übernehmen`}
          </button>
        </div>
      )}
    </div>
  );
}
