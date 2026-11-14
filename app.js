'use strict';

/* Tay's Brain. All personal data comes from a private repo at runtime.
   This file holds no names, tokens or content. */

const APP_VERSION = '2.0.0'; // keep in sync with CACHE in sw.js
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
const STATUSES = ['unread', 'reading', 'learned', 'applied'];
const STATUS_LABEL = { unread: 'Unread', reading: 'Reading', learned: 'Learned', applied: 'Applied' };
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
  thoughts: [], // thoughts and links, newest first
  replyCache: {}, // issue number -> { updatedAt, reply }
  saved: {}, // cardId -> { ...card, savedAt, note, issue, dirty }
  closeQueue: [], // card-note issues to close (unsaved while offline)
  read: new Set(),
  filter: 'all',
  statusFilter: 'all',
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

/* ---------- Card art: seeded SVG, one motif per field ---------- */
const ART = {
  'time-freedom':    { bg: '#fff3d6', soft: '#ffe2a0', base: '#ffb020', deep: '#e57c00', pop: '#ff4d3d' },
  'future-of-work':  { bg: '#e3ecff', soft: '#bcd0ff', base: '#2f6bff', deep: '#1a44c2', pop: '#ff4fa3' },
  'money':           { bg: '#dcf6ea', soft: '#a9ebcf', base: '#00b37e', deep: '#007a57', pop: '#ffb020' },
  'sports-business': { bg: '#ff4d3d', soft: '#ff8a7d', base: '#ffffff', deep: '#c8261a', pop: '#ffb020' },
  'skills':          { bg: '#eee6ff', soft: '#d3c2ff', base: '#8b5cf6', deep: '#5b2fc9', pop: '#ff4fa3' },
  'thoughts':        { bg: '#ffe2f0', soft: '#ffb8da', base: '#ff4fa3', deep: '#c4167a', pop: '#8b5cf6' },
};
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = hashStr(String(seed));
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function artSvg(field, seed) {
  const c = ART[field] || ART['future-of-work'];
  const r = rng(seed + '|' + field);
  const R = (a, b) => a + r() * (b - a);
  const n = (v) => v.toFixed(1);
  let s = `<rect width="400" height="240" fill="${c.bg}"/>`;

  if (field === 'time-freedom') {
    const cx = R(90, 310), cy = R(80, 140), rad = R(48, 70);
    for (let i = 3; i >= 1; i--) s += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rad + i * 26)}" fill="none" stroke="${c.soft}" stroke-width="12" opacity="${0.35 + i * 0.12}"/>`;
    s += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(rad)}" fill="${c.base}"/>`;
    const y = R(168, 192), a = R(16, 34);
    s += `<path d="M0 ${n(y)} Q 100 ${n(y - a)} 200 ${n(y)} T 400 ${n(y)} V240 H0Z" fill="${c.deep}"/>`;
    s += `<path d="M0 ${n(y + 26)} Q 120 ${n(y + 4)} 240 ${n(y + 26)} T 480 ${n(y + 26)} V240 H0Z" fill="${c.pop}" opacity=".9"/>`;
  } else if (field === 'future-of-work') {
    for (let x = 12; x < 400; x += 24) for (let y = 12; y < 240; y += 24) s += `<circle cx="${x}" cy="${y}" r="2.2" fill="${c.deep}" opacity=".28"/>`;
    const pts = [];
    let y = R(150, 210);
    for (let x = 36; x <= 372; x += 84) { pts.push(`${x},${n(y)}`); y = Math.max(36, Math.min(204, y + R(-90, 40))); }
    s += `<rect x="${n(R(210, 290))}" y="${n(R(30, 80))}" width="84" height="84" rx="20" fill="${c.soft}" transform="rotate(${n(R(-14, 14))} 300 100)"/>`;
    s += `<polyline points="${pts.join(' ')}" fill="none" stroke="${c.base}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`;
    const last = pts[pts.length - 1].split(',');
    s += `<circle cx="${last[0]}" cy="${last[1]}" r="20" fill="${c.pop}"/><circle cx="${last[0]}" cy="${last[1]}" r="34" fill="none" stroke="${c.pop}" stroke-width="5" opacity=".4"/>`;
  } else if (field === 'money') {
    const count = 5, w = 46, gap = R(14, 22), x0 = R(24, 60);
    for (let i = 0; i < count; i++) {
      const h = 46 + i * R(24, 32);
      s += `<rect x="${n(x0 + i * (w + gap))}" y="${n(240 - h)}" width="${w}" height="${n(h + 20)}" rx="14" fill="${i % 2 ? c.deep : c.base}"/>`;
    }
    const cx = R(290, 350), cy = R(48, 76);
    s += `<circle cx="${n(cx)}" cy="${n(cy)}" r="32" fill="${c.pop}"/><circle cx="${n(cx)}" cy="${n(cy)}" r="20" fill="none" stroke="#fff" stroke-width="4" opacity=".7"/>`;
    s += `<circle cx="${n(cx - 56)}" cy="${n(cy + 22)}" r="12" fill="${c.soft}"/>`;
  } else if (field === 'sports-business') {
    const rot = R(-10, 10), ox = R(-40, 40);
    s += `<g transform="rotate(${n(rot)} 200 120) translate(${n(ox)} 0)" fill="none" stroke="#fff" stroke-width="6" opacity=".6">`
      + `<rect x="-20" y="22" width="440" height="196" rx="26"/><line x1="200" y1="22" x2="200" y2="218"/>`
      + `<circle cx="200" cy="120" r="44"/><path d="M-20 70 H60 A50 50 0 0 1 60 170 H-20"/><path d="M420 70 H340 A50 50 0 0 0 340 170 H420"/></g>`;
    const bx = R(80, 320), by = R(60, 180);
    s += `<circle cx="${n(bx)}" cy="${n(by)}" r="30" fill="${c.pop}"/>`
      + `<path d="M${n(bx - 30)} ${n(by)} H${n(bx + 30)} M${n(bx)} ${n(by - 30)} V${n(by + 30)}" stroke="${c.deep}" stroke-width="3" opacity=".5"/>`;
    s += `<circle cx="${n(R(40, 360))}" cy="${n(R(30, 210))}" r="10" fill="${c.deep}" opacity=".5"/>`;
  } else if (field === 'skills') {
    s += `<path d="M-10 230 Q 200 ${n(R(40, 90))} 410 230" fill="none" stroke="${c.soft}" stroke-width="22"/>`;
    const nodes = [];
    for (let i = 0; i < 6; i++) nodes.push([30 + i * 68 + R(-14, 14), R(40, 200)]);
    let lines = '';
    for (let i = 0; i < nodes.length - 1; i++) lines += `<line x1="${n(nodes[i][0])}" y1="${n(nodes[i][1])}" x2="${n(nodes[i + 1][0])}" y2="${n(nodes[i + 1][1])}"/>`;
    lines += `<line x1="${n(nodes[0][0])}" y1="${n(nodes[0][1])}" x2="${n(nodes[3][0])}" y2="${n(nodes[3][1])}"/>`;
    s += `<g stroke="${c.deep}" stroke-width="4" opacity=".45">${lines}</g>`;
    nodes.forEach(([x, y], i) => {
      const fill = i === 2 ? c.pop : i % 2 ? c.base : '#fff';
      s += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(i === 2 ? 22 : R(10, 17))}" fill="${fill}" stroke="${c.deep}" stroke-width="${fill === '#fff' ? 4 : 0}"/>`;
    });
  } else { // thoughts
    const b = (x, y, w, h, fill, flip) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2.4)}" fill="${fill}"/>`
      + `<path d="M${n(x + (flip ? w - 46 : 34))} ${n(y + h - 4)} l${flip ? 22 : -8} 30 l${flip ? -2 : 30} -30z" fill="${fill}"/>`;
    s += b(R(20, 60), R(26, 50), R(170, 210), R(78, 96), c.base, false);
    s += b(R(170, 220), R(110, 130), R(150, 180), R(64, 78), c.pop, true);
    const dx = R(70, 100), dy = R(64, 84);
    s += [0, 1, 2].map((i) => `<circle cx="${n(dx + i * 26)}" cy="${n(dy)}" r="7" fill="#fff"/>`).join('');
    s += `<circle cx="${n(R(330, 380))}" cy="${n(R(30, 70))}" r="16" fill="${c.soft}"/>`;
  }
  return `<svg viewBox="0 0 400 240" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
}
function artEl(field, seed, cls = 'art') {
  const d = el('div', cls);
  if (!d.classList.contains('art')) d.classList.add('art');
  d.innerHTML = artSvg(field, seed); // generated from numbers and constants only, never data text
  return d;
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

function normalizeCard(c) {
  return {
    id: String(c.id),
    field: str(c.field, 60),
    headline: str(c.headline, 300),
    why: str(c.why, 1200),
    source: str(c.source, 120),
    url: str(c.url, 2000),
    drop: str(c.drop, 10),
    createdAt: str(c.createdAt, 40),
  };
}
function normalizeCards(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((c) => c && typeof c === 'object' && (c.id != null) && c.headline)
    .map(normalizeCard)
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
async function fetchIssues(label, maxPages = 1) {
  let all = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await gh(`/repos/${state.repo}/issues?labels=${encodeURIComponent(label)}&state=all&sort=created&direction=desc&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) break;
    all = all.concat(batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
  }
  return all;
}
async function latestReply(i) {
  if (!(i.comments > 0)) return null;
  const cached = state.replyCache[i.number];
  if (cached && cached.updatedAt === i.updated_at) return cached.reply;
  try {
    const cs = await gh(`/repos/${state.repo}/issues/${i.number}/comments?per_page=100`);
    const c = Array.isArray(cs) && cs[cs.length - 1];
    const reply = c ? { body: str(c.body, 6000), at: c.created_at } : null;
    state.replyCache[i.number] = { updatedAt: i.updated_at, reply };
    return reply;
  } catch { return cached ? cached.reply : null; }
}

