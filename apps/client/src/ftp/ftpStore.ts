import { estimateFtp, sparseCurve, type CurveRide, type FtpEstimate } from '@velo/metrics';
import { activitiesStore, type StoredActivity } from '../state/activities';
import { settingsStore, updateSettings } from '../state/settings';
import { Store, saveJson } from '../state/store';
import { adviseFtp, EMPTY_FTP_STATE, type FtpAdvice, type FtpSource, type FtpState, type WorkoutFeedback } from './advisor';

const KEY = 'velo.ftp.v1';
const HISTORY_MAX = 60;

/**
 * Where the FTP comes from, its history and the rider's workout feedback. The FTP value itself stays in
 * settings.ftp (0 = unknown), so workouts, zones and TSS keep reading it from there.
 */
function load(): FtpState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...EMPTY_FTP_STATE, ...JSON.parse(raw) };
  } catch {
    // fall through to the migration
  }
  // First start with FTP bookkeeping: the old default of 200 W was never measured – drop it.
  const ftp = settingsStore.get().ftp;
  if (!ftp || ftp === 200) {
    if (ftp) updateSettings({ ftp: 0 });
    return { ...EMPTY_FTP_STATE };
  }
  const now = Date.now();
  return { ...EMPTY_FTP_STATE, source: 'manual', since: now, updatedAt: now, levelAsked: true, history: [{ ftp, source: 'manual', at: now }] };
}

export const ftpStore = new Store<FtpState>(load());
ftpStore.subscribe(() => saveJson(KEY, ftpStore.get()));
saveJson(KEY, ftpStore.get()); // keep the migration result, so it runs only once

const listeners = new Set<() => void>();
/** Called after every local change (the account sync pushes it to the server). */
export function onFtpChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function patch(p: Partial<FtpState>): void {
  ftpStore.set((s) => ({ ...s, ...p, updatedAt: Date.now() }));
  for (const l of listeners) l();
}

export function hasFtp(): boolean {
  return settingsStore.get().ftp > 0;
}

export function setFtp(ftp: number, source: FtpSource, note?: string): void {
  const value = Math.round(ftp);
  const now = Date.now();
  updateSettings({ ftp: value });
  const s = ftpStore.get();
  const history = [...s.history, { ftp: value, source, at: now, note }].slice(-HISTORY_MAX);
  patch({ source: value > 0 ? source : 'unknown', since: now, note, history, levelAsked: true, dismissedAt: undefined, dismissedFtp: undefined, suggestedAt: now });
}

/** The rider skipped the first question – ask again only from the workout list. */
export function skipLevelQuestion(): void {
  patch({ levelAsked: true });
}

export function dismissAdvice(advice: FtpAdvice): void {
  const now = Date.now();
  if (advice.kind === 'reminder') patch({ reminderAt: now, suggestedAt: now });
  else patch({ dismissedAt: now, dismissedFtp: 'ftp' in advice ? advice.ftp : undefined, suggestedAt: now });
}

export function addWorkoutFeedback(f: WorkoutFeedback): void {
  patch({ feedback: [...ftpStore.get().feedback.filter((x) => x.at !== f.at), f].slice(-20) });
}

/** Server copy is newer (other device): take it over. */
export function applyRemoteFtp(remote: { ftp: number; state: FtpState }): void {
  if (remote.state.updatedAt <= ftpStore.get().updatedAt) return;
  updateSettings({ ftp: remote.ftp });
  ftpStore.set({ ...EMPTY_FTP_STATE, ...remote.state });
}

/** Every real ride with power (no simulator, no teleport); older rides only have 1/5/20 min. */
export function curveRides(all: StoredActivity[] = activitiesStore.get()): CurveRide[] {
  return all
    .filter((a) => !a.simulated && a.summary.avgPower > 0)
    .map((a) => ({
      startTime: a.startTime,
      durationS: a.summary.durationS,
      curve: a.curve ?? sparseCurve(a.summary.best1min, a.summary.best5min, a.summary.best20min),
    }));
}

export function currentEstimate(now = Date.now()): FtpEstimate | undefined {
  return estimateFtp(curveRides(), now);
}

export function currentAdvice(now = Date.now()): FtpAdvice | undefined {
  return adviseFtp(ftpStore.get(), settingsStore.get().ftp, currentEstimate(now), now);
}

/**
 * After a ride: a new estimate is taken over right away while the FTP is unknown or only a guess;
 * everything else is returned for the ride summary to ask about.
 */
export function adviceAfterRide(): FtpAdvice | undefined {
  const advice = currentAdvice();
  if (advice?.kind === 'auto') setFtp(advice.ftp, 'estimate', advice.estimate.basis);
  return advice;
}
