import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@velo/protocol';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/auth';
import { wrapGap } from '../src/rooms';
import { startServer, type VeloServer } from '../src/server';
import { MemoryStorage } from '../src/storage/memory';
import { PostgresStorage } from '../src/storage/postgres';
import type { Storage } from '../src/storage/types';

const SECRET = 'test-secret';
const loadout = { bike: 'bike-basis', wheels: 'wheels-basis', jersey: 'jersey-club-orange' };

describe('auth', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('geheim123');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('geheim123', h)).toBe(true);
    expect(await verifyPassword('falsch', h)).toBe(false);
  });

  it('signs and verifies tokens, rejects tampering and expiry', () => {
    const t = signToken({ sub: 'u1', name: 'Ali' }, SECRET);
    expect(verifyToken(t, SECRET)?.sub).toBe('u1');
    expect(verifyToken(t, 'other')).toBeNull();
    const [h, , s] = t.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin', name: 'x', exp: 9e9 })).toString('base64url')}.${s}`;
    expect(verifyToken(forged, SECRET)).toBeNull();
    expect(verifyToken(signToken({ sub: 'u1', name: 'A' }, SECRET, -10), SECRET)).toBeNull();
  });
});

describe('wrapGap', () => {
  it('returns the shortest distance around the loop', () => {
    expect(wrapGap(100, 1000)).toBe(100);
    expect(wrapGap(900, 1000)).toBe(-100);
    expect(wrapGap(-950, 1000)).toBe(50);
  });
});

function storageSuite(name: string, make: () => Promise<Storage>) {
  describe(`storage: ${name}`, () => {
    let storage: Storage;
    beforeAll(async () => {
      storage = await make();
    });
    afterAll(async () => {
      await storage.close();
    });

    it('creates users with starter equipment and books purchases atomically', async () => {
      const email = `ali+${Date.now()}@example.com`;
      const u = await storage.createUser(email, 'Ali', 'hash');
      await expect(storage.createUser(email.toUpperCase(), 'Ali', 'hash')).rejects.toThrow();
      expect((await storage.findUserByEmail(email))?.id).toBe(u.id);
      let g = await storage.getGarage(u.id);
      expect(g.balance).toBe(0);
      expect(g.owned).toContain('bike-basis');
      expect(g.loadout).toEqual(loadout);

      expect(await storage.addLedger(u.id, 5000, 'Fahrt')).toBe(5000);
      expect(await storage.buy(u.id, 'bike-treck-domano', 4000, 'Kauf')).toEqual({ ok: true, balance: 1000 });
      expect(await storage.buy(u.id, 'bike-treck-domano', 4000, 'Kauf')).toMatchObject({ ok: false });
      expect(await storage.buy(u.id, 'bike-gigant-kontend', 4500, 'Kauf')).toMatchObject({ ok: false, error: 'Nicht genug Watt-Taler' });
      await storage.setLoadout(u.id, { ...loadout, bike: 'bike-treck-domano' });
      await storage.markRouteLap(u.id, 'kuestenrunde');
      await storage.markRouteLap(u.id, 'kuestenrunde');
      g = await storage.getGarage(u.id);
      expect(g.balance).toBe(1000);
      expect(g.loadout.bike).toBe('bike-treck-domano');
      expect(g.routesWithLap).toEqual(['kuestenrunde']);
      expect(g.ledger.map((e) => e.amount)).toEqual([5000, -4000]);
    });
  });
}

storageSuite('memory', async () => new MemoryStorage());
if (process.env.PG_TEST_URL) storageSuite('postgres', () => PostgresStorage.connect(process.env.PG_TEST_URL!));

class TestClient {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url.replace('http', 'ws') + '/ws');
    this.ws.on('message', (d) => this.messages.push(JSON.parse(d.toString())));
  }
  ready() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, ms = 3000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const m = this.messages.find((x) => x.type === type && pred(x as Extract<ServerMessage, { type: T }>));
      if (m) return m as Extract<ServerMessage, { type: T }>;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
}

