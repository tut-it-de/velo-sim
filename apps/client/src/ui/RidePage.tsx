import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { accountStore, fetchOnline, isLoggedIn, refreshAccount, serverBase } from '../net/api';
import { MultiplayerClient } from '../net/multiplayer';
import { maybeAutoUpload } from '../net/strava';
import { ROUTES, getTrack, type RouteStyle, type Track } from '@velo/routes';
import { estimateTime, setupFor } from '@velo/equipment';
import type { Workout } from '@velo/workouts';
import { deviceManager } from '../devices/deviceManager';
import { keepAwake } from '../devices/files';
import { CAMERA_MODES, GameWorld, type CameraMode } from '../game/world';
import { RideSession, type RideResult } from '../ride/rideSession';
import { saveActivity, type StoredActivity } from '../state/activities';
import { creditRide, garageStore } from '../state/garage';
import { lookFromLoadout } from '../game/look';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { pageStore, searchStore, uiStore } from '../state/ui';
import { ElevationProfile } from './ElevationProfile';
import { Hud } from './Hud';
import { RideSummary } from './RideSummary';
import { WorkoutSelect } from './WorkoutSelect';
import { formatDuration } from './components';
import { Icon } from './icons';

type Phase =
  | { kind: 'select' }
  | { kind: 'ride'; routeId: string; bots: boolean; workout?: Workout }
  | { kind: 'summary'; result: RideResult; activity: StoredActivity };

/** Dev shortcut: `?ride=<route id>&km=<distance>` starts an offline ride at once (screenshots, tests). */
const DEV = new URLSearchParams(location.search);
const DEV_RIDE = ROUTES.some((r) => r.id === DEV.get('ride')) ? DEV.get('ride')! : null;

export function RidePage({ view }: { view: 'ride' | 'routes' | 'workouts' }) {
  const [phase, setPhase] = useState<Phase>(DEV_RIDE ? { kind: 'ride', routeId: DEV_RIDE, bots: false } : { kind: 'select' });

  useEffect(() => {
    uiStore.set({ immersive: phase.kind === 'ride' });
    return () => uiStore.set({ immersive: false });
  }, [phase.kind]);

  if (phase.kind === 'ride') {
    return (
      <RideView
        routeId={phase.routeId}
        bots={phase.bots}
        workout={phase.workout}
        onFinish={async (result) => {
          const activity = await saveActivity(result, result.simulated, result.workout ? `Workout „${result.workout.name}“` : undefined);
          if (isLoggedIn()) {
            // Online + logged in: the server books from its own telemetry.
            await refreshAccount().catch(() => undefined);
          } else if (!result.simulated) {
            creditRide(result.earnings, result.routeId, result.lapsCompleted, activity.title);
          }
          void maybeAutoUpload(activity.id);
          setPhase({ kind: 'summary', result, activity });
        }}
        onCancel={() => setPhase({ kind: 'select' })}
      />
    );
  }
  return (
    <>
      <RouteSelect view={view} onStart={(routeId, bots, workout) => setPhase({ kind: 'ride', routeId, bots, workout })} />
      {phase.kind === 'summary' && <RideSummary result={phase.result} activity={phase.activity} onClose={() => setPhase({ kind: 'select' })} />}
    </>
  );
}

const STYLE_LABEL: Record<RouteStyle, string> = { coast: 'Küste', hills: 'Hügel', alpine: 'Alpin', lake: 'See' };
const STYLE_HUE: Record<RouteStyle, string> = { coast: '#22b8cf', hills: '#51cf66', alpine: '#b197fc', lake: '#4dabf7' };
const DIFFICULTY_LABEL = ['Leicht', 'Moderat', 'Mittel', 'Schwer', 'Sehr schwer'];
type RouteFilter = 'all' | 'real' | 'fantasy' | 'flat' | 'climb';
const FILTERS: Array<{ id: RouteFilter; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'real', label: 'Echte Straßen' },
  { id: 'fantasy', label: 'Fantasy' },
  { id: 'flat', label: 'Flach & wellig' },
  { id: 'climb', label: 'Berge' },
];