/* Embedded JSON in an HTML comment: '-' is escaped so the comment can never end early. */
const encodeData = (o) => JSON.stringify(o).replace(/-/g, '\\u002d');
function decodeData(body, tag) {
  const m = new RegExp(`<!-- ${tag} (\\{[\\s\\S]*?\\}) -->`).exec(body || '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function fetchThoughtsAndLinks() {
  const [thoughts, links] = await Promise.all([fetchIssues('thought'), fetchIssues('link')]);
  const items = await Promise.all([
    ...thoughts.map(async (i) => ({
      kind: 'thought', number: i.number, text: str(i.body, 6000) || str(i.title, 300),
      at: i.created_at, closed: i.state === 'closed', reply: await latestReply(i),
    })),
    ...links.map(async (i) => {
      const d = decodeData(i.body, 'tb-link') || {};
      const found = /(https?:\/\/\S+)/.exec(i.body || '');
      return {
        kind: 'link', number: i.number, url: str(d.url, 2000) || (found ? found[1] : ''),
        text: str(d.note, 2000), at: i.created_at, closed: i.state === 'closed', reply: await latestReply(i),
      };
    }),
  ]);
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* ---------- Card notes (saved cards <-> "card-note" issues) ---------- */
const blankNote = () => ({ status: 'unread', why: '', learned: '', apply: '', statusAt: {} });

function noteTitle(s) {
  return `${s.id}: ${s.headline}`.slice(0, 200);
}
function noteBody(s) {
  const n = s.note;
  const url = safeUrl(s.url);
  const section = (h, v) => [`## ${h}`, v ? v : '_Not written yet._', ''];
  const lines = [
    `**Status:** ${STATUS_LABEL[n.status]}`,
    `**Field:** ${FIELD_BY_ID[s.field]?.name || s.field || 'Uncategorized'}`,
    `**Source:** ${s.source || hostOf(s.url) || 'Unknown'}${url ? ` (${url})` : ''}`,
    `**Saved:** ${String(s.savedAt).slice(0, 10)}`,
    '',
    ...section('Why I saved it', n.why),
    ...section('What I learned', n.learned),
    ...section("How I'll apply it", n.apply),
    `<!-- tb-card-note ${encodeData({
      v: 1,
      cardId: s.id,
      card: { headline: s.headline, field: s.field, why: s.why, source: s.source, url: s.url, drop: s.drop, createdAt: s.createdAt },
      savedAt: s.savedAt,
      note: n,
    })} -->`,
  ];
  return lines.join('\n');
}
function persistSaved() {
  store.set('saved', state.saved);
  store.set('closeQueue', state.closeQueue);
}

const syncing = new Set();
const resync = new Set();
const noteTimers = {};
let syncListener = null; // the open sheet listens for sync results

async function syncNote(id) {
  clearTimeout(noteTimers[id]);
  delete noteTimers[id];
  const s = state.saved[id];
  if (!s || !state.token) return;
  s.dirty = true;
  persistSaved();
  if (syncing.has(id)) { resync.add(id); return; }
  syncing.add(id);
  syncListener?.(id, 'saving');
  try {
    const payload = { title: noteTitle(s), body: noteBody(s) };
    if (s.issue) {
      await gh(`/repos/${state.repo}/issues/${s.issue}`, { method: 'PATCH', body: { ...payload, state: 'open' } });
    } else {
      const issue = await gh(`/repos/${state.repo}/issues`, { method: 'POST', body: { ...payload, labels: ['card-note'] } });
      s.issue = issue.number;
    }
    if (state.saved[id] !== s) {
      // Unsaved while the request was in flight.
      queueClose(s);
    } else {
      s.dirty = false;
      persistSaved();
      syncListener?.(id, 'synced');
    }
  } catch {
    syncListener?.(id, 'offline');
  } finally {
    syncing.delete(id);
    if (resync.delete(id)) syncNote(id);
  }
}
function syncNoteSoon(id) {
  clearTimeout(noteTimers[id]);
  syncListener?.(id, 'pending');
  noteTimers[id] = setTimeout(() => syncNote(id), 1200);
}
function queueClose(s) {
  if (!s.issue) return;
  state.closeQueue = state.closeQueue.filter((q) => q.issue !== s.issue);
  state.closeQueue.push({ issue: s.issue, snapshot: s });
  persistSaved();
  flushCloseQueue();
}
let flushingClose = false;
async function flushCloseQueue() {
  if (flushingClose || !state.token) return;
  flushingClose = true;
  for (const q of [...state.closeQueue]) {
    // Saved again before the close went through: leave it open.
    if (Object.values(state.saved).some((s) => s.issue === q.issue)) {
      state.closeQueue = state.closeQueue.filter((x) => x !== q);
      continue;
    }
    try {
      const snap = { ...q.snapshot, note: { ...blankNote(), ...q.snapshot.note } };
      const body = noteBody(snap).replace(/^\*\*Status:\*\* .*/, '**Status:** Dropped (unsaved)');
      await gh(`/repos/${state.repo}/issues/${q.issue}`, {
        method: 'PATCH',
        body: { body, state: 'closed', state_reason: 'not_planned' },
      });
      state.closeQueue = state.closeQueue.filter((x) => x !== q);
    } catch { break; }
  }
  persistSaved();
  flushingClose = false;
}

async function fetchNotes() {
  return fetchIssues('card-note', 3);
}

/* Merge remote card-notes with this phone's saved cards. */
function reconcileNotes(issues) {
  const latest = {};
  for (const i of issues) {
    const d = decodeData(i.body, 'tb-card-note');
    if (!d || !d.cardId) continue;
    const id = String(d.cardId);
    if (!latest[id] || i.updated_at > latest[id].issue.updated_at) latest[id] = { issue: i, data: d };
  }
  const queuedClose = new Set(state.closeQueue.map((q) => q.issue));
  for (const [id, { issue, data }] of Object.entries(latest)) {
    const local = state.saved[id];
    if (issue.state === 'open') {
      if (queuedClose.has(issue.number)) continue;
      if (!local) {
        // Saved on another device.
        if (!data.card || !data.card.headline) continue;
        state.saved[id] = {
          ...normalizeCard({ id, ...data.card }),
          savedAt: data.savedAt || issue.created_at,
          note: { ...blankNote(), ...data.note },
          issue: issue.number,
          dirty: false,
        };
      } else if (!local.issue) {
        local.issue = issue.number;
        local.dirty = true;
      } else if (!local.dirty && local.issue === issue.number) {
        local.note = { ...blankNote(), ...data.note };
      }
    } else if (local) {
      if (local.issue === issue.number && !local.dirty &&
          new Date(issue.closed_at || 0) > new Date(local.savedAt || 0)) {
        delete state.saved[id]; // unsaved on another device
      } else if (!local.issue) {
        local.issue = issue.number; // reopen the old note instead of making a new one
        local.dirty = true;
      }
    }
  }
  persistSaved();
  for (const s of Object.values(state.saved)) if (s.dirty || !s.issue) syncNote(s.id);
  flushCloseQueue();
}

/* ---------- Load ---------- */
async function loadAll({ quiet = false } = {}) {
  if (!state.token || state.refreshing) return;
  state.refreshing = true;
  const [cards, sources, thoughts, notes] = await Promise.allSettled([
    fetchCards(), fetchSources(), fetchThoughtsAndLinks(), fetchNotes(),
  ]);
  state.refreshing = false;
  if (!state.token) return; // key was forgotten mid-flight

  state.errors = {};
  const failed = [cards, sources, thoughts, notes].filter((r) => r.status === 'rejected').map((r) => r.reason);
  if (cards.status === 'fulfilled') state.cards = cards.value; else state.errors.cards = cards.reason;
  if (sources.status === 'fulfilled') state.sources = sources.value; else state.errors.sources = sources.reason;
  if (thoughts.status === 'fulfilled') state.thoughts = [...state.thoughts.filter((t) => t.pending), ...thoughts.value];
  else state.errors.thoughts = thoughts.reason;
  if (notes.status === 'fulfilled') reconcileNotes(notes.value);

  if (failed.length < 4) {
    state.loaded = true;
    state.syncedAt = new Date().toISOString();
    saveCache();
  }
  renderAll();
  if (failed.some((e) => e && e.status === 0)) toast("You're offline. Showing your last sync.");
  else if (!quiet && failed.length === 0) toast('Up to date');
  return failed;
}
function saveCache() {
  store.set('cache', {
    cards: state.cards, sources: state.sources, thoughts: state.thoughts.filter((t) => !t.pending),
    replyCache: state.replyCache, syncedAt: state.syncedAt,
  });
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
function hasNoteText(s) { return !!(s && (s.note.why || s.note.learned || s.note.apply)); }

function toggleSave(card) {
  if (isSaved(card.id)) {
    const s = state.saved[card.id];
    delete state.saved[card.id];
    clearTimeout(noteTimers[card.id]);
    persistSaved();
    queueClose(s);
  } else {
    const base = normalizeCard(card);
    state.saved[card.id] = { ...base, savedAt: new Date().toISOString(), note: blankNote(), issue: null, dirty: true };
    persistSaved();
    syncNote(card.id);
  }
  syncCardButtons(card.id);
  return isSaved(card.id);
}
function toggleRead(id) {
  if (state.read.has(id)) state.read.delete(id); else state.read.add(id);
  store.set('read', Array.from(state.read).slice(-3000));
  syncCardButtons(id);
  renderFeedMeta();
}
function setStatus(id, status) {
  const s = state.saved[id];
  if (!s || !STATUSES.includes(status)) return;
  const now = new Date().toISOString();
  const statusAt = { ...s.note.statusAt };
  // Jumping ahead (say, straight to Applied) also stamps the steps skipped on the way.
  STATUSES.slice(1, STATUSES.indexOf(status) + 1).forEach((st) => { if (!statusAt[st] || st === status) statusAt[st] = now; });
  s.note.status = status;
  s.note.statusAt = statusAt;
  persistSaved();
  syncNote(id);
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
    c.classList.toggle('is-read', read && !c.classList.contains('compact'));
  });
}

/* ---------- Card element ---------- */
const tplCard = $('#tpl-card');
function cardEl(card, { i = 0, animate = false, layout = 'standard', savedView = false } = {}) {
  const node = tplCard.content.firstElementChild.cloneNode(true);
  node.dataset.id = card.id;
  node.dataset.field = FIELD_BY_ID[card.field] ? card.field : 'none';
  node.classList.add(layout);
  const art = $('.card-art', node);
  art.classList.add('art');
  art.innerHTML = artSvg(card.field, card.id); // numbers and constants only
  if (layout === 'split') $('.card-body', node).prepend(art);

  $('.tag-name', node).textContent = FIELD_BY_ID[card.field]?.name || card.field || 'Uncategorized';
  $('.card-headline', node).textContent = card.headline;
  if (card.why) $('.card-why', node).textContent = card.why;
  else { $('.card-why-label', node).remove(); $('.card-why', node).remove(); }

  const a = $('.card-source', node);
  const url = safeUrl(card.url);
  a.textContent = card.source || hostOf(card.url) || 'Source';
  if (url) a.href = url; else a.removeAttribute('href');

  if (savedView) {
    const s = state.saved[card.id];
    node.classList.add('compact', 'opens');
    $('.card-why-label', node)?.remove();
    const chip = $('.status-chip', node);
    chip.hidden = false;
    chip.dataset.status = s.note.status;
    chip.textContent = STATUS_LABEL[s.note.status];
    chip.setAttribute('aria-label', `Status: ${STATUS_LABEL[s.note.status]}. Tap to move it forward.`);
    $('.read-btn', node).hidden = true;
    const preview = s.note.learned ? ['Learned', s.note.learned] : s.note.why ? ['Why I saved it', s.note.why] : null;
    if (preview) {
      const p = el('p', 'card-note-preview');
      p.append(el('b', null, preview[0] + ': '), document.createTextNode(preview[1]));
      $('.card-foot', node).before(p);
    }
  }

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
  node.classList.toggle('is-read', read && !savedView);
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
const feedLayout = (i) => (i === 0 ? 'featured' : i % 3 === 2 ? 'split' : 'standard');

function renderChips() {
  const nav = $('#chips');
  nav.replaceChildren();
  for (const f of [{ id: 'all', name: 'All' }, ...FIELDS]) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.filter = f.id;
    if (f.id !== 'all') { b.dataset.field = f.id; b.append(el('i')); }
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
    if (!err) status.append(el('b', null, 'Your first drop is on its way'), document.createTextNode('Cards land here every other day. Drop a thought or add a link while you wait.'));
    caught.hidden = true;
    renderFeedMeta();
    return;
  }

  const latestCards = state.cards.filter((c) => c.drop === latest && matchesFilter(c));
  if (latestCards.length === 0) {
    const f = FIELD_BY_ID[state.filter];
    status.append(el('b', null, `Nothing on ${f ? f.name.toLowerCase() : 'this'} in ${dropLabel(latest).toLowerCase()}`), document.createTextNode('Try another field, or check the earlier drops below.'));
  }
  latestCards.forEach((c, i) => list.append(cardEl(c, { i, animate, layout: feedLayout(i) })));

  caught.hidden = false;
  caught.classList.remove('seen');
  observeCaughtUp(animate);

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
        if (d.open && !wrap.childElementCount) cards.forEach((c, i) => wrap.append(cardEl(c, { i, animate: true, layout: 'split' })));
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
  if (!inDrop.length) sub.textContent = state.loaded ? 'Your first drop is on its way.' : '';
  else if (unread === 0) sub.textContent = `You've read all of ${dropLabel(latest).toLowerCase()}.`;
  else sub.textContent = `${dropLabel(latest)}: ${inDrop.length} cards, ${unread} unread.`;

  const next = parseDay(latest);
  let nextText = '';
  if (next) {
    next.setDate(next.getDate() + DROP_EVERY_DAYS);
    nextText = next <= startOfToday()
      ? 'The next drop is due any time now.'
      : `The next one lands around ${fmtDay(next, { weekday: 'long', month: 'short', day: 'numeric' })}.`;
  }
  const lead = unread === 0 ? `You read all ${inDrop.length}.` : `That's all ${inDrop.length} from this drop.`;
  $('#caught-text').textContent = `${lead} ${nextText}`.trim();
}

let caughtObserver;
function observeCaughtUp(animate) {
  const node = $('#caught-up');
  if (!animate || reduceMotion.matches || !('IntersectionObserver' in window)) { node.classList.add('seen'); return; }
  caughtObserver?.disconnect();
  caughtObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { node.classList.add('seen'); caughtObserver.disconnect(); }
  }, { threshold: 0.6 });
  caughtObserver.observe(node);
}

