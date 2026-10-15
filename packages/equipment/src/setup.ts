import { DEFAULT_CRR, baseCdA, steadySpeed, type RiderSetup } from '@velo/physics';
import type { Track } from '@velo/routes';
import { BIKES, CATALOG, JERSEYS, WHEELS, getItem, type BikeItem, type EquipmentItem, type JerseyItem, type WheelsItem } from './catalog';

export interface Loadout {
  bike: string;
  wheels: string;
  jersey: string;
}

export interface RiderBody {
  weightKg: number;
  heightCm: number;
}

export function resolveLoadout(l: Loadout): { bike: BikeItem; wheels: WheelsItem; jersey: JerseyItem } {
  const bike = getItem(l.bike);
  const wheels = getItem(l.wheels);
  const jersey = getItem(l.jersey);
  return {
    bike: bike?.type === 'bike' ? bike : BIKES.find((b) => b.tier === 'start')!,
    wheels: wheels?.type === 'wheels' ? wheels : WHEELS.find((w) => w.tier === 'start')!,
    jersey: jersey?.type === 'jersey' ? jersey : JERSEYS.find((j) => j.tier === 'start')!,
  };
}

/** Physics parameters for a rider on the given equipment. */
export function setupFor(body: RiderBody, loadout: Loadout): RiderSetup {
  const { bike, wheels, jersey } = resolveLoadout(loadout);
  return {
    riderMassKg: body.weightKg,
    bikeMassKg: bike.weightKg,
    wheelsMassKg: wheels.weightKg,
    cda: baseCdA(body.heightCm, body.weightKg) + bike.cdaDelta + wheels.cdaDelta + jersey.cdaDelta,
    crr: DEFAULT_CRR,
  };
}

/** Rounds to half stars between 1 and 5. */
function stars(value: number, best: number, worst: number): number {
  if (best === worst) return 3;
  const t = (worst - value) / (worst - best);
  return Math.round((1 + 4 * Math.min(1, Math.max(0, t))) * 2) / 2;
}

/** Aero rating 1–5 relative to all items of the same type. */
export function aeroStars(item: EquipmentItem): number {
  const same = CATALOG.filter((i) => i.type === item.type).map((i) => i.cdaDelta);
  return stars(item.cdaDelta, Math.min(...same), Math.max(...same));
}

/** Weight rating 1–5 relative to the same type (jerseys have none). */
export function weightStars(item: EquipmentItem): number | undefined {
  if (item.type === 'jersey') return undefined;
  const same = CATALOG.filter((i): i is BikeItem | WheelsItem => i.type === item.type).map((i) => i.weightKg);
  return stars(item.weightKg, Math.min(...same), Math.max(...same));
}

/**
 * Time to ride [fromM, toM) of a track at constant power, from steady-state
 * speeds every 20 m (ignores acceleration — fine for comparing equipment).
 */
export function estimateTime(track: Track, setup: RiderSetup, powerW: number, fromM = 0, toM = track.length): number {
  const step = 20;
  let t = 0;
  for (let d = fromM; d < toM; d += step) {
    const len = Math.min(step, toM - d);
    const g = track.sample(d + len / 2).gradePercent;
    // Riders do not pedal flat out on steep descents; cap at a realistic coasting speed floor.
    const v = Math.max(1.5, steadySpeed(powerW, setup, { gradePercent: g }));
    t += len / v;
  }
  return t;
}

export interface Comparison {
  trackId: string;
  trackName: string;
  currentS: number;
  candidateS: number;
  deltaS: number;
}

export function compareLoadouts(tracks: Track[], body: RiderBody, current: Loadout, candidate: Loadout, powerW: number): Comparison[] {
  const a = setupFor(body, current);
  const b = setupFor(body, candidate);
  return tracks.map((t) => {
    const currentS = estimateTime(t, a, powerW);
    const candidateS = estimateTime(t, b, powerW);
    return { trackId: t.id, trackName: t.name, currentS, candidateS, deltaS: candidateS - currentS };
  });
}
