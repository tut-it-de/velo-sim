/**
 * Watt-Lock for free rides: the smart trainer holds a fixed power in ERG mode (like a workout block
 * without end). While it is on, the virtual gears do nothing on the trainer – every shift
 * (Zwift remote, mouse, keys, HUD buttons) changes the locked watts by WATT_LOCK_STEP instead.
 */
export const WATT_LOCK_STEP = 5;
export const WATT_LOCK_MIN = 50;
export const WATT_LOCK_MAX = 1000;

export type WattLockReleaseReason = 'toggle' | 'paused' | 'stopped' | 'finished' | 'unavailable';

/** Rounds to the 5-W grid and keeps the value in a range every trainer can hold. */
export function lockWatts(power: number): number {
  const rounded = Math.round((Number.isFinite(power) ? power : 0) / WATT_LOCK_STEP) * WATT_LOCK_STEP;
  return Math.min(WATT_LOCK_MAX, Math.max(WATT_LOCK_MIN, rounded));
}

export interface WattLockConditions {
  /** The ride is running (not paused or finished). */
  riding: boolean;
  /** The trainer is connected and supports ERG. */
  canErg: boolean;
  /** A workout is running – its player controls ERG (also the ramp test). */
  workoutActive: boolean;
}

/** Watt-Lock is offered in free rides with an ERG trainer only. */
export function wattLockAllowed(c: WattLockConditions): boolean {
  return c.riding && c.canErg && !c.workoutActive;
}

export class WattLock {
  private value: number | null = null;
  /** Why the last lock ended (for the HUD / tests). */
  lastRelease?: WattLockReleaseReason;

  get active(): boolean {
    return this.value !== null;
  }

  /** Locked watts, undefined when off. */
  get watts(): number | undefined {
    return this.value ?? undefined;
  }

  engage(currentPower: number): number {
    this.value = lockWatts(currentPower);
    this.lastRelease = undefined;
    return this.value;
  }

  /** On → off, off → on at the current power. Returns whether it is on afterwards. */
  toggle(currentPower: number): boolean {
    if (this.active) this.release('toggle');
    else this.engage(currentPower);
    return this.active;
  }

  /** Changes the locked watts by `steps` × 5 W; ignored while off. */
  adjust(steps: number): number | undefined {
    if (this.value === null) return undefined;
    this.value = lockWatts(this.value + steps * WATT_LOCK_STEP);
    return this.value;
  }

  /** Turns the lock off; returns true when it was on. */
  release(reason: WattLockReleaseReason): boolean {
    if (this.value === null) return false;
    this.value = null;
    this.lastRelease = reason;
    return true;
  }
}