/* ---------- Saved ---------- */
function monthProgress() {
  const now = new Date();
  const inMonth = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  };
  let learned = 0, applied = 0;
  for (const s of Object.values(state.saved)) {
    const idx = STATUSES.indexOf(s.note.status);
    if (idx >= 2 && inMonth(s.note.statusAt?.learned)) learned++;
    if (idx >= 3 && inMonth(s.note.statusAt?.applied)) applied++;
  }
  return { learned, applied };
}
function renderSaved({ animate = true } = {}) {
  const items = Object.values(state.saved).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  const prog = $('#saved-progress');
  prog.replaceChildren();
  if (!items.length) {
    prog.textContent = 'Cards you keep live here.';
  } else {
    const { learned, applied } = monthProgress();
    prog.append(el('b', null, `${learned} learned, ${applied} applied`), document.createTextNode(' this month.'));
  }

  const chips = $('#status-chips');
  chips.replaceChildren();
  chips.hidden = !items.length;
  for (const st of ['all', ...STATUSES]) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.statusFilter = st;
    if (st !== 'all') { b.dataset.status = st; b.append(el('i')); }
    b.append(document.createTextNode(st === 'all' ? 'All ' : STATUS_LABEL[st] + ' '));
    b.append(el('b', null, String(st === 'all' ? items.length : items.filter((s) => s.note.status === st).length)));
    b.setAttribute('aria-pressed', String(state.statusFilter === st));
    chips.append(b);
  }

  const list = $('#saved-list');
  list.replaceChildren();
  if (!items.length) {
    const e = el('div', 'empty');
    e.append(el('b', null, 'Nothing saved yet'), document.createTextNode('Tap the bookmark on any card in your feed. Then open it here to note what you learned.'));
    list.append(e);
    return;
  }
  const shown = items.filter((s) => state.statusFilter === 'all' || s.note.status === state.statusFilter);
  if (!shown.length) {
    const e = el('div', 'empty');
    e.append(el('b', null, `Nothing marked ${STATUS_LABEL[state.statusFilter].toLowerCase()}`), document.createTextNode('Tap the status on a card to move it forward.'));
    list.append(e);
    return;
  }
  shown.forEach((s, i) => list.append(cardEl(s, { i, animate: animate && i < 8, layout: 'split', savedView: true })));
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
    e.append(el('b', null, state.loaded ? 'Nothing here yet' : 'Loading your thoughts'),
      document.createTextNode(state.loaded ? 'Type a thought above, or tap + to add a link. The Brain answers on its next sweep.' : 'One second.'));
    list.append(e);
    return;
  }
  for (const t of state.thoughts) {
    const item = el('article', 'thought');
    if (t.kind === 'link') {
      const url = safeUrl(t.url);
      const a = el(url ? 'a' : 'div', 'thought-link');
      if (url) { a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.append(artEl('thoughts', t.url || String(t.number)));
      const span = el('span');
      span.append(el('b', null, hostOf(t.url) || 'Link'), el('small', null, t.url));
      a.append(span);
      item.append(a);
      if (t.text) item.append(el('p', 'thought-text', t.text));
    } else {
      item.append(el('p', 'thought-text', t.text));
    }
    const meta = el('div', 'thought-meta');
    let pill;
    if (t.pending) pill = el('span', 'pill pill-sending', 'Sending');
    else if (t.kind === 'link' && t.closed) pill = el('span', 'pill pill-done', 'Added to your feed');
    else if (t.kind === 'link' && !t.reply) pill = el('span', 'pill pill-wait', 'Waiting for the Brain');
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
  $('#thoughts-badge').hidden = !state.thoughts.some((t) => t.reply && t.reply.at > seen);
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
    g.dataset.field = f.id;
    const head = el('div', 'source-head');
    head.append(artEl(f.id, 'source-' + f.id), el('h2', null, f.name));
    g.append(head);
    const items = state.sources[f.id] || [];
    if (!items.length) {
      g.append(el('p', 'source-note', f.id === 'thoughts' ? 'Comes from what you post in Thoughts, plus links you add.' : 'No sources yet.'));
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
  } else if (v === 'sources') renderSources();
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
  $('#fab').hidden = !(v === 'feed' || v === 'thoughts');
  renderView(v);
  if (changed) window.scrollTo(0, 0);
}
function renderAll() {
  if (!state.token) return;
  if (currentView === 'saved' && $('#note-sheet').open) return; // don't yank the list under an open sheet
  renderView(currentRoute());
  updateThoughtsBadge();
}

/* ---------- Composer (thoughts) ---------- */
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
  const temp = { kind: 'thought', number: 'pending-' + Date.now(), text, at: new Date().toISOString(), reply: null, pending: true };
  state.thoughts.unshift(temp);
  if (currentView === 'thoughts') renderThoughts();
  const firstLine = text.split('\n')[0];
  const title = firstLine.length > 60 ? firstLine.slice(0, 59).trimEnd() + '…' : firstLine;
  try {
    const issue = await gh(`/repos/${state.repo}/issues`, { method: 'POST', body: { title, body: text, labels: ['thought'] } });
    Object.assign(temp, { number: issue.number, at: issue.created_at, pending: false });
    saveCache();
    toast('Thought sent. The Brain replies on its next sweep.');
    if (currentView === 'thoughts') renderThoughts();
    return true;
  } catch (e) {
    state.thoughts = state.thoughts.filter((t) => t !== temp);
    if (currentView === 'thoughts') renderThoughts();
    toast(sendError(e));
    return false;
  }
}
function sendError(e) {
  if (e.status === 403 || e.status === 404) return "Couldn't send. The key needs Issues read and write.";
  if (e.status === 401) return "Couldn't send. Your key stopped working.";
  return "Couldn't send. Check your connection.";
}

