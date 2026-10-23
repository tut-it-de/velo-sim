import { referenceFtp } from '../ftp/advisor';
import { useEffect, useRef, useState } from 'react';
import { formatCoins } from '@velo/equipment';
import { MAX_DRAFT_REDUCTION } from '@velo/physics';
import type { MinimapData } from '../game/real/realWorld';
import { CAMERA_MODES, type CameraMode } from '../game/world';
import { GEARS, type RideSession, type RideSnapshot } from '../ride/rideSession';
import { accountStore } from '../net/api';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { ClimbPanel } from './ClimbPanel';
import { formatDuration } from './components';
import { ElevationProfile } from './ElevationProfile';
import { Flag } from './Flag';
import { HudFieldBar } from './HudFields';
import { Minimap } from './Minimap';
import { WorkoutHud } from './WorkoutHud';
import { ActiveSegments, SegmentToast } from './SegmentHud';
import { TeleportPanel } from './TeleportPanel';
import { WattLockControl } from './WattLockControl';

const OTHER_COLOR = { bot: '#58a6ff', remote: '#3fb950' };

export function Hud({
  session,
  map,
  camera,
  onCamera,
  onFinish,
}: {
  session: RideSession;
  map: MinimapData | null;
  camera: CameraMode;
  onCamera: (m: CameraMode) => void;
  onFinish: () => void | Promise<void>;
}) {
  const s = useStore(session.snapshot);
  const settings = useStore(settingsStore);
  const track = session.track;
  const paused = s.state === 'paused';
  const lapFraction = s.lapDistanceM / track.length;
  const [teleportOpen, setTeleportOpen] = useState(false);
  const admin = settings.adminMode;
  // Ramp test: stopping the pedals ends the test – straight to the result.
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const autoFinished = useRef(false);
  useEffect(() => {
    if (!s.testAborted || s.state !== 'riding' || autoFinished.current) return;
    autoFinished.current = true;
    void finishRef.current();
  }, [s.testAborted, s.state]);
  useEffect(() => {
    if (!admin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 't' || e.key === 'T') setTeleportOpen((o) => !o);
      else if (e.key === 'Escape') setTeleportOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [admin]);
  const markers = s.others.map((b) => ({
    id: b.id,
    positionM: track.wrap(s.lapDistanceM + b.gapM),
    color: b.remote ? OTHER_COLOR.remote : OTHER_COLOR.bot,
  }));

  return (
    <div className="hud">
      <div className="hud-top">
        <div className="hud-panel hud-route">
          <div className="hud-route-name">{track.name}</div>
          <div className="hud-route-stats">
            <span>{(track.length / 1000).toFixed(1)} km</span>
            <span>{Math.round(track.elevationGain)} hm</span>
            <span>Runde {s.lap}</span>
          </div>
          <div className="hud-route-bar" role="progressbar" aria-label="Rundenfortschritt" aria-valuenow={Math.round(lapFraction * 100)}>
            <div style={{ width: `${lapFraction * 100}%` }} />
          </div>
          <div className="hud-sub">
            {(s.lapDistanceM / 1000).toFixed(2)} / {(track.length / 1000).toFixed(1)} km
          </div>
        </div>

        <div className="hud-top-center">
          <DraftBar draft={s.draft} />
        </div>

        <div className="hud-controls">
          {s.wattLock === undefined && (
          <div className={`shifter${session.mode === 'erg' ? ' off' : ''}`} title={session.mode === 'erg' ? 'Im ERG-Modus hält der Trainer die Watt – Schalten wirkt erst wieder in der freien Fahrt' : 'Virtuell schalten: Taste − / +'}>
            <button onClick={() => session.shift(-1)} disabled={s.gear <= 1} aria-label="Leichter schalten">
              −
            </button>
            <span className="shifter-gear">
              <small>Gang</small>
              {s.gear}
            </span>
            <button onClick={() => session.shift(1)} disabled={s.gear >= GEARS.length} aria-label="Schwerer schalten">
              +
            </button>
          </div>
          )}
          <WattLockControl session={session} snapshot={s} />
          <select value={camera} onChange={(e) => onCamera(e.target.value as CameraMode)} aria-label="Kamera">
            {CAMERA_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                📷 {m.label}
              </option>
            ))}
          </select>
          {admin && (
            <button className={`admin-button ${teleportOpen ? 'active' : ''}`} onClick={() => setTeleportOpen((o) => !o)} title="Teleport (T)">
              ⌖ Teleport
            </button>
          )}
          <button onClick={() => (paused ? session.resume() : session.pause())}>{paused ? '▶ Weiter' : '⏸ Pause'}</button>
          <button className="danger" onClick={onFinish}>
            ■ Beenden
          </button>
        </div>
      </div>

      <div className="hud-left">
        <ClimbPanel track={track} snapshot={s} />
        <div className="hud-chips">
          <div className="hud-chip">Ø {Math.round(s.avgPower)} W · NP {Math.round(s.normalizedPower)} W</div>
          <div className="hud-chip">{Math.round(s.kilojoules)} kJ</div>
          <div className={`hud-chip coins ${s.coinsDisabled ? 'disabled' : ''}`} title={s.coinsDisabled ? 'Mit dem Simulator gibt es keine Watt-Taler' : 'Watt-Taler dieser Fahrt'}>
            {s.teleported ? 'Teleport – keine Taler' : s.coinsDisabled ? 'Simulator – keine Taler' : formatCoins(s.coins)}
          </div>
        </div>
        <ActiveSegments snapshot={s} skipClimbs />
      </div>

      <SegmentToast result={s.lastResult} />

      {s.workout && (
        <div className="hud-center">
          <WorkoutHud session={session} snapshot={s} ftp={referenceFtp(settings)} />
        </div>
      )}

      <div className="hud-right">
        {(s.others.length > 0 || session.net) && <NearbyRiders session={session} snapshot={s} country={settings.country} name={settings.riderName} weightKg={settings.weightKg} />}
        <Minimap track={track} map={map} positionM={s.lapDistanceM} others={markers} />
      </div>

      {admin && teleportOpen && <TeleportPanel session={session} map={map} positionM={s.lapDistanceM} onClose={() => setTeleportOpen(false)} />}

      {session.net && <ChatBox session={session} />}
      {session.net && <RideOnToast session={session} />}

      {s.noTrainerData && !paused && <div className="hud-warning">Keine Leistungsdaten – ist der Trainer verbunden? (Geräte-Seite)</div>}
      {paused && (
        <div className="hud-warning paused">{s.autoPaused ? 'Pausiert – einfach weitertreten' : 'Pausiert – „Weiter“ oder Taste P'}</div>
      )}

      <HudFieldBar
        snapshot={s}
        settings={settings}
        profile={
          <div className="hud-panel hud-profile">
            <ElevationProfile track={track} positionM={s.lapDistanceM} height={70} markers={markers} />
          </div>
        }
      />
    </div>
  );
}

