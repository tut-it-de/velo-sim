import { normalizedPower } from '@velo/metrics';

/** Cadence target: a single rpm value or an inclusive range. */
export type CadenceTarget = number | [min: number, max: number];

export interface IntervalPart {
  durationS: number;
  /** Fraction of FTP, e.g. 1.2 = 120 %. */
  power: number;
  cadence?: CadenceTarget;
}

export type WorkoutStep =
  | { type: 'warmup' | 'cooldown' | 'ramp'; durationS: number; powerStart: number; powerEnd: number; cadence?: CadenceTarget; label?: string }
  | { type: 'steady'; durationS: number; power: number; cadence?: CadenceTarget; label?: string }
  | { type: 'intervals'; repeat: number; on: IntervalPart; off: IntervalPart }
  | { type: 'freeride'; durationS: number; cadence?: CadenceTarget }
  | { type: 'maxeffort'; durationS: number };

export interface TextEvent {
  /** Seconds from the start of the workout. */
  atS: number;
  message: string;
  durationS?: number;
}

export interface Workout {
  id: string;
  name: string;
  description: string;
  author?: string;
  category?: WorkoutCategory;
  steps: WorkoutStep[];
  textEvents?: TextEvent[];
  /** Special handling at the end (FTP estimate). */
  test?: 'ramp';
}

export type WorkoutCategory = 'test' | 'endurance' | 'sweetspot' | 'threshold' | 'vo2max' | 'sprint' | 'cadence' | 'recovery' | 'custom';

export const CATEGORY_LABEL: Record<WorkoutCategory, string> = {
  test: 'Test',
  endurance: 'Grundlage',
  sweetspot: 'Sweet Spot',
  threshold: 'Schwelle',
  vo2max: 'VO2max',
  sprint: 'Sprint',
  cadence: 'Kadenz',
  recovery: 'Erholung',
  custom: 'Eigene',
};

/** One flat piece of the workout timeline. */
export interface TimelineSegment {
  index: number;
  startS: number;
  durationS: number;
  /** ERG = trainer holds power; free = SIM mode, rider decides (free ride, max effort). */
  mode: 'erg' | 'free';
  powerStart: number;
  powerEnd: number;
  cadence?: CadenceTarget;
  kind: WorkoutStep['type'] | 'on' | 'off';
  label: string;
}

const STEP_LABEL: Record<WorkoutStep['type'], string> = {
  warmup: 'Aufwärmen',
  cooldown: 'Ausrollen',
  ramp: 'Rampe',
  steady: 'Konstant',
  intervals: 'Intervalle',
  freeride: 'Freie Fahrt',
  maxeffort: 'Vollgas',
};

/** Flattens steps (expanding intervals) into a timeline. */
export function buildTimeline(workout: Workout): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  let t = 0;
  const push = (seg: Omit<TimelineSegment, 'index' | 'startS'>) => {
    if (seg.durationS <= 0) return;
    out.push({ ...seg, index: out.length, startS: t });
    t += seg.durationS;
  };
  for (const step of workout.steps) {
    switch (step.type) {
      case 'warmup':
      case 'cooldown':
      case 'ramp':
        push({
          durationS: step.durationS,
          mode: 'erg',
          powerStart: step.powerStart,
          powerEnd: step.powerEnd,
          cadence: step.cadence,
          kind: step.type,
          label: step.label ?? STEP_LABEL[step.type],
        });
        break;
      case 'steady':
        push({
          durationS: step.durationS,
          mode: 'erg',
          powerStart: step.power,
          powerEnd: step.power,
          cadence: step.cadence,
          kind: 'steady',
          label: step.label ?? STEP_LABEL.steady,
        });
        break;
      case 'intervals':
        for (let r = 1; r <= step.repeat; r++) {
          push({
            durationS: step.on.durationS,
            mode: 'erg',
            powerStart: step.on.power,
            powerEnd: step.on.power,
            cadence: step.on.cadence,
            kind: 'on',
            label: `Intervall ${r}/${step.repeat}`,
          });
          push({
            durationS: step.off.durationS,
            mode: 'erg',
            powerStart: step.off.power,
            powerEnd: step.off.power,
            cadence: step.off.cadence,
            kind: 'off',
            label: `Pause ${r}/${step.repeat}`,
          });
        }
        break;
      case 'freeride':
        push({ durationS: step.durationS, mode: 'free', powerStart: 0, powerEnd: 0, cadence: step.cadence, kind: 'freeride', label: STEP_LABEL.freeride });
        break;
      case 'maxeffort':
        push({ durationS: step.durationS, mode: 'free', powerStart: 2, powerEnd: 2, kind: 'maxeffort', label: STEP_LABEL.maxeffort });
        break;
    }
  }
  return out;
}

export function totalDurationS(workout: Workout): number {
  return buildTimeline(workout).reduce((a, s) => a + s.durationS, 0);
}

/** Target power fraction at time `t` within a segment (linear ramps). */
export function segmentPowerAt(seg: TimelineSegment, t: number): number {
  const f = seg.durationS > 0 ? Math.min(1, Math.max(0, (t - seg.startS) / seg.durationS)) : 0;
  return seg.powerStart + (seg.powerEnd - seg.powerStart) * f;
}

export function findSegment(timeline: TimelineSegment[], t: number): TimelineSegment | undefined {
  for (const s of timeline) if (t >= s.startS && t < s.startS + s.durationS) return s;
  return undefined;
}

export interface WorkoutStats {
  durationS: number;
  /** Estimated values assuming the rider hits every target (free ride counted as 60 % FTP). */
  intensityFactor: number;
  tss: number;
  avgPower: number;
}

export function workoutStats(workout: Workout): WorkoutStats {
  const tl = buildTimeline(workout);
  const series: number[] = [];
  for (const seg of tl) {
    for (let s = 0; s < seg.durationS; s++) {
      const p = seg.mode === 'free' ? (seg.kind === 'maxeffort' ? 1.6 : 0.6) : segmentPowerAt(seg, seg.startS + s + 0.5);
      series.push(p);
    }
  }
  const np = normalizedPower(series);
  const durationS = series.length;
  return {
    durationS,
    intensityFactor: np,
    tss: ((durationS * np * np) / 3600) * 100,
    avgPower: series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0,
  };
}

export function cadenceRange(c: CadenceTarget | undefined): [number, number] | undefined {
  if (c === undefined) return undefined;
  return typeof c === 'number' ? [c - 5, c + 5] : c;
}

export function formatCadence(c: CadenceTarget | undefined): string {
  if (c === undefined) return '';
  return typeof c === 'number' ? `${c} rpm` : `${c[0]}–${c[1]} rpm`;
}
