/**
 * Monthly challenges and badges. Pure rules over the rider's rides, shared by the client (display)
 * and the server (which books the Watt-Taler from the synced rides, once per key).
 * Calendar months and weeks are counted in German time, so both sides agree on the boundaries.
 */

export interface AchievementRide {
  id: string;
  startTime: number;
  routeId: string;
  distanceM: number;
  durationS: number;
  ascentM: number;
  lapCount: number;
  /** Simulator or teleport: does not count. */
  simulated: boolean;
  ftpTest?: boolean;
  /** A new best time on a segment. */
  segmentPb?: boolean;
  groupRide?: boolean;
}

export type ChallengeMetric = 'distance' | 'ascent' | 'time' | 'rides';

export interface ChallengeTier {
  key: string;
  target: number;
  reward: number;
  done: boolean;
}

export interface Challenge {
  metric: ChallengeMetric;
  label: string;
  unit: string;
  value: number;
  tiers: ChallengeTier[];
}

export interface Badge {
  key: string;
  title: string;
  description: string;
  icon: string;
  reward: number;
  /** Start time of the ride that earned it. */
  earnedAt?: number;
  progress?: { value: number; target: number };
}

export interface Achievements {
  /** The month of `now`, e.g. "2026-10". */
  month: string;
  challenges: Challenge[];
  badges: Badge[];
  /** Everything earned so far (all months), key → { reward, label, ride start }. */
  earned: Map<string, { reward: number; label: string; at: number }>;
}

const TZ = 'Europe/Berlin';
export const TIER_NAMES = ['Bronze', 'Silber', 'Gold'] as const;

const CHALLENGES: Array<{ metric: ChallengeMetric; label: string; unit: string; targets: [number, number, number]; of: (r: AchievementRide) => number }> = [
  { metric: 'distance', label: 'Kilometer', unit: 'km', targets: [100, 300, 600], of: (r) => r.distanceM / 1000 },
  { metric: 'ascent', label: 'Höhenmeter', unit: 'hm', targets: [1000, 3000, 6000], of: (r) => r.ascentM },
  { metric: 'time', label: 'Stunden im Sattel', unit: 'h', targets: [5, 10, 20], of: (r) => r.durationS / 3600 },
  { metric: 'rides', label: 'Fahrten', unit: '', targets: [4, 8, 16], of: () => 1 },
];
const TIER_REWARDS = [250, 500, 1000];

/** The badge catalogue in display order (route badges are added per route). */
const BADGES = {
  'first-ride': { title: 'Erste Fahrt', description: 'Deine erste Fahrt auf Velo Sim.', icon: '🚲', reward: 100 },
  'km-100': { title: '100 km', description: 'Insgesamt 100 km gefahren.', icon: '🥉', reward: 200 },
  'km-1000': { title: '1.000 km', description: 'Insgesamt 1.000 km gefahren.', icon: '🥈', reward: 1000 },
  'km-10000': { title: '10.000 km', description: 'Insgesamt 10.000 km gefahren.', icon: '🥇', reward: 5000 },
  'alpe-21': { title: '21 Kehren', description: 'Alpe d’Huez einmal komplett hochgefahren.', icon: '⛰️', reward: 500 },
  'all-routes': { title: 'Alle Strecken', description: 'Jede Strecke mindestens einmal komplett gefahren.', icon: '🗺️', reward: 2000 },
  'ftp-test': { title: 'Erster FTP-Test', description: 'Einen FTP-Test zu Ende gefahren.', icon: '⚡', reward: 300 },
  'streak-4': { title: '4 Wochen am Stück', description: 'Vier Kalenderwochen hintereinander mindestens eine Fahrt.', icon: '🔥', reward: 500 },
  'group-ride': { title: 'Erste Gruppenfahrt', description: 'Mit anderen zusammen in einer Gruppe gefahren.', icon: '👥', reward: 200 },
  'segment-pb': { title: 'Segment-Bestzeit', description: 'Eine neue Bestzeit auf einem Segment.', icon: '⏱️', reward: 200 },
} as const;

/** Rides that cannot be real (more than 70 km/h on average, more than 24 h) are ignored. */
export function countsForAchievements(r: AchievementRide): boolean {
  if (r.simulated || !(r.distanceM > 0) || !(r.durationS > 0) || r.durationS > 86_400) return false;
  return r.distanceM / r.durationS <= 70 / 3.6;
}

const fmtParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar date in German time. */
function berlinDate(t: number): { y: number; m: number; d: number } {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

export function monthKey(t: number): string {
  const { y, m } = berlinDate(t);
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Number of the (Monday-based) week since 1970, in German time. */
function weekIndex(t: number): number {
  const { y, m, d } = berlinDate(t);
  const days = Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
  // 1970-01-01 was a Thursday: shift so that weeks start on Monday
  return Math.floor((days + 3) / 7);
}

/** Challenges of the month of `now`, the badges, and every key earned so far. */
export function evaluateAchievements(all: AchievementRide[], routeIds: string[], routeNames: Record<string, string>, now = Date.now()): Achievements {
  const rides = all.filter(countsForAchievements).sort((a, b) => a.startTime - b.startTime);
  const earned: Achievements['earned'] = new Map();
  const earn = (key: string, reward: number, label: string, at: number) => {
    if (!earned.has(key)) earned.set(key, { reward, label, at });
  };

  // monthly challenges: walk every month that has rides, so past months are booked too
  const month = monthKey(now);
  const sums = new Map<string, number[]>();
  for (const r of rides) {
    const mk = monthKey(r.startTime);
    const s = sums.get(mk) ?? CHALLENGES.map(() => 0);
    sums.set(mk, s);
    CHALLENGES.forEach((c, i) => {
      s[i]! += c.of(r);
      c.targets.forEach((target, t) => {
        if (s[i]! >= target) earn(`month:${mk}:${c.metric}:${t + 1}`, TIER_REWARDS[t]!, `Monatsziel ${mk}: ${fmtTarget(target, c.unit)} ${c.label} (${TIER_NAMES[t]})`, r.startTime);
      });
    });
  }
  const cur = sums.get(month) ?? CHALLENGES.map(() => 0);
  const challenges: Challenge[] = CHALLENGES.map((c, i) => ({
    metric: c.metric,
    label: c.label,
    unit: c.unit,
    value: cur[i]!,
    tiers: c.targets.map((target, t) => ({ key: `month:${month}:${c.metric}:${t + 1}`, target, reward: TIER_REWARDS[t]!, done: cur[i]! >= target })),
  }));

  // badges
  const badges: Badge[] = [];
  const badge = (key: keyof typeof BADGES, at: number | undefined, progress?: Badge['progress']) => {
    const b = BADGES[key];
    badges.push({ key, ...b, earnedAt: at, progress: at === undefined ? progress : undefined });
    if (at !== undefined) earn(`badge:${key}`, b.reward, `Abzeichen: ${b.title}`, at);
  };
  const first = <T>(pred: (r: AchievementRide) => T) => rides.find((r) => pred(r))?.startTime;

  badge('first-ride', rides[0]?.startTime, { value: 0, target: 1 });
  let km = 0;
  const kmAt: Record<number, number | undefined> = {};
  for (const r of rides) {
    km += r.distanceM / 1000;
    for (const t of [100, 1000, 10000]) if (kmAt[t] === undefined && km >= t) kmAt[t] = r.startTime;
  }
  badge('km-100', kmAt[100], { value: km, target: 100 });
  badge('km-1000', kmAt[1000], { value: km, target: 1000 });
  badge('km-10000', kmAt[10000], { value: km, target: 10000 });
  badge('alpe-21', first((r) => r.routeId === 'alpe-dhuez' && r.lapCount > 0));

  const routeDone = new Map<string, number>();
  for (const r of rides) if (r.lapCount > 0 && !routeDone.has(r.routeId)) routeDone.set(r.routeId, r.startTime);
  const doneRoutes = routeIds.filter((id) => routeDone.has(id));
  badge('all-routes', doneRoutes.length === routeIds.length && routeIds.length ? Math.max(...doneRoutes.map((id) => routeDone.get(id)!)) : undefined, { value: doneRoutes.length, target: routeIds.length });

  badge('ftp-test', first((r) => !!r.ftpTest));

  // four calendar weeks in a row with at least one ride
  let streakAt: number | undefined;
  let run = 0;
  let lastWeek = Number.NaN;
  for (const r of rides) {
    const w = weekIndex(r.startTime);
    if (w === lastWeek) continue;
    run = w === lastWeek + 1 ? run + 1 : 1;
    lastWeek = w;
    if (run >= 4 && streakAt === undefined) streakAt = r.startTime;
  }
  const currentRun = lastWeek >= weekIndex(now) - 1 ? run : 0;
  badge('streak-4', streakAt, { value: Math.min(4, currentRun), target: 4 });
  badge('group-ride', first((r) => !!r.groupRide));
  badge('segment-pb', first((r) => !!r.segmentPb));

  // one badge per route, without Taler (the first lap on a route is already rewarded per ride)
  for (const id of routeIds) {
    badges.push({ key: `route:${id}`, title: routeNames[id] ?? id, description: 'Einmal die ganze Strecke gefahren.', icon: '🏁', reward: 0, earnedAt: routeDone.get(id) });
  }

  return { month, challenges, badges, earned };
}

function fmtTarget(n: number, unit: string): string {
  return `${n.toLocaleString('de-DE')}${unit ? ` ${unit}` : ''}`;
}

/** A stored ride as the client keeps it and the server receives it (only the fields used here). */
export interface AchievementSource {
  id: string;
  startTime: number;
  routeId?: string;
  simulated?: boolean;
  summary?: { distanceM?: number; durationS?: number; ascentM?: number; lapCount?: number };
  segments?: Array<{ improved?: boolean }>;
  workout?: { test?: boolean };
  /** Set on rides in a group ride. */
  group?: unknown;
}

/** Same reading on the client and on the server; unknown or missing fields count as nothing. */
export function toAchievementRide(a: AchievementSource): AchievementRide {
  const s = a.summary ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    id: a.id,
    startTime: a.startTime,
    routeId: typeof a.routeId === 'string' ? a.routeId : '',
    distanceM: num(s.distanceM),
    durationS: num(s.durationS),
    ascentM: num(s.ascentM),
    lapCount: num(s.lapCount),
    simulated: a.simulated !== false,
    ftpTest: !!a.workout?.test,
    segmentPb: Array.isArray(a.segments) && a.segments.some((x) => !!x?.improved),
    groupRide: !!a.group,
  };
}
