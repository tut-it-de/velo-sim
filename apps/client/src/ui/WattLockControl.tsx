import { useEffect } from 'react';
import { deviceManager } from '../devices/deviceManager';
import type { RideSession, RideSnapshot } from '../ride/rideSession';
import { WATT_LOCK_STEP } from '../ride/wattLock';

/**
 * Watt-Lock in the free ride: the trainer holds the current watts (ERG). Key L switches it, ↑ / ↓
 * change ±5 W (not with the trainer simulator, whose rider power sits on those keys) – and every
 * virtual shift (+/−, Zwift remote, mouse) changes the watts instead of the gear while it is on.
 */
export function WattLockControl({ session, snapshot: s }: { session: RideSession; snapshot: RideSnapshot }) {
  const workoutRunning = !!s.workout && !s.workout.finished;
  useEffect(() => {
    if (workoutRunning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'l' || e.key === 'L') {
        session.toggleWattLock();
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && session.wattLock.active && !deviceManager.simTransport.trainer?.connected) {
        session.adjustWattLock(e.key === 'ArrowUp' ? 1 : -1);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, workoutRunning]);

  if (workoutRunning) return null;
  if (s.wattLock === undefined) {
    return (
      <button
        className="watt-lock-button"
        aria-label="Watt-Lock"
        onClick={() => session.toggleWattLock()}
        disabled={!s.canWattLock}
        title={s.canWattLock ? 'Watt-Lock: der Trainer hält deine aktuellen Watt (Taste L)' : 'Watt-Lock braucht einen Trainer mit ERG-Modus'}
      >
        🔒<span className="watt-lock-label"> Watt-Lock</span>
      </button>
    );
  }
  return (
    <div className="shifter watt-lock" title="Watt-Lock: −/+ (auch Schalter, Tasten +/−, ↑/↓) ändert um 5 W. Antippen oder L beendet.">
      <button onClick={() => session.adjustWattLock(-1)} aria-label={`${WATT_LOCK_STEP} W weniger`}>
        −
      </button>
      <button className="watt-lock-value" onClick={() => session.toggleWattLock()} aria-label="Watt-Lock beenden">
        <small>Watt-Lock</small>
        {s.wattLock} W
      </button>
      <button onClick={() => session.adjustWattLock(1)} aria-label={`${WATT_LOCK_STEP} W mehr`}>
        +
      </button>
    </div>
  );
}