/* ---------- Sheets ---------- */
function openSheet(dialog) {
  dialog.classList.remove('closing');
  dialog.style.transform = '';
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function closeSheet(dialog) {
  if (!dialog.open || dialog.classList.contains('closing')) return;
  dialog.dispatchEvent(new Event('sheetclose'));
  if (reduceMotion.matches) { dialog.close(); return; }
  dialog.classList.add('closing');
  dialog.addEventListener('animationend', () => {
    dialog.classList.remove('closing');
    dialog.style.transform = '';
    dialog.close();
  }, { once: true });
}
$$('.sheet').forEach((dialog) => {
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(dialog); });
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closeSheet(dialog); return; }
    if (e.target === dialog && e.clientY < dialog.getBoundingClientRect().top) closeSheet(dialog);
  });
  // Drag the grip down to dismiss.
  const grip = $('[data-grip]', dialog);
  let start = null;
  grip.addEventListener('pointerdown', (e) => { start = e.clientY; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointermove', (e) => {
    if (start == null) return;
    dialog.style.transform = `translate3d(0, ${Math.max(0, e.clientY - start)}px, 0)`;
  });
  const end = (e) => {
    if (start == null) return;
    const dy = e.clientY - start;
    start = null;
    if (dy > 90) closeSheet(dialog);
    else dialog.style.transform = '';
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
});

