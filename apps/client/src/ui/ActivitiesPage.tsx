import { useEffect } from 'react';
import { ROUTES } from '@velo/routes';
import { recordKey, recordsStore } from '../state/records';
import { refreshStravaStatus, stravaStore, uploadToStrava } from '../net/strava';
import { StravaStatusLine } from './StravaStatusLine';
import { exportFile } from '../devices/files';
import { activitiesStore, deleteActivity, fitFileName, loadActivities } from '../state/activities';
import { useStore } from '../state/store';
import { fmt, formatDuration } from './components';

export function ActivitiesPage() {
  const activities = useStore(activitiesStore);
  const records = useStore(recordsStore);
  const strava = useStore(stravaStore);
  useEffect(() => {
    void loadActivities();
    void refreshStravaStatus();
  }, []);

  const totals = activities.reduce(
    (acc, a) => ({ km: acc.km + a.summary.distanceM / 1000, s: acc.s + a.summary.durationS, tss: acc.tss + a.summary.tss }),
    { km: 0, s: 0, tss: 0 },
  );

  return (
    <div className="page">
      <div className="page-inner">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>Aktivitäten</h1>
          {activities.length > 0 && (
            <span className="muted small">
              {activities.length} Fahrten · {totals.km.toFixed(0)} km · {formatDuration(totals.s)} · {fmt(totals.tss)} TSS
            </span>
          )}
        </div>
        <div className="card">
          <h2>Persönliche Bestzeiten</h2>
          <div className="grid cols-3">
            {ROUTES.map((r) => (
              <div key={r.id}>
                <strong>{r.name}</strong>
                <table className="segments-table">
                  <tbody>
                    {[{ id: 'lap', name: 'Runde' }, ...r.segments].map((seg) => {
                      const pb = records[recordKey(r.id, seg.id)];
                      return (
                        <tr key={seg.id}>
                          <td>{seg.name}</td>
                          <td>{pb ? formatDuration(pb.timeS) : '–'}</td>
                          <td className="muted small">{pb ? new Date(pb.date).toLocaleDateString('de-DE') : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            Fahrten mit dem Simulator zählen nicht für Bestzeiten.
          </div>
        </div>
        {activities.length === 0 && <div className="card muted">Noch keine Fahrten. Unter „Fahren“ geht’s los.</div>}
        {activities.map((a) => (
          <div key={a.id} className="card activity-row">
            <div style={{ flex: 1, minWidth: 220 }}>
              <strong>{a.title}</strong>
              {a.simulated && <span className="badge">Simulator</span>}
              <div className="muted small">
                {(a.summary.distanceM / 1000).toFixed(1)} km · {formatDuration(a.summary.durationS)} · Ø {fmt(a.summary.avgPower)} W · NP{' '}
                {fmt(a.summary.normalizedPower)} W · {fmt(a.summary.tss)} TSS · {Math.round(a.summary.ascentM)} hm
              </div>
            </div>
            <div className="row">
              {a.strava && a.strava.status !== 'error' ? (
                <StravaStatusLine activity={a} compact />
              ) : (
                strava.connected &&
                !a.simulated && (
                  <button className="strava-button small" onClick={() => void uploadToStrava(a)} title={a.strava?.error}>
                    {a.strava?.status === 'error' ? 'Strava erneut' : 'Zu Strava'}
                  </button>
                )
              )}
              <button onClick={() => exportFile(fitFileName(a), a.fit)}>FIT</button>
              <button
                className="danger"
                onClick={() => {
                  if (confirm('Aktivität wirklich löschen?')) void deleteActivity(a.id);
                }}
              >
                Löschen
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
