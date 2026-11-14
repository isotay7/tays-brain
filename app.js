'use strict';

/* Tay's Brain. All personal data comes from a private repo at runtime.
   This file holds no names, tokens or content. */

const APP_VERSION = '1.0.0'; // keep in sync with CACHE in sw.js
const API = 'https://api.github.com';
const DROP_EVERY_DAYS = 2;

const FIELDS = [
  { id: 'time-freedom', name: 'Time freedom & ownership' },
  { id: 'future-of-work', name: 'Future of work' },
  { id: 'money', name: 'Money & investing' },
  { id: 'sports-business', name: 'Sports business' },
  { id: 'skills', name: 'Where my skills translate' },
  { id: 'thoughts', name: 'Your thoughts' },
];
const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.id, f]));
const VIEWS = ['feed', 'saved', 'thoughts', 'sources', 'settings'];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- Storage: every access guarded ---------- */
const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem('tb.' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('tb.' + key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem('tb.' + key); } catch { /* ignore */ }
  },
  wipe() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('tb.')).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

/* ---------- State ---------- */
const state = {
  token: null,
  repo: null,
  name: '',
  cards: [],
  sources: {},
  thoughts: [],
  replyCache: {}, // issue number -> { updatedAt, reply }
  saved: {},
  read: new Set(),
  filter: 'all',
  loaded: false,
  syncedAt: null,
  errors: {},
  refreshing: false,
  feedSig: '',
};

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const str = (v, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch { return null; }
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}
function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
const fmtDay = (d, opts) => d.toLocaleDateString(undefined, opts);

function dropLabel(drop) {
  const d = parseDay(drop);
  if (!d) return 'Latest drop';
  const ago = daysBetween(d, startOfToday());
  if (ago <= 0) return "Today's drop";
  if (ago === 1) return "Yesterday's drop";
  if (ago < 7) return fmtDay(d, { weekday: 'long' }) + "'s drop";
  return fmtDay(d, { month: 'short', day: 'numeric' }) + ' drop';
}
function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
  return fmtDay(new Date(t), { month: 'short', day: 'numeric' });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- GitHub ---------- */
