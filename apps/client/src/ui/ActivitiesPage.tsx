import { useEffect } from 'react';
import { exportFile } from '../devices/files';
import { activitiesStore, deleteActivity, fitFileName, loadActivities } from '../state/activities';
import { useStore } from '../state/store';
import { fmt, formatDuration } from './components';

export function ActivitiesPage() {
  const activities = useStore(activitiesStore);
  useEffect(() => {
    void loadActivities();
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
