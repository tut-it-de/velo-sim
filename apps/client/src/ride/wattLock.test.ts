import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WATT_LOCK_MAX, WATT_LOCK_MIN, WattLock, lockWatts, wattLockAllowed } from './wattLock';

const dm = vi.hoisted(() => {
  const d = {
    canErg: true,
    canSim: true,
    live: { power: 0, power3s: 0, cadence: 0 },
    metrics: { get: () => ({ ...d.live, stale: false, heartRate: undefined as number | undefined }) },
    setErg: async (_w: number) => undefined,
    setSim: async (_p: unknown) => undefined,
  };
  return d;
});
vi.mock('../devices/deviceManager', () => ({ deviceManager: dm }));

const { RideSession, NEUTRAL_GEAR } = await import('./rideSession');
const { DEFAULT_SETTINGS } = await import('../state/settings');

describe('WattLock', () => {
  it('rounds to 5 W and stays in range', () => {
    expect(lockWatts(218)).toBe(220);
    expect(lockWatts(217.4)).toBe(215);
    expect(lockWatts(12)).toBe(WATT_LOCK_MIN);
    expect(lockWatts(5000)).toBe(WATT_LOCK_MAX);
    expect(lockWatts(NaN)).toBe(WATT_LOCK_MIN);
  });

  it('switches on and off and changes in 5-W steps', () => {
    const l = new WattLock();
    expect(l.adjust(1)).toBeUndefined();
    expect(l.toggle(203)).toBe(true);
    expect(l.watts).toBe(205);
    expect(l.adjust(2)).toBe(215);
    expect(l.adjust(-1)).toBe(210);
    expect(l.toggle(400)).toBe(false);
    expect(l.watts).toBeUndefined();
    expect(l.lastRelease).toBe('toggle');
    expect(l.release('paused')).toBe(false);
  });

  it('is offered only in free rides with an ERG trainer', () => {
    expect(wattLockAllowed({ riding: true, canErg: true, workoutActive: false })).toBe(true);
    expect(wattLockAllowed({ riding: true, canErg: true, workoutActive: true })).toBe(false);
    expect(wattLockAllowed({ riding: true, canErg: false, workoutActive: false })).toBe(false);
    expect(wattLockAllowed({ riding: false, canErg: true, workoutActive: false })).toBe(false);
  });
});

describe('Watt-Lock in the ride', () => {
  let now = 0;
  let erg: number[] = [];
  let sims = 0;
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    dm.canErg = true;
    erg = [];
    sims = 0;
    dm.setErg = async (w: number) => void erg.push(w);
    dm.setSim = async () => void sims++;
    dm.live = { power: 223, power3s: 223, cadence: 90 };
  });

  type Session = InstanceType<typeof RideSession>;
  const tick = (s: Session, seconds = 0.1) => {
    for (let t = 0; t < seconds - 1e-9; t += 0.1) {
      now += 100;
      (s as unknown as { tick(): void }).tick();
    }
  };

  it('holds the watts by ERG, shifting changes them instead of the gear', () => {
    const s = new RideSession('kuestenrunde', DEFAULT_SETTINGS);
    tick(s);
    expect(s.snapshot.get().canWattLock).toBe(true);
    s.toggleWattLock();
    expect(s.snapshot.get().wattLock).toBe(225);
    expect(erg.at(-1)).toBe(225);
    sims = 0;
    s.shift(1);
    s.shift(1);
    expect(s.snapshot.get().wattLock).toBe(235);
    expect(s.snapshot.get().gear).toBe(NEUTRAL_GEAR);
    tick(s, 1.2);
    expect(erg.at(-1)).toBe(235);
    expect(sims).toBe(0);
    s.toggleWattLock();
    expect(s.snapshot.get().wattLock).toBeUndefined();
    expect(sims).toBe(1);
    s.dispose();
  });

  it('ends when the rider stops pedalling, pauses or finishes', () => {
    const s = new RideSession('kuestenrunde', { ...DEFAULT_SETTINGS, autoPause: false });
    tick(s);
    s.toggleWattLock();
    dm.live = { power: 0, power3s: 0, cadence: 0 };
    tick(s, 3.5);
    expect(s.wattLock.active).toBe(false);
    expect(s.wattLock.lastRelease).toBe('stopped');

    dm.live = { power: 200, power3s: 200, cadence: 90 };
    tick(s);
    s.toggleWattLock();
    expect(s.wattLock.active).toBe(true);
    s.pause();
    expect(s.wattLock.lastRelease).toBe('paused');
    s.resume();
    s.toggleWattLock();
    expect(s.wattLock.active).toBe(true);
    s.finish();
    expect(s.wattLock.lastRelease).toBe('finished');
    expect(s.snapshot.get().wattLock).toBeUndefined();
  });

  it('is not possible in a workout or without ERG', () => {
    const workout = { id: 'w', name: 'W', steps: [{ type: 'steady', durationS: 600, power: 0.6 }] };
    const w = new RideSession('kuestenrunde', DEFAULT_SETTINGS, { workout: workout as never });
    tick(w);
    w.toggleWattLock();
    expect(w.wattLock.active).toBe(false);
    expect(w.snapshot.get().canWattLock).toBe(false);
    w.dispose();

    dm.canErg = false;
    const s = new RideSession('kuestenrunde', DEFAULT_SETTINGS);
    s.toggleWattLock();
    expect(s.wattLock.active).toBe(false);
    s.dispose();
  });

  it('turns off when the trainer can no longer hold ERG', () => {
    const s = new RideSession('kuestenrunde', DEFAULT_SETTINGS);
    tick(s);
    s.toggleWattLock();
    dm.canErg = false;
    tick(s);
    expect(s.wattLock.lastRelease).toBe('unavailable');
    s.dispose();
  });
});
