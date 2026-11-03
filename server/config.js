import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_BRAND = {
  name: 'Private Meet',
  tagline: 'Video meetings that only the people in them can see.',
  logo: null,
  accent: '#2f9e6f',
  theme: 'system',
  links: [],
  credit: null,
  features: { chat: true, screenShare: true, raiseHand: true },
  requireFrameEncryption: true,
  strings: {},
};

const DEFAULT_STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

function int(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Could not read ${label} (${path}): ${err.message}`);
  }
}

function sanitizeBrand(raw) {
  const b = { ...DEFAULT_BRAND, ...(raw || {}) };
  b.features = { ...DEFAULT_BRAND.features, ...(raw?.features || {}) };
  if (!/^#[0-9a-fA-F]{6}$/.test(b.accent)) b.accent = DEFAULT_BRAND.accent;
  if (!['system', 'light', 'dark'].includes(b.theme)) b.theme = 'system';
  b.links = Array.isArray(b.links)
    ? b.links.filter((l) => l && typeof l.label === 'string' && /^https?:\/\//.test(l.url || '')).slice(0, 6)
    : [];
  if (b.credit && !(typeof b.credit.text === 'string' && /^https?:\/\//.test(b.credit.url || ''))) b.credit = null;
  if (b.logo && !/^(https?:\/\/|\/)/.test(b.logo)) b.logo = null;
  b.strings = b.strings && typeof b.strings === 'object' ? b.strings : {};
  return b;
}

export function loadConfig(env = process.env) {
  const brandPath = env.BRAND_FILE ? resolve(env.BRAND_FILE) : resolve(ROOT, 'brand.json');
  const brand = sanitizeBrand(readJson(brandPath, 'brand file'));

  let extraIce = [];
  if (env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS);
      if (Array.isArray(parsed)) extraIce = parsed;
    } catch {
      throw new Error('ICE_SERVERS must be a JSON array');
    }
  }

  return {
    port: int(env.PORT, 3000, 0, 65535),
    host: env.HOST || '0.0.0.0',
    maxPeers: int(env.MAX_PEERS, 6, 2, 16),
    maxRooms: int(env.MAX_ROOMS, 2000, 1, 100000),
    maxConnectionsPerIp: int(env.MAX_CONNECTIONS_PER_IP, 24, 1, 1000),
    trustProxy: env.TRUST_PROXY === '1',
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    brand,
    stun: extraIce.length ? [] : DEFAULT_STUN,
    extraIce,
    turnUrls: (env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean),
    turnSecret: env.TURN_SECRET || '',
  };
}

/** coturn "REST API" credentials: username is an expiry timestamp, password an HMAC of it. */
export function turnCredentials(secret, ttlSeconds = 6 * 3600, now = Date.now()) {
  const username = String(Math.floor(now / 1000) + ttlSeconds);
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

/** What the browser is allowed to know. Never include secrets here. */
export function publicConfig(cfg, now = Date.now()) {
  const iceServers = [...cfg.stun, ...cfg.extraIce];
  if (cfg.turnUrls.length && cfg.turnSecret) {
    iceServers.push({ urls: cfg.turnUrls, ...turnCredentials(cfg.turnSecret, undefined, now) });
  }
  return { brand: cfg.brand, iceServers, maxPeers: cfg.maxPeers };
}
