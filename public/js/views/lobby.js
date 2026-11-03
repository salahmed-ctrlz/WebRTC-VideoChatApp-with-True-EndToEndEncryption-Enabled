import { h, t, copyText, toast } from '../ui.js';
import { icon } from '../icons.js';
import { getLocalMedia, listDevices, canPickSpeaker, watchLevel } from '../media.js';
import { formatMeetingHash } from '../crypto.js';

const NAME_KEY = 'display-name';
const load = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export function lobby(root, app) {
  const { meeting, keys, brand } = app;
  const blocked = brand.requireFrameEncryption && !app.e2ee;
  const link = `${location.origin}${location.pathname}#${formatMeetingHash(meeting.roomId, meeting.secret)}`;

  let audio = null;
  let video = null;
  let micOn = true;
  let camOn = true;
  let stopMeter = () => {};
  let ctx = null;
  let handedOff = false;
  let alive = true;

  const preview = h('video', { autoplay: true, muted: true, playsinline: true, class: 'mirror' });
  preview.muted = true;
  const avatar = h('div', { class: 'preview-off' }, t('cameraOff'));
  const meter = h('div', { class: 'meter', role: 'meter', 'aria-label': t('micLevel'), 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i'));
  const problem = h('div', { class: 'problem', hidden: true });
  const micBtn = h('button', { class: 'ctl', type: 'button', onclick: () => toggleMic() });
  const camBtn = h('button', { class: 'ctl', type: 'button', onclick: () => toggleCam() });

  const nameInput = h('input', { id: 'name', type: 'text', maxlength: 40, placeholder: t('namePlaceholder'), autocomplete: 'nickname', value: load(NAME_KEY) });
  const camSel = h('select', { id: 'cam', onchange: () => restart() });
  const micSel = h('select', { id: 'mic', onchange: () => restart() });
  const spkSel = h('select', { id: 'spk' });
  const joinBtn = h('button', { class: 'btn primary lg block', type: 'button', onclick: () => join() }, t('joinNow'));
  const joinWithout = h('button', { class: 'btn block', type: 'button', hidden: true, onclick: () => join() }, t('joinWithout'));

  function paintControls() {
    micBtn.replaceChildren(icon(micOn && audio ? 'mic' : 'micOff'));
    micBtn.classList.toggle('off', !micOn || !audio);
    micBtn.setAttribute('aria-label', micOn ? t('mute') : t('unmute'));
    micBtn.setAttribute('aria-pressed', String(!micOn));
    camBtn.replaceChildren(icon(camOn && video ? 'video' : 'videoOff'));
    camBtn.classList.toggle('off', !camOn || !video);
    camBtn.setAttribute('aria-label', camOn ? t('cameraOffAction') : t('cameraOn'));
    camBtn.setAttribute('aria-pressed', String(!camOn));
    avatar.hidden = !!(video && camOn);
    micBtn.disabled = !audio;
    camBtn.disabled = !video;
    if (audio) audio.enabled = micOn;
    if (video) video.enabled = camOn;
  }

  function fill(select, items, current) {
    select.replaceChildren(h('option', { value: '' }, t('defaultDevice')));
    items.forEach((d, i) => select.append(h('option', { value: d.deviceId }, d.label || `${select.id} ${i + 1}`)));
    if (current && items.some((d) => d.deviceId === current)) select.value = current;
    select.disabled = items.length === 0;
  }

  async function start(keepIds) {
    stopMeter();
    [audio, video].forEach((tr) => tr?.stop());
    audio = video = null;
    const media = await getLocalMedia({ audioId: keepIds ? micSel.value : '', videoId: keepIds ? camSel.value : '' });
    if (!alive) {
      media.audio?.stop();
      media.video?.stop();
      return;
    }
    audio = media.audio;
    video = media.video;
    preview.srcObject = new MediaStream([video].filter(Boolean));
    problem.hidden = !!(audio || video);
    joinWithout.hidden = !!(audio || video);
    if (!audio && !video) {
      problem.replaceChildren(
        h('strong', {}, t('noDevices')), h('span', {}, t('noDevicesHelp')),
        h('button', { class: 'btn', type: 'button', onclick: () => start(false) }, t('tryAgain')),
      );
    } else if (audio) {
      ctx ||= new AudioContext();
      stopMeter = watchLevel(new MediaStream([audio]), (l) => {
        meter.firstChild.style.transform = `scaleX(${micOn ? l : 0})`;
        meter.setAttribute('aria-valuenow', String(Math.round(l * 100)));
      }, ctx);
    }
    const devices = await listDevices();
    if (!alive) return;
    fill(camSel, devices.cameras, video?.getSettings().deviceId);
    fill(micSel, devices.mics, audio?.getSettings().deviceId);
    fill(spkSel, devices.speakers, '');
    paintControls();
  }

  const restart = () => start(true);
  const toggleMic = () => { micOn = !micOn; paintControls(); };
  const toggleCam = () => { camOn = !camOn; paintControls(); };

  function join() {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      nameInput.classList.add('invalid');
      return;
    }
    save(NAME_KEY, name);
    stopMeter();
    handedOff = true;
    ctx?.close().catch(() => {});
    app.enterRoom({
      name,
      tracks: { audio, video },
      micOn: micOn && !!audio,
      camOn: camOn && !!video,
      sinkId: spkSel.value,
    });
  }

  const copyBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    toast((await copyText(link)) ? t('linkCopied') : t('copyFailed'));
  } }, icon('copy', 16), t('copyLink'));

  nameInput.addEventListener('input', () => nameInput.classList.remove('invalid'));
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  root.append(
    h('div', { class: 'page' },
      h('header', { class: 'topbar' }, app.logo(), app.themeButton()),
      h('main', { class: 'lobby' },
        h('section', { class: 'lobby-preview', 'aria-label': t('camera') },
          h('div', { class: 'preview' }, preview, avatar, problem),
          h('div', { class: 'preview-bar' }, micBtn, camBtn, h('div', { class: 'meter-wrap' }, meter)),
        ),
        h('section', { class: 'lobby-form' },
          h('h1', { class: 'h2' }, t('ready')),
          h('p', { class: 'muted' }, t('readyText')),
          blocked && h('div', { class: 'banner danger', role: 'alert' }, h('strong', {}, t('unsupportedTitle')), h('span', {}, t('unsupportedBody'))),
          h('div', { class: 'field' }, h('label', { for: 'name' }, t('yourName')), nameInput),
          h('div', { class: 'field' }, h('label', { for: 'cam' }, t('camera')), camSel),
          h('div', { class: 'field' }, h('label', { for: 'mic' }, t('microphone')), micSel),
          canPickSpeaker() && h('div', { class: 'field' }, h('label', { for: 'spk' }, t('speaker')), spkSel),
          h('div', { class: 'secure-note' }, icon('lock', 18),
            h('div', {}, h('strong', {}, t('encrypted')), h('span', { class: 'muted' }, ` · ${t('securityCode')} `), h('code', {}, keys.safetyCode))),
          blocked ? null : joinBtn,
          blocked ? null : joinWithout,
          h('div', { class: 'invite' }, h('input', { type: 'text', readonly: true, value: link, 'aria-label': t('invite'), onfocus: (e) => e.target.select() }), copyBtn),
        ),
      ),
      app.footer(),
    ),
  );

  start(false).then(() => { if (alive && !nameInput.value) nameInput.focus(); });

  return () => {
    alive = false;
    stopMeter();
    if (!handedOff) {
      audio?.stop();
      video?.stop();
      ctx?.close().catch(() => {});
    }
  };
}
