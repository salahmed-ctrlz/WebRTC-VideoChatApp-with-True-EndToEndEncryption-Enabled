import { parseMeeting, newRoomId, newSecret, formatMeetingHash, deriveRoomKeys } from './crypto.js';
import { setStringOverrides, h, clear, t } from './ui.js';
import { icon } from './icons.js';
import { e2eeSupported } from './mesh.js';
import { landing } from './views/landing.js';
import { lobby } from './views/lobby.js';
import { room } from './views/room.js';

const root = document.getElementById('app');
const app = { config: null, brand: null, meeting: null, keys: null };
let cleanup = () => {};
let inRoom = false;

/* ---------- theme & brand ---------- */

function applyTheme(mode) {
  const resolved = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]') || document.head.appendChild(h('meta', { name: 'theme-color' }));
  meta.content = resolved === 'dark' ? '#0f1112' : '#f7f8f7';
}

function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#0b0d0e' : '#ffffff';
}

function applyBrand(brand) {
  document.title = brand.name;
  const s = document.documentElement.style;
  s.setProperty('--accent', brand.accent);
  s.setProperty('--accent-ink', readableOn(brand.accent));
  setStringOverrides(brand.strings);
  let saved = null;
  try {
    saved = localStorage.getItem('theme');
  } catch {
    /* storage unavailable */
  }
  applyTheme(saved === 'light' || saved === 'dark' ? saved : brand.theme);
}

app.toggleTheme = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', next);
  } catch {
    /* storage unavailable */
  }
  applyTheme(next);
};

app.logo = () => {
  const { brand } = app;
  return h(
    'a',
    { class: 'brand', href: location.pathname, 'aria-label': brand.name, onclick: (e) => { e.preventDefault(); app.go(null); } },
    brand.logo ? h('img', { src: brand.logo, alt: '', class: 'brand-logo' }) : h('span', { class: 'brand-mark' }, icon('video', 18)),
    h('span', { class: 'brand-name' }, brand.name),
  );
};

app.themeButton = () =>
  h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('theme'), title: t('theme'), onclick: app.toggleTheme },
    h('span', { class: 'only-light' }, icon('moon')), h('span', { class: 'only-dark' }, icon('sun')));

app.footer = () => {
  const { brand } = app;
  const links = brand.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label));
  const credit = brand.credit && h('a', { class: 'credit', href: brand.credit.url, target: '_blank', rel: 'noopener noreferrer' }, brand.credit.text);
  if (!links.length && !credit) return null;
  return h('footer', { class: 'footer' }, h('nav', { class: 'footer-links', 'aria-label': 'Links' }, links), credit);
};

/* ---------- routing ---------- */

app.go = (meeting, { replace = false } = {}) => {
  const hash = meeting ? `#${formatMeetingHash(meeting.roomId, meeting.secret)}` : '';
  const url = location.pathname + location.search + hash;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  route();
};

app.newMeeting = () => app.go({ roomId: newRoomId(), secret: newSecret() });

app.enterRoom = (session) => {
  inRoom = true;
  render(room, session);
};

app.leaveRoom = (reason) => {
  inRoom = false;
  render(landing, { left: reason === 'left' });
};

function render(view, props) {
  cleanup();
  clear(root);
  window.scrollTo(0, 0);
  cleanup = view(root, app, props) || (() => {});
}

async function route() {
  if (inRoom) return; // the room owns the page until the user leaves
  const hash = location.hash.slice(1);
  if (!hash) return render(landing, {});
  const meeting = parseMeeting(hash);
  if (!meeting) return render(landing, { error: /^[a-z2-9]{16}$/.test(hash.split('.')[0]) ? t('missingKey') : t('invalidLink') });
  if (!app.keys || app.meeting?.roomId !== meeting.roomId || app.meeting?.secret !== meeting.secret) {
    app.keys = await deriveRoomKeys(meeting.roomId, meeting.secret);
  }
  app.meeting = meeting;
  render(lobby, {});
}

async function main() {
  try {
    app.config = await (await fetch('/config.json', { cache: 'no-store' })).json();
  } catch {
    clear(root);
    root.append(h('p', { class: 'fatal' }, 'Could not reach the server.'));
    return;
  }
  app.brand = app.config.brand;
  app.e2ee = e2eeSupported;
  applyBrand(app.brand);
  addEventListener('hashchange', route);
  addEventListener('popstate', route);
  route();
}

main();
