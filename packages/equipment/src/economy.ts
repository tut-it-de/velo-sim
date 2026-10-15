/** Earning rules for "Watt-Taler" (working name). All numbers are tunable. */
export const ECONOMY = {
  coinsPerKj: 1,
  lapBonus: 50,
  firstLapOnRouteBonus: 500,
  personalBestBonus: 100,
  /** Share of the coins earned during a workout that is added when it is completed. */
  workoutCompletionBonus: 0.2,
} as const;

export type EarningReason = 'work' | 'lap' | 'first-lap' | 'pb' | 'workout';

export interface EarningLine {
  reason: EarningReason;
  label: string;
  amount: number;
}

export interface RideEarningsInput {
  kilojoules: number;
  /** kJ ridden while a workout was active. */
  workoutKilojoules: number;
  workoutCompleted: boolean;
  lapsCompleted: number;
  firstLapOnRoute: boolean;
  personalBests: number;
}

/** Itemised earnings for one ride. */
export function rideEarnings(i: RideEarningsInput): EarningLine[] {
  const lines: EarningLine[] = [];
  const work = Math.floor(i.kilojoules * ECONOMY.coinsPerKj);
  if (work > 0) lines.push({ reason: 'work', label: `${Math.round(i.kilojoules)} kJ Arbeit`, amount: work });
  if (i.lapsCompleted > 0) lines.push({ reason: 'lap', label: `${i.lapsCompleted} × Runde`, amount: i.lapsCompleted * ECONOMY.lapBonus });
  if (i.firstLapOnRoute && i.lapsCompleted > 0) lines.push({ reason: 'first-lap', label: 'Erste Runde auf dieser Strecke', amount: ECONOMY.firstLapOnRouteBonus });
  if (i.personalBests > 0) lines.push({ reason: 'pb', label: `${i.personalBests} × Bestzeit`, amount: i.personalBests * ECONOMY.personalBestBonus });
  if (i.workoutCompleted) {
    const bonus = Math.floor(i.workoutKilojoules * ECONOMY.coinsPerKj * ECONOMY.workoutCompletionBonus);
    if (bonus > 0) lines.push({ reason: 'workout', label: 'Workout geschafft (+20 %)', amount: bonus });
  }
  return lines;
}

export function total(lines: EarningLine[]): number {
  return lines.reduce((a, l) => a + l.amount, 0);
}

export function formatCoins(n: number): string {
  return Math.round(n).toLocaleString('de-DE');
}
