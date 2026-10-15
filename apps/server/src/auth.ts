import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;
const N = 16384;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Password hash as `scrypt$N$salt$key` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, , saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export interface TokenPayload {
  sub: string;
  name: string;
  exp: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** Minimal HS256 JWT — no dependency needed for a single trusted issuer. */
export function signToken(payload: Omit<TokenPayload, 'exp'>, secret: string, ttlSeconds = 60 * 60 * 24 * 30): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}
