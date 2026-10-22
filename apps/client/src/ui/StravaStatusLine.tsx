import type { StoredActivity } from '../state/activities';
import poweredByStrava from '../assets/strava/powered-by-strava-white.svg';
import { openExternal } from '../net/strava';

/** Official Strava attribution (brand guidelines: unmodified asset, less prominent than our own name). */
export function PoweredByStrava() {
  return <img className="powered-by-strava" src={poweredByStrava} width={146} height={15} alt="Powered by Strava" />;
}

/** Shows where an activity stands on Strava, with a link once it exists. */
export function StravaStatusLine({ activity, compact = false }: { activity: StoredActivity; compact?: boolean }) {
  const s = activity.strava;
  if (!s) return null;
  const link = s.url && (
    <button className="link strava-link" onClick={() => void openExternal(s.url!)}>
      View on Strava
    </button>
  );
  const text: Record<NonNullable<StoredActivity['strava']>['status'], string> = {
    pending: 'Wartet auf Internet – wird automatisch zu Strava hochgeladen',
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
      <PoweredByStrava />
    </div>
  );
}
