'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const CONTROL_KEY = process.env.CONTROL_KEY || '';
const HOST = process.env.HOST || '0.0.0.0';
// Where this server is reached from outside (e.g. https://wall.example.com) when it sits behind
// a reverse proxy; the control page then shows this as the OBS display URL.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// media/ and the files the server rewrites as it runs; a DATA_DIR per instance lets several
// walls run from one copy of the code.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT;
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const RUNDOWN_FILE = path.join(DATA_DIR, 'rundowns.json');
const ASRUN_FILE = path.join(DATA_DIR, 'asrun.csv');

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB, 10) > 0 ? parseInt(process.env.MAX_UPLOAD_MB, 10) : 2048;
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
const TOO_LARGE = 'File too large (max ' + (MAX_UPLOAD_MB % 1024 ? MAX_UPLOAD_MB + ' MB' : MAX_UPLOAD_MB / 1024 + ' GB') + ')';
const TYPES = ['default', 'image', 'video', 'page', 'text', 'blank', 'black', 'screen'];
const FITS = ['cover', 'contain', 'fill'];
const HEX = /^#[0-9a-fA-F]{3,8}$/;
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
const VIDEO_EXT = ['mp4', 'webm', 'mov'];
const UPLOAD_EXT = IMAGE_EXT.concat(VIDEO_EXT);

const MIME = {
  html: 'text/html; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

fs.mkdirSync(MEDIA_DIR, { recursive: true });

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function writeJsonFile(file, obj) {
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    console.error('Failed to save ' + path.basename(file) + ':', e.message);
  }
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

// ---------- state ----------

// Program fields (type/src/loop/audio/fit/bg/text) are what the display renders.
// takeId changes on every take so the display restarts media even when the same file is
// taken again; partial updates (fit, bg, loop, audio) keep it.
let state = {
  type: 'default',
  src: '',
  loop: true,
  audio: false, // on-air video plays its sound; everything else, and the default loop, is silent
  fit: 'cover',
  bg: '#000000',
  text: '',
  default: { type: 'video', src: '' },
  takeId: 0,
  transition: 600, // ms dissolve used for the last take
  startedAt: Date.now(),
  onAir: null, // { id, label, rid, duration, autoNext, notes } for the program item
  preview: null, // full item cued in preview
  autoMs: 600, // AUTO transition length
  aspect: '', // shape of the physical wall as 'W:H' ('' = 16:9, the OBS source's own shape)
  changed: Date.now(),
};

try { state = Object.assign(state, readJsonFile(STATE_FILE)); } catch (e) { /* no saved state yet */ }
if (!state.default || typeof state.default !== 'object') state.default = { type: 'video', src: '' };
if (typeof state.takeId !== 'number') state.takeId = 0;
if (typeof state.autoMs !== 'number') state.autoMs = 600;
if (typeof state.aspect !== 'string') state.aspect = '';

// The wall's shape as 'W:H', e.g. '12:11'. Returns it tidied, '' for 16:9, or null if invalid.
function parseAspect(v) {
  if (!v) return '';
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(v));
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (!(w > 0 && h > 0 && w / h >= 0.2 && w / h <= 5)) return null;
  return Math.abs(w / h - 16 / 9) < 0.001 ? '' : w + ':' + h;
}

const clients = new Map(); // SSE response -> role ('display', 'preview', 'control', 'other')
const peers = new Map(); // page id -> its SSE response, for screen-share setup messages meant for that page only

function broadcast(event, data) {
  const msg = (event ? 'event: ' + event + '\n' : '') + 'data: ' + data + '\n\n';
  for (const res of clients.keys()) res.write(msg);
}

// The display reloads itself when its page (or the screen-share script it loads) changes, so
// OBS never needs a manual refresh.
const DISPLAY_FILES = ['display.html', 'screen.js'];
let displayHash = { mtime: '', hash: '' };
function displayVersion() {
  try {
    const files = DISPLAY_FILES.map((f) => path.join(PUBLIC_DIR, f));
    const mtime = files.map((f) => fs.statSync(f).mtimeMs).join('|');
    if (mtime !== displayHash.mtime) displayHash = { mtime, hash: hashOf(Buffer.concat(files.map((f) => fs.readFileSync(f)))) };
  } catch (e) { /* keep last */ }
  return displayHash.hash;
}
function hashOf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

function payload() {
  return JSON.stringify(Object.assign({}, state, { now: Date.now(), displayVersion: displayVersion(), shares: shareList() }));
}

// The change goes out to the display and control pages first, so a take never waits on the
// disk (a synchronous write can stall for a while when antivirus scans the file); state.json
// is saved straight after, once for a run of changes.
let saveQueued = false;
function commit(patch) {
  state = Object.assign({}, state, patch, { changed: Date.now() });
  broadcast(null, payload());
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => { saveQueued = false; writeJsonFile(STATE_FILE, state); });
}

// ---------- rundowns ----------

let rundowns = { active: '', list: [] };
try {
  const saved = readJsonFile(RUNDOWN_FILE);
  if (saved && Array.isArray(saved.list)) rundowns = saved;
} catch (e) { /* none yet */ }
rundowns.list = rundowns.list
  .filter((r) => r && typeof r.id === 'string')
  .map((r) => ({ id: r.id, name: String(r.name || 'Rundown'), items: Array.isArray(r.items) ? r.items : [] }));
if (!rundowns.list.length) rundowns.list.push({ id: newId(), name: 'Show 1', items: [] });
if (!rundowns.list.some((r) => r.id === rundowns.active)) rundowns.active = rundowns.list[0].id;

function activeRundown() {
  return rundowns.list.find((r) => r.id === rundowns.active) || rundowns.list[0];
}

