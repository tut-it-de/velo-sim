import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CATALOG, STARTER_LOADOUT, type Loadout } from '@velo/equipment';
import { DuplicateEmailError, type Garage, type RideRecord, type Storage, type StravaConnectionRecord, type User } from './types';

const STARTER_ITEMS = CATALOG.filter((i) => i.price === 0).map((i) => i.id);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount integer NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger(user_id, created_at);
CREATE TABLE IF NOT EXISTS owned_items (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS loadouts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bike text NOT NULL,
  wheels text NOT NULL,
  jersey text NOT NULL
);
ALTER TABLE loadouts ADD COLUMN IF NOT EXISTS helmet text;
CREATE TABLE IF NOT EXISTS route_laps (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id text NOT NULL,
  PRIMARY KEY (user_id, route_id)
);
CREATE TABLE IF NOT EXISTS rides (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id text NOT NULL,
  started_at timestamptz NOT NULL,
  duration_s integer NOT NULL,
  distance_m integer NOT NULL,
  kilojoules integer NOT NULL,
  coins integer NOT NULL,
  flagged boolean NOT NULL DEFAULT false,
  reason text
);
CREATE INDEX IF NOT EXISTS rides_user_idx ON rides(user_id, started_at DESC);
CREATE TABLE IF NOT EXISTS strava_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  athlete_id bigint NOT NULL,
  athlete_name text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at bigint NOT NULL,
  scope text NOT NULL,
  auto_upload boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

/** PostgreSQL storage. The wallet balance is always the SUM of the ledger. */
export class PostgresStorage implements Storage {
  private constructor(private readonly pool: pg.Pool) {}

