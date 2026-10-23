import { randomUUID } from 'node:crypto';
import { rideEarnings, total } from '@velo/equipment';
import { encodeTuple, type ClientMessage, type LoadoutDTO, type RiderInfo, type RideSummaryDTO, type ServerMessage } from '@velo/protocol';
import { ROUTES, getTrack } from '@velo/routes';
import type { Storage } from './storage/types';

export interface Connection {
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
  readonly open: boolean;
}

interface Telemetry {
  startedAt: number;
  lastAt: number;
  kilojoules: number;
  maxDistance: number;
  lastDistance: number;
  lastSpeed: number;
  window: Array<[number, number]>;
  flags: Set<string>;
  /** Where the ride started (late riders join a group ride mid-way): only the distance beyond counts. */
  baseDistance?: number;
  /** Group ride with speed help: Taler only from kJ, no lap bonuses (laps are helped along). */
  noLapBonus?: boolean;
}

export interface Rider {
  id: string;
  userId?: string;
  name: string;
  country?: string;
  loadout: LoadoutDTO;
  weightKg: number;
  bot: boolean;
  /** The client rides with the built-in simulator — never earns coins. */
  simulated: boolean;
  conn: Connection;
  d: number;
  v: number;
  lat: number;
  p: number;
  c: number;
  updatedAt: number;
  lastChatAt: number;
  lastEmoteAt: number;
  telemetry: Telemetry;
}

export const ROOM_CAPACITY = 300;
const SNAPSHOT_HZ = 4;
const NEAR_M = 800;
const MAX_POWER = 2500;
const MAX_WKG_60S = 10;
const MAX_SPEED = 28;

/** One shard of a route: relays positions, chat and kudos between riders. */
export class Room {
  readonly id = randomUUID().slice(0, 8);
  readonly riders = new Map<string, Rider>();
  private tickCount = 0;
  readonly trackLength: number;

  constructor(readonly routeId: string) {
    this.trackLength = getTrack(routeId).length;
  }

  get size(): number {
    return this.riders.size;
  }

  info(r: Rider): RiderInfo {
    return { id: r.id, name: r.name, country: r.country, loadout: r.loadout, bot: r.bot || undefined };
  }

  join(r: Rider, authenticated: boolean): void {
    this.riders.set(r.id, r);
    r.conn.send({
      type: 'welcome',
      id: r.id,
      roomId: this.id,
      routeId: this.routeId,
      riders: [...this.riders.values()].filter((o) => o.id !== r.id).map((o) => this.info(o)),
      serverTime: Date.now(),
      authenticated,
    });
    this.broadcast({ type: 'joined', rider: this.info(r) }, r.id);
  }

  leave(id: string): Rider | undefined {
    const r = this.riders.get(id);
    if (!r) return undefined;
    this.riders.delete(id);
    this.broadcast({ type: 'left', id });
    return r;
  }

  handle(r: Rider, msg: ClientMessage, now = Date.now()): void {
    switch (msg.type) {
      case 'state':
        this.updateState(r, msg, now);
        break;
      case 'chat':
        if (now - r.lastChatAt < 1500) return;
        r.lastChatAt = now;
        this.broadcast({ type: 'chat', from: r.id, name: r.name, text: msg.text, at: now });
        break;
      case 'rideOn': {
        const target = this.riders.get(msg.to);
        if (!target || target.id === r.id) return;
        const m: ServerMessage = { type: 'rideOn', from: r.id, name: r.name, to: target.id };
        target.conn.send(m);
        r.conn.send(m);
        break;
      }
      case 'emote':
        // one puff takes ~8 s; anything faster is spam
        if (now - r.lastEmoteAt < 8000) return;
        r.lastEmoteAt = now;
        for (const other of this.riders.values()) if (other.id !== r.id) other.conn.send({ type: 'emote', from: r.id, e: msg.e });
        break;
      default:
        break;
    }
  }

  private updateState(r: Rider, s: Extract<ClientMessage, { type: 'state' }>, now: number): void {
    if (now - r.updatedAt < 45) return; // max ~20 Hz
    const t = r.telemetry;
    const dt = Math.min(2, (now - t.lastAt) / 1000);
    const power = Math.max(0, s.p);
    if (power > MAX_POWER) t.flags.add('unrealistische Leistung');
    if (s.v > MAX_SPEED) t.flags.add('unrealistische Geschwindigkeit');
    const dd = s.d - t.lastDistance;
    if (dd > Math.max(s.v, t.lastSpeed) * dt * 1.6 + 15) t.flags.add('Positionssprung');

    t.kilojoules += (Math.min(power, MAX_POWER) * dt) / 1000;
    t.window.push([now, power]);
    while (t.window.length && now - t.window[0]![0] > 60_000) t.window.shift();
    if (t.window.length > 20 && now - t.startedAt > 60_000) {
      const avg = t.window.reduce((a, [, p]) => a + p, 0) / t.window.length;
      if (avg / r.weightKg > MAX_WKG_60S) t.flags.add('W/kg über 60 s unplausibel');
    }
    t.lastAt = now;
    t.lastDistance = s.d;
    t.lastSpeed = s.v;
    t.maxDistance = Math.max(t.maxDistance, s.d);

    r.d = s.d;
    r.v = Math.min(MAX_SPEED, Math.max(0, s.v));
    r.lat = Math.min(4, Math.max(-4, s.lat));
    r.p = power;
    r.c = Math.max(0, s.c);
    r.updatedAt = now;
  }

