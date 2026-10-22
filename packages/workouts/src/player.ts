import { buildTimeline, findSegment, segmentPowerAt, type CadenceTarget, type TimelineSegment, type Workout } from './model';
import { isRampStep, isTestBlock, type TestProgress } from './test';

export interface PlayerInput {
  power: number;
  cadence: number;
}

export interface PlayerState {
  elapsedS: number;
  totalS: number;
  finished: boolean;
  segment?: TimelineSegment;
  next?: TimelineSegment;
  segmentElapsedS: number;
  segmentRemainingS: number;
  mode: 'erg' | 'free';
  /** Power the trainer should hold (ERG only), after intensity and relief. */
  targetWatts?: number;
  /** Unmodified target as fraction of FTP. */
  targetFraction?: number;
  cadenceTarget?: CadenceTarget;
  intensity: number;
  /** ERG reduced because the rider's cadence collapsed (prevents the "ERG death spiral"). */
  relief: boolean;
  /** Share of ERG time within ±10 % of target (0…1). */
  compliance: number;
  segmentCompliance: number;
  activeText?: string;
  /** Live numbers of the 20-minute test block (only while riding it). */
  testBlock?: { elapsedS: number; avgPower: number };
}

export interface PlayerStep {
  state: PlayerState;
  /** True when this advance crossed into a new segment (used to close a lap). */
  segmentChanged: boolean;
}

const RELIEF_CADENCE = 40;
const RELIEF_AFTER_S = 3;
const RECOVER_CADENCE = 65;
const RECOVER_AFTER_S = 2;
const RAMP_FAIL_CADENCE = 50;
const RAMP_FAIL_AFTER_S = 5;

/**
 * Drives a structured workout: computes the ERG target every tick, handles
 * pause/skip/intensity, the low-cadence relief and compliance scoring.
 * Pure logic — the ride session sends the targets to the trainer.
 */
export class WorkoutPlayer {
  readonly timeline: TimelineSegment[];
  readonly totalS: number;
  private elapsed = 0;
  private intensity: number;
  private relief = false;
  private lowCadenceS = 0;
  private recoverS = 0;
  private inTarget = 0;
  private ergTime = 0;
  private segIn = 0;
  private segTime = 0;
  private currentIndex = -1;
  private rampFailS = 0;
  private rampS = 0;
  private rampAborted = false;
  private blockS = 0;
  private blockJ = 0;
  private last: PlayerState;

  constructor(
    readonly workout: Workout,
    readonly ftp: number,
    opts: { intensity?: number } = {},
  ) {
    this.timeline = buildTimeline(workout, ftp);
    this.totalS = this.timeline.reduce((a, s) => a + s.durationS, 0);
    this.intensity = opts.intensity ?? 1;
    this.last = this.compute();
  }

  get state(): PlayerState {
    return this.last;
  }

  setIntensity(value: number): void {
    this.intensity = Math.min(1.5, Math.max(0.5, Math.round(value * 100) / 100));
    this.last = this.compute();
  }

  /** Jumps to the start of the next segment. */
  skip(): void {
    const seg = findSegment(this.timeline, this.elapsed);
    if (seg) this.elapsed = seg.startS + seg.durationS;
    this.last = this.compute();
  }

