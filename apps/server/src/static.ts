import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';

/**
 * Serves the built web client (apps/client/dist) on the same port as the API and
 * WebSocket, so https://host/ opens the game. Node built-ins only.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Worth compressing on the fly (text, JSON world data, terrain heightmaps, wasm). */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.xml', '.svg', '.ico', '.wasm', '.bin', '.gltf']);
const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESS_BYTES = 32 * 1024 * 1024;
/** Compressed bodies are cached in memory (keyed by path + mtime) up to this many bytes. */
const CACHE_LIMIT_BYTES = 128 * 1024 * 1024;

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

type Encoding = 'br' | 'gzip';

function pickEncoding(acceptEncoding: string | undefined): Encoding | undefined {
  if (!acceptEncoding) return undefined;
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find(Boolean);
    if (name) accepted.set(name, q === undefined ? 1 : Number(q));
  }
  const ok = (e: string) => (accepted.get(e) ?? accepted.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return undefined;
}

export interface StaticHandler {
  /** Absolute path of the served directory. */
  readonly root: string;
  /** Serves GET/HEAD requests; always answers (404 when nothing matches). */
  serve(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createStaticHandler(dir: string): StaticHandler {
  const root = realpathSync(path.resolve(dir));
  const cache = new Map<string, { body: Promise<Buffer>; bytes: number }>();
  let cacheBytes = 0;

  const compressed = (file: string, mtimeMs: number, encoding: Encoding): Promise<Buffer> => {
    const key = `${encoding}:${mtimeMs}:${file}`;
    const hit = cache.get(key);
    if (hit) return hit.body;
    const entry = {
      body: readFile(file).then((raw) =>
        encoding === 'br'
          ? brotli(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
          : gzipAsync(raw, { level: 6 }),
      ),
      bytes: 0,
    };
    cache.set(key, entry);
    entry.body.then(
      (buf) => {
        if (cache.get(key) !== entry) return;
        entry.bytes = buf.length;
        cacheBytes += buf.length;
        // Evict the oldest entries (Map keeps insertion order).
        for (const [k, v] of cache) {
          if (cacheBytes <= CACHE_LIMIT_BYTES) break;
          if (k === key) continue;
          cache.delete(k);
          cacheBytes -= v.bytes;
        }
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
    return entry.body;
  };

  /** Resolves a URL path to a regular file inside root, or undefined. */
  const resolveFile = async (relPath: string): Promise<{ file: string; size: number; mtimeMs: number } | undefined> => {
    const candidate = path.join(root, relPath);
    try {
      let st = await stat(candidate);
      let file = candidate;
      if (st.isDirectory()) {
        file = path.join(candidate, 'index.html');
        st = await stat(file);
      }
      if (!st.isFile()) return undefined;
      // Symlinks must not lead outside the client directory either.
      const real = await realpath(file);
      if (real !== root && !real.startsWith(root + path.sep)) return undefined;
      return { file: real, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return undefined;
    }
  };

  const notFound = (res: ServerResponse, status = 404, text = 'Nicht gefunden') => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  };

  return {
    root,
    async serve(req, res) {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
        res.end('Methode nicht erlaubt');
        return;
      }

      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      } catch {
        return notFound(res, 400, 'Ungültige Adresse');
      }
      // Normalise and refuse anything that could escape root or expose dotfiles.
      const segments = pathname.split(/[/\\]+/).filter(Boolean);
      if (pathname.includes('\0') || segments.some((s) => s === '..' || s.startsWith('.'))) return notFound(res);
      const relPath = segments.join('/');

      let found = await resolveFile(relPath);
      let isIndex = found ? path.basename(found.file) === 'index.html' && path.dirname(found.file) === root : false;
      if (!found) {
        // SPA fallback: only for page navigations without a file extension (not for missing assets/data).
        const last = segments[segments.length - 1] ?? '';
        const accept = String(req.headers.accept ?? '');
        const navigation = req.headers['sec-fetch-mode'] === 'navigate' || accept.includes('text/html');
        if (path.extname(last) || !navigation) return notFound(res);
        found = await resolveFile('index.html');
        if (!found) return notFound(res);
        isIndex = true;
      }

      const { file, size, mtimeMs } = found;
      const rel = path.relative(root, file).split(path.sep).join('/');
      const ext = path.extname(file).toLowerCase();
      const etag = `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
      const headers: Record<string, string | number> = {
        'content-type': contentType(file),
        // Vite puts content-hashed files under assets/ – cache them forever; everything else revalidates.
        'cache-control': !isIndex && rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        etag,
        'last-modified': new Date(mtimeMs).toUTCString(),
        'x-content-type-options': 'nosniff',
      };
      const compressible = COMPRESSIBLE.has(ext) && size >= MIN_COMPRESS_BYTES && size <= MAX_COMPRESS_BYTES;
      if (compressible) headers.vary = 'Accept-Encoding';

      const inm = req.headers['if-none-match'];
      const ims = req.headers['if-modified-since'];
      const fresh = inm
        ? inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')
        : !!ims && Math.floor(mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000);
      if (fresh) {
        res.writeHead(304, headers);
        res.end();
        return;
      }

      const encoding = compressible ? pickEncoding(req.headers['accept-encoding']) : undefined;
      try {
        if (encoding) {
          const body = await compressed(file, mtimeMs, encoding);
          res.writeHead(200, { ...headers, 'content-encoding': encoding, 'content-length': body.length });
          res.end(method === 'HEAD' ? undefined : body);
          return;
        }
        res.writeHead(200, { ...headers, 'content-length': size });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        pipeline(createReadStream(file), res, () => undefined);
      } catch (err) {
        console.error('[static]', err);
        if (!res.headersSent) notFound(res, 500, 'Interner Fehler');
        else res.destroy();
      }
    },
  };
}

/**
 * Where the built client lives: $CLIENT_DIST, else next to the bundle (Docker: /app/public),
 * else the monorepo build output apps/client/dist (works from src/ and from dist/server.mjs).
 * Returns undefined when nothing servable is found (API-only mode). CLIENT_DIST=off disables it.
 */
export function resolveClientDist(env: NodeJS.ProcessEnv = process.env, base: string = import.meta.url): string | undefined {
  const configured = env.CLIENT_DIST?.trim();
  if (configured === 'off' || configured === 'false' || configured === '0') return undefined;
  const candidates = configured ? [path.resolve(configured)] : [fileURLToPath(new URL('./public', base)), fileURLToPath(new URL('../../client/dist', base))];
  return candidates.find((dir) => existsSync(path.join(dir, 'index.html')));
}
