import { deriveSenderKey, open, seal } from './crypto.js';

export const e2eeSupported = typeof RTCRtpScriptTransform !== 'undefined' && typeof Worker !== 'undefined';

const MAX_NAME = 40;
const MAX_CHAT = 2000;

// Strip control and bidirectional-override characters so names can't spoof or reorder text.
const clean = (v, max) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : '';

/**
 * Full mesh of RTCPeerConnections. Every signalling message (offers, answers, ICE candidates,
 * names, status, chat) is sealed with the room key before it reaches the relay, and every encoded
 * media frame is encrypted with a per-sender key by a worker (see e2ee-worker.js).
 *
 * Events: 'peer' (a peer's info, streams or connection changed), 'peer-joined', 'peer-left',
 * 'chat', 'hand'.
 */
export class Mesh extends EventTarget {
  peers = new Map();
  camStream = new MediaStream();
  screenStream = null;
  state = { name: '', audio: false, video: false, hand: false, cam: null, screen: null, e2ee: false };

  #sig;
  #roomId;
  #keys;
  #iceServers;
  #selfId = '';
  #selfKey = null;
  #worker = null;
  #destroyed = false;

  constructor({ signaling, roomId, keys, iceServers, selfId, name, useFrameEncryption }) {
    super();
    this.#sig = signaling;
    this.#roomId = roomId;
    this.#keys = keys;
    this.#iceServers = iceServers;
    this.#selfId = selfId;
    this.state.name = name;
    this.state.cam = this.camStream.id;
    this.state.e2ee = useFrameEncryption;
    if (useFrameEncryption) {
      this.ready = deriveSenderKey(keys.mediaRoot, selfId).then((k) => {
        this.#selfKey = k;
      });
      this.#worker = new Worker(new URL('./e2ee-worker.js', import.meta.url), { type: 'module' });
      this.#worker.onmessage = ({ data }) => this.#onWorker(data);
      this.#worker.onerror = (e) => console.error('e2ee worker error', e.message);
    }
  }

  get selfId() {
    return this.#selfId;
  }

  get frameEncryption() {
    return !!this.#worker;
  }

  /** Resolves once our own frame key exists. Peers are only built after this. */
  ready = Promise.resolve();

  async init() {
    await this.ready;
  }

  /* ---------- sending ---------- */

  // Sealing is async and a description is much larger than a candidate, so without a queue a
  // candidate can overtake the offer it belongs to. Messages leave strictly in the order queued.
  #outbox = Promise.resolve();

