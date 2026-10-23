import type { IncomingMessage, ServerResponse } from 'node:http';
import { getItem, itemName } from '@velo/equipment';
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth';
import type { Game } from './rooms';
import { StravaError } from './strava';
import { callbackPage, type StravaService } from './stravaService';
import { DuplicateEmailError, type Storage, type User } from './storage/types';

export interface ApiContext {
  storage: Storage;
  secret: string;
  game: Game;
  /** Undefined when STRAVA_CLIENT_ID/SECRET are not configured. */
  strava?: StravaService;
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
const MAX_FIT_BYTES = 6 * 1024 * 1024;
const MAX_ACTIVITY_META = 64 * 1024;
const ACTIVITY_PAGE = 200;
const ACTIVITY_ID_RE = /^[\w.-]{1,100}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'Anfrage zu groß');
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

/** Admins come from ADMIN_EMAILS (comma-separated) on the server – the app cannot make itself admin. */
export const isAdmin = (email: string, list = process.env.ADMIN_EMAILS ?? '') =>
  list
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .includes(email.trim().toLowerCase()) && !!email.trim();
const publicUser = (u: User) => ({ id: u.id, name: u.name, email: u.email, admin: isAdmin(u.email) });

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
    // Behind Caddy (TRUST_PROXY=1) every request comes from the proxy; Caddy puts the real client IP in X-Forwarded-For.
    const forwarded = process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    const ip = forwarded || req.socket.remoteAddress || 'unknown';

    if (url.pathname.startsWith('/api/strava/')) return await handleStrava(ctx, req, res, url);

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
        return send(res, 200, { user: publicUser(user), garage: await ctx.storage.getGarage(user.id), fitness: (await ctx.storage.getFitness(user.id)) ?? null });
      }

      case 'POST /api/me/fitness': {
        const user = await requireUser(ctx, req);
        const b = await readJson(req);
        const ftp = Number(b.ftp);
        const state = b.state as { updatedAt?: unknown } | undefined;
        if (!Number.isFinite(ftp) || ftp < 0 || ftp > 2000 || !state || typeof state !== 'object' || typeof state.updatedAt !== 'number') {
          throw new HttpError(400, 'Ungültige FTP-Daten');
        }
        if (JSON.stringify(state).length > 64_000) throw new HttpError(413, 'FTP-Daten zu groß');
        // The newer side wins – an older device must not overwrite a newer FTP.
        const current = (await ctx.storage.getFitness(user.id)) as { state?: { updatedAt?: number } } | undefined;
        if ((current?.state?.updatedAt ?? 0) <= state.updatedAt) await ctx.storage.setFitness(user.id, { ftp: Math.round(ftp), state });
        return send(res, 200, { fitness: (await ctx.storage.getFitness(user.id)) ?? null });
      }

      case 'POST /api/me/name': {
        const user = await requireUser(ctx, req);
        const name = String((await readJson(req)).name ?? '').trim().slice(0, 24);
        if (name.length < 2) throw new HttpError(400, 'Der Name muss mindestens 2 Zeichen haben');
        await ctx.storage.setUserName(user.id, name);
        return send(res, 200, { user: publicUser({ ...user, name }) });
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
        if (item.price > 0 && !garage.owned.includes(item.id)) throw new HttpError(403, 'Artikel nicht in deiner Garage');
        await ctx.storage.setLoadout(user.id, { ...garage.loadout, [item.type]: item.id });
        return send(res, 200, { garage: await ctx.storage.getGarage(user.id) });
      }

      case 'GET /api/rides': {
        const user = await requireUser(ctx, req);
        return send(res, 200, { rides: await ctx.storage.listRides(user.id, 50) });
      }

      case 'POST /api/activities': {
        const user = await requireUser(ctx, req);
        const b = await readJson(req, Math.ceil(MAX_FIT_BYTES * 1.4) + MAX_ACTIVITY_META);
        const id = String(b.id ?? '');
        const startTime = Number(b.startTime);
        if (!ACTIVITY_ID_RE.test(id) || !Number.isFinite(startTime) || startTime <= 0) throw new HttpError(400, 'Ungültige Aktivität');
        if (!b.meta || typeof b.meta !== 'object' || JSON.stringify(b.meta).length > MAX_ACTIVITY_META) throw new HttpError(400, 'Ungültige Aktivitätsdaten');
        let fit: Uint8Array | undefined;
        if (b.fit !== undefined) {
          const buf = Buffer.from(String(b.fit), 'base64');
          if (buf.length > MAX_FIT_BYTES || buf.length < 14 || buf.subarray(8, 12).toString('latin1') !== '.FIT') throw new HttpError(400, 'Keine gültige FIT-Datei');
          fit = new Uint8Array(buf);
        }
        const rec = await ctx.storage.saveActivity(user.id, { id, startTime, meta: b.meta, fit });
        return send(res, 200, { id: rec.id, cursor: rec.updatedAt });
      }

      case 'GET /api/activities': {
        const user = await requireUser(ctx, req);
        const since = Number(url.searchParams.get('since') ?? 0) || 0;
        const list = await ctx.storage.listActivities(user.id, since, ACTIVITY_PAGE);
        return send(res, 200, {
          activities: list.map((a) => ({ id: a.id, startTime: a.startTime, meta: a.meta, deleted: a.deleted, hasFit: a.hasFit })),
          cursor: list.length ? list[list.length - 1]!.updatedAt : since,
          more: list.length === ACTIVITY_PAGE,
        });
      }

      default: {
        const m = /^(GET|POST) \/api\/activities\/([^/]+)\/(fit|delete)$/.exec(route);
        if (m) {
          const user = await requireUser(ctx, req);
          const id = decodeURIComponent(m[2]!);
          if (!ACTIVITY_ID_RE.test(id)) throw new HttpError(400, 'Ungültige Aktivität');
          if (m[1] === 'GET' && m[3] === 'fit') {
            const fit = await ctx.storage.getActivityFit(user.id, id);
            if (!fit) throw new HttpError(404, 'Keine FIT-Datei');
            return send(res, 200, { fit: Buffer.from(fit).toString('base64') });
          }
          if (m[1] === 'POST' && m[3] === 'delete') {
            await ctx.storage.deleteActivity(user.id, id);
            return send(res, 200, { ok: true });
          }
        }
        throw new HttpError(404, 'Nicht gefunden');
      }
    }
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (err instanceof StravaError) return send(res, err.status === 401 || err.status === 409 ? 409 : 502, { error: err.message });
    console.error('[http]', err);
    return send(res, 500, { error: 'Interner Fehler' });
  }
}


