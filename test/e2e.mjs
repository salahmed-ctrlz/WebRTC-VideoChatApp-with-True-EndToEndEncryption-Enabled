// Real-browser test: three people in a room, plus an outsider with the wrong key.
// Needs Playwright with Chromium:   npm i -D playwright && npx playwright install chromium
//   node test/e2e.mjs            (set SHOTS=dir to also save screenshots)
import { createRequire } from 'node:module';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createApp } from '../server/index.js';
import { loadConfig } from '../server/config.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const app = createApp(loadConfig({ PORT: '0', MAX_PEERS: '6' }));
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const origin = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

// Headless browsers have no screen picker, so hand getDisplayMedia an animated canvas instead.
const fakeScreen = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
    const g = c.getContext('2d');
    let n = 0;
    setInterval(() => { g.fillStyle = '#123'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('SCREEN ' + n++, 100, 300); }, 66);
    return c.captureStream(15);
  };
};

// Software VP8 for several browsers on a small CI box is slow; cap the capture size in the test only.
const lowRes = () => {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) =>
    orig(c?.video ? { ...c, video: { ...(typeof c.video === 'object' ? c.video : {}), width: 320, height: 240, frameRate: 15 } } : c);
};

const errors = [];
async function person(name, { viewport = { width: 1280, height: 800 }, url = origin } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(fakeScreen);
  await ctx.addInitScript(lowRes);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  await page.goto(url);
  return { name, ctx, page };
}

async function startMeeting(p) {
  await p.page.click('text=New meeting');
  await joinFromLobby(p);
  return p.page.url();
}
async function joinFromLobby(p) {
  await p.page.fill('#name', p.name);
  await p.page.waitForFunction(() => document.querySelector('.preview video')?.videoWidth > 0);
  if (SHOTS && p.name === 'Ana') await p.page.screenshot({ path: `${SHOTS}/lobby-${p.page.viewportSize().width}.png` });
  await p.page.click('text=Join meeting');
  await p.page.waitForSelector('.room');
}
async function playing(page, n, kind = 'camera') {
  try {
    await page.waitForFunction(({ n, kind }) => {
      const vids = [...document.querySelectorAll(`.tile:not(.self)[data-kind="${kind}"] video`)];
      return vids.length >= n && vids.slice(0, n).every((v) => v.videoWidth > 0 && v.currentTime > 0.3 && !v.paused);
    }, { n, kind }, { timeout: 45000 });
  } catch (e) {
    const info = await page.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => {
      const v = t.querySelector('video');
      return `${t.dataset.key} kind=${t.dataset.kind} w=${v.videoWidth} t=${v.currentTime.toFixed(1)} paused=${v.paused} rs=${v.readyState} status=${t.querySelector('.tile-status')?.textContent}`;
    }));
    throw new Error(`video not playing (${kind}, want ${n}):\n  ${info.join('\n  ')}`);
  }
}

