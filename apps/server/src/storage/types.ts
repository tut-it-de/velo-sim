import type { Loadout } from '@velo/equipment';

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: number;
}

export interface LedgerEntry {
  id: string;
  at: number;
  amount: number;
  label: string;
}

export interface Garage {
  owned: string[];
  loadout: Loadout;
  balance: number;
  routesWithLap: string[];
  ledger: LedgerEntry[];
}

export interface RideRecord {
  id: string;
  userId: string;
  routeId: string;
  startedAt: number;
  durationS: number;
  distanceM: number;
  kilojoules: number;
  coins: number;
  flagged: boolean;
  reason?: string;
}

export class DuplicateEmailError extends Error {
  override name = 'DuplicateEmailError';
}

/** Persistence used by the HTTP API and the game rooms. */
export interface Storage {
  createUser(email: string, name: string, passwordHash: string): Promise<User>;
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;
  getGarage(userId: string): Promise<Garage>;
  /** Adds a ledger entry and returns the new balance. */
  addLedger(userId: string, amount: number, label: string): Promise<number>;
  /** Atomically checks the balance, books the price and adds the item. */
  buy(userId: string, itemId: string, price: number, label: string): Promise<{ ok: true; balance: number } | { ok: false; error: string }>;
  setLoadout(userId: string, loadout: Loadout): Promise<void>;
  markRouteLap(userId: string, routeId: string): Promise<void>;
  saveRide(ride: RideRecord): Promise<void>;
  listRides(userId: string, limit: number): Promise<RideRecord[]>;
  close(): Promise<void>;
}
