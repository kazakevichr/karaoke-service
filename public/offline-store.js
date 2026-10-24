/* ==========================================================================
   Игры, сохранённые для работы без интернета.

   Живут внутри браузера (IndexedDB): сохраняет их страница игры, играет
   страница /offline. Отдельной папки с файлами, которую можно переслать, не
   появляется — аудио и обложки открываются только этой страницей и только
   пока действует лицензия.

   Лицензию выдаёт сервер (/api/license), пока у ведущего есть доступ, и
   подписывает своим ключом; открытый ключ приходит в /license-key.js. В
   лицензии сказано, до какого момента можно играть без связи: три дня от
   выдачи, но не дольше срока доступа. Пока интернет есть, лицензия
   обновляется сама при каждом открытии страницы. Если сервер ответил, что
   доступ закончился, сохранённые игры стираются.
   ========================================================================== */
const MBOffline = (() => {
  const DB_NAME = 'muzbingo-offline';
  // Запас на расхождение часов: компьютер ведущего и сервер не обязаны
  // совпадать до секунды.
  const CLOCK_SLACK_MS = 10 * 60 * 1000;

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('games', { keyPath: 'id' });
          db.createObjectStore('media');   // ключ — путь файла в хранилище (audio/…, photo/…)
          db.createObjectStore('meta');    // license, lastSeen
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  const done = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function store(name, mode = 'readonly') {
    return (await openDb()).transaction(name, mode).objectStore(name);
  }
  const get = async (name, key) => done((await store(name)).get(key));
  const put = async (name, value, key) => done((await store(name, 'readwrite')).put(value, key));
  const del = async (name, key) => done((await store(name, 'readwrite')).delete(key));
  const getAll = async name => done((await store(name)).getAll());
  const getAllKeys = async name => done((await store(name)).getAllKeys());
  const clear = async name => done((await store(name, 'readwrite')).clear());

  // Тот же код браузера, что и в shared.js (mbDeviceId): к нему привязан
  // логин ведущего, он же записан в лицензию.
  function deviceId() {
    let id = null;
    try { id = localStorage.getItem('mb_device_id'); } catch (e) {}
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      try { localStorage.setItem('mb_device_id', id); } catch (e) {}
    }
    return id;
  }

  /* ---------- Лицензия ---------- */
  function b64urlBytes(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), c => c.charCodeAt(0));
  }
  async function verifyToken(token) {
    if (!token || !window.MB_LICENSE_KEY || !(window.crypto && crypto.subtle)) return null;
    const [body, sig] = String(token).split('.');
    try {
      const key = await crypto.subtle.importKey('jwk', window.MB_LICENSE_KEY, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlBytes(sig), new TextEncoder().encode(body));
      return ok ? JSON.parse(new TextDecoder().decode(b64urlBytes(body))) : null;
    } catch (e) {
      return null;
    }
  }

  /* Спросить сервер о свежей лицензии. Статусы:
     ok — получена; offline — сервера не видно (нет интернета или он еле
     живой), играем по сохранённой; login — нужно заново войти на сайте;
     device — логин отвязан от этого браузера; expired — доступ закончился,
     игры уже стёрты. */
  async function refreshLicense(timeoutMs = 5000) {
    let r;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      r = await fetch('/api/license', { headers: { 'X-Device-Id': deviceId() }, cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
    } catch (e) {
      return { status: 'offline' };
    }
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.token) { await put('meta', d.token, 'license'); return { status: 'ok' }; }
    if (r.status === 401) return { status: 'login', error: d.error };
    if (r.status === 403 && d.code === 'access_expired') { await wipe(); return { status: 'expired', error: d.error }; }
    if (r.status === 403 && d.code === 'device_mismatch') return { status: 'device', error: d.error };
    return { status: 'offline', error: d.error };
  }

  /* Можно ли играть прямо сейчас — по сохранённой лицензии, без сети.
     reason: none — лицензии нет; clock — часы переведены назад; device —
     лицензия выдана другому браузеру; expired — вышел срок без связи. */
  async function checkLicense() {
    const payload = await verifyToken(await get('meta', 'license'));
    if (!payload) return { ok: false, reason: 'none' };
    const now = Date.now();
    const lastSeen = (await get('meta', 'lastSeen')) || 0;
    // Перевести часы назад — самый простой способ продлить лицензию. Ловим
    // по времени выдачи и по самому позднему моменту, который страница уже
    // видела на этом компьютере.
    if (now < payload.iat - CLOCK_SLACK_MS || now < lastSeen - CLOCK_SLACK_MS) return { ok: false, reason: 'clock', payload };
    if (payload.device && payload.device !== deviceId()) return { ok: false, reason: 'device', payload };
    if (now > payload.offlineUntil) return { ok: false, reason: 'expired', payload };
    await put('meta', Math.max(now, lastSeen), 'lastSeen');
    return { ok: true, payload };
  }
  async function touchClock() {
    const lastSeen = (await get('meta', 'lastSeen')) || 0;
    if (Date.now() > lastSeen) await put('meta', Date.now(), 'lastSeen');
  }

  /* ---------- Игры ---------- */
  // То, чем страница /offline собирает PDF бланков (см. lib/blanks-core.js).
  const BLANKS_ASSETS = ['/blanks-core.js', '/vendor/pdfkit.js', '/vendor/qrcode.js', '/fonts/DejaVuSans.ttf', '/fonts/DejaVuSans-Bold.ttf'];
  // Всё для бланков без интернета — заранее, пока сеть есть: сервис-воркер
  // кладёт эти файлы в кэш по дороге.
  const prefetchBlanksAssets = () => Promise.all(BLANKS_ASSETS.map(u => fetch(u).catch(() => {})));
  async function fetchBlob(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }
  async function runLimited(items, limit, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }));
  }

  /* Скачать сохранённую игру к себе. Уже скачанные файлы (например, общие с
     другой игрой) повторно не качаются — поэтому повторный запуск просто
     докачивает то, что не скачалось в прошлый раз. onProgress получает
     { done, total, bytes, failed }. */
  async function saveGame(gameId, onProgress = () => {}) {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const lic = await refreshLicense(15000);
    if (lic.status !== 'ok') {
      throw new Error(lic.error || 'Нет связи с сервером — проверьте интернет и попробуйте ещё раз');
    }
    const payload = await verifyToken(await get('meta', 'license'));
    if (!payload) throw new Error('Браузер не смог проверить разрешение на игру без интернета — обновите страницу');

    const r = await fetch('/api/saved-games/' + encodeURIComponent(gameId) + '/offline', { cache: 'no-store' });
    const g = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(g.error || 'Не удалось получить игру с сервера');

    const files = [];
    Object.values(g.tracks || {}).forEach(t => {
      if (t.audioKey && t.audioUrl) files.push({ key: t.audioKey, url: t.audioUrl });
      if (t.photoKey && t.photoUrl) files.push({ key: t.photoKey, url: t.photoUrl });
    });
    const have = new Set(await getAllKeys('media'));
    const todo = files.filter(f => !have.has(f.key));
    const progress = { done: files.length - todo.length, total: files.length, bytes: 0, failed: 0 };
    onProgress({ ...progress });

    // Сначала качаем прямо из хранилища — это быстро. Если браузер не
    // пускает (у хранилища не настроено правило CORS), переходим на путь
    // через сервер: медленнее, но работает.
    const viaServer = key => `/api/saved-games/${encodeURIComponent(gameId)}/media?key=${encodeURIComponent(key)}`;
    let direct = true;
    async function fetchFile(f) {
      if (direct) {
        try { return await fetchBlob(f.url); }
        catch (e) {
          const blob = await fetchBlob(viaServer(f.key));
          direct = false;
          return blob;
        }
      }
      return fetchBlob(viaServer(f.key));
    }

    await runLimited(todo, 4, async f => {
      let blob = null;
      for (let attempt = 0; attempt < 3 && !blob; attempt++) {
        try { blob = await fetchFile(f); }
        catch (e) { await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); }
      }
      if (blob) { await put('media', blob, f.key); progress.bytes += blob.size; }
      else progress.failed++;
      progress.done++;
      onProgress({ ...progress });
    });

    const tracks = {};
    Object.values(g.tracks || {}).forEach(t => {
      tracks[t.id] = {
        id: t.id, title: t.title, artist: t.artist, hook: t.hook, lines: t.lines || [],
        audioKey: t.audioKey, photoKey: t.photoKey,
      };
    });
    await put('games', {
      id: g.id, name: g.name, savedAt: g.savedAt, rounds: g.rounds, tracks,
      blanksDesign: g.blanksDesign || null,
      owner: payload.sub, storedAt: Date.now(), failed: progress.failed,
    });
    await prefetchBlanksAssets();
    return progress;
  }

  async function listGames() {
    return (await getAll('games')).sort((a, b) => (b.storedAt || 0) - (a.storedAt || 0));
  }
  const getGame = id => get('games', id);
  const getMedia = key => get('media', key);

  // Удалить игру и те файлы, которые больше ни одной игре не нужны.
  async function deleteGame(id) {
    await del('games', id);
    const used = new Set();
    (await getAll('games')).forEach(g => Object.values(g.tracks || {}).forEach(t => {
      if (t.audioKey) used.add(t.audioKey);
      if (t.photoKey) used.add(t.photoKey);
    }));
    for (const key of await getAllKeys('media')) if (!used.has(key)) await del('media', key);
  }
  async function wipe() {
    await clear('games');
    await clear('media');
    await del('meta', 'license');
  }

  return {
    deviceId, refreshLicense, checkLicense, touchClock,
    saveGame, listGames, getGame, getMedia, deleteGame, wipe, prefetchBlanksAssets,
  };
})();
