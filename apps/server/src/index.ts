import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from './server';
import { resolveClientDist } from './static';
import { MemoryStorage } from './storage/memory';
import { PostgresStorage } from './storage/postgres';
import type { Storage } from './storage/types';

const port = Number(process.env.PORT ?? 8080);
const certDir = fileURLToPath(new URL('../certs/', import.meta.url));
const defaultCert = `${certDir}cert.pem`;
const defaultKey = `${certDir}key.pem`;
const databaseUrl = process.env.DATABASE_URL;
let secret = process.env.JWT_SECRET;

if (!secret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('JWT_SECRET fehlt – in Produktion zwingend erforderlich.');
    process.exit(1);
  }
  secret = randomBytes(32).toString('hex');
  console.warn('⚠ JWT_SECRET nicht gesetzt – zufälliger Schlüssel, Logins gelten nur bis zum Neustart.');
}

let storage: Storage;
if (databaseUrl) {
  storage = await PostgresStorage.connect(databaseUrl);
  console.log('Datenbank: PostgreSQL');
} else {
  storage = new MemoryStorage();
  console.warn('⚠ DATABASE_URL nicht gesetzt – Daten nur im Speicher (Entwicklung).');
}

const strava =
  process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET
    ? {
        clientId: process.env.STRAVA_CLIENT_ID,
        clientSecret: process.env.STRAVA_CLIENT_SECRET,
        publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
        apiBase: process.env.STRAVA_API_BASE,
      }
    : undefined;
console.log(strava ? `Strava: aktiv (Callback ${strava.publicUrl}/api/strava/callback)` : 'Strava: nicht eingerichtet (STRAVA_CLIENT_ID/SECRET fehlen)');

const clientDir = resolveClientDist();
console.log(
  clientDir
    ? `Web-Client: ${clientDir}`
    : 'Web-Client: kein Build gefunden (npm run build -w @velo/client oder CLIENT_DIST setzen) – nur API/WebSocket',
);

// HTTPS next to HTTP (TLS_CERT/TLS_KEY = PEM files): browsers allow Web Bluetooth only on https:// or localhost,
// so phones and tablets in the LAN need it. npm run cert creates a self-signed pair in apps/server/certs.
const tlsCert = process.env.TLS_CERT ?? (existsSync(defaultCert) ? defaultCert : undefined);
const tlsKey = process.env.TLS_KEY ?? (existsSync(defaultKey) ? defaultKey : undefined);
const tls =
  tlsCert && tlsKey
    ? { port: Number(process.env.HTTPS_PORT ?? 8443), cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }
    : undefined;

const server = await startServer({ storage, secret, port, strava, clientDir, tls });
console.log(`Velo-Sim-Server läuft auf ${server.url} (${clientDir ? 'App /, ' : ''}API /api, WebSocket /ws)`);
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i!.address);
for (const ip of lan) {
  console.log(`Im Netzwerk: http://${ip}:${port}` + (server.httpsUrl ? `  ·  https://${ip}:${tls!.port} (Bluetooth)` : ''));
}
if (!server.httpsUrl) console.log('HTTPS: aus (npm run cert -w @velo/server erzeugt ein Zertifikat – nötig für Bluetooth auf anderen Geräten)');

const shutdown = async () => {
  console.log('Fahre herunter …');
  await server.close();
  await storage.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
