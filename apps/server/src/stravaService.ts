import { signToken, verifyToken } from './auth';
import { STRAVA_SCOPE, StravaClient, StravaError, TokenCipher, type StravaConfig, type StravaUploadResult } from './strava';
import type { Storage } from './storage/types';

const STATE_NAME = 'strava-oauth-state';

export interface StravaStatus {
  configured: boolean;
  connected: boolean;
  athleteName?: string;
  autoUpload?: boolean;
}

/** Glue between Strava, the token store and the HTTP API. */
export class StravaService {
  private readonly client: StravaClient;
  private readonly cipher: TokenCipher;
  private readonly pollIntervalMs: number;
  private readonly pollAttempts: number;

  constructor(
    cfg: StravaConfig & { pollIntervalMs?: number; pollAttempts?: number },
    private readonly storage: Storage,
    private readonly secret: string,
  ) {
    this.client = new StravaClient(cfg);
    this.cipher = new TokenCipher(secret);
    this.pollIntervalMs = cfg.pollIntervalMs ?? 1500;
    this.pollAttempts = cfg.pollAttempts ?? 5;
  }

  /** Strava authorize URL with a signed, 10-minute state that identifies the user. */
  connectUrl(userId: string): string {
    return this.client.authorizeUrl(signToken({ sub: userId, name: STATE_NAME }, this.secret, 600));
  }

  async handleCallback(q: URLSearchParams): Promise<{ ok: boolean; message: string }> {
    if (q.get('error')) return { ok: false, message: 'Die Verbindung wurde bei Strava abgelehnt.' };
    const state = verifyToken(q.get('state') ?? '', this.secret);
    if (!state || state.name !== STATE_NAME) return { ok: false, message: 'Der Link ist abgelaufen – bitte in der App erneut auf „Mit Strava verbinden“ tippen.' };
    const scope = q.get('scope') ?? '';
    if (!scope.split(',').includes('activity:write')) {
      return { ok: false, message: 'Bitte bei Strava die Berechtigung „Aktivitäten hochladen“ erlauben und erneut verbinden.' };
    }
    const code = q.get('code');
    if (!code) return { ok: false, message: 'Strava hat keinen Code geliefert.' };
    try {
      const { tokens, athlete } = await this.client.exchangeCode(code);
      const previous = await this.storage.getStrava(state.sub);
      await this.storage.saveStrava({
        userId: state.sub,
        athleteId: athlete.id,
        athleteName: athlete.name,
        accessToken: this.cipher.encrypt(tokens.accessToken),
        refreshToken: this.cipher.encrypt(tokens.refreshToken),
        expiresAt: tokens.expiresAt,
        scope: scope || STRAVA_SCOPE,
        autoUpload: previous?.autoUpload ?? true,
      });
      return { ok: true, message: `Strava ist mit ${athlete.name} verbunden.` };
    } catch (err) {
      return { ok: false, message: `Strava-Anmeldung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async status(userId: string): Promise<StravaStatus> {
    const c = await this.storage.getStrava(userId);
    return c ? { configured: true, connected: true, athleteName: c.athleteName, autoUpload: c.autoUpload } : { configured: true, connected: false };
  }

  async setAutoUpload(userId: string, autoUpload: boolean): Promise<void> {
    const c = await this.storage.getStrava(userId);
    if (c) await this.storage.saveStrava({ ...c, autoUpload });
  }

  async disconnect(userId: string): Promise<void> {
    const c = await this.storage.getStrava(userId);
    if (!c) return;
    try {
      await this.client.deauthorize(this.cipher.decrypt(c.accessToken));
    } catch {
      // token may be expired or undecryptable — we forget it anyway
    }
    await this.storage.deleteStrava(userId);
  }

  /** Valid access token, refreshed when it expires within a minute. */
  private async accessToken(userId: string): Promise<string> {
    const c = await this.storage.getStrava(userId);
    if (!c) throw new StravaError('Strava ist nicht verbunden', 409);
    if (c.expiresAt - 60 > Date.now() / 1000) return this.cipher.decrypt(c.accessToken);
    const t = await this.client.refresh(this.cipher.decrypt(c.refreshToken));
    await this.storage.saveStrava({
      ...c,
      accessToken: this.cipher.encrypt(t.accessToken),
      refreshToken: this.cipher.encrypt(t.refreshToken),
      expiresAt: t.expiresAt,
    });
    return t.accessToken;
  }

  async upload(userId: string, fit: Uint8Array, meta: { name: string; description?: string; externalId: string }): Promise<StravaUploadResult> {
    const token = await this.accessToken(userId);
    let result = await this.client.upload(token, fit, meta);
    // Strava processes uploads asynchronously; wait briefly so the app usually gets the activity link right away.
    for (let i = 0; i < this.pollAttempts && result.status === 'processing' && result.uploadId; i++) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      result = await this.client.uploadStatus(token, result.uploadId);
    }
    return result;
  }

  async uploadStatus(userId: string, uploadId: number): Promise<StravaUploadResult> {
    return this.client.uploadStatus(await this.accessToken(userId), uploadId);
  }
}

export function callbackPage(ok: boolean, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Velo Sim – Strava</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif}
.box{max-width:420px;padding:28px;border:1px solid #2a313c;border-radius:12px;background:#161b22;text-align:center}
h1{font-size:22px;margin:0 0 10px;color:${ok ? '#fc4c02' : '#f85149'}}p{color:#8b949e;line-height:1.5}</style></head>
<body><div class="box"><h1>${ok ? 'Strava verbunden ✓' : 'Verbindung fehlgeschlagen'}</h1><p>${esc(message)}</p>
<p>Du kannst dieses Fenster schließen und zur App zurückkehren.</p></div></body></html>`;
}
