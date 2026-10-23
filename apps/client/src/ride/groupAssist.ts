import type { Environment, RiderState } from '@velo/physics';
import { Store } from '../state/store';

/**
 * "Stay together" for group rides (no race): riders behind the group get extra draft and a light
 * push, riders ahead a bit more resistance – both grow with the gap to the group position (median
 * of all riders, sent by the server). Only speed and position change: the measured power, and with
 * it TSS, kJ, the FIT file and the Watt-Taler, stay real.
 *
 * The push is a virtual grade on top of the route's (the trainer still gets the real grade):
 *
 *   x      = clamp(gap / SOFT_M, −1, 1)                      gap = group − me, + = I am behind
 *   grade' = grade − MAX_GRADE·x − DAMPING·(v_group − v_me)  clamped to ±MAX_TOTAL_GRADE around the route grade
 *   draft' = draft + EXTRA_DRAFT·max(0, x) − LESS_DRAFT·max(0, −x)
 *
 * Beyond HARD_M the rider is pulled back to the group (position eased, at most PULL_MAX_MPS faster)
 * or, when ahead, held at HARD_M until the group is back.
 */
export const ASSIST = {
  /** Gap to the group (m) at which the help reaches full strength. */
  SOFT_M: 20,
  /** Hard limit: beyond this gap the rider is pulled back / held. */
  HARD_M: 60,
  /** Virtual grade in % at full strength (≈ 50 N for 85 kg). */
  MAX_GRADE: 8,
  /** Grade % per m/s speed difference to the group – damps the elastic band so it does not swing. */
  DAMPING: 1.2,
  MAX_TOTAL_GRADE: 10,
  EXTRA_DRAFT: 0.25,
  LESS_DRAFT: 0.1,
  MAX_DRAFT: 0.6,
  /** Share of the excess gap pulled in per second, and the cap on that extra speed. */
  PULL_RATE: 0.5,
  PULL_MAX_MPS: 6,
  /** Help shorter than this is not worth a hint in the HUD. */
  HINT_GRADE: 0.8,
} as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface GroupFix {
  /** Group distance (m) and speed (m/s) at `at` (local ms). */
  d: number;
  v: number;
  n: number;
  at: number;
}

/** The environment for my physics step with the group help (pure – used by the tests too). */
export function assistEnvironment(env: Environment, me: RiderState, group: { d: number; v: number }): Environment {
  const gap = group.d - me.distanceM;
  const x = clamp(gap / ASSIST.SOFT_M, -1, 1);
  const offset = clamp(-ASSIST.MAX_GRADE * x - ASSIST.DAMPING * (group.v - me.speedMps), -ASSIST.MAX_TOTAL_GRADE, ASSIST.MAX_TOTAL_GRADE);
  const draft = clamp((env.draftReduction ?? 0) + ASSIST.EXTRA_DRAFT * Math.max(0, x) - ASSIST.LESS_DRAFT * Math.max(0, -x), 0, ASSIST.MAX_DRAFT);
  return { ...env, gradePercent: env.gradePercent + offset, draftReduction: draft };
}

/** Hard limit after the physics step (pure). `prev` is my state before the step. */
export function assistConstrain(prev: RiderState, next: RiderState, group: { d: number; v: number }, dt: number): RiderState {
  const gap = group.d - next.distanceM;
  if (gap > ASSIST.HARD_M && next.speedMps > 0.5) {
    // Dropped: eased back towards the group while still pedalling (stopping lets you go).
    const pull = Math.min((gap - ASSIST.HARD_M) * ASSIST.PULL_RATE, ASSIST.PULL_MAX_MPS) * dt;
    return { ...next, distanceM: next.distanceM + pull };
  }
  if (gap < -ASSIST.HARD_M) {
    // Too far ahead: held at the limit (never moved backwards) until the group comes.
    return { distanceM: Math.max(prev.distanceM, group.d + ASSIST.HARD_M), speedMps: Math.min(next.speedMps, Math.max(0, group.v) + 0.5) };
  }
  return next;
}

export interface AssistState {
  /** Gap to the group position (+ = I am behind), undefined before the first fix. */
  gapM?: number;
  /** 'pull': the group pulls me along, 'brake': I am ahead and get slowed, 'hold': at the hard limit. */
  mode: 'none' | 'pull' | 'brake' | 'hold';
  riders: number;
}

/** Hook into RideSession: changes my speed/position, never the power. */
export interface RideAssist {
  environment(env: Environment, me: RiderState, now: number): Environment;
  constrain(prev: RiderState, next: RiderState, dt: number, now: number): RiderState;
}

/**
 * Live group help for one ride. Fed with the server's group position (4 Hz) and extrapolated
 * between fixes; without a fix, or alone, it does nothing.
 */
export class GroupAssist implements RideAssist {
  readonly state = new Store<AssistState>({ mode: 'none', riders: 0 });
  private fix?: GroupFix;

  constructor(readonly enabled: boolean) {}

  update(d: number, v: number, n: number, at = performance.now()): void {
    this.fix = { d, v, n, at };
  }

  /** Group position now (extrapolated for at most 2 s), undefined when there is no group to stay with. */
  group(now: number): { d: number; v: number } | undefined {
    const f = this.fix;
    if (!f || f.n < 2 || now - f.at > 5000) return undefined;
    return { d: f.d + f.v * clamp((now - f.at) / 1000, 0, 2), v: f.v };
  }

  environment(env: Environment, me: RiderState, now: number): Environment {
    const g = this.group(now);
    if (!g) {
      this.publish(undefined, 'none');
      return env;
    }
    const gap = g.d - me.distanceM;
    if (!this.enabled) {
      this.publish(gap, 'none');
      return env;
    }
    const out = assistEnvironment(env, me, g);
    // hysteresis: the hint shows from HINT_GRADE and stays until half of it, so it does not flicker
    const offset = out.gradePercent - env.gradePercent;
    const was = this.state.get().mode;
    const pull = offset < -(was === 'pull' ? ASSIST.HINT_GRADE / 2 : ASSIST.HINT_GRADE);
    const brake = offset > (was === 'brake' ? ASSIST.HINT_GRADE / 2 : ASSIST.HINT_GRADE);
    this.publish(gap, Math.abs(gap) > ASSIST.HARD_M ? 'hold' : pull ? 'pull' : brake ? 'brake' : 'none');
    return out;
  }

  constrain(prev: RiderState, next: RiderState, dt: number, now: number): RiderState {
    const g = this.group(now);
    return g && this.enabled ? assistConstrain(prev, next, g, dt) : next;
  }

  private publish(gapM: number | undefined, mode: AssistState['mode']): void {
    const s = this.state.get();
    const riders = this.fix?.n ?? 0;
    const rounded = gapM === undefined ? undefined : Math.round(gapM);
    if (s.mode !== mode || s.gapM !== rounded || s.riders !== riders) this.state.set({ gapM: rounded, mode, riders });
  }
}
