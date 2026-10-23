import {
  activitiesStore,
  deleteActivity,
  pendingDeletes,
  putSyncedActivity,
  setActivityOwner,
  updateActivity,
  type StoredActivity,
} from '../state/activities';
import { loadJson, saveJson } from '../state/store';
import { accountStore, apiCall, isLoggedIn } from './api';

/**
 * Rides follow the account: every ride goes to the server (summary, power curve, segments and the FIT file),
 * rides from other devices come back without their FIT file, which is fetched when it is needed.
 * Offline rides and deletions wait and go out with the next sync (app start, back online, after a ride).
 */

const CURSOR_KEY = 'velo.activitySync.v1';
/** Last server change seen, per account. */
let cursors = loadJson<Record<string, number>>(CURSOR_KEY, {});

type Meta = Omit<StoredActivity, 'fit' | 'owner' | 'synced' | 'serverFit'>;
interface RemoteActivity {
  id: string;
  startTime: number;
  meta: Meta | null;
  deleted: boolean;
  hasFit: boolean;
}

function toMeta(a: StoredActivity): Meta {
  const { fit: _fit, owner: _owner, synced: _synced, serverFit: _serverFit, ...meta } = a;
  // an upload that is still running on this device is not a status for the others
  if (meta.strava && (meta.strava.status === 'uploading' || meta.strava.status === 'pending')) delete meta.strava;
  return meta;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

let running: Promise<void> | undefined;
let again = false;

/** Sends local changes and fetches the other devices' changes; concurrent calls are merged into one more run. */
export function syncActivities(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } finally {
      running = undefined;
    }
  })();
  return running;
}

async function syncOnce(): Promise<void> {
  const user = accountStore.get().user?.id;
  await setActivityOwner(user);
  if (!user || !isLoggedIn() || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;

  // 1. deletions made here
  for (const id of pendingDeletes.get()[user] ?? []) {
    await apiCall(`/api/activities/${encodeURIComponent(id)}/delete`, {});
    pendingDeletes.set((p) => ({ ...p, [user]: (p[user] ?? []).filter((x) => x !== id) }));
  }

  // 2. new and changed rides (oldest first, so an interrupted backfill resumes in order)
  const outgoing = activitiesStore
    .get()
    .filter((a) => !a.synced)
    .sort((a, b) => a.startTime - b.startTime);
  for (const a of outgoing) {
    const withFit = !a.serverFit && !!a.fit?.length;
    const meta = toMeta(a);
    await apiCall('/api/activities', { id: a.id, startTime: a.startTime, meta, fit: withFit ? toBase64(a.fit!) : undefined });
    const current = activitiesStore.get().find((x) => x.id === a.id);
    if (!current) continue;
    // changed again while uploading: leave it unsynced for the next run
    if (JSON.stringify(toMeta(current)) !== JSON.stringify(meta)) {
      again = true;
      await updateActivity(a.id, { owner: user, serverFit: a.serverFit || !!withFit });
      continue;
    }
    await updateActivity(a.id, { owner: user, synced: true, serverFit: a.serverFit || !!withFit });
  }

  // 3. changes from the other devices
  for (;;) {
    const since = cursors[user] ?? 0;
    const r = await apiCall<{ activities: RemoteActivity[]; cursor: number; more: boolean }>(`/api/activities?since=${since}`);
    for (const remote of r.activities) await applyRemote(user, remote);
    cursors = { ...cursors, [user]: r.cursor };
    saveJson(CURSOR_KEY, cursors);
    if (!r.more) break;
  }
}

async function applyRemote(user: string, remote: RemoteActivity): Promise<void> {
  const local = activitiesStore.get().find((a) => a.id === remote.id);
  if (remote.deleted) {
    if (local) await deleteActivity(remote.id, { remote: true });
    return;
  }
  if (!remote.meta) return;
  // our own unsent edit wins; it goes out with the next run
  if (local && !local.synced) return;
  await putSyncedActivity({ ...remote.meta, id: remote.id, owner: user, synced: true, serverFit: remote.hasFit, fit: local?.fit });
}

/** The FIT file of a ride – from the device, or from the server for rides of another device. */
export async function activityFit(a: StoredActivity): Promise<Uint8Array> {
  if (a.fit?.length) return a.fit;
  if (!a.serverFit) throw new Error('Für diese Fahrt gibt es keine FIT-Datei.');
  const r = await apiCall<{ fit: string }>(`/api/activities/${encodeURIComponent(a.id)}/fit`);
  const fit = fromBase64(r.fit);
  await updateActivity(a.id, { fit });
  return fit;
}

const quietSync = () => void syncActivities().catch((err) => console.warn('Fahrten-Abgleich fehlgeschlagen', err));

if (typeof window !== 'undefined') {
  window.addEventListener('online', quietSync);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && quietSync());
  // account switched (login, logout, other account): show that account's rides and fetch them
  let lastUser = accountStore.get().user?.id;
  accountStore.subscribe(() => {
    const u = accountStore.get().user?.id;
    if (u === lastUser) return;
    lastUser = u;
    quietSync();
  });
}

export { quietSync as syncActivitiesQuietly };
