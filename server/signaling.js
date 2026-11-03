import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

// The server is a blind relay. It knows room ids, peer ids and IP addresses, and it sees the size
// and timing of messages. Message bodies are sealed in the browser with a key the server never gets.

const ROOM_ID = /^[a-z2-9]{16}$/;
const MAX_PAYLOAD = 64 * 1024;
const PING_INTERVAL_MS = 25_000;

// Token bucket per connection. ICE candidates arrive in bursts when a mesh forms.
const BUCKET_SIZE = 300;
const REFILL_PER_SEC = 100;

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (tests, CLI tools)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachSignaling(server, cfg) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  /** @type {Map<string, Map<string, import('ws').WebSocket>>} */
  const rooms = new Map();
  const perIp = new Map();

  server.on('upgrade', (req, socket, head) => {
    const ok = req.url?.split('?')[0] === '/ws';
    const origin = req.headers.origin;
    const originOk = cfg.allowedOrigins.length ? !origin || cfg.allowedOrigins.includes(origin) : sameOrigin(req);
    const ip = clientIp(req, cfg.trustProxy);
    if (!ok || !originOk || (perIp.get(ip) || 0) >= cfg.maxConnectionsPerIp) {
      socket.write(`HTTP/1.1 ${ok ? (originOk ? 429 : 403) : 404} Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      wss.emit('connection', ws, req);
    });
  });

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  function leave(ws) {
    const room = ws.room;
    if (!room) return;
    room.delete(ws.id);
    ws.room = null;
    if (room.size === 0) {
      rooms.delete(ws.roomId);
    } else {
      for (const peer of room.values()) send(peer, { t: 'peer-left', id: ws.id });
    }
  }

  wss.on('connection', (ws) => {
    perIp.set(ws.ip, (perIp.get(ws.ip) || 0) + 1);
    ws.alive = true;
    ws.id = randomBytes(6).toString('hex');
    ws.room = null;
    ws.tokens = BUCKET_SIZE;
    ws.refilledAt = Date.now();

    ws.on('pong', () => {
      ws.alive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.close(1003, 'text only');

      const now = Date.now();
      ws.tokens = Math.min(BUCKET_SIZE, ws.tokens + ((now - ws.refilledAt) / 1000) * REFILL_PER_SEC);
      ws.refilledAt = now;
      if (--ws.tokens < 0) return ws.close(1008, 'rate limit');

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.close(1003, 'bad json');
      }

      if (msg.t === 'join') {
        if (ws.room || typeof msg.room !== 'string' || !ROOM_ID.test(msg.room)) {
          return send(ws, { t: 'error', code: 'bad-room' });
        }
        let room = rooms.get(msg.room);
        if (!room) {
          if (rooms.size >= cfg.maxRooms) return send(ws, { t: 'error', code: 'busy' });
          room = new Map();
          rooms.set(msg.room, room);
        }
        if (room.size >= cfg.maxPeers) return send(ws, { t: 'error', code: 'full' });
        ws.room = room;
        ws.roomId = msg.room;
        const existing = [...room.keys()];
        room.set(ws.id, ws);
        send(ws, { t: 'joined', id: ws.id, peers: existing, max: cfg.maxPeers });
        for (const peer of room.values()) if (peer !== ws) send(peer, { t: 'peer-joined', id: ws.id });
        return;
      }

      if (msg.t === 'msg' && ws.room && typeof msg.d === 'string' && msg.d.length < MAX_PAYLOAD) {
        const out = { t: 'msg', from: ws.id, to: msg.to, d: msg.d };
        if (msg.to === '*') {
          for (const peer of ws.room.values()) if (peer !== ws) send(peer, out);
        } else if (typeof msg.to === 'string') {
          const peer = ws.room.get(msg.to);
          if (peer) send(peer, out);
        }
      }
    });

    ws.on('close', () => {
      const n = (perIp.get(ws.ip) || 1) - 1;
      if (n <= 0) perIp.delete(ws.ip);
      else perIp.set(ws.ip, n);
      leave(ws);
    });
    ws.on('error', () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  return {
    wss,
    stats: () => ({ rooms: rooms.size, peers: wss.clients.size }),
    close: () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