/* Note sheet for a saved card */
let openNoteId = null;
const SYNC_COPY = {
  pending: 'Saving…',
  saving: 'Saving…',
  synced: 'Synced to your Brain',
  offline: "Saved on this phone. It'll sync when you're back online.",
};
function renderStatusTrack(id) {
  const s = state.saved[id];
  const track = $('#note-status');
  track.replaceChildren();
  const cur = STATUSES.indexOf(s.note.status);
  STATUSES.forEach((st, idx) => {
    const b = el('button', idx < cur ? 'done' : '', STATUS_LABEL[st]);
    b.type = 'button';
    b.dataset.status = st;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(idx === cur));
    track.append(b);
  });
}
function openNote(id) {
  const s = state.saved[id];
  if (!s) return;
  openNoteId = id;
  const sheet = $('#note-sheet');
  sheet.dataset.field = FIELD_BY_ID[s.field] ? s.field : 'none';
  const art = $('#note-art');
  art.classList.add('art');
  art.innerHTML = artSvg(s.field, s.id); // numbers and constants only
  $('#note-tag .tag-name').textContent = FIELD_BY_ID[s.field]?.name || s.field || 'Uncategorized';
  $('#note-headline').textContent = s.headline;
  const a = $('#note-source');
  const url = safeUrl(s.url);
  a.textContent = s.source || hostOf(s.url) || 'Source';
  if (url) a.href = url; else a.removeAttribute('href');
  renderStatusTrack(id);
  $('#note-why').value = s.note.why || '';
  $('#note-learned').value = s.note.learned || '';
  $('#note-apply').value = s.note.apply || '';
  $('#note-sync').textContent = s.dirty ? SYNC_COPY.offline : s.issue ? SYNC_COPY.synced : '';
  openSheet(sheet);
  // showModal focuses the first link; start with nothing focused so no ring shows.
  if (document.activeElement && sheet.contains(document.activeElement)) document.activeElement.blur();
}
syncListener = (id, phase) => {
  if (id === openNoteId && $('#note-sheet').open) $('#note-sync').textContent = SYNC_COPY[phase] || '';
};
$('#note-status').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-status]');
  if (!b || !openNoteId) return;
  setStatus(openNoteId, b.dataset.status);
  renderStatusTrack(openNoteId);
});
[['#note-why', 'why'], ['#note-learned', 'learned'], ['#note-apply', 'apply']].forEach(([sel, key]) => {
  const input = $(sel);
  input.addEventListener('input', () => {
    const s = state.saved[openNoteId];
    if (!s) return;
    s.note[key] = input.value.slice(0, 600);
    s.dirty = true;
    persistSaved();
    syncNoteSoon(openNoteId);
  });
});
$('#note-sheet').addEventListener('sheetclose', () => {
  const id = openNoteId;
  if (id && noteTimers[id]) syncNote(id);
  openNoteId = null;
  if (currentView === 'saved') renderSaved({ animate: false });
});

