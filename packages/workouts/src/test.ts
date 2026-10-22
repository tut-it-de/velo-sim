import type { TimelineSegment, Workout } from './model';

/** Ramp steps are labelled "Stufe …", the 20-minute block "Testblock …" (see library.ts). */
export const isRampStep = (seg: TimelineSegment) => seg.label.startsWith('Stufe');
export const isTestBlock = (seg: TimelineSegment) => seg.label.startsWith('Testblock');

/** What the rider did in a test, collected by the WorkoutPlayer. */
export interface TestProgress {
  /** Seconds ridden in ramp steps. */
  rampS: number;
  /** The rider finished the last ramp step — the test was too easy to find the limit. */
  rampTopReached: boolean;
  topStepWatts?: number;
  /** Seconds ridden in the 20-minute block and the average power there. */
  blockS: number;
  blockAvgPower: number;
  blockPlannedS: number;
}

export type TestConfidence = 'hoch' | 'mittel' | 'schätzung';

export interface TestResult {
  kind: 'ramp' | 'ftp20';
  /** Undefined when the test was stopped too early for a sensible estimate. */
  ftp?: number;
  /** How the number came about, e.g. "75 % der besten Minute (312 W)". */
  basis: string;
  confidence?: TestConfidence;
  notes: string[];
}

/** Minimum ramp time before the best minute says anything about the rider. */
export const MIN_RAMP_S = 180;
/** Below ~12 minutes a single effort is too anaerobic to estimate FTP (it overestimates). */
export const MIN_BLOCK_S = 12 * 60;

/** FTP estimate from a ramp test: 75 % of the best one-minute power (Zwift / TrainerRoad). */
export function ftpFromRampTest(best1minPower: number): number {
  return Math.round(best1minPower * 0.75);
}

/**
 * Share of an all-out effort of `durationS` that is sustainable for an hour:
 * 95 % for 20 minutes (Coggan), 90 % for 8 minutes, log-interpolated in between.
 */
export function ftpFactorForDuration(durationS: number): number {
  const t = Math.min(1200, Math.max(480, durationS));
  return 0.9 + (0.05 * Math.log(t / 480)) / Math.log(1200 / 480);
}

/** Evaluates a test ride — also when it was stopped early. Returns undefined for workouts that are not tests. */
export function evaluateTest(workout: Workout, progress: TestProgress, best1minPower: number): TestResult | undefined {
  if (workout.test === 'ramp') {
    if (progress.rampS < MIN_RAMP_S || best1minPower <= 0) {
      return {
        kind: 'ramp',
        basis: `Nur ${Math.floor(progress.rampS / 60)} min der Rampe gefahren`,
        notes: ['Für eine Auswertung brauchst du mindestens 3 Minuten auf der Rampe. Fahr den Test bis zur Erschöpfung – oder probier den Rampentest Lite.'],
      };
    }
    const notes = ['Der Rampentest überschätzt Sprinter und unterschätzt Ausdauertypen leicht. Ein 20-Minuten-Test ist genauer.'];
    if (progress.rampTopReached) {
      notes.unshift(
        `Du hast die letzte Stufe (${progress.topStepWatts ?? '?'} W) geschafft – deine FTP liegt wahrscheinlich höher. Nimm beim nächsten Mal den stärkeren Rampentest.`,
      );
    }
    return {
      kind: 'ramp',
      ftp: ftpFromRampTest(best1minPower),
      basis: `75 % der besten Minute (${Math.round(best1minPower)} W)`,
      confidence: progress.rampTopReached ? 'schätzung' : 'mittel',
      notes,
    };
  }

  if (workout.test === 'ftp20') {
    const full = progress.blockS >= Math.min(1200, progress.blockPlannedS) - 10;
    const minutes = Math.floor(progress.blockS / 60);
    if (progress.blockS < MIN_BLOCK_S || progress.blockAvgPower <= 0) {
      return {
        kind: 'ftp20',
        basis: progress.blockS > 0 ? `Testblock nach ${minutes} min beendet` : 'Testblock nicht erreicht',
        notes: [
          'Unter 12 Minuten lässt sich die FTP nicht seriös schätzen – kurze Belastungen sind zu anaerob.',
          'Tipp: Starte den Testblock etwas defensiver (ca. 2–3 % unter deinem Ziel) und steigere erst in den letzten 5 Minuten. Oder nimm den Rampentest.',
        ],
      };
    }
    const factor = full ? 0.95 : ftpFactorForDuration(progress.blockS);
    return {
      kind: 'ftp20',
      ftp: Math.round(progress.blockAvgPower * factor),
      basis: `${Math.round(factor * 100)} % von Ø ${Math.round(progress.blockAvgPower)} W über ${full ? '20' : minutes} min`,
      confidence: full ? 'hoch' : 'schätzung',
      notes: full
        ? ['Der 20-Minuten-Test ist der verlässlichste FTP-Test – vorausgesetzt, du bist gleichmäßig und am Limit gefahren.']
        : [`Der Testblock wurde nach ${minutes} min beendet – die FTP ist aus der Dauer hochgerechnet und nur eine Schätzung.`],
    };
  }
  return undefined;
}

/** Coggan's seven power zones as fractions of FTP (upper bound inclusive; Infinity for Z7). */
export const FTP_ZONES = [
  { zone: 1, name: 'Aktive Erholung', max: 0.55 },
  { zone: 2, name: 'Grundlage', max: 0.75 },
  { zone: 3, name: 'Tempo', max: 0.9 },
  { zone: 4, name: 'Schwelle', max: 1.05 },
  { zone: 5, name: 'VO2max', max: 1.2 },
  { zone: 6, name: 'Anaerob', max: 1.5 },
  { zone: 7, name: 'Neuromuskulär', max: Infinity },
] as const;

/** Watt ranges of the seven zones for a given FTP, e.g. Z2 = 141–188 W at 250 W. */
export function zoneWatts(ftp: number): Array<{ zone: number; name: string; from: number; to?: number }> {
  return FTP_ZONES.map((z, i) => ({
    zone: z.zone,
    name: z.name,
    from: i === 0 ? 0 : Math.round(FTP_ZONES[i - 1]!.max * ftp) + 1,
    to: Number.isFinite(z.max) ? Math.round(z.max * ftp) : undefined,
  }));
}
