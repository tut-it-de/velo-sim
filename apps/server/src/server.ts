import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from '@velo/protocol';
import { verifyToken } from './auth';
import { handleHttp } from './http';
import { Game, type Connection, type Rider, type Room } from './rooms';
import type { Storage } from './storage/types';
import type { StravaConfig } from './strava';
import { StravaService } from './stravaService';

export interface VeloServerOptions {
  storage: Storage;
  secret: string;
  port?: number;
  host?: string;
  strava?: StravaConfig & { pollIntervalMs?: number; pollAttempts?: number };
}

export interface VeloServer {
  http: Server;
  game: Game;
  url: string;
  close(): Promise<void>;
}

function wsConnection(ws: WebSocket): Connection {
  return {
    send(msg: ServerMessage) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    get open() {
      return ws.readyState === ws.OPEN;
    },
  };
}

/** HTTP API on /api/*, game WebSocket on /ws. */
export async function startServer(opts: VeloServerOptions): Promise<VeloServer> {
  const game = new Game({ storage: opts.storage });
  const strava = opts.strava ? new StravaService(opts.strava, opts.storage, opts.secret) : undefined;
  const ctx = { storage: opts.storage, secret: opts.secret, game, strava };
  const http = createServer((req, res) => void handleHttp(ctx, req, res));
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 8 * 1024 });

  wss.on('connection', (ws) => {
    const conn = wsConnection(ws);
    let joined: { rider: Rider; room: Room } | null = null;
    let leaving = false;
    // Clients must say hello within 10 s.
    const helloTimer = setTimeout(() => !joined && ws.close(4000, 'hello timeout'), 10_000);

    const leave = async () => {
      if (!joined || leaving) return;
      leaving = true;
      try {
        const summary = await game.leave(joined.room, joined.rider);
        if (summary) conn.send({ type: 'rideSummary', summary });
      } catch (err) {
        console.error('[game] ride booking failed', err);
      }
    };

    ws.on('message', async (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      if (!joined) {
        if (msg.type !== 'hello') return;
        if (msg.v !== PROTOCOL_VERSION) {
          conn.send({ type: 'error', message: 'Bitte die App aktualisieren (Protokollversion).' });
          ws.close(4001, 'protocol');
          return;
        }
        let user: { id: string; name: string } | undefined;
        if (msg.token) {
          const payload = verifyToken(msg.token, opts.secret);
          const u = payload ? await opts.storage.getUser(payload.sub) : undefined;
          if (u) user = { id: u.id, name: u.name };
        }
        clearTimeout(helloTimer);
        joined = game.join(conn, msg, user);
        if (!joined) ws.close(4002, 'route');
        return;
      }
      if (msg.type === 'bye') {
        await leave();
        ws.close(1000, 'bye');
        return;
      }
      joined.room.handle(joined.rider, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      void leave();
    });
  });

  game.start();
  await new Promise<void>((resolve) => http.listen(opts.port ?? 8080, opts.host ?? '0.0.0.0', resolve));
  const addr = http.address() as AddressInfo;
  const url = `http://${addr.address === '0.0.0.0' || addr.address === '::' ? 'localhost' : addr.address}:${addr.port}`;

  return {
    http,
    game,
    url,
    async close() {
      game.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