  static async connect(connectionString: string): Promise<PostgresStorage> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    await pool.query(SCHEMA);
    return new PostgresStorage(pool);
  }

  private mapUser(r: Record<string, unknown>): User {
    return {
      id: r.id as string,
      email: r.email as string,
      name: r.name as string,
      passwordHash: r.password_hash as string,
      createdAt: new Date(r.created_at as string).getTime(),
    };
  }

  async createUser(email: string, name: string, passwordHash: string): Promise<User> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      const res = await client.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING *', [
        id,
        email.trim().toLowerCase(),
        name,
        passwordHash,
      ]);
      for (const item of STARTER_ITEMS) await client.query('INSERT INTO owned_items (user_id, item_id) VALUES ($1, $2)', [id, item]);
      await client.query('INSERT INTO loadouts (user_id, bike, wheels, jersey, helmet) VALUES ($1, $2, $3, $4, $5)', [
        id,
        STARTER_LOADOUT.bike,
        STARTER_LOADOUT.wheels,
        STARTER_LOADOUT.jersey,
        STARTER_LOADOUT.helmet,
      ]);
      await client.query('COMMIT');
      return this.mapUser(res.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code === '23505') throw new DuplicateEmailError(email);
      throw err;
    } finally {
      client.release();
    }
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const res = await this.pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    return res.rows[0] ? this.mapUser(res.rows[0]) : undefined;
  }

  async getUser(id: string): Promise<User | undefined> {
    const res = await this.pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0] ? this.mapUser(res.rows[0]) : undefined;
  }

  async getGarage(userId: string): Promise<Garage> {
    const [owned, loadout, balance, laps, ledger] = await Promise.all([
      this.pool.query('SELECT item_id FROM owned_items WHERE user_id = $1', [userId]),
      this.pool.query('SELECT bike, wheels, jersey, helmet FROM loadouts WHERE user_id = $1', [userId]),
      this.pool.query('SELECT COALESCE(SUM(amount), 0)::int AS balance FROM ledger WHERE user_id = $1', [userId]),
      this.pool.query('SELECT route_id FROM route_laps WHERE user_id = $1', [userId]),
      this.pool.query('SELECT id, amount, label, created_at FROM ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
    ]);
    const l = loadout.rows[0] as Loadout | undefined;
    return {
      owned: owned.rows.map((r) => r.item_id as string),
      loadout: l ? { bike: l.bike, wheels: l.wheels, jersey: l.jersey, helmet: l.helmet ?? undefined } : { ...STARTER_LOADOUT },
      balance: balance.rows[0].balance as number,
      routesWithLap: laps.rows.map((r) => r.route_id as string),
      ledger: ledger.rows.reverse().map((r) => ({ id: r.id, amount: r.amount, label: r.label, at: new Date(r.created_at).getTime() })),
    };
  }

  async addLedger(userId: string, amount: number, label: string): Promise<number> {
    await this.pool.query('INSERT INTO ledger (id, user_id, amount, label) VALUES ($1, $2, $3, $4)', [randomUUID(), userId, Math.round(amount), label]);
    const res = await this.pool.query('SELECT COALESCE(SUM(amount), 0)::int AS balance FROM ledger WHERE user_id = $1', [userId]);
    return res.rows[0].balance as number;
  }

  async buy(userId: string, itemId: string, price: number, label: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialise purchases per user so two parallel requests cannot overspend.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
      const has = await client.query('SELECT 1 FROM owned_items WHERE user_id = $1 AND item_id = $2', [userId, itemId]);
      if (has.rowCount) {
        await client.query('ROLLBACK');
        return { ok: false as const, error: 'Schon in deiner Garage' };
      }
      const bal = await client.query('SELECT COALESCE(SUM(amount), 0)::int AS balance FROM ledger WHERE user_id = $1', [userId]);
      const balance = bal.rows[0].balance as number;
      if (balance < price) {
        await client.query('ROLLBACK');
        return { ok: false as const, error: 'Nicht genug Watt-Taler' };
      }
      await client.query('INSERT INTO ledger (id, user_id, amount, label) VALUES ($1, $2, $3, $4)', [randomUUID(), userId, -price, label]);
      await client.query('INSERT INTO owned_items (user_id, item_id) VALUES ($1, $2)', [userId, itemId]);
      await client.query('COMMIT');
      return { ok: true as const, balance: balance - price };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async setLoadout(userId: string, loadout: Loadout): Promise<void> {
    await this.pool.query(
      `INSERT INTO loadouts (user_id, bike, wheels, jersey, helmet) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET bike = EXCLUDED.bike, wheels = EXCLUDED.wheels, jersey = EXCLUDED.jersey, helmet = EXCLUDED.helmet`,
      [userId, loadout.bike, loadout.wheels, loadout.jersey, loadout.helmet ?? null],
    );
  }

  async markRouteLap(userId: string, routeId: string): Promise<void> {
    await this.pool.query('INSERT INTO route_laps (user_id, route_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, routeId]);
  }

  async saveRide(r: RideRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO rides (id, user_id, route_id, started_at, duration_s, distance_m, kilojoules, coins, flagged, reason)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, $7, $8, $9, $10)`,
      [r.id, r.userId, r.routeId, r.startedAt, Math.round(r.durationS), Math.round(r.distanceM), Math.round(r.kilojoules), r.coins, r.flagged, r.reason ?? null],
    );
  }

  async listRides(userId: string, limit: number): Promise<RideRecord[]> {
    const res = await this.pool.query('SELECT * FROM rides WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2', [userId, limit]);
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      routeId: r.route_id,
      startedAt: new Date(r.started_at).getTime(),
      durationS: r.duration_s,
      distanceM: r.distance_m,
      kilojoules: r.kilojoules,
      coins: r.coins,
      flagged: r.flagged,
      reason: r.reason ?? undefined,
    }));
  }

  async getStrava(userId: string): Promise<StravaConnectionRecord | undefined> {
    const res = await this.pool.query('SELECT * FROM strava_connections WHERE user_id = $1', [userId]);
    const r = res.rows[0];
    if (!r) return undefined;
    return {
      userId: r.user_id,
      athleteId: Number(r.athlete_id),
      athleteName: r.athlete_name,
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: Number(r.expires_at),
      scope: r.scope,
      autoUpload: r.auto_upload,
    };
  }

  async saveStrava(c: StravaConnectionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO strava_connections (user_id, athlete_id, athlete_name, access_token, refresh_token, expires_at, scope, auto_upload, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET athlete_id = EXCLUDED.athlete_id, athlete_name = EXCLUDED.athlete_name,
         access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at,
         scope = EXCLUDED.scope, auto_upload = EXCLUDED.auto_upload, updated_at = now()`,
      [c.userId, c.athleteId, c.athleteName, c.accessToken, c.refreshToken, c.expiresAt, c.scope, c.autoUpload],
    );
  }

  async deleteStrava(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM strava_connections WHERE user_id = $1', [userId]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
