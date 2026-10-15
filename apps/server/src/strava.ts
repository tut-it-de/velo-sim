import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Strava API client (OAuth + uploads). Runs on the server because the
 * client secret must never ship inside the desktop or iPad app.
 * Docs: https://developers.strava.com/docs/authentication/ and /docs/uploads/
 */

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
  /** Public base URL of this server, used for the OAuth redirect (…/api/strava/callback). */
  publicUrl: string;
  /** Override for tests. */
  apiBase?: string;
  fetch?: typeof fetch;
}

export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds */
  expiresAt: number;
}

export interface StravaAthlete {
  id: number;
  name: string;
}

export interface StravaUploadResult {
  status: 'ready' | 'processing' | 'duplicate' | 'error';
  uploadId?: number;
  activityId?: number;
  url?: string;
  error?: string;
}

export class StravaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'StravaError';
  }
}

export const STRAVA_SCOPE = 'read,activity:write';

export class StravaClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: StravaConfig) {
    this.base = (cfg.apiBase ?? 'https://www.strava.com').replace(/\/+$/, '');
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  get redirectUri(): string {
    return `${this.cfg.publicUrl.replace(/\/+$/, '')}/api/strava/callback`;
  }

  authorizeUrl(state: string): string {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      approval_prompt: 'auto',
      scope: STRAVA_SCOPE,
      state,
    });
    return `${this.base}/oauth/authorize?${p}`;
  }

  private async tokenRequest(body: Record<string, string>): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await this.fetchImpl(`${this.base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!res.ok) throw new StravaError(json.message ?? `Strava-Token-Fehler ${res.status}`, res.status);
    return json;
  }

  async exchangeCode(code: string): Promise<{ tokens: StravaTokens; athlete: StravaAthlete }> {
    const j = await this.tokenRequest({ code, grant_type: 'authorization_code' });
    const a = j.athlete ?? {};
    return {
      tokens: { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: j.expires_at },
      athlete: { id: Number(a.id ?? 0), name: [a.firstname, a.lastname ? `${String(a.lastname).charAt(0)}.` : ''].filter(Boolean).join(' ') || 'Strava' },
    };
  }

  async refresh(refreshToken: string): Promise<StravaTokens> {
    const j = await this.tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: j.expires_at };
  }

  async deauthorize(accessToken: string): Promise<void> {
    await this.fetchImpl(`${this.base}/oauth/deauthorize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
  }

  async upload(accessToken: string, fit: Uint8Array, meta: { name: string; description?: string; externalId: string }): Promise<StravaUploadResult> {
    const form = new FormData();
    form.append('file', new Blob([fit.slice().buffer], { type: 'application/octet-stream' }), `${meta.externalId}.fit`);
    form.append('data_type', 'fit');
    form.append('name', meta.name);
    if (meta.description) form.append('description', meta.description);
    form.append('trainer', '1');
    form.append('commute', '0');
    form.append('external_id', meta.externalId);
    const res = await this.fetchImpl(`${this.base}/api/v3/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: form,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (res.status === 401) throw new StravaError('Strava-Zugriff abgelaufen – bitte neu verbinden', 401);
    if (!res.ok && !json.error) throw new StravaError(json.message ?? `Strava-Upload-Fehler ${res.status}`, res.status);
    return this.interpret(json);
  }

  async uploadStatus(accessToken: string, uploadId: number): Promise<StravaUploadResult> {
    const res = await this.fetchImpl(`${this.base}/api/v3/uploads/${uploadId}`, { headers: { authorization: `Bearer ${accessToken}` } });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!res.ok) throw new StravaError(json.message ?? `Strava-Status-Fehler ${res.status}`, res.status);
    return this.interpret(json);
  }

  /** Maps Strava's upload object (status strings vary) onto our result type. */
  private interpret(j: Record<string, any>): StravaUploadResult { // eslint-disable-line @typescript-eslint/no-explicit-any
    const uploadId = typeof j.id === 'number' ? j.id : undefined;
    if (j.activity_id) {
      return { status: 'ready', uploadId, activityId: j.activity_id, url: activityUrl(j.activity_id) };
    }
    if (j.error) {
      const dup = /duplicate of (?:activity )?(?:<a[^>]*activities\/)?(\d{4,})/i.exec(String(j.error));
      if (dup) {
        const id = Number(dup[1]);
        return { status: 'duplicate', uploadId, activityId: id, url: activityUrl(id), error: 'Diese Fahrt ist schon auf Strava.' };
      }
      return { status: 'error', uploadId, error: String(j.error) };
    }
    return { status: 'processing', uploadId };
  }
}

export function activityUrl(id: number): string {
  return `https://www.strava.com/activities/${id}`;
}

/** AES-256-GCM for tokens at rest (key derived from the server secret). */
export class TokenCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`velo-sim/strava-tokens/${secret}`).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [iv, tag, enc] = payload.split('.');
    if (!iv || !tag || !enc) throw new Error('Ungültiges Token-Format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
  }
}