async function gh(path, { method = 'GET', body, raw = false, token = state.token } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('offline');
    e.status = 0;
    throw e;
  }
  if (!res.ok) {
    const e = new Error('GitHub ' + res.status);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

function normalizeCards(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((c) => c && typeof c === 'object' && (c.id != null) && c.headline)
    .map((c) => ({
      id: String(c.id),
      field: str(c.field, 60),
      headline: str(c.headline, 300),
      why: str(c.why, 1200),
      source: str(c.source, 120),
      url: str(c.url, 2000),
      drop: str(c.drop, 10),
      createdAt: str(c.createdAt, 40),
    }))
    .sort((a, b) => (b.drop.localeCompare(a.drop)) || (b.createdAt.localeCompare(a.createdAt)));
}

function normalizeSources(data) {
  const out = {};
  if (!data || typeof data !== 'object') return out;
  for (const f of FIELDS) {
    const list = Array.isArray(data[f.id]) ? data[f.id] : [];
    out[f.id] = list
      .filter((s) => s && s.name)
      .map((s) => ({ name: str(s.name, 120), url: str(s.url, 2000), why: str(s.why, 300) }));
  }
  return out;
}

async function fetchCards() {
  try {
    return normalizeCards(await gh(`/repos/${state.repo}/contents/feed/cards.json`, { raw: true }));
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}
async function fetchSources() {
  try {
    return normalizeSources(await gh(`/repos/${state.repo}/contents/feed/sources.json`, { raw: true }));
  } catch (e) {
    if (e.status === 404) return normalizeSources({});
    throw e;
  }
}
async function fetchThoughts() {
  const issues = await gh(`/repos/${state.repo}/issues?labels=thought&state=all&sort=created&direction=desc&per_page=50`);
  const list = (Array.isArray(issues) ? issues : []).filter((i) => !i.pull_request);
  return Promise.all(list.map(async (i) => {
    let reply = null;
    if (i.comments > 0) {
      const cached = state.replyCache[i.number];
      if (cached && cached.updatedAt === i.updated_at) {
        reply = cached.reply;
      } else {
        try {
          const cs = await gh(`/repos/${state.repo}/issues/${i.number}/comments?per_page=100`);
          const c = Array.isArray(cs) && cs[cs.length - 1];
          if (c) reply = { body: str(c.body, 6000), at: c.created_at };
          state.replyCache[i.number] = { updatedAt: i.updated_at, reply };
        } catch { /* keep going without the reply */ }
      }
    }
    return {
      number: i.number,
      text: str(i.body, 6000) || str(i.title, 300),
      at: i.created_at,
      reply,
    };
  }));
}

async function loadAll({ quiet = false } = {}) {
  if (!state.token || state.refreshing) return;
  state.refreshing = true;
  const [cards, sources, thoughts] = await Promise.allSettled([fetchCards(), fetchSources(), fetchThoughts()]);
  state.refreshing = false;
  if (!state.token) return; // key was forgotten mid-flight

  state.errors = {};
  const failed = [cards, sources, thoughts].filter((r) => r.status === 'rejected').map((r) => r.reason);
  if (cards.status === 'fulfilled') state.cards = cards.value; else state.errors.cards = cards.reason;
  if (sources.status === 'fulfilled') state.sources = sources.value; else state.errors.sources = sources.reason;
  if (thoughts.status === 'fulfilled') state.thoughts = mergePending(thoughts.value); else state.errors.thoughts = thoughts.reason;

  if (failed.length < 3) {
    state.loaded = true;
    state.syncedAt = new Date().toISOString();
    store.set('cache', {
      cards: state.cards, sources: state.sources, thoughts: state.thoughts.filter((t) => !t.pending),
      replyCache: state.replyCache, syncedAt: state.syncedAt,
    });
  }
  renderAll();
  if (failed.some((e) => e && e.status === 0)) toast("You're offline. Showing your last sync.");
  else if (!quiet && failed.length === 0) toast('Up to date');
  return failed;
}

function mergePending(fresh) {
  const pending = state.thoughts.filter((t) => t.pending);
  return [...pending, ...fresh];
}

function errorCopy(e) {
  if (!e) return null;
  if (e.status === 401) return { title: 'Your key stopped working', body: 'It may have expired. Make a new one and paste it in.', action: 'rekey' };
  if (e.status === 403) return { title: 'GitHub blocked the request', body: 'Check the key has Contents read and Issues read and write, or try again in a minute.' };
  if (e.status === 404) return { title: "Can't find your data repo", body: `Check that ${state.repo} exists and the key has access to it.`, action: 'rekey' };
  if (e.status === 0) return { title: "You're offline", body: 'Showing what was here last time. Pull down to try again.' };
  return { title: 'GitHub had a problem', body: `It answered with error ${e.status}. Pull down to try again.` };
}

/* ---------- Saved / read ---------- */
function isSaved(id) { return Object.prototype.hasOwnProperty.call(state.saved, id); }
function toggleSave(card) {
  if (isSaved(card.id)) {
    delete state.saved[card.id];
  } else {
    state.saved[card.id] = { ...card, savedAt: new Date().toISOString() };
  }
  store.set('saved', state.saved);
  syncCardButtons(card.id);
  return isSaved(card.id);
}
function toggleRead(id) {
  if (state.read.has(id)) state.read.delete(id); else state.read.add(id);
  store.set('read', Array.from(state.read).slice(-3000));
  syncCardButtons(id);
  renderFeedMeta();
}
function syncCardButtons(id) {
  $$(`.card[data-id="${CSS.escape(id)}"]`).forEach((c) => {
    const saved = isSaved(id);
    const read = state.read.has(id);
    const sb = $('.save-btn', c);
    sb.setAttribute('aria-pressed', String(saved));
    sb.setAttribute('aria-label', saved ? 'Remove from saved' : 'Save');
    const rb = $('.read-btn', c);
    rb.setAttribute('aria-pressed', String(read));
    rb.setAttribute('aria-label', read ? 'Mark unread' : 'Mark read');
    c.classList.toggle('is-read', read);
  });
}

/* ---------- Card element ---------- */
const tplCard = $('#tpl-card');
function cardEl(card, i = 0, animate = false) {
  const node = tplCard.content.firstElementChild.cloneNode(true);
  node.dataset.id = card.id;
  if (FIELD_BY_ID[card.field]) node.dataset.field = card.field;
  $('.tag-name', node).textContent = FIELD_BY_ID[card.field]?.name || card.field || 'Uncategorized';
  $('.card-headline', node).textContent = card.headline;
  if (card.why) {
    $('.card-why', node).textContent = card.why;
  } else {
    $('.card-why-label', node).remove();
    $('.card-why', node).remove();
  }
  const a = $('.card-source', node);
  const url = safeUrl(card.url);
  a.textContent = card.source || hostOf(card.url) || 'Source';
  if (url) a.href = url; else a.removeAttribute('href');
  if (animate && !reduceMotion.matches) {
    node.classList.add('enter');
    node.style.setProperty('--i', String(i));
    node.addEventListener('animationend', () => node.classList.remove('enter'), { once: true });
  }
  node._card = card;
  const saved = isSaved(card.id);
  const read = state.read.has(card.id);
  $('.save-btn', node).setAttribute('aria-pressed', String(saved));
  $('.save-btn', node).setAttribute('aria-label', saved ? 'Remove from saved' : 'Save');
  $('.read-btn', node).setAttribute('aria-pressed', String(read));
  $('.read-btn', node).setAttribute('aria-label', read ? 'Mark unread' : 'Mark read');
  node.classList.toggle('is-read', read);
  return node;
}

/* ---------- Feed ---------- */
function greeting() {
  const h = new Date().getHours();
  const g = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return state.name ? `${g}, ${state.name}` : g;
}
function latestDrop() {
  return state.cards.reduce((m, c) => (c.drop > m ? c.drop : m), '');
}
const matchesFilter = (c) => state.filter === 'all' || c.field === state.filter;

function renderChips() {
  const nav = $('#chips');
  nav.replaceChildren();
  const all = [{ id: 'all', name: 'All' }, ...FIELDS];
  for (const f of all) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.filter = f.id;
    if (f.id !== 'all') {
      b.style.setProperty('--f', `var(--f-${f.id})`);
      b.append(el('i'));
    }
    b.append(document.createTextNode(f.name));
    b.setAttribute('aria-pressed', String(state.filter === f.id));
    nav.append(b);
  }
}

function renderFeed() {
  $('#greeting').textContent = greeting();
  $('#hero-date').textContent = fmtDay(new Date(), { weekday: 'long', month: 'long', day: 'numeric' });

  const latest = latestDrop();
  const sig = [latest, state.cards.length, state.filter].join('|');
  const animate = sig !== state.feedSig;
  state.feedSig = sig;

  const status = $('#feed-status');
  const list = $('#feed-latest');
  const older = $('#feed-older');
  const caught = $('#caught-up');
  status.replaceChildren();
  list.replaceChildren();
  older.replaceChildren();

  const err = errorCopy(state.errors.cards);
  if (err && (state.cards.length === 0 || err.action === 'rekey')) {
    status.append(el('b', null, err.title), document.createTextNode(err.body));
    if (err.action === 'rekey') {
      const btn = el('button', 'btn btn-quiet', 'Enter a new key');
      btn.type = 'button';
      btn.addEventListener('click', () => showSetup({ keepData: true }));
      status.append(el('br'), btn);
    }
  }

  if (!state.loaded && state.cards.length === 0) {
    if (!err) status.append(el('b', null, 'Pulling your latest drop'), document.createTextNode('One second.'));
    caught.hidden = true;
    renderFeedMeta();
    return;
  }

  if (state.cards.length === 0) {
    if (!err) status.append(el('b', null, 'Your first drop is on its way'), document.createTextNode('Cards land here every other day. Drop a thought while you wait.'));
    caught.hidden = true;
    renderFeedMeta();
    return;
  }

  const latestCards = state.cards.filter((c) => c.drop === latest && matchesFilter(c));
  if (latestCards.length === 0) {
    const f = FIELD_BY_ID[state.filter];
    status.append(el('b', null, `Nothing on ${f ? f.name.toLowerCase() : 'this'} in ${dropLabel(latest).toLowerCase()}`), document.createTextNode('Try another field, or check the earlier drops below.'));
  }
  latestCards.forEach((c, i) => list.append(cardEl(c, i, animate)));

  caught.hidden = false;
  caught.classList.remove('seen');
  observeCaughtUp(animate);

  // Earlier drops, collapsed. Cards render only when a group opens.
  const groups = new Map();
  for (const c of state.cards) {
    if (c.drop === latest || !matchesFilter(c)) continue;
    if (!groups.has(c.drop)) groups.set(c.drop, []);
    groups.get(c.drop).push(c);
  }
  if (groups.size) {
    older.append(el('p', 'older-head', 'Earlier drops'));
    for (const [drop, cards] of groups) {
      const d = el('details', 'drop');
      const s = el('summary', null, dropLabel(drop));
      s.append(el('span', null, cards.length === 1 ? '1 card' : `${cards.length} cards`));
      d.append(s);
      const wrap = el('div', 'cards');
      d.append(wrap);
      d.addEventListener('toggle', () => {
        if (d.open && !wrap.childElementCount) cards.forEach((c, i) => wrap.append(cardEl(c, i, true)));
      });
      older.append(d);
    }
  }
  renderFeedMeta();
}

function renderFeedMeta() {
  const latest = latestDrop();
  const inDrop = state.cards.filter((c) => c.drop === latest);
  const unread = inDrop.filter((c) => !state.read.has(c.id)).length;
  const sub = $('#hero-sub');
  if (!inDrop.length) {
    sub.textContent = state.loaded ? 'Your first drop is on its way.' : '';
  } else if (unread === 0) {
    sub.textContent = `You've read all of ${dropLabel(latest).toLowerCase()}.`;
  } else {
    sub.textContent = `${dropLabel(latest)}: ${inDrop.length} cards, ${unread} unread.`;
  }

  const next = parseDay(latest);
  let nextText = '';
  if (next) {
    next.setDate(next.getDate() + DROP_EVERY_DAYS);
    nextText = next <= startOfToday()
      ? 'The next drop is due any time now.'
      : `The next one lands around ${fmtDay(next, { weekday: 'long', month: 'short', day: 'numeric' })}.`;
  }
  const lead = unread === 0
    ? `You read all ${inDrop.length}.`
    : `That's all ${inDrop.length} from this drop.`;
  $('#caught-text').textContent = `${lead} ${nextText}`.trim();
}

let caughtObserver;
function observeCaughtUp(animate) {
  const node = $('#caught-up');
  if (!animate || reduceMotion.matches || !('IntersectionObserver' in window)) {
    node.classList.add('seen');
    return;
  }
  caughtObserver?.disconnect();
  caughtObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      node.classList.add('seen');
      caughtObserver.disconnect();
    }
  }, { threshold: 0.6 });
  caughtObserver.observe(node);
}