/** Real in-game screenshot of a route (public/route-shots, made with scripts/route-shots.mjs). */
const routeShot = (id: string) => `${import.meta.env.BASE_URL}route-shots/${id}.jpg`;

/** 1–5 from climbing per kilometre and the steepest ramp. */
function difficulty(t: Track): number {
  const perKm = t.elevationGain / (t.length / 1000);
  const score = perKm / 10 + Math.max(0, t.maxGrade - 6) / 4;
  return Math.min(5, Math.max(1, Math.round(score)));
}

function DifficultyPips({ value }: { value: number }) {
  return (
    <span className="pips" title={`Schwierigkeit ${value} von 5`} aria-label={`Schwierigkeit ${value} von 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= value ? 'on' : ''} />
      ))}
    </span>
  );
}

/** The lap seen from above, as a line drawing with the start/finish marked. */
function RouteShape({ track, size = 120, stroke = 3, label }: { track: Track; size?: number; stroke?: number; label?: string }) {
  const { d, start } = useMemo(() => {
    const { minX, maxX, minZ, maxZ } = track.bounds;
    const pad = stroke * 2;
    const k = (size - 2 * pad) / Math.max(1, maxX - minX, maxZ - minZ);
    const ox = (size - (maxX - minX) * k) / 2;
    const oy = (size - (maxZ - minZ) * k) / 2;
    const at = (j: number) => [ox + (track.xs[j]! - minX) * k, size - oy - (track.zs[j]! - minZ) * k] as const;
    const every = Math.max(1, Math.floor(track.count / 300));
    let p = '';
    for (let i = 0; i <= track.count; i += every) {
      const [x, y] = at(i % track.count);
      p += `${p ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return { d: `${p}Z`, start: at(0) };
  }, [track, size, stroke]);
  return (
    <svg className="route-shape" viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <path d={d} className="route-shape-glow" strokeWidth={stroke * 3} />
      <path d={d} className="route-shape-line" strokeWidth={stroke} />
      <circle cx={start[0]} cy={start[1]} r={stroke * 1.6} className="route-shape-start" />
      {label && (
        <text x={start[0]} y={start[1] - stroke * 4} className="route-shape-label" textAnchor={start[0] > size * 0.7 ? 'end' : start[0] < size * 0.3 ? 'start' : 'middle'}>
          {label}
        </text>
      )}
    </svg>
  );
}

function StatTile({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
    </div>
  );
}

/** Elevation profile with a kilometre axis below it. */
function ProfileWithAxis({ track, height }: { track: Track; height: number }) {
  const km = track.length / 1000;
  const step = km > 40 ? 10 : km > 16 ? 5 : km > 6 ? 2 : 1;
  const ticks: number[] = [];
  // Leave room for the total at the right end.
  for (let k = 0; k <= km - Math.max(step * 0.5, km * 0.15); k += step) ticks.push(k);
  return (
    <div className="profile-axis">
      <ElevationProfile track={track} height={height} showSegments={false} />
      <div className="axis">
        {ticks.map((k) => (
          <span key={k} style={{ left: `${(k / km) * 100}%` }}>
            {k}
          </span>
        ))}
        <span className="end" style={{ left: '100%' }}>
          {km.toFixed(1)} km
        </span>
      </div>
    </div>
  );
}

interface RouteRow {
  r: (typeof ROUTES)[number];
  t: Track;
  diff: number;
  timeS: number;
}

function RouteImageCard({ row, selected, online, onClick }: { row: RouteRow; selected: boolean; online: number | null; onClick: () => void }) {
  const { r, t, diff, timeS } = row;
  return (
    <button className={`route-card${selected ? ' selected' : ''}`} style={{ ['--hue' as string]: STYLE_HUE[r.style] }} onClick={onClick} aria-pressed={selected}>
      <div className="route-card-img" style={{ backgroundImage: `url(${routeShot(r.id)})` }}>
        <span className="tag">{r.fantasy ? 'Fantasy' : r.world ? 'Echte Straßen' : STYLE_LABEL[r.style]}</span>
        {online !== null && <span className="tag live">● {online}</span>}
      </div>
      <div className="route-card-body">
        <span className="route-title">{r.name}</span>
        <span className="route-card-region">
          <Icon name="pin" size={13} /> {r.region ?? STYLE_LABEL[r.style]}
        </span>
        <div className="route-card-stats">
          <span>{(t.length / 1000).toFixed(1)} km</span>
          <span>{Math.round(t.elevationGain)} hm</span>
          <span>≈ {formatDuration(timeS)}</span>
        </div>
        <div className="route-card-foot">
          <DifficultyPips value={diff} />
          <span className="muted small">{DIFFICULTY_LABEL[diff - 1]}</span>
        </div>
      </div>
    </button>
  );
}

/** Trainer status, live power/cadence/heart rate and the start button – fixed at the bottom. */
function DeviceBar({
  startLabel,
  startDisabled,
  onStart,
  bots,
  setBots,
  hasServer,
  online,
}: {
  startLabel: string;
  startDisabled: boolean;
  onStart: () => void;
  bots: boolean;
  setBots: (v: boolean) => void;
  hasServer: boolean;
  online: Record<string, number> | null;
}) {
  const slots = useStore(deviceManager.slots);
  const m = useStore(deviceManager.metrics);
  const settings = useStore(settingsStore);
  const trainer = slots.trainer;
  const connected = trainer.state === 'connected';
  return (
    <div className="device-bar">
      <div className={`device-trainer${connected ? ' ok' : ''}`}>
        <span className="device-icon">
          <Icon name="ride" size={22} />
        </span>
        <span className="device-text">
          <strong>{connected ? (trainer.name ?? 'Trainer') : trainer.state === 'connecting' ? 'Verbinde …' : 'Kein Trainer'}</strong>
          {connected ? (
            <span className="ok-text">● Verbunden</span>
          ) : (
            <span className="device-actions">
              <button className="link" onClick={() => pageStore.set('devices')}>
                Verbinden
              </button>
            </span>
          )}
        </span>
      </div>
      <div className="device-metric">
        <Icon name="power" size={18} />
        <span>
          <span className="muted small">Leistung</span>
          <strong>
            {connected ? Math.round(m.power3s) : '–'} <small>W</small>
          </strong>
        </span>
      </div>
      <div className="device-metric">
        <Icon name="cadence" size={18} />
        <span>
          <span className="muted small">Trittfrequenz</span>
          <strong>
            {m.cadenceSource ? Math.round(m.cadence) : '–'} <small>rpm</small>
          </strong>
        </span>
      </div>
      <div className="device-metric heart">
        <Icon name="heart" size={18} />
        <span>
          <span className="muted small">Herzfrequenz</span>
          <strong>
            {m.heartRate ? Math.round(m.heartRate) : '–'} <small>bpm</small>
          </strong>
        </span>
      </div>
      <div className="device-options">
        <button className={`chip${bots ? ' active' : ''}`} onClick={() => setBots(!bots)} aria-pressed={bots} title="Pacer-Bots mit 2,0 · 2,8 · 3,5 W/kg">
          Pacer-Bots
        </button>
        {hasServer && (
          <button
            className={`chip${settings.rideOnline ? ' active' : ''}`}
            onClick={() => updateSettings({ rideOnline: !settings.rideOnline })}
            aria-pressed={settings.rideOnline}
            title={online ? 'Mit anderen auf der Strecke' : 'Server nicht erreichbar'}
          >
            Online
          </button>
        )}
      </div>
      <button className="primary cta start-training" disabled={startDisabled} onClick={onStart}>
        <Icon name="play" size={16} />
        {startLabel}
      </button>
    </div>
  );
}

type View = 'ride' | 'routes' | 'workouts';

function RouteSelect({ view, onStart }: { view: View; onStart: (routeId: string, bots: boolean, workout?: Workout) => void }) {
  const settings = useStore(settingsStore);
  const garage = useStore(garageStore);
  const search = useStore(searchStore);
  const [routeId, setRouteId] = useState(ROUTES[0]!.id);
  const [bots, setBots] = useState(true);
  const [details, setDetails] = useState(false);
  const [filter, setFilter] = useState<RouteFilter>('all');
  const [workout, setWorkout] = useState<Workout | undefined>();
  const [online, setOnline] = useState<Record<string, number> | null>(null);
  const hasServer = !!settings.serverUrl.trim();
  const account = useStore(accountStore);
  // Where a pick on the route list goes back to: the start page or the workout list.
  const pickReturn = useRef<'ride' | 'workouts'>('ride');
  if (view !== 'routes') pickReturn.current = view;

  useEffect(() => {
    if (!hasServer) return;
    let alive = true;
    const load = () => fetchOnline().then((o) => alive && setOnline(o));
    void load();
    const id = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [hasServer, settings.serverUrl]);

  const power = Math.round(settings.ftp * 0.75);
  const routes = useMemo<RouteRow[]>(() => {
    const setup = setupFor(settings, garage.loadout);
    return ROUTES.map((r) => {
      const t = getTrack(r.id);
      return { r, t, diff: difficulty(t), timeS: estimateTime(t, setup, power) };
    });
  }, [settings, garage.loadout, power]);
  const sel = routes.find((x) => x.r.id === routeId) ?? routes[0]!;
  const onlineOf = (id: string) => (online ? (online[id] ?? 0) : null);
  const mostRidden = online ? routes.reduce((a, b) => ((online[b.r.id] ?? 0) > (online[a.r.id] ?? 0) ? b : a)) : null;
  const popular = !!mostRidden && mostRidden.r.id === sel.r.id && (online?.[sel.r.id] ?? 0) > 0;

  const q = search.trim().toLowerCase();
  const shown = routes.filter(
    ({ r, diff }) =>
      (filter === 'all' ? true : filter === 'real' ? !!r.world : filter === 'fantasy' ? !!r.fantasy : filter === 'flat' ? diff <= 2 : diff >= 3) &&
      (!q || [r.name, r.region ?? '', r.description, STYLE_LABEL[r.style]].some((s) => s.toLowerCase().includes(q))),
  );

  const isWorkout = view === 'workouts';
  const start = () => onStart(routeId, bots, isWorkout ? workout : undefined);
  const pick = (id: string) => {
    setRouteId(id);
    setDetails(false);
    if (view === 'routes') pageStore.set(pickReturn.current);
  };

  return (
    <div className="page ride-home">
      <div className="page-inner">
        {!account.user && (
          <div className="callout neutral">
            <span className="callout-text">
              <strong>Du fährst allein.</strong> Mit einem Konto siehst du andere Fahrer auf der Strecke, und deine Taler liegen sicher auf dem Server.
            </span>
            <button onClick={() => pageStore.set('login')}>Anmelden</button>
          </div>
        )}

        {view === 'ride' && (
          <>
            <div className="home-top">
              <section className="hero" style={{ ['--hue' as string]: STYLE_HUE[sel.r.style], backgroundImage: `url(${routeShot(sel.r.id)})` }}>
                <div className="hero-content">
                  <span className="hero-badge">{popular ? 'Beliebte Strecke' : sel.r.fantasy ? 'Fantasy-Welt' : sel.r.world ? 'Echte Straßen' : STYLE_LABEL[sel.r.style]}</span>
                  <h1 className="hero-title">{sel.r.name}</h1>
                  <span className="hero-place">
                    <Icon name="pin" size={15} /> {sel.r.region ?? STYLE_LABEL[sel.r.style]}
                  </span>
                  <p className="hero-desc">{sel.r.description}</p>
                  <div className="stat-row">
                    <StatTile label="Distanz" value={(sel.t.length / 1000).toFixed(1)} unit="km" />
                    <StatTile label="Höhenmeter" value={String(Math.round(sel.t.elevationGain))} unit="hm" />
                    <StatTile label="Dauer" value={formatDuration(sel.timeS)} />
                    <StatTile label="Schwierigkeit" value={DIFFICULTY_LABEL[sel.diff - 1]} />
                    <StatTile label="Online" value={online ? String(online[sel.r.id] ?? 0) : '–'} />
                  </div>
                  <div className="hero-actions">
                    <button className="primary cta" onClick={() => onStart(routeId, bots)}>
                      Jetzt fahren <Icon name="arrow" size={18} />
                    </button>
                    <button className="ghost cta" onClick={() => setDetails(!details)} aria-expanded={details}>
                      Strecken-Details
                    </button>
                  </div>
                </div>
              </section>

              <aside className="map-panel" style={{ ['--hue' as string]: STYLE_HUE[sel.r.style] }}>
                <div className="map-head">
                  <span className="eyebrow">Streckenverlauf</span>
                  <DifficultyPips value={sel.diff} />
                </div>
                <div className="map-shape">
                  <RouteShape track={sel.t} size={260} stroke={3} label="Start · Ziel" />
                </div>
                <div className="map-profile">
                  <span className="eyebrow">Höhenprofil</span>
                  <ProfileWithAxis track={sel.t} height={70} />
                </div>
              </aside>
            </div>

            {details && (
              <section className="route-details">
                <div className="route-details-stats">
                  <StatTile label="Max. Steigung" value={sel.t.maxGrade.toFixed(0)} unit="%" />
                  <StatTile label="Segmente" value={String(sel.t.segments.length)} />
                  <StatTile label={`Zeit bei ${power} W`} value={formatDuration(sel.timeS)} />
                  <StatTile label="Welt" value={sel.r.fantasy ? 'Fantasy' : sel.r.world ? 'Echt' : STYLE_LABEL[sel.r.style]} />
                </div>
                <ElevationProfile track={sel.t} height={96} />
                <div className="legend">
                  <span className="lg climb">Anstieg</span>
                  <span className="lg sprint">Sprint</span>
                  <span className="lg descent">Abfahrt</span>
                </div>
                {sel.t.segments.length > 0 && (
                  <ul className="segment-list">
                    {sel.t.segments.map((s) => (
                      <li key={s.id}>
                        <span className={`lg ${s.type}`}>{s.name}</span>
                        <span className="muted small">
                          km {(s.startM / 1000).toFixed(1)}–{(s.endM / 1000).toFixed(1)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <div className="section-head">
              <h2>Weitere Strecken entdecken</h2>
              <button className="link" onClick={() => pageStore.set('routes')}>
                Alle Strecken anzeigen <Icon name="arrow" size={15} />
              </button>
            </div>
            <div className="route-row">
              {routes
                .filter((x) => x.r.id !== sel.r.id)
                .slice(0, 4)
                .map((row) => (
                  <RouteImageCard key={row.r.id} row={row} selected={false} online={onlineOf(row.r.id)} onClick={() => pick(row.r.id)} />
                ))}
            </div>
          </>
        )}

        {view === 'routes' && (
          <>
            <header className="page-head">
              <h1>Strecken</h1>
              <div className="chips">
                {FILTERS.map((f) => (
                  <button key={f.id} className={filter === f.id ? 'chip active' : 'chip'} onClick={() => setFilter(f.id)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </header>
            {q && (
              <div className="muted">
                {shown.length} Treffer für „{search.trim()}“{' '}
                <button className="link" onClick={() => searchStore.set('')}>
                  Suche löschen
                </button>
              </div>
            )}
            <div className="route-grid">
              {shown.map((row) => (
                <RouteImageCard key={row.r.id} row={row} selected={row.r.id === routeId} online={onlineOf(row.r.id)} onClick={() => pick(row.r.id)} />
              ))}
            </div>
          </>
        )}

        {view === 'workouts' && (
          <>
            <header className="page-head">
              <h1>Workouts</h1>
              <button className="route-pick" onClick={() => pageStore.set('routes')}>
                <span className="route-pick-img" style={{ backgroundImage: `url(${routeShot(sel.r.id)})` }} />
                <span>
                  <span className="muted small">Strecke</span>
                  <strong>{sel.r.name}</strong>
                </span>
                <span className="link">ändern</span>
              </button>
            </header>
            <WorkoutSelect selectedId={workout?.id} onSelect={setWorkout} />
          </>
        )}
      </div>

      <DeviceBar
        startLabel={isWorkout ? (workout ? 'Workout starten' : 'Workout wählen') : 'Training starten'}
        startDisabled={isWorkout && !workout}
        onStart={start}
        bots={bots}
        setBots={setBots}
        hasServer={hasServer}
        online={online}
      />
    </div>
  );
}

function RideView({
  routeId,
  bots,
  workout,
  onFinish,
  onCancel,
}: {
  routeId: string;
  bots: boolean;
  workout?: Workout;
  onFinish: (r: RideResult) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [session, setSession] = useState<RideSession | null>(null);
  const [world, setWorld] = useState<GameWorld | null>(null);
  const [progress, setProgress] = useState('Strecke wird geladen …');
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraMode>('chase');

  useEffect(() => {
    let cancelled = false;
    let w: GameWorld | null = null;
    const garage = garageStore.get();
    const st = settingsStore.get();
    const net =
      st.rideOnline && serverBase() && !DEV_RIDE
        ? new MultiplayerClient(serverBase(), {
            name: accountStore.get().user?.name ?? st.riderName,
            country: st.country,
            routeId,
            loadout: garage.loadout,
            weightKg: st.weightKg,
            token: accountStore.get().token,
            simulated: st.useSimulator,
          })
        : undefined;
    const s = new RideSession(routeId, st, { bots, workout, loadout: garage.loadout, routesWithLap: garage.routesWithLap, net });
    GameWorld.create(canvasRef.current!, routeId, lookFromLoadout(garage.loadout), setProgress, st.graphicsQuality)
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        w = created;
        for (const b of s.bots) created.ensureRider(b.id, b.look);
        if (net) {
          net.on('joined', (info) => created.ensureRider(info.id, lookFromLoadout(info.loadout)));
          net.on('left', (id) => created.removeRider(id));
          net.on('emote', ({ from, e }) => {
            if (e === 'vape') created.vapeOther(from);
          });
          net.connect();
        }
        created.setFrameProvider((dt) => s.frame(dt));
        s.start();
        if (DEV_RIDE && DEV.get('km')) s.teleport(Number(DEV.get('km')) * 1000);
        setWorld(created);
        setSession(s);
        (window as unknown as { __velo?: unknown }).__velo = { world: created, session: s };
        void keepAwake(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
      net?.close();
      s.dispose();
      w?.dispose();
      void keepAwake(false);
    };
  }, [routeId, bots, workout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!world || !session) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'c' || e.key === 'C') {
        const idx = CAMERA_MODES.findIndex((m) => m.id === world.cameraMode);
        const next = CAMERA_MODES[(idx + 1) % CAMERA_MODES.length]!.id;
        world.setCameraMode(next);
        setCamera(next);
      } else if (e.key === 'v' || e.key === 'V') {
        world.vape();
        session.net?.sendEmote('vape');
      } else if (e.key === 'p' || e.key === 'P') {
        const st = session.snapshot.get().state;
        if (st === 'riding') session.pause();
        else if (st === 'paused') session.resume();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [world, session]);

  return (
    <div className="ride-view">
      <canvas ref={canvasRef} className="ride-canvas" />
      {!session && (
        <div className="ride-loading">
          {error ? (
            <>
              <div className="error-text">3D-Ansicht konnte nicht gestartet werden: {error}</div>
              <button onClick={onCancel}>Zurück</button>
            </>
          ) : (
            <>
              <div className="spinner" />
              <div>{progress}</div>
            </>
          )}
        </div>
      )}
      {session && world && (
        <Hud
          session={session}
          map={world.minimap}
          camera={camera}
          onCamera={(mode) => {
            world.setCameraMode(mode);
            setCamera(mode);
          }}
          onFinish={async () => {
            const result = session.finish();
            if (session.net) result.server = await session.net.finish();
            onFinish(result);
          }}
        />
      )}
    </div>
  );
}