  #send(to, payload) {
    this.#outbox = this.#outbox
      .then(async () => {
        if (this.#destroyed) return;
        const data = await seal(this.#keys.signalKey, payload, this.#roomId, this.#selfId, to);
        this.#sig.send(to, data);
      })
      .catch((e) => console.warn('send failed', e));
    return this.#outbox;
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.#send('*', { k: 'state', s: this.state });
  }

  sendChat(text) {
    const msg = { k: 'chat', text: String(text).slice(0, MAX_CHAT), ts: Date.now() };
    this.#send('*', msg);
    return msg;
  }

  /* ---------- peers ---------- */

  /**
   * `initiator` is true for peers that were already in the room when we arrived (and for
   * newcomers we are told about): exactly one side makes the first offer, so the initial
   * connection never involves two offers colliding. Perfect negotiation still covers later changes.
   */
  addPeer(id, { initiator = false } = {}) {
    if (id === this.#selfId) return null;
    const existing = this.peers.get(id);
    if (existing) return existing;
    const peer = {
      id,
      initiator,
      polite: this.#selfId > id, // exactly one side of each pair is polite
      making: false,
      ignore: false,
      pc: null,
      key: null,
      info: { name: '', audio: true, video: true, hand: false, cam: null, screen: null, e2ee: true },
      streams: new Map(),
      senders: { cam: {}, screen: [] },
      conn: 'connecting',
      crypto: { decrypted: 0, dropped: 0, byStream: {} },
      queue: Promise.resolve(),
    };
    this.peers.set(id, peer);
    peer.queue = (async () => {
      await this.ready;
      if (this.#worker) peer.key = await deriveSenderKey(this.#keys.mediaRoot, id);
      if (this.#destroyed || this.peers.get(id) !== peer) return;
      this.#build(peer);
    })().catch((e) => console.warn('peer setup failed', e));
    return peer;
  }

  removePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.fallback);
    try {
      peer.pc?.close();
    } catch {
      /* already closed */
    }
    this.#applyBitrates();
    this.dispatchEvent(new CustomEvent('peer-left', { detail: { id, name: peer.info.name } }));
  }

  #build(peer) {
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers, bundlePolicy: 'max-bundle' });
    peer.pc = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#send(peer.id, { k: 'ice', c: candidate.toJSON() });
    };

    pc.onnegotiationneeded = () => {
      if (!peer.initiator && !pc.remoteDescription) return; // wait for their first offer
      this.#negotiate(peer);
    };
    if (!peer.initiator) {
      // Safety net: if the other side never offers, do it ourselves.
      peer.fallback = setTimeout(() => {
        if (this.peers.get(peer.id) === peer && !pc.remoteDescription && pc.signalingState === 'stable') {
          peer.initiator = true;
          this.#negotiate(peer);
        }
      }, 6000);
    }

    pc.ontrack = ({ track, receiver, streams }) => {
      this.#decryptWith(peer, receiver);
      const stream = streams[0] || new MediaStream([track]);
      peer.streams.set(stream.id, stream);
      stream.addEventListener('removetrack', () => {
        if (!stream.getTracks().length) {
          peer.streams.delete(stream.id);
          this.#changed(peer);
        }
      });
      this.#changed(peer);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        peer.conn = 'connected';
        this.#applyBitrates();
      } else if (s === 'disconnected') peer.conn = 'reconnecting';
      else if (s === 'failed') {
        peer.conn = 'reconnecting';
        pc.restartIce();
      } else if (s === 'connecting' || s === 'new') peer.conn = peer.conn === 'connected' ? 'reconnecting' : 'connecting';
      this.#changed(peer);
    };

    for (const track of this.camStream.getTracks()) peer.senders.cam[track.kind] = this.#addTrack(peer, track, this.camStream);
    if (this.screenStream) {
      peer.senders.screen = this.screenStream.getTracks().map((t) => this.#addTrack(peer, t, this.screenStream));
    }
    this.#send(peer.id, { k: 'state', s: this.state });
    this.#applyBitrates();
  }

  async #negotiate(peer) {
    const pc = peer.pc;
    try {
      peer.making = true;
      await pc.setLocalDescription();
      const { type, sdp } = pc.localDescription;
      await this.#send(peer.id, { k: 'desc', d: { type, sdp } });
    } catch (e) {
      console.warn('negotiation failed', e);
    } finally {
      peer.making = false;
    }
  }

  // Chrome ignores a receiver transform that is first assigned inside `ontrack` when the
  // transceiver was created locally (addTrack), so it is also set as soon as the transceiver exists.
  #decryptWith(peer, receiver) {
    if (!this.#worker || !peer.key || receiver.transform) return;
    receiver.transform = new RTCRtpScriptTransform(this.#worker, {
      operation: 'decrypt',
      key: peer.key,
      kind: receiver.track.kind,
      peerId: peer.id,
    });
  }

  #addTrack(peer, track, stream) {
    const sender = peer.pc.addTrack(track, stream);
    const transceiver = peer.pc.getTransceivers().find((t) => t.sender === sender);
    if (transceiver) this.#decryptWith(peer, transceiver.receiver);
    if (this.#worker && this.#selfKey) {
      sender.transform = new RTCRtpScriptTransform(this.#worker, {
        operation: 'encrypt',
        key: this.#selfKey,
        kind: track.kind,
        peerId: peer.id,
      });
    }
    if (track.kind === 'video') this.#preferVp8(peer.pc, sender);
    return sender;
  }

  // Frame encryption keeps the first bytes of each frame readable so the RTP packetiser still
  // works; those offsets are the VP8 ones, so VP8 is the only video codec we offer.
  #preferVp8(pc, sender) {
    try {
      const tr = pc.getTransceivers().find((t) => t.sender === sender);
      const codecs = RTCRtpSender.getCapabilities('video')?.codecs || [];
      const allowed = codecs.filter((c) => /video\/(vp8|rtx|red|ulpfec)/i.test(c.mimeType));
      if (tr && allowed.some((c) => /vp8/i.test(c.mimeType))) tr.setCodecPreferences(allowed);
    } catch {
      /* older browsers: negotiation falls back to defaults */
    }
  }

  /* ---------- local media ---------- */

  setCameraTrack(kind, track) {
    const current = this.camStream.getTracks().find((t) => t.kind === kind);
    if (current && current !== track) this.camStream.removeTrack(current);
    if (track && current !== track) this.camStream.addTrack(track);
    for (const peer of this.peers.values()) {
      if (!peer.pc) continue;
      const sender = peer.senders.cam[kind];
      if (sender) sender.replaceTrack(track).catch(() => {});
      else if (track) peer.senders.cam[kind] = this.#addTrack(peer, track, this.camStream);
    }
    this.#applyBitrates();
  }

  startScreen(stream) {
    this.screenStream = stream;
    this.setState({ screen: stream.id });
    for (const peer of this.peers.values()) {
      if (peer.pc) peer.senders.screen = stream.getTracks().map((t) => this.#addTrack(peer, t, stream));
    }
    this.#applyBitrates();
  }

  stopScreen() {
    if (!this.screenStream) return;
    for (const peer of this.peers.values()) {
      for (const s of peer.senders.screen) {
        try {
          peer.pc.removeTrack(s);
        } catch {
          /* connection closed */
        }
      }
      peer.senders.screen = [];
    }
    this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.setState({ screen: null });
  }

  // Mesh upload cost grows with every person, so each outgoing stream gets a smaller share.
  #applyBitrates() {
    const remotes = Math.max(1, this.peers.size);
    const camBps = Math.min(1_500_000, Math.max(250_000, Math.floor(2_400_000 / remotes)));
    const scale = remotes >= 4 ? 2 : remotes === 3 ? 1.5 : 1;
    const screenBps = Math.min(2_500_000, Math.max(500_000, Math.floor(3_000_000 / remotes)));
    for (const peer of this.peers.values()) {
      if (!peer.pc) continue;
      const apply = (sender, bps, scaleDown, hint) => {
        if (!sender?.track || sender.track.kind !== 'video') return;
        const p = sender.getParameters();
        if (!p.encodings?.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = bps;
        p.encodings[0].scaleResolutionDownBy = scaleDown;
        p.degradationPreference = hint;
        sender.setParameters(p).catch(() => {});
      };
      apply(peer.senders.cam.video, camBps, scale, 'balanced');
      for (const s of peer.senders.screen) apply(s, screenBps, 1, 'maintain-resolution');
    }
  }

  /* ---------- receiving ---------- */

  handleMessage({ from, to, d }) {
    if (from === this.#selfId) return;
    const peer = this.peers.get(from) || this.addPeer(from);
    if (!peer) return;
    // Keep per-peer processing in order: SDP and ICE must be applied in the order they were sent.
    peer.queue = peer.queue
      .then(async () => {
        const payload = await open(this.#keys.signalKey, d, this.#roomId, from, to);
        if (payload && this.peers.get(from) === peer) await this.#process(peer, payload);
      })
      .catch((e) => console.warn('message failed', e));
  }

  async #process(peer, p) {
    switch (p?.k) {
      case 'state':
        return this.#onState(peer, p.s);
      case 'chat': {
        const text = typeof p.text === 'string' ? p.text.slice(0, MAX_CHAT) : '';
        if (text.trim()) {
          this.dispatchEvent(
            new CustomEvent('chat', { detail: { from: peer.id, name: peer.info.name || '…', text, ts: Date.now() } }),
          );
        }
        return;
      }
      case 'desc':
        return this.#onDescription(peer, p.d);
      case 'ice':
        if (!peer.pc || !p.c) return;
        if (!peer.pc.remoteDescription) {
          (peer.pendingIce ||= []).push(p.c); // arrived before the offer/answer; apply it afterwards
          return;
        }
        try {
          await peer.pc.addIceCandidate(p.c);
        } catch (e) {
          if (!peer.ignore) console.warn('candidate rejected', e);
        }
    }
  }

  #onState(peer, s) {
    if (!s || typeof s !== 'object') return;
    const first = !peer.info.name;
    const prev = peer.info;
    peer.info = {
      name: clean(s.name, MAX_NAME) || prev.name || 'Guest',
      audio: s.audio !== false,
      video: s.video !== false,
      hand: s.hand === true,
      cam: typeof s.cam === 'string' ? s.cam : null,
      screen: typeof s.screen === 'string' ? s.screen : null,
      e2ee: s.e2ee !== false,
    };
    if (first) this.dispatchEvent(new CustomEvent('peer-joined', { detail: { id: peer.id, name: peer.info.name } }));
    if (peer.info.hand && !prev.hand) {
      this.dispatchEvent(new CustomEvent('hand', { detail: { id: peer.id, name: peer.info.name } }));
    }
    this.#changed(peer);
  }

  // "Perfect negotiation": if both sides offer at once, the polite one rolls back and accepts.
  async #onDescription(peer, desc) {
    const pc = peer.pc;
    if (!pc || !desc || (desc.type !== 'offer' && desc.type !== 'answer') || typeof desc.sdp !== 'string') return;
    const collision = desc.type === 'offer' && (peer.making || pc.signalingState !== 'stable');
    peer.ignore = !peer.polite && collision;
    if (peer.ignore) return;
    await pc.setRemoteDescription({ type: desc.type, sdp: desc.sdp });
    for (const c of peer.pendingIce?.splice(0) || []) {
      await pc.addIceCandidate(c).catch(() => {});
    }
    if (desc.type === 'offer') {
      await pc.setLocalDescription();
      const { type, sdp } = pc.localDescription;
      await this.#send(peer.id, { k: 'desc', d: { type, sdp } });
    }
  }

  #onWorker(data) {
    if (data?.type !== 'stats' || data.operation !== 'decrypt') return;
    const peer = this.peers.get(data.peerId);
    if (!peer) return;
    peer.crypto.byStream[data.kind] = { decrypted: data.decrypted, dropped: data.dropped };
    const all = Object.values(peer.crypto.byStream);
    peer.crypto.decrypted = all.reduce((n, s) => n + s.decrypted, 0);
    peer.crypto.dropped = all.reduce((n, s) => n + s.dropped, 0);
    this.#changed(peer);
  }

  #changed(peer) {
    if (!this.#destroyed) this.dispatchEvent(new CustomEvent('peer', { detail: peer.id }));
  }

  /** Which streams to show for a peer: one camera tile and, if they're presenting, one screen tile. */
  tilesFor(peer) {
    const tiles = [];
    const screen = peer.info.screen && peer.streams.get(peer.info.screen);
    const cam = [...peer.streams.values()].find((s) => s.id !== peer.info.screen);
    tiles.push({ kind: 'camera', stream: cam || null });
    if (screen) tiles.push({ kind: 'screen', stream: screen });
    return tiles;
  }

  destroy({ keepLocal = false } = {}) {
    this.#destroyed = true;
    for (const peer of this.peers.values()) {
      clearTimeout(peer.fallback);
      try {
        peer.pc?.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    this.#worker?.terminate();
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    if (!keepLocal) this.camStream.getTracks().forEach((t) => t.stop());
  }
}
