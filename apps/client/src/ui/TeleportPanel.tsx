import { useMemo, useState } from 'react';
import type { MinimapData } from '../game/real/realWorld';
import type { RideSession } from '../ride/rideSession';
import { ElevationProfile } from './ElevationProfile';
import { Minimap, nearestDistance } from './Minimap';

interface Jump {
  id: string;
  label: string;
  sub: string;
  distanceM: number;
  kind: 'start' | 'climb' | 'sprint' | 'segment' | 'place';
}

const KIND_ICON: Record<Jump['kind'], string> = { start: '🏁', climb: '⛰', sprint: '⚡', segment: '◆', place: '📍' };

/**
 * Admin tool in the ride: pick a point on the map or the elevation profile (or one of the jump targets)
 * and the rider is put there. Teleported rides earn no Taler and set no best times.
 */
export function TeleportPanel({
  session,
  map,
  positionM,
  onClose,
}: {
  session: RideSession;
  map: MinimapData | null;
  positionM: number;
  onClose: () => void;
}) {
  const track = session.track;
  const [km, setKm] = useState((positionM / 1000).toFixed(2));
  const [last, setLast] = useState<string | null>(null);

  const jumps = useMemo<Jump[]>(() => {
    const out: Jump[] = [{ id: 'start', label: 'Start / Ziel', sub: '0,00 km', distanceM: 0, kind: 'start' }];
    for (const s of track.segments) {
      const kind = s.type === 'climb' ? 'climb' : s.type === 'sprint' ? 'sprint' : 'segment';
      out.push({ id: `${s.id}-a`, label: s.name, sub: `Beginn · ${(s.startM / 1000).toFixed(2)} km`, distanceM: s.startM, kind });
      if (s.type === 'climb') {
        // a few metres before the line, so the summit is still ahead
        const top = Math.max(s.startM, s.endM - 150);
        out.push({ id: `${s.id}-b`, label: s.name, sub: `vor dem Gipfel · ${(top / 1000).toFixed(2)} km`, distanceM: top, kind });
      }
    }
    for (const p of map?.places ?? []) {
      const d = nearestDistance(track, p.x, p.z);
      const s = track.sample(d);
      if (Math.hypot(s.x - p.x, s.z - p.z) > 300) continue;
      if (out.some((j) => j.kind === 'place' && Math.abs(j.distanceM - d) < 400)) continue;
      out.push({ id: `place-${p.name}`, label: p.name, sub: `Ort · ${(d / 1000).toFixed(2)} km`, distanceM: d, kind: 'place' });
    }
    return out.sort((a, b) => a.distanceM - b.distanceM);
  }, [track, map]);

  const go = (d: number, label?: string) => {
    session.teleport(d);
    setKm((d / 1000).toFixed(2));
    setLast(label ?? `${(d / 1000).toFixed(2)} km`);
  };
  const pickLabel = (d: number) => `${(d / 1000).toFixed(2)} km · ${Math.round(track.sample(d).y)} m`;
  const kmValue = Number(km.replace(',', '.'));
  const kmValid = Number.isFinite(kmValue) && kmValue >= 0 && kmValue * 1000 < track.length;

  return (
    <div className="teleport" role="dialog" aria-label="Teleport">
      <div className="teleport-head">
        <div>
          <div className="eyebrow">Admin-Modus</div>
          <div className="teleport-title">Teleport</div>
        </div>
        <div className="teleport-pos">
          <span className="eyebrow">Position</span>
          <strong>{(positionM / 1000).toFixed(2)} km</strong>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Schließen" title="Schließen (T)">
          ✕
        </button>
      </div>

      {!session.canTeleport ? (
        <div className="notice">In einer Online-Fahrt ist der Teleport gesperrt: Der Server bucht aus den Positionen aller Fahrer.</div>
      ) : (
        <>
          <div className="teleport-body">
            <div className="teleport-map">
              <Minimap track={track} map={map} positionM={positionM} others={[]} width={560} height={360} onPick={(d) => go(d)} pickLabel={pickLabel} />
              <div className="teleport-hint">Auf die Strecke klicken, um dorthin zu springen</div>
            </div>
            <div className="teleport-jumps">
              <div className="eyebrow">Sprungziele</div>
              <div className="teleport-jump-list">
                {jumps.map((j) => (
                  <button key={j.id} className={`jump jump-${j.kind}`} onClick={() => go(j.distanceM, j.label)}>
                    <span className="jump-icon">{KIND_ICON[j.kind]}</span>
                    <span className="jump-text">
                      <span className="jump-label">{j.label}</span>
                      <span className="jump-sub">{j.sub}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="teleport-profile">
            <ElevationProfile track={track} positionM={positionM} height={96} onPick={(d) => go(d)} />
          </div>
          <form
            className="teleport-foot"
            onSubmit={(e) => {
              e.preventDefault();
              if (kmValid) go(kmValue * 1000);
            }}
          >
            <label className="teleport-km">
              <span>Kilometer</span>
              <input
                value={km}
                inputMode="decimal"
                onChange={(e) => setKm(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                aria-invalid={!kmValid}
              />
              <span className="muted">/ {(track.length / 1000).toFixed(2)}</span>
            </label>
            <button className="primary" type="submit" disabled={!kmValid}>
              Springen
            </button>
            <span className="teleport-note">{last ? `✓ Gesprungen: ${last}` : 'Nach einem Teleport zählt die Fahrt nicht für Taler und Bestzeiten.'}</span>
          </form>
        </>
      )}
    </div>
  );
}
