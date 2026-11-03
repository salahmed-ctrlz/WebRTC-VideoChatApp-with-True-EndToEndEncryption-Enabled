import { defaults } from './strings.js';

let overrides = {};
export function setStringOverrides(o) {
  overrides = o && typeof o === 'object' ? o : {};
}

/** Look up copy. Brand overrides can replace plain strings; function strings stay as defined. */
export function t(key, ...args) {
  const v = typeof defaults[key] === 'function' ? defaults[key] : overrides[key] ?? defaults[key];
  return typeof v === 'function' ? v(...args) : v;
}

/**
 * Tiny element builder. Children are always added as text nodes or elements, never parsed as HTML,
 * so names and chat messages from other people can't inject markup.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
}

let toastHost;
export function toast(message, { tone = 'info', ms = 3500 } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const el = h('div', { class: `toast ${tone}` }, message);
  toastHost.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { readonly: true, style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Splits text into text nodes and safe http(s) links. */
export function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    let url = m[0].replace(/[.,;:!?)\]]+$/, '');
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = m.index + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : '');
  return s.toUpperCase();
}
