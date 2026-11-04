// Service worker: makes the app open instantly and work with no internet.
//
// Every file the app needs is kept in one cache named after a hash of the files' contents.
// The app always opens from that cache. Each time it opens online (at most once a minute) this
// worker re-downloads the files in the background; if anything changed, it fills a complete new
// cache, switches to it in one step and tells the page, which offers "Update ready · Reload".
// So there is no version number to bump: upload changed files and the tablet picks them up.
//
// On localhost (development over USB) it asks the server first, so a reload always shows the
// latest code, and falls back to the cache when the server is off. That is how offline is tested.
//
// If you add a file the app loads, add it to SHELL.

const SHELL = [
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];
const PREFIX = 'teleprompter-shell-';
const META = 'teleprompter-meta';        // remembers which shell cache is current
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);
const CHECK_EVERY_MS = 60 * 1000;

let currentName = null;
let lastCheck = 0;
let checking = null;

async function getCurrentName() {
  if (currentName) return currentName;
  const hit = await (await caches.open(META)).match('current');
  currentName = hit ? await hit.text() : null;
  return currentName;
}

async function setCurrentName(name) {
  await (await caches.open(META)).put('current', new Response(name));
  currentName = name;
}

async function hashOf(buffers) {
  const all = new Uint8Array(buffers.reduce((n, b) => n + b.byteLength, 0));
  let offset = 0;
  for (const b of buffers) { all.set(new Uint8Array(b), offset); offset += b.byteLength; }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...digest.slice(0, 6)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Downloads one file and reads it straight away. (Waiting for every response before reading any
 *  of them deadlocks: Chrome opens at most 6 connections to a server, an unread response can
 *  hold its connection, and the 7th download then never starts.) */
async function download(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not download ${response.url} (${response.status})`);
  return { url, body: await response.arrayBuffer(), type: response.headers.get('Content-Type') || '' };
}

/** Downloads every app file. If they differ from the cached copy, swaps to a new cache.
 *  Resolves true when an older copy was replaced (an update), false otherwise. */
async function refresh() {
  const files = await Promise.all(SHELL.map(download));
  const name = PREFIX + await hashOf(files.map(f => f.body));
  const previous = await getCurrentName();
  if (name === previous && await caches.has(name)) return false;

  const cache = await caches.open(name);
  await Promise.all(files.map(f => cache.put(f.url, new Response(f.body, { headers: { 'Content-Type': f.type } }))));
  await setCurrentName(name);           // the switch: from here on, pages open the new copy
  for (const key of await caches.keys()) {
    if (key.startsWith(PREFIX) && key !== name) await caches.delete(key);
  }
  return Boolean(previous);
}

async function tellPages(message) {
  for (const page of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
    page.postMessage(message);
  }
}

function checkForUpdate() {
  if (checking) return checking;
  if (!DEV && Date.now() - lastCheck < CHECK_EVERY_MS) return Promise.resolve(false);
  lastCheck = Date.now();
  checking = refresh()
    .then(async updated => {
      if (updated && !DEV) await tellPages({ type: 'updated' });   // in dev the page already has the new code
      return updated;
    })
    .catch(() => false)                 // offline or a file missing: keep the copy we have
    .finally(() => { checking = null; });
  return checking;
}

async function fromCache(key) {
  const name = await getCurrentName();
  if (!name) return undefined;
  return (await caches.open(name)).match(key, { ignoreSearch: true });
}

async function cacheFirst(request, key) {
  return (await fromCache(key)) || fetch(request);
}

/** Development: the server's copy if it answers within a second, otherwise the cached copy.
 *  (With the USB link up but the server stopped, a request takes ~20 s to fail.) After one
 *  miss, the cache is used straight away for 10 s, so a page load waits once, not per file. */
let serverDownUntil = 0;

async function networkFirst(request, key) {
  if (Date.now() < serverDownUntil) return (await fromCache(key)) || fetch(request);
  const network = fetch(request);
  network.catch(() => {});              // a late failure is handled below; don't report it twice
  try {
    const answer = await Promise.race([network, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (answer) return answer;
  } catch { /* the server is off: use the cache */ }
  serverDownUntil = Date.now() + 10_000;
  return (await fromCache(key)) || network;
}

self.addEventListener('install', event => {
  // Install only once every file is cached, so the first install already works offline.
  event.waitUntil(refresh().then(updated => {
    lastCheck = Date.now();
    if (updated && !DEV) tellPages({ type: 'updated' });
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Every page of the app is index.html; the route lives in the #hash.
    event.respondWith(DEV ? networkFirst(request, './index.html') : cacheFirst(request, './index.html'));
    event.waitUntil(checkForUpdate());
    return;
  }
  event.respondWith(DEV ? networkFirst(request, request) : cacheFirst(request, request));
});