  /** Sends position snapshots: nearby riders every tick, far ones once per second. */
  tick(now = Date.now()): void {
    this.tickCount++;
    const full = this.tickCount % SNAPSHOT_HZ === 0;
    const all = [...this.riders.values()];
    for (const me of all) {
      if (me.bot && !full) continue; // load-test bots only need occasional updates
      const tuples = [];
      for (const o of all) {
        if (o.id === me.id) continue;
        const gap = Math.abs(wrapGap(o.d - me.d, this.trackLength));
        if (!full && gap > NEAR_M) continue;
        tuples.push(encodeTuple(o.id, o.d, o.v, o.lat, o.p, o.c));
      }
      if (tuples.length) me.conn.send({ type: 'snapshot', t: now, r: tuples });
    }
  }

  broadcast(msg: ServerMessage, exceptId?: string): void {
    for (const r of this.riders.values()) if (r.id !== exceptId) r.conn.send(msg);
  }
}

/** Shortest signed distance between two lap positions on a loop. */
export function wrapGap(gap: number, length: number): number {
  const g = ((gap % length) + length) % length;
  return g > length / 2 ? g - length : g;
}

export interface GameOptions {
  storage: Storage;
}

/**
 * All rooms of the server. Riders are placed into the first shard of their
 * route with free capacity; finishing a ride books server-computed Watt-Taler.
 */
export class Game {
  private readonly rooms = new Map<string, Room[]>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly opts: GameOptions) {}

  start(): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const shards of this.rooms.values()) for (const room of shards) room.tick(now);
    }, 1000 / SNAPSHOT_HZ);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  online(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of ROUTES) out[r.id] = (this.rooms.get(r.id) ?? []).reduce((a, room) => a + room.size, 0);
    return out;
  }

  private roomFor(routeId: string): Room {
    let shards = this.rooms.get(routeId);
    if (!shards) this.rooms.set(routeId, (shards = []));
    let room = shards.find((s) => s.size < ROOM_CAPACITY);
    if (!room) {
      room = new Room(routeId);
      shards.push(room);
    }
    return room;
  }

  join(conn: Connection, hello: Extract<ClientMessage, { type: 'hello' }>, user?: { id: string; name: string }): { rider: Rider; room: Room } | null {
    if (!ROUTES.some((r) => r.id === hello.routeId)) {
      conn.send({ type: 'error', message: `Unbekannte Strecke: ${hello.routeId}` });
      return null;
    }
    const rider = newRider(conn, hello, user);
    const room = this.roomFor(hello.routeId);
    room.join(rider, !!user);
    return { rider, room };
  }

  /** Removes the rider and, for logged-in riders, books the ride. */
  async leave(room: Room, rider: Rider): Promise<RideSummaryDTO | undefined> {
    room.leave(rider.id);
    if (!rider.userId) return undefined;
    return this.bookRide(room.routeId, room.trackLength, rider);
  }

  private async bookRide(routeId: string, lapLength: number, rider: Rider): Promise<RideSummaryDTO | undefined> {
    const { storage } = this.opts;
    const t = rider.telemetry;
    const userId = rider.userId!;
    if (t.kilojoules < 1) return undefined;
    const distance = Math.max(0, t.maxDistance - (t.baseDistance ?? 0));
    const laps = Math.floor(distance / lapLength);
    const lapBonus = !t.noLapBonus;
    if (rider.simulated || rider.bot) {
      return { kilojoules: t.kilojoules, coins: 0, laps, flagged: false, reason: 'Simulator – keine Taler' };
    }
    const flagged = t.flags.size > 0;
    const garage = await storage.getGarage(userId);
    const lines = flagged
      ? []
      : rideEarnings({
          kilojoules: t.kilojoules,
          workoutKilojoules: 0,
          workoutCompleted: false,
          lapsCompleted: lapBonus ? laps : 0,
          firstLapOnRoute: lapBonus && !garage.routesWithLap.includes(routeId),
          personalBests: 0,
        });
    const coins = total(lines);
    let balance = garage.balance;
    if (coins > 0) balance = await storage.addLedger(userId, coins, `Fahrt: ${getTrack(routeId).name} (${Math.round(t.kilojoules)} kJ)`);
    if (laps > 0 && lapBonus) await storage.markRouteLap(userId, routeId);
    await storage.saveRide({
      id: randomUUID(),
      userId,
      routeId,
      startedAt: t.startedAt,
      durationS: (t.lastAt - t.startedAt) / 1000,
      distanceM: distance,
      kilojoules: t.kilojoules,
      coins,
      flagged,
      reason: flagged ? [...t.flags].join(', ') : undefined,
    });
    return { kilojoules: t.kilojoules, coins, laps, flagged, reason: flagged ? [...t.flags].join(', ') : undefined, balance };
  }
}

/** A fresh rider for a hello (also used by group rooms). */
export function newRider(conn: Connection, hello: Extract<ClientMessage, { type: 'hello' }>, user?: { id: string; name: string }): Rider {
  const now = Date.now();
  return {
    id: randomUUID().slice(0, 12),
    userId: user?.id,
    name: user?.name ?? hello.name,
    country: hello.country,
    loadout: hello.loadout,
    weightKg: hello.weightKg,
    bot: !!hello.bot,
    simulated: !!hello.simulated,
    conn,
    d: 0,
    v: 0,
    lat: 1.4,
    p: 0,
    c: 0,
    updatedAt: 0,
    lastChatAt: 0,
    lastEmoteAt: 0,
    telemetry: { startedAt: now, lastAt: now, kilojoules: 0, maxDistance: 0, lastDistance: 0, lastSpeed: 0, window: [], flags: new Set() },
  };
}