async function api(server: VeloServer, path: string, body?: unknown, token?: string) {
  const res = await fetch(server.url + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('server', () => {
  let server: VeloServer;
  beforeAll(async () => {
    server = await startServer({ storage: new MemoryStorage(), secret: SECRET, port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await server.close();
  });

  it('registers, logs in and buys through the API', async () => {
    const reg = await api(server, '/api/auth/register', { email: 'a@b.de', name: 'Ali', password: 'supergeheim' });
    expect(reg.status).toBe(201);
    expect((await api(server, '/api/auth/register', { email: 'a@b.de', name: 'Ali', password: 'supergeheim' })).status).toBe(409);
    expect((await api(server, '/api/auth/login', { email: 'a@b.de', password: 'falsch!!' })).status).toBe(401);
    const login = await api(server, '/api/auth/login', { email: 'A@B.de', password: 'supergeheim' });
    expect(login.status).toBe(200);
    const me = await api(server, '/api/me', undefined, login.json.token);
    expect(me.json.garage.balance).toBe(0);
    const buy = await api(server, '/api/garage/buy', { itemId: 'bike-treck-domano' }, login.json.token);
    expect(buy.status).toBe(409);
    expect((await api(server, '/api/me')).status).toBe(401);
  });

  it('relays positions between riders, chat and kudos', async () => {
    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    await Promise.all([a.ready(), b.ready()]);
    a.send({ type: 'hello', v: 1, name: 'Anna', routeId: 'kuestenrunde', loadout, weightKg: 60 });
    const wa = await a.waitFor('welcome');
    b.send({ type: 'hello', v: 1, name: 'Ben', routeId: 'kuestenrunde', loadout, weightKg: 80 });
    const wb = await b.waitFor('welcome');
    expect(wb.riders.map((r) => r.name)).toEqual(['Anna']);
    await a.waitFor('joined', (m) => m.rider.name === 'Ben');

    a.send({ type: 'state', d: 120, v: 9, p: 210, c: 88, lat: 1.4 });
    const snap = await b.waitFor('snapshot', (m) => m.r.some((t) => t[0] === wa.id && t[1] === 120));
    expect(snap.r.find((t) => t[0] === wa.id)).toEqual([wa.id, 120, 9, 1.4, 210, 88]);

    b.send({ type: 'chat', text: 'Servus!' });
    expect((await a.waitFor('chat')).text).toBe('Servus!');
    b.send({ type: 'rideOn', to: wa.id });
    expect((await a.waitFor('rideOn')).name).toBe('Ben');

    b.ws.close();
    await a.waitFor('left', (m) => m.id === wb.id);
    a.ws.close();
  });

  it('computes kJ on the server and books Watt-Taler for logged-in riders', async () => {
    const reg = await api(server, '/api/auth/register', { email: 'c@d.de', name: 'Chris', password: 'supergeheim' });
    const token = reg.json.token as string;
    const c = new TestClient(server.url);
    await c.ready();
    c.send({ type: 'hello', v: 1, token, name: 'egal', routeId: 'kuestenrunde', loadout, weightKg: 75 });
    const w = await c.waitFor('welcome');
    expect(w.authenticated).toBe(true);
    // 24 updates 250 ms apart at 400 W ≈ 6 s × 400 W ≈ 2.4 kJ
    for (let i = 1; i <= 24; i++) {
      c.send({ type: 'state', d: i * 2.5, v: 10, p: 400, c: 90, lat: 1.4 });
      await new Promise((r) => setTimeout(r, 250));
    }
    c.send({ type: 'bye' });
    const summary = (await c.waitFor('rideSummary')).summary;
    expect(summary.flagged).toBe(false);
    expect(summary.kilojoules).toBeGreaterThan(2.0);
    expect(summary.kilojoules).toBeLessThan(2.7);
    expect(summary.coins).toBe(Math.floor(summary.kilojoules));
    const me = await api(server, '/api/me', undefined, token);
    expect(me.json.garage.balance).toBe(summary.coins);
  }, 15_000);

  it('flags implausible rides and pays nothing', async () => {
    const reg = await api(server, '/api/auth/register', { email: 'e@f.de', name: 'Eve', password: 'supergeheim' });
    const c = new TestClient(server.url);
    await c.ready();
    c.send({ type: 'hello', v: 1, token: reg.json.token, name: 'Eve', routeId: 'bergrunde', loadout, weightKg: 60 });
    await c.waitFor('welcome');
    for (let i = 1; i <= 6; i++) {
      c.send({ type: 'state', d: i * 500, v: 10, p: 3000, c: 90, lat: 1.4 });
      await new Promise((r) => setTimeout(r, 120));
    }
    c.send({ type: 'bye' });
    const summary = (await c.waitFor('rideSummary')).summary;
    expect(summary.flagged).toBe(true);
    expect(summary.coins).toBe(0);
    expect(summary.reason).toMatch(/Leistung|Positionssprung/);
  });

  it('rejects unknown routes and old protocol versions', async () => {
    const c = new TestClient(server.url);
    await c.ready();
    c.send({ type: 'hello', v: 99, name: 'X', routeId: 'kuestenrunde', loadout, weightKg: 70 });
    expect((await c.waitFor('error')).message).toMatch(/Protokoll/);
    const d = new TestClient(server.url);
    await d.ready();
    d.send({ type: 'hello', v: 1, name: 'X', routeId: 'mond', loadout, weightKg: 70 });
    expect((await d.waitFor('error')).message).toMatch(/Unbekannte Strecke/);
  });
});
