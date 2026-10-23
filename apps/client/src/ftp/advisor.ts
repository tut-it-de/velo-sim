import type { FtpEstimate } from '@velo/metrics';

/** Where the current FTP comes from. */
export type FtpSource = 'unknown' | 'provisional' | 'estimate' | 'test' | 'manual';

export const SOURCE_LABEL: Record<FtpSource, string> = {
  unknown: 'noch nicht bestimmt',
  provisional: 'vorläufig (Selbsteinschätzung)',
  estimate: 'aus deinen Fahrten geschätzt',
  test: 'aus einem FTP-Test',
  manual: 'von dir eingetragen',
};

export interface FtpEntry {
  ftp: number;
  source: FtpSource;
  at: number;
  note?: string;
}

export type WorkoutRating = 'leicht' | 'passend' | 'hart' | 'zu hart';

export interface WorkoutFeedback {
  at: number;
  workoutId: string;
  name: string;
  /** Sweet spot, threshold or VO2max – the workouts that tell something about the FTP. */
  hard: boolean;
  completed: boolean;
  rating: WorkoutRating;
}

export interface FtpState {
  source: FtpSource;
  /** Last change of the FTP or its bookkeeping – the newer side wins when syncing with the server. */
  updatedAt: number;
  /** When the current FTP was set. */
  since: number;
  note?: string;
  /** W/kg of the self-assessed level – a provisional FTP follows weight changes. */
  wkg?: number;
  history: FtpEntry[];
  /** The "how fit are you?" question was answered or skipped. */
  levelAsked: boolean;
  /** Last suggestion the rider turned down, and its value. */
  dismissedAt?: number;
  dismissedFtp?: number;
  /** Last time any suggestion was shown (at most one per week). */
  suggestedAt?: number;
  /** "Check your FTP" reminder dismissed. */
  reminderAt?: number;
  feedback: WorkoutFeedback[];
}

export const EMPTY_FTP_STATE: FtpState = { source: 'unknown', updatedAt: 0, since: 0, history: [], levelAsked: false, feedback: [] };

export type FtpAdvice =
  /** No FTP yet (or only a guess): the estimate is taken over right away. */
  | { kind: 'auto'; ftp: number; estimate: FtpEstimate }
  | { kind: 'increase'; ftp: number; estimate: FtpEstimate }
  | { kind: 'decrease'; ftp: number; estimate: FtpEstimate }
  /** Two hard workouts in a row felt easy. */
  | { kind: 'feedback-up'; ftp: number }
  /** Two hard workouts in a row were too hard or broken off. */
  | { kind: 'feedback-down'; ftp: number }
  /** The FTP is old – check it. */
  | { kind: 'reminder'; estimate?: FtpEstimate };

const DAY = 86_400_000;
/** Self-assessed levels for the first question, in W/kg. */
export const LEVELS = [
  { id: 'beginner', label: 'Einsteiger', hint: 'fahre selten oder fange gerade an', wkg: 2.0 },
  { id: 'hobby', label: 'Hobby', hint: '1–2× pro Woche, gemütlich', wkg: 2.5 },
  { id: 'ambitious', label: 'Ambitioniert', hint: '2–4× pro Woche, auch mal hart', wkg: 3.0 },
  { id: 'sporty', label: 'Sportlich', hint: 'Training mit Plan, Rennen', wkg: 3.5 },
] as const;

/** Round to 1 W; a change smaller than 2 % or 3 W is not worth a suggestion. */
const meaningful = (from: number, to: number) => Math.abs(to - from) >= Math.max(3, from * 0.02);

/**
 * What to tell the rider about the FTP after a ride (or on the settings page).
 *  - unknown / only self-assessed: take over an estimate of at least medium confidence automatically
 *  - higher estimate: suggest right after the ride (after "no" 14 days of quiet unless it rises further)
 *  - lower estimate: only after 6 weeks with the same FTP and 6+ rides, never automatically
 *  - workout feedback: two "easy" hard workouts → +3 %, two "too hard"/broken off → −3 %
 *  - FTP older than 6 weeks: a reminder to check it (decrease and reminder at most once a week)
 */
export function adviseFtp(state: FtpState, ftp: number, estimate: FtpEstimate | undefined, now = Date.now()): FtpAdvice | undefined {
  const known = ftp > 0 && state.source !== 'unknown' && state.source !== 'provisional';
  if (!known) {
    if (estimate && estimate.confidence !== 'niedrig' && (ftp <= 0 || meaningful(ftp, estimate.ftp))) return { kind: 'auto', ftp: estimate.ftp, estimate };
    return undefined;
  }

  const quietUntil = (state.suggestedAt ?? 0) + 7 * DAY;
  const recentlyDismissed = state.dismissedAt !== undefined && now - state.dismissedAt < 14 * DAY;
  const age = now - state.since;

  if (estimate && estimate.ftp > ftp && meaningful(ftp, estimate.ftp)) {
    // After a "no", only a clearly higher value comes back within 14 days.
    const beatsDismissed = state.dismissedFtp !== undefined && estimate.ftp > state.dismissedFtp && meaningful(state.dismissedFtp, estimate.ftp);
    if (!recentlyDismissed || beatsDismissed) return { kind: 'increase', ftp: estimate.ftp, estimate };
  }

  const hard = state.feedback.filter((f) => f.hard && f.at > state.since).slice(-2);
  if (hard.length === 2 && !recentlyDismissed) {
    if (hard.every((f) => f.rating === 'leicht' && f.completed)) return { kind: 'feedback-up', ftp: Math.round(ftp * 1.03) };
    if (hard.every((f) => f.rating === 'zu hart' || !f.completed)) return { kind: 'feedback-down', ftp: Math.round(ftp * 0.97) };
  }

  if (now < quietUntil || recentlyDismissed) return undefined;
  if (age > 42 * DAY && estimate && estimate.rides >= 6 && estimate.ftp < ftp * 0.95) return { kind: 'decrease', ftp: estimate.ftp, estimate };
  if (age > 42 * DAY && (state.reminderAt === undefined || now - state.reminderAt > 42 * DAY)) return { kind: 'reminder', estimate };
  return undefined;
}

/**
 * FTP to scale charts, route times and absolute-watt workouts with while the real one is unknown
 * (2.5 W/kg). Never stored and never used for TSS or as a workout target in % of FTP.
 */
export function referenceFtp(s: { ftp: number; weightKg: number }): number {
  return s.ftp > 0 ? s.ftp : Math.round(s.weightKg * 2.5);
}
