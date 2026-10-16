import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveServerBase, sameOriginServer, webSocketUrl } from './serverUrl';

const capacitor = vi.hoisted(() => ({ native: false }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => capacitor.native } }));

const at = (url: string) => vi.stubGlobal('location', new URL(url));

describe('same-origin server default', () => {
  beforeEach(() => {
    vi.stubEnv('DEV', false);
    capacitor.native = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses the page origin when served over http(s) by the game server', () => {
    at('https://velo.example.de/');
    expect(sameOriginServer()).toBe('https://velo.example.de');
    expect(resolveServerBase('')).toBe('https://velo.example.de');
    expect(resolveServerBase('  ')).toBe('https://velo.example.de');
    expect(webSocketUrl('')).toBe('wss://velo.example.de/ws');

    at('http://192.168.1.20:8080/');
    expect(resolveServerBase('')).toBe('http://192.168.1.20:8080');
    expect(webSocketUrl('')).toBe('ws://192.168.1.20:8080/ws');

    at('http://localhost:8080/');
    expect(sameOriginServer()).toBe('http://localhost:8080');
  });

  it('keeps an explicitly configured server', () => {
    at('https://velo.example.de/');
    expect(resolveServerBase(' https://anderer-server.de/ ')).toBe('https://anderer-server.de');
    expect(webSocketUrl('http://localhost:8080/')).toBe('ws://localhost:8080/ws');
    expect(webSocketUrl('https://anderer-server.de')).toBe('wss://anderer-server.de/ws');
  });

  it('stays offline by default in dev, preview, Electron and the iPad app', () => {
    at('http://localhost:5173/');
    expect(sameOriginServer()).toBe('');
    at('http://localhost:4173/');
    expect(sameOriginServer()).toBe('');
    at('app://velo/index.html');
    expect(resolveServerBase('')).toBe('');
    at('capacitor://localhost/');
    expect(resolveServerBase('')).toBe('');
    at('file:///C:/velo/index.html');
    expect(resolveServerBase('')).toBe('');

    at('https://localhost/');
    capacitor.native = true;
    expect(sameOriginServer()).toBe('');
    capacitor.native = false;

    vi.stubGlobal('window', { veloDesktop: { platform: 'win32' } });
    expect(sameOriginServer()).toBe('');
    vi.stubGlobal('window', {});

    vi.stubEnv('DEV', true);
    at('http://192.168.1.20:5174/');
    expect(sameOriginServer()).toBe('');
  });
});
