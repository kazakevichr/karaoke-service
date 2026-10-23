/* Сервис-воркер. Держит в кэше браузера страницу /offline и всё, что ей
   нужно, чтобы она открывалась по адресу сайта и без интернета. Остальной
   сайт не трогает: онлайн-страницы и API ходят в сеть как обычно, а аудио
   для игры без интернета лежит не здесь, а в IndexedDB (offline-store.js). */
const CACHE = 'muzbingo-offline-v1';
const SHELL = ['/offline', '/offline-store.js', '/license-key.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  e.respondWith(networkFirst(e.request, url.pathname));
});

/* Сначала сеть — так обновления страницы доезжают сами, — но не дольше
   трёх секунд. На площадке, где интернет «вроде есть, но еле живой»,
   страница должна открыться сразу из кэша, а не висеть. */
async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  const net = fetch(request).then(r => {
    if (r.ok) cache.put(key, r.clone());
    return r;
  });
  const quick = await Promise.race([
    net.catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), 3000)),
  ]);
  if (quick && quick.ok) return quick;
  const cached = await cache.match(key);
  if (cached) return cached;
  return quick || net;
}
