import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer, type VeloServer } from '../src/server';
import { contentType, resolveClientDist } from '../src/static';
import { MemoryStorage } from '../src/storage/memory';

const INDEX = '<!doctype html><html><head><title>Velo Sim</title></head><body><div id="root"></div></body></html>';
const JS = `console.log(${JSON.stringify('x'.repeat(4000))});`;
const WORLD = JSON.stringify({ id: 'demo', points: Array.from({ length: 2000 }, (_, i) => [i, i * 2, i % 7]) });
const TERRAIN = Buffer.alloc(64 * 1024, 7);

/** Raw request (fetch would normalise ../ away). */
function rawGet(url: string, rawPath: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static web client', () => {
  let tmp: string;
  let dist: string;
  let server: VeloServer;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'velo-static-'));
    dist = path.join(tmp, 'dist');
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await mkdir(path.join(dist, 'worlds', 'demo'), { recursive: true });
    await writeFile(path.join(dist, 'index.html'), INDEX);
    await writeFile(path.join(dist, 'assets', 'index-AbC123.js'), JS);
    await writeFile(path.join(dist, 'manifest.webmanifest'), '{"name":"velo-sim"}');
    await writeFile(path.join(dist, 'worlds', 'demo', 'world.json'), WORLD);
    await writeFile(path.join(dist, 'worlds', 'demo', 'terrain.bin'), TERRAIN);
    await writeFile(path.join(dist, '.env'), 'SECRET=1');
    await writeFile(path.join(tmp, 'secret.txt'), 'top secret');
    server = await startServer({ storage: new MemoryStorage(), secret: 's', port: 0, host: '127.0.0.1', clientDir: dist });
  });

  afterAll(async () => {
    await server.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('serves index.html on / without caching', async () => {
    const res = await fetch(server.url + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX);
  });

  it('caches hashed assets forever and compresses them', async () => {
    const res = await fetch(server.url + '/assets/index-AbC123.js', { headers: { 'accept-encoding': 'br, gzip' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(await res.text()).toBe(JS);
  });

  it('serves world data compressed with the right types', async () => {
    const json = await fetch(server.url + '/worlds/demo/world.json', { headers: { 'accept-encoding': 'gzip' } });
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(json.headers.get('content-encoding')).toBe('gzip');
    expect(json.headers.get('cache-control')).toBe('no-cache');
    expect(await json.text()).toBe(WORLD);

    const bin = await fetch(server.url + '/worlds/demo/terrain.bin', { headers: { 'accept-encoding': 'br' } });
    expect(bin.headers.get('content-type')).toBe('application/octet-stream');
    expect(bin.headers.get('content-encoding')).toBe('br');
    expect(Number(bin.headers.get('content-length'))).toBeLessThan(TERRAIN.length);
    expect(Buffer.from(await bin.arrayBuffer()).equals(TERRAIN)).toBe(true);

    const plain = await fetch(server.url + '/worlds/demo/terrain.bin', { headers: { 'accept-encoding': 'identity' } });
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(Number(plain.headers.get('content-length'))).toBe(TERRAIN.length);
    expect(Buffer.from(await plain.arrayBuffer()).equals(TERRAIN)).toBe(true);

    const manifest = await fetch(server.url + '/manifest.webmanifest');
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json; charset=utf-8');
  });

  it('answers conditional requests with 304 and HEAD without a body', async () => {
    const first = await fetch(server.url + '/worlds/demo/world.json');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"/);
    const again = await fetch(server.url + '/worlds/demo/world.json', { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    const head = await fetch(server.url + '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('falls back to index.html only for navigations without extension', async () => {
    const nav = await fetch(server.url + '/fahren', { headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(nav.status).toBe(200);
    expect(await nav.text()).toBe(INDEX);
    expect((await fetch(server.url + '/fahren')).status).toBe(404);
    expect((await fetch(server.url + '/assets/missing.js', { headers: { accept: 'text/html' } })).status).toBe(404);
    expect((await fetch(server.url + '/worlds/nope/world.json')).status).toBe(404);
  });

  it('blocks path traversal and dotfiles', async () => {
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%5c..%5csecret.txt', '/.env', '/%00index.html']) {
      const res = await rawGet(server.url, p);
      expect(res.status, p).toBeGreaterThanOrEqual(400);
      expect(res.body, p).not.toContain('top secret');
      expect(res.body, p).not.toContain('SECRET=1');
    }
  });

  it('keeps the API and the WebSocket on their paths', async () => {
    const health = await fetch(server.url + '/api/health', { headers: { accept: 'text/html' } });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const missing = await fetch(server.url + '/api/nope', { headers: { accept: 'text/html' } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
    expect((await fetch(server.url + '/api/auth/login', { method: 'POST', body: '{}' })).status).toBe(401);

    const ws = new WebSocket(server.url.replace('http', 'ws') + '/ws');
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.close();
  });
});

describe('resolveClientDist', () => {
  it('uses CLIENT_DIST, can be switched off and finds the build next to the bundle', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'velo-dist-'));
    try {
      await mkdir(path.join(tmp, 'public'));
      await writeFile(path.join(tmp, 'public', 'index.html'), INDEX);
      const bundle = pathToFileURL(path.join(tmp, 'server.mjs')).href;
      expect(resolveClientDist({}, bundle)).toBe(path.join(tmp, 'public'));
      expect(resolveClientDist({ CLIENT_DIST: path.join(tmp, 'public') }, bundle)).toBe(path.join(tmp, 'public'));
      expect(resolveClientDist({ CLIENT_DIST: path.join(tmp, 'nope') }, bundle)).toBeUndefined();
      expect(resolveClientDist({ CLIENT_DIST: 'off' }, bundle)).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('maps file extensions to content types', () => {
    expect(contentType('a.wasm')).toBe('application/wasm');
    expect(contentType('a.woff2')).toBe('font/woff2');
    expect(contentType('a.svg')).toBe('image/svg+xml');
    expect(contentType('a.png')).toBe('image/png');
    expect(contentType('a.unknown')).toBe('application/octet-stream');
  });
});
