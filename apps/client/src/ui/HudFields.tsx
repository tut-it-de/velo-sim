import type { ReactNode } from 'react';
import { referenceFtp } from '../ftp/advisor';
import { fieldDef, fieldValue, splitFields, type HudFieldId } from '../ride/hudFields';
import type { RideSnapshot } from '../ride/rideSession';
import type { Settings } from '../state/settings';

export function Metric({ label, value, unit, sub, accent }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; accent?: string }) {
  return (
    <div className="hud-metric" style={accent ? { borderBottomColor: accent } : undefined}>
      <div className="hud-label">{label}</div>
      <div className="hud-value">
        {value}
        {unit && <span className="hud-unit">{unit}</span>}
      </div>
      <div className="hud-sub">{sub ?? ' '}</div>
    </div>
  );
}

function Tiles({ ids, snapshot, settings, className }: { ids: HudFieldId[]; snapshot: RideSnapshot; settings: Settings; className: string }) {
  const ctx = { ftp: referenceFtp(settings), weightKg: settings.weightKg };
  return (
    <div className={`hud-metrics ${className}`}>
      {ids.map((id) => {
        const v = fieldValue(id, snapshot, ctx);
        return <Metric key={id} label={fieldDef(id).label} value={v.value} unit={v.unit} sub={v.sub} accent={v.accent} />;
      })}
    </div>
  );
}

/**
 * The rider's data fields (Settings → Datenfelder): the first half left of the elevation profile,
 * the rest right of it. `profile` goes in between.
 */
export function HudFieldBar({ snapshot, settings, profile }: { snapshot: RideSnapshot; settings: Settings; profile: ReactNode }) {
  const ids = snapshot.workout ? settings.hudFields.workout : settings.hudFields.free;
  const [left, right] = splitFields(ids);
  return (
    <div className="hud-bottom">
      <Tiles ids={left} snapshot={snapshot} settings={settings} className="hud-metrics-left" />
      {profile}
      <Tiles ids={right} snapshot={snapshot} settings={settings} className="hud-metrics-right" />
    </div>
  );
}