function saveRundowns() {
  writeJsonFile(RUNDOWN_FILE, rundowns);
  // A ping only: rundowns are fetched with the key, not pushed down the public event stream.
  broadcast('rundowns', '{}');
}

function rundownAction(body) {
  const find = (id) => rundowns.list.find((r) => r.id === id);
  switch (body.action) {
    case 'create': {
      const r = { id: newId(), name: String(body.name || 'New rundown').slice(0, 100), items: [] };
      rundowns.list.push(r);
      rundowns.active = r.id;
      break;
    }
    case 'rename': {
      const r = find(body.id);
      if (!r) return 'Rundown not found';
      if (body.name) r.name = String(body.name).slice(0, 100);
      break;
    }
    case 'delete': {
      if (rundowns.list.length < 2) return 'Keep at least one rundown';
      const i = rundowns.list.findIndex((r) => r.id === body.id);
      if (i < 0) return 'Rundown not found';
      rundowns.list.splice(i, 1);
      if (rundowns.active === body.id) rundowns.active = rundowns.list[0].id;
      break;
    }
    case 'activate': {
      if (!find(body.id)) return 'Rundown not found';
      rundowns.active = body.id;
      break;
    }
    case 'save': {
      const r = find(body.id);
      if (!r) return 'Rundown not found';
      if (!Array.isArray(body.items)) return 'items must be an array';
      if (body.items.length > 1000) return 'Too many items';
      const items = [];
      const seen = new Set();
      for (const raw of body.items) {
        const { item, error } = normalizeItem(raw);
        if (error) return 'Row ' + (items.length + 1) + ': ' + error;
        delete item.rid;
        if (seen.has(item.id)) item.id = newId();
        seen.add(item.id);
        items.push(item);
      }
      r.items = items;
      break;
    }
    default:
      return 'Unknown action';
  }
  saveRundowns();
  if (body.action === 'save') syncFromRundown();
  return null;
}

// Edits to a row apply straight away to its copy in Preview, and to the item on air
// (hold time, auto-follow, label, notes, loop and sound).
function syncFromRundown() {
  const rows = activeRundown().items;
  const byId = (id) => rows.find((r) => r.id === id);
  const patch = {};
  let reschedule = false;
  const pv = state.preview;
  if (pv && pv.rid) {
    const row = byId(pv.rid);
    if (row) {
      const cue = cueFromRow(row);
      if (JSON.stringify(cue) !== JSON.stringify(pv)) patch.preview = cue;
    }
  }
  const a = state.onAir;
  const row = a && a.rid ? byId(a.rid) : null;
  if (row) {
    const next = Object.assign({}, a, { label: row.label || '', duration: row.duration || 0, autoNext: !!row.autoNext, notes: row.notes || '' });
    if (JSON.stringify(next) !== JSON.stringify(a)) {
      patch.onAir = next;
      reschedule = next.duration !== a.duration;
    }
    if (state.type === 'video' && row.type === 'video' && row.src === state.src && (row.loop !== false) !== state.loop) {
      patch.loop = row.loop !== false;
    }
    const sameItem = state.type === row.type && (row.type === 'screen' || (row.type === 'video' && row.src === state.src));
    if (sameItem && hasSound(row.type) && !!row.audio !== !!state.audio) {
      patch.audio = !!row.audio;
    }
  }
  if (Object.keys(patch).length) {
    commit(patch);
    if (reschedule) scheduleEnd(false);
  }
}

// ---------- as-run log ----------

const asrun = []; // recent entries for the control page; asrun.csv keeps everything
let asrunHasHeader = fs.existsSync(ASRUN_FILE);