try {
  const ana = await person('Ana');
  const link = await startMeeting(ana);
  assert.match(link, /#[a-z2-9]{16}\.[A-Za-z0-9_-]{43}$/);

  const ben = await person('Ben', { url: link });
  await joinFromLobby(ben);
  const cy = await person('Cy', { url: link });
  await joinFromLobby(cy);

  for (const p of [ana, ben, cy]) await playing(p.page, 2);
  console.log('ok  three people see each other, decoded video is advancing');

  // Everyone sees the same safety code.
  const codes = [];
  for (const p of [ana, ben, cy]) {
    await p.page.click('.secure');
    codes.push(await p.page.textContent('.dialog .code'));
    await p.page.keyboard.press('Escape');
  }
  assert.equal(new Set(codes).size, 1, `codes differ: ${codes}`);
  console.log('ok  safety code matches:', codes[0]);

  // Media really is frame-encrypted: each remote peer reports decrypted frames and none dropped.
  await ana.page.click('button[aria-label^="People"]');
  await ana.page.waitForFunction(() => [...document.querySelectorAll('.person .chip')].filter((c) => c.textContent === 'Encrypted').length === 3, null, { timeout: 20000 });
  console.log('ok  frame encryption active for every participant');
  await ana.page.keyboard.press('Escape');

  // Chat.
  await ana.page.click('button[aria-label^="Chat"]');
  await ana.page.fill('.chat-form input', 'hello <b>there</b> https://example.com/x');
  await ana.page.keyboard.press('Enter');
  for (const p of [ben, cy]) {
    await p.page.click('button[aria-label^="Chat"]');
    await p.page.waitForSelector('.msg:not(.self) .msg-text');
    assert.equal(await p.page.textContent('.msg:not(.self) .msg-text'), 'hello <b>there</b> https://example.com/x');
    assert.equal(await p.page.locator('.msg-text b').count(), 0, 'chat must not render HTML');
    assert.equal(await p.page.getAttribute('.msg-text a', 'href'), 'https://example.com/x');
  }
  console.log('ok  encrypted chat delivered, rendered as text, links are safe');

  // Mute state propagates.
  await ben.page.click('button[aria-label^="Mute"]');
  await ana.page.waitForSelector('.tile:has-text("Ben") .badge-ico.off');
  console.log('ok  mute status propagates');

  // Screen share goes to a spotlight layout on the other side.
  await ana.page.click('button[aria-label^="Share screen"]');
  await ben.page.waitForSelector('.stage[data-layout="spotlight"]', { timeout: 20000 });
  await playing(ben.page, 1, 'screen');
  assert.equal(await ben.page.locator('.tile.is-main').getAttribute('data-kind'), 'screen');
  if (SHOTS) {
    await ben.page.screenshot({ path: `${SHOTS}/room-screenshare.png` });
  }
  await ana.page.click('button[aria-label^="Stop sharing"]');
  await ben.page.waitForSelector('.stage[data-layout="grid"]', { timeout: 20000 });
  console.log('ok  screen share starts and stops cleanly');

  if (SHOTS) {
    await ana.page.click('button[aria-label^="Chat"]');
    await ana.page.screenshot({ path: `${SHOTS}/room-grid.png` });
  }

  // The signalling connection dies (server restart, flaky network): everyone reconnects and the mesh re-forms.
  for (const ws of app.signaling.wss.clients) ws.terminate();
  await ana.page.waitForSelector('.conn-banner', { state: 'visible', timeout: 10000 });
  await ana.page.waitForSelector('.conn-banner', { state: 'hidden', timeout: 30000 });
  for (const p of [ana, ben, cy]) await playing(p.page, 2);
  await ana.page.waitForSelector('.tile:has-text("Ben") .badge-ico.off', { timeout: 20000 });
  console.log('ok  after a dropped connection the meeting recovers on its own (mute state kept)');

  // Someone with the room id but the wrong key can't see or be seen, and can't read anything.
  const wrong = link.replace(/\.[A-Za-z0-9_-]{43}$/, '.' + 'A'.repeat(43));
  const eve = await person('Eve', { url: wrong });
  await joinFromLobby(eve);
  await eve.page.waitForTimeout(4000);
  assert.equal(await eve.page.locator('.tile:not(.self)').count(), 0, 'Eve must not see anyone');
  assert.equal(await ana.page.locator('.tile', { hasText: 'Eve' }).count(), 0, 'nobody should see Eve');
  assert.equal(await ana.page.textContent('.count'), '3 people');
  console.log('ok  outsider with the wrong key sees and is seen by nobody');

  // Leaving updates everyone.
  await cy.page.click('button[aria-label="Leave"]');
  await ana.page.waitForFunction(() => document.querySelector('.count')?.textContent === '2 people');
  console.log('ok  leaving is reflected for the others');

  // Mobile layout in a room.
  const mo = await person('Mo', { url: link, viewport: { width: 375, height: 740 } });
  await joinFromLobby(mo);
  await playing(mo.page, 2);
  const overflow = await mo.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `horizontal overflow on mobile: ${overflow}px`);
  if (SHOTS) await mo.page.screenshot({ path: `${SHOTS}/room-mobile.png` });
  console.log('ok  mobile room has no horizontal overflow');

  assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], 'console/page errors');
  console.log('ok  no console errors');
} finally {
  await browser.close();
  app.signaling.close();
  app.server.close();
}
