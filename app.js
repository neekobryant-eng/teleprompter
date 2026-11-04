// Teleprompter — Phase 1 (core prompter). Plain JavaScript, no dependencies.
// See SPEC.md for the full plan. Sections below:
//   constants · utilities · storage · dialogs · router · library · editor
//   script parsing · prompter engine · gestures · keyboard · overlay · wake lock · init

/* ============================== Constants ============================== */

const BASE_WPM = 140;        // reading rate at 100% speed (words per minute)
const SPEED_STEP = 5;        // percent per tap / key press
const LONG_PRESS_MS = 550;
const DOUBLE_TAP_MS = 320;
const TAP_SLOP = 12;         // px a finger may move and still count as a tap
const SWIPE_MIN = 60;        // px of sideways travel for a two-finger swipe

const THEMES = ['dark', 'light', 'contrast'];
const MODES = ['full', 'rig'];   // Phase 3 adds 'strip' (near-camera)

// [min, max, step] for numeric settings; also drives the sliders.
const RANGES = {
  speed: [10, 300, SPEED_STEP],
  fontSize: [24, 160, 2],
  lineHeight: [1, 2.4, 0.05],
  margin: [0, 30, 1],
  readingLine: [10, 80, 1],
};

const DEFAULT_SETTINGS = Object.freeze({
  speed: 100,
  fontSize: 56,
  lineHeight: 1.4,
  margin: 8,
  readingLine: 33,
  theme: 'dark',
  prevTheme: 'dark',   // theme to return to when leaving rig mode
  mode: 'full',
  mirrorH: false,
  mirrorV: false,
  countdown: true,
});

const FORMAT = {
  speed: v => `${v}%`,
  fontSize: v => `${v}px`,
  lineHeight: v => Number(v).toFixed(2),
  margin: v => `${v}%`,
  readingLine: v => `${v}% from top`,
};

const SAMPLE_SCRIPT = `## Welcome
This is a sample script. Tap the middle of the screen to start or pause.
Tap the right side to speed up, and the left side to slow down.

Swipe up or down to move the text by hand. Long-press anywhere for the controls: font size, spacing, margins, theme, mirror and more.
// This line is a note. You only see it in the editor.

## Sections
A line that starts with two hash marks begins a new section. Swipe left or right with two fingers to jump between sections.

Double-tap the middle to go back to the top.

## Your turn
Go back to the library and paste your own script. Everything stays on this tablet.`;

/* ============================== Utilities ============================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function uid() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function debounce(fn, ms) {
  let timer = null;
  let lastArgs = [];
  const run = () => { timer = null; fn(...lastArgs); };
  const d = (...args) => { lastArgs = args; clearTimeout(timer); timer = setTimeout(run, ms); };
  d.flush = () => { if (timer !== null) { clearTimeout(timer); run(); } };
  return d;
}

const normalizeNewlines = text => String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const countWords = text => (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const min = 60e3, hr = 60 * min, day = 24 * hr;
  if (diff < min) return 'just now';
  if (diff < hr) return `${Math.floor(diff / min)} min ago`;
  if (diff < day) return `${Math.floor(diff / hr)} h ago`;
  if (diff < 2 * day) return 'yesterday';
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: diff > 300 * day ? 'numeric' : undefined,
  });
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let toastTimer = 0;
function toast(message, ms = 2600) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ============================== Storage (IndexedDB) ============================== */

const DB_NAME = 'teleprompter';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('scripts')) d.createObjectStore('scripts', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => d.close();   // let a newer version of the app upgrade the database
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  });
}

const db = {
  all: () => tx('scripts', 'readonly', s => s.getAll()),
  put: script => tx('scripts', 'readwrite', s => s.put(script)),
  putMany: list => tx('scripts', 'readwrite', s => { list.forEach(x => s.put(x)); }),
  del: id => tx('scripts', 'readwrite', s => s.delete(id)),
  getMeta: key => tx('meta', 'readonly', s => s.get(key)).then(r => r?.value),
  setMeta: (key, value) => tx('meta', 'readwrite', s => s.put({ key, value })),
};

/** In-memory copy of every script, keyed by id. IndexedDB is the source of truth on load. */
const scripts = new Map();

function sanitizeSettings(x) {
  x = x && typeof x === 'object' ? x : {};
  const s = { ...DEFAULT_SETTINGS };
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const v = Number(x[key]);
    if (x[key] !== undefined && Number.isFinite(v)) s[key] = clamp(v, lo, hi);
  }
  for (const key of ['mirrorH', 'mirrorV', 'countdown']) if (typeof x[key] === 'boolean') s[key] = x[key];
  if (THEMES.includes(x.theme)) s.theme = x.theme;
  if (THEMES.includes(x.prevTheme)) s.prevTheme = x.prevTheme;
  if (MODES.includes(x.mode)) s.mode = x.mode;
  return s;
}

function normalizeScript(raw) {
  const now = Date.now();
  return {
    id: String(raw.id || uid()),
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? normalizeNewlines(raw.body) : '',
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    settings: sanitizeSettings(raw.settings),
  };
}

async function loadScripts() {
  const all = await db.all();
  scripts.clear();
  for (const raw of all) {
    const s = normalizeScript(raw);
    scripts.set(s.id, s);
  }
}

async function saveScript(s) {
  s.updatedAt = Date.now();
  scripts.set(s.id, s);
  await db.put(s);
}