function csvCell(v) {
  let s = String(v === undefined || v === null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // keep spreadsheet apps from running it as a formula
  return '"' + s.replace(/"/g, '""') + '"';
}

function logAsRun(action, item) {
  const entry = { at: Date.now(), action, type: item.type, label: itemLabel(item), src: item.src || '' };
  asrun.push(entry);
  if (asrun.length > 200) asrun.shift();
  let line = [new Date(entry.at).toISOString(), action, entry.type, entry.label, entry.src].map(csvCell).join(',') + '\n';
  if (!asrunHasHeader) { line = 'time,action,type,label,src\n' + line; asrunHasHeader = true; }
  fs.appendFile(ASRUN_FILE, line, (err) => { if (err) console.error('Failed to write as-run log:', err.message); });
  broadcast('asrun', JSON.stringify(entry));
}

// ---------- helpers ----------

function ext(name) {
  return path.extname(name).slice(1).toLowerCase();
}

function mediaKind(name) {
  const e = ext(name);
  if (IMAGE_EXT.includes(e)) return 'image';
  if (VIDEO_EXT.includes(e)) return 'video';
  return null;
}

// Every filename from a request goes through basename, so nothing outside media/ is reachable.
function safeName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return '';
  return base;
}

// "/media/foo.mp4" -> "foo.mp4" (only for local media srcs)
function mediaNameFromSrc(src) {
  if (typeof src !== 'string' || !src.startsWith('/media/')) return '';
  try { return safeName(decodeURIComponent(src.slice(7))); } catch (e) { return ''; }
}

function mediaSrc(name) {
  return '/media/' + encodeURIComponent(name);
}

// Items that can play sound on the wall (muted unless their audio flag is set).
function hasSound(type) { return type === 'video' || type === 'screen'; }

function isFalse(v) { return v === false || v === 'false' || v === 0 || v === '0'; }
function isTrue(v) { return v === true || v === 'true' || v === 1 || v === '1'; }

function send(res, status, body, headers) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, Object.assign({
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(data);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function authorized(req, url) {
  if (!CONTROL_KEY) return true;
  return url.searchParams.get('key') === CONTROL_KEY || req.headers['x-key'] === CONTROL_KEY;
}

function uniqueName(name) {
  const e = path.extname(name);
  const stem = name.slice(0, name.length - e.length);
  let candidate = name;
  let n = 2;
  while (fs.existsSync(path.join(MEDIA_DIR, candidate))) {
    candidate = `${stem}-${n}${e}`;
    n++;
  }
  return candidate;
}

// ---------- items ----------

function normalizePageUrl(src) {
  let s = src.trim();
  if (!/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !s.startsWith('/')) s = (/^(localhost|[\d.]+)(:|\/|$)/i.test(s) ? 'http://' : 'https://') + s; // "example.com" -> https://example.com
  if (!/^https?:\/\//i.test(s) && !s.startsWith('/')) return null; // no javascript:, data:, file: etc.
  return s;
}

// Anything that can go on air: a rundown row, a library file, a Stream Deck URL.
// Returns { item } or { error }.
function normalizeItem(input) {
  if (!input || typeof input !== 'object') return { error: 'item required' };
  if (!TYPES.includes(input.type)) return { error: 'type must be one of: ' + TYPES.join(', ') };
  const item = { id: typeof input.id === 'string' && input.id ? input.id.slice(0, 64) : newId(), type: input.type };
  if (['image', 'video', 'page'].includes(item.type)) {
    let src = String(input.src || '').trim();
    if (!src) return { error: `type "${item.type}" requires src` };
    if (item.type === 'page') {
      src = normalizePageUrl(src);
      if (!src) return { error: 'page src must be an http(s) URL' };
    }
    item.src = src.slice(0, 4096);
  }
  // A screen share names the share it shows; without one it shows whichever share started last.
  if (item.type === 'screen' && input.src) item.src = String(input.src).slice(0, 64);
  if (item.type === 'text') item.text = String(input.text || '').slice(0, 5000);
  if (item.type === 'video') item.loop = !isFalse(input.loop);
  if (hasSound(item.type) && isTrue(input.audio)) item.audio = true;
  if (input.fit) {
    if (!FITS.includes(input.fit)) return { error: 'fit must be one of: ' + FITS.join(', ') };
    item.fit = input.fit;
  }
  if (input.bg) {
    if (!HEX.test(String(input.bg))) return { error: 'bg must be a hex colour like #000000' };
    item.bg = String(input.bg);
  }
  if (input.duration !== undefined && input.duration !== null && input.duration !== '') {
    const d = Number(input.duration);
    if (!isFinite(d) || d < 0 || d > 86400) return { error: 'duration must be seconds (0 to 86400)' };
    if (d > 0) item.duration = d;
  }
  if (isTrue(input.autoNext)) item.autoNext = true;
  if (input.label) item.label = String(input.label).slice(0, 200);
  if (input.notes) item.notes = String(input.notes).slice(0, 1000);
  if (input.rid) item.rid = String(input.rid).slice(0, 64);
  return { item };
}

const TYPE_NAMES = { default: 'Default loop', blank: 'Blank', black: 'Black' };
function itemLabel(it) {
  if (it.label) return it.label;
  if (it.type === 'text') return (it.text || '').replace(/\s+/g, ' ').slice(0, 60) || 'Text';
  if (it.type === 'screen') return 'Screen: ' + (shares.has(it.src) ? shares.get(it.src).name : 'any share');
  if (it.src) return mediaNameFromSrc(it.src) || it.src;
  return TYPE_NAMES[it.type] || it.type;
}

// ?file= / ?page= / ?url=&type= / ?text= / ?type=, plus loop, audio, fit, bg, duration, autoNext, label.
function itemFromQuery(q) {
  const input = {};
  if (q.has('file')) {
    const name = safeName(q.get('file'));
    const kind = mediaKind(name);
    if (!name || !kind) return { error: 'Bad file', status: 400 };
    if (!fs.existsSync(path.join(MEDIA_DIR, name))) return { error: 'File not found: ' + name, status: 404 };
    input.type = kind;
    input.src = mediaSrc(name);
  } else if (q.has('page')) {
    input.type = 'page';
    input.src = q.get('page');
  } else if (q.has('url')) {
    input.src = q.get('url');
    input.type = q.get('type') || 'page';
  } else if (q.has('text')) {
    input.type = 'text';
    input.text = q.get('text');
  } else if (q.has('type')) {
    input.type = q.get('type');
  }
  for (const k of ['loop', 'audio', 'fit', 'bg', 'duration', 'autoNext', 'label']) if (q.has(k)) input[k] = q.get(k);
  return { input };
}

// ---------- screen shares ----------

// A /share page captures a screen in its browser and streams it straight to each page that
// shows it (the OBS display and the control page's monitors) over WebRTC. The video never
// passes through this server: it only relays the few setup messages, over the sharer's command
// socket one way and the viewer's event stream and /api/rtc the other.
const shares = new Map(); // id -> { id, name, socket, since, endTimer }
const SHARE_ID = /^[a-z0-9]{8,40}$/i;
const SHARE_GRACE = 8000; // a sharer whose socket drops has this long to come back

function shareList() {
  return Array.from(shares.values()).map((s) => ({ id: s.id, name: s.name, live: !!s.socket, since: s.since }));
}

function latestShare() {
  let best = null;
  for (const s of shares.values()) if (s.socket && (!best || s.since > best.since)) best = s;
  return best;
}

// A screen item without a live share gets the latest one, if any.
function withShare(item) {
  if (!item || item.type !== 'screen' || shares.has(item.src)) return item;
  const s = latestShare();
  return s ? Object.assign({}, item, { src: s.id }) : item;
}

// Pages that may watch a share without the key: only while it is on air or cued, as
// /display shows what's on air (and preloads what's cued) to anyone anyway.
function shareInUse(id) {
  return (state.type === 'screen' && state.src === id)
    || (!!state.preview && state.preview.type === 'screen' && state.preview.src === id);
}

function toPeer(peer, msg) {
  const res = peers.get(peer);
  if (res) res.write('event: rtc\ndata: ' + JSON.stringify(msg) + '\n\n');
}

function shareStarted(socket, msg) {
  if (!SHARE_ID.test(String(msg.id))) return;
  const name = String(msg.name || '').trim().slice(0, 60) || 'Screen';
  let s = shares.get(msg.id);
  if (s) {
    clearTimeout(s.endTimer);
    if (s.socket && s.socket !== socket) s.socket.shareId = null;
    Object.assign(s, { name, socket });
  } else {
    s = { id: msg.id, name, socket, since: Date.now(), endTimer: null };
    shares.set(s.id, s);
  }
  if (socket.shareId && socket.shareId !== s.id) endShare(socket.shareId);
  socket.shareId = s.id;
  wsSend(socket, { type: 'share-ok', id: s.id });
  // A cued screen item that had no share to show now has one.
  const pv = state.preview;
  if (pv && pv.type === 'screen' && !shares.has(pv.src)) commit({ preview: withShare(Object.assign({}, pv, { src: '' })) });
  else broadcast(null, payload());
}

function shareSocketClosed(socket) {
  const s = shares.get(socket.shareId);
  if (!s || s.socket !== socket) return;
  s.socket = null;
  s.endTimer = setTimeout(() => endShare(s.id), SHARE_GRACE);
  broadcast(null, payload());
}

function endShare(id) {
  const s = shares.get(id);
  if (!s) return;
  clearTimeout(s.endTimer);
  shares.delete(id);
  shareStats.delete(id);
  if (s.socket) s.socket.shareId = null;
  const patch = {};
  const pv = state.preview;
  if (pv && pv.type === 'screen' && pv.src === id) {
    const row = pv.rid ? activeRundown().items.find((r) => r.id === pv.rid) : null;
    patch.preview = row ? cueFromRow(row) : null;
  }
  if (state.type === 'screen' && state.src === id) takeItem({ type: 'default' }, state.autoMs, 'SHARE ENDED', patch);
  else if (Object.keys(patch).length) commit(patch);
  else broadcast(null, payload());
}

// A program share whose sharer never came back after a server restart.
setTimeout(() => {
  if (state.type === 'screen' && !shares.has(state.src)) takeItem({ type: 'default' }, state.autoMs, 'SHARE ENDED');
}, 15000).unref();

// From a sharer's command socket.
function onShareMessage(socket, msg) {
  if (msg.type === 'share') return shareStarted(socket, msg);
  if (msg.type === 'share-stop') return socket.shareId && endShare(socket.shareId);
  if (msg.type === 'rtc' && socket.shareId && typeof msg.peer === 'string' && msg.kind === 'offer') {
    toPeer(msg.peer, { share: socket.shareId, kind: 'offer', sdp: msg.sdp });
  }
  if (msg.type === 'share-stats' && socket.shareId) noteStats(socket.shareId, 'sender', msg.stats);
}

// ---------- screen share stats ----------

// Both ends of each OBS connection report what they actually do (the sharer: captured and sent
// frames; the OBS display: received, decoded and shown frames), so the control panel can show
// where a share loses frames or quality. Relayed and kept briefly, never saved.
const shareStats = new Map(); // share id -> { sender, display, at }

function cleanStats(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj).slice(0, 40)) {
    if (typeof v === 'number' && isFinite(v)) out[k.slice(0, 40)] = v;
    else if (typeof v === 'string' || typeof v === 'boolean') out[k.slice(0, 40)] = typeof v === 'string' ? v.slice(0, 80) : v;
  }
  return out;
}

function noteStats(id, from, stats) {
  if (!shares.has(id)) return;
  const entry = shareStats.get(id) || {};
  entry[from] = Object.assign(cleanStats(stats), { at: Date.now() });
  shareStats.set(id, entry);
  broadcast('rtcstats', JSON.stringify({ share: id, from, stats: entry[from] }));
}

// From a viewer: hello (send me an offer), answer, bye.
function onViewerSignal(req, url, body) {
  const s = shares.get(body.share);
  const peer = String(body.peer || '');
  if (body.kind === 'hello' && !authorized(req, url) && !(s && shareInUse(s.id))) return [403, { error: 'Not on air' }];
  if (!s || !s.socket) return [404, { error: 'Share not live' }];
  if (!peers.has(peer)) return [409, { error: 'Unknown page' }];
  if (body.kind === 'hello') {
    wsSend(s.socket, { type: 'rtc', kind: 'hello', peer, role: body.role === 'display' ? 'display' : 'preview' });
  } else if (body.kind === 'answer' || body.kind === 'bye') {
    wsSend(s.socket, { type: 'rtc', kind: body.kind, peer, sdp: body.sdp });
  } else return [400, { error: 'Bad kind' }];
  return [200, { ok: true }];
}

// ---------- switching ----------

let endTimer = null;

// Put an item on air.
function takeItem(item, ms, action, extra) {
  if (item.type === 'screen') {
    item = withShare(item);
    if (!shares.has(item.src)) item = { type: 'default' }; // its share has ended
  }
  const patch = Object.assign({
    type: item.type,
    src: item.src || '',
    text: item.text || '',
    loop: item.type === 'video' ? item.loop !== false : true,
    audio: hasSound(item.type) && !!item.audio,
    takeId: state.takeId + 1,
    transition: ms,
    startedAt: Date.now(),
    onAir: {
      id: item.id || newId(), label: item.label || '', rid: item.rid || '',
      duration: item.duration || 0, autoNext: !!item.autoNext, notes: item.notes || '',
    },
    ftb: null, // set only by FTB: what to fade back up to
  }, extra || {});
  if (item.fit) patch.fit = item.fit;
  if (item.bg) patch.bg = item.bg;
  commit(patch);
  logAsRun(action, item);
  scheduleEnd(false);
}

function programAsItem() {
  const it = { id: newId(), type: state.type, fit: state.fit, bg: state.bg };
  if (state.src) it.src = state.src;
  if (state.type === 'text') it.text = state.text;
  if (state.type === 'video') it.loop = state.loop;
  if (hasSound(state.type) && state.audio) it.audio = true;
  const a = state.onAir;
  if (a) {
    if (a.id) it.id = a.id;
    if (a.label) it.label = a.label;
    if (a.rid) it.rid = a.rid;
    if (a.duration) it.duration = a.duration;
    if (a.autoNext) it.autoNext = true;
    if (a.notes) it.notes = a.notes;
  }
  return it;
}

function cueFromRow(row) {
  return withShare(Object.assign({}, row, { rid: row.id }));
}

function neighbour(rid, dir) {
  const items = activeRundown().items;
  const i = items.findIndex((r) => r.id === rid);
  const row = i < 0 ? null : items[i + dir];
  return row ? cueFromRow(row) : null;
}

function takePreview(how, action) {
  const item = state.preview;
  if (!item) return 'Nothing in preview';
  if (item.type === 'screen' && !shares.has(withShare(item).src)) return 'No screen is being shared';
  // Rundown items roll the preview on to the next row; anything else swaps with what was on air.
  const next = item.rid ? neighbour(item.rid, 1) : programAsItem();
  takeItem(item, how === 'cut' ? 0 : state.autoMs, action, { preview: next });
  return null;
}

function cueStep(dir) {
  const items = activeRundown().items;
  if (!items.length) return 'Rundown is empty';
  const ref = (state.preview && state.preview.rid) || (state.onAir && state.onAir.rid);
  const i = ref ? items.findIndex((r) => r.id === ref) : -1;
  const t = i < 0 ? (dir > 0 ? 0 : items.length - 1) : i + dir;
  if (t < 0 || t >= items.length) return dir > 0 ? 'End of rundown' : 'Start of rundown';
  commit({ preview: cueFromRow(items[t]) });
  return null;
}

function cueRow(n) {
  const items = activeRundown().items;
  if (!(n >= 1 && n <= items.length)) return 'No rundown row ' + n;
  commit({ preview: cueFromRow(items[n - 1]) });
  return null;
}

// The program item finished: a play-once video ended, or its duration ran out.
function endProgram() {
  clearTimeout(endTimer);
  if (state.onAir && state.onAir.autoNext && state.preview) takePreview('mix', 'AUTO-FOLLOW');
  else takeItem({ type: 'default' }, state.autoMs, 'END');
}

function scheduleEnd(onStartup) {
  clearTimeout(endTimer);
  endTimer = null;
  const d = state.onAir && state.onAir.duration;
  if (!d) return;
  const left = state.startedAt + d * 1000 - Date.now();
  if (onStartup && left <= 0) return; // don't yank the wall straight after a restart
  const takeId = state.takeId;
  endTimer = setTimeout(() => { if (state.takeId === takeId) endProgram(); }, Math.max(0, left));
}

// Stream Deck / legacy "put this on air now". Partial updates (fit, bg, loop, audio) change the program in place.
function applyShow(input) {
  const hasType = input.type !== undefined && input.type !== null && input.type !== '';
  if (hasType || input.src !== undefined || input.text !== undefined) {
    const full = Object.assign({}, input, {
      type: hasType ? input.type : state.type,
      src: input.src !== undefined ? input.src : (hasType ? '' : state.src),
      text: input.text !== undefined ? input.text : (hasType ? '' : state.text),
    });
    const { item, error } = normalizeItem(full);
    if (error) return error;
    if (item.type === 'screen' && !shares.has(withShare(item).src)) return 'No screen is being shared';
    takeItem(item, state.autoMs, 'PUNCH');
    return null;
  }
  const patch = {};
  if (input.fit !== undefined) {
    if (!FITS.includes(input.fit)) return 'fit must be one of: ' + FITS.join(', ');
    patch.fit = input.fit;
  }
  if (input.bg !== undefined) {
    if (!HEX.test(String(input.bg))) return 'bg must be a hex colour like #000000';
    patch.bg = String(input.bg);
  }
  if (input.loop !== undefined) patch.loop = state.type === 'video' ? !isFalse(input.loop) : true;
  if (input.audio !== undefined) patch.audio = hasSound(state.type) && isTrue(input.audio);
  if (!Object.keys(patch).length) return 'Nothing to change';
  commit(patch);
  return null;
}

function setPreview(input) {
  if (input.clear) { commit({ preview: null }); return null; }
  const { item, error } = normalizeItem(input.item || input);
  if (error) return error;
  commit({ preview: withShare(item) });
  return null;
}

function setDefault(src) {
  if (!src) {
    commit({ default: { type: 'video', src: '' } });
    return null;
  }
  const name = mediaNameFromSrc(src) || safeName(src);
  if (!name) return 'src must be a file in media/';
  const kind = mediaKind(name);
  if (!kind) return 'default must be an image or video';
  if (!fs.existsSync(path.join(MEDIA_DIR, name))) return 'file not found in media/: ' + name;
  commit({ default: { type: kind, src: mediaSrc(name) } });
  return null;
}

// ---------- handlers ----------

function serveStatic(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) return send(res, 500, 'Missing ' + file);
    if (file === 'display.html') data = data.toString('utf8').replace('__DISPLAY_VERSION__', displayVersion());
    send(res, 200, data, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : MIME.html });
  });
}

