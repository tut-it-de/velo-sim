import { encodeFitActivity, type ActivitySummary } from '@velo/metrics';
import type { RideResult } from '../ride/rideSession';
import { Store } from './store';

export interface StoredActivity {
  id: string;
  routeId: string;
  routeName: string;
  title: string;
  startTime: number;
  summary: Omit<ActivitySummary, 'laps'> & { lapCount: number };
  simulated: boolean;
  fit: Uint8Array;
  segments?: Array<{ id: string; name: string; type: string; timeS: number; isPb: boolean }>;
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

export const activitiesStore = new Store<StoredActivity[]>([]);

export async function loadActivities(): Promise<void> {
  try {
    const all = await tx<StoredActivity[]>('readonly', (s) => s.getAll() as IDBRequest<StoredActivity[]>);
    activitiesStore.set(all.sort((a, b) => b.startTime - a.startTime));
  } catch (err) {
    console.warn('Aktivitäten konnten nicht geladen werden', err);
  }
}

export function activityTitle(routeName: string, startTime: number, prefix = 'Freie Fahrt'): string {
  const d = new Date(startTime);
  return `${prefix}: ${routeName} – ${d.toLocaleDateString('de-DE')} ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

export async function saveActivity(result: RideResult, simulated: boolean, titlePrefix?: string): Promise<StoredActivity> {
  const { laps, ...rest } = result.summary;
  const activity: StoredActivity = {
    id: `${result.summary.startTime}-${result.routeId}`,
    routeId: result.routeId,
    routeName: result.routeName,
    title: activityTitle(result.routeName, result.summary.startTime, titlePrefix),
    startTime: result.summary.startTime,
    summary: { ...rest, lapCount: laps.length },
    simulated,
    fit: encodeFitActivity(result.samples, result.summary),
    segments: result.segments.map((r) => ({ id: r.segment.id, name: r.segment.name, type: r.segment.type, timeS: r.timeS, isPb: r.saved })),
  };
  try {
    await tx('readwrite', (s) => s.put(activity));
  } catch (err) {
    console.warn('Aktivität konnte nicht gespeichert werden', err);
  }
  activitiesStore.set([activity, ...activitiesStore.get().filter((a) => a.id !== activity.id)]);
  return activity;
}

/** Merges a patch into a stored activity (e.g. its Strava upload status). */
export async function updateActivity(id: string, patch: Partial<StoredActivity>): Promise<StoredActivity | undefined> {
  const current = activitiesStore.get().find((a) => a.id === id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  activitiesStore.set(activitiesStore.get().map((a) => (a.id === id ? next : a)));
  try {
    await tx('readwrite', (s) => s.put(next));
  } catch {
    // keep in memory even if IndexedDB is unavailable
  }
  return next;
}

export async function deleteActivity(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    // ignore
  }
  activitiesStore.set(activitiesStore.get().filter((a) => a.id !== id));
}

export function fitFileName(a: StoredActivity): string {
  const d = new Date(a.startTime);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `velo-sim_${a.routeId}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.fit`;
}
