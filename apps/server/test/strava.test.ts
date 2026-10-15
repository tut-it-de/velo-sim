import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecorder, encodeFitActivity } from '@velo/metrics';
import { startServer, type VeloServer } from '../src/server';
import { MemoryStorage } from '../src/storage/memory';
import { TokenCipher } from '../src/strava';

/** Minimal fake of the Strava endpoints we use. */
function fakeStrava() {
  const log: string[] = [];
  const uploads = new Map<string, number>(); // external_id → activity id
  let processingCalls = 0;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('latin1');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? '';
    log.push(`${req.method} ${req.url} ${auth}`);
    if (req.url === '/oauth/token') {
      const b = JSON.parse(raw);
      if (b.client_secret !== 'shh') return json(401, { message: 'bad client' });
      if (b.grant_type === 'authorization_code' && b.code === 'good') {
        return json(200, { access_token: 'acc-1', refresh_token: 'ref-1', expires_at: Math.floor(Date.now() / 1000) + 3600, athlete: { id: 42, firstname: 'Ali', lastname: 'Tut' } });
      }
      if (b.grant_type === 'refresh_token' && b.refresh_token === 'ref-1') {
        return json(200, { access_token: 'acc-2', refresh_token: 'ref-2', expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      return json(400, { message: 'bad grant' });
    }
    if (req.url === '/oauth/deauthorize') return json(200, {});
    if (req.url === '/api/v3/uploads' && req.method === 'POST') {
      if (!auth.startsWith('Bearer acc-')) return json(401, { message: 'Authorization Error' });
      if (!raw.includes('name="data_type"') || !raw.includes('name="file"') || !raw.includes('.FIT')) return json(400, { message: 'bad upload' });
      const ext = /name="external_id"\r\n\r\n([^\r]+)/.exec(raw)?.[1] ?? '';
      if (uploads.has(ext)) {
        return json(201, { id: 900, error: `${ext}.fit duplicate of activity ${uploads.get(ext)}`, status: 'There was an error processing your activity.', activity_id: null });
      }
      uploads.set(ext, 123456 + uploads.size);
      processingCalls = 0;
      return json(201, { id: 777, external_id: ext, error: null, status: 'Your activity is still being processed.', activity_id: null });
    }
    if (req.url === '/api/v3/uploads/777') {
      processingCalls++;
      if (processingCalls < 2) return json(200, { id: 777, error: null, status: 'Your activity is still being processed.', activity_id: null });
      return json(200, { id: 777, error: null, status: 'Your activity is ready.', activity_id: [...uploads.values()].at(-1) });
    }
    json(404, { message: 'not found' });
  });
  return { server, log };
}

function fitFile(): string {
  const rec = new ActivityRecorder(250, Date.UTC(2026, 9, 15, 17));
  for (let i = 0; i < 120; i++) rec.record({ timestamp: Date.UTC(2026, 9, 15, 17) + i * 1000, distanceM: i * 9, speedMps: 9, elevationM: 10, gradePercent: 0, power: 200 });
  return Buffer.from(encodeFitActivity(rec.samples, rec.summary())).toString('base64');
}

describe('Strava integration', () => {
  let strava: ReturnType<typeof fakeStrava>;
  let server: VeloServer;
  let storage: MemoryStorage;
  let token: string;
  let userId: string;

  const api = async (path: string, body?: unknown, auth = true) => {
    const res = await fetch(server.url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {
      json = { html: text };
    }
    return { status: res.status, json };
  };

  beforeAll(async () => {
    strava = fakeStrava();
    await new Promise<void>((r) => strava.server.listen(0, '127.0.0.1', r));
    const apiBase = `http://127.0.0.1:${(strava.server.address() as AddressInfo).port}`;
    storage = new MemoryStorage();
    server = await startServer({
      storage,
      secret: 'test',
      port: 0,
      host: '127.0.0.1',
      strava: { clientId: '1234', clientSecret: 'shh', publicUrl: 'https://velo.example.de', apiBase, pollIntervalMs: 10 },
    });
    const reg = await api('/api/auth/register', { email: 'ali@example.de', name: 'Ali', password: 'supergeheim' }, false);
    token = reg.json.token;
    userId = reg.json.user.id;
  });

  afterAll(async () => {
    await server.close();
    await new Promise<void>((r) => strava.server.close(() => r()));
  });

  it('reports status and builds the authorize URL', async () => {
    expect((await api('/api/strava/status')).json).toEqual({ configured: true, connected: false });
    const { json } = await api('/api/strava/connect', {});
    const url = new URL(json.url);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('1234');
    expect(url.searchParams.get('redirect_uri')).toBe('https://velo.example.de/api/strava/callback');
    expect(url.searchParams.get('scope')).toBe('read,activity:write');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('rejects callbacks with a forged state or missing upload permission', async () => {
    const bad = await api('/api/strava/callback?code=good&state=forged&scope=read,activity:write', undefined, false);
    expect(bad.status).toBe(400);
    expect(bad.json.html).toContain('abgelaufen');
    const { json } = await api('/api/strava/connect', {});
    const state = new URL(json.url).searchParams.get('state')!;
    const noScope = await api(`/api/strava/callback?code=good&state=${state}&scope=read`, undefined, false);
    expect(noScope.json.html).toContain('Aktivitäten hochladen');
  });

  it('connects through the OAuth callback and stores tokens encrypted', async () => {
    const { json } = await api('/api/strava/connect', {});
    const state = new URL(json.url).searchParams.get('state')!;
    const cb = await api(`/api/strava/callback?code=good&state=${encodeURIComponent(state)}&scope=read,activity:write`, undefined, false);
    expect(cb.status).toBe(200);
    expect(cb.json.html).toContain('Strava verbunden');
    expect((await api('/api/strava/status')).json).toEqual({ configured: true, connected: true, athleteName: 'Ali T.', autoUpload: true });
    const stored = await storage.getStrava(userId);
    expect(stored!.accessToken).not.toContain('acc-1');
    expect(new TokenCipher('test').decrypt(stored!.accessToken)).toBe('acc-1');
  });

  it('uploads a FIT file and waits for the activity link', async () => {
    const res = await api('/api/strava/upload', { fit: fitFile(), name: 'Küstenrunde', externalId: 'velo-1' });
    expect(res.json).toEqual({ status: 'ready', uploadId: 777, activityId: 123456, url: 'https://www.strava.com/activities/123456' });
    expect(strava.log.some((l) => l.startsWith('POST /api/v3/uploads Bearer acc-1'))).toBe(true);
  });

  it('recognises duplicates', async () => {
    const res = await api('/api/strava/upload', { fit: fitFile(), name: 'Küstenrunde', externalId: 'velo-1' });
    expect(res.json.status).toBe('duplicate');
    expect(res.json.activityId).toBe(123456);
  });

  it('refreshes an expired access token before uploading', async () => {
    const c = (await storage.getStrava(userId))!;
    await storage.saveStrava({ ...c, expiresAt: Math.floor(Date.now() / 1000) - 10 });
    const res = await api('/api/strava/upload', { fit: fitFile(), name: 'Bergrunde', externalId: 'velo-2' });
    expect(res.json.status).toBe('ready');
    expect(strava.log.some((l) => l.startsWith('POST /api/v3/uploads Bearer acc-2'))).toBe(true);
    const after = (await storage.getStrava(userId))!;
    expect(new TokenCipher('test').decrypt(after.refreshToken)).toBe('ref-2');
  });

  it('rejects non-FIT uploads, toggles auto upload and disconnects', async () => {
    expect((await api('/api/strava/upload', { fit: Buffer.from('hello world, no fit').toString('base64') })).status).toBe(400);
    expect((await api('/api/strava/settings', { autoUpload: false })).json.autoUpload).toBe(false);
    expect((await api('/api/strava/disconnect', {})).json).toEqual({ configured: true, connected: false });
    expect(strava.log.some((l) => l.startsWith('POST /oauth/deauthorize'))).toBe(true);
    expect((await api('/api/strava/upload', { fit: fitFile() })).status).toBe(409);
  });

  it('requires a login', async () => {
    expect((await api('/api/strava/status', undefined, false)).status).toBe(401);
  });
});
