import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';
import { loadConfig, publicConfig, turnCredentials } from '../server/config.js';
import { createHmac } from 'node:crypto';

async function start(env = {}) {
  const cfg = loadConfig({ PORT: '0', MAX_PEERS: '3', ...env });
  const app = createApp(cfg);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  return { ...app, port, url: `ws://127.0.0.1:${port}/ws`, http: `http://127.0.0.1:${port}` };
}

function client(url, headers) {
  const ws = new WebSocket(url, { headers });
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  ws.next = (pred = () => true, ms = 2000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  ws.sendJson = (m) => ws.send(JSON.stringify(m));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const ROOM = 'abcdefghjkmnpqrs';

test('peers in a room are introduced and can relay opaque messages', async () => {
  const s = await start();
  try {
    const a = await client(s.url);
    a.sendJson({ t: 'join', room: ROOM });
    const ja = await a.next((m) => m.t === 'joined');
    assert.deepEqual(ja.peers, []);

    const b = await client(s.url);
    b.sendJson({ t: 'join', room: ROOM });
    const jb = await b.next((m) => m.t === 'joined');
    assert.deepEqual(jb.peers, [ja.id]);
    assert.equal((await a.next((m) => m.t === 'peer-joined')).id, jb.id);

    a.sendJson({ t: 'msg', to: jb.id, d: 'sealed-direct' });
    assert.deepEqual(await b.next((m) => m.t === 'msg'), { t: 'msg', from: ja.id, to: jb.id, d: 'sealed-direct' });

    b.sendJson({ t: 'msg', to: '*', d: 'sealed-broadcast' });
    assert.equal((await a.next((m) => m.t === 'msg')).d, 'sealed-broadcast');

    b.close();
    assert.equal((await a.next((m) => m.t === 'peer-left')).id, jb.id);
    a.close();
  } finally {
    s.signaling.close();
    s.server.close();
  }
});

test('rooms are isolated and capped at MAX_PEERS', async () => {
  const s = await start();
  try {
    const peers = [];
    for (let i = 0; i < 3; i++) {
      const c = await client(s.url);
      c.sendJson({ t: 'join', room: ROOM });
      await c.next((m) => m.t === 'joined');
      peers.push(c);
    }
    const extra = await client(s.url);
    extra.sendJson({ t: 'join', room: ROOM });
    assert.equal((await extra.next((m) => m.t === 'error')).code, 'full');

    const outsider = await client(s.url);
    outsider.sendJson({ t: 'join', room: 'zzzzzzzzzzzzzzzz' });
    const jo = await outsider.next((m) => m.t === 'joined');
    assert.deepEqual(jo.peers, []);
    outsider.sendJson({ t: 'msg', to: '*', d: 'x' });
    await assert.rejects(peers[0].next((m) => m.t === 'msg', 200));
    [...peers, extra, outsider].forEach((c) => c.close());
  } finally {
    s.signaling.close();
    s.server.close();
  }
});

test('bad input is refused; messages before joining go nowhere', async () => {
  const s = await start();
  try {
    const c = await client(s.url);
    c.sendJson({ t: 'join', room: '../../etc/passwd' });
    assert.equal((await c.next((m) => m.t === 'error')).code, 'bad-room');
    c.sendJson({ t: 'msg', to: '*', d: 'x' }); // not in a room: ignored
    c.close();
  } finally {
    s.signaling.close();
    s.server.close();
  }
});

test('a flood is cut off by the rate limiter', async () => {
  const s = await start();
  try {
    const c = await client(s.url);
    c.sendJson({ t: 'join', room: ROOM });
    await c.next((m) => m.t === 'joined');
    const closed = once(c, 'close');
    for (let i = 0; i < 2000; i++) c.sendJson({ t: 'msg', to: '*', d: 'x' });
    const [code] = await closed;
    assert.equal(code, 1008);
  } finally {
    s.signaling.close();
    s.server.close();
  }
});

test('cross-origin websocket upgrades are rejected unless allowed', async () => {
  const s = await start();
  try {
    await assert.rejects(client(s.url, { Origin: 'https://evil.example' }));
    const ok = await client(s.url, { Origin: `http://127.0.0.1:${s.port}` });
    ok.close();
  } finally {
    s.signaling.close();
    s.server.close();
  }
  const s2 = await start({ ALLOWED_ORIGINS: 'https://meet.example' });
  try {
    const ok = await client(s2.url, { Origin: 'https://meet.example' });
    ok.close();
    await assert.rejects(client(s2.url, { Origin: 'https://evil.example' }));
  } finally {
    s2.signaling.close();
    s2.server.close();
  }
});

test('http: security headers, config and static files', async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.http}/config.json`);
    const body = await res.json();
    assert.equal(body.maxPeers, 3);
    assert.ok(body.brand.name);
    assert.ok(Array.isArray(body.iceServers));
    assert.ok(!JSON.stringify(body).includes('turnSecret'));
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${s.http}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.http}/../server/index.js`)).status, 404);
    assert.equal((await fetch(`${s.http}/%2e%2e/package.json`)).status, 404);
  } finally {
    s.signaling.close();
    s.server.close();
  }
});

test('TURN credentials are short-lived HMACs and secrets stay server-side', () => {
  const now = 1_700_000_000_000;
  const { username, credential } = turnCredentials('s3cret', 3600, now);
  assert.equal(username, String(1_700_000_000 + 3600));
  assert.equal(credential, createHmac('sha1', 's3cret').update(username).digest('base64'));

  const cfg = loadConfig({ TURN_URLS: 'turn:t.example:3478', TURN_SECRET: 's3cret' });
  const pub = publicConfig(cfg, now);
  const turn = pub.iceServers.find((i) => i.credential);
  assert.deepEqual(turn.urls, ['turn:t.example:3478']);
  assert.ok(!JSON.stringify(pub).includes('s3cret'));
});

test('brand file values are validated', () => {
  const cfg = loadConfig({ BRAND_FILE: '/nonexistent.json' });
  assert.equal(cfg.brand.accent, '#2f9e6f');
});
