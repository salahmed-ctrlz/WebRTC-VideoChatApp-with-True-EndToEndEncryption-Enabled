import { h, t, toast, copyText, linkify, initials, clear } from '../ui.js';
import { icon } from '../icons.js';
import { Signaling } from '../signaling.js';
import { Mesh } from '../mesh.js';
import { formatMeetingHash } from '../crypto.js';
import { getLocalMedia, getScreen, listDevices, canShareScreen, canPickSpeaker, watchLevel } from '../media.js';

const GAP = 8;

export function room(root, app, session) {
  const { meeting, keys, config, brand } = app;
  const features = brand.features;
  const link = `${location.origin}${location.pathname}#${formatMeetingHash(meeting.roomId, meeting.secret)}`;

  /* ---------- state ---------- */
  const local = { audio: session.tracks.audio, video: session.tracks.video };
  const me = { name: session.name, micOn: session.micOn, camOn: session.camOn, hand: false };
  const chatLog = [];
  let sinkId = session.sinkId || '';
  let mesh = null;
  let online = false;
  let panel = null; // 'chat' | 'people' | null
  let unread = 0;
  let pinned = null;
  let dead = false;
  let frame = 0;
  let wakeLock = null;
  const tiles = new Map();
  const selfView = new MediaStream();
  const ctx = new AudioContext();

  if (!me.camOn && local.video) {
    local.video.stop();
    local.video = null;
  }
  if (local.audio) local.audio.enabled = me.micOn;
  if (local.video) selfView.addTrack(local.video);

  /* ---------- DOM skeleton ---------- */
  const stage = h('div', { class: 'stage', 'aria-label': 'Participants' });
  const waiting = h('div', { class: 'waiting', hidden: true });
  const banner = h('div', { class: 'conn-banner', role: 'status', hidden: true }, t('lostConnection'));
  const countEl = h('span', { class: 'count' });
  const panelEl = h('aside', { class: 'panel', hidden: true, 'aria-label': 'Side panel' });
  const controls = h('div', { class: 'controls', role: 'toolbar', 'aria-label': 'Meeting controls' });
  const secureBtn = h('button', { class: 'secure', type: 'button', onclick: () => showSecurity() },
    icon('lock', 16), h('span', { class: 'secure-text' }, t('encrypted')));

  const shell = h('div', { class: 'room' },
    h('header', { class: 'room-top' },
      secureBtn,
      h('div', { class: 'room-meta' }, h('span', { class: 'room-name' }, brand.name), countEl),
      h('button', { class: 'btn sm', type: 'button', onclick: copyInvite }, icon('copy', 16), h('span', { class: 'hide-sm' }, t('copyLink'))),
    ),
    banner,
    h('div', { class: 'room-body' }, h('div', { class: 'stage-wrap' }, stage, waiting), panelEl),
    controls,
  );
  root.append(shell);

  /* ---------- controls ---------- */
  const mk = (cls, label, onclick, extra) => {
    const b = h('button', { class: `ctl ${cls}`, type: 'button', onclick, 'aria-label': label, title: label });
    if (extra) b.append(extra);
    return b;
  };
  const btn = {
    mic: mk('', '', () => toggleMic()),
    cam: mk('', '', () => toggleCam()),
    share: features.screenShare && canShareScreen() ? mk('', '', () => toggleShare()) : null,
    hand: features.raiseHand ? mk('', '', () => toggleHand()) : null,
    chat: features.chat ? mk('', t('chat'), () => togglePanel('chat')) : null,
    people: mk('', t('people'), () => togglePanel('people')),
    settings: mk('', t('settings'), () => showSettings()),
    leave: h('button', { class: 'ctl leave', type: 'button', onclick: () => leave(), 'aria-label': t('leave'), title: t('leave') }, icon('leave'), h('span', { class: 'ctl-label' }, t('leave'))),
  };
  const chatBadge = h('span', { class: 'badge', hidden: true });
  btn.chat?.append(chatBadge);
  const labelled = (b, ic, text) => b.replaceChildren(icon(ic), h('span', { class: 'ctl-label' }, text));

  function paintControls() {
    const hasMic = !!local.audio;
    const hasCam = !!local.video;
    const micOn = me.micOn && hasMic;
    labelled(btn.mic, micOn ? 'mic' : 'micOff', micOn ? t('mute') : t('unmute'));
    btn.mic.classList.toggle('off', !micOn);
    btn.mic.setAttribute('aria-label', micOn ? `${t('mute')} (M)` : `${t('unmute')} (M)`);
    btn.mic.setAttribute('aria-pressed', String(!micOn));
    const camOn = me.camOn && hasCam;
    labelled(btn.cam, camOn ? 'video' : 'videoOff', camOn ? t('cameraOffAction') : t('cameraOn'));
    btn.cam.classList.toggle('off', !camOn);
    btn.cam.setAttribute('aria-label', `${camOn ? t('cameraOffAction') : t('cameraOn')} (V)`);
    btn.cam.setAttribute('aria-pressed', String(!camOn));
    if (btn.share) {
      const on = !!mesh?.screenStream;
      labelled(btn.share, on ? 'screenOff' : 'screen', on ? t('stopPresenting') : t('present'));
      btn.share.classList.toggle('active', on);
      btn.share.setAttribute('aria-label', `${on ? t('stopPresenting') : t('present')} (S)`);
      btn.share.setAttribute('aria-pressed', String(on));
    }
    if (btn.hand) {
      labelled(btn.hand, 'hand', me.hand ? t('lowerHand') : t('raiseHand'));
      btn.hand.classList.toggle('active', me.hand);
      btn.hand.setAttribute('aria-pressed', String(me.hand));
      btn.hand.setAttribute('aria-label', `${me.hand ? t('lowerHand') : t('raiseHand')} (H)`);
    }
    if (btn.chat) {
      const keep = chatBadge;
      labelled(btn.chat, 'chat', t('chat'));
      btn.chat.append(keep);
      btn.chat.classList.toggle('active', panel === 'chat');
      btn.chat.setAttribute('aria-label', `${t('chat')} (C)`);
    }
    labelled(btn.people, 'users', t('people'));
    btn.people.classList.toggle('active', panel === 'people');
    btn.people.setAttribute('aria-label', `${t('people')} (P)`);
    labelled(btn.settings, 'settings', t('settings'));
    chatBadge.hidden = unread === 0;
    chatBadge.textContent = unread > 9 ? '9+' : String(unread);
  }
  controls.append(...Object.values(btn).filter(Boolean));

  /* ---------- actions ---------- */
  async function toggleMic() {
    if (!local.audio) {
      const m = await getLocalMedia({ wantVideo: false });
      if (!m.audio) return toast(t('noDevices'), { tone: 'warn' });
      local.audio = m.audio;
      mesh?.setCameraTrack('audio', m.audio);
      me.micOn = true;
    } else {
      me.micOn = !me.micOn;
    }
    local.audio.enabled = me.micOn;
    mesh?.setState({ audio: me.micOn });
    paintControls();
    render();
  }

  async function toggleCam() {
    if (local.video) {
      const old = local.video;
      local.video = null;
      selfView.removeTrack(old);
      mesh?.setCameraTrack('video', null);
      old.stop();
      me.camOn = false;
    } else {
      const m = await getLocalMedia({ wantAudio: false });
      if (!m.video) return toast(t('noDevices'), { tone: 'warn' });
      local.video = m.video;
      selfView.addTrack(m.video);
      mesh?.setCameraTrack('video', m.video);
      me.camOn = true;
    }
    mesh?.setState({ video: me.camOn });
    paintControls();
    render();
  }

  async function toggleShare() {
    if (!mesh) return;
    if (mesh.screenStream) {
      mesh.stopScreen();
    } else {
      try {
        const stream = await getScreen();
        stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          if (mesh?.screenStream === stream) {
            mesh.stopScreen();
            paintControls();
            render();
          }
        });
        mesh.startScreen(stream);
      } catch (e) {
        if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast(t('screenFailed'), { tone: 'warn' });
      }
    }
    paintControls();
    render();
  }

  function toggleHand() {
    me.hand = !me.hand;
    mesh?.setState({ hand: me.hand });
    paintControls();
    render();
  }

  function togglePanel(name) {
    panel = panel === name ? null : name;
    if (panel === 'chat') unread = 0;
    paintPanel();
    paintControls();
  }

  async function copyInvite() {
    toast((await copyText(link)) ? t('linkCopied') : t('copyFailed'));
  }

  function leave(reason = 'left') {
    cleanup();
    app.leaveRoom(reason);
  }

  /* ---------- signalling ---------- */
  const sig = new Signaling(meeting.roomId);

  sig.addEventListener('joined', async ({ detail }) => {
    mesh?.destroy({ keepLocal: true });
    mesh = new Mesh({
      signaling: sig, roomId: meeting.roomId, keys, iceServers: config.iceServers,
      selfId: detail.id, name: me.name, useFrameEncryption: app.e2ee,
    });
    if (local.audio) mesh.camStream.addTrack(local.audio);
    if (local.video) mesh.camStream.addTrack(local.video);
    Object.assign(mesh.state, { audio: me.micOn && !!local.audio, video: me.camOn && !!local.video, hand: me.hand });
    await mesh.init();
    if (dead) return mesh.destroy();
    mesh.addEventListener('peer', schedule);
    mesh.addEventListener('peer-joined', ({ detail: d }) => { toast(t('joined', d.name)); schedule(); });
    mesh.addEventListener('peer-left', ({ detail: d }) => { if (d.name) toast(t('left', d.name)); schedule(); });
    mesh.addEventListener('hand', ({ detail: d }) => toast(t('raisedHand', d.name)));
    mesh.addEventListener('chat', ({ detail: m }) => addMessage({ ...m, self: false }));
    for (const id of detail.peers) mesh.addPeer(id, { initiator: false });
    online = true;
    banner.hidden = true;
    paintControls();
    render();
  });
  sig.addEventListener('peer-joined', ({ detail }) => { mesh?.addPeer(detail.id, { initiator: true }); schedule(); });
  sig.addEventListener('peer-left', ({ detail }) => { mesh?.removePeer(detail.id); schedule(); });
  sig.addEventListener('msg', ({ detail }) => mesh?.handleMessage(detail));
  sig.addEventListener('disconnected', () => { online = false; banner.hidden = false; render(); });
  sig.addEventListener('server-error', ({ detail: code }) => {
    leave(code);
    toast(code === 'full' ? t('roomFull') : t('serverBusy'), { tone: 'warn', ms: 6000 });
  });
  sig.start();

  /* ---------- tiles & layout ---------- */
  function schedule() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  function desiredTiles() {
    const list = [];
    list.push({ key: 'self-camera', self: true, kind: 'camera', name: `${me.name} (${t('you')})`, stream: selfView,
      videoOn: !!local.video && me.camOn, audioOn: me.micOn && !!local.audio, hand: me.hand });
    if (mesh?.screenStream) {
      list.push({ key: 'self-screen', self: true, kind: 'screen', name: t('yourScreen'), stream: mesh.screenStream, videoOn: true, audioOn: true });
    }
    for (const peer of mesh?.peers.values() || []) {
      if (!peer.info.name) continue; // wait until they've introduced themselves
      for (const tile of mesh.tilesFor(peer)) {
        const live = tile.stream?.getVideoTracks().some((tr) => tr.readyState === 'live');
        list.push({
          key: `${peer.id}-${tile.kind}`, peer, kind: tile.kind, stream: tile.stream,
          name: tile.kind === 'screen' ? t('screenOf', peer.info.name) : peer.info.name,
          videoOn: tile.kind === 'screen' ? true : peer.info.video && !!live,
          audioOn: peer.info.audio, hand: tile.kind === 'camera' && peer.info.hand,
        });
      }
    }
    return list;
  }

  function makeTile(key) {
    const video = h('video', { autoplay: true, playsinline: true });
    const avatar = h('div', { class: 'avatar' }, h('span'));
    const nameEl = h('span', { class: 'tile-name' });
    const badges = h('span', { class: 'tile-badges' });
    const status = h('div', { class: 'tile-status' });
    const el = h('div', { class: 'tile', tabindex: 0, role: 'group', dataset: { key } }, video, avatar, status,
      h('div', { class: 'tile-bar' }, nameEl, badges));
    el.addEventListener('click', () => { pinned = pinned === key ? null : key; render(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.click(); });
    return { key, el, video, avatar, nameEl, badges, status, stream: null, stop: null, audioId: null, hold: 0 };
  }

  function syncTile(tile, d) {
    const { el, video } = tile;
    video.muted = !!d.self;
    if (video.srcObject !== d.stream) {
      video.srcObject = d.stream || null;
      if (d.stream) video.play().catch(() => {});
    } else if (d.stream && video.paused && !tile.playing) {
      // The autoplay attribute doesn't always fire for streams that gain tracks after being attached.
      tile.playing = true;
      video.play().catch(() => {}).finally(() => { tile.playing = false; });
    }
    if (sinkId && video.setSinkId && video.sinkId !== sinkId) video.setSinkId(sinkId).catch(() => {});
    el.dataset.kind = d.kind;
    el.classList.toggle('self', !!d.self && d.kind === 'camera');
    el.classList.toggle('no-video', !d.videoOn);
    tile.avatar.firstChild.textContent = initials(d.peer ? d.peer.info.name : me.name);
    tile.nameEl.textContent = d.name;
    el.setAttribute('aria-label', d.name);

    const badges = [];
    if (!d.audioOn && d.kind === 'camera') badges.push(h('span', { class: 'badge-ico off', title: t('unmuteHint') }, icon('micOff', 14)));
    if (d.hand) badges.push(h('span', { class: 'badge-ico hand', title: t('raiseHand') }, icon('hand', 14)));
    tile.badges.replaceChildren(...badges);

    let status = '';
    if (d.peer) {
      const sec = peerSecurity(d.peer);
      if (sec.tone === 'bad') status = sec.text;
      else if (d.peer.conn !== 'connected') status = d.peer.conn === 'reconnecting' ? t('reconnecting') : t('connecting');
    }
    tile.status.textContent = status;
    tile.status.hidden = !status;

    // Speaking indicator (remote camera streams only)
    const audioTrack = d.stream && !d.self && d.kind === 'camera' ? d.stream.getAudioTracks()[0] : null;
    if (audioTrack?.id !== tile.audioId) {
      tile.stop?.();
      tile.stop = null;
      tile.audioId = audioTrack?.id || null;
      if (audioTrack) {
        tile.stop = watchLevel(new MediaStream([audioTrack]), (level) => {
          const now = performance.now();
          if (level > 0.12) tile.hold = now + 350;
          el.classList.toggle('speaking', now < tile.hold);
        }, ctx);
      }
    }
  }

  function render() {
    if (dead) return;
    const desired = desiredTiles();
    const seen = new Set();
    desired.forEach((d, i) => {
      seen.add(d.key);
      let tile = tiles.get(d.key);
      if (!tile) {
        tile = makeTile(d.key);
        tiles.set(d.key, tile);
      }
      syncTile(tile, d);
      if (stage.children[i] !== tile.el) stage.insertBefore(tile.el, stage.children[i] || null);
    });
    for (const [key, tile] of tiles) {
      if (seen.has(key)) continue;
      tile.stop?.();
      tile.video.srcObject = null;
      tile.el.remove();
      tiles.delete(key);
    }
    if (pinned && !seen.has(pinned)) pinned = null;

    const main = pinned || desired.find((d) => d.kind === 'screen')?.key || null;
    const spotlight = main && desired.length > 1;
    stage.dataset.layout = spotlight ? 'spotlight' : 'grid';
    stage.style.setProperty('--rail', String(Math.max(1, desired.length - 1)));
    for (const [key, tile] of tiles) {
      tile.el.classList.toggle('is-main', !!spotlight && key === main);
      tile.el.classList.toggle('pinned', key === pinned);
    }
    if (spotlight && stage.firstChild !== tiles.get(main).el) stage.prepend(tiles.get(main).el);
    fit(desired.length, spotlight);

    const peers = mesh ? [...mesh.peers.values()].filter((p) => p.info.name).length + 1 : 1;
    countEl.textContent = `${peers} ${peers === 1 ? 'person' : 'people'}`;
    const alone = online && mesh && [...mesh.peers.values()].every((p) => !p.info.name);
    waiting.hidden = !alone;
    if (alone && !waiting.firstChild) {
      waiting.append(h('strong', {}, t('waiting')), h('span', {}, t('waitingText')),
        h('button', { class: 'btn sm primary', type: 'button', onclick: copyInvite }, icon('copy', 16), t('copyLink')));
    }
    secureBtn.classList.toggle('warn', !!mesh && !mesh.frameEncryption);
    secureBtn.querySelector('.secure-text').textContent = mesh && !mesh.frameEncryption ? t('mediaOnlyDtls') : t('encrypted');
    if (panel === 'people') paintPeople();
  }

  // Pick the column count that gives the largest tiles for the space available.
  function fit(n, spotlight) {
    if (spotlight || n === 0) return;
    const W = stage.clientWidth;
    const H = stage.clientHeight;
    if (!W || !H) return;
    const ratio = W >= H ? 16 / 9 : 3 / 4;
    let best = { w: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((W - GAP * (cols - 1)) / cols, ((H - GAP * (rows - 1)) / rows) * ratio);
      if (w > best.w) best = { w, cols };
    }
    stage.style.setProperty('--tw', `${Math.floor(best.w)}px`);
    stage.style.setProperty('--ratio', String(ratio));
  }
  const ro = new ResizeObserver(() => render());
  ro.observe(stage);

  /* ---------- side panel ---------- */
  const chatList = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' }, h('p', { class: 'muted empty' }, t('chatEmpty')));
  const chatInput = h('input', { type: 'text', maxlength: 2000, placeholder: t('messagePlaceholder'), 'aria-label': t('messagePlaceholder'), autocomplete: 'off' });
  const chatForm = h('form', { class: 'chat-form', onsubmit: (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !mesh) return;
    const msg = mesh.sendChat(text);
    addMessage({ name: me.name, text, ts: msg.ts, self: true });
    chatInput.value = '';
  } }, chatInput, h('button', { class: 'btn primary icon-only', type: 'submit', 'aria-label': t('sending') }, icon('send', 18)));
  const peopleList = h('div', { class: 'people-list' });

  function addMessage(m) {
    chatLog.push(m);
    chatList.querySelector('.empty')?.remove();
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    chatList.append(h('div', { class: `msg${m.self ? ' self' : ''}` },
      h('div', { class: 'msg-meta' }, h('span', {}, m.self ? t('you') : m.name), h('time', {}, time)),
      h('div', { class: 'msg-text' }, linkify(m.text))));
    chatList.scrollTop = chatList.scrollHeight;
    if (!m.self && panel !== 'chat') {
      unread++;
      paintControls();
    }
  }

  function peerSecurity(peer) {
    if (!mesh?.frameEncryption) return { tone: 'warn', text: t('mediaOnlyDtls') };
    const c = peer.crypto;
    if (!peer.info.e2ee || (c.dropped > 0 && c.decrypted === 0)) return { tone: 'bad', text: t('cantDecrypt') };
    if (c.decrypted > 0) return { tone: 'good', text: t('encryptedLabel') };
    return { tone: 'muted', text: t('connecting') };
  }

  function personRow(name, { audio, video, hand, sec, you }) {
    return h('div', { class: 'person' },
      h('span', { class: 'person-avatar' }, initials(name)),
      h('span', { class: 'person-name' }, you ? `${name} (${t('you')})` : name),
      h('span', { class: 'person-icons' },
        hand && icon('hand', 16),
        !audio && icon('micOff', 16),
        !video && icon('videoOff', 16)),
      sec && h('span', { class: `chip ${sec.tone}` }, sec.text));
  }

  function paintPeople() {
    const rows = [personRow(me.name, { audio: me.micOn && !!local.audio, video: me.camOn && !!local.video, hand: me.hand, you: true,
      sec: mesh ? { tone: mesh.frameEncryption ? 'good' : 'warn', text: mesh.frameEncryption ? t('encryptedLabel') : t('mediaOnlyDtls') } : null })];
    for (const p of mesh?.peers.values() || []) {
      if (p.info.name) rows.push(personRow(p.info.name, { audio: p.info.audio, video: p.info.video, hand: p.info.hand, sec: peerSecurity(p) }));
    }
    peopleList.replaceChildren(...rows,
      h('div', { class: 'invite-block' }, h('strong', {}, t('invite')),
        h('div', { class: 'invite' }, h('input', { type: 'text', readonly: true, value: link, 'aria-label': t('invite'), onfocus: (e) => e.target.select() }),
          h('button', { class: 'btn', type: 'button', onclick: copyInvite }, icon('copy', 16)))));
  }

  function paintPanel() {
    panelEl.hidden = !panel;
    shell.dataset.panel = panel || '';
    if (!panel) return;
    clear(panelEl);
    panelEl.append(
      h('div', { class: 'panel-head' }, h('h2', {}, panel === 'chat' ? t('chat') : t('people')),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('closePanel'), onclick: () => togglePanel(panel) }, icon('x'))),
      panel === 'chat' ? h('div', { class: 'chat' }, chatList, chatForm) : peopleList,
    );
    if (panel === 'people') paintPeople();
    if (panel === 'chat') { chatList.scrollTop = chatList.scrollHeight; chatInput.focus(); }
    requestAnimationFrame(render);
  }

  /* ---------- dialogs ---------- */
  function dialog(title, ...body) {
    const d = h('dialog', { class: 'dialog', 'aria-label': title },
      h('div', { class: 'dialog-head' }, h('h2', {}, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('closePanel'), onclick: () => d.close() }, icon('x'))),
      ...body);
    d.addEventListener('close', () => d.remove());
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    shell.append(d);
    d.showModal();
    return d;
  }

  function showSecurity() {
    const rows = [];
    for (const p of mesh?.peers.values() || []) {
      if (!p.info.name) continue;
      const sec = peerSecurity(p);
      rows.push(h('li', {}, h('span', {}, p.info.name), h('span', { class: `chip ${sec.tone}` }, sec.text)));
    }
    dialog(mesh && !mesh.frameEncryption ? t('mediaOnlyDtls') : t('encrypted'),
      h('p', { class: 'muted' }, t('securityCodeHelp')),
      h('div', { class: 'code' }, keys.safetyCode),
      rows.length ? h('ul', { class: 'sec-list' }, rows) : null,
      h('details', { class: 'how' }, h('summary', {}, t('howPrivate')), t('howPrivateBody').map((p) => h('p', {}, p))));
  }

  async function showSettings() {
    const devices = await listDevices();
    const select = (id, label, items, current, onchange) => {
      const s = h('select', { id, onchange: () => onchange(s.value) }, h('option', { value: '' }, t('defaultDevice')),
        items.map((d, i) => h('option', { value: d.deviceId }, d.label || `${label} ${i + 1}`)));
      if (current) s.value = current;
      return h('div', { class: 'field' }, h('label', { for: id }, label), s);
    };
    dialog(t('settings'),
      select('set-cam', t('camera'), devices.cameras, local.video?.getSettings().deviceId, async (id) => {
        const m = await getLocalMedia({ videoId: id, wantAudio: false });
        if (!m.video) return toast(t('noDevices'), { tone: 'warn' });
        const old = local.video;
        if (old) selfView.removeTrack(old);
        local.video = m.video;
        selfView.addTrack(m.video);
        mesh?.setCameraTrack('video', m.video);
        old?.stop();
        me.camOn = true;
        mesh?.setState({ video: true });
        paintControls();
        render();
      }),
      select('set-mic', t('microphone'), devices.mics, local.audio?.getSettings().deviceId, async (id) => {
        const m = await getLocalMedia({ audioId: id, wantVideo: false });
        if (!m.audio) return toast(t('noDevices'), { tone: 'warn' });
        const old = local.audio;
        local.audio = m.audio;
        m.audio.enabled = me.micOn;
        mesh?.setCameraTrack('audio', m.audio);
        old?.stop();
        paintControls();
      }),
      canPickSpeaker() ? select('set-spk', t('speaker'), devices.speakers, sinkId, (id) => { sinkId = id; render(); }) : null);
  }

  /* ---------- keyboard, wake lock, cleanup ---------- */
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, dialog')) return;
    const k = e.key.toLowerCase();
    const map = { m: toggleMic, v: toggleCam, s: toggleShare, h: toggleHand, c: () => togglePanel('chat'), p: () => togglePanel('people') };
    if (k === 'escape' && panel) togglePanel(panel);
    else if (map[k] && (k !== 's' || btn.share) && (k !== 'h' || btn.hand) && (k !== 'c' || btn.chat)) {
      e.preventDefault();
      map[k]();
    }
  }
  document.addEventListener('keydown', onKey);

  async function keepAwake() {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      wakeLock = null;
    }
  }
  const onVisible = () => { if (document.visibilityState === 'visible' && !dead) keepAwake(); };
  document.addEventListener('visibilitychange', onVisible);
  keepAwake();

  function cleanup() {
    if (dead) return;
    dead = true;
    cancelAnimationFrame(frame);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisible);
    ro.disconnect();
    sig.close();
    mesh?.destroy();
    local.audio?.stop();
    local.video?.stop();
    for (const tile of tiles.values()) tile.stop?.();
    tiles.clear();
    ctx.close().catch(() => {});
    wakeLock?.release?.().catch?.(() => {});
  }

  paintControls();
  render();
  return cleanup;
}
