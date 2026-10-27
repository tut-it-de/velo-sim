import { CATALOG, STARTER_LOADOUT, getItem, itemName, type EarningLine, type Loadout } from '@velo/equipment';
import { settingsStore } from './settings';
import { Store, loadJson, saveJson } from './store';

export interface LedgerEntry {
  id: string;
  at: number;
  /** Positive = earned, negative = spent. */
  amount: number;
  label: string;
}

export interface GarageState {
  owned: string[];
  loadout: Loadout;
  ledger: LedgerEntry[];
  /** Routes on which the first-lap bonus was already paid. */
  routesWithLap: string[];
}

const KEY = 'velo.garage.v1';

const DEFAULT: GarageState = {
  owned: CATALOG.filter((i) => i.price === 0).map((i) => i.id),
  loadout: { ...STARTER_LOADOUT },
  ledger: [],
  routesWithLap: [],
};

/**
 * Local wallet + garage. Every change is a ledger entry; the balance is their
 * sum. Phase 5 moves the ledger to the server (the client is not trusted).
 */
export const garageStore = new Store<GarageState>(loadJson(KEY, DEFAULT));
garageStore.subscribe(() => saveJson(KEY, garageStore.get()));

/** Back to the starter kit (signing out: the next rider on this device starts fresh). */
export function resetGarage(): void {
  garageStore.set({ ...DEFAULT, loadout: { ...DEFAULT.loadout } });
}

export function balance(state = garageStore.get()): number {
  if (settingsStore.get().adminMode) return Infinity;
  return state.ledger.reduce((a, e) => a + e.amount, 0);
}

let seq = 0;
const entryId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function buy(itemId: string): { ok: true } | { ok: false; error: string } {
  const item = getItem(itemId);
  const state = garageStore.get();
  if (!item) return { ok: false, error: 'Unbekannter Artikel' };
  if (state.owned.includes(itemId)) return { ok: false, error: 'Schon in deiner Garage' };
  if (balance(state) < item.price) return { ok: false, error: 'Nicht genug Watt-Taler' };
  // admin mode: unlimited money, the purchase costs nothing
  const admin = settingsStore.get().adminMode;
  garageStore.set({
    ...state,
    owned: [...state.owned, itemId],
    ledger: [...state.ledger, { id: entryId(), at: Date.now(), amount: admin ? 0 : -item.price, label: `${admin ? 'Admin' : 'Kauf'}: ${itemName(item)}` }],
  });
  return { ok: true };
}

export function equip(itemId: string): void {
  const item = getItem(itemId);
  const state = garageStore.get();
  if (!item || (item.price > 0 && !state.owned.includes(itemId))) return;
  garageStore.set({ ...state, loadout: { ...state.loadout, [item.type]: itemId } });
}

/** Books the earnings of a finished ride. */
export function creditRide(lines: EarningLine[], routeId: string, lapsCompleted: number, title: string): number {
  const state = garageStore.get();
  const amount = lines.reduce((a, l) => a + l.amount, 0);
  if (amount <= 0) return 0;
  garageStore.set({
    ...state,
    ledger: [...state.ledger, { id: entryId(), at: Date.now(), amount, label: title }],
    routesWithLap: lapsCompleted > 0 && !state.routesWithLap.includes(routeId) ? [...state.routesWithLap, routeId] : state.routesWithLap,
  });
  return amount;
}
