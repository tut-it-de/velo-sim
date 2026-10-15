import { useEffect, useState, type ReactNode } from 'react';
import { formatCoins } from '@velo/equipment';
import { powerZone } from '@velo/metrics';
import { MAX_DRAFT_REDUCTION } from '@velo/physics';
import { CAMERA_MODES, type CameraMode } from '../game/world';
import type { RideSession } from '../ride/rideSession';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { fmt, formatDuration } from './components';
import { ElevationProfile } from './ElevationProfile';
import { WorkoutHud } from './WorkoutHud';
import { ActiveSegments, SegmentToast } from './SegmentHud';

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
  onFinish: () => void | Promise<void>;
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

        <div className="hud-top-center">
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
        <DraftBar draft={s.draft} />
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
        <div className="hud-chip">Ø {Math.round(s.avgPower)} W · NP {Math.round(s.normalizedPower)} W</div>
        <div className="hud-chip">{Math.round(s.kilojoules)} kJ</div>
        <div className={`hud-chip coins ${s.coinsDisabled ? 'disabled' : ''}`} title={s.coinsDisabled ? 'Mit dem Simulator gibt es keine Watt-Taler' : 'Watt-Taler dieser Fahrt'}>
          🪙 {s.coinsDisabled ? 'Simulator – keine Taler' : formatCoins(s.coins)}
        </div>
        <ActiveSegments snapshot={s} />
      </div>

      <SegmentToast result={s.lastResult} />

      {s.workout && (
        <div className="hud-center">
          <WorkoutHud session={session} snapshot={s} ftp={settings.ftp} />
        </div>
      )}

      {(s.others.length > 0 || session.net) && (
        <div className="hud-right hud-panel">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="hud-label">Mitfahrer</span>
            {session.net && <NetBadge session={session} />}
          </div>
          {[...s.others]
            .sort((a, b) => Math.abs(a.gapM) - Math.abs(b.gapM))
            .slice(0, 8)
            .sort((a, b) => b.gapM - a.gapM)
            .map((b) => (
              <div key={b.id} className="hud-bot">
                <span>
                  {b.remote ? '🌐 ' : ''}
                  {b.name}
                </span>
                <span className="muted">{b.wkg !== undefined ? `${b.wkg.toFixed(1)} W/kg` : b.power !== undefined ? `${Math.round(b.power)} W` : ''}</span>
                <span className={b.gapM >= 0 ? 'ahead' : 'behind'}>
                  {b.gapM >= 0 ? '+' : '−'}
                  {Math.abs(b.gapM) >= 1000 ? `${(Math.abs(b.gapM) / 1000).toFixed(1)} km` : `${Math.round(Math.abs(b.gapM))} m`}
                </span>
                {b.remote && (
                  <button className="rideon" title="Kudos geben" onClick={() => session.net?.sendRideOn(b.id)}>
                    👋
                  </button>
                )}
              </div>
            ))}
        </div>
      )}

      {session.net && <ChatBox session={session} />}
      {session.net && <RideOnToast session={session} />}

      {s.noTrainerData && !paused && <div className="hud-warning">Keine Leistungsdaten – ist der Trainer verbunden? (Geräte-Seite)</div>}
      {paused && <div className="hud-warning paused">Pausiert – „Weiter“ oder Taste P</div>}

      <div className="hud-bottom hud-panel">
        <ElevationProfile
          track={track}
          positionM={s.lapDistanceM}
          height={78}
          markers={s.others.map((b) => ({ id: b.id, positionM: track.wrap(s.lapDistanceM + b.gapM), color: b.remote ? '#3fb950' : '#58a6ff' }))}
        />
      </div>
    </div>
  );
}

function NetBadge({ session }: { session: RideSession }) {
  const net = useStore(session.net!.state);
  const label = net.status === 'online' ? `online · ${net.riderCount}` : net.status === 'connecting' ? 'verbinde …' : net.status === 'error' ? 'Fehler' : 'offline';
  return (
    <span className={`net-badge ${net.status}`} title={net.error ?? (net.authenticated ? 'angemeldet – Taler bucht der Server' : 'Gast – keine Taler auf dem Server')}>
      ● {label}
    </span>
  );
}

function ChatBox({ session }: { session: RideSession }) {
  const net = useStore(session.net!.state);
  const [text, setText] = useState('');
  const recent = net.chat.filter((c) => Date.now() - c.at < 60_000).slice(-5);
  return (
    <div className="hud-chat">
      {recent.map((c, i) => (
        <div key={i} className="hud-chat-line">
          <strong>{c.name}:</strong> {c.text}
        </div>
      ))}
      <input
        value={text}
        placeholder="Nachricht … (Enter)"
        maxLength={280}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && text.trim()) {
            session.net?.sendChat(text);
            setText('');
          }
        }}
      />
    </div>
  );
}

function RideOnToast({ session }: { session: RideSession }) {
  const net = useStore(session.net!.state);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!net.lastRideOn) return;
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(id);
  }, [net.lastRideOn?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!visible || !net.lastRideOn) return null;
  return <div className="rideon-toast">👋 {net.lastRideOn.name} gibt dir Kudos!</div>;
}

/** Fills up the closer you ride behind someone (full = maximum drag reduction). */
function DraftBar({ draft }: { draft: number }) {
  const fill = Math.min(1, Math.max(0, draft / MAX_DRAFT_REDUCTION));
  const active = fill > 0.02;
  return (
    <div className={`draft-bar ${active ? 'active' : ''}`} title="Windschatten: je voller, desto weniger Luftwiderstand">
      <span className="draft-label">Windschatten</span>
      <div className="draft-track" role="meter" aria-label="Windschatten" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill * 100)}>
        <div className="draft-fill" style={{ width: `${fill * 100}%` }} />
        {[0.25, 0.5, 0.75].map((t) => (
          <span key={t} className="draft-tick" style={{ left: `${t * 100}%` }} />
        ))}
      </div>
      <span className="draft-value">{active ? `−${Math.round(draft * 100)} % Luft` : '–'}</span>
    </div>
  );
}
