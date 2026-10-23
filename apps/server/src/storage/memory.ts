import { randomUUID } from 'node:crypto';
import { CATALOG, STARTER_LOADOUT, type Loadout } from '@velo/equipment';
import {
  type ActivityRecord,
  DuplicateEmailError,
  type Garage,
  type LedgerEntry,
  type RideRecord,
  type Storage,
  type StravaConnectionRecord,
  type User,
} from './types';

interface UserData {
  user: User;
  owned: Set<string>;
  loadout: Loadout;
  fitness?: unknown;
  ledger: LedgerEntry[];
  routesWithLap: Set<string>;
  rides: RideRecord[];
  activities: Map<string, ActivityRecord & { fit?: Uint8Array }>;
  claims: Set<string>;
}

const STARTER_ITEMS = CATALOG.filter((i) => i.price === 0).map((i) => i.id);

/** In-memory storage for development and tests (data is lost on restart). */
export class MemoryStorage implements Storage {
  private users = new Map<string, UserData>();
  private strava = new Map<string, StravaConnectionRecord>();

  private data(userId: string): UserData {
    const d = this.users.get(userId);
    if (!d) throw new Error('Unbekannter Benutzer');
    return d;
  }

  async createUser(email: string, name: string, passwordHash: string): Promise<User> {
    const normalized = email.trim().toLowerCase();
    if ([...this.users.values()].some((d) => d.user.email === normalized)) throw new DuplicateEmailError(normalized);
    const user: User = { id: randomUUID(), email: normalized, name, passwordHash, createdAt: Date.now() };
    this.users.set(user.id, { user, owned: new Set(STARTER_ITEMS), loadout: { ...STARTER_LOADOUT }, ledger: [], routesWithLap: new Set(), rides: [], activities: new Map(), claims: new Set() });
    return user;
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const normalized = email.trim().toLowerCase();
    return [...this.users.values()].find((d) => d.user.email === normalized)?.user;
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id)?.user;
  }

  async setUserName(userId: string, name: string): Promise<void> {
    this.data(userId).user.name = name;
  }

  private clock = 0;
  /** Strictly increasing, so two changes in the same millisecond still sort apart. */
  private tick(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  async saveActivity(userId: string, a: { id: string; startTime: number; meta: unknown; fit?: Uint8Array }): Promise<ActivityRecord> {
    const map = this.data(userId).activities;
    const fit = a.fit ?? map.get(a.id)?.fit;
    const rec = { id: a.id, startTime: a.startTime, meta: a.meta, updatedAt: this.tick(), deleted: false, hasFit: !!fit, fit };
    map.set(a.id, rec);
    const { fit: _fit, ...out } = rec;
    return out;
  }

  async listActivities(userId: string, since: number, limit: number): Promise<ActivityRecord[]> {
    return [...this.data(userId).activities.values()]
      .filter((a) => a.updatedAt > since)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit)
      .map(({ fit: _fit, ...a }) => a);
  }

  async getActivityFit(userId: string, id: string): Promise<Uint8Array | undefined> {
    const a = this.data(userId).activities.get(id);
    return a && !a.deleted ? a.fit : undefined;
  }

  async deleteActivity(userId: string, id: string): Promise<void> {
    const map = this.data(userId).activities;
    map.set(id, { id, startTime: map.get(id)?.startTime ?? 0, meta: null, updatedAt: this.tick(), deleted: true, hasFit: false });
  }

  async getFitness(userId: string): Promise<unknown> {
    return this.data(userId).fitness;
  }

  async setFitness(userId: string, fitness: unknown): Promise<void> {
    this.data(userId).fitness = fitness;
  }

  async getGarage(userId: string): Promise<Garage> {
    const d = this.data(userId);
    return {
      owned: [...d.owned],
      loadout: { ...d.loadout },
      balance: d.ledger.reduce((a, e) => a + e.amount, 0),
      routesWithLap: [...d.routesWithLap],
      ledger: [...d.ledger].slice(-50),
    };
  }

  async addLedger(userId: string, amount: number, label: string): Promise<number> {
    const d = this.data(userId);
    d.ledger.push({ id: randomUUID(), at: Date.now(), amount, label });
    return d.ledger.reduce((a, e) => a + e.amount, 0);
  }

  async claimAchievement(userId: string, key: string, amount: number, label: string): Promise<number | undefined> {
    const d = this.data(userId);
    if (d.claims.has(key)) return undefined;
    d.claims.add(key);
    return this.addLedger(userId, amount, label);
  }

  async listAchievementClaims(userId: string): Promise<string[]> {
    return [...this.data(userId).claims];
  }

  async buy(userId: string, itemId: string, price: number, label: string) {
    const d = this.data(userId);
    if (d.owned.has(itemId)) return { ok: false as const, error: 'Schon in deiner Garage' };
    const balance = d.ledger.reduce((a, e) => a + e.amount, 0);
    if (balance < price) return { ok: false as const, error: 'Nicht genug Watt-Taler' };
    d.ledger.push({ id: randomUUID(), at: Date.now(), amount: -price, label });
    d.owned.add(itemId);
    return { ok: true as const, balance: balance - price };
  }

  async setLoadout(userId: string, loadout: Loadout): Promise<void> {
    this.data(userId).loadout = { ...loadout };
  }

  async markRouteLap(userId: string, routeId: string): Promise<void> {
    this.data(userId).routesWithLap.add(routeId);
  }

  async saveRide(ride: RideRecord): Promise<void> {
    this.data(ride.userId).rides.push(ride);
  }

  async listRides(userId: string, limit: number): Promise<RideRecord[]> {
    return [...this.data(userId).rides].reverse().slice(0, limit);
  }

  async getStrava(userId: string): Promise<StravaConnectionRecord | undefined> {
    const r = this.strava.get(userId);
    return r && { ...r };
  }

  async saveStrava(record: StravaConnectionRecord): Promise<void> {
    this.strava.set(record.userId, { ...record });
  }

  async deleteStrava(userId: string): Promise<void> {
    this.strava.delete(userId);
  }

  async close(): Promise<void> {}
}
