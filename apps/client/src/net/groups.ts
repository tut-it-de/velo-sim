import type { GroupRideDTO, GroupStateDTO } from '@velo/protocol';
import { ApiError, accountStore, serverBase } from './api';

/** Group rides over HTTP: create one, look one up by its invite code (login required). */

async function groupCall<T>(path: string, body?: unknown): Promise<T> {
  const base = serverBase();
  if (!base) throw new ApiError(0, 'Kein Server eingestellt');
  const token = accountStore.get().token;
  if (!token) throw new ApiError(401, 'Gruppenfahrten gibt es nur angemeldet.');
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Server nicht erreichbar');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Fehler ${res.status}`);
  return json;
}

export async function createGroupRide(input: { name: string; routeId: string; startAt: number | null; together: boolean }): Promise<GroupRideDTO> {
  return (await groupCall<{ group: GroupRideDTO }>('/api/groups', input)).group;
}

export async function fetchGroupRide(code: string): Promise<GroupStateDTO> {
  return (await groupCall<{ group: GroupStateDTO }>(`/api/groups/${encodeURIComponent(normalizeCode(code))}`)).group;
}

/** "k7q x2m" → "K7QX2M"; also accepts a pasted invite link. */
export function normalizeCode(input: string): string {
  const fromLink = /[?&]group=([A-Za-z0-9]+)/.exec(input)?.[1];
  return (fromLink ?? input).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
}

/** Link that opens the app with the join dialog; the server also serves the web client. */
export function inviteLink(code: string): string {
  const base = /^https?:/.test(serverBase()) ? serverBase().replace(/\/$/, '') : `${location.origin}${location.pathname.replace(/\/$/, '')}`;
  return `${base}/?group=${code}`;
}

/** Invite code from the address (?group=…), if the app was opened with a link. */
export function inviteCodeFromUrl(): string | null {
  const code = new URLSearchParams(location.search).get('group');
  return code ? normalizeCode(code) : null;
}
