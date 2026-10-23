import { intensityFactor, powerZone, trainingStressScore } from '@velo/metrics';
import { gradeColor } from '../ui/ClimbPanel';
import { formatDuration as formatClock } from '../ui/components';
import type { RideSnapshot } from './rideSession';

/**
 * Data fields of the bottom HUD bar: which values exist, how they are computed from the ride
 * snapshot, and the layout the rider picks in the settings (separately for free rides and workouts).
 */
export type HudFieldId =
  | 'power3s'
  | 'power10s'
  | 'avgPower'
  | 'np'
  | 'wkg'
  | 'heartRate'
  | 'cadence'
  | 'speed'
  | 'distance'
  | 'time'
  | 'grade'
  | 'kj'
  | 'tss'
  | 'if'
  | 'lapPower'
  | 'targetPower'
  | 'intervalRemaining';

export type HudLayoutMode = 'free' | 'workout';

export interface HudFieldDef {
  id: HudFieldId;
  /** Tile title in the HUD (short, upper case there). */
  label: string;
  /** Name in the settings list. */
  name: string;
  /** Only offered in workouts. */
  workoutOnly?: boolean;
}

export const HUD_FIELDS: HudFieldDef[] = [
  { id: 'power3s', label: 'Leistung', name: 'Leistung 3 s' },
  { id: 'power10s', label: 'Leistung 10 s', name: 'Leistung 10 s' },
  { id: 'avgPower', label: 'Ø Leistung', name: 'Ø Leistung' },
  { id: 'np', label: 'NP', name: 'Normalized Power (NP)' },
  { id: 'wkg', label: 'W/kg', name: 'W/kg (3 s)' },
  { id: 'heartRate', label: 'Herzfrequenz', name: 'Herzfrequenz' },
  { id: 'cadence', label: 'Kadenz', name: 'Kadenz' },
  { id: 'speed', label: 'Speed', name: 'Tempo' },
  { id: 'distance', label: 'Distanz', name: 'Distanz' },
  { id: 'time', label: 'Zeit', name: 'Zeit' },
  { id: 'grade', label: 'Steigung', name: 'Steigung' },
  { id: 'kj', label: 'Arbeit', name: 'kJ' },
  { id: 'tss', label: 'TSS', name: 'TSS' },
  { id: 'if', label: 'IF', name: 'Intensity Factor (IF)' },
  { id: 'lapPower', label: 'Runde Ø', name: 'Rundenleistung' },
  { id: 'targetPower', label: 'Ziel', name: 'Ziel-Watt', workoutOnly: true },
  { id: 'intervalRemaining', label: 'Intervall', name: 'Restzeit im Intervall', workoutOnly: true },
];

const FIELD_IDS = new Set<string>(HUD_FIELDS.map((f) => f.id));

/**
 * At most this many tiles – today's layout has 7 (speed, power, cadence, heart rate | distance, time,
 * gradient), and it stays the default. On phones in portrait the CSS shows at most 3 per side (6).
 */
export const MAX_HUD_FIELDS = 7;

export type HudLayout = Record<HudLayoutMode, HudFieldId[]>;

const CLASSIC: HudFieldId[] = ['speed', 'power3s', 'cadence', 'heartRate', 'distance', 'time', 'grade'];

/** The layout before the fields became configurable – same tiles in free rides and workouts. */
export const DEFAULT_HUD_LAYOUT: HudLayout = { free: [...CLASSIC], workout: [...CLASSIC] };

export function fieldDef(id: HudFieldId): HudFieldDef {
  return HUD_FIELDS.find((f) => f.id === id)!;
}

export function availableFields(mode: HudLayoutMode): HudFieldDef[] {
  return HUD_FIELDS.filter((f) => mode === 'workout' || !f.workoutOnly);
}

/** Cleans a stored list: known ids only, no duplicates, workout fields only in workouts, at most MAX_HUD_FIELDS. */
export function sanitizeFields(list: unknown, mode: HudLayoutMode): HudFieldId[] {
  if (!Array.isArray(list)) return [...DEFAULT_HUD_LAYOUT[mode]];
  const out: HudFieldId[] = [];
  for (const id of list) {
    if (typeof id !== 'string' || !FIELD_IDS.has(id) || out.includes(id as HudFieldId)) continue;
    if (mode === 'free' && fieldDef(id as HudFieldId).workoutOnly) continue;
    out.push(id as HudFieldId);
    if (out.length >= MAX_HUD_FIELDS) break;
  }
  return out;
}

export function sanitizeLayout(value: unknown): HudLayout {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<HudLayoutMode, unknown>>;
  return { free: sanitizeFields(v.free, 'free'), workout: sanitizeFields(v.workout, 'workout') };
}

