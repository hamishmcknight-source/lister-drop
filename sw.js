/* Lister drop service worker.
   1. Keeps the app itself on the phone, so it opens with no signal.
   2. On Android (Background Sync), finishes queued uploads after the app is closed.
      iPhone has no Background Sync: there, the page uploads whenever it is open. */
const SHELL = 'ld-shell-v5';
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('ld-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                                   // uploads go straight to the network
  if (u.origin === location.origin) {                                       // app shell: network first, cache when offline
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
  } else if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) {        // fonts and icons: cache first
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(n => { const c = n.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); return n; })));
  }
});

/* ── background upload (same protocol as the page: one photo per request, then commit) ── */
let CFG = null;
self.addEventListener('message', e => { if (e.data && e.data.cfg) { CFG = e.data.cfg; kv('cfg', CFG); } });
function db() { return new Promise((res, rej) => { const r = indexedDB.open('lister-drop-v1', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'itemId' }); if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs'); }; }); }
function req(store, mode, fn) { return db().then(d => new Promise((res, rej) => { const t = d.transaction(store, mode), o = fn(t.objectStore(store)); t.oncomplete = () => res(o && o.result); t.onerror = () => rej(t.error); })); }
function kv(k, v) { return caches.open('ld-kv').then(c => v === undefined ? c.match(k).then(r => r && r.json()) : c.put(k, new Response(JSON.stringify(v)))); }
function b64(blob) { return blob.arrayBuffer().then(buf => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }); }
async function api(body) {
  const r = await fetch(CFG.api, { method: 'POST', body: JSON.stringify(Object.assign(body, { k: CFG.key })), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}
/* One uploader at a time: the open page takes the same lock, so a photo is never sent by both at once. */
function drain() { return (self.navigator && navigator.locks && navigator.locks.request) ? navigator.locks.request('ld-upload', drainOnce) : drainOnce(); }
async function drainOnce() {
  CFG = CFG || await kv('cfg');
  if (!CFG) return;
  const items = (await req('items', 'readonly', s => s.getAll())) || [];
  for (const it of items.filter(i => !i.committed && !i.stuck).sort((a, b) => a.capturedAt < b.capturedAt ? -1 : 1)) {
    for (let i = 0; i < it.names.length; i++) {
      if (it.sent[i]) continue;
      const b = await req('blobs', 'readonly', s => s.get(it.itemId + '/' + it.names[i]));
      if (b) { const r = await api({ op: 'put', itemId: it.itemId, name: it.names[i], mime: b.type || 'image/jpeg', b64: await b64(b) }); if (!r.ok) throw new Error(r.error || 'server'); }
      it.sent[i] = true; await req('items', 'readwrite', s => s.put(it));
    }
    const c = await api({ op: 'commit', itemId: it.itemId, names: it.names, note: it.note, hints: it.hints, capturedAt: it.capturedAt });
    if (!c.ok) throw new Error(c.error || 'commit');
    it.committed = true; await req('items', 'readwrite', s => s.put(it));
    for (const n of it.names) await req('blobs', 'readwrite', s => s.delete(it.itemId + '/' + n));
  }
}
self.addEventListener('sync', e => { if (e.tag === 'ld-upload') e.waitUntil(drain()); });   // a throw makes the browser retry later