/* Add-a-link sheet */
function normalizeLink(raw) {
  let v = raw.trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  const url = safeUrl(v);
  if (!url) return null;
  return new URL(url).hostname.includes('.') ? url : null;
}
$('#fab').addEventListener('click', () => {
  $('#link-url').value = '';
  $('#link-note').value = '';
  $('#link-error').hidden = true;
  $('#link-paste').hidden = !(navigator.clipboard && navigator.clipboard.readText);
  openSheet($('#link-sheet'));
});
$('#link-paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const found = /(https?:\/\/\S+)/.exec(text || '');
    $('#link-url').value = (found ? found[1] : text || '').trim();
  } catch { toast('Paste with a long press instead.'); }
});
$('#link-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#link-error');
  err.hidden = true;
  const url = normalizeLink($('#link-url').value);
  const note = $('#link-note').value.trim().slice(0, 800);
  if (!url) { err.textContent = 'That doesn\'t look like a link. Paste the full address, like https://example.com/story.'; err.hidden = false; return; }

  const btn = $('#link-submit');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  const host = hostOf(url);
  let path = '';
  try { path = new URL(url).pathname.replace(/\/$/, ''); } catch { /* ignore */ }
  const title = `Link: ${host}${path}`.slice(0, 100);
  const body = [
    url,
    '',
    `**Why it caught my eye:** ${note || '_No note._'}`,
    '',
    `<!-- tb-link ${encodeData({ v: 1, url, note })} -->`,
  ].join('\n');
  try {
    const issue = await gh(`/repos/${state.repo}/issues`, { method: 'POST', body: { title, body, labels: ['link'] } });
    state.thoughts.unshift({ kind: 'link', number: issue.number, url, text: note, at: issue.created_at, closed: false, reply: null });
    saveCache();
    closeSheet($('#link-sheet'));
    toast("Link sent. It'll show up in your next drop.");
    if (currentView === 'thoughts') renderThoughts();
  } catch (ex) {
    err.textContent = sendError(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to the Brain';
  }
});

