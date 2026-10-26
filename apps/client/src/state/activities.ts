import { encodeFitActivity, powerCurve, timeInHeartRateZones, timeInZones, type ActivitySummary } from '@velo/metrics';
import type { RideResult } from '../ride/rideSession';
import { settingsStore } from './settings';
import { Store, loadJson, saveJson } from './store';

export interface StoredActivity {
  id: string;
  routeId: string;
  routeName: string;
  title: string;
  startTime: number;
  summary: Omit<ActivitySummary, 'laps'> & { lapCount: number };
  simulated: boolean;
  /** Missing on rides pulled from another device until it is needed (fetched from the server then). */
  fit?: Uint8Array;
  /** Account the ride belongs to; older rides get the first account that syncs them. */
  owner?: string;
  /** The server has the current version (metadata). */
  synced?: boolean;
  /** The server has the FIT file. */
  serverFit?: boolean;
  /** Best power for each of CURVE_DURATIONS – the input for the FTP estimate (missing on older rides). */
  curve?: number[];
  /** `improved`: beat an earlier best time (not just the first time on the segment). */
  segments?: Array<{ id: string; name: string; type: string; timeS: number; isPb: boolean; improved?: boolean }>;
  /** Workout ridden in this ride; `test`: a finished FTP test. */
  workout?: { name: string; completed: boolean; test?: boolean };
  /** Seconds in each power zone (with a known FTP) and heart rate zone (with a heart rate strap), for the Strava text. */
  zones?: { power?: number[]; heartRate?: number[]; maxHr?: number };
  /** Group ride this ride was part of (invite code and name). */
  group?: { id: string; name: string };
  strava?: {
    status: 'pending' | 'uploading' | 'processing' | 'ready' | 'duplicate' | 'error' | 'skipped';
    uploadId?: number;
    activityId?: number;
    url?: string;
    error?: string;
  };
}

const DB = 'velo-sim';
const STORE = 'activities';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** The rides of the signed-in account (and rides of no account yet) – the device may hold several accounts' rides. */
export const activitiesStore = new Store<StoredActivity[]>([]);

// start with the stored account, so the list is right before the first sync (no import of net/api: cycle)
let owner: string | undefined = loadJson<{ user?: { id?: string } }>('velo.account.v1', {}).user?.id;
const mine = (a: StoredActivity) => !a.owner || a.owner === owner;

/** Called by the account sync whenever the signed-in account changes. */
export async function setActivityOwner(id: string | undefined): Promise<void> {
  if (id === owner) return;
  owner = id;
  await loadActivities();
}

export async function loadActivities(): Promise<void> {
  try {
    const all = await tx<StoredActivity[]>('readonly', (s) => s.getAll() as IDBRequest<StoredActivity[]>);
    activitiesStore.set(all.filter(mine).sort((a, b) => b.startTime - a.startTime));
  } catch (err) {
    console.warn('Aktivitäten konnten nicht geladen werden', err);
  }
}

export function activityTitle(routeName: string, startTime: number, prefix = 'Freie Fahrt'): string {
  const d = new Date(startTime);
  return `${prefix}: ${routeName} – ${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

export async function saveActivity(result: RideResult, simulated: boolean, titlePrefix?: string, group?: { id: string; name: string }): Promise<StoredActivity> {
  const { laps, ...rest } = result.summary;
  const activity: StoredActivity = {
    id: `${result.summary.startTime}-${result.routeId}`,
    routeId: result.routeId,
    routeName: result.routeName,
    title: activityTitle(result.routeName, result.summary.startTime, titlePrefix),
    startTime: result.summary.startTime,
    summary: { ...rest, lapCount: laps.length },
    simulated,
    owner,
    synced: false,
    fit: encodeFitActivity(result.samples, result.summary),
    curve: powerCurve(result.samples.map((x) => x.power)),
    segments: result.segments.map((r) => ({
      id: r.segment.id,
      name: r.segment.name,
      type: r.segment.type,
      timeS: r.timeS,
      isPb: r.saved,
      improved: r.saved && r.previousBestS !== undefined && r.timeS < r.previousBestS,
    })),
    zones: rideZones(result),
    workout: result.workout && { name: result.workout.name, completed: result.workout.completed, test: !!result.workout.test?.ftp },
    group,
  };
  try {
    await tx('readwrite', (s) => s.put(activity));
  } catch (err) {
    console.warn('Aktivität konnte nicht gespeichert werden', err);
  }
  activitiesStore.set([activity, ...activitiesStore.get().filter((a) => a.id !== activity.id)]);
  return activity;
}

function rideZones(result: RideResult): StoredActivity['zones'] {
  const ftp = result.summary.ftp || settingsStore.get().ftp;
  const hr = result.samples.map((x) => x.heartRate);
  const maxHr = settingsStore.get().maxHeartRate || Math.max(190, result.summary.maxHeartRate ?? 0);
  return {
    power: ftp > 0 ? timeInZones(result.samples.map((x) => x.power), ftp) : undefined,
    heartRate: hr.some((v) => (v ?? 0) > 0) ? timeInHeartRateZones(hr, maxHr) : undefined,
    maxHr,
  };
}

/** Fields that only describe this device's copy – changing them does not need a new upload. */
const LOCAL_FIELDS = new Set<keyof StoredActivity>(['fit', 'owner', 'synced', 'serverFit']);

/** Merges a patch into a stored activity (e.g. its Strava upload status); other devices get it with the next sync. */
export async function updateActivity(id: string, patch: Partial<StoredActivity>): Promise<StoredActivity | undefined> {
  const current = activitiesStore.get().find((a) => a.id === id);
  if (!current) return undefined;
  const shared = (Object.keys(patch) as Array<keyof StoredActivity>).some((k) => !LOCAL_FIELDS.has(k));
  const next = { ...current, ...(shared ? { synced: false } : {}), ...patch };
  activitiesStore.set(activitiesStore.get().map((a) => (a.id === id ? next : a)));
  try {
    await tx('readwrite', (s) => s.put(next));
  } catch {
    // keep in memory even if IndexedDB is unavailable
  }
  return next;
}

/** Stores a ride that came from the server (another device). */
export async function putSyncedActivity(a: StoredActivity): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(a));
  } catch {
    // keep in memory even if IndexedDB is unavailable
  }
  if (!mine(a)) return;
  const rest = activitiesStore.get().filter((x) => x.id !== a.id);
  activitiesStore.set([...rest, a].sort((x, y) => y.startTime - x.startTime));
}

const DELETES_KEY = 'velo.activityDeletes.v1';
/** Deletions the server has not heard of yet (offline): account id → activity ids. */
export const pendingDeletes = new Store<Record<string, string[]>>(loadJson(DELETES_KEY, {}));
pendingDeletes.subscribe(() => saveJson(DELETES_KEY, pendingDeletes.get()));

export async function deleteActivity(id: string, opts: { remote?: boolean } = {}): Promise<void> {
  const a = activitiesStore.get().find((x) => x.id === id);
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    // ignore
  }
  activitiesStore.set(activitiesStore.get().filter((x) => x.id !== id));
  // deleted here: tell the server (and so the other devices), unless the deletion came from there
  const acc = a?.owner ?? owner;
  if (!opts.remote && acc) pendingDeletes.set((p) => ({ ...p, [acc]: [...new Set([...(p[acc] ?? []), id])] }));
}

export function fitFileName(a: StoredActivity): string {
  const d = new Date(a.startTime);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `velo-sim_${a.routeId}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.fit`;
}
