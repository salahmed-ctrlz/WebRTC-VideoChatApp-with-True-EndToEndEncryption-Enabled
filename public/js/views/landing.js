import { h, t } from '../ui.js';
import { icon } from '../icons.js';
import { parseMeeting } from '../crypto.js';

export function landing(root, app, { error, left } = {}) {
  const input = h('input', {
    type: 'text', id: 'join-input', name: 'link', placeholder: t('joinPlaceholder'),
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('joinWithLink'),
  });
  const message = h('p', { class: 'form-error', role: 'alert' }, error || '');
  message.hidden = !error;

  const submit = (e) => {
    e.preventDefault();
    const meeting = parseMeeting(input.value);
    if (!meeting) {
      message.textContent = /^[a-z2-9]{16}$/.test(input.value.trim()) ? t('missingKey') : t('invalidLink');
      message.hidden = false;
      input.focus();
      return;
    }
    app.go(meeting);
  };

  const point = (title, text) => h('li', {}, h('strong', {}, title), h('span', {}, text));
  const cfg = app.config;

  root.append(
    h('div', { class: 'page' },
      h('header', { class: 'topbar' }, app.logo(), app.themeButton()),
      h('main', { class: 'landing' },
        left && h('div', { class: 'notice' }, h('span', {}, t('leftTitle')),
          app.meeting && h('button', { class: 'btn sm', type: 'button', onclick: () => app.go(app.meeting) }, t('rejoin'))),
        h('h1', {}, app.brand.tagline),
        h('div', { class: 'cta' },
          h('button', { class: 'btn primary lg', type: 'button', onclick: app.newMeeting }, icon('video'), t('newMeeting')),
          h('form', { class: 'join-form', onsubmit: submit }, input, h('button', { class: 'btn', type: 'submit' }, t('join'))),
        ),
        message,
        h('ul', { class: 'points' },
          point(t('noAccount'), t('noAccountText')),
          point(t('upTo', cfg.maxPeers), t('upToText')),
          app.brand.features.screenShare && point(t('shareScreen'), t('shareScreenText')),
        ),
        h('details', { class: 'how' },
          h('summary', {}, t('howPrivate')),
          t('howPrivateBody').map((p) => h('p', {}, p)),
        ),
      ),
      app.footer(),
    ),
  );
  return () => {};
}