/** New scripts start from the settings used most recently, so you only tune your setup once. */
async function createScript({ title = '', body = '' } = {}) {
  let last;
  try { last = await db.getMeta('lastSettings'); } catch { /* fall back to defaults */ }
  const now = Date.now();
  const s = { id: uid(), title, body: normalizeNewlines(body), createdAt: now, updatedAt: now, settings: sanitizeSettings(last) };
  await saveScript(s);
  return s;
}

/* ============================== Dialogs ============================== */

const dlg = $('#dlg');
let cancelOpenDialog = null;

dlg.addEventListener('cancel', e => { e.preventDefault(); cancelOpenDialog?.(); });
dlg.addEventListener('close', () => { if (!dlg.open) cancelOpenDialog?.(); });

/**
 * Shows a modal dialog. actions: [{ label, value, kind?: 'primary'|'danger', default?, cancel? }]
 * Resolves { value, text } where text is the trimmed input (if any).
 */
function showDialog({ title = '', message = '', input = null, actions, vertical = false }) {
  cancelOpenDialog?.();
  return new Promise(resolve => {
    let done = false;
    let inputEl = null;
    const cancelValue = actions.find(a => a.cancel)?.value ?? null;
    const finish = value => {
      if (done) return;
      done = true;
      cancelOpenDialog = null;
      const text = inputEl ? inputEl.value.trim() : '';
      if (dlg.open) dlg.close();
      resolve({ value, text });
    };
    cancelOpenDialog = () => finish(cancelValue);

    const form = el('form', { className: 'dlg-form', method: 'dialog' });
    if (title) form.append(el('h2', { className: 'dlg-title', textContent: title }));
    if (message) form.append(el('p', { className: 'dlg-msg', textContent: message }));
    if (input) {
      inputEl = el('input', { className: 'dlg-input', type: 'text', value: input.value ?? '', placeholder: input.placeholder ?? '' });
      inputEl.setAttribute('enterkeyhint', 'done');
      form.append(inputEl);
    }
    const row = el('div', { className: `dlg-actions${vertical ? ' vertical' : ''}` });
    for (const a of actions) {
      const b = el('button', { type: 'button', className: `btn ${a.kind || ''}`, textContent: a.label });
      b.addEventListener('click', () => finish(a.value));
      if (a.default && !input) b.autofocus = true;
      row.append(b);
    }
    form.append(row);
    form.addEventListener('submit', e => {
      e.preventDefault();
      finish(actions.find(a => a.default)?.value ?? cancelValue);
    });

    dlg.replaceChildren(form);
    dlg.showModal();
    if (inputEl) { inputEl.focus(); inputEl.select(); }
  });
}

async function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  const r = await showDialog({
    title, message,
    actions: [
      { label: 'Cancel', value: false, cancel: true },
      { label: okLabel, value: true, kind: danger ? 'danger' : 'primary', default: true },
    ],
  });
  return r.value === true;
}

async function promptDialog(title, value, okLabel = 'Save') {
  const r = await showDialog({
    title, input: { value },
    actions: [
      { label: 'Cancel', value: false, cancel: true },
      { label: okLabel, value: true, kind: 'primary', default: true },
    ],
  });
  return r.value === true ? r.text : null;
}

async function menuDialog(title, items) {
  const r = await showDialog({ title, vertical: true, actions: [...items, { label: 'Cancel', value: null, cancel: true }] });
  return r.value;
}

/* ============================== Router ============================== */
// #/ → library · #/edit/<id> → editor · #/play/<id> → prompter
// history.state.depth lets "Back"/"Exit" return to the previous screen instead of stacking new ones.