/* ---------- Saved ---------- */
function renderSaved() {
  const list = $('#saved-list');
  list.replaceChildren();
  const items = Object.values(state.saved).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  $('#saved-count').textContent = items.length
    ? (items.length === 1 ? '1 card worth keeping.' : `${items.length} cards worth keeping.`)
    : 'Cards you keep live here.';
  if (!items.length) {
    const e = el('div', 'empty');
    e.append(el('b', null, 'Nothing saved yet'), document.createTextNode('Tap the bookmark on any card in your feed to keep it here.'));
    list.append(e);
    return;
  }
  items.forEach((c, i) => list.append(cardEl(c, i, i < 8)));
}

/* ---------- Thoughts ---------- */
function renderThoughts() {
  const list = $('#thoughts-list');
  list.replaceChildren();
  const err = errorCopy(state.errors.thoughts);
  if (err && !state.thoughts.length) {
    const e = el('div', 'empty');
    e.append(el('b', null, err.title), document.createTextNode(err.body));
    list.append(e);
    return;
  }
  if (!state.thoughts.length) {
    const e = el('div', 'empty');
    e.append(el('b', null, state.loaded ? 'No thoughts yet' : 'Loading your thoughts'),
      document.createTextNode(state.loaded ? 'Type one above. The Brain reads it on the next sweep and replies here.' : 'One second.'));
    list.append(e);
    return;
  }
  for (const t of state.thoughts) {
    const item = el('article', 'thought');
    item.append(el('p', 'thought-text', t.text));
    const meta = el('div', 'thought-meta');
    let pill;
    if (t.pending) pill = el('span', 'pill pill-sending', 'Sending');
    else if (t.reply) pill = el('span', 'pill pill-done', 'Brain replied');
    else pill = el('span', 'pill pill-wait', 'Waiting');
    pill.prepend(el('i'));
    meta.append(pill, el('span', null, relTime(t.at)));
    item.append(meta);
    if (t.reply) {
      const r = el('div', 'reply');
      r.append(el('p', 'reply-text', t.reply.body));
      item.append(r);
    }
    list.append(item);
  }
}
function updateThoughtsBadge() {
  const seen = store.get('thoughtsSeenAt', '');
  const fresh = state.thoughts.some((t) => t.reply && t.reply.at > seen);
  $('#thoughts-badge').hidden = !fresh;
}

