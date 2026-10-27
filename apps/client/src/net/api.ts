import type { Loadout } from '@velo/equipment';
import { garageStore, resetGarage, type GarageState } from '../state/garage';
import { DEFAULT_SETTINGS, settingsStore } from '../state/settings';
import { recordsStore } from '../state/records';
import { Store, loadJson, saveJson } from '../state/store';
import { fixedServer } from './serverUrl';
import { applyRemoteFtp, ftpStore, onFtpChange } from '../ftp/ftpStore';
import { EMPTY_FTP_STATE, type FtpState } from '../ftp/advisor';

export interface AccountUser {
  id: string;
  name: string;
  email: string;
  /** Set by the server (ADMIN_EMAILS): admin mode and the trainer simulator. */
  admin?: boolean;
}

interface ServerGarage {
  owned: string[];
  loadout: Loadout;
  balance: number;
  routesWithLap: string[];
  ledger: Array<{ id: string; at: number; amount: number; label: string }>;
}

export interface AccountState {
  token?: string;
  user?: AccountUser;
}

const KEY = 'velo.account.v1';
export const accountStore = new Store<AccountState>(loadJson<AccountState>(KEY, {}));
accountStore.subscribe(() => saveJson(KEY, accountStore.get()));

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Game server base URL – fixed per build, see fixedServer(). */
export function serverBase(): string {
  return fixedServer();
}

export function isLoggedIn(): boolean {
  return !!accountStore.get().token && !!serverBase();
}

export async function apiCall<T>(path: string, body?: unknown): Promise<T> {
  return call<T>(path, body);
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const base = serverBase();
  if (!base) throw new ApiError(0, 'Kein Server eingestellt');
  const token = accountStore.get().token;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Server nicht erreichbar');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    if (res.status === 401 && token) accountStore.set({});
    throw new ApiError(res.status, json.error ?? `Fehler ${res.status}`);
  }
  return json;
}

/** The server is the source of truth for the wallet once logged in. */
function applyGarage(g: ServerGarage): void {
  let next: GarageState = { owned: g.owned, loadout: g.loadout, ledger: g.ledger, routesWithLap: g.routesWithLap };
  if (settingsStore.get().adminMode) {
    // admin mode buys locally for free: keep those items and the loadout chosen with them
    const local = garageStore.get();
    next = { ...next, owned: [...new Set([...g.owned, ...local.owned])], loadout: local.loadout };
  }
  garageStore.set(next);
}

export async function register(email: string, name: string, password: string): Promise<void> {
  const r = await call<{ token: string; user: AccountUser }>('/api/auth/register', { email, name, password });
  accountStore.set({ token: r.token, user: r.user });
  await refreshAccount();
}

export async function login(email: string, password: string): Promise<void> {
  const r = await call<{ token: string; user: AccountUser }>('/api/auth/login', { email, password });
  accountStore.set({ token: r.token, user: r.user });
  await refreshAccount();
}

/** New name on the route: shown at once, saved on the server (other riders see it from the next ride). */
export async function renameAccount(name: string): Promise<void> {
  const user = accountStore.get().user;
  if (user) accountStore.set({ ...accountStore.get(), user: { ...user, name } });
  if (name.trim().length < 2) return;
  const r = await call<{ user: AccountUser }>('/api/me/name', { name: name.trim() });
  accountStore.set({ ...accountStore.get(), user: r.user });
}

/**
 * Signs out for real: forgets the token and everything personal on this device (name, body data, FTP,
 * garage, bests); the rides stay in the account and come back on the next sign-in. Device settings
 * (graphics, trainer, data fields) stay. Back on the sign-in page, not as a guest.
 */
export function logout(): void {
  accountStore.set({});
  const s = settingsStore.get();
  const d = DEFAULT_SETTINGS;
  settingsStore.set({ ...s, riderName: d.riderName, country: d.country, weightKg: d.weightKg, heightCm: d.heightCm, ftp: 0, maxHeartRate: 0, guest: false, adminMode: false });
  ftpStore.set({ ...EMPTY_FTP_STATE });
  recordsStore.set({});
  resetGarage();
}

export const isAdminUser = (state: AccountState = accountStore.get()) => !!state.user?.admin;

// Admin mode is admin-only: switch it off as soon as the account is not (or no longer) an admin.
// (The simulator is switched off by the App through the device manager, which also disconnects it.)
function enforceAdminOnly(): void {
  if (isAdminUser()) return;
  const s = settingsStore.get();
  if (s.adminMode) settingsStore.set({ ...s, adminMode: false });
}
enforceAdminOnly();
accountStore.subscribe(enforceAdminOnly);

export async function refreshAccount(): Promise<void> {
  if (!isLoggedIn()) return;
  const r = await call<{ user: AccountUser; garage: ServerGarage; fitness?: { ftp: number; state: FtpState } | null }>('/api/me');
  accountStore.set({ ...accountStore.get(), user: r.user });
  applyGarage(r.garage);
  // FTP: the newer side wins – take the server's or send ours.
  if (r.fitness) applyRemoteFtp(r.fitness);
  if (ftpStore.get().updatedAt > (r.fitness?.state.updatedAt ?? 0)) await pushFtp();
}

/** Sends the FTP and its history to the account (silently retried on the next refresh when offline). */
export async function pushFtp(): Promise<void> {
  if (!isLoggedIn()) return;
  await call('/api/me/fitness', { ftp: settingsStore.get().ftp, state: ftpStore.get() });
}
onFtpChange(() => void pushFtp().catch(() => undefined));

export async function serverBuy(itemId: string): Promise<void> {
  const r = await call<{ garage: ServerGarage }>('/api/garage/buy', { itemId });
  applyGarage(r.garage);
}

export async function serverEquip(itemId: string): Promise<void> {
  const r = await call<{ garage: ServerGarage }>('/api/garage/equip', { itemId });
  applyGarage(r.garage);
}

export async function fetchOnline(): Promise<Record<string, number> | null> {
  if (!serverBase()) return null;
  try {
    const r = await call<{ online: Record<string, number> }>('/api/health');
    return r.online;
  } catch {
    return null;
  }
}