/** "+0:12" — the time gap, from the distance and the riders' speeds (distance when standing). */
function formatGap(gapM: number, speedMps: number): string {
  const sign = gapM >= 0 ? '+' : '−';
  const abs = Math.abs(gapM);
  if (speedMps < 1 || abs / speedMps >= 3600) return `${sign}${abs >= 1000 ? `${(abs / 1000).toFixed(1)} km` : `${Math.round(abs)} m`}`;
  return `${sign}${formatDuration(abs / speedMps)}`;
}

/** Riders around me, ahead at the top, with flag, W/kg and time gap; I am in the list too. */
function NearbyRiders({
  session,
  snapshot: s,
  country,
  name,
  weightKg,
}: {
  session: RideSession;
  snapshot: RideSnapshot;
  country: string;
  name: string;
  weightKg: number;
}) {
  const account = useStore(accountStore);
  const near = [...s.others].sort((a, b) => Math.abs(a.gapM) - Math.abs(b.gapM)).slice(0, 7);
  const rows = [
    ...near.map((o) => ({ ...o, me: false })),
    { id: 'me', name: account.user?.name ?? name, country, gapM: 0, speedMps: s.speedMps, wkg: s.power3s / weightKg, remote: false, power: undefined, me: true },
  ].sort((a, b) => b.gapM - a.gapM);
  return (
    <div className={`hud-panel hud-riders ${session.net ? 'online' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <span className="hud-label">In der Nähe</span>
        {session.net && <NetBadge session={session} />}
      </div>
      {rows.map((r) => (
        <div key={r.id} className={`hud-bot ${r.me ? 'me' : ''}`}>
          <Flag code={r.country} size={18} />
          <span className="hud-bot-name" title={r.remote ? 'online' : r.me ? 'du' : 'Pacer-Bot'}>
            {r.name}
          </span>
          <span className="hud-bot-wkg">
            {r.wkg !== undefined ? r.wkg.toFixed(1) : r.power !== undefined ? Math.round(r.power) : ''}
            <small>{r.wkg !== undefined ? 'W/kg' : r.power !== undefined ? 'W' : ''}</small>
          </span>
          <span className={r.me ? 'gap' : r.gapM >= 0 ? 'gap ahead' : 'gap behind'} title={`${Math.round(Math.abs(r.gapM))} m`}>
            {r.me ? '' : formatGap(r.gapM, Math.max(0, (s.speedMps + r.speedMps) / 2))}
          </span>
          {session.net &&
            (r.remote ? (
              <button className="rideon" title="Kudos geben" onClick={() => session.net?.sendRideOn(r.id)}>
                👋
              </button>
            ) : (
              <span />
            ))}
        </div>
      ))}
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