/* ---------- Sources ---------- */
function renderSources() {
  const list = $('#sources-list');
  list.replaceChildren();
  const err = errorCopy(state.errors.sources);
  if (err && !Object.keys(state.sources).length) {
    const e = el('div', 'empty');
    e.append(el('b', null, err.title), document.createTextNode(err.body));
    list.append(e);
    return;
  }
  for (const f of FIELDS) {
    const g = el('section', 'source-group');
    g.style.setProperty('--f', `var(--f-${f.id})`);
    const h = el('h2');
    h.append(el('i'), document.createTextNode(f.name));
    g.append(h);
    const items = state.sources[f.id] || [];
    if (f.id === 'thoughts' && !items.length) {
      g.append(el('p', 'source-note', 'Comes from what you post in Thoughts.'));
    } else if (!items.length) {
      g.append(el('p', 'source-note', 'No sources yet.'));
    } else {
      const ul = el('ul');
      for (const s of items) {
        const li = el('li');
        const url = safeUrl(s.url);
        const a = el(url ? 'a' : 'div');
        if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        a.append(el('p', 'source-name', s.name));
        if (s.why) a.append(el('p', 'source-why', s.why));
        li.append(a);
        ul.append(li);
      }
      g.append(ul);
    }
    list.append(g);
  }
}

