import { useEffect } from 'react';
import { ROUTES } from '@velo/routes';
import { recordKey, recordsStore } from '../state/records';
import { refreshStravaStatus, stravaStore, uploadToStrava } from '../net/strava';
import { StravaStatusLine } from './StravaStatusLine';
import { exportFile } from '../devices/files';
import { activityFit, syncActivitiesQuietly } from '../net/activitySync';
import { activitiesStore, deleteActivity, fitFileName, loadActivities } from '../state/activities';
import { useStore } from '../state/store';
import { fmt, formatDuration } from './components';
import { FitnessCard } from './FitnessCard';

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
        <div className="page-head">
          <div>
            <h1>Aktivitäten</h1>
          </div>
        </div>
        {activities.length > 0 && (
          <div className="stat-row stat-row-4">
            <div className="stat"><span className="stat-label">Fahrten</span><span className="stat-value">{activities.length}</span></div>
            <div className="stat"><span className="stat-label">Distanz</span><span className="stat-value">{totals.km.toFixed(0)}<small>km</small></span></div>
            <div className="stat"><span className="stat-label">Zeit</span><span className="stat-value">{formatDuration(totals.s)}</span></div>
            <div className="stat"><span className="stat-label">Belastung</span><span className="stat-value">{fmt(totals.tss)}<small>TSS</small></span></div>
          </div>
        )}
        <FitnessCard />
        <div className="card">
          <h2>Persönliche Bestzeiten</h2>
          <div className="pb-grid">
            {ROUTES.map((r) => (
              <div key={r.id} className="pb-card">
                <div className="pb-card-title">{r.name}</div>
                <table className="segments-table">
                  <tbody>
                    {[{ id: 'lap', name: 'Runde' }, ...r.segments].map((seg) => {
                      const pb = records[recordKey(r.id, seg.id)];
                      return (
                        <tr key={seg.id}>
                          <td>{seg.name}</td>
                          <td className="pb-time">{pb ? formatDuration(pb.timeS) : '–'}</td>
                          <td className="pb-date">{pb ? new Date(pb.date).toLocaleDateString('de-DE') : ''}</td>
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
            <div className="activity-title">
              <strong>{a.title}</strong>
              {a.simulated && <span className="badge">Simulator</span>}
            </div>
            <div className="activity-stats">
              <span><strong>{(a.summary.distanceM / 1000).toFixed(1)}</strong>km</span>
              <span><strong>{formatDuration(a.summary.durationS)}</strong>Zeit</span>
              <span><strong>{fmt(a.summary.avgPower)}</strong>Ø W</span>
              <span><strong>{fmt(a.summary.normalizedPower)}</strong>NP W</span>
              <span><strong>{fmt(a.summary.tss)}</strong>TSS</span>
              <span><strong>{Math.round(a.summary.ascentM)}</strong>hm</span>
            </div>
            <div className="row activity-actions">
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
              <button onClick={() => void activityFit(a).then((fit) => exportFile(fitFileName(a), fit)).catch((err) => alert(err instanceof Error ? err.message : String(err)))}>FIT</button>
              <button
                className="danger"
                onClick={() => {
                  if (confirm('Aktivität wirklich löschen? Sie wird auch auf deinen anderen Geräten gelöscht.')) void deleteActivity(a.id).then(() => syncActivitiesQuietly());
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
