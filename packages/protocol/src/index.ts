/**
 * Wire protocol between app and game server (JSON over WebSocket).
 * Positions are 1-D: distance along the route plus a lateral lane offset —
 * the client turns that into world coordinates with the shared route data.
 */

export const PROTOCOL_VERSION = 1;

/** Equipment item ids — the client resolves them to looks via @velo/equipment. */
export interface LoadoutDTO {
  bike: string;
  wheels: string;
  jersey: string;
  helmet?: string;
}

export interface RiderInfo {
  id: string;
  name: string;
  loadout: LoadoutDTO;
  /** ISO 3166-1 alpha-2 country code for the flag next to the name. */
  country?: string;
  /** Set for server-side bots and load-test clients. */
  bot?: boolean;
}

/** Short animations other riders see (V: a puff from the vape). */
export const EMOTES = ['vape'] as const;
export type Emote = (typeof EMOTES)[number];

/** [id, distance m, speed m/s, lateral m, power W, cadence rpm] */
export type RiderTuple = [string, number, number, number, number, number];

export type ClientMessage =
  | { type: 'hello'; v: number; token?: string; name: string; country?: string; routeId: string; loadout: LoadoutDTO; weightKg: number; bot?: boolean; simulated?: boolean; groupId?: string }
  | { type: 'state'; d: number; v: number; p: number; c: number; lat: number; hr?: number }
  | { type: 'chat'; text: string }
  | { type: 'rideOn'; to: string }
  | { type: 'emote'; e: Emote }
  | { type: 'bye' }
  /** Group ride host: start the countdown now / end the ride for everyone. */
  | { type: 'groupStart' }
  | { type: 'groupEnd' };

export interface RideSummaryDTO {
  kilojoules: number;
  coins: number;
  laps: number;
  flagged: boolean;
  reason?: string;
  balance?: number;
}

export type ServerMessage =
  | { type: 'welcome'; id: string; roomId: string; routeId: string; riders: RiderInfo[]; serverTime: number; authenticated: boolean }
  | { type: 'joined'; rider: RiderInfo }
  | { type: 'left'; id: string }
  | { type: 'snapshot'; t: number; r: RiderTuple[] }
  | { type: 'chat'; from: string; name: string; text: string; at: number }
  | { type: 'rideOn'; from: string; name: string; to: string }
  | { type: 'emote'; from: string; e: Emote }
  | { type: 'rideSummary'; summary: RideSummaryDTO }
  | { type: 'group'; group: GroupStateDTO }
  | { type: 'groupPos'; t: number; d: number; v: number; n: number }
  | { type: 'error'; message: string };

/** Status of a group ride: waiting in the lobby, riding, or over. */
export type GroupStatus = 'lobby' | 'riding' | 'ended';

/** A group ride as the HTTP API returns it. */
export interface GroupRideDTO {
  /** Invite code, e.g. "K7QX2M". */
  id: string;
  name: string;
  routeId: string;
  hostUserId: string;
  hostName: string;
  /** Planned start (ms); null = the host starts by hand. */
  startAt: number | null;
  /** Speed help so everyone stays together (no race). */
  together: boolean;
  status: GroupStatus;
  startedAt?: number;
  createdAt: number;
}

/** Live group state in the room (lobby list, countdown, start/end). */
export interface GroupStateDTO extends GroupRideDTO {
  members: Array<{ id: string; name: string; country?: string; host: boolean }>;
  /** Distance of the group when a late rider joins a running ride – that rider starts there. */
  startD?: number;
}

/** Invite codes: 6 characters without look-alikes (0/O, 1/I/L). */
export const GROUP_CODE_RE = /^[A-HJ-KM-NP-Z2-9]{6}$/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length <= max;

/** Normalises an ISO 3166-1 alpha-2 country code ("de" → "DE"); anything else becomes undefined. */
export function countryCode(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-z]{2}$/i.test(v) ? v.toUpperCase() : undefined;
}

function isLoadout(v: unknown): v is LoadoutDTO {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return isStr(l.bike, 64) && isStr(l.wheels, 64) && isStr(l.jersey, 64);
}

/** Validates an incoming client message; returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 4096) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'hello':
      if (!isNum(o.v) || !isStr(o.name, 40) || !isStr(o.routeId, 40) || !isLoadout(o.loadout) || !isNum(o.weightKg)) return null;
      if (o.token !== undefined && !isStr(o.token, 2000)) return null;
      return {
        type: 'hello',
        v: o.v,
        token: o.token as string | undefined,
        name: o.name.trim().slice(0, 24) || 'Fahrer',
        country: countryCode(o.country),
        routeId: o.routeId,
        loadout: o.loadout,
        weightKg: Math.min(200, Math.max(30, o.weightKg)),
        bot: o.bot === true,
        simulated: o.simulated === true,
        groupId: isStr(o.groupId, 12) && o.groupId.trim() ? o.groupId.trim().toUpperCase() : undefined,
      };
    case 'state':
      if (!isNum(o.d) || !isNum(o.v) || !isNum(o.p) || !isNum(o.c) || !isNum(o.lat)) return null;
      return {
        type: 'state',
        d: o.d,
        v: o.v,
        p: o.p,
        c: o.c,
        lat: o.lat,
        hr: isNum(o.hr) ? o.hr : undefined,
      };
    case 'chat':
      if (!isStr(o.text, 280) || !o.text.trim()) return null;
      return { type: 'chat', text: o.text.trim() };
    case 'rideOn':
      if (!isStr(o.to, 64)) return null;
      return { type: 'rideOn', to: o.to };
    case 'emote':
      return (EMOTES as readonly unknown[]).includes(o.e) ? { type: 'emote', e: o.e as Emote } : null;
    case 'bye':
      return { type: 'bye' };
    case 'groupStart':
    case 'groupEnd':
      return { type: o.type };
    default:
      return null;
  }
}

/** Compact rounding so snapshots stay small. */
export function encodeTuple(id: string, d: number, v: number, lat: number, p: number, c: number): RiderTuple {
  return [id, Math.round(d * 10) / 10, Math.round(v * 100) / 100, Math.round(lat * 100) / 100, Math.round(p), Math.round(c)];
}