/* ---------- Settings ---------- */
function renderSettings() {
  $('#set-name').value = state.name;
  $('#repo-status').textContent = state.repo || '';
  $('#key-status').textContent = state.syncedAt
    ? `Saved on this phone. Last synced ${relTime(state.syncedAt)}.`
    : 'Saved on this phone.';
  $('#app-version').textContent = `Version ${APP_VERSION}`;
}

/* ---------- Router ---------- */
let currentView = null;
function currentRoute() {
  const h = location.hash.slice(1);
  return VIEWS.includes(h) ? h : 'feed';
}
function renderView(v) {
  if (v === 'feed') renderFeed();
  else if (v === 'saved') renderSaved();
  else if (v === 'thoughts') {
    renderThoughts();
    store.set('thoughtsSeenAt', new Date().toISOString());
    updateThoughtsBadge();
  }
  else if (v === 'sources') renderSources();
  else if (v === 'settings') renderSettings();
}
function route() {
  if (!state.token) return;
  const v = currentRoute();
  const changed = v !== currentView;
  currentView = v;
  for (const s of $$('.view')) {
    const on = s.dataset.view === v;
    s.hidden = !on;
    if (on && changed && !reduceMotion.matches) {
      s.classList.remove('entering');
      void s.offsetWidth;
      s.classList.add('entering');
    }
  }
  $$('.tabbar a').forEach((a) => {
    if (a.dataset.tab === v) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  renderView(v);
  if (changed) window.scrollTo(0, 0);
}
function renderAll() {
  if (!state.token) return;
  renderView(currentRoute());
  updateThoughtsBadge();
}

/* ---------- Composer ---------- */
function mountComposers() {
  const tpl = $('#tpl-composer');
  $$('[data-composer]').forEach((slot) => {
    if (slot.childElementCount) return;
    const form = tpl.content.firstElementChild.cloneNode(true);
    const input = $('[data-composer-input]', form);
    const send = $('[data-composer-send]', form);
    const sync = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 180) + 'px';
      send.disabled = !input.value.trim();
    };
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sync();
      input.blur();
      const ok = await postThought(text);
      if (!ok) { input.value = text; sync(); }
    });
    slot.append(form);
  });
}

