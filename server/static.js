import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.webmanifest']);

/** Loads the (small) public directory into memory once, with gzip and ETags precomputed. */
export function loadStatic(dir) {
  const root = resolve(dir);
  const files = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const ext = extname(name);
      const body = readFileSync(full);
      const url = '/' + full.slice(root.length + 1).split(sep).join('/');
      files.set(url, {
        type: TYPES[ext] || 'application/octet-stream',
        body,
        gzip: COMPRESSIBLE.has(ext) && body.length > 512 ? gzipSync(body, { level: 9 }) : null,
        etag: `"${createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`,
        html: ext === '.html',
      });
    }
  };
  walk(root);
  return files;
}

export function serveStatic(files, req, res, headers) {
  let url = (req.url || '/').split('?')[0];
  if (url === '/') url = '/index.html';
  const file = files.get(url);
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) return false;

  const h = {
    ...headers,
    'Content-Type': file.type,
    ETag: file.etag,
    // No build step means no hashed filenames, so revalidate on every load (cheap thanks to ETag).
    'Cache-Control': 'no-cache',
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, h);
    res.end();
    return true;
  }
  const useGzip = file.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = useGzip ? file.gzip : file.body;
  if (useGzip) h['Content-Encoding'] = 'gzip';
  h['Content-Length'] = body.length;
  res.writeHead(200, h);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}
