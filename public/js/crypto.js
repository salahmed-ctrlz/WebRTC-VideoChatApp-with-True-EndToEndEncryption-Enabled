// Key handling shared by the browser and the tests. Web Crypto only, no dependencies.
//
// A meeting link looks like   https://host/#ROOMID.SECRET
// ROOMID goes to the server so it can group connections. SECRET never leaves the browser
// (URL fragments are not sent in HTTP requests). Everything else is derived from SECRET:
//   - a signalling key: seals SDP, ICE, names, chat and status messages
//   - a media root key: per-sender frame keys for the encoded audio/video
//   - a short safety code people can read out to confirm they hold the same secret

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes
const ID_LENGTH = 16;

export function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Random room id (~80 bits) from an alphabet without look-alike characters. */
export function newRoomId() {
  // 31 symbols: reject bytes >= 248 (31 * 8) so the choice stays uniform.
  let out = '';
  while (out.length < ID_LENGTH) {
    for (const b of randomBytes(32)) {
      if (b < 248 && out.length < ID_LENGTH) out += ID_ALPHABET[b % 31];
    }
  }
  return out;
}

export function newSecret() {
  return b64u(randomBytes(32));
}

export function isRoomId(s) {
  return typeof s === 'string' && s.length === ID_LENGTH && [...s].every((c) => ID_ALPHABET.includes(c));
}

export function isSecret(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s)) return false;
  try {
    return unb64u(s).length === 32;
  } catch {
    return false;
  }
}

/** Build the part after '#'. */
export function formatMeetingHash(roomId, secret) {
  return `${roomId}.${secret}`;
}

/** Accepts a full link, a '#...' fragment or a bare 'ROOMID.SECRET'. Returns null if it isn't valid. */
export function parseMeeting(input) {
  if (!input) return null;
  let s = String(input).trim();
  const hash = s.lastIndexOf('#');
  if (hash !== -1) s = s.slice(hash + 1);
  s = s.replace(/^\/+/, '');
  const [roomId, secret, ...rest] = s.split('.');
  if (rest.length || !isRoomId(roomId) || !isSecret(secret)) return null;
  return { roomId, secret };
}

async function hkdf(secretBytes, info, bits) {
  const base = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
  return { base, info: enc.encode(info), bits };
}

async function deriveAesKey(secretBytes, info, usages) {
  const { base, info: i } = await hkdf(secretBytes, info);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: i },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

async function deriveBytes(secretBytes, info, length) {
  const { base, info: i } = await hkdf(secretBytes, info);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: i }, base, length * 8);
  return new Uint8Array(bits);
}

/**
 * Everything a client needs from the shared secret.
 * The room id is mixed into every derivation so the same secret can't be reused across rooms.
 */
export async function deriveRoomKeys(roomId, secret) {
  const raw = unb64u(secret);
  const ctx = `|${roomId}`;
  const signalKey = await deriveAesKey(raw, `meet/v1/signal${ctx}`, ['encrypt', 'decrypt']);
  const mediaRoot = await deriveBytes(raw, `meet/v1/media-root${ctx}`, 32);
  const codeBytes = await deriveBytes(raw, `meet/v1/safety-code${ctx}`, 5);
  const hex = [...codeBytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { signalKey, mediaRoot, safetyCode: `${hex.slice(0, 4)} ${hex.slice(4, 8)} ${hex.slice(8, 10)}` };
}

/** AES-GCM key used to encrypt the frames that peer `peerId` sends. Non-extractable. */
export async function deriveSenderKey(mediaRoot, peerId) {
  return deriveAesKey(mediaRoot, `meet/v1/frame|${peerId}`, ['encrypt', 'decrypt']);
}

// Associated data ties each message to the room and to who sent it / who it is for,
// so a relay can't re-address, re-attribute or move messages between rooms.
function aad(roomId, from, to) {
  return enc.encode(`meet/v1|${roomId}|${from}|${to}`);
}

/** Seal a JSON-serialisable value. Returns base64url(iv || ciphertext+tag). */
export async function seal(key, value, roomId, from, to) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(roomId, from, to) }, key, enc.encode(JSON.stringify(value))),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}

/** Opens a sealed message. Returns null if it doesn't authenticate. */
export async function open(key, data, roomId, from, to) {
  try {
    const raw = unb64u(data);
    if (raw.length < 12 + 16) return null;
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: aad(roomId, from, to) },
      key,
      raw.slice(12),
    );
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}
