import { Capacitor } from '@capacitor/core';
import { activitiesStore, updateActivity, type StoredActivity } from '../state/activities';
import { Store, loadJson, saveJson } from '../state/store';
import { accountStore, isLoggedIn, serverBase } from './api';

export interface StravaStatus {
  configured: boolean;
  connected: boolean;
  athleteName?: string;
  autoUpload?: boolean;
}

export interface StravaUpload {
  /** pending: waiting for the internet, uploaded on the next start or when the connection is back. */
  status: 'pending' | 'uploading' | 'processing' | 'ready' | 'duplicate' | 'error' | 'skipped';
  uploadId?: number;
  activityId?: number;
  url?: string;
  error?: string;
}

// Kept on the device, so a ride offline still knows that it should go to Strava later.
export const stravaStore = new Store<StravaStatus>(loadJson('velo.strava.v1', { configured: false, connected: false }));
stravaStore.subscribe(() => saveJson('velo.strava.v1', stravaStore.get()));

const OFFLINE = 'Server nicht erreichbar';

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${serverBase()}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accountStore.get().token ?? ''}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(OFFLINE);
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Fehler ${res.status}`);
  return json;
}

export async function refreshStravaStatus(): Promise<StravaStatus> {
  if (!isLoggedIn()) {
    stravaStore.set({ configured: false, connected: false });
    return stravaStore.get();
  }
  try {
    stravaStore.set(await call<StravaStatus>('/api/strava/status'));
  } catch {
    // keep last known state
  }
  return stravaStore.get();
}

/** Opens a URL outside the app (system browser / Safari sheet) — needed for the Strava login. */
export async function openExternal(url: string): Promise<void> {
  if (window.veloDesktop?.openExternal) {
    window.veloDesktop.openExternal(url);
  } else if (Capacitor.isNativePlatform()) {
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/** Starts the OAuth flow and resolves once the server reports the connection (or after 3 min). */
export async function connectStrava(): Promise<boolean> {
  const { url } = await call<{ url: string }>('/api/strava/connect', {});
  await openExternal(url);
  const until = Date.now() + 3 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2500));
    if ((await refreshStravaStatus()).connected) return true;
  }
  return false;
}

export async function setStravaAutoUpload(autoUpload: boolean): Promise<void> {
  stravaStore.set(await call<StravaStatus>('/api/strava/settings', { autoUpload }));
}

export async function disconnectStrava(): Promise<void> {
  stravaStore.set(await call<StravaStatus>('/api/strava/disconnect', {}));
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function describeRide(a: StoredActivity): string {
  const s = a.summary;
  const parts = [
    `${(s.distanceM / 1000).toFixed(1)} km auf der ${a.routeName}`,
    `Ø ${Math.round(s.avgPower)} W · NP ${Math.round(s.normalizedPower)} W · TSS ${Math.round(s.tss)}`,
  ];
  const pbs = (a.segments ?? []).filter((x) => x.isPb).map((x) => x.name);
  if (pbs.length) parts.push(`🏆 Bestzeiten: ${pbs.join(', ')}`);
  parts.push('Gefahren mit Velo Sim');
  return parts.join('\n');
}

/** Uploads one stored activity to Strava and keeps its status on the activity. */
export async function uploadToStrava(a: StoredActivity): Promise<StravaUpload> {
  if (a.simulated) {
    const skipped: StravaUpload = { status: 'skipped', error: 'Simulator-Fahrten werden nicht zu Strava hochgeladen.' };
    await updateActivity(a.id, { strava: skipped });
    return skipped;
  }
  await updateActivity(a.id, { strava: { status: 'uploading' } });
  let result: StravaUpload;
  try {
    result = await call<StravaUpload>('/api/strava/upload', {
      fit: toBase64(a.fit),
      name: a.title.replace(/ – \d{2}\.\d{2}\.\d{4}.*$/, ''),
      description: describeRide(a),
      externalId: `velo-sim-${a.id}`,
    });
    // Strava sometimes needs longer than the server waits; keep polling a little.
    for (let i = 0; i < 8 && result.status === 'processing' && result.uploadId; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      result = await call<StravaUpload>(`/api/strava/upload/${result.uploadId}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = msg === OFFLINE ? { status: 'pending' } : { status: 'error', error: msg };
  }
  await updateActivity(a.id, { strava: result });
  return result;
}

/** Called after every ride: uploads when Strava is connected and auto upload is on. */
export async function maybeAutoUpload(activityId: string): Promise<void> {
  if (!isLoggedIn()) return;
  const status = stravaStore.get().connected ? stravaStore.get() : await refreshStravaStatus();
  if (!status.connected || !status.autoUpload) return;
  const a = activitiesStore.get().find((x) => x.id === activityId);
  if (!a || a.summary.durationS < 60) return;
  await uploadToStrava(a);
}

let syncing = false;
/** Uploads the rides that waited for the internet (app start, back online, app back in front). */
export async function syncPendingStrava(): Promise<void> {
  if (syncing || !isLoggedIn() || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  syncing = true;
  try {
    const pending = activitiesStore.get().filter((a) => a.strava?.status === 'pending' || a.strava?.status === 'uploading');
    if (!pending.length) return;
    const status = await refreshStravaStatus();
    if (!status.connected) return;
    for (const a of pending) if ((await uploadToStrava(a)).status === 'pending') break;
  } finally {
    syncing = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void syncPendingStrava());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void syncPendingStrava());
}
