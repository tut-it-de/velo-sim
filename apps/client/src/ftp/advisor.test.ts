import { describe, expect, it } from 'vitest';
import type { FtpEstimate } from '@velo/metrics';
import { adviseFtp, EMPTY_FTP_STATE, referenceFtp, type FtpState, type WorkoutFeedback } from './advisor';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20);
const est = (ftp: number, confidence: FtpEstimate['confidence'] = 'mittel', rides = 4): FtpEstimate => ({ ftp, confidence, basis: 'test', rides, curve: [], at: NOW - DAY });
const known = (p: Partial<FtpState> = {}): FtpState => ({ ...EMPTY_FTP_STATE, source: 'test', since: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY, levelAsked: true, ...p });
const fb = (rating: WorkoutFeedback['rating'], daysAgo: number, completed = true): WorkoutFeedback => ({ at: NOW - daysAgo * DAY, workoutId: 'w', name: 'W', hard: true, completed, rating });

describe('FTP advice', () => {
  it('takes over an estimate automatically while the FTP is unknown or only self-assessed', () => {
    expect(adviseFtp(EMPTY_FTP_STATE, 0, est(214), NOW)).toMatchObject({ kind: 'auto', ftp: 214 });
    expect(adviseFtp({ ...EMPTY_FTP_STATE, source: 'provisional' }, 190, est(214), NOW)).toMatchObject({ kind: 'auto', ftp: 214 });
    // a rough guess from short efforts is not enough
    expect(adviseFtp(EMPTY_FTP_STATE, 0, est(214, 'niedrig'), NOW)).toBeUndefined();
  });

  it('suggests a clearly higher FTP, but not a tiny one', () => {
    expect(adviseFtp(known(), 230, est(240), NOW)).toMatchObject({ kind: 'increase', ftp: 240 });
    expect(adviseFtp(known(), 230, est(232), NOW)).toBeUndefined();
  });

  it('stays quiet for 14 days after "no", unless the estimate rises further', () => {
    const s = known({ dismissedAt: NOW - 2 * DAY, dismissedFtp: 240 });
    expect(adviseFtp(s, 230, est(240), NOW)).toBeUndefined();
    expect(adviseFtp(s, 230, est(250), NOW)).toMatchObject({ kind: 'increase', ftp: 250 });
  });

  it('suggests a lower FTP only after 6 weeks and 6 rides, and reminds to test', () => {
    expect(adviseFtp(known(), 250, est(220, 'mittel', 8), NOW)).toBeUndefined();
    const old = known({ since: NOW - 50 * DAY });
    expect(adviseFtp(old, 250, est(220, 'mittel', 8), NOW)).toMatchObject({ kind: 'decrease', ftp: 220 });
    expect(adviseFtp(old, 250, est(245, 'mittel', 8), NOW)).toMatchObject({ kind: 'reminder' });
  });

  it('reads two easy or two too-hard workouts in a row', () => {
    expect(adviseFtp(known({ feedback: [fb('leicht', 3), fb('leicht', 1)] }), 250, undefined, NOW)).toMatchObject({ kind: 'feedback-up', ftp: 258 });
    expect(adviseFtp(known({ feedback: [fb('zu hart', 3), fb('passend', 1, false)] }), 250, undefined, NOW)).toMatchObject({ kind: 'feedback-down', ftp: 243 });
    expect(adviseFtp(known({ feedback: [fb('leicht', 3), fb('passend', 1)] }), 250, undefined, NOW)).toBeUndefined();
    // feedback from before the current FTP does not count
    expect(adviseFtp(known({ feedback: [fb('leicht', 30), fb('leicht', 20)] }), 250, undefined, NOW)).toBeUndefined();
  });

  it('scales charts with 2.5 W/kg while the FTP is unknown', () => {
    expect(referenceFtp({ ftp: 0, weightKg: 80 })).toBe(200);
    expect(referenceFtp({ ftp: 260, weightKg: 80 })).toBe(260);
  });
});