let current = { view: null, id: null };
const currentPath = () => location.hash.replace(/^#\/?/, '');

function go(path, { replace = false } = {}) {
  const st = history.state || {};
  const state = { depth: (st.depth || 0) + (replace ? 0 : 1), prev: replace ? st.prev : currentPath() };
  history[replace ? 'replaceState' : 'pushState'](state, '', `#/${path}`);
  route();
}

function back() {
  if ((history.state?.depth || 0) > 0) history.back();
  else go('', { replace: true });
}

function route() {
  const [view, id] = currentPath().split('/');
  let next = { view: 'library', id: null };
  if ((view === 'edit' || view === 'play') && scripts.has(id)) next = { view: view === 'edit' ? 'editor' : 'prompter', id };
  else if (currentPath()) history.replaceState(history.state, '', '#/');
  if (next.view === current.view && next.id === current.id) return;

  leaveCurrent();
  current = next;
  document.body.dataset.view = next.view;
  for (const name of ['library', 'editor', 'prompter']) $(`#view-${name}`).hidden = name !== next.view;

  if (next.view === 'editor') showEditor(next.id);
  else if (next.view === 'prompter') showPrompter(next.id);
  else showLibrary();
}

function leaveCurrent() {
  if (current.view === 'editor') {
    saveEditorSoon.flush();
    ed.script = null;
  } else if (current.view === 'prompter') {
    stopCountdown();
    P.state = 'paused';
    cancelAnimationFrame(P.raf);
    P.raf = 0;
    P.v = 0;
    P.pending = 0;
    saveSettingsSoon.flush();
    closeOverlay();
    releaseWakeLock();
    exitFullscreen();
    P.script = null;
    P.s = null;
  }
}

function flushSaves() {
  saveEditorSoon.flush();
  saveSettingsSoon.flush();
}

/* ============================== Library ============================== */

function showLibrary() {
  renderLibrary();
}

function renderLibrary() {
  const list = $('#lib-list');
  const items = [...scripts.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  $('#lib-empty').hidden = items.length > 0;
  $('#lib-count').textContent = items.length ? `${items.length} script${items.length === 1 ? '' : 's'}` : '';

  list.replaceChildren(...items.map(s => {
    const text = visibleText(s.body);
    const words = countWords(text);
    const minutes = words / (BASE_WPM * s.settings.speed / 100);
    const main = el('button', { type: 'button', className: 'card-main' },
      el('h3', { className: 'card-title', textContent: displayTitle(s) }),
      el('p', { className: 'card-preview', textContent: text.replace(/\s+/g, ' ').slice(0, 240) || 'Empty script' }),
      el('p', { className: 'card-meta', textContent: `${words} words · ~${fmtDuration(minutes * 60)} at ${s.settings.speed}% · ${relTime(s.updatedAt)}` }),
    );
    main.addEventListener('click', () => go(`edit/${s.id}`));

    const play = el('button', { type: 'button', className: 'btn primary', textContent: '▶ Play' });
    play.addEventListener('click', () => { enterFullscreen(); go(`play/${s.id}`); });

    const more = el('button', { type: 'button', className: 'btn icon', textContent: '⋯', ariaLabel: 'More actions' });
    more.addEventListener('click', () => scriptMenu(s.id));

    return el('article', { className: 'card' }, main, el('div', { className: 'card-actions' }, play, more));
  }));
}

async function scriptMenu(id) {
  const s = scripts.get(id);
  if (!s) return;
  const choice = await menuDialog(displayTitle(s), [
    { label: 'Edit', value: 'edit' },
    { label: 'Rename', value: 'rename' },
    { label: 'Duplicate', value: 'duplicate' },
    { label: 'Delete', value: 'delete', kind: 'danger' },
  ]);
  try {
    if (choice === 'edit') {
      go(`edit/${id}`);
    } else if (choice === 'rename') {
      const name = await promptDialog('Rename script', displayTitle(s));
      if (name !== null) { s.title = name; await saveScript(s); renderLibrary(); }
    } else if (choice === 'duplicate') {
      const now = Date.now();
      const copy = { ...structuredClone(s), id: uid(), title: `${displayTitle(s)} (copy)`, createdAt: now, updatedAt: now };
      await saveScript(copy);
      renderLibrary();
      toast('Duplicated');
    } else if (choice === 'delete') {
      const ok = await confirmDialog(`Delete “${displayTitle(s)}”?`, 'This removes the script from this tablet. It can’t be undone unless you have a backup.', 'Delete', true);
      if (ok) { await db.del(id); scripts.delete(id); renderLibrary(); toast('Deleted'); }
    }
  } catch (err) {
    toast(`Something went wrong: ${err.message}`);
  }
}

async function newScript() {
  const s = await createScript();
  go(`edit/${s.id}`);
}

async function pasteAsNew() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { /* permission denied or unsupported */ }
  if (!text.trim()) {
    toast('Couldn’t read the clipboard — paste into the new script instead');
    return newScript();
  }
  const s = await createScript({ body: text });
  go(`edit/${s.id}`);
}

async function importFiles(files) {
  let count = 0;
  for (const file of files) {
    try {
      let body = normalizeNewlines(await file.text());
      let title = file.name.replace(/\.(txt|md|markdown)$/i, '');
      // A leading "# Title" line in a Markdown file becomes the script title.
      const m = /^\s*#\s+(.+)\n/.exec(body);
      if (m) { title = m[1].trim(); body = body.slice(m[0].length); }
      await createScript({ title, body });
      count++;
    } catch (err) {
      toast(`Couldn’t import ${file.name}: ${err.message}`);
    }
  }
  renderLibrary();
  if (count) toast(`Imported ${count} script${count === 1 ? '' : 's'}`);
}

function exportBackup() {
  const data = { app: 'teleprompter', version: 1, exportedAt: new Date().toISOString(), scripts: [...scripts.values()] };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `teleprompter-backup-${dateStamp()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast(`Saved a backup of ${data.scripts.length} script${data.scripts.length === 1 ? '' : 's'} to Downloads`);
}

/** Restores a backup. Scripts not on the tablet are added; ones that exist are replaced only if the backup copy is newer. */
async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file isn’t a valid backup'); return; }
  const list = Array.isArray(data) ? data : data?.scripts;
  if (!Array.isArray(list)) { toast('No scripts found in that file'); return; }

  let added = 0, updated = 0, unchanged = 0;
  const toSave = [];
  for (const raw of list) {
    if (!raw || typeof raw.body !== 'string') continue;
    const s = normalizeScript(raw);
    const existing = scripts.get(s.id);
    if (!existing) added++;
    else if (s.updatedAt > existing.updatedAt) updated++;
    else { unchanged++; continue; }
    toSave.push(s);
  }
  try {
    await db.putMany(toSave);
    toSave.forEach(s => scripts.set(s.id, s));
  } catch (err) {
    toast(`Restore failed: ${err.message}`);
    return;
  }
  renderLibrary();
  toast(`Restored: ${added} new, ${updated} updated, ${unchanged} already up to date`, 4000);
}

function bindLibrary() {
  $('#lib-new').addEventListener('click', newScript);
  $('#lib-paste').addEventListener('click', pasteAsNew);
  $('#lib-import').addEventListener('click', () => $('#file-import').click());
  $('#lib-backup').addEventListener('click', exportBackup);
  $('#lib-restore').addEventListener('click', () => $('#file-restore').click());
  $('#file-import').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) importFiles(files);
  });
  $('#file-restore').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) restoreBackup(file);
  });
}

/* ============================== Editor ============================== */

const ed = { script: null };

const saveEditorSoon = debounce(async () => {
  const s = ed.script;
  if (!s) return;
  try {
    await saveScript(s);
    if (ed.script === s) setEdStatus('Saved');
  } catch (err) {
    setEdStatus('Not saved!');
    toast(`Couldn’t save: ${err.message}`);
  }
}, 400);

function setEdStatus(text) { $('#ed-status').textContent = text; }

function updateEdCount() {
  const s = ed.script;
  const words = countWords(visibleText(s.body));
  const sec = words / (BASE_WPM * s.settings.speed / 100) * 60;
  $('#ed-count').textContent = `${words} words · about ${fmtDuration(sec)} at ${s.settings.speed}% speed`;
}

function showEditor(id) {
  ed.script = scripts.get(id);
  $('#ed-title').value = ed.script.title;
  $('#ed-title').placeholder = titleFromBody(ed.script.body) || 'Title';
  $('#ed-body').value = ed.script.body;
  $('#ed-body').scrollTop = 0;
  setEdStatus('Saved');
  updateEdCount();
  if (!ed.script.body) $('#ed-body').focus();
}

function bindEditor() {
  $('#ed-title').addEventListener('input', e => {
    ed.script.title = e.target.value;
    setEdStatus('Saving…');
    saveEditorSoon();
  });
  $('#ed-body').addEventListener('input', e => {
    ed.script.body = e.target.value;
    $('#ed-title').placeholder = titleFromBody(ed.script.body) || 'Title';
    setEdStatus('Saving…');
    updateEdCount();
    saveEditorSoon();
  });
  $('#ed-back').addEventListener('click', back);
  $('#ed-play').addEventListener('click', () => {
    enterFullscreen();
    go(`play/${ed.script.id}`);
  });
}

/* ============================== Script parsing ============================== */
// Phase 1 understands "## Section" lines, "// note" lines (hidden) and blank lines (paragraphs).
// Everything else is shown as-is. Inline cue marks ([PAUSE], *emphasis* …) arrive in Phase 3.

function parseScript(body) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = []; }
  };
  for (const raw of normalizeNewlines(body).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//')) continue;
    const heading = /^##(?!#)\s*(.*)$/.exec(line);
    if (heading) { flush(); blocks.push({ type: 'h', text: heading[1].trim() }); continue; }
    if (!line) { flush(); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}

const visibleText = body => parseScript(body).filter(b => b.type === 'p').map(b => b.text).join('\n');

function titleFromBody(body) {
  const first = parseScript(body)[0];
  const t = first ? first.text.split('\n')[0] : '';
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t;
}

const displayTitle = s => s.title.trim() || titleFromBody(s.body) || 'Untitled script';

/** Inline rendering hook. Phase 3 turns cue marks and *emphasis* into elements here. */
function renderInline(text) {
  return document.createTextNode(text);
}

/* ============================== Prompter engine ============================== */
// Positions are in content pixels. pos = 0 puts the first line on the reading line.
// The track is moved with translate3d using fractional pixels; speed is in px per second,
// so it is identical at 60 Hz and 120 Hz. Speed % is relative to BASE_WPM, measured from the
// rendered text, so changing font size or rotating the tablet keeps the same words per minute.

const P = {
  stage: null, mirror: null, track: null,
  script: null, s: null,
  state: 'paused',          // 'paused' | 'countdown' | 'playing'
  pos: 0, endPos: 0, homePos: 0,
  v: 0,                     // current velocity (px/s), eased toward the target
  pxPerSec: 0,              // target velocity at the current speed
  pending: 0,               // distance still to travel for nudges and jumps (px)
  lastTs: null, raf: 0,
  lh: 0, readY: 0, contentH: 0, words: 0,
  blockEls: [], blocks: [], sections: [],
  countdownTimer: 0,
};

function showPrompter(id) {
  P.script = scripts.get(id);
  P.s = P.script.settings;
  P.state = 'paused';
  P.pos = 0;
  P.v = 0;
  P.pending = 0;
  buildTrack(P.script.body);
  applySettings(false);
  P.pos = P.homePos;
  render();
  acquireWakeLock();
  showHint('Tap the middle to start · long-press for controls', 2600);
}

function buildTrack(body) {
  const blocks = parseScript(body);
  if (!blocks.length) blocks.push({ type: 'p', text: 'This script is empty. Long-press, then tap Edit script.' });
  P.sections = [];
  P.words = 0;
  P.blockEls = blocks.map((b, index) => {
    if (b.type === 'h') {
      const title = b.text || `Section ${P.sections.length + 1}`;
      const node = el('div', { className: 'pr-section' }, el('span', { textContent: title }));
      P.sections.push({ title, index, pos: 0 });
      return node;
    }
    P.words += countWords(b.text);
    return el('p', { className: 'pr-p' }, renderInline(b.text));
  });
  P.track.replaceChildren(...P.blockEls);
}

/** Applies the script's display settings, re-measures, and keeps the same text on the reading line. */
function applySettings(keepAnchor = true) {
  const s = P.s;
  const anchor = keepAnchor ? captureAnchor() : null;

  P.stage.className = `pr-stage theme-${s.theme}`;
  P.mirror.style.transform = s.mirrorH || s.mirrorV ? `scale(${s.mirrorH ? -1 : 1}, ${s.mirrorV ? -1 : 1})` : '';
  const t = P.track.style;
  t.fontSize = `${s.fontSize}px`;
  t.lineHeight = String(s.lineHeight);
  t.paddingLeft = t.paddingRight = `${s.margin}%`;

  measure();
  P.pos = anchor ? posFromAnchor(anchor) : clamp(P.pos, 0, P.endPos);
  P.pending = 0;
  render();
}

function measure() {
  const s = P.s;
  P.lh = s.fontSize * s.lineHeight;
  P.readY = P.stage.clientHeight * s.readingLine / 100;
  P.blocks = P.blockEls.map(e => ({ top: e.offsetTop, h: e.offsetHeight }));
  const last = P.blocks[P.blocks.length - 1];
  P.contentH = last ? last.top + last.h : 0;
  P.endPos = Math.max(0, P.contentH - P.lh);
  // "Top" is the first line of text, even when the script opens with a section divider.
  const firstText = P.blocks.find((_, i) => P.blockEls[i].tagName === 'P');
  P.homePos = firstText ? Math.min(firstText.top, P.endPos) : 0;
  // A section jump puts the section's first line on the reading line, with its divider just above.
  for (const sec of P.sections) {
    const head = P.blocks[sec.index];
    const next = P.blocks[sec.index + 1];
    sec.pos = clamp(next ? next.top : head.top + head.h / 2 - P.lh / 2, 0, P.endPos);
  }
  P.stage.style.setProperty('--lh', `${P.lh}px`);
  P.stage.style.setProperty('--rl', `${P.readY}px`);
  updateSpeed();
}

function updateSpeed() {
  const pxPerWord = P.words > 0 && P.contentH > 0 ? P.contentH / P.words : 0;
  const base = pxPerWord ? (BASE_WPM / 60) * pxPerWord : P.lh * 0.4;
  P.pxPerSec = base * P.s.speed / 100;
}

/** Which block is on the reading line, and how far into it (0–1). */
function captureAnchor() {
  if (!P.blocks.length) return null;
  const c = P.pos + P.lh / 2;
  for (let i = 0; i < P.blocks.length; i++) {
    const b = P.blocks[i];
    if (c < b.top + b.h || i === P.blocks.length - 1) return { i, f: clamp((c - b.top) / Math.max(1, b.h), 0, 1) };
  }
  return null;
}

function posFromAnchor({ i, f }) {
  const b = P.blocks[i];
  if (!b) return clamp(P.pos, 0, P.endPos);
  return clamp(b.top + f * b.h - P.lh / 2, 0, P.endPos);
}

function render() {
  P.track.style.transform = `translate3d(0,${(P.readY - P.lh / 2 - P.pos).toFixed(2)}px,0)`;
}

function ensureLoop() {
  if (!P.raf) {
    P.lastTs = null;
    P.raf = requestAnimationFrame(frame);
  }
}

function frame(ts) {
  P.raf = 0;
  const dt = P.lastTs === null ? 0 : Math.min(0.1, (ts - P.lastTs) / 1000);
  P.lastTs = ts;

  // Ease velocity so starts, stops and speed changes never jerk.
  const target = P.state === 'playing' ? P.pxPerSec : 0;
  P.v += (target - P.v) * (1 - Math.exp(-dt / 0.15));
  if (Math.abs(target - P.v) < 0.05) P.v = target;
  let move = P.v * dt;

  // Nudges and section jumps glide instead of snapping.
  if (P.pending) {
    let step = P.pending * (1 - Math.exp(-dt / 0.09));
    if (Math.abs(P.pending - step) < 0.5) step = P.pending;
    P.pending -= step;
    move += step;
  }

  if (move) {
    const next = P.pos + move;
    P.pos = clamp(next, 0, P.endPos);
    if (P.pos !== next) P.pending = 0;
    render();
  }

  if (P.state === 'playing' && P.pos >= P.endPos) {
    P.state = 'paused';
    syncPlayUI();
    showHint('End of script', 1400);
  }

  if (P.state === 'playing' || P.v !== 0 || P.pending !== 0) P.raf = requestAnimationFrame(frame);
}

/* ---------- Actions (shared by touch and keyboard) ---------- */

function togglePlay() {
  if (P.state === 'playing') pause();
  else if (P.state === 'countdown') { stopCountdown(); syncPlayUI(); showHint('Paused'); }
  else start();
}

function start() {
  if (P.pos >= P.endPos - 0.5) { showHint('End of script · double-tap to restart', 1600); return; }
  enterFullscreen();
  if (P.s.countdown) runCountdown();
  else play(true);
}

function play(withHint) {
  P.state = 'playing';
  if (withHint) showHint(`Play · ${P.s.speed}%`);
  syncPlayUI();
  ensureLoop();
}

function pause() {
  stopCountdown();
  P.state = 'paused';
  showHint('Paused');
  syncPlayUI();
  ensureLoop();
}

function runCountdown() {
  P.state = 'countdown';
  syncPlayUI();
  hideHint();
  const cd = $('#pr-countdown');
  let n = 3;
  const tick = () => {
    if (P.state !== 'countdown') return;
    if (n === 0) { cd.hidden = true; play(false); return; }
    cd.textContent = String(n--);
    cd.hidden = false;
    cd.classList.remove('pop');
    void cd.offsetWidth;   // restart the CSS animation
    cd.classList.add('pop');
    P.countdownTimer = setTimeout(tick, 1000);
  };
  tick();
}

function stopCountdown() {
  clearTimeout(P.countdownTimer);
  $('#pr-countdown').hidden = true;
  if (P.state === 'countdown') P.state = 'paused';
}

function changeSpeed(dir) {
  const s = P.s;
  s.speed = clamp(Math.round((s.speed + dir * SPEED_STEP) / SPEED_STEP) * SPEED_STEP, RANGES.speed[0], RANGES.speed[1]);
  updateSpeed();
  showHint(`Speed ${s.speed}%`);
  saveSettingsSoon();
  if (overlayOpen()) syncOverlay();
}

function nudge(lines) {
  P.pending += lines * P.lh;
  showHint(lines > 0 ? 'Forward' : 'Back');
  ensureLoop();
}

/** Direct finger drag: content follows the finger. */
function dragBy(px) {
  P.pending = 0;
  P.pos = clamp(P.pos + px, 0, P.endPos);
  render();
}

function jumpTo(pos) {
  P.pending = clamp(pos, 0, P.endPos) - P.pos;
  ensureLoop();
}

// A section that starts less than ~a line below the reading line counts as the current one.
const sectionSlack = () => P.lh * 0.75;

function currentSectionIndex() {
  const at = P.pos + P.pending;
  let idx = -1;
  P.sections.forEach((sec, i) => { if (sec.pos <= at + sectionSlack()) idx = i; });
  return idx;
}

function jumpSection(dir) {
  const secs = P.sections;
  if (!secs.length) { showHint('No sections · add ## headings'); return; }
  const at = P.pos + P.pending;   // where we are heading, so repeated swipes keep stepping
  if (dir > 0) {
    const i = secs.findIndex(sec => sec.pos > at + sectionSlack());
    if (i === -1) { showHint('Last section'); return; }
    jumpTo(secs[i].pos);
    showHint(`${i + 1}/${secs.length} · ${secs[i].title}`);
  } else {
    // Going back from just inside a section goes to the previous one, like a music player.
    let i = -1;
    for (let k = secs.length - 1; k >= 0; k--) if (secs[k].pos < at - P.lh * 1.5) { i = k; break; }
    if (i === -1) { jumpTo(P.homePos); showHint('Top'); return; }
    jumpTo(secs[i].pos);
    showHint(`${i + 1}/${secs.length} · ${secs[i].title}`);
  }
}

async function confirmRestart() {
  if (P.state !== 'paused') {
    stopCountdown();
    P.state = 'paused';
    syncPlayUI();
    ensureLoop();
  }
  hideHint();
  const ok = await confirmDialog('Restart from the top?', '', 'Restart');
  if (ok && P.script) { jumpTo(P.homePos); showHint('Back to the top'); }
}

const ACTIONS = {
  toggle: togglePlay,
  faster: () => changeSpeed(1),
  slower: () => changeSpeed(-1),
  forward: () => nudge(1),
  back: () => nudge(-1),
  nextSection: () => jumpSection(1),
  prevSection: () => jumpSection(-1),
  controls: () => openOverlay(),
  restart: confirmRestart,
};

/* ---------- Hints ---------- */

let hintTimer = 0;
function showHint(text, ms = 700) {
  const h = $('#pr-hint');
  h.textContent = text;
  h.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove('show'), ms);   // then fades over 0.25 s
}
function hideHint() {
  clearTimeout(hintTimer);
  $('#pr-hint').classList.remove('show');
}

/* ============================== Gestures (pointer events) ============================== */
// All zones use physical screen coordinates, so in mirror mode the right side is still "faster".

const G = { pts: new Map(), mode: null, x0: 0, y0: 0, lastY: 0, lpTimer: 0, lastTap: null };

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { P.stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  G.pts.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });

  if (G.pts.size === 1) {
    G.mode = 'pending';
    G.x0 = e.clientX;
    G.y0 = e.clientY;
    G.lastY = e.clientY;
    clearTimeout(G.lpTimer);
    G.lpTimer = setTimeout(() => {
      if (G.mode === 'pending') { G.mode = 'done'; openOverlay(); }
    }, LONG_PRESS_MS);
  } else if (G.pts.size === 2 && (G.mode === 'pending' || G.mode === 'drag')) {
    clearTimeout(G.lpTimer);
    G.mode = 'two';
    for (const p of G.pts.values()) { p.x0 = p.x; p.y0 = p.y; }
  } else {
    G.mode = 'done';   // three or more fingers: ignore until all are lifted
  }
}

function onPointerMove(e) {
  const p = G.pts.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;
  if (G.mode === 'pending' && Math.hypot(p.x - G.x0, p.y - G.y0) > TAP_SLOP) {
    clearTimeout(G.lpTimer);
    G.mode = Math.abs(p.y - G.y0) >= Math.abs(p.x - G.x0) ? 'drag' : 'done';
    G.lastY = p.y;
  }
  if (G.mode === 'drag') {
    const d = p.y - G.lastY;
    G.lastY = p.y;
    if (d) dragBy(-d);   // finger up → text forward
  }
}

function onPointerUp(e) {
  const p = G.pts.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX;
  p.y = e.clientY;

  if (G.mode === 'two') {
    let dx = 0, dy = 0;
    for (const q of G.pts.values()) { dx += q.x - q.x0; dy += q.y - q.y0; }
    dx /= G.pts.size;
    dy /= G.pts.size;
    G.mode = 'done';
    if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.2) {
      ACTIONS[dx < 0 ? 'nextSection' : 'prevSection']();
    }
  } else if (G.mode === 'pending' && G.pts.size === 1) {
    clearTimeout(G.lpTimer);
    handleTap(e.clientX, e.clientY, e.timeStamp);
  }

  G.pts.delete(e.pointerId);
  if (G.pts.size === 0) { G.mode = null; clearTimeout(G.lpTimer); }
}

function onPointerCancel(e) {
  G.pts.delete(e.pointerId);
  clearTimeout(G.lpTimer);
  G.mode = G.pts.size ? 'done' : null;
}

function handleTap(x, y, t) {
  const w = P.stage.clientWidth;
  if (x > w / 3 && x < (w * 2) / 3) {
    // Middle: play/pause now; a quick second tap turns it into "restart from top".
    const last = G.lastTap;
    if (last && t - last.t < DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) < 60) {
      G.lastTap = null;
      ACTIONS.restart();
      return;
    }
    G.lastTap = { t, x, y };
    ACTIONS.toggle();
  } else {
    G.lastTap = null;
    ACTIONS[x >= (w * 2) / 3 ? 'faster' : 'slower']();
  }
}

function bindGestures() {
  const st = P.stage;
  st.addEventListener('pointerdown', onPointerDown);
  st.addEventListener('pointermove', onPointerMove);
  st.addEventListener('pointerup', onPointerUp);
  st.addEventListener('pointercancel', onPointerCancel);
  st.addEventListener('contextmenu', e => e.preventDefault());
}

/* ============================== Keyboard (and future Bluetooth remote) ============================== */

const KEYMAP = {
  ' ': 'toggle',
  ArrowRight: 'faster',
  ArrowLeft: 'slower',
  ArrowDown: 'forward',
  ArrowUp: 'back',
  PageDown: 'nextSection',
  PageUp: 'prevSection',
  Escape: 'controls',
  Home: 'restart',
};
const NO_REPEAT = new Set(['toggle', 'controls', 'restart']);

function onKeyDown(e) {
  if (current.view !== 'prompter' || dlg.open || e.ctrlKey || e.metaKey || e.altKey) return;
  if (overlayOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
    return;
  }
  const action = KEYMAP[e.key];
  if (!action) return;
  e.preventDefault();
  if (e.repeat && NO_REPEAT.has(action)) return;
  ACTIONS[action]();
}

/* ============================== Controls overlay ============================== */

const overlayOpen = () => !$('#pr-overlay').hidden;

function openOverlay() {
  if (!P.script) return;
  syncOverlay();
  const ov = $('#pr-overlay');
  ov.hidden = false;
  ov.classList.add('opening');   // ignore the finger that is still down from the long press
  setTimeout(() => ov.classList.remove('opening'), 350);
  navigator.vibrate?.(12);
}

function closeOverlay() {
  $('#pr-overlay').hidden = true;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

function syncPlayUI() {
  $('#ov-play').textContent = P.state === 'paused' ? '▶ Play' : '❚❚ Pause';
}

function syncOverlay() {
  const s = P.s;
  if (!s) return;
  const ov = $('#pr-overlay');
  $('#ov-title').textContent = displayTitle(P.script);
  $('#ov-progress').textContent = P.endPos > 0 ? `· ${Math.round((P.pos / P.endPos) * 100)}%` : '';
  $('#ov-speed').textContent = FORMAT.speed(s.speed);
  for (const i of $$('input[type=range][data-setting]', ov)) if (i !== document.activeElement) i.value = s[i.dataset.setting];
  for (const o of $$('output[data-out]', ov)) o.textContent = FORMAT[o.dataset.out](s[o.dataset.out]);
  for (const seg of $$('.seg[data-setting]', ov)) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(s[seg.dataset.setting] === b.dataset.value));
  }
  for (const c of $$('input[type=checkbox][data-setting]', ov)) c.checked = !!s[c.dataset.setting];
  $('#ov-fs').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  syncPlayUI();

  $('#ov-sections-wrap').hidden = P.sections.length === 0;
  const cur = currentSectionIndex();
  $('#ov-sections').replaceChildren(...P.sections.map((sec, i) => {
    const b = el('button', { type: 'button', className: `btn${i === cur ? ' current' : ''}`, textContent: sec.title });
    b.addEventListener('click', () => { closeOverlay(); jumpTo(sec.pos); showHint(sec.title); });
    return b;
  }));
}

function setSetting(key, value) {
  const s = P.s;
  if (!s) return;
  if (key === 'mode') {
    if (s.mode === value) return;
    if (value === 'rig') {
      s.prevTheme = s.theme;
      s.theme = 'contrast';
      s.mirrorH = true;
    } else {
      s.theme = s.prevTheme || 'dark';
      s.mirrorH = false;
      s.mirrorV = false;
    }
    s.mode = value;
  } else {
    if (s[key] === value) return;
    s[key] = value;
  }
  applySettings(true);
  syncOverlay();
  saveSettingsSoon();
}

const saveSettingsSoon = debounce(() => {
  const s = P.script;
  if (!s) return;
  saveScript(s).catch(err => toast(`Couldn’t save settings: ${err.message}`));
  db.setMeta('lastSettings', { ...s.settings }).catch(() => {});
}, 600);

function bindOverlay() {
  const ov = $('#pr-overlay');
  $('#ov-backdrop').addEventListener('click', closeOverlay);
  $('#ov-close').addEventListener('click', closeOverlay);
  $('#ov-play').addEventListener('click', () => { closeOverlay(); togglePlay(); });
  $('#ov-restart').addEventListener('click', () => { closeOverlay(); confirmRestart(); });
  $('#ov-fs').hidden = INSTALLED_FULLSCREEN;   // already full screen; the button would do nothing
  $('#ov-fs').addEventListener('click', () => {
    if (document.fullscreenElement) exitFullscreen(); else enterFullscreen();
  });
  $('#ov-edit').addEventListener('click', () => {
    const path = `edit/${P.script.id}`;
    if (history.state?.prev === path) back(); else go(path, { replace: true });
  });
  $('#ov-exit').addEventListener('click', back);
  $('#ov-slower').addEventListener('click', () => changeSpeed(-1));
  $('#ov-faster').addEventListener('click', () => changeSpeed(1));

  for (const input of $$('input[type=range][data-setting]', ov)) {
    const [min, max, step] = RANGES[input.dataset.setting];
    Object.assign(input, { min, max, step });
    input.addEventListener('input', () => setSetting(input.dataset.setting, Math.round(Number(input.value) * 100) / 100));
  }
  for (const seg of $$('.seg[data-setting]', ov)) {
    seg.addEventListener('click', e => {
      const b = e.target.closest('button[data-value]');
      if (b) setSetting(seg.dataset.setting, b.dataset.value);
    });
  }
  for (const cb of $$('input[type=checkbox][data-setting]', ov)) {
    cb.addEventListener('change', () => setSetting(cb.dataset.setting, cb.checked));
  }
  document.addEventListener('fullscreenchange', () => {
    $('#ov-fs').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  });
}

/* ============================== Full screen + wake lock ============================== */

// Installed from the home screen, the manifest already opens the app full screen. Read at load,
// before the page asks for full screen itself.
const INSTALLED_FULLSCREEN = matchMedia('(display-mode: fullscreen)').matches;

function enterFullscreen() {
  const root = document.documentElement;
  if (!INSTALLED_FULLSCREEN && !document.fullscreenElement && root.requestFullscreen) {
    root.requestFullscreen({ navigationUI: 'hide' }).catch(() => { /* needs a tap; tried again on Play */ });
  }
}

function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

let wakeLock = null;
let wantWakeLock = false;

async function acquireWakeLock() {
  wantWakeLock = true;
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wantWakeLock) { lock.release(); return; }
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
  } catch (err) {
    console.warn('Screen wake lock unavailable:', err);
  }
}

function releaseWakeLock() {
  wantWakeLock = false;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    if (wantWakeLock) acquireWakeLock();   // Android drops the lock when the app is backgrounded
  } else {
    flushSaves();
    if (current.view === 'prompter' && P.state !== 'paused') {
      stopCountdown();
      P.state = 'paused';
      syncPlayUI();
    }
  }
}

/* ============================== Install + offline ============================== */
// sw.js keeps a copy of the app on the tablet so it opens with no internet, and checks for a
// newer copy whenever the app opens online. This side shows "Install app" when Chrome offers it,
// "Update ready · Reload" when a newer copy has been downloaded, and "Works offline" once cached.

let installPrompt = null;
let updateReady = false;
let offlineReady = false;

function setupOffline() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();               // use our button instead of Chrome's banner
    installPrompt = e;
    syncAppStatus();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    syncAppStatus();
    toast('Installed. Open Teleprompter from the home screen.', 4000);
  });
  $('#lib-install').addEventListener('click', async () => {
    const e = installPrompt;
    if (!e) return;
    installPrompt = null;
    syncAppStatus();
    try { await e.prompt(); } catch { /* the prompt can only be shown once */ }
  });
  $('#lib-update').addEventListener('click', () => { flushSaves(); location.reload(); });

  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'updated') { updateReady = true; syncAppStatus(); }
  });
  navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Offline support unavailable:', err));
  navigator.serviceWorker.ready.then(() => { offlineReady = true; syncAppStatus(); });
}

function syncAppStatus() {
  const install = $('#lib-install'), update = $('#lib-update'), offline = $('#lib-offline');
  if (!install) return;   // the library is gone if storage failed to open
  install.hidden = !installPrompt;
  update.hidden = !updateReady;
  offline.textContent = offlineReady ? ' Works offline.' : '';
}

/* ============================== Init ============================== */

let relayoutQueued = false;
function scheduleRelayout() {
  if (relayoutQueued) return;
  relayoutQueued = true;
  requestAnimationFrame(() => {
    relayoutQueued = false;
    if (current.view === 'prompter' && P.script) applySettings(true);
  });
}

function reportError(message) {
  if (/^ResizeObserver loop/.test(message)) return;   // harmless browser notice
  console.error(message);
  toast(`Error: ${message}`, 5000);
}

async function init() {
  P.stage = $('#pr-stage');
  P.mirror = $('#pr-mirror');
  P.track = $('#pr-track');

  setupOffline();   // first, so Chrome's install offer is never missed
  bindLibrary();
  bindEditor();
  bindOverlay();
  bindGestures();
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', flushSaves);
  window.addEventListener('popstate', route);
  window.addEventListener('error', e => reportError(e.message));
  window.addEventListener('unhandledrejection', e => reportError(e.reason?.message || String(e.reason)));
  new ResizeObserver(() => { if (current.view === 'prompter') scheduleRelayout(); }).observe(P.stage);

  try {
    await loadScripts();
    if (!scripts.size && !(await db.getMeta('seeded'))) {
      await createScript({ title: 'Welcome — try me', body: SAMPLE_SCRIPT });
      await db.setMeta('seeded', true);
    }
  } catch (err) {
    document.body.replaceChildren(el('p', { className: 'empty', textContent: `Couldn’t open storage on this device: ${err.message}` }));
    return;
  }
  navigator.storage?.persist?.().catch(() => {});   // ask Chrome not to evict scripts under storage pressure
  route();
}

init();