function displayCount() {
  let n = 0;
  for (const role of clients.values()) if (role === 'display') n++;
  return n;
}

function sendHealth() {
  broadcast('health', JSON.stringify({ displays: displayCount() }));
}

function handleEvents(req, res, url) {
  const role = ['display', 'preview', 'control'].includes(url.searchParams.get('role')) ? url.searchParams.get('role') : 'other';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write('data: ' + payload() + '\n\n');
  clients.set(res, role);
  const peer = url.searchParams.get('peer') || '';
  if (SHARE_ID.test(peer)) peers.set(peer, res);
  sendHealth();
  // A screen share already streaming to this page carries on through a reconnect: the video
  // doesn't come through here, and the sharer drops it by itself if the page has gone.
  req.on('close', () => {
    clients.delete(res);
    if (peers.get(peer) === res) peers.delete(peer);
    sendHealth();
  });
}

setInterval(() => {
  for (const res of clients.keys()) res.write(': keep-alive\n\n');
}, 20000).unref();

function handleMedia(req, res, rawName) {
  let decoded;
  try { decoded = decodeURIComponent(rawName); } catch (e) { return send(res, 400, 'Bad name'); }
  const name = safeName(decoded);
  if (!name || name !== decoded) return send(res, 400, 'Bad name');
  const file = path.join(MEDIA_DIR, name);

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    const type = MIME[ext(name)] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
    };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start, end;
      if (m) {
        if (m[1] === '' && m[2] !== '') { // suffix range: last N bytes
          start = Math.max(0, st.size - parseInt(m[2], 10));
          end = st.size - 1;
        } else {
          start = parseInt(m[1], 10);
          end = m[2] === '' ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
        }
      }
      if (!m || isNaN(start) || isNaN(end) || start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    }
  });
}