/* ---------- Card interactions: filters, save, read, status, open, tilt ---------- */
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip && chip.dataset.filter) {
    state.filter = chip.dataset.filter;
    $$('#chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    chip.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    renderFeed();
    return;
  }
  if (chip && chip.dataset.statusFilter) {
    state.statusFilter = chip.dataset.statusFilter;
    renderSaved();
    return;
  }
  const card = e.target.closest('.card');
  if (!card || !card._card) return;
  const id = card._card.id;

  if (e.target.closest('.save-btn')) {
    const btn = e.target.closest('.save-btn');
    const s = state.saved[id];
    if (s && hasNoteText(s) && !window.confirm('Remove from saved? Your notes stay in your data repo.')) return;
    const nowSaved = toggleSave(card._card);
    if (nowSaved) {
      btn.classList.remove('pop');
      void btn.offsetWidth;
      btn.classList.add('pop');
      if (navigator.vibrate) navigator.vibrate(8);
    }
    toast(nowSaved ? 'Saved. Open it in Saved to add notes.' : 'Removed from saved');
    if (currentView === 'saved') renderSaved({ animate: false });
  } else if (e.target.closest('.read-btn')) {
    toggleRead(id);
  } else if (e.target.closest('.status-chip')) {
    const s = state.saved[id];
    if (!s) return;
    const idx = STATUSES.indexOf(s.note.status);
    if (idx >= STATUSES.length - 1) { openNote(id); return; }
    const next = STATUSES[idx + 1];
    setStatus(id, next);
    const chipEl = e.target.closest('.status-chip');
    chipEl.dataset.status = next;
    chipEl.textContent = STATUS_LABEL[next];
    chipEl.classList.remove('bump');
    void chipEl.offsetWidth;
    chipEl.classList.add('bump');
    if (navigator.vibrate) navigator.vibrate(6);
    const { learned, applied } = monthProgress();
    const prog = $('#saved-progress');
    prog.replaceChildren(el('b', null, `${learned} learned, ${applied} applied`), document.createTextNode(' this month.'));
  } else if (e.target.closest('.card-source')) {
    if (!state.read.has(id)) toggleRead(id); // opening the source counts as reading it
  } else if (card.classList.contains('opens')) {
    openNote(id);
  }
});