  advance(dtS: number, input: PlayerInput): PlayerStep {
    if (this.last.finished) return { state: this.last, segmentChanged: false };
    const from = this.elapsed;
    this.elapsed = Math.min(this.totalS, this.elapsed + dtS);
    // Test bookkeeping: time spent in ramp steps / the test block during this tick.
    for (const s of this.timeline) {
      if (!isRampStep(s) && !isTestBlock(s)) continue;
      const overlap = Math.min(this.elapsed, s.startS + s.durationS) - Math.max(from, s.startS);
      if (overlap <= 0) continue;
      if (isRampStep(s)) this.rampS += overlap;
      else {
        this.blockS += overlap;
        this.blockJ += input.power * overlap;
      }
    }
    const seg = findSegment(this.timeline, this.elapsed);

    // Low-cadence relief in ERG mode.
    if (seg?.mode === 'erg') {
      if (!this.relief) {
        this.lowCadenceS = input.cadence < RELIEF_CADENCE ? this.lowCadenceS + dtS : 0;
        if (this.lowCadenceS >= RELIEF_AFTER_S) {
          this.relief = true;
          this.recoverS = 0;
        }
      } else {
        this.recoverS = input.cadence >= RECOVER_CADENCE ? this.recoverS + dtS : 0;
        if (this.recoverS >= RECOVER_AFTER_S) {
          this.relief = false;
          this.lowCadenceS = 0;
        }
      }
    } else {
      this.relief = false;
      this.lowCadenceS = 0;
    }

    // Ramp test: when the rider can no longer turn the pedals, jump to the cooldown.
    if (this.workout.test === 'ramp' && seg && isRampStep(seg)) {
      this.rampFailS = input.cadence < RAMP_FAIL_CADENCE ? this.rampFailS + dtS : 0;
      if (this.rampFailS >= RAMP_FAIL_AFTER_S) {
        const cooldown = this.timeline.find((s) => s.kind === 'cooldown');
        if (cooldown) this.elapsed = cooldown.startS;
        this.rampFailS = 0;
        this.relief = false;
        this.rampAborted = true;
      }
    }

    const state = this.compute();
    const changed = state.segment?.index !== this.currentIndex;
    if (changed) {
      this.currentIndex = state.segment?.index ?? -1;
      this.segIn = 0;
      this.segTime = 0;
    }

    // Compliance: ±10 % (at least ±10 W) of the target in ERG segments.
    if (state.mode === 'erg' && state.targetWatts !== undefined && !this.relief && state.segmentElapsedS > 3) {
      const tol = Math.max(10, state.targetWatts * 0.1);
      const ok = Math.abs(input.power - state.targetWatts) <= tol;
      this.ergTime += dtS;
      this.segTime += dtS;
      if (ok) {
        this.inTarget += dtS;
        this.segIn += dtS;
      }
    }
    this.last = { ...state, compliance: this.ergTime ? this.inTarget / this.ergTime : 1, segmentCompliance: this.segTime ? this.segIn / this.segTime : 1 };
    return { state: this.last, segmentChanged: changed };
  }

  /** What the rider has done of the test so far — the input for evaluateTest(). */
  get testProgress(): TestProgress {
    const steps = this.timeline.filter(isRampStep);
    const last = steps.at(-1);
    return {
      rampS: this.rampS,
      rampTopReached: !!last && !this.rampAborted && this.elapsed >= last.startS + last.durationS,
      topStepWatts: last ? Math.round(last.powerEnd * this.ftp) : undefined,
      blockS: this.blockS,
      blockAvgPower: this.blockS > 0 ? this.blockJ / this.blockS : 0,
      blockPlannedS: this.timeline.find(isTestBlock)?.durationS ?? 0,
    };
  }

  private compute(): PlayerState {
    const finished = this.elapsed >= this.totalS;
    const seg = finished ? undefined : findSegment(this.timeline, this.elapsed);
    const next = seg ? this.timeline[seg.index + 1] : undefined;
    const mode = seg?.mode ?? 'free';
    let targetWatts: number | undefined;
    let targetFraction: number | undefined;
    if (seg && seg.mode === 'erg') {
      targetFraction = segmentPowerAt(seg, this.elapsed);
      targetWatts = Math.round(targetFraction * this.ftp * this.intensity);
      if (this.relief) targetWatts = Math.max(50, Math.round(targetWatts * 0.5));
    }
    const text = this.workout.textEvents?.find((e) => this.elapsed >= e.atS && this.elapsed < e.atS + (e.durationS ?? 10));
    return {
      elapsedS: this.elapsed,
      totalS: this.totalS,
      finished,
      segment: seg,
      next,
      segmentElapsedS: seg ? this.elapsed - seg.startS : 0,
      segmentRemainingS: seg ? seg.startS + seg.durationS - this.elapsed : 0,
      mode,
      targetWatts,
      targetFraction,
      cadenceTarget: seg?.cadence,
      intensity: this.intensity,
      relief: this.relief,
      compliance: this.last?.compliance ?? 1,
      segmentCompliance: this.last?.segmentCompliance ?? 1,
      activeText: text?.message,
      testBlock: seg && isTestBlock(seg) ? { elapsedS: this.elapsed - seg.startS, avgPower: this.blockS > 0 ? this.blockJ / this.blockS : 0 } : undefined,
    };
  }
}
