import type { StoredActivity } from '../state/activities';
import { openExternal } from '../net/strava';

/** Shows where an activity stands on Strava, with a link once it exists. */
export function StravaStatusLine({ activity, compact = false }: { activity: StoredActivity; compact?: boolean }) {
  const s = activity.strava;
  if (!s) return null;
  const link = s.url && (
    <button className="link strava-link" onClick={() => void openExternal(s.url!)}>
      Auf Strava ansehen ↗
    </button>
  );
  const text: Record<NonNullable<StoredActivity['strava']>['status'], string> = {
    uploading: 'Lade zu Strava hoch …',
    processing: 'Strava verarbeitet die Fahrt …',
    ready: 'Auf Strava hochgeladen ✓',
    duplicate: 'Schon auf Strava',
    error: `Strava-Upload fehlgeschlagen: ${s.error ?? 'unbekannter Fehler'}`,
    skipped: s.error ?? 'Nicht hochgeladen',
  };
  if (compact) return link ?? <span className="muted small">{text[s.status]}</span>;
  return (
    <div className={`strava-status ${s.status}`}>
      <span className="strava-mark">Strava</span> {text[s.status]} {link}
    </div>
  );
}
