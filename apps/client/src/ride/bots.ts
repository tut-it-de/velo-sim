import { step, type RiderSetup } from '@velo/physics';
import type { Track } from '@velo/routes';
import type { RiderLook } from '../game/rider';

/**
 * The bots of a route: about 50 riders in packs and alone, from 1.6 to 4.6 W/kg.
 * Their positions follow from the route and the wall clock only, so every rider on the
 * route sees the same bots in the same places – online and offline, without a server.
 */
export const BOT_COUNT = 50;

export interface BotPlan {
  id: string;
  name: string;
  country: string;
  wkg: number;
  look: RiderLook;
  lateral: number;
  cadence: number;
  /** Start offset on the shared clock in seconds. */
  offsetS: number;
  /** Lap timetable of this bot's power class. */
  table: LapTable;
}

/** Time at every `stepM` metres of one lap for a steady power – the bots' position as a function of time. */
export interface LapTable {
  stepM: number;
  times: Float64Array;
  lapS: number;
}

const FIRST = ['Lena', 'Jonas', 'Mia', 'Paul', 'Emma', 'Luca', 'Sofia', 'Felix', 'Anna', 'Noah', 'Lea', 'Elias', 'Marie', 'Ben', 'Clara', 'Finn', 'Julia', 'Tom', 'Nina', 'Max', 'Sara', 'Leon', 'Ida', 'Jan', 'Eva', 'Tim', 'Mila', 'Nico', 'Lara', 'Moritz', 'Hanna', 'Jakob', 'Greta', 'Erik', 'Marta', 'Ole', 'Paula', 'Matteo', 'Ines', 'Theo'];
const LAST = 'ABCDEFGHJKLMNPRSTVWZ';
const COUNTRIES = ['DE', 'DE', 'DE', 'AT', 'CH', 'IT', 'FR', 'NL', 'BE', 'DK', 'ES', 'GB', 'PL', 'NO'];
const JERSEYS = ['#2e7dd7', '#2fa84f', '#d63a3a', '#f2c230', '#7b4fd6', '#1d1d1d', '#ffffff', '#ff7a1a', '#14a6a6', '#e0559a', '#3b4a6b', '#8fbf3a'];
const FRAMES = ['#e8e8e8', '#1d1d1d', '#c9a227', '#c62828', '#1565c0', '#2e2e2e', '#9e9e9e'];

/** Small deterministic random generator (mulberry32) – same route, same bots everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Rides one lap at a steady power (pushing a little harder uphill, like a real rider). */
export function lapTable(track: Track, setup: RiderSetup, powerW: number, stepM = 10): LapTable {
  const n = Math.ceil(track.length / stepM);
  const times = new Float64Array(n + 1);
  let state = { speedMps: 7, distanceM: 0 };
  let t = 0;
  let next = 1;
  const dt = 0.5;
  while (next <= n) {
    const g = track.sample(state.distanceM).gradePercent;
    const p = powerW * (1 + Math.max(-0.1, Math.min(0.15, g * 0.02)));
    const before = state.distanceM;
    state = step(state, p, setup, { gradePercent: g, draftReduction: 0 }, dt);
    t += dt;
    while (next <= n && state.distanceM >= next * stepM) {
      const f = (next * stepM - before) / Math.max(1e-6, state.distanceM - before);
      times[next] = t - dt + f * dt;
      next++;
    }
    if (t > 6 * 3600) break; // a wall the bot cannot climb: give up instead of looping forever
  }
  for (; next <= n; next++) times[next] = t + next;
  return { stepM, times, lapS: times[n]! };
}

/** Lap position (m) and speed (m/s) of a bot at `clockS` on the shared clock. */
export function botPosition(plan: BotPlan, clockS: number, trackLength: number): { lapM: number; speedMps: number } {
  const { times, stepM, lapS } = plan.table;
  const t = (((clockS + plan.offsetS) % lapS) + lapS) % lapS;
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi]! - times[lo]!;
  const f = span > 0 ? (t - times[lo]!) / span : 0;
  return { lapM: Math.min(trackLength - 0.01, (lo + f) * stepM), speedMps: span > 0 ? stepM / span : 0 };
}

/** The bots of a route: three named pacers (2.0 / 2.8 / 3.5 W/kg), packs of 4–8 and riders alone. */
export function planBots(track: Track, setup: RiderSetup): BotPlan[] {
  const rand = rng(hash(track.id));
  const tables = new Map<number, LapTable>();
  const tableFor = (wkg: number) => {
    let t = tables.get(wkg);
    if (!t) tables.set(wkg, (t = lapTable(track, { ...setup, riderMassKg: 75 }, wkg * 75)));
    return t;
  };
  const plans: BotPlan[] = [];
  const add = (name: string, wkg: number, offsetS: number) => {
    const i = plans.length;
    const jersey = JERSEYS[Math.floor(rand() * JERSEYS.length)]!;
    plans.push({
      id: `bot-${i}`,
      name,
      country: COUNTRIES[Math.floor(rand() * COUNTRIES.length)]!,
      wkg,
      look: { jersey, helmet: rand() < 0.5 ? jersey : '#f2f2f2', frame: FRAMES[Math.floor(rand() * FRAMES.length)]! },
      lateral: 0.4 + rand() * 2.6,
      cadence: 78 + Math.round(rand() * 18),
      offsetS,
      table: tableFor(wkg),
    });
  };
  const person = () => `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}.`;
  const spread = () => rand() * 100_000;

  add('Pacer Lena', 2.0, spread());
  add('Pacer Jonas', 2.8, spread());
  add('Pacer Mia', 3.5, spread());
  // Packs ride a few seconds apart at the same power, so they stay together on the climbs.
  for (const wkg of [2.2, 2.6, 3.0, 3.4, 3.9]) {
    if (plans.length >= BOT_COUNT) break;
    const size = 4 + Math.floor(rand() * 5);
    const at = spread();
    for (let k = 0; k < size && plans.length < BOT_COUNT; k++) add(person(), wkg, at + k * (0.6 + rand() * 0.9));
  }
  while (plans.length < BOT_COUNT) add(person(), Math.round((1.6 + rand() * 3) * 5) / 5, spread());
  return plans;
}
