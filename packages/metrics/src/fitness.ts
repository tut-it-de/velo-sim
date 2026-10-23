/**
 * Training load over time (Performance Manager, after Coggan/Banister):
 *  - Fitness (CTL) = exponentially weighted average of the daily TSS over ~42 days
 *  - Fatigue (ATL) = the same over ~7 days
 *  - Form (TSB)    = yesterday's fitness − yesterday's fatigue (how fresh you start into the day)
 * Days are local calendar days; days without a ride count as TSS 0.
 */

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;
const DAY = 86_400_000;

export interface LoadRide {
  startTime: number;
  tss: number;
}

export interface FitnessDay {
  /** Local midnight of the day. */
  day: number;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
}

/** Local midnight of the day `t` falls on. */
export function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Next local midnight (DST-safe: a day is 23–25 h). */
function nextDay(day: number): number {
  return dayStart(day + DAY * 1.5);
}

/**
 * One entry per day from the first ride (or `from`, if later only the window is returned) up to `until`.
 * The whole history is always accumulated, so the window starts with the right values.
 */
export function fitnessSeries(rides: LoadRide[], until = Date.now(), from?: number): FitnessDay[] {
  if (!rides.length) return [];
  const byDay = new Map<number, number>();
  for (const r of rides) {
    if (!(r.tss > 0)) continue;
    const d = dayStart(r.startTime);
    byDay.set(d, (byDay.get(d) ?? 0) + r.tss);
  }
  if (!byDay.size) return [];
  const kc = 1 - Math.exp(-1 / CTL_DAYS);
  const ka = 1 - Math.exp(-1 / ATL_DAYS);
  const end = dayStart(until);
  const out: FitnessDay[] = [];
  let ctl = 0;
  let atl = 0;
  for (let day = Math.min(...byDay.keys()); day <= end; day = nextDay(day)) {
    const tss = byDay.get(day) ?? 0;
    const tsb = ctl - atl;
    ctl += (tss - ctl) * kc;
    atl += (tss - atl) * ka;
    if (from === undefined || day >= dayStart(from)) out.push({ day, tss, ctl, atl, tsb });
  }
  return out;
}

export type FormState = 'erholt' | 'frisch' | 'neutral' | 'im Training' | 'ermüdet';

/** Rough reading of the form value (TrainingPeaks' zones, slightly simplified). */
export function formState(tsb: number): FormState {
  if (tsb > 25) return 'erholt';
  if (tsb > 5) return 'frisch';
  if (tsb > -10) return 'neutral';
  if (tsb > -30) return 'im Training';
  return 'ermüdet';
}

/** Change of fitness over the last 7 days – more than ~8 per week is a steep build-up. */
export function rampRate(series: FitnessDay[]): number {
  if (series.length < 2) return 0;
  const last = series[series.length - 1]!;
  const before = series[Math.max(0, series.length - 8)]!;
  return last.ctl - before.ctl;
}

/** TSS per calendar week (Monday start), the last `weeks` weeks up to `until`, oldest first. */
export function weeklyLoad(rides: LoadRide[], weeks: number, until = Date.now()): Array<{ week: number; tss: number }> {
  const monday = (t: number) => {
    const d = new Date(dayStart(t));
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  };
  const start: number[] = [];
  let w = monday(until);
  for (let i = 0; i < weeks; i++) {
    start.unshift(w);
    w = monday(w - DAY);
  }
  const out = start.map((week) => ({ week, tss: 0 }));
  for (const r of rides) {
    const i = start.indexOf(monday(r.startTime));
    if (i >= 0 && r.tss > 0) out[i]!.tss += r.tss;
  }
  return out;
}
