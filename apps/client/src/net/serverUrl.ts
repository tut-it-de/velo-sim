import { Capacitor } from '@capacitor/core';

/** Vite dev server and `vite preview` – there the game server runs separately (npm run server). */
const DEV_PORTS = new Set(['5173', '4173']);

/**
 * The page's own origin when the app is served by the game server itself (browser deployment:
 * https://host/ → API https://host/api, WebSocket wss://host/ws). Empty where that does not apply:
 * Electron (app://), the iPad app (capacitor://), file://, the Vite dev server and `vite preview`.
 */
export function sameOriginServer(): string {
  if (import.meta.env.DEV || typeof location === 'undefined') return '';
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return '';
  if (Capacitor.isNativePlatform() || (typeof window !== 'undefined' && window.veloDesktop)) return '';
  if (DEV_PORTS.has(location.port)) return '';
  return location.origin;
}

/** Configured server address without trailing slashes; empty falls back to the same origin (see above). */
export function resolveServerBase(configured: string | undefined): string {
  return (configured ?? '').trim().replace(/\/+$/, '') || sameOriginServer();
}

/** ws:// for http://, wss:// for https:// (a page served over HTTPS may only open wss://). */
export function webSocketUrl(serverBase: string): string {
  const base = resolveServerBase(serverBase);
  return `${base.replace(/^http(s?):\/\//i, 'ws$1://')}/ws`;
}