/** Moves the field at `index` one place up (−1) or down (+1). */
export function moveField(list: HudFieldId[], index: number, delta: -1 | 1): HudFieldId[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export function addField(list: HudFieldId[], id: HudFieldId): HudFieldId[] {
  return list.includes(id) || list.length >= MAX_HUD_FIELDS ? list : [...list, id];
}

export function removeField(list: HudFieldId[], id: HudFieldId): HudFieldId[] {
  return list.filter((f) => f !== id);
}

/** Left of the elevation profile the first half (rounded up), right the rest – 7 tiles give 4 | 3 as before. */
export function splitFields(list: HudFieldId[]): [HudFieldId[], HudFieldId[]] {
  const left = Math.ceil(list.length / 2);
  return [list.slice(0, left), list.slice(left)];
}

export interface FieldContext {
  /** Reference FTP (zones, IF, TSS); 0 = unknown. */
  ftp: number;
  weightKg: number;
}

export interface FieldValue {
  value: string;
  unit?: string;
  sub?: string;
  /** Colour of the bottom edge (power zone, gradient …). */
  accent?: string;
}

const DASH = '–';

function num(v: number | undefined, digits = 0): string {
  return v === undefined || !Number.isFinite(v) ? DASH : v.toFixed(digits);
}

/** Intensity factor of the ride so far (NP / FTP). */
export function liveIntensity(s: Pick<RideSnapshot, 'normalizedPower'>, ftp: number): number {
  return intensityFactor(s.normalizedPower, ftp);
}

/** Training Stress Score so far, from the moving time and the running NP. */
export function liveTss(s: Pick<RideSnapshot, 'normalizedPower' | 'movingS'>, ftp: number): number {
  return trainingStressScore(s.movingS, s.normalizedPower, ftp);
}

/** Value, unit, sub line and accent colour of one tile. */
export function fieldValue(id: HudFieldId, s: RideSnapshot, ctx: FieldContext): FieldValue {
  const wkg = (w: number) => (ctx.weightKg > 0 ? w / ctx.weightKg : 0);
  const zoneOf = (w: number) => (ctx.ftp > 0 ? powerZone(w, ctx.ftp) : undefined);
  switch (id) {
    case 'power3s': {
      const zone = zoneOf(s.power3s);
      return { value: num(s.power3s), unit: 'W', sub: `${wkg(s.power3s).toFixed(1)} W/kg${zone ? ` · Z${zone.zone}` : ''}`, accent: zone?.color };
    }
    case 'power10s': {
      const zone = zoneOf(s.power10s);
      return { value: num(s.power10s), unit: 'W', sub: `${wkg(s.power10s).toFixed(1)} W/kg`, accent: zone?.color };
    }
    case 'avgPower':
      return { value: num(s.avgPower), unit: 'W', sub: `${wkg(s.avgPower).toFixed(1)} W/kg` };
    case 'np':
      return { value: s.movingS > 0 ? num(s.normalizedPower) : DASH, unit: 'W', sub: s.avgPower > 0 ? `VI ${(s.normalizedPower / s.avgPower).toFixed(2)}` : undefined };
    case 'wkg': {
      const zone = zoneOf(s.power3s);
      return { value: wkg(s.power3s).toFixed(1), unit: 'W/kg', sub: `${num(s.power3s)} W`, accent: zone?.color };
    }
    case 'heartRate':
      return { value: s.heartRate ? num(s.heartRate) : DASH, unit: 'bpm', accent: s.heartRate ? '#f85149' : undefined };
    case 'cadence':
      return { value: num(s.cadence), unit: 'rpm' };
    case 'speed':
      return { value: num(s.speedMps * 3.6, 1), unit: 'km/h' };
    case 'distance':
      return { value: (s.distanceM / 1000).toFixed(2), unit: 'km', sub: `⛰ ${Math.round(s.ascentM)} hm` };
    case 'time': {
      const avgKmh = s.movingS > 0 ? (s.distanceM / s.movingS) * 3.6 : 0;
      return { value: formatClock(s.movingS), sub: s.movingS >= 10 ? `Ø ${avgKmh.toFixed(1)} km/h` : undefined };
    }
    case 'grade':
      return {
        value: `${s.gradePercent < 0 ? '−' : ''}${Math.abs(s.gradePercent).toFixed(1)}`,
        unit: '%',
        sub: s.trainerGrade !== undefined ? `Trainer ${s.trainerGrade.toFixed(1)} %` : undefined,
        accent: gradeColor(s.gradePercent),
      };
    case 'kj':
      return { value: num(s.kilojoules), unit: 'kJ', sub: `≈ ${Math.round(s.kilojoules)} kcal` };
    case 'tss':
      return { value: ctx.ftp > 0 ? num(liveTss(s, ctx.ftp), liveTss(s, ctx.ftp) < 10 ? 1 : 0) : DASH, sub: ctx.ftp > 0 ? `FTP ${Math.round(ctx.ftp)} W` : 'FTP fehlt' };
    case 'if':
      return { value: ctx.ftp > 0 && s.movingS > 0 ? liveIntensity(s, ctx.ftp).toFixed(2) : DASH, sub: ctx.ftp > 0 ? `NP ${Math.round(s.normalizedPower)} W` : 'FTP fehlt' };
    case 'lapPower':
      return { value: s.lapPowerS > 0 ? num(s.lapPower) : DASH, unit: 'W', sub: s.workout ? `Block · ${formatClock(s.lapPowerS)}` : `Runde ${s.lap} · ${formatClock(s.lapPowerS)}` };
    case 'targetPower': {
      const w = s.workout;
      if (!w || w.finished || w.mode !== 'erg' || w.targetWatts === undefined) return { value: DASH, unit: 'W', sub: w?.finished ? 'Workout fertig' : 'frei' };
      const delta = Math.round(s.power3s - w.targetWatts);
      const ok = Math.abs(delta) <= Math.max(10, w.targetWatts * 0.1);
      return { value: String(w.targetWatts), unit: 'W', sub: ok ? '✓ im Ziel' : `${delta > 0 ? '+' : ''}${delta} W`, accent: ok ? '#3fb950' : '#d29922' };
    }
    case 'intervalRemaining': {
      const w = s.workout;
      if (!w || w.finished) return { value: DASH };
      return { value: formatClock(Math.ceil(w.segmentRemainingS)), sub: w.segment?.label };
    }
  }
}
