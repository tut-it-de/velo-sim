import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, parseClientMessage, type ServerMessage } from '@velo/protocol';
import { verifyToken } from './auth';
import { GroupRegistry, GroupRoom } from './groups';
import { handleHttp } from './http';
import { Game, type Connection, type Rider, type Room } from './rooms';
import { createStaticHandler } from './static';
import type { Storage } from './storage/types';
import type { StravaConfig } from './strava';
import { StravaService } from './stravaService';

export interface VeloServerOptions {
  storage: Storage;
  secret: string;
  port?: number;
  host?: string;
  strava?: StravaConfig & { pollIntervalMs?: number; pollAttempts?: number };
  /** Built web client (apps/client/dist) to serve on / — omitted: API and WebSocket only. */
  clientDir?: string;
  /** Also serve everything over HTTPS on this port, e.g. so phones in the LAN may use Web Bluetooth (secure context only). */
  /** Group ride countdown after the host's start (tests use a short one). */
  groupCountdownMs?: number;
  tls?: { port: number; cert: string | Buffer; key: string | Buffer; /** DER root, offered for download on /velo-ca.crt. */ ca?: Buffer };
}

export interface VeloServer {
  http: Server;
  https?: Server;
  game: Game;
  url: string;
  httpsUrl?: string;
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

/** API paths stay with the JSON handler (incl. its 404s), everything else may be a client file. */
const isApiPath = (url = '/') => /^\/(api|ws)(\/|\?|$)/.test(url);

/** HTTP API on /api/*, game WebSocket on /ws, optionally the web client on everything else. */
export async function startServer(opts: VeloServerOptions): Promise<VeloServer> {
  const game = new Game({ storage: opts.storage });
  const strava = opts.strava ? new StravaService(opts.strava, opts.storage, opts.secret) : undefined;
  const groups = new GroupRegistry(game, opts.storage, opts.groupCountdownMs);
  const ctx = { storage: opts.storage, secret: opts.secret, game, strava, groups };
  const client = opts.clientDir ? createStaticHandler(opts.clientDir) : undefined;
  const onRequest: RequestListener = (req, res) => {
    if (opts.tls?.ca && req.url === '/velo-ca.crt') {
      res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="velo-ca.crt"' });
      res.end(opts.tls.ca);
      return;
    }
    if (client && (req.method === 'GET' || req.method === 'HEAD') && !isApiPath(req.url)) {
      void client.serve(req, res).catch((err) => {
        console.error('[static]', err);
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
      return;
    }
    void handleHttp(ctx, req, res);
  };
  const http = createServer(onRequest);
  const https = opts.tls ? createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }, onRequest) : undefined;
  const wss = new WebSocketServer({ noServer: true, path: '/ws', maxPayload: 8 * 1024 });
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!wss.shouldHandle(req)) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  http.on('upgrade', onUpgrade);
  https?.on('upgrade', onUpgrade);

  wss.on('connection', (ws) => {
    const conn = wsConnection(ws);
    let joined: { rider: Rider; room: Room } | null = null;
    let leaving = false;
    let joining = false;
    // Clients must say hello within 10 s.
    const helloTimer = setTimeout(() => !joined && ws.close(4000, 'hello timeout'), 10_000);

    const leave = async () => {
      if (!joined || leaving) return;
      leaving = true;
      try {
        const summary = joined.room instanceof GroupRoom ? await groups.leave(joined.room, joined.rider) : await game.leave(joined.room, joined.rider);
        if (summary) conn.send({ type: 'rideSummary', summary });
      } catch (err) {
        console.error('[game] ride booking failed', err);
      }
    };

    ws.on('message', async (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      if (!joined) {
        if (msg.type !== 'hello' || joining) return;
        if (msg.v !== PROTOCOL_VERSION) {
          conn.send({ type: 'error', message: 'Bitte die App aktualisieren (Protokollversion).' });
          ws.close(4001, 'protocol');
          return;
        }
        let user: { id: string; name: string } | undefined;
        joining = true;
        if (msg.token) {
          const payload = verifyToken(msg.token, opts.secret);
          const u = payload ? await opts.storage.getUser(payload.sub) : undefined;
          if (u) user = { id: u.id, name: u.name };
        }
        clearTimeout(helloTimer);
        joined = msg.groupId ? await groups.join(conn, msg, user) : game.join(conn, msg, user);
        joining = false;
        if (!joined) ws.close(msg.groupId ? 4003 : 4002, msg.groupId ? 'group' : 'route');
        else if (ws.readyState !== ws.OPEN) void leave(); // closed while joining
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
  groups.start();
  await new Promise<void>((resolve) => http.listen(opts.port ?? 8080, opts.host ?? '0.0.0.0', resolve));
  const addr = http.address() as AddressInfo;
  const hostName = (a: AddressInfo) => (a.address === '0.0.0.0' || a.address === '::' ? 'localhost' : a.address);
  const url = `http://${hostName(addr)}:${addr.port}`;
  let httpsUrl: string | undefined;
  if (https && opts.tls) {
    await new Promise<void>((resolve) => https.listen(opts.tls!.port, opts.host ?? '0.0.0.0', resolve));
    const a = https.address() as AddressInfo;
    httpsUrl = `https://${hostName(a)}:${a.port}`;
  }

  return {
    http,
    https,
    game,
    url,
    httpsUrl,
    async close() {
      game.stop();
      groups.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (https) await new Promise<void>((resolve) => https.close(() => resolve()));
    },
  };
}
