import type { ReactNode } from 'react';
import { powerZone } from '@velo/metrics';
import { CAMERA_MODES, type CameraMode } from '../game/world';
import type { RideSession } from '../ride/rideSession';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { fmt, formatDuration } from './components';
import { ElevationProfile } from './ElevationProfile';
import { WorkoutHud } from './WorkoutHud';

function gradeColor(g: number): string {
  if (g >= 8) return '#ef4444';
  if (g >= 5) return '#f97316';
  if (g >= 2) return '#eab308';
  if (g <= -2) return '#3b82f6';
  return '#8b949e';
}

function Metric({ label, value, unit, sub, accent }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; accent?: string }) {
  return (
    <div className="hud-metric" style={accent ? { borderColor: accent } : undefined}>
      <div className="hud-label">{label}</div>
      <div className="hud-value">
        {value}
        {unit && <span className="hud-unit">{unit}</span>}
      </div>
      {sub && <div className="hud-sub">{sub}</div>}
    </div>
  );
}

export function Hud({
  session,
  camera,
  onCamera,
  onFinish,
}: {
  session: RideSession;
  camera: CameraMode;
  onCamera: (m: CameraMode) => void;
  onFinish: () => void;
}) {
  const s = useStore(session.snapshot);
  const settings = useStore(settingsStore);
  const track = session.track;
  const zone = powerZone(s.power3s, settings.ftp);
  const paused = s.state === 'paused';

  return (
    <div className="hud">
      <div className="hud-top">
        <div className="hud-panel hud-route">
          <div className="hud-route-name">{track.name}</div>
          <div className="small">
            Runde {s.lap} · {(s.lapDistanceM / 1000).toFixed(2)} / {(track.length / 1000).toFixed(1)} km
          </div>
          <div className="hud-route-stats">
            <span>⏱ {formatDuration(s.movingS)}</span>
            <span>↔ {(s.distanceM / 1000).toFixed(2)} km</span>
            <span>⛰ {Math.round(s.ascentM)} hm</span>
          </div>
        </div>

        <div className="hud-metrics">
          <Metric
            label="Leistung"
            value={fmt(s.power3s)}
            unit="W"
            sub={`${(s.power3s / settings.weightKg).toFixed(1)} W/kg · Z${zone.zone}`}
            accent={zone.color}
          />
          <Metric label="Speed" value={fmt(s.speedMps * 3.6, 1)} unit="km/h" />
          <Metric label="Kadenz" value={fmt(s.cadence)} unit="rpm" />
          <Metric label="Herzfrequenz" value={fmt(s.heartRate)} unit="bpm" />
        </div>

        <div className="hud-controls">
          <select value={camera} onChange={(e) => onCamera(e.target.value as CameraMode)} aria-label="Kamera">
            {CAMERA_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                📷 {m.label}
              </option>
            ))}
          </select>
          <button onClick={() => (paused ? session.resume() : session.pause())}>{paused ? '▶ Weiter' : '⏸ Pause'}</button>
          <button className="danger" onClick={onFinish}>
            ■ Beenden
          </button>
        </div>
      </div>

      <div className="hud-left">
        <div className="hud-grade" style={{ background: gradeColor(s.gradePercent) }}>
          {s.gradePercent >= 0 ? '' : '−'}
          {Math.abs(s.gradePercent).toFixed(1)}
          <span>%</span>
        </div>
        {s.trainerGrade !== undefined && <div className="hud-chip">Trainer {s.trainerGrade.toFixed(1)} %</div>}
        {s.draft > 0.03 && <div className="hud-chip draft">Windschatten −{Math.round(s.draft * 100)} %</div>}
        <div className="hud-chip">Ø {Math.round(s.avgPower)} W · NP {Math.round(s.normalizedPower)} W</div>
        <div className="hud-chip">{Math.round(s.kilojoules)} kJ</div>
      </div>

      {s.workout && (
        <div className="hud-center">
          <WorkoutHud session={session} snapshot={s} ftp={settings.ftp} />
        </div>
      )}

      {s.bots.length > 0 && (
        <div className="hud-right hud-panel">
          <div className="hud-label" style={{ marginBottom: 6 }}>
            Mitfahrer
          </div>
          {[...s.bots]
            .sort((a, b) => b.gapM - a.gapM)
            .map((b) => (
              <div key={b.id} className="hud-bot">
                <span>{b.name}</span>
                <span className="muted">{b.wkg.toFixed(1)} W/kg</span>
                <span className={b.gapM >= 0 ? 'ahead' : 'behind'}>
                  {b.gapM >= 0 ? '+' : '−'}
                  {Math.abs(b.gapM) >= 1000 ? `${(Math.abs(b.gapM) / 1000).toFixed(1)} km` : `${Math.round(Math.abs(b.gapM))} m`}
                </span>
              </div>
            ))}
        </div>
      )}

      {s.noTrainerData && !paused && <div className="hud-warning">Keine Leistungsdaten – ist der Trainer verbunden? (Geräte-Seite)</div>}
      {paused && <div className="hud-warning paused">Pausiert – „Weiter“ oder Taste P</div>}

      <div className="hud-bottom hud-panel">
        <ElevationProfile
          track={track}
          positionM={s.lapDistanceM}
          height={78}
          markers={s.bots.map((b) => ({ id: b.id, positionM: track.wrap(s.lapDistanceM + b.gapM), color: '#58a6ff' }))}
        />
      </div>
    </div>
  );
}