function listMedia() {
  const defName = mediaNameFromSrc(state.default && state.default.src);
  return fs.readdirSync(MEDIA_DIR)
    .filter((n) => !n.startsWith('.') && mediaKind(n))
    .map((name) => {
      const st = fs.statSync(path.join(MEDIA_DIR, name));
      return {
        name,
        type: mediaKind(name),
        src: mediaSrc(name),
        size: st.size,
        mtime: st.mtimeMs,
        isDefault: name === defName,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function handleUpload(req, res) {
  let raw = req.headers['x-filename'] || '';
  try { raw = decodeURIComponent(raw); } catch (e) { return send(res, 400, { error: 'Bad X-Filename' }); }
  let name = safeName(raw).replace(/[<>:"|?*\x00-\x1f]/g, '_');
  if (!name) return send(res, 400, { error: 'Missing or invalid X-Filename header' });
  if (!UPLOAD_EXT.includes(ext(name))) {
    return send(res, 400, { error: 'Allowed types: ' + UPLOAD_EXT.join(', ') });
  }
  const declared = parseInt(req.headers['content-length'], 10);
  if (declared > MAX_UPLOAD) return send(res, 413, { error: TOO_LARGE });

  const tmp = path.join(MEDIA_DIR, `.upload-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let failed = false;

  const fail = (status, msg) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    fs.unlink(tmp, () => {});
    if (!res.headersSent) send(res, status, { error: msg });
    req.resume();
  };

  req.on('data', (c) => {
    received += c.length;
    if (received > MAX_UPLOAD) fail(413, TOO_LARGE);
  });
  req.on('aborted', () => fail(400, 'Upload aborted'));
  out.on('error', (e) => fail(500, 'Write failed: ' + e.message));
  out.on('finish', () => {
    if (failed) return;
    name = uniqueName(name);
    fs.rename(tmp, path.join(MEDIA_DIR, name), (err) => {
      if (err) { fs.unlink(tmp, () => {}); return send(res, 500, { error: err.message }); }
      broadcast('media', JSON.stringify({ added: mediaSrc(name) }));
      send(res, 200, { ok: true, name, src: mediaSrc(name), type: mediaKind(name), size: received });
    });
  });
  req.pipe(out);
}

function handleDelete(res, url) {
  const name = safeName(url.searchParams.get('name'));
  if (!name || name !== url.searchParams.get('name')) return send(res, 400, { error: 'Bad name' });
  const file = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
  try { fs.unlinkSync(file); } catch (e) { return send(res, 500, { error: e.message }); }

  const patch = {};
  if (state.preview && mediaNameFromSrc(state.preview.src) === name) patch.preview = null;
  if (mediaNameFromSrc(state.default && state.default.src) === name) patch.default = { type: 'video', src: '' };
  if (state.ftb && mediaNameFromSrc(state.ftb.src) === name) patch.ftb = null;
  if (Object.keys(patch).length) commit(patch);
  if (mediaNameFromSrc(state.src) === name && ['image', 'video'].includes(state.type)) {
    takeItem({ type: 'default' }, 0, 'DELETED');
  }
  // Names the file so displays drop their in-memory copy (it could be uploaded again by name).
  broadcast('media', JSON.stringify({ removed: mediaSrc(name) }));
  send(res, 200, { ok: true, state });
}

function handleAsrunCsv(res) {
  fs.stat(ASRUN_FILE, (err, st) => {
    const headers = {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="asrun.csv"',
      'Cache-Control': 'no-store',
    };
    if (err) { res.writeHead(200, headers); return res.end('time,action,type,label,src\n'); }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(ASRUN_FILE).pipe(res);
  });
}

// ---------- router ----------

const ACTIONS = {
  '/api/take': () => takePreview('cut', 'TAKE'),
  '/api/auto': () => takePreview('mix', 'AUTO'),
  // One press fades to black; pressed again while black, it fades back up to what was on air.
  '/api/ftb': () => {
    if (state.ftb && state.type === 'black') takeItem(state.ftb, state.autoMs, 'FTB UP');
    else takeItem({ type: 'black' }, state.autoMs, 'FTB', { ftb: programAsItem() });
    return null;
  },
  '/api/safe': () => { takeItem({ type: 'default' }, state.autoMs, 'SAFE'); return null; },
  '/api/next': () => cueStep(1),
  '/api/prev': () => cueStep(-1),
};

// A switcher press that arrives this late was held up on the way (see the command socket
// below) and is ignored: firing it now would put the wrong thing on air.
const MAX_COMMAND_AGE = 1500;

// Switcher commands from the control page, over HTTP POST or the command socket.
// sentAt is the control page's estimate of server time when it was pressed. Returns [status, body].
function command(p, body, sentAt) {
  const late = typeof sentAt === 'number' && isFinite(sentAt) ? Date.now() - sentAt : 0;
  if (late > MAX_COMMAND_AGE) {
    return [409, { error: 'That press reached the server ' + (late / 1000).toFixed(1) + 's late, so it was ignored. Press again.' }];
  }
  let err;
  if (ACTIONS[p]) err = ACTIONS[p]();
  else if (p === '/api/preview') err = setPreview(body);
  else if (p === '/api/show') err = applyShow(body);
  else if (p === '/api/settings') {
    const patch = {};
    if (body.autoMs !== undefined) {
      const ms = Number(body.autoMs);
      if (!isFinite(ms) || ms < 0 || ms > 10000) err = 'autoMs must be 0 to 10000';
      else patch.autoMs = Math.round(ms);
    }
    if (body.aspect !== undefined) {
      const a = parseAspect(body.aspect);
      if (a === null) err = 'aspect must be width:height, like 12:11';
      else patch.aspect = a;
    }
    if (!err) commit(patch);
  } else return [404, { error: 'Not found' }];
  return err ? [ACTIONS[p] ? 409 : 400, { error: err }] : [200, state];
}
const COMMANDS = new Set(Object.keys(ACTIONS).concat(['/api/preview', '/api/show', '/api/settings']));

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, 'Bad URL'); }
  const p = url.pathname;
  const m = req.method;

  try {
    // Public routes
    if (p === '/' && m === 'GET') {
      res.writeHead(302, { Location: '/control' + url.search });
      return res.end();
    }
    if (p === '/display' && m === 'GET') return serveStatic(res, 'display.html');
    if (p === '/screen.js' && m === 'GET') return serveStatic(res, 'screen.js');
    if (p === '/api/rtcstats' && m === 'POST') {
      const body = await readJson(req, 16 * 1024);
      // Only the OBS display's report is kept; previews receive a deliberately small copy.
      if (body.role === 'display' && Array.isArray(body.stats)) body.stats.slice(0, 8).forEach((s) => s && noteStats(String(s.share), 'display', s));
      return send(res, 204, '');
    }
    if (p === '/api/rtc' && m === 'POST') {
      const [status, body] = onViewerSignal(req, url, await readJson(req, 64 * 1024));
      return send(res, status, body);
    }
    if (p === '/events' && m === 'GET') return handleEvents(req, res, url);
    if (p === '/api/state' && m === 'GET') return send(res, 200, state);
    if (p.startsWith('/media/') && (m === 'GET' || m === 'HEAD')) return handleMedia(req, res, p.slice(7));
    if (p === '/api/ended' && m === 'POST') {
      const body = await readJson(req, 4096);
      // takeId is what current displays send; older cached displays only send changed.
      const same = body.takeId !== undefined ? body.takeId === state.takeId : body.changed === state.changed;
      if (same && state.type === 'video' && state.loop === false) {
        endProgram();
        return send(res, 200, { ok: true, switched: true });
      }
      return send(res, 200, { ok: true, switched: false });
    }
    // The OBS display reports playback position and media errors; previews and the control page follow it.
    // Relayed only, never saved.
    if (p === '/api/position' && m === 'POST') {
      const body = await readJson(req, 4096);
      if (typeof body.src === 'string') {
        const out = { src: body.src.slice(0, 2048) };
        if (typeof body.t === 'number' && isFinite(body.t)) out.t = body.t;
        if (typeof body.d === 'number' && isFinite(body.d)) out.d = body.d;
        if (typeof body.err === 'string') out.err = body.err.slice(0, 200);
        if (out.t !== undefined || out.err) broadcast('pos', JSON.stringify(out));
      }
      return send(res, 204, '');
    }

    // Everything below needs the key (if set)
    const isProtected = p === '/control' || p === '/share' || p.startsWith('/api/');
    if (!isProtected) return send(res, 404, 'Not found');
    if (!authorized(req, url)) return send(res, 401, { error: 'Unauthorized' });

    if (p === '/control' && m === 'GET') return serveStatic(res, 'control.html');
    if (p === '/share' && m === 'GET') return serveStatic(res, 'share.html');

    if (p === '/api/info' && m === 'GET') {
      if (PUBLIC_URL) return send(res, 200, { displayUrl: PUBLIC_URL + '/display', lanDisplayUrls: [] });
      return send(res, 200, { displayUrl: `http://localhost:${PORT}/display`, lanDisplayUrls: lanHosts().map((h) => `http://${h}:${PORT}/display`) });
    }
    if (p === '/api/media' && m === 'GET') return send(res, 200, listMedia());
    if (p === '/api/media' && m === 'DELETE') return handleDelete(res, url);
    if (p === '/api/upload' && m === 'POST') return handleUpload(req, res);

    // Switcher actions: GET for Stream Deck buttons, POST for the control page.
    if (ACTIONS[p] && m === 'GET') {
      const err = ACTIONS[p]();
      return err ? send(res, 409, { error: err }) : send(res, 200, state);
    }
    if (COMMANDS.has(p) && m === 'POST') {
      const sentAt = req.headers['x-sent-at'] ? Number(req.headers['x-sent-at']) : undefined;
      const [status, body] = command(p, ACTIONS[p] ? {} : await readJson(req), sentAt);
      return send(res, status, body);
    }
    if (p === '/api/cue' && (m === 'GET' || m === 'POST')) {
      const err = cueRow(parseInt(url.searchParams.get('n'), 10));
      return err ? send(res, 409, { error: err }) : send(res, 200, state);
    }
    if (p === '/api/preview' && m === 'GET') {
      const q = itemFromQuery(url.searchParams);
      if (q.error) return send(res, q.status, { error: q.error });
      const err = setPreview(q.input);
      return err ? send(res, 400, { error: err }) : send(res, 200, state);
    }
    if (p === '/api/rundowns' && m === 'GET') return send(res, 200, rundowns);
    if (p === '/api/rundowns' && m === 'POST') {
      const err = rundownAction(await readJson(req));
      return err ? send(res, 400, { error: err }) : send(res, 200, rundowns);
    }

    if (p === '/api/asrun' && m === 'GET') return send(res, 200, asrun);
    if (p === '/api/rtcstats' && m === 'GET') return send(res, 200, Object.fromEntries(shareStats));
    if (p === '/api/asrun.csv' && m === 'GET') return handleAsrunCsv(res);

    if (p === '/api/show' && m === 'GET') {
      const q = itemFromQuery(url.searchParams);
      if (q.error) return send(res, q.status, { error: q.error });
      const err = applyShow(q.input);
      return err ? send(res, 400, { error: err }) : send(res, 200, state);
    }

    if (p === '/api/default' && m === 'POST') {
      const body = await readJson(req);
      const err = setDefault(body.src || '');
      return err ? send(res, 400, { error: err }) : send(res, 200, state);
    }
    if (p === '/api/default' && m === 'GET') {
      const file = url.searchParams.get('file') || '';
      const err = setDefault(file ? mediaSrc(safeName(file)) : '');
      return err ? send(res, 400, { error: err }) : send(res, 200, state);
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) send(res, 400, { error: e.message });
  }
});

function lanHosts() {
  const hosts = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' || ni.family === 4) if (!ni.internal) hosts.push(ni.address);
    }
  }
  return hosts;
}

// ---------- command socket ----------

// The control page sends switcher commands over a WebSocket at /ws. A browser opens at most six
// HTTP connections to one server, and the monitors' videos and event streams can use all of them;
// a TAKE sent over HTTP then waits in the browser and arrives later together with every other
// press made meanwhile. WebSockets don't count towards that limit. Minimal RFC 6455: unfragmented
// text frames, ping and close, which is all a browser sends for messages this small.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_MESSAGE = 1024 * 1024;

function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function wsSend(socket, obj) {
  if (!socket.destroyed) socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(obj))));
}

