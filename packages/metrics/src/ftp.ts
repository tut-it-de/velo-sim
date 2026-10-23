import { bestAverage } from './power';

/**
 * FTP estimate from ride data, without a test.
 *  - Single efforts of 8–60 min are scaled to an hour (Zwift: 8 min ≈ 90 %, 20 min ≈ 95 %, 60 min = 100 %).
 *  - Critical Power from the 3–20 min bests: work = CP · t + W′ (two-parameter model, Monod & Scherrer).
 * A clean CP fit wins (it uses the whole curve); a 20+ min effort can still beat it, as easy rides only ever
 * underestimate. Without a CP fit the best single effort counts.
 */

/** Durations (s) of the power curve stored with every ride. */
export const CURVE_DURATIONS = [5, 15, 30, 60, 120, 180, 300, 480, 600, 720, 900, 1200, 1800, 2700, 3600] as const;

/** Best average power for each of CURVE_DURATIONS (0 when the ride was shorter). */
export function powerCurve(power: ArrayLike<number>): number[] {
  return CURVE_DURATIONS.map((d) => Math.round(bestAverage(power, d)));
}

/** Curve from the three bests every older ride has (1, 5 and 20 min); the rest stays 0. */
export function sparseCurve(best1min: number, best5min: number, best20min: number): number[] {
  return CURVE_DURATIONS.map((d) => (d === 60 ? best1min : d === 300 ? best5min : d === 1200 ? best20min : 0));
}

/** Share of an effort of `durationS` (8–60 min) that is sustainable for an hour; log-interpolated. */
export function hourFactor(durationS: number): number {
  const t = Math.min(3600, Math.max(480, durationS));
  if (t <= 1200) return 0.9 + (0.05 * Math.log(t / 480)) / Math.log(1200 / 480);
  return 0.95 + (0.05 * Math.log(t / 1200)) / Math.log(3600 / 1200);
}

export interface CriticalPowerFit {
  cp: number;
  /** Anaerobic work capacity in joules. */
  wPrime: number;
  r2: number;
}

/** Linear regression of work over time; needs at least three efforts of different length. */
export function fitCriticalPower(points: Array<{ t: number; p: number }>): CriticalPowerFit | undefined {
  if (points.length < 3) return undefined;
  const xs = points.map((x) => x.t);
  const ys = points.map((x) => x.p * x.t);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return undefined;
  const cp = sxy / sxx;
  return { cp, wPrime: my - cp * mx, r2: (sxy * sxy) / (sxx * syy) };
}

/** What one stored ride contributes. */
export interface CurveRide {
  startTime: number;
  durationS: number;
  curve: number[];
}

export type EstimateConfidence = 'niedrig' | 'mittel' | 'hoch';

export interface FtpEstimate {
  ftp: number;
  confidence: EstimateConfidence;
  /** e.g. "aus 12 min mit 248 W" or "Critical Power aus 3–20 min". */
  basis: string;
  /** Rides in the window. */
  rides: number;
  /** Best power per duration over the window (for the chart). */
  curve: number[];
  /** When the deciding effort was ridden. */
  at: number;
}

export const ESTIMATE_WINDOW_DAYS = 42;
const DAY = 86_400_000;
const CP_DURATIONS = new Set([180, 300, 480, 600, 720, 900, 1200]);

const fmtMin = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

/** Estimate over the last 42 days, or undefined when there is no usable effort of at least 5 minutes. */
export function estimateFtp(rides: CurveRide[], now = Date.now()): FtpEstimate | undefined {
  const recent = rides.filter((r) => r.startTime >= now - ESTIMATE_WINDOW_DAYS * DAY && r.startTime <= now + DAY);
  if (!recent.length) return undefined;

  const curve = CURVE_DURATIONS.map(() => 0);
  const when = CURVE_DURATIONS.map(() => 0);
  for (const r of recent) {
    CURVE_DURATIONS.forEach((_, i) => {
      const p = r.curve[i] ?? 0;
      if (p > curve[i]!) {
        curve[i] = p;
        when[i] = r.startTime;
      }
    });
  }

  // a) the best single effort of 8–60 min
  let single: { ftp: number; d: number; p: number; at: number } | undefined;
  CURVE_DURATIONS.forEach((d, i) => {
    const p = curve[i]!;
    if (d < 480 || p <= 0) return;
    const ftp = p * hourFactor(d);
    if (!single || ftp > single.ftp) single = { ftp, d, p, at: when[i]! };
  });

  // b) Critical Power from 3–20 min, only when the fit is clean and W′ is plausible
  const pts = CURVE_DURATIONS.map((d, i) => ({ t: d as number, p: curve[i]! })).filter((x) => CP_DURATIONS.has(x.t) && x.p > 0);
  const fit = pts.some((x) => x.t >= 480) ? fitCriticalPower(pts) : undefined;
  const cpOk = !!fit && fit.r2 >= 0.995 && fit.wPrime >= 5000 && fit.wPrime <= 35000 && fit.cp > 0;

  const longRides = recent.filter((r) => r.durationS >= 1200).length;
  let ftp: number;
  let basis: string;
  let at: number;
  let confidence: EstimateConfidence;
  // With a clean CP fit the whole curve decides; only an effort of 20+ min (a reliable lower bound) can beat it.
  const long = single && single.d >= 1200 ? single : undefined;
  if (cpOk && (!long || fit!.cp >= long.ftp)) {
    ftp = fit!.cp;
    basis = `Critical Power aus deinen besten 3–20 min (W′ ${(fit!.wPrime / 1000).toFixed(1)} kJ)`;
    at = Math.max(...when.filter((_, i) => CP_DURATIONS.has(CURVE_DURATIONS[i]!)));
    confidence = 'hoch';
  } else if (single) {
    if (cpOk) single = long!;
    ftp = single.ftp;
    basis = `aus ${fmtMin(single.d)} mit Ø ${single.p} W (${Math.round(hourFactor(single.d) * 100)} %)`;
    at = single.at;
    confidence = single.d >= 1200 && longRides >= 2 ? 'hoch' : longRides >= 3 ? 'mittel' : 'niedrig';
  } else {
    // Only short efforts: 5 min × 85 % is a rough lower guess.
    const i5 = CURVE_DURATIONS.indexOf(300);
    if (!curve[i5]) return undefined;
    ftp = curve[i5]! * 0.85;
    basis = `grob aus 5 min mit Ø ${curve[i5]} W (85 %)`;
    at = when[i5]!;
    confidence = 'niedrig';
  }
  return { ftp: Math.round(ftp), confidence, basis, rides: recent.length, curve, at };
}
