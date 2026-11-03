// WebSocket connection to the relay. Reconnects with backoff and re-joins the room each time.
export class Signaling extends EventTarget {
  #ws = null;
  #room;
  #retry = 0;
  #closed = false;
  #timer = null;

  constructor(roomId) {
    super();
    this.#room = roomId;
  }

  start() {
    this.#open();
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #open() {
    if (this.#closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.#ws = ws;

    ws.onopen = () => {
      this.#retry = 0;
      ws.send(JSON.stringify({ t: 'join', room: this.#room }));
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === 'error') this.#emit('server-error', m.code);
      else this.#emit(m.t, m);
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      if (this.#closed) return;
      this.#emit('disconnected');
      const delay = Math.min(8000, 400 * 2 ** this.#retry++) + Math.random() * 300;
      this.#timer = setTimeout(() => this.#open(), delay);
    };
    ws.onerror = () => ws.close();
  }

  /** `to` is a peer id or '*' for everyone else. `data` is already sealed. */
  send(to, data) {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'msg', to, d: data }));
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }
}
