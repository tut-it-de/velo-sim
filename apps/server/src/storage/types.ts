import type { Loadout } from '@velo/equipment';
import type { GroupRideDTO, GroupStatus } from '@velo/protocol';

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
  getStrava(userId: string): Promise<StravaConnectionRecord | undefined>;
  saveStrava(record: StravaConnectionRecord): Promise<void>;
  deleteStrava(userId: string): Promise<void>;
  close(): Promise<void>;
  // --- group rides ---
  /** Stores a new group ride; false when the code is already taken. */
  createGroupRide(group: GroupRideRecord): Promise<boolean>;
  getGroupRide(id: string): Promise<GroupRideRecord | undefined>;
  updateGroupRide(id: string, patch: GroupRidePatch): Promise<void>;
}

/** A group ride (invite code = id); the riders themselves only live in the game room. */
export type GroupRideRecord = GroupRideDTO;
export type GroupRidePatch = Partial<{ status: GroupStatus; startAt: number | null; startedAt: number }>;
