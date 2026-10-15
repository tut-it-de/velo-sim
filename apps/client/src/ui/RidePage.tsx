import { useEffect, useRef, useState } from 'react';
import { ROUTES, getTrack } from '@velo/routes';
import { deviceManager } from '../devices/deviceManager';
import { keepAwake } from '../devices/files';
import { CAMERA_MODES, GameWorld, type CameraMode } from '../game/world';
import { RideSession, type RideResult } from '../ride/rideSession';
import { saveActivity, type StoredActivity } from '../state/activities';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { uiStore } from '../state/ui';
import { ElevationProfile } from './ElevationProfile';
import { Hud } from './Hud';
import { RideSummary } from './RideSummary';

type Phase = { kind: 'select' } | { kind: 'ride'; routeId: string; bots: boolean } | { kind: 'summary'; result: RideResult; activity: StoredActivity };

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
        onFinish={async (result) => {
          const activity = await saveActivity(result, settingsStore.get().useSimulator);
          setPhase({ kind: 'summary', result, activity });
        }}
        onCancel={() => setPhase({ kind: 'select' })}
      />
    );
  }
  return (
    <>
      <RouteSelect onStart={(routeId, bots) => setPhase({ kind: 'ride', routeId, bots })} />
      {phase.kind === 'summary' && <RideSummary result={phase.result} activity={phase.activity} onClose={() => setPhase({ kind: 'select' })} />}
    </>
  );
}

function RouteSelect({ onStart }: { onStart: (routeId: string, bots: boolean) => void }) {
  const slots = useStore(deviceManager.slots);
  const settings = useStore(settingsStore);
  const [routeId, setRouteId] = useState(ROUTES[0]!.id);
  const [bots, setBots] = useState(true);
  const trainerReady = slots.trainer.state === 'connected';

  const useSimulator = async () => {
    updateSettings({ useSimulator: true });
    await deviceManager.connect('trainer');
    await deviceManager.connect('hrm');
  };

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Freie Fahrt</h1>
        {!trainerReady && (
          <div className="notice row" style={{ justifyContent: 'space-between' }}>
            <span>Kein Trainer verbunden. Verbinde deinen KICKR unter „Geräte“ – oder teste mit dem Simulator.</span>
            {!settings.useSimulator || slots.trainer.state === 'disconnected' ? (
              <button onClick={useSimulator}>Simulator starten</button>
            ) : null}
          </div>
        )}
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
          <label className="row">
            <input type="checkbox" checked={bots} onChange={(e) => setBots(e.target.checked)} />
            Pacer-Bots (2,0 / 2,8 / 3,5 W/kg) – zum Mitfahren im Windschatten
          </label>
          <div className="row">
            <span className="muted small">Trainer-Schwierigkeit {Math.round(settings.trainerDifficulty * 100)} %</span>
            <button className="primary" onClick={() => onStart(routeId, bots)}>
              Los geht’s
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RideView({ routeId, bots, onFinish, onCancel }: { routeId: string; bots: boolean; onFinish: (r: RideResult) => void; onCancel: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [session, setSession] = useState<RideSession | null>(null);
  const [world, setWorld] = useState<GameWorld | null>(null);
  const [progress, setProgress] = useState('Strecke wird geladen …');
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState<CameraMode>('chase');

  useEffect(() => {
    let cancelled = false;
    let w: GameWorld | null = null;
    const s = new RideSession(routeId, settingsStore.get(), { bots });
    const s2 = settingsStore.get();
    GameWorld.create(canvasRef.current!, routeId, { jersey: '#ff7a1a', frame: '#20232a', helmet: '#ffffff', rim: '#ff7a1a' }, setProgress)
      .then((created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        w = created;
        for (const b of s.bots) created.ensureRider(b.id, b.look);
        created.setFrameProvider((dt) => s.frame(dt));
        s.start();
        setWorld(created);
        setSession(s);
        (window as unknown as { __velo?: unknown }).__velo = { world: created, session: s };
        void keepAwake(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    void s2;
    return () => {
      cancelled = true;
      s.dispose();
      w?.dispose();
      void keepAwake(false);
    };
  }, [routeId, bots]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!world || !session) return;
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
          onFinish={() => onFinish(session.finish())}
        />
      )}
    </div>
  );
}
