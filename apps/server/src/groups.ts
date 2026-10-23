import { randomInt } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ClientMessage, GroupStateDTO } from '@velo/protocol';
import { ROUTES } from '@velo/routes';
import { HttpError, readJson, requireUser, send, type ApiContext } from './http';
import { Room, newRider, type Connection, type Game, type Rider } from './rooms';
import type { GroupRideRecord, GroupRidePatch, Storage } from './storage/types';

/**
 * Group rides: a private room per invite code (no bots, no strangers), a lobby with a countdown,
 * one common start, and the group position (median distance) for the client's "stay together" help.
 */

export const GROUP_CAPACITY = 50;
/** Countdown after the host presses start. */
export const GROUP_COUNTDOWN_MS = 10_000;
/** Riders who sent nothing for this long (paused, gone) do not count for the group position. */
const ACTIVE_MS = 3000;
const TICK_HZ = 4;
const MAX_PLAN_AHEAD_MS = 14 * 24 * 3600_000;
/** A ride that never ended counts as over after this long. */
const MAX_AGE_MS = 24 * 3600_000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function groupCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}

/** Median of the active riders' distances and speeds; undefined when nobody is riding. */
export function groupCenter(riders: Iterable<Pick<Rider, 'd' | 'v' | 'updatedAt'>>, now: number): { d: number; v: number; n: number } | undefined {
  const active = [...riders].filter((r) => r.updatedAt > 0 && now - r.updatedAt < ACTIVE_MS);
  if (!active.length) return undefined;
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  return { d: median(active.map((r) => r.d)), v: median(active.map((r) => r.v)), n: active.length };
}

export class GroupRoom extends Room {
  constructor(
    public group: GroupRideRecord,
    private readonly storage: Storage,
    private readonly countdownMs = GROUP_COUNTDOWN_MS,
  ) {
    super(group.routeId);
  }

  private get hostPresent(): boolean {
    return [...this.riders.values()].some((r) => r.userId === this.group.hostUserId);
  }

  state(startD?: number): GroupStateDTO {
    return {
      ...this.group,
      members: [...this.riders.values()].map((r) => ({ id: r.id, name: r.name, country: r.country, host: r.userId === this.group.hostUserId })),
      startD,
    };
  }

  private patch(p: GroupRidePatch): void {
    this.group = { ...this.group, ...p };
    this.storage.updateGroupRide(this.group.id, p).catch((err) => console.error('[groups] update failed', err));
  }

  override join(r: Rider, authenticated: boolean): void {
    r.telemetry.noLapBonus = this.group.together;
    let startD: number | undefined;
    if (this.group.status === 'riding') {
      // Late rider: starts where the group is now.
      startD = groupCenter(this.riders.values(), Date.now())?.d ?? 0;
      const t = r.telemetry;
      r.d = startD;
      t.baseDistance = t.lastDistance = t.maxDistance = startD;
    }
    super.join(r, authenticated);
    r.conn.send({ type: 'group', group: this.state(startD) });
    this.broadcast({ type: 'group', group: this.state() }, r.id);
  }

  override leave(id: string): Rider | undefined {
    const r = super.leave(id);
    if (r) this.broadcast({ type: 'group', group: this.state() });
    return r;
  }

  override handle(r: Rider, msg: ClientMessage, now = Date.now()): void {
    const isHost = r.userId === this.group.hostUserId;
    switch (msg.type) {
      case 'groupStart':
        // Without the host in the lobby, anyone may start.
        if (this.group.status !== 'lobby' || (!isHost && this.hostPresent)) return;
        if (this.group.startAt !== null && this.group.startAt - now <= this.countdownMs) return;
        this.patch({ startAt: now + this.countdownMs });
        this.broadcast({ type: 'group', group: this.state() });
        return;
      case 'groupEnd':
        if (!isHost || this.group.status === 'ended') return;
        this.patch({ status: 'ended' });
        this.broadcast({ type: 'group', group: this.state() });
        return;
      case 'state':
        // Nobody moves in the lobby.
        if (this.group.status !== 'riding') return;
        return super.handle(r, msg, now);
      default:
        return super.handle(r, msg, now);
    }
  }

  /** Common start: everyone at 0 m, the server's ride recording starts now. */
  private begin(now: number): void {
    this.patch({ status: 'riding', startedAt: now });
    for (const r of this.riders.values()) {
      r.d = r.v = r.p = r.c = 0;
      r.updatedAt = 0;
      const t = r.telemetry;
      Object.assign(t, { startedAt: now, lastAt: now, kilojoules: 0, maxDistance: 0, lastDistance: 0, lastSpeed: 0, window: [], baseDistance: 0 });
      t.flags.clear();
    }
    this.broadcast({ type: 'group', group: this.state() });
  }