async function handleStrava(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const strava = ctx.strava;
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/strava/callback') {
    const result = strava ? await strava.handleCallback(url.searchParams) : { ok: false, message: 'Strava ist auf diesem Server nicht eingerichtet.' };
    res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(callbackPage(result.ok, result.message));
    return;
  }

  const user = await requireUser(ctx, req);
  if (route === 'GET /api/strava/status') {
    return send(res, 200, strava ? await strava.status(user.id) : { configured: false, connected: false });
  }
  if (!strava) throw new HttpError(501, 'Strava ist auf diesem Server nicht eingerichtet (STRAVA_CLIENT_ID/SECRET fehlen).');

  switch (route) {
    case 'POST /api/strava/connect':
      return send(res, 200, { url: strava.connectUrl(user.id) });
    case 'POST /api/strava/settings': {
      const b = await readJson(req);
      await strava.setAutoUpload(user.id, b.autoUpload === true);
      return send(res, 200, await strava.status(user.id));
    }
    case 'POST /api/strava/disconnect':
      await strava.disconnect(user.id);
      return send(res, 200, await strava.status(user.id));
    case 'POST /api/strava/upload': {
      const b = await readJson(req, Math.ceil(MAX_FIT_BYTES * 1.4));
      const fit = Buffer.from(String(b.fit ?? ''), 'base64');
      if (fit.length < 14 || fit.subarray(8, 12).toString('latin1') !== '.FIT') throw new HttpError(400, 'Keine gültige FIT-Datei');
      const externalId = String(b.externalId ?? '').replace(/[^\w.-]/g, '').slice(0, 80) || `velo-sim-${Date.now()}`;
      const result = await strava.upload(user.id, new Uint8Array(fit), {
        name: String(b.name ?? 'Velo Sim Fahrt').slice(0, 120),
        description: b.description ? String(b.description).slice(0, 2000) : undefined,
        externalId,
      });
      return send(res, 200, result);
    }
    default: {
      const m = /^GET \/api\/strava\/upload\/(\d+)$/.exec(route);
      if (m) return send(res, 200, await strava.uploadStatus(user.id, Number(m[1])));
      throw new HttpError(404, 'Nicht gefunden');
    }
  }
}
