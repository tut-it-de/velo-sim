/** Training metrics after Coggan. Inputs are 1 Hz power samples in watts. */

export function average(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]!;
  return sum / values.length;
}

/** Normalized Power: 30 s rolling average → 4th power → mean → 4th root. */
export function normalizedPower(power: ArrayLike<number>): number {
  const n = power.length;
  if (n === 0) return 0;
  if (n < 30) return average(power);
  let windowSum = 0;
  for (let i = 0; i < 30; i++) windowSum += power[i]!;
  let sum4 = (windowSum / 30) ** 4;
  let count = 1;
  for (let i = 30; i < n; i++) {
    windowSum += power[i]! - power[i - 30]!;
    sum4 += (windowSum / 30) ** 4;
    count++;
  }
  return (sum4 / count) ** 0.25;
}

export function intensityFactor(np: number, ftp: number): number {
  return ftp > 0 ? np / ftp : 0;
}

/** Training Stress Score: 100 = one hour at FTP. */
export function trainingStressScore(durationS: number, np: number, ftp: number): number {
  if (ftp <= 0) return 0;
  const ifactor = np / ftp;
  return ((durationS * np * ifactor) / (ftp * 3600)) * 100;
}

/** Mechanical work in kJ (1 Hz samples). */
export function kilojoules(power: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < power.length; i++) sum += Math.max(0, power[i]!);
  return sum / 1000;
}

/** Human efficiency is ~24 %, so kcal burnt ≈ kJ of mechanical work. */
export function estimateCalories(kj: number): number {
  return kj;
}

export function bestAverage(power: ArrayLike<number>, windowS: number): number {
  if (power.length < windowS || windowS <= 0) return 0;
  let sum = 0;
  for (let i = 0; i < windowS; i++) sum += power[i]!;
  let best = sum;
  for (let i = windowS; i < power.length; i++) {
    sum += power[i]! - power[i - windowS]!;
    if (sum > best) best = sum;
  }
  return best / windowS;
}

export interface PowerZone {
  zone: number;
  name: string;
  /** Upper bound as fraction of FTP (exclusive); Infinity for the last zone. */
  max: number;
  color: string;
}

/** Six training zones with the familiar indoor-cycling colour scheme. */
export const POWER_ZONES: PowerZone[] = [
  { zone: 1, name: 'Regeneration', max: 0.6, color: '#8b949e' },
  { zone: 2, name: 'Grundlage', max: 0.76, color: '#3b82f6' },
  { zone: 3, name: 'Tempo', max: 0.9, color: '#22c55e' },
  { zone: 4, name: 'Schwelle', max: 1.05, color: '#eab308' },
  { zone: 5, name: 'VO2max', max: 1.19, color: '#f97316' },
  { zone: 6, name: 'Anaerob', max: Infinity, color: '#ef4444' },
];

export function powerZone(power: number, ftp: number): PowerZone {
  const rel = ftp > 0 ? power / ftp : 0;
  return POWER_ZONES.find((z) => rel < z.max) ?? POWER_ZONES[POWER_ZONES.length - 1]!;
}

/** Seconds spent in each zone (index 0 = Z1). */
export function timeInZones(power: ArrayLike<number>, ftp: number): number[] {
  const out = POWER_ZONES.map(() => 0);
  for (let i = 0; i < power.length; i++) out[powerZone(power[i]!, ftp).zone - 1]! += 1;
  return out;
}
