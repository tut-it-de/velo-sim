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
  | { type: 'freeride'; durationS: number; cadence?: CadenceTarget; label?: string }
  | { type: 'maxeffort'; durationS: number; label?: string };

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
  /** Special handling at the end (FTP estimate): step ramp or 20-minute test. */
  test?: 'ramp' | 'ftp20';
  /** 'watts' = step powers are absolute watts (e.g. Zwift-style ramp tests); default fraction of FTP. */
  powerUnit?: 'ftp' | 'watts';
  level?: WorkoutLevel;
}

export type WorkoutCategory =
  | 'test'
  | 'endurance'
  | 'tempo'
  | 'sweetspot'
  | 'threshold'
  | 'vo2max'
  | 'anaerobic'
  | 'sprint'
  | 'cadence'
  | 'recovery'
  | 'custom';

/** 1 = Einsteiger, 2 = Fortgeschritten, 3 = Profi. */
export type WorkoutLevel = 1 | 2 | 3;

export const LEVEL_LABEL: Record<WorkoutLevel, string> = { 1: 'Einsteiger', 2: 'Fortgeschritten', 3: 'Profi' };

export const CATEGORY_LABEL: Record<WorkoutCategory, string> = {
  test: 'Test',
  endurance: 'Grundlage',
  tempo: 'Tempo',
  sweetspot: 'Sweet Spot',
  threshold: 'Schwelle',
  vo2max: 'VO2max',
  anaerobic: 'Anaerob',
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

const scalePower = <T extends { power: number }>(p: T, ftp: number): T => ({ ...p, power: p.power / ftp });

/** Converts a workout with absolute watts into the usual FTP fractions for a rider; other workouts pass through. */
export function resolveWorkout(workout: Workout, ftp = 200): Workout {
  if (workout.powerUnit !== 'watts') return workout;
  const f = Math.max(1, ftp);
  const steps = workout.steps.map((s): WorkoutStep => {
    switch (s.type) {
      case 'warmup':
      case 'cooldown':
      case 'ramp':
        return { ...s, powerStart: s.powerStart / f, powerEnd: s.powerEnd / f };
      case 'steady':
        return scalePower(s, f);
      case 'intervals':
        return { ...s, on: scalePower(s.on, f), off: scalePower(s.off, f) };
      default:
        return s;
    }
  });
  const { powerUnit: _unit, ...rest } = workout;
  return { ...rest, steps };
}

/** Flattens steps (expanding intervals) into a timeline. `ftp` only matters for workouts in absolute watts. */
export function buildTimeline(input: Workout, ftp?: number): TimelineSegment[] {
  const workout = resolveWorkout(input, ftp);
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
        push({ durationS: step.durationS, mode: 'free', powerStart: 0, powerEnd: 0, cadence: step.cadence, kind: 'freeride', label: step.label ?? STEP_LABEL.freeride });
        break;
      case 'maxeffort':
        push({ durationS: step.durationS, mode: 'free', powerStart: 2, powerEnd: 2, kind: 'maxeffort', label: step.label ?? STEP_LABEL.maxeffort });
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

export function workoutStats(workout: Workout, ftp?: number): WorkoutStats {
  const tl = buildTimeline(workout, ftp);
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
