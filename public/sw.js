/* Сервис-воркер. Держит в кэше браузера страницу /offline и всё, что ей
   нужно, чтобы она открывалась по адресу сайта и без интернета. Остальной
   сайт не трогает: онлайн-страницы и API ходят в сеть как обычно, а аудио
   для игры без интернета лежит не здесь, а в IndexedDB (offline-store.js). */
const CACHE = 'muzbingo-offline-v2';
// Страница и её код: сначала сеть, чтобы обновления доезжали сами.
const FRESH = ['/offline', '/offline-store.js', '/license-key.js', '/blanks-core.js', '/manifest.webmanifest', '/icon.svg'];
// Для бланков без интернета: pdfkit и шрифты — несколько мегабайт, и они не
// меняются. Берём из кэша, а в кэш кладём при первом обращении: если
// сложить их в установку, один оборвавшийся файл сорвал бы установку
// целиком, и без интернета не открылась бы даже сама страница. Обновился
// pdfkit — поменяйте CACHE, иначе у ведущих останется старая сборка.
const STATIC = ['/vendor/pdfkit.js', '/vendor/qrcode.js', '/fonts/DejaVuSans.ttf', '/fonts/DejaVuSans-Bold.ttf'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FRESH)).then(() => self.skipWaiting()));
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
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (FRESH.includes(url.pathname)) e.respondWith(networkFirst(e.request, url.pathname));
  else if (STATIC.includes(url.pathname)) e.respondWith(cacheFirst(e.request, url.pathname));
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

async function cacheFirst(request, key) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached) return cached;
  const r = await fetch(request);
  if (r.ok) cache.put(key, r.clone());
  return r;
}
