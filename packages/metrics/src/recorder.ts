import { average, bestAverage, estimateCalories, intensityFactor, kilojoules, normalizedPower, trainingStressScore } from './power';

/** One sample per second of moving time. */
export interface ActivitySample {
  /** ms since epoch */
  timestamp: number;
  distanceM: number;
  speedMps: number;
  elevationM: number;
  gradePercent: number;
  power: number;
  cadence?: number;
  heartRate?: number;
}

export interface LapSummary {
  index: number;
  startTime: number;
  endTime: number;
  /** Timer time in s (excludes pauses). */
  durationS: number;
  distanceM: number;
  avgPower: number;
  maxPower: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  avgCadence?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  ascentM: number;
}

export interface ActivitySummary extends Omit<LapSummary, 'index'> {
  elapsedS: number;
  normalizedPower: number;
  intensityFactor: number;
  tss: number;
  kilojoules: number;
  calories: number;
  ftp: number;
  best5s: number;
  best1min: number;
  best5min: number;
  best20min: number;
  laps: LapSummary[];
}

function max(values: number[]): number {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return m;
}

function summarize(samples: ActivitySample[]): Omit<LapSummary, 'index' | 'startTime' | 'endTime'> {
  const power = samples.map((s) => s.power);
  const cad = samples.map((s) => s.cadence).filter((c): c is number => c !== undefined && c > 0);
  const hr = samples.map((s) => s.heartRate).filter((h): h is number => h !== undefined && h > 0);
  let ascent = 0;
  for (let i = 1; i < samples.length; i++) {
    const dy = samples[i]!.elevationM - samples[i - 1]!.elevationM;
    if (dy > 0) ascent += dy;
  }
  const distanceM = samples.length ? samples.at(-1)!.distanceM - samples[0]!.distanceM : 0;
  return {
    durationS: samples.length,
    distanceM,
    avgPower: average(power),
    maxPower: max(power),
    avgSpeedMps: samples.length ? distanceM / samples.length : 0,
    maxSpeedMps: max(samples.map((s) => s.speedMps)),
    avgCadence: cad.length ? average(cad) : undefined,
    avgHeartRate: hr.length ? average(hr) : undefined,
    maxHeartRate: hr.length ? max(hr) : undefined,
    ascentM: ascent,
  };
}

/**
 * Collects 1 Hz samples during a ride and produces lap and activity summaries.
 * Feed it with `record()` once per second of moving time; call `lap()` when
 * the rider crosses the finish line.
 */
export class ActivityRecorder {
  readonly samples: ActivitySample[] = [];
  private lapStarts: number[] = [0];
  readonly startedAt: number;

  constructor(
    readonly ftp: number,
    startedAt = Date.now(),
  ) {
    this.startedAt = startedAt;
  }

  record(sample: ActivitySample): void {
    this.samples.push(sample);
  }

  /** Closes the current lap at the latest sample. */
  lap(): void {
    if (this.samples.length > (this.lapStarts.at(-1) ?? 0)) this.lapStarts.push(this.samples.length);
  }

  get lapCount(): number {
    return this.lapStarts.length;
  }

  laps(): LapSummary[] {
    const out: LapSummary[] = [];
    for (let i = 0; i < this.lapStarts.length; i++) {
      const from = this.lapStarts[i]!;
      const to = this.lapStarts[i + 1] ?? this.samples.length;
      // A lap shares its first sample with the end of the previous one so distances add up.
      const slice = this.samples.slice(Math.max(0, from - 1), to);
      if (to <= from) continue;
      // Rides start at distance 0, so the first lap is measured from 0 as well.
      const startDistance = from > 0 ? this.samples[from - 1]!.distanceM : 0;
      out.push({
        index: out.length,
        startTime: this.samples[from]!.timestamp,
        endTime: this.samples[to - 1]!.timestamp,
        ...summarize(slice),
        distanceM: this.samples[to - 1]!.distanceM - startDistance,
        durationS: to - from,
      });
    }
    return out;
  }

  summary(endTime = Date.now()): ActivitySummary {
    const base = summarize(this.samples);
    const power = this.samples.map((s) => s.power);
    const np = normalizedPower(power);
    const kj = kilojoules(power);
    const first = this.samples[0];
    const startTime = first?.timestamp ?? this.startedAt;
    const last = this.samples.at(-1);
    return {
      ...base,
      distanceM: last ? last.distanceM : 0,
      avgSpeedMps: last && this.samples.length ? last.distanceM / this.samples.length : 0,
      startTime,
      endTime: last?.timestamp ?? endTime,
      elapsedS: Math.max(this.samples.length, Math.round(((last?.timestamp ?? endTime) - startTime) / 1000) + 1),
      normalizedPower: np,
      intensityFactor: intensityFactor(np, this.ftp),
      tss: trainingStressScore(this.samples.length, np, this.ftp),
      kilojoules: kj,
      calories: estimateCalories(kj),
      ftp: this.ftp,
      best5s: bestAverage(power, 5),
      best1min: bestAverage(power, 60),
      best5min: bestAverage(power, 300),
      best20min: bestAverage(power, 1200),
      laps: this.laps(),
    };
  }
}
