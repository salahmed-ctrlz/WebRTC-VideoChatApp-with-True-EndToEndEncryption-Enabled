import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, publicConfig, ROOT } from './config.js';
import { loadStatic, serveStatic } from './static.js';
import { attachSignaling } from './signaling.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // inline style attributes for grid/accent variables
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
};

export function createApp(cfg = loadConfig()) {
  const files = loadStatic(resolve(ROOT, 'public'));

  const server = createServer((req, res) => {
    const headers = { ...SECURITY_HEADERS };
    const proto = req.headers['x-forwarded-proto'];
    if (cfg.trustProxy && proto === 'https') headers['Strict-Transport-Security'] = 'max-age=31536000';

    const path = (req.url || '/').split('?')[0];
    if (path === '/healthz') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('ok');
    }
    if (path === '/config.json') {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(publicConfig(cfg)));
    }
    if (serveStatic(files, req, res, headers)) return;
    res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  const signaling = attachSignaling(server, cfg);
  return { server, signaling, cfg };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { server, signaling, cfg } = createApp();
  server.listen(cfg.port, cfg.host, () => {
    console.log(`${cfg.brand.name} listening on http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  });
  const stop = () => {
    signaling.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