let tilt = null;
function applyTilt() {
  if (!tilt) return;
  tilt.raf = 0;
  const { card, rect, x, y } = tilt;
  const px = Math.max(-0.5, Math.min(0.5, (x - rect.left) / rect.width - 0.5));
  const py = Math.max(-0.5, Math.min(0.5, (y - rect.top) / rect.height - 0.5));
  card.style.transform = `perspective(900px) rotateX(${(-py * 6).toFixed(2)}deg) rotateY(${(px * 6).toFixed(2)}deg) scale(0.985)`;
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
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, releaseTilt, { passive: true }));
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
    if (!state.token || state.refreshing || window.scrollY > 0 || e.touches.length > 1 || $('dialog[open]')) { startY = null; return; }
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
  return host.endsWith('.github.io') ? host.split('.')[0] + '/tays-brain-data' : '';
}
function renderMosaic() {
  const m = $('#mosaic');
  if (m.childElementCount) return;
  ['sports-business', 'time-freedom', 'future-of-work', 'money', 'thoughts', 'skills'].forEach((f, i) => {
    const t = artEl(f, 'mosaic-' + f, 'tile');
    t.style.setProperty('--i', String(i));
    m.append(t);
  });
}
function clearRenderedData() {
  ['#feed-latest', '#feed-older', '#feed-status', '#saved-list', '#status-chips', '#thoughts-list', '#sources-list', '#chips']
    .forEach((s) => $(s).replaceChildren());
  $$('dialog[open]').forEach((d) => d.close());
}

function showSetup({ keepData = false } = {}) {
  if (keepData) {
    store.remove('token');
  } else {
    store.wipe();
    state.saved = {};
    state.closeQueue = [];
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
  renderMosaic();
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
function loadLocalState() {
  const saved = store.get('saved', {}) || {};
  for (const s of Object.values(saved)) {
    s.note = { ...blankNote(), ...(s.note || {}) };
    if (!('issue' in s)) { s.issue = null; s.dirty = true; } // saved before notes existed
  }
  state.saved = saved;
  state.closeQueue = store.get('closeQueue', []) || [];
  state.read = new Set(store.get('read', []) || []);
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
    loadLocalState();
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
  if (window.confirm('Forget your key? This also clears saved cards and read history on this phone. Your notes stay in your data repo.')) {
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
  loadLocalState();
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