async function postThought(text) {
  const temp = { number: 'pending-' + Date.now(), text, at: new Date().toISOString(), reply: null, pending: true };
  state.thoughts.unshift(temp);
  if (currentView === 'thoughts') renderThoughts();
  const firstLine = text.split('\n')[0];
  const title = firstLine.length > 60 ? firstLine.slice(0, 59).trimEnd() + '…' : firstLine;
  try {
    const issue = await gh(`/repos/${state.repo}/issues`, {
      method: 'POST',
      body: { title, body: text, labels: ['thought'] },
    });
    Object.assign(temp, { number: issue.number, at: issue.created_at, pending: false });
    store.set('cache', { ...store.get('cache', {}), thoughts: state.thoughts.filter((t) => !t.pending) });
    toast('Thought sent. The Brain replies on its next sweep.');
    if (currentView === 'thoughts') renderThoughts();
    return true;
  } catch (e) {
    state.thoughts = state.thoughts.filter((t) => t !== temp);
    if (currentView === 'thoughts') renderThoughts();
    toast(e.status === 403 || e.status === 404
      ? "Couldn't send. The key needs Issues read and write."
      : e.status === 401 ? "Couldn't send. Your key stopped working." : "Couldn't send. Check your connection.");
    return false;
  }
}

/* ---------- Card interactions: save, read, tilt ---------- */
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    state.filter = chip.dataset.filter;
    $$('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    chip.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    renderFeed();
    return;
  }
  const card = e.target.closest('.card');
  if (!card || !card._card) return;
  if (e.target.closest('.save-btn')) {
    const btn = e.target.closest('.save-btn');
    const nowSaved = toggleSave(card._card);
    if (nowSaved) {
      btn.classList.remove('pop');
      void btn.offsetWidth;
      btn.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate(8);
    }
    toast(nowSaved ? 'Saved' : 'Removed from saved');
    if (currentView === 'saved') renderSaved();
  } else if (e.target.closest('.read-btn')) {
    toggleRead(card._card.id);
  } else if (e.target.closest('.card-source')) {
    // Opening the source counts as reading it.
    if (!state.read.has(card._card.id)) toggleRead(card._card.id);
  }
});