  override tick(now = Date.now()): void {
    if (this.group.status === 'lobby' && this.group.startAt !== null && now >= this.group.startAt) this.begin(now);
    super.tick(now);
    if (this.group.status !== 'riding') return;
    const c = groupCenter(this.riders.values(), now);
    if (c) this.broadcast({ type: 'groupPos', t: now, d: Math.round(c.d * 10) / 10, v: Math.round(c.v * 100) / 100, n: c.n });
  }
}

/** All live group rooms (by invite code). Group rides need a login. */
export class GroupRegistry {
  private readonly rooms = new Map<string, GroupRoom>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly game: Game,
    private readonly storage: Storage,
    private readonly countdownMs = GROUP_COUNTDOWN_MS,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const room of this.rooms.values()) room.tick(now);
    }, 1000 / TICK_HZ);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  room(id: string): GroupRoom | undefined {
    return this.rooms.get(id);
  }

  async join(conn: Connection, hello: Extract<ClientMessage, { type: 'hello' }>, user?: { id: string; name: string }): Promise<{ rider: Rider; room: GroupRoom } | null> {
    const fail = (message: string) => {
      conn.send({ type: 'error', message });
      return null;
    };
    if (!user) return fail('Gruppenfahrten gibt es nur angemeldet.');
    const id = hello.groupId ?? '';
    let room = this.rooms.get(id);
    const group = room?.group ?? (await this.storage.getGroupRide(id));
    if (!group) return fail('Gruppenfahrt nicht gefunden – stimmt der Code?');
    if (group.status === 'ended' || Date.now() - (group.startedAt ?? group.startAt ?? group.createdAt) > MAX_AGE_MS) return fail('Diese Gruppenfahrt ist schon vorbei.');
    room = this.rooms.get(id); // may have been created while loading
    if (!room) this.rooms.set(id, (room = new GroupRoom(group, this.storage, this.countdownMs)));
    if (room.size >= GROUP_CAPACITY) return fail('Die Gruppe ist voll.');
    const rider = newRider(conn, { ...hello, routeId: group.routeId }, user);
    room.join(rider, true);
    return { rider, room };
  }

  async leave(room: GroupRoom, rider: Rider) {
    const summary = await this.game.leave(room, rider);
    if (room.size === 0) this.rooms.delete(room.group.id);
    return summary;
  }
}

/** /api/groups: create a group ride, look one up by its code. */
export async function handleGroups(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const user = await requireUser(ctx, req);
  const route = `${req.method} ${url.pathname}`;
  if (route === 'POST /api/groups') {
    const b = await readJson(req);
    const routeId = String(b.routeId ?? '');
    if (!ROUTES.some((r) => r.id === routeId)) throw new HttpError(400, 'Unbekannte Strecke');
    const name = String(b.name ?? '').trim().slice(0, 40) || `Gruppenfahrt von ${user.name}`;
    const now = Date.now();
    let startAt: number | null = null;
    if (b.startAt !== undefined && b.startAt !== null) {
      startAt = Number(b.startAt);
      if (!Number.isFinite(startAt) || startAt < now - 60_000 || startAt > now + MAX_PLAN_AHEAD_MS) throw new HttpError(400, 'Ungültige Startzeit');
      startAt = Math.max(startAt, now + GROUP_COUNTDOWN_MS);
    }
    for (let i = 0; i < 5; i++) {
      const group: GroupRideRecord = {
        id: groupCode(),
        name,
        routeId,
        hostUserId: user.id,
        hostName: user.name,
        startAt,
        together: b.together !== false,
        status: 'lobby',
        createdAt: now,
      };
      if (await ctx.storage.createGroupRide(group)) return send(res, 201, { group });
    }
    throw new HttpError(503, 'Kein freier Code – bitte nochmal versuchen');
  }
  const m = /^GET \/api\/groups\/([A-Za-z0-9]{1,12})$/.exec(route);
  if (m) {
    const id = m[1]!.toUpperCase();
    const live = ctx.groups?.room(id);
    const group = live?.group ?? (await ctx.storage.getGroupRide(id));
    if (!group) throw new HttpError(404, 'Gruppenfahrt nicht gefunden – stimmt der Code?');
    return send(res, 200, { group: live ? live.state() : { ...group, members: [] } });
  }
  throw new HttpError(404, 'Nicht gefunden');
}
