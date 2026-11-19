/* 離線快取（手機現場記錄）：有網路時先抓最新版（4 秒內沒回應才用快取），沒網路用快取。
 * 資料（現場包、記錄、照片）在 IndexedDB，不經過這裡。
 * 2026-11-19：原本先用快取、背景更新，推了新版要打開第二次才會換（使用者反映不好用）。 */
const CACHE = 'pp-field-v8';
const FILES = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const net = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    const timeout = new Promise((ok) => setTimeout(ok, 4000, null));
    try { const r = await Promise.race([net, timeout]); if (r) return r; } catch (_) { /* 沒網路 */ }
    const hit = await c.match(e.request, { ignoreSearch: true });
    return hit || net;
  })());
});
