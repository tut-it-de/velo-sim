import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@velo/protocol';
import { hashPassword, signToken, verifyPassword, verifyToken } from '../src/auth';
import { isAdmin } from '../src/http';
import { wrapGap } from '../src/rooms';
import { groupCenter, groupCode } from '../src/groups';
import { startServer, type VeloServer } from '../src/server';
import { MemoryStorage } from '../src/storage/memory';
import { PostgresStorage } from '../src/storage/postgres';
import type { Storage } from '../src/storage/types';

const SECRET = 'test-secret';
const loadout = { bike: 'bike-basis', wheels: 'wheels-basis', jersey: 'jersey-club-orange', helmet: 'helmet-basis' };

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

describe('isAdmin', () => {
  it('only accepts e-mails from the ADMIN_EMAILS list, case-insensitive', () => {
    expect(isAdmin('Chef@Example.de', ' chef@example.de , zwei@example.de')).toBe(true);
    expect(isAdmin('zwei@example.de', 'chef@example.de,zwei@example.de')).toBe(true);
    expect(isAdmin('andere@example.de', 'chef@example.de')).toBe(false);
    expect(isAdmin('', '')).toBe(false);
    expect(isAdmin('', 'chef@example.de,')).toBe(false);
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

    it('syncs activities with a cursor, keeps the FIT file and leaves tombstones', async () => {
      const u = await storage.createUser(`act+${Date.now()}@example.com`, 'Ali', 'hash');
      const fit = new Uint8Array([1, 2, 3]);
      const a = await storage.saveActivity(u.id, { id: '1-r', startTime: 1, meta: { title: 'A' }, fit });
      await storage.saveActivity(u.id, { id: '2-r', startTime: 2, meta: { title: 'B' } });
      expect((await storage.listActivities(u.id, 0, 10)).map((x) => x.id)).toEqual(['1-r', '2-r']);
      expect((await storage.listActivities(u.id, a.updatedAt, 10)).map((x) => x.id)).toEqual(['2-r']);
      // a metadata update keeps the FIT file and moves the activity to the end
      await storage.saveActivity(u.id, { id: '1-r', startTime: 1, meta: { title: 'A2' } });
      expect(await storage.getActivityFit(u.id, '1-r')).toEqual(fit);
      const after = await storage.listActivities(u.id, a.updatedAt, 10);
      expect(after.map((x) => [x.id, (x.meta as { title: string }).title])).toEqual([['2-r', 'B'], ['1-r', 'A2']]);
      await storage.deleteActivity(u.id, '1-r');
      const last = (await storage.listActivities(u.id, 0, 10)).at(-1)!;
      expect(last).toMatchObject({ id: '1-r', deleted: true });
      expect(await storage.getActivityFit(u.id, '1-r')).toBeUndefined();
    });

    it('stores group rides by invite code', async () => {
      const u = await storage.createUser(`gruppe+${Date.now()}@example.com`, 'Gina', 'hash');
      const id = `T${Date.now().toString(36).slice(-5).toUpperCase()}`;
      const group = { id, name: 'Sonntagsrunde', routeId: 'kuestenrunde', hostUserId: u.id, hostName: 'Gina', startAt: null, together: true, status: 'lobby' as const, createdAt: 1_700_000_000_000 };
      expect(await storage.createGroupRide(group)).toBe(true);
      expect(await storage.createGroupRide({ ...group, name: 'Doppelt' })).toBe(false);
      expect(await storage.getGroupRide(id)).toEqual(group);
      await storage.updateGroupRide(id, { status: 'riding', startAt: 1_700_000_100_000, startedAt: 1_700_000_100_000 });
      expect(await storage.getGroupRide(id)).toEqual({ ...group, status: 'riding', startAt: 1_700_000_100_000, startedAt: 1_700_000_100_000 });
      expect(await storage.getGroupRide('NIXDA')).toBeUndefined();
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

  it('stores activities per account and pages through changes', async () => {
    const reg = await api(server, '/api/auth/register', { email: 'akt@b.de', name: 'Akt', password: 'supergeheim' });
    const t = reg.json.token as string;
    const fit = Buffer.concat([Buffer.from([14, 16, 0, 0, 0, 0, 0, 0]), Buffer.from('.FIT'), Buffer.from([0, 0])]).toString('base64');
    expect((await api(server, '/api/activities', { id: '1-r', startTime: 1, meta: { a: 1 }, fit: 'bm9wZQ==' }, t)).status).toBe(400);
    expect((await api(server, '/api/activities', { id: '../x', startTime: 1, meta: { a: 1 } }, t)).status).toBe(400);
    expect((await api(server, '/api/activities', { id: '1-r', startTime: 1, meta: { a: 1 }, fit }, t)).status).toBe(200);
    const list = await api(server, '/api/activities?since=0', undefined, t);
    expect(list.json.activities).toEqual([{ id: '1-r', startTime: 1, meta: { a: 1 }, deleted: false, hasFit: true }]);
    expect((await api(server, `/api/activities?since=${list.json.cursor}`, undefined, t)).json.activities).toEqual([]);
    expect((await api(server, '/api/activities/1-r/fit', undefined, t)).json.fit).toBe(fit);
    // another account sees nothing
    const other = await api(server, '/api/auth/register', { email: 'akt2@b.de', name: 'Akt2', password: 'supergeheim' });
    expect((await api(server, '/api/activities?since=0', undefined, other.json.token)).json.activities).toEqual([]);
    expect((await api(server, '/api/activities/1-r/fit', undefined, other.json.token)).status).toBe(404);
    expect((await api(server, '/api/activities/1-r/delete', {}, t)).status).toBe(200);
    expect((await api(server, `/api/activities?since=${list.json.cursor}`, undefined, t)).json.activities).toMatchObject([{ id: '1-r', deleted: true }]);
  });

  it('books challenge and badge rewards once, from the synced rides only', async () => {
    const reg = await api(server, '/api/auth/register', { email: 'erfolg@b.de', name: 'Erfolg', password: 'supergeheim' });
    const t = reg.json.token as string;
    const start = (await api(server, '/api/me', undefined, t)).json.garage.balance as number;
    const meta = (p: object) => ({ routeId: 'huegelrunde', simulated: false, summary: { distanceM: 30_000, durationS: 3600, ascentM: 200, lapCount: 0 }, ...p });
    const now = Date.now();
    await api(server, '/api/activities', { id: 'sim', startTime: now - 3000, meta: meta({ simulated: true }) }, t);
    expect((await api(server, '/api/achievements/claim', {}, t)).json.booked).toEqual([]);
    await api(server, '/api/activities', { id: 'r1', startTime: now - 2000, meta: meta({ workout: { test: true } }) }, t);
    const first = await api(server, '/api/achievements/claim', {}, t);
    expect(first.json.booked.map((b: { key: string }) => b.key).sort()).toEqual(['badge:first-ride', 'badge:ftp-test']);
    expect(first.json.balance).toBe(start + 400);
    // asking again books nothing
    const again = await api(server, '/api/achievements/claim', {}, t);
    expect(again.json.booked).toEqual([]);
    expect(again.json.claimed).toContain('badge:ftp-test');
    expect(again.json.balance).toBe(start + 400);
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
    b.send({ type: 'emote', e: 'vape' });
    expect(await a.waitFor('emote')).toEqual({ type: 'emote', from: wb.id, e: 'vape' });

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

describe('group rides', () => {
  let server: VeloServer;
  beforeAll(async () => {
    server = await startServer({ storage: new MemoryStorage(), secret: SECRET, port: 0, host: '127.0.0.1', groupCountdownMs: 400 });
  });
  afterAll(async () => {
    await server.close();
  });

  it('makes codes without look-alike characters and takes the median of active riders', () => {
    for (let i = 0; i < 50; i++) expect(groupCode()).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
    const now = 10_000;
    expect(groupCenter([], now)).toBeUndefined();
    const r = (d: number, v: number, updatedAt = now - 100) => ({ d, v, updatedAt });
    expect(groupCenter([r(100, 10), r(60, 8)], now)).toEqual({ d: 80, v: 9, n: 2 });
    // the paused rider (no update for 5 s) does not hold the group back
    expect(groupCenter([r(100, 10), r(60, 8), r(500, 12), r(0, 0, now - 5000)], now)).toEqual({ d: 100, v: 10, n: 3 });
  });

  it('creates a group, fills the lobby, starts everyone together and sends the group position', async () => {
    const regA = await api(server, '/api/auth/register', { email: 'host@g.de', name: 'Hanna', password: 'supergeheim' });
    const regB = await api(server, '/api/auth/register', { email: 'gast@g.de', name: 'Gerd', password: 'supergeheim' });
    const regC = await api(server, '/api/auth/register', { email: 'spaet@g.de', name: 'Carla', password: 'supergeheim' });
    expect((await api(server, '/api/groups', { routeId: 'kuestenrunde' })).status).toBe(401);
    expect((await api(server, '/api/groups', { routeId: 'mond' }, regA.json.token)).status).toBe(400);
    const created = await api(server, '/api/groups', { name: 'Feierabendrunde', routeId: 'kuestenrunde', startAt: null, together: true }, regA.json.token);
    expect(created.status).toBe(201);
    const code = created.json.group.id as string;
    expect(created.json.group).toMatchObject({ name: 'Feierabendrunde', routeId: 'kuestenrunde', status: 'lobby', together: true, hostName: 'Hanna', startAt: null });
    const looked = await api(server, `/api/groups/${code.toLowerCase()}`, undefined, regB.json.token);
    expect(looked.json.group).toMatchObject({ id: code, members: [] });
    expect((await api(server, '/api/groups/ZZZZZZ', undefined, regB.json.token)).status).toBe(404);

    // Without login there is no group ride.
    const anon = new TestClient(server.url);
    await anon.ready();
    anon.send({ type: 'hello', v: 1, name: 'Anon', routeId: 'kuestenrunde', loadout, weightKg: 70, groupId: code });
    expect((await anon.waitFor('error')).message).toMatch(/angemeldet/);

    const a = new TestClient(server.url);
    const b = new TestClient(server.url);
    const stranger = new TestClient(server.url);
    await Promise.all([a.ready(), b.ready(), stranger.ready()]);
    stranger.send({ type: 'hello', v: 1, name: 'Fremd', routeId: 'kuestenrunde', loadout, weightKg: 70 });
    await stranger.waitFor('welcome');
    a.send({ type: 'hello', v: 1, token: regA.json.token, name: 'x', routeId: 'kuestenrunde', loadout, weightKg: 60, groupId: code });
    const wa = await a.waitFor('welcome');
    expect(wa.riders).toEqual([]); // own room: no strangers
    expect((await a.waitFor('group')).group.members.map((m) => [m.name, m.host])).toEqual([['Hanna', true]]);
    b.send({ type: 'hello', v: 1, token: regB.json.token, name: 'x', routeId: 'bergrunde', loadout, weightKg: 80, groupId: code });
    const wb = await b.waitFor('welcome');
    expect(wb.routeId).toBe('kuestenrunde');
    expect(wb.riders.map((r) => r.name)).toEqual(['Hanna']);
    await a.waitFor('group', (m) => m.group.members.length === 2);
    expect((await api(server, `/api/groups/${code}`, undefined, regB.json.token)).json.group.members).toHaveLength(2);

    // Nobody moves in the lobby, and only the host starts.
    a.send({ type: 'state', d: 500, v: 10, p: 200, c: 90, lat: 1.4 });
    b.send({ type: 'groupStart' });
    await new Promise((r) => setTimeout(r, 300));
    expect(b.messages.some((m) => m.type === 'group' && m.group.startAt !== null)).toBe(false);
    a.send({ type: 'groupStart' });
    const countdown = await b.waitFor('group', (m) => m.group.startAt !== null);
    expect(countdown.group.status).toBe('lobby');
    await a.waitFor('group', (m) => m.group.status === 'riding');
    await b.waitFor('group', (m) => m.group.status === 'riding');

    a.send({ type: 'state', d: 12, v: 9, p: 300, c: 90, lat: 1.4 });
    b.send({ type: 'state', d: 8, v: 8, p: 150, c: 85, lat: 1.4 });
    const pos = await b.waitFor('groupPos', (m) => m.n === 2);
    expect(pos.d).toBe(10);
    expect(pos.v).toBe(8.5);
    const snap = await b.waitFor('snapshot', (m) => m.r.some((t) => t[0] === wa.id && t[1] === 12));
    expect(snap.r.map((t) => t[0])).toEqual([wa.id]);

    // A late rider starts where the group is.
    const c = new TestClient(server.url);
    await c.ready();
    c.send({ type: 'hello', v: 1, token: regC.json.token, name: 'x', routeId: 'kuestenrunde', loadout, weightKg: 70, groupId: code });
    const late = await c.waitFor('group');
    expect(late.group.status).toBe('riding');
    expect(late.group.startD).toBe(10);
    c.send({ type: 'state', d: 12, v: 8, p: 200, c: 85, lat: 1.4 });
    await a.waitFor('groupPos', (m) => m.n === 3);

    // Ride for 3 s at real power, then the host ends it for everyone.
    for (let i = 1; i <= 12; i++) {
      a.send({ type: 'state', d: 12 + i * 2.5, v: 10, p: 400, c: 90, lat: 1.4 });
      b.send({ type: 'state', d: 8 + i * 2.5, v: 10, p: 400, c: 90, lat: 1.4 });
      await new Promise((r) => setTimeout(r, 250));
    }
    b.send({ type: 'groupEnd' }); // not the host: ignored
    a.send({ type: 'groupEnd' });
    const ended = await b.waitFor('group', (m) => m.group.status === 'ended');
    expect(c.messages.some((m) => m.type === 'group' && m.group.status === 'ended')).toBe(true);
    expect(ended.group.members).toHaveLength(3);
    b.send({ type: 'bye' });
    const summary = (await b.waitFor('rideSummary')).summary;
    expect(summary.flagged).toBe(false);
    expect(summary.kilojoules).toBeGreaterThan(1);
    expect(summary.coins).toBe(Math.floor(summary.kilojoules)); // only kJ, the group help pays nothing

    // An ended ride cannot be joined again.
    const d = new TestClient(server.url);
    await d.ready();
    d.send({ type: 'hello', v: 1, token: regC.json.token, name: 'x', routeId: 'kuestenrunde', loadout, weightKg: 70, groupId: code });
    expect((await d.waitFor('error')).message).toMatch(/vorbei/);
    for (const x of [a, c, stranger, anon, d]) x.ws.close();
  }, 20_000);
});
