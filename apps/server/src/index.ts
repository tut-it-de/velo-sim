import { randomBytes } from 'node:crypto';
import { startServer } from './server';
import { MemoryStorage } from './storage/memory';
import { PostgresStorage } from './storage/postgres';
import type { Storage } from './storage/types';

const port = Number(process.env.PORT ?? 8080);
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

const server = await startServer({ storage, secret, port });
console.log(`Velo-Sim-Server läuft auf ${server.url} (API /api, WebSocket /ws)`);

const shutdown = async () => {
  console.log('Fahre herunter …');
  await server.close();
  await storage.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
