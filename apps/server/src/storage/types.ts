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

/** Strava link of a user. Tokens are stored encrypted (see TokenCipher). */
export interface StravaConnectionRecord {
  userId: string;
  athleteId: number;
  athleteName: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds */
  expiresAt: number;
  scope: string;
  autoUpload: boolean;
}

/** A ride as the client stores it, synced between the rider's devices. */
export interface ActivityRecord {
  /** Client id, unique per user ("<startTime>-<routeId>"). */
  id: string;
  startTime: number;
  /** Everything the activity list needs (summary, curve, segments …) – opaque JSON from the client. */
  meta: unknown;
  /** Server time of the last change – the clients pull everything newer than their last sync. */
  updatedAt: number;
  deleted: boolean;
  hasFit: boolean;
}

export class DuplicateEmailError extends Error {
  override name = 'DuplicateEmailError';
}

/** Persistence used by the HTTP API and the game rooms. */
export interface Storage {
  createUser(email: string, name: string, passwordHash: string): Promise<User>;
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;
  setUserName(userId: string, name: string): Promise<void>;
  /** FTP and its bookkeeping (source, history, workout feedback) as the client keeps it – opaque JSON. */
  getFitness(userId: string): Promise<unknown>;
  setFitness(userId: string, fitness: unknown): Promise<void>;
  getGarage(userId: string): Promise<Garage>;
  /** Adds a ledger entry and returns the new balance. */
  addLedger(userId: string, amount: number, label: string): Promise<number>;
  /** Atomically checks the balance, books the price and adds the item. */
  buy(userId: string, itemId: string, price: number, label: string): Promise<{ ok: true; balance: number } | { ok: false; error: string }>;
  setLoadout(userId: string, loadout: Loadout): Promise<void>;
  markRouteLap(userId: string, routeId: string): Promise<void>;
  saveRide(ride: RideRecord): Promise<void>;
  listRides(userId: string, limit: number): Promise<RideRecord[]>;
  /** Insert or replace (the FIT file is kept when `fit` is undefined). */
  saveActivity(userId: string, a: { id: string; startTime: number; meta: unknown; fit?: Uint8Array }): Promise<ActivityRecord>;
  /** Changes (including deletions) after `since`, oldest first. */
  listActivities(userId: string, since: number, limit: number): Promise<ActivityRecord[]>;
  getActivityFit(userId: string, id: string): Promise<Uint8Array | undefined>;
  /** Leaves a tombstone so other devices delete their copy too. */
  deleteActivity(userId: string, id: string): Promise<void>;
  getStrava(userId: string): Promise<StravaConnectionRecord | undefined>;
  saveStrava(record: StravaConnectionRecord): Promise<void>;
  deleteStrava(userId: string): Promise<void>;
  close(): Promise<void>;
}
