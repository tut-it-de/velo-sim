import type { IncomingMessage, ServerResponse } from 'node:http';
import { getItem, itemName } from '@velo/equipment';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth';
import type { Game } from './rooms';
import { DuplicateEmailError, type Storage, type User } from './storage/types';

export interface ApiContext {
  storage: Storage;
  secret: string;
  game: Game;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 16 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Anfrage zu groß');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'Ungültiges JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email });

/** Small fixed-window limiter for login/register (per IP). */
const attempts = new Map<string, { count: number; resetAt: number }>();
function limit(ip: string, max = 20, windowMs = 60_000): void {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (++a.count > max) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten');
}

async function requireUser(ctx: ApiContext, req: IncomingMessage): Promise<User> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? verifyToken(token, ctx.secret) : null;
  const user = payload ? await ctx.storage.getUser(payload.sub) : undefined;
  if (!user) throw new HttpError(401, 'Bitte anmelden');
  return user;
}

export async function handleHttp(ctx: ApiContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const ip = req.socket.remoteAddress ?? 'unknown';

    switch (route) {
      case 'GET /api/health':
        return send(res, 200, { ok: true, online: ctx.game.online() });

      case 'POST /api/auth/register': {
        limit(ip);
        const b = await readJson(req);
        const email = String(b.email ?? '').trim();
        const name = String(b.name ?? '').trim().slice(0, 24);
        const password = String(b.password ?? '');
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Bitte eine gültige E-Mail angeben');
        if (name.length < 2) throw new HttpError(400, 'Der Name muss mindestens 2 Zeichen haben');
        if (password.length < 8) throw new HttpError(400, 'Das Passwort muss mindestens 8 Zeichen haben');
        try {
          const user = await ctx.storage.createUser(email, name, await hashPassword(password));
          return send(res, 201, { token: signToken({ sub: user.id, name: user.name }, ctx.secret), user: publicUser(user) });
        } catch (err) {
          if (err instanceof DuplicateEmailError) throw new HttpError(409, 'Diese E-Mail ist schon registriert');
          throw err;
        }
      }

      case 'POST /api/auth/login': {
        limit(ip);
        const b = await readJson(req);
        const user = await ctx.storage.findUserByEmail(String(b.email ?? ''));
        if (!user || !(await verifyPassword(String(b.password ?? ''), user.passwordHash))) throw new HttpError(401, 'E-Mail oder Passwort falsch');
        return send(res, 200, { token: signToken({ sub: user.id, name: user.name }, ctx.secret), user: publicUser(user) });
      }

      case 'GET /api/me': {
        const user = await requireUser(ctx, req);
        return send(res, 200, { user: publicUser(user), garage: await ctx.storage.getGarage(user.id) });
      }

      case 'POST /api/garage/buy': {
        const user = await requireUser(ctx, req);
        const b = await readJson(req);
        const item = getItem(String(b.itemId ?? ''));
        if (!item) throw new HttpError(404, 'Unbekannter Artikel');
        const result = await ctx.storage.buy(user.id, item.id, item.price, `Kauf: ${itemName(item)}`);
        if (!result.ok) throw new HttpError(409, result.error);
        return send(res, 200, { garage: await ctx.storage.getGarage(user.id) });
      }

      case 'POST /api/garage/equip': {
        const user = await requireUser(ctx, req);
        const b = await readJson(req);
        const item = getItem(String(b.itemId ?? ''));
        if (!item) throw new HttpError(404, 'Unbekannter Artikel');
        const garage = await ctx.storage.getGarage(user.id);
        if (!garage.owned.includes(item.id)) throw new HttpError(403, 'Artikel nicht in deiner Garage');
        await ctx.storage.setLoadout(user.id, { ...garage.loadout, [item.type]: item.id });
        return send(res, 200, { garage: await ctx.storage.getGarage(user.id) });
      }

      case 'GET /api/rides': {
        const user = await requireUser(ctx, req);
        return send(res, 200, { rides: await ctx.storage.listRides(user.id, 50) });
      }

      default:
        throw new HttpError(404, 'Nicht gefunden');
    }
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error('[http]', err);
    return send(res, 500, { error: 'Interner Fehler' });
  }
}
