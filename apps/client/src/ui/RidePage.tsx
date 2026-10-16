import { useEffect, useRef, useState } from 'react';
import { accountStore, fetchOnline, isLoggedIn, refreshAccount, serverBase } from '../net/api';
import { MultiplayerClient } from '../net/multiplayer';
import { maybeAutoUpload } from '../net/strava';
import { ROUTES, getTrack } from '@velo/routes';
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
import { uiStore } from '../state/ui';
import { ElevationProfile } from './ElevationProfile';
import { Hud } from './Hud';
import { RideSummary } from './RideSummary';
import { WorkoutSelect } from './WorkoutSelect';
import { formatDuration } from './components';

type Phase =
  | { kind: 'select' }
  | { kind: 'ride'; routeId: string; bots: boolean; workout?: Workout }
  | { kind: 'summary'; result: RideResult; activity: StoredActivity };

export function RidePage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'select' });

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

function RouteSelect({ onStart }: { onStart: (routeId: string, bots: boolean, workout?: Workout) => void }) {
  const slots = useStore(deviceManager.slots);
  const settings = useStore(settingsStore);
  const [routeId, setRouteId] = useState(ROUTES[0]!.id);
  const [bots, setBots] = useState(true);
  const [mode, setMode] = useState<'free' | 'workout'>('free');
  const [workout, setWorkout] = useState<Workout | undefined>();
  const [online, setOnline] = useState<Record<string, number> | null>(null);
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
  const trainerReady = slots.trainer.state === 'connected';

  const useSimulator = async () => {
    updateSettings({ useSimulator: true });
    await deviceManager.connect('trainer');
    await deviceManager.connect('hrm');
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>Fahren</h1>
          <div className="segmented">
            <button className={mode === 'free' ? 'active' : ''} onClick={() => setMode('free')}>
              Freie Fahrt
            </button>
            <button className={mode === 'workout' ? 'active' : ''} onClick={() => setMode('workout')}>
              Workout
            </button>
          </div>
        </div>
        {!trainerReady && (
          <div className="notice row" style={{ justifyContent: 'space-between' }}>
            <span>Kein Trainer verbunden. Verbinde deinen KICKR unter „Geräte“ – oder teste mit dem Simulator.</span>
            {!settings.useSimulator || slots.trainer.state === 'disconnected' ? (
              <button onClick={useSimulator}>Simulator starten</button>
            ) : null}
          </div>
        )}
        {mode === 'workout' && <WorkoutSelect selectedId={workout?.id} onSelect={setWorkout} />}
        {mode === 'workout' && <h2 style={{ margin: '4px 0 -6px' }}>Strecke für das Workout</h2>}
        <div className="grid cols-3">
          {ROUTES.map((r) => {
            const t = getTrack(r.id);
            const selected = r.id === routeId;
            return (
              <button
                key={r.id}
                className={`route-card ${selected ? 'selected' : ''}`}
                onClick={() => setRouteId(r.id)}
                aria-pressed={selected}
              >
                <div className="route-title">{r.name}</div>
                <div className="route-stats">
                  <span>{(t.length / 1000).toFixed(1)} km</span>
                  <span>{Math.round(t.elevationGain)} hm</span>
                  <span>max. {t.maxGrade.toFixed(0)} %</span>
                  {online && <span className="online-count">🌐 {online[r.id] ?? 0} online</span>}
                </div>
                <ElevationProfile track={t} height={70} />
                <div className="muted small" style={{ marginTop: 8, textAlign: 'left' }}>
                  {r.description}
                </div>
              </button>
            );
          })}
        </div>
        <div className="card row" style={{ justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: 18 }}>
            <label className="row">
              <input type="checkbox" checked={bots} onChange={(e) => setBots(e.target.checked)} />
              Pacer-Bots (2,0 / 2,8 / 3,5 W/kg)
            </label>
            {hasServer && (
              <label className="row" title={online ? '' : 'Server nicht erreichbar'}>
                <input type="checkbox" checked={settings.rideOnline} onChange={(e) => updateSettings({ rideOnline: e.target.checked })} />
                Online mit anderen fahren {online ? '' : '(Server nicht erreichbar)'}
              </label>
            )}
          </div>
          <div className="row">
            <span className="muted small">
              {mode === 'workout' && workout
                ? `${workout.name} · ${formatDuration(workoutStats(workout).durationS)} · FTP ${settings.ftp} W`
                : `Trainer-Schwierigkeit ${Math.round(settings.trainerDifficulty * 100)} %`}
            </span>
            <button
              className="primary"
              disabled={mode === 'workout' && !workout}
              onClick={() => onStart(routeId, bots, mode === 'workout' ? workout : undefined)}
            >
              {mode === 'workout' ? (workout ? 'Workout starten' : 'Workout wählen') : 'Los geht’s'}
            </button>
          </div>
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
      st.rideOnline && serverBase()
        ? new MultiplayerClient(serverBase(), {
            name: accountStore.get().user?.name ?? st.riderName,
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
          net.connect();
        }
        created.setFrameProvider((dt) => s.frame(dt));
        s.start();
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