let tilt = null;
function applyTilt() {
  if (!tilt) return;
  tilt.raf = 0;
  const { card, rect, x, y } = tilt;
  const px = Math.max(-0.5, Math.min(0.5, (x - rect.left) / rect.width - 0.5));
  const py = Math.max(-0.5, Math.min(0.5, (y - rect.top) / rect.height - 0.5));
  card.style.transform = `perspective(900px) rotateX(${(-py * 7).toFixed(2)}deg) rotateY(${(px * 7).toFixed(2)}deg) scale(0.985)`;
}
function releaseTilt() {
  if (!tilt) return;
  const { card, raf } = tilt;
  if (raf) cancelAnimationFrame(raf);
  card.classList.add('settle');
  card.classList.remove('pressed');
  card.style.transform = '';
  card.addEventListener('transitionend', () => card.classList.remove('settle'), { once: true });
  tilt = null;
}
document.addEventListener('pointerdown', (e) => {
  if (reduceMotion.matches) return;
  const card = e.target.closest('.card');
  if (!card || e.target.closest('button, a')) return;
  releaseTilt();
  card.classList.remove('settle', 'enter');
  card.classList.add('pressed');
  tilt = { card, rect: card.getBoundingClientRect(), id: e.pointerId, x: e.clientX, y: e.clientY, raf: 0 };
  tilt.raf = requestAnimationFrame(applyTilt);
}, { passive: true });
document.addEventListener('pointermove', (e) => {
  if (!tilt || e.pointerId !== tilt.id) return;
  tilt.x = e.clientX;
  tilt.y = e.clientY;
  if (!tilt.raf) tilt.raf = requestAnimationFrame(applyTilt);
}, { passive: true });
['pointerup', 'pointercancel'].forEach((t) =>
  document.addEventListener(t, releaseTilt, { passive: true }));
window.addEventListener('scroll', releaseTilt, { passive: true });

/* ---------- Pull to refresh ---------- */
(function pullToRefresh() {
  const ptr = $('#ptr');
  const THRESHOLD = 70;
  let startY = null;
  let pulled = 0;
  const setPull = (p) => {
    ptr.style.opacity = String(Math.min(p / 50, 1));
    ptr.style.transform = `translate3d(0, ${p - 50}px, 0) rotate(${p * 4}deg)`;
  };
  const hide = () => {
    ptr.classList.add('release');
    ptr.classList.remove('spinning');
    ptr.style.opacity = '0';
    ptr.style.transform = 'translate3d(0, -50px, 0)';
    setTimeout(() => ptr.classList.remove('release'), 450);
  };
  document.addEventListener('touchstart', (e) => {
    if (!state.token || state.refreshing || window.scrollY > 0 || e.touches.length > 1) { startY = null; return; }
    if (e.target.closest('.chips, textarea')) { startY = null; return; }
    startY = e.touches[0].clientY;
    pulled = 0;
    ptr.classList.remove('release');
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) { pulled = 0; setPull(0); return; }
    pulled = Math.min(dy * 0.5, 100);
    setPull(pulled);
  }, { passive: true });
  document.addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    if (pulled < THRESHOLD) { hide(); return; }
    ptr.classList.add('release', 'spinning');
    ptr.style.opacity = '1';
    ptr.style.transform = 'translate3d(0, 24px, 0)';
    if (navigator.vibrate) navigator.vibrate(10);
    const started = Date.now();
    await loadAll();
    setTimeout(hide, Math.max(0, 500 - (Date.now() - started)));
  }, { passive: true });
})();

/* ---------- Setup / key ---------- */
function defaultRepo() {
  const host = location.hostname;
  if (host.endsWith('.github.io')) return host.split('.')[0] + '/tays-brain-data';
  return '';
}

function clearRenderedData() {
  ['#feed-latest', '#feed-older', '#feed-status', '#saved-list', '#thoughts-list', '#sources-list', '#chips']
    .forEach((s) => $(s).replaceChildren());
}

