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
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { pageStore, uiStore } from '../state/ui';
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

export function RidePage({ view }: { view: 'ride' | 'workouts' }) {
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
      <RouteSelect view={view} onStart={(routeId, workout) => setPhase({ kind: 'ride', routeId, bots: true, workout })} />
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
        {selected && <span className="route-card-check">✓ Ausgewählt</span>}
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

/** Trainer status, live power/cadence/heart rate and the start buttons – fixed at the bottom. */
function DeviceBar({ children }: { children: ReactNode }) {
  const slots = useStore(deviceManager.slots);
  const m = useStore(deviceManager.metrics);
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
      <div className="device-start">{children}</div>
    </div>
  );
}

/**
 * Opens before a ride when the trainer or the heart rate strap is missing.
 * The trainer is required; a ride without a strap is possible.
 */
function StartDevicesDialog({ onReady, onClose }: { onReady: () => void; onClose: () => void }) {
  const slots = useStore(deviceManager.slots);
  const settings = useStore(settingsStore);
  const trainerOk = slots.trainer.state === 'connected';
  const hrmOk = slots.hrm.state === 'connected';
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    if (trainerOk && hrmOk) ready.current();
  }, [trainerOk, hrmOk]);
  useEffect(() => {
    void deviceManager.autoConnect();
  }, []);

  const row = (slot: 'trainer' | 'hrm', title: string, hint: string) => {
    const s = slots[slot];
    const ok = s.state === 'connected';
    const busy = s.state === 'connecting' || s.state === 'reconnecting';
    return (
      <div className={`start-device${ok ? ' ok' : ''}`}>
        <span className="device-icon">
          <Icon name={slot === 'trainer' ? 'ride' : 'heart'} size={22} />
        </span>
        <span className="start-device-text">
          <strong>{title}</strong>
          <span className="muted small">{ok ? `● ${s.name ?? 'Verbunden'}` : busy ? 'Suche …' : hint}</span>
          {s.error && <span className="error-text small">{s.error}</span>}
        </span>
        {ok ? (
          <span className="ok-text">Verbunden</span>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void deviceManager.connect(slot)}>
            {busy ? 'Verbinde …' : settings.useSimulator ? 'Simulator verbinden' : 'Verbinden'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal start-devices" role="dialog" aria-label="Geräte verbinden">
        <h2>Geräte verbinden</h2>
        <p className="muted small">Vor dem Start brauchst du deinen Trainer. Mit Pulsgurt siehst du auch deine Herzfrequenz.</p>
        {row('trainer', 'Smart-Trainer', 'Pflicht – z. B. Wahoo KICKR')}
        {row('hrm', 'Pulsgurt', 'Optional – Brustgurt oder Uhr')}
        <div className="row start-devices-actions">
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={!trainerOk} onClick={onReady}>
            {hrmOk ? 'Los geht’s' : 'Ohne Pulsgurt starten'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RouteSelect({ view, onStart }: { view: 'ride' | 'workouts'; onStart: (routeId: string, workout?: Workout) => void }) {
  const settings = useStore(settingsStore);
  const garage = useStore(garageStore);
  const slots = useStore(deviceManager.slots);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RouteFilter>('all');
  const [workout, setWorkout] = useState<Workout | undefined>();
  const [online, setOnline] = useState<Record<string, number> | null>(null);
  const [pending, setPending] = useState<{ routeId: string; workout?: Workout } | null>(null);
  const hasServer = !!settings.serverUrl.trim();

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
  const sel = routes.find((x) => x.r.id === routeId);
  const onlineOf = (id: string) => (online ? (online[id] ?? 0) : null);
  const shown = routes.filter(({ r, diff }) => (filter === 'all' ? true : filter === 'real' ? !!r.world : filter === 'fantasy' ? !!r.fantasy : filter === 'flat' ? diff <= 2 : diff >= 3));

  // Without trainer or strap, the device dialog comes first.
  const start = (w?: Workout) => {
    if (!routeId) return;
    if (slots.trainer.state === 'connected' && slots.hrm.state === 'connected') onStart(routeId, w);
    else setPending({ routeId, workout: w });
  };

  return (
    <div className="page ride-home">
      <div className="page-inner">
        {view === 'ride' && (
          <>
            <header className="page-head">
              <div>
                <h1>Fahren</h1>
                <span className="muted">{sel ? `${sel.r.name} – unten rechts frei fahren oder ein Workout wählen.` : 'Wähle eine Strecke.'}</span>
              </div>
              <div className="chips">
                {FILTERS.map((f) => (
                  <button key={f.id} className={filter === f.id ? 'chip active' : 'chip'} onClick={() => setFilter(f.id)}>
                    {f.label}
                  </button>
                ))}
              </div>
            </header>
            <div className="route-grid">
              {shown.map((row) => (
                <RouteImageCard key={row.r.id} row={row} selected={row.r.id === routeId} online={onlineOf(row.r.id)} onClick={() => setRouteId(row.r.id)} />
              ))}
            </div>
          </>
        )}

        {view === 'workouts' && (
          <>
            <header className="page-head">
              <h1>Workouts</h1>
              <button className="route-pick" onClick={() => pageStore.set('ride')}>
                {sel && <span className="route-pick-img" style={{ backgroundImage: `url(${routeShot(sel.r.id)})` }} />}
                <span>
                  <span className="muted small">Strecke</span>
                  <strong>{sel ? sel.r.name : 'Noch keine gewählt'}</strong>
                </span>
                <span className="link">{sel ? 'ändern' : 'wählen'}</span>
              </button>
            </header>
            <WorkoutSelect selectedId={workout?.id} onSelect={setWorkout} />
          </>
        )}
      </div>

      <DeviceBar>
        {view === 'ride' ? (
          <>
            <button className="ghost cta" disabled={!sel} onClick={() => pageStore.set('workouts')}>
              <Icon name="workouts" size={16} />
              Workout auswählen
            </button>
            <button className="primary cta start-training" disabled={!sel} onClick={() => start()}>
              <Icon name="play" size={16} />
              Freie Fahrt
            </button>
          </>
        ) : !sel ? (
          <button className="primary cta start-training" onClick={() => pageStore.set('ride')}>
            Strecke wählen <Icon name="arrow" size={16} />
          </button>
        ) : (
          <button className="primary cta start-training" disabled={!workout} onClick={() => start(workout)}>
            <Icon name="play" size={16} />
            {workout ? 'Workout starten' : 'Workout wählen'}
          </button>
        )}
      </DeviceBar>
      {pending && (
        <StartDevicesDialog
          onClose={() => setPending(null)}
          onReady={() => {
            setPending(null);
            onStart(pending.routeId, pending.workout);
          }}
        />
      )}
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
  const viewRef = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<RideSession | null>(null);
  const [world, setWorld] = useState<GameWorld | null>(null);
  const [progress, setProgress] = useState('Strecke wird geladen …');
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraMode>('chase');

  useEffect(() => {
    let cancelled = false;
    let w: GameWorld | null = null;
    let botTimer: ReturnType<typeof setInterval> | undefined;
    const garage = garageStore.get();
    const st = settingsStore.get();
    const net =
      serverBase() && !DEV_RIDE
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
        const drawn = new Set<string>();
        const syncBots = () => {
          const next = s.botsToDraw(drawn);
          for (const b of s.bots) {
            if (next.has(b.id) && !drawn.has(b.id)) created.ensureRider(b.id, b.look);
            else if (!next.has(b.id) && drawn.has(b.id)) created.removeRider(b.id);
          }
          drawn.clear();
          for (const id of next) drawn.add(id);
        };
        syncBots();
        botTimer = setInterval(syncBots, 1000);
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
      clearInterval(botTimer);
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
      } else if ((e.key === '-' || e.key === '_') && settingsStore.get().shiftKeys) {
        session.shift(-1);
      } else if ((e.key === '+' || e.key === '=') && settingsStore.get().shiftKeys) {
        session.shift(1);
      } else if (e.key === 'p' || e.key === 'P') {
        const st = session.snapshot.get().state;
        if (st === 'riding') session.pause();
        else if (st === 'paused') session.resume();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [world, session]);

  // Virtual shifting from the Zwift remote and, if chosen, the mouse (left heavier, right lighter).
  useEffect(() => {
    if (!session) return;
    const off = deviceManager.onShift((d) => session.shift(d));
    const view = viewRef.current;
    const onMouse = (e: MouseEvent) => {
      if (!settingsStore.get().shiftMouse || (e.button !== 0 && e.button !== 2)) return;
      if ((e.target as Element).closest('button, input, select, textarea, a, label, .hud-controls')) return;
      session.shift(e.button === 0 ? 1 : -1);
    };
    const onMenu = (e: MouseEvent) => {
      if (settingsStore.get().shiftMouse) e.preventDefault();
    };
    view?.addEventListener('mousedown', onMouse);
    view?.addEventListener('contextmenu', onMenu);
    return () => {
      off();
      view?.removeEventListener('mousedown', onMouse);
      view?.removeEventListener('contextmenu', onMenu);
    };
  }, [session]);

  return (
    <div className="ride-view" ref={viewRef}>
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
