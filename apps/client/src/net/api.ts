import type { Loadout } from '@velo/equipment';
import { garageStore, type GarageState } from '../state/garage';
import { settingsStore } from '../state/settings';
import { Store, loadJson, saveJson } from '../state/store';
import { resolveServerBase, sameOriginServer } from './serverUrl';

export interface AccountUser {
  id: string;
  name: string;
  email: string;
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

/**
 * Browser deployment (app served by the game server): an empty server address means "this
 * origin". Fill it in so the settings page shows it and allows logging in right away.
 */
const sameOrigin = sameOriginServer();
if (sameOrigin && !settingsStore.get().serverUrl.trim()) {
  settingsStore.set({ ...settingsStore.get(), serverUrl: sameOrigin });
}

/** Game server base URL ('' = offline). Empty setting → same origin when served by the game server. */
export function serverBase(): string {
  return resolveServerBase(settingsStore.get().serverUrl);
}

export function isLoggedIn(): boolean {
  return !!accountStore.get().token && !!serverBase();
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

export function logout(): void {
  accountStore.set({});
}

export async function refreshAccount(): Promise<void> {
  if (!isLoggedIn()) return;
  const r = await call<{ user: AccountUser; garage: ServerGarage }>('/api/me');
  accountStore.set({ ...accountStore.get(), user: r.user });
  applyGarage(r.garage);
}

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