function showSetup({ keepData = false } = {}) {
  if (keepData) {
    store.remove('token');
  } else {
    store.wipe();
    state.saved = {};
    state.read = new Set();
    state.name = '';
  }
  state.token = null;
  state.cards = [];
  state.sources = {};
  state.thoughts = [];
  state.replyCache = {};
  state.loaded = false;
  state.errors = {};
  state.feedSig = '';
  currentView = null;
  clearRenderedData();
  $('#app').hidden = true;
  $('#setup').hidden = false;
  $('#setup-name').value = state.name || '';
  $('#setup-repo').value = state.repo || store.get('repo') || defaultRepo();
  $('#setup-token').value = '';
  $('#setup-error').hidden = true;
  if (!keepData) state.repo = null;
  history.replaceState(null, '', location.pathname + location.search);
}

function setupError(msg) {
  const e = $('#setup-error');
  e.textContent = msg;
  e.hidden = false;
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#setup-name').value.trim().slice(0, 30);
  const token = $('#setup-token').value.trim();
  const repo = $('#setup-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  $('#setup-error').hidden = true;
  if (!token) return setupError('Paste your GitHub key first.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return setupError('The data repo should look like owner/tays-brain-data.');

  const btn = $('#setup-submit');
  btn.disabled = true;
  btn.textContent = 'Checking your key…';
  try {
    const info = await gh(`/repos/${repo}`, { token });
    if (info && info.private === false) {
      setupError(`${repo} is public, so anyone could read your cards and thoughts. Make it private on GitHub, then try again.`);
      return;
    }
    state.token = token;
    state.repo = repo;
    state.name = name;
    store.set('token', token);
    store.set('repo', repo);
    store.set('name', name);
    state.saved = store.get('saved', {}) || {};
    state.read = new Set(store.get('read', []) || []);
    $('#setup-token').value = '';
    showApp();
  } catch (err) {
    if (err.status === 401) setupError("GitHub didn't accept that key. Copy it again, all the way from github_pat_ to the end.");
    else if (err.status === 404 || err.status === 403) setupError(`Can't see ${repo}. Check the name, and that the key was given access to that repo.`);
    else if (err.status === 0) setupError("Can't reach GitHub. Check your connection and try again.");
    else setupError(`GitHub answered with error ${err.status}. Try again in a minute.`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock my feed';
  }
});

$('#forget-key').addEventListener('click', () => {
  if (window.confirm('Forget your key? This also clears your saved cards and read history on this phone.')) {
    showSetup();
    toast('Key forgotten');
  }
});
$('#name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  state.name = $('#set-name').value.trim().slice(0, 30);
  store.set('name', state.name);
  $('#set-name').blur();
  toast('Name saved');
});
$('#refresh-btn').addEventListener('click', () => loadAll());

function showApp() {
  $('#setup').hidden = true;
  $('#app').hidden = false;
  mountComposers();
  renderChips();
  if (!location.hash) history.replaceState(null, '', '#feed');
  route();
  loadAll({ quiet: true });
}

/* ---------- Boot ---------- */
function boot() {
  state.token = store.get('token');
  state.repo = store.get('repo');
  state.name = store.get('name', '') || '';
  if (!state.token || !state.repo) {
    showSetup({ keepData: !!store.get('saved') });
    return;
  }
  state.saved = store.get('saved', {}) || {};
  state.read = new Set(store.get('read', []) || []);
  const cache = store.get('cache');
  if (cache) {
    state.cards = normalizeCards(cache.cards);
    state.sources = normalizeSources(cache.sources);
    state.thoughts = Array.isArray(cache.thoughts) ? cache.thoughts : [];
    state.replyCache = cache.replyCache || {};
    state.syncedAt = cache.syncedAt || null;
    state.loaded = true;
  }
  showApp();
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  // Coming back to the app after a while: refresh quietly.
  if (document.visibilityState === 'visible' && state.token && state.syncedAt &&
      Date.now() - new Date(state.syncedAt).getTime() > 10 * 60 * 1000) {
    loadAll({ quiet: true });
  }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Reload only when a new version replaces an old one, never on first install.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || !hadController) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
}

boot();
