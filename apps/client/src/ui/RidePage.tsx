import { useEffect, useMemo, useRef, useState } from 'react';
import { accountStore, fetchOnline, isLoggedIn, refreshAccount, serverBase } from '../net/api';
import { MultiplayerClient } from '../net/multiplayer';
import { maybeAutoUpload } from '../net/strava';
import { ROUTES, getTrack, type RouteStyle, type Track } from '@velo/routes';
import { estimateTime, setupFor } from '@velo/equipment';
import { workoutStats, type Workout } from '@velo/workouts';
import { deviceManager } from '../devices/deviceManager';
import { keepAwake } from '../devices/files';
import { CAMERA_MODES, GameWorld, type CameraMode } from '../game/world';
import { RideSession, type RideResult } from '../ride/rideSession';
import { saveActivity, type StoredActivity } from '../state/activities';
import { creditRide, garageStore } from '../state/garage';
import { lookFromLoadout } from '../game/look';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { pageStore, uiStore } from '../state/ui';
import { ElevationProfile } from './ElevationProfile';
import { Hud } from './Hud';
import { RideSummary } from './RideSummary';
import { WorkoutSelect } from './WorkoutSelect';
import { Toggle, formatDuration } from './components';

type Phase =
  | { kind: 'select' }
  | { kind: 'ride'; routeId: string; bots: boolean; workout?: Workout }
  | { kind: 'summary'; result: RideResult; activity: StoredActivity };

/** Dev shortcut: `?ride=<route id>&km=<distance>` starts an offline ride at once (screenshots, tests). */
const DEV = new URLSearchParams(location.search);
const DEV_RIDE = ROUTES.some((r) => r.id === DEV.get('ride')) ? DEV.get('ride')! : null;

export function RidePage() {
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
      <RouteSelect onStart={(routeId, bots, workout) => setPhase({ kind: 'ride', routeId, bots, workout })} />
      {phase.kind === 'summary' && <RideSummary result={phase.result} activity={phase.activity} onClose={() => setPhase({ kind: 'select' })} />}
    </>
  );
}

const STYLE_LABEL: Record<RouteStyle, string> = { coast: 'Küste', hills: 'Hügel', alpine: 'Alpin', lake: 'See' };
const STYLE_HUE: Record<RouteStyle, string> = { coast: '#22b8cf', hills: '#51cf66', alpine: '#b197fc', lake: '#4dabf7' };
type RouteFilter = 'all' | 'real' | 'fantasy' | 'flat' | 'climb';
const FILTERS: Array<{ id: RouteFilter; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'real', label: 'Echte Straßen' },
  { id: 'fantasy', label: 'Fantasy' },
  { id: 'flat', label: 'Flach & wellig' },
  { id: 'climb', label: 'Berge' },
];

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

/** The lap seen from above, as a line drawing (route cards and hero). */
function RouteShape({ track, size = 120, stroke = 3 }: { track: Track; size?: number; stroke?: number }) {
  const d = useMemo(() => {
    const { minX, maxX, minZ, maxZ } = track.bounds;
    const pad = stroke * 2;
    const k = (size - 2 * pad) / Math.max(1, maxX - minX, maxZ - minZ);
    const ox = (size - (maxX - minX) * k) / 2;
    const oy = (size - (maxZ - minZ) * k) / 2;
    const every = Math.max(1, Math.floor(track.count / 300));
    let p = '';
    for (let i = 0; i <= track.count; i += every) {
      const j = i % track.count;
      p += `${p ? 'L' : 'M'}${(ox + (track.xs[j]! - minX) * k).toFixed(1)},${(size - oy - (track.zs[j]! - minZ) * k).toFixed(1)}`;
    }
    return `${p}Z`;
  }, [track, size, stroke]);
  const start = useMemo(() => {
    const { minX, maxX, minZ, maxZ } = track.bounds;
    const pad = stroke * 2;
    const k = (size - 2 * pad) / Math.max(1, maxX - minX, maxZ - minZ);
    const ox = (size - (maxX - minX) * k) / 2;
    const oy = (size - (maxZ - minZ) * k) / 2;
    return [ox + (track.xs[0]! - minX) * k, size - oy - (track.zs[0]! - minZ) * k] as const;
  }, [track, size, stroke]);
  return (
    <svg className="route-shape" viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <path d={d} className="route-shape-glow" strokeWidth={stroke * 3} />
      <path d={d} className="route-shape-line" strokeWidth={stroke} />
      <circle cx={start[0]} cy={start[1]} r={stroke * 1.6} className="route-shape-start" />
    </svg>
  );
}

function StatTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
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

function RouteSelect({ onStart }: { onStart: (routeId: string, bots: boolean, workout?: Workout) => void }) {
  const slots = useStore(deviceManager.slots);
  const settings = useStore(settingsStore);
  const garage = useStore(garageStore);
  const [routeId, setRouteId] = useState(ROUTES[0]!.id);
  const [bots, setBots] = useState(true);
  const [mode, setMode] = useState<'free' | 'workout'>('free');
  const [filter, setFilter] = useState<RouteFilter>('all');
  const [workout, setWorkout] = useState<Workout | undefined>();
  const [online, setOnline] = useState<Record<string, number> | null>(null);
  const hasServer = !!settings.serverUrl.trim();
  const account = useStore(accountStore);

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
  const trainerReady = slots.trainer.state === 'connected';

  const power = Math.round(settings.ftp * 0.75);
  const routes = useMemo(() => {
    const setup = setupFor(settings, garage.loadout);
    return ROUTES.map((r) => {
      const t = getTrack(r.id);
      return { r, t, diff: difficulty(t), timeS: estimateTime(t, setup, power) };
    });
  }, [settings, garage.loadout, power]);
  const shown = routes.filter(({ r, diff }) =>
    filter === 'all' ? true : filter === 'real' ? !!r.world : filter === 'fantasy' ? !!r.fantasy : filter === 'flat' ? diff <= 2 : diff >= 3,
  );
  const sel = routes.find((x) => x.r.id === routeId) ?? routes[0]!;

  const useSimulator = async () => {
    await deviceManager.setSimulator(true);
    await deviceManager.connect('trainer');
    await deviceManager.connect('hrm');
  };

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <div>
            <h1>Wähle deine Strecke</h1>
          </div>
          <div className="segmented">
            <button className={mode === 'free' ? 'active' : ''} onClick={() => setMode('free')}>
              Freie Fahrt
            </button>
            <button className={mode === 'workout' ? 'active' : ''} onClick={() => setMode('workout')}>
              Workout
            </button>
          </div>
        </header>

        {!trainerReady && (
          <div className="callout">
            <span className="callout-text">
              <strong>Kein Trainer verbunden.</strong> Verbinde deinen KICKR unter „Geräte“ – oder teste mit dem Simulator.
            </span>
            {!settings.useSimulator || slots.trainer.state === 'disconnected' ? <button onClick={useSimulator}>Simulator starten</button> : null}
          </div>
        )}

        {!account.user && (
          <div className="callout neutral">
            <span className="callout-text">
              <strong>Du fährst allein.</strong> Mit einem Konto siehst du andere Fahrer auf der Strecke, und deine Taler liegen sicher auf dem Server.
            </span>
            <button onClick={() => pageStore.set('login')}>Anmelden</button>
          </div>
        )}

        {mode === 'workout' && <WorkoutSelect selectedId={workout?.id} onSelect={setWorkout} />}

        <section className="route-hero" style={{ ['--hue' as string]: STYLE_HUE[sel.r.style] }}>
          <div className="route-hero-main">
            <div className="badges">
              {sel.r.region && <span className="badge-pill">{sel.r.region}</span>}
              <span className="badge-pill hue">{STYLE_LABEL[sel.r.style]}</span>
              {sel.r.world && <span className="badge-pill real">Echte Straßen</span>}
              {sel.r.fantasy && <span className="badge-pill real">Fantasy</span>}
              {online && <span className="badge-pill live">● {online[sel.r.id] ?? 0} online</span>}
            </div>
            <h2 className="route-hero-title">{sel.r.name}</h2>
            <p className="route-hero-desc">{sel.r.description}</p>
            <div className="stat-row">
              <StatTile label="Distanz" value={(sel.t.length / 1000).toFixed(1)} unit="km" />
              <StatTile label="Höhenmeter" value={String(Math.round(sel.t.elevationGain))} unit="hm" />
              <StatTile label="Max. Steigung" value={sel.t.maxGrade.toFixed(0)} unit="%" />
              <StatTile label="Segmente" value={String(sel.t.segments.length)} />
              <StatTile label={`Zeit bei ${power} W`} value={formatDuration(sel.timeS)} />
            </div>
          </div>
          <div className="route-hero-shape">
            <RouteShape track={sel.t} size={220} stroke={3} />
            <div className="route-hero-diff">
              <span className="eyebrow">Schwierigkeit</span>
              <DifficultyPips value={sel.diff} />
            </div>
          </div>
          <div className="route-hero-profile">
            <ElevationProfile track={sel.t} height={88} />
            <div className="legend">
              <span className="lg climb">Anstieg</span>
              <span className="lg sprint">Sprint</span>
              <span className="lg descent">Abfahrt</span>
            </div>
          </div>
        </section>

        <div className="section-head">
          <h2>{mode === 'workout' ? 'Strecke für das Workout' : 'Alle Strecken'}</h2>
          <div className="chips">
            {FILTERS.map((f) => (
              <button key={f.id} className={filter === f.id ? 'chip active' : 'chip'} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="route-grid">
          {shown.map(({ r, t, diff, timeS }) => {
            const selected = r.id === routeId;
            return (
              <button
                key={r.id}
                className={`route-card ${selected ? 'selected' : ''}`}
                style={{ ['--hue' as string]: STYLE_HUE[r.style] }}
                onClick={() => setRouteId(r.id)}
                aria-pressed={selected}
              >
                <div className="route-card-top">
                  <div className="route-card-titles">
                    <span className="route-card-region">{r.region ?? STYLE_LABEL[r.style]}</span>
                    <span className="route-title">{r.name}</span>
                  </div>
                  <RouteShape track={t} size={64} stroke={2} />
                </div>
                <div className="route-card-stats">
                  <span>
                    <strong>{(t.length / 1000).toFixed(1)}</strong> km
                  </span>
                  <span>
                    <strong>{Math.round(t.elevationGain)}</strong> hm
                  </span>
                  <span>
                    <strong>{t.maxGrade.toFixed(0)}</strong> %
                  </span>
                </div>
                <ElevationProfile track={t} height={46} showSegments={false} />
                <div className="route-card-foot">
                  <DifficultyPips value={diff} />
                  <span className="route-card-time">≈ {formatDuration(timeS)}</span>
                  {r.world && <span className="badge-pill real small">Echt</span>}
                  {r.fantasy && <span className="badge-pill real small">Fantasy</span>}
                  {online && <span className="online-count">● {online[r.id] ?? 0}</span>}
                </div>
              </button>
            );
          })}
        </div>

        <div className="start-bar">
          <div className="start-bar-route">
            <span className="eyebrow">{mode === 'workout' ? 'Workout' : 'Freie Fahrt'}</span>
            <strong>{sel.r.name}</strong>
            <span className="muted small">
              {mode === 'workout' && workout
                ? `${workout.name} · ${formatDuration(workoutStats(workout).durationS)} · FTP ${settings.ftp} W`
                : `Trainer-Schwierigkeit ${Math.round(settings.trainerDifficulty * 100)} %`}
            </span>
          </div>
          <div className="start-bar-options">
            <Toggle checked={bots} onChange={setBots} label="Pacer-Bots" hint="2,0 · 2,8 · 3,5 W/kg" />
            {hasServer && (
              <Toggle
                checked={settings.rideOnline}
                onChange={(v) => updateSettings({ rideOnline: v })}
                label="Online fahren"
                hint={online ? 'mit anderen auf der Strecke' : 'Server nicht erreichbar'}
              />
            )}
          </div>
          <button
            className="primary cta"
            disabled={mode === 'workout' && !workout}
            onClick={() => onStart(routeId, bots, mode === 'workout' ? workout : undefined)}
          >
            {mode === 'workout' ? (workout ? 'Workout starten' : 'Workout wählen') : 'Los geht’s'}
            <span aria-hidden>→</span>
          </button>
        </div>
      </div>
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