function onWsMessage(socket, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  // The control page pings every couple of seconds: the reply proves the connection is alive,
  // and its server time lets the page stamp presses in server time (see command()).
  if (msg && msg.type === 'ping') return wsSend(socket, { type: 'pong', id: msg.id, now: Date.now() });
  if (msg && /^(share|share-stop|rtc|share-stats)$/.test(msg.type)) return onShareMessage(socket, msg);
  if (!msg || typeof msg.path !== 'string') return;
  let status, body;
  if (!COMMANDS.has(msg.path)) [status, body] = [404, { error: 'Not found' }];
  else {
    try { [status, body] = command(msg.path, msg.body && typeof msg.body === 'object' ? msg.body : {}, msg.at); }
    catch (e) { [status, body] = [400, { error: e.message }]; }
  }
  const reply = { id: msg.id, status };
  if (status !== 200) reply.error = body.error;
  wsSend(socket, reply);
}

server.on('upgrade', (req, socket) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return socket.destroy(); }
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  if (!authorized(req, url)) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 20000);
  socket.on('error', () => socket.destroy());
  socket.on('close', () => shareSocketClosed(socket));

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, opcode = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      // Browsers always mask and don't fragment messages this small; anything else isn't our page.
      if (!masked || !fin || len > WS_MAX_MESSAGE) return socket.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (opcode === 0x1) onWsMessage(socket, data.toString('utf8'));
      else if (opcode === 0x9) socket.write(wsFrame(0xA, data));
      else if (opcode === 0x8) return socket.end(wsFrame(0x8, Buffer.alloc(0)));
    }
  });
});

scheduleEnd(true);

server.requestTimeout = 0; // allow long uploads
server.listen(PORT, HOST, () => {
  const keyQs = CONTROL_KEY ? '?key=' + encodeURIComponent(CONTROL_KEY) : '';
  let bases = [`http://${HOST}:${PORT}`];
  if (PUBLIC_URL) bases = [PUBLIC_URL];
  else if (HOST === '0.0.0.0') bases = ['localhost'].concat(lanHosts()).map((h) => `http://${h}:${PORT}`);
  console.log('wall-screen running');
  console.log('\nDisplay (OBS browser source):');
  for (const b of bases) console.log(`  ${b}/display`);
  console.log('\nControl:');
  for (const b of bases) console.log(`  ${b}/control${keyQs}`);
  console.log(CONTROL_KEY ? '\nCONTROL_KEY is set.' : '\nCONTROL_KEY not set: control is open to anyone on the network.');
});
