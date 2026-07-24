require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // лимит Whisper API — 25 МБ
});
// Отдельный лимит для загрузки самих треков в общий банк — тут ограничение
// Whisper (25 МБ) уже не при чём, это просто хранение файла в S3.
const uploadTrackFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

/* ==========================================================================
   Общий банк треков и раунды — теперь на сервере, а не в IndexedDB/localStorage
   браузера, чтобы с сервисом можно было работать с любого устройства.
   Метаданные (название/исполнитель/текст/тайминги/раунды) — в SQLite-файле
   (путь берётся из DB_PATH; ОБЯЗАТЕЛЬНО должен указывать на персистентный том
   в Coolify — иначе база будет обнуляться при каждом передеплое). Сами
   аудиофайлы и обложки — в S3-совместимом хранилище (переменные S3_*).
   ========================================================================== */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'karaoke.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    artist TEXT DEFAULT '',
    album TEXT DEFAULT '',
    hook REAL DEFAULT 0,
    lyrics TEXT DEFAULT '',
    lines TEXT DEFAULT '[]',
    syncPct INTEGER,
    categories TEXT DEFAULT '[]',
    audioKey TEXT,
    audioType TEXT,
    photoKey TEXT,
    createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
`);

const s3Enabled = !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);
const s3 = s3Enabled ? new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'ru-1',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
  forcePathStyle: true, // большинство S3-совместимых провайдеров (не сам AWS) требуют path-style URL
}) : null;
if (!s3Enabled) {
  console.warn('S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY/S3_SECRET_KEY не заданы — загрузка аудио/обложек в общий банк работать не будет, пока их не добавить в переменные окружения.');
}
const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');
function s3PublicUrl(key) {
  if (!key) return null;
  if (S3_PUBLIC_BASE) return `${S3_PUBLIC_BASE}/${key}`;
  return `${(process.env.S3_ENDPOINT || '').replace(/\/$/, '')}/${process.env.S3_BUCKET}/${key}`;
}
async function s3Upload(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET, Key: key, Body: buffer,
    ContentType: contentType || 'application/octet-stream', ACL: 'public-read',
  }));
}
async function s3Delete(key) {
  if (!key) return;
  try { await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })); }
  catch (e) { console.warn('Не удалось удалить объект из S3:', key, e.message); }
}
function rowToTrack(row) {
  return {
    id: row.id, title: row.title, artist: row.artist, album: row.album,
    hook: row.hook, lyrics: row.lyrics,
    lines: JSON.parse(row.lines || '[]'),
    syncPct: row.syncPct,
    categories: JSON.parse(row.categories || '[]'),
    audioUrl: s3PublicUrl(row.audioKey),
    photoUrl: s3PublicUrl(row.photoKey),
    createdAt: row.createdAt,
  };
}

/* ---- API: общий банк треков ---- */
app.get('/api/tracks', (req, res) => {
  const rows = db.prepare('SELECT * FROM tracks ORDER BY createdAt DESC').all();
  res.json(rows.map(rowToTrack));
});

app.put('/api/tracks/:id', (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const existing = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
    const createdAt = existing ? existing.createdAt : (b.createdAt || Date.now());
    db.prepare(`
      INSERT INTO tracks (id, title, artist, album, hook, lyrics, lines, syncPct, categories, audioKey, photoKey, audioType, createdAt)
      VALUES (@id, @title, @artist, @album, @hook, @lyrics, @lines, @syncPct, @categories, @audioKey, @photoKey, @audioType, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, artist=excluded.artist, album=excluded.album, hook=excluded.hook,
        lyrics=excluded.lyrics, lines=excluded.lines, syncPct=excluded.syncPct, categories=excluded.categories
    `).run({
      id, title: b.title || '', artist: b.artist || '', album: b.album || '',
      hook: +b.hook || 0, lyrics: b.lyrics || '',
      lines: JSON.stringify(b.lines || []), syncPct: b.syncPct == null ? null : b.syncPct,
      categories: JSON.stringify(b.categories || []),
      audioKey: existing ? existing.audioKey : null, photoKey: existing ? existing.photoKey : null,
      audioType: existing ? existing.audioType : null,
      createdAt,
    });
    res.json(rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/tracks/:id/audio', (req, res) => {
  uploadTrackFile.single('audio')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const code = uploadErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(code).json({ error: uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (лимит 50 МБ)' : 'Ошибка загрузки файла: ' + uploadErr.message });
    }
    try {
      if (!s3Enabled) return res.status(500).json({ error: 'S3 не настроен на сервере (заданы не все переменные S3_*)' });
      if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
      const id = req.params.id;
      const existing = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Трек не найден — сначала сохраните метаданные' });
      const ext = (path.extname(req.file.originalname || '') || '.mp3').replace('.', '') || 'mp3';
      const key = `audio/${id}.${ext}`;
      await s3Upload(key, req.file.buffer, req.file.mimetype);
      if (existing.audioKey && existing.audioKey !== key) await s3Delete(existing.audioKey);
      db.prepare('UPDATE tracks SET audioKey = ?, audioType = ? WHERE id = ?').run(key, req.file.mimetype, id);
      res.json({ url: s3PublicUrl(key) });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
  });
});

app.post('/api/tracks/:id/photo', (req, res) => {
  uploadTrackFile.single('photo')(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: 'Ошибка загрузки файла: ' + uploadErr.message });
    try {
      if (!s3Enabled) return res.status(500).json({ error: 'S3 не настроен на сервере (заданы не все переменные S3_*)' });
      if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
      const id = req.params.id;
      const existing = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Трек не найден — сначала сохраните метаданные' });
      const key = `photo/${id}.jpg`;
      await s3Upload(key, req.file.buffer, req.file.mimetype || 'image/jpeg');
      db.prepare('UPDATE tracks SET photoKey = ? WHERE id = ?').run(key, id);
      res.json({ url: s3PublicUrl(key) });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
  });
});

// Прокси аудио уже сохранённого трека через сервер — используется только для
// повторного авто-синхрона (нужно отдать байты в /api/transcribe). Обычное
// воспроизведение в плеере идёт напрямую по S3-ссылке (audioUrl) и этого
// прокси не касается — <audio src> не подчиняется CORS, а вот JS fetch()
// из браузера напрямую на S3 упирается в отсутствие CORS-заголовков у
// бакета, поэтому байты забираем здесь, на сервере (CORS — чисто браузерное
// ограничение, серверных запросов оно не касается).
app.get('/api/tracks/:id/audio-file', async (req, res) => {
  try {
    if (!s3Enabled) return res.status(500).json({ error: 'S3 не настроен на сервере' });
    const row = db.prepare('SELECT audioKey, audioType FROM tracks WHERE id = ?').get(req.params.id);
    if (!row || !row.audioKey) return res.status(404).json({ error: 'Аудио не найдено' });
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: row.audioKey }));
    res.set('Content-Type', row.audioType || 'audio/mpeg');
    obj.Body.pipe(res);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/tracks/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const existing = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
    if (existing) {
      if (existing.audioKey) await s3Delete(existing.audioKey);
      if (existing.photoKey) await s3Delete(existing.photoKey);
    }
    db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

/* ---- API: настройки (категории, раунды) — один общий JSON-документ ---- */
app.get('/api/settings', (req, res) => {
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  res.json(row ? JSON.parse(row.data) : null);
});
app.put('/api/settings', (req, res) => {
  try {
    db.prepare(`
      INSERT INTO settings (id, data) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data
    `).run(JSON.stringify(req.body || {}));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/transcribe', (req, res) => {
  upload.single('audio')(req, res, async (uploadErr) => {
    if (uploadErr) {
      // Ошибки multer (например, превышен лимит размера) не должны улетать
      // в дефолтный HTML-обработчик Express — фронт ждёт JSON.
      const code = uploadErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? 'Аудиофайл слишком большой для распознавания (лимит 25 МБ)'
        : 'Ошибка загрузки файла: ' + uploadErr.message;
      return res.status(code).json({ error: msg });
    }
    try {
      await transcribeHandler(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
});

async function transcribeHandler(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY не задан в переменных окружения' });
    }

    // Текст песни используется как подсказка — заметно снижает выдумки модели
    const hint = (req.body.lyricsHint || '').slice(0, 800);

    const form = new FormData();
    form.append('file', req.file.buffer, { filename: req.file.originalname });
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('language', 'ru');
    form.append('temperature', '0');
    if (hint) form.append('prompt', hint);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Whisper API error:', errText);
      return res.status(response.status).json({ error: 'Ошибка распознавания: ' + errText });
    }

    const data = await response.json();
    const words = (data.words || []).map(w => ({ word: w.word, start: w.start, end: w.end }));
    res.json({ words, duration: data.duration });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}

/* ==========================================================================
   Метаданные трека (по образцу spotDL): название, исполнитель, альбом,
   обложка — из Spotify Web API; текст песни — из открытого lyrics.ovh.
   Ключи Spotify (SPOTIFY_CLIENT_ID/SECRET) нужны только на сервере —
   в браузер они не попадают.
   ========================================================================== */

let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;

  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET не заданы в переменных окружения');
  }

  const auth = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64');

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!r.ok) {
    throw new Error('Не удалось получить токен Spotify: ' + (await r.text()));
  }

  const data = await r.json();
  spotifyToken = data.access_token;
  // обновляем токен на минуту раньше реального истечения — про запас
  spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

// Запасной источник метаданных/текста — Яндекс.Музыка (через yandex-music
// Python-библиотеку и небольшой скрипт-мост scripts/ym_lookup.py). Используется,
// только если Spotify недоступен (например, требует Premium у владельца
// приложения) или ничего не нашёл. Токен YANDEX_MUSIC_TOKEN опционален —
// поиск и метаданные у Яндекса по большей части доступны и анонимно.
function runYandexScript(mode, query) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scripts', 'ym_lookup.py');
    const proc = spawn('python3', [scriptPath, mode, query]);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', (e) => reject(new Error('python3/ym_lookup.py не найден: ' + e.message)));
    proc.on('close', () => {
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      try {
        resolve(JSON.parse(lastLine));
      } catch (e) {
        reject(new Error(stderr.trim() || 'Не удалось разобрать ответ Яндекс.Музыки'));
      }
    });
  });
}

// Поиск трека: возвращает варианты с названием, исполнителем, альбомом и обложкой.
// Сначала Spotify, при неудаче — Яндекс.Музыка как запасной источник.
app.get('/api/search-track', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Пустой запрос' });

  try {
    const token = await getSpotifyToken();
    const r = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=8`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (r.ok) {
      const data = await r.json();
      const tracks = (data.tracks?.items || []).map(t => ({
        title: t.name,
        artist: (t.artists || []).map(a => a.name).join(', '),
        album: t.album?.name || '',
        cover: t.album?.images?.[0]?.url || '',
        spotifyUrl: t.external_urls?.spotify || ''
      }));
      if (tracks.length) return res.json({ tracks, source: 'spotify' });
    } else {
      console.warn('Spotify search error, пробуем Яндекс.Музыку:', await r.text());
    }
  } catch (e) {
    console.warn('Spotify недоступен, пробуем Яндекс.Музыку:', e.message);
  }

  try {
    const result = await runYandexScript('search', q);
    if (result.error) return res.status(502).json({ error: 'Spotify и Яндекс.Музыка недоступны: ' + result.error });
    return res.json({ tracks: result.tracks || [], source: 'yandex' });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'Spotify и Яндекс.Музыка недоступны: ' + e.message });
  }
});

// Прокси для обложки: скачиваем на сервере, чтобы не упираться в CORS в браузере.
// Разрешены обложки Spotify и Яндекс.Музыки.
app.get('/api/cover-proxy', async (req, res) => {
  try {
    const url = req.query.url || '';
    if (!/^https:\/\/(i\.scdn\.co|avatars\.yandex\.net)\//.test(url)) {
      return res.status(400).json({ error: 'Некорректный URL обложки' });
    }
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    r.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Genius: официальный API отдаёт только ссылку на страницу песни (сам текст
// через API не отдают специально), поэтому текст достаём из HTML страницы —
// тот же приём, что используют почти все подобные интеграции с Genius.
// Нужен бесплатный токен (GENIUS_ACCESS_TOKEN) — получить на genius.com/api-clients.
// Если токен не задан, этот источник просто пропускается.
async function tryGenius(artist, title) {
  if (!process.env.GENIUS_ACCESS_TOKEN) return null;
  try {
    const searchR = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`, {
      headers: { Authorization: `Bearer ${process.env.GENIUS_ACCESS_TOKEN}` }
    });
    if (!searchR.ok) return null;
    const searchData = await searchR.json();
    const hit = searchData?.response?.hits?.[0]?.result;
    if (!hit?.url) return null;

    const pageR = await fetch(hit.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' }
    });
    if (!pageR.ok) return null;
    const html = await pageR.text();

    const blocks = [...html.matchAll(/<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>\s*(?:<div|<\/div>)/g)];
    if (!blocks.length) return null;
    const text = blocks.map(b => b[1])
      .join('\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<a[^>]*>|<\/a>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[[^\]]*\]/g, '') // убираем пометки вида [Verse 1], [Chorus]
      .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
      .split('\n').map(s => s.trim()).filter(Boolean).join('\n');
    return text || null;
  } catch (e) {
    console.warn('Genius не сработал:', e.message);
    return null;
  }
}

// Текст песни: сначала бесплатный lyrics.ovh, затем Яндекс.Музыка, затем Genius
// (если задан токен) — три независимых источника подряд, чтобы редкие тексты
// с большей вероятностью находились автоматически. Если ни один не нашёл —
// фронт оставит поле пустым, текст впишется вручную, как и раньше.
app.get('/api/lyrics', async (req, res) => {
  const artist = (req.query.artist || '').trim();
  const title = (req.query.title || '').trim();
  if (!artist || !title) return res.status(400).json({ error: 'Нужны artist и title' });

  try {
    const r = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
    );
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.lyrics) return res.json({ lyrics: data.lyrics.trim(), source: 'lyrics.ovh' });
  } catch (e) {
    console.warn('lyrics.ovh недоступен, пробуем Яндекс.Музыку:', e.message);
  }

  try {
    const result = await runYandexScript('lyrics', `${artist} ${title}`.trim());
    if (!result.error && result.lyrics) {
      return res.json({ lyrics: result.lyrics.trim(), source: 'yandex' });
    }
  } catch (e) {
    console.warn('Яндекс.Музыка (текст) недоступна:', e.message);
  }

  try {
    const geniusText = await tryGenius(artist, title);
    if (geniusText) return res.json({ lyrics: geniusText, source: 'genius' });
  } catch (e) {
    console.warn('Genius (текст) недоступен:', e.message);
  }

  res.status(404).json({ error: 'Текст не найден' });
});

// Ищет несколько вариантов на YouTube (без скачивания) — название, канал,
// длительность, превью — чтобы можно было выбрать нужную версию вручную,
// а не слепо качать первый результат (который может оказаться кавером
// или записью с концерта).
app.get('/api/search-youtube', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Пустой запрос' });

  // player_client=android,web — обход HTTP 403 при обращении к YouTube с
  // серверных/датацентровых IP (см. комментарий у /api/fetch-audio ниже).
  const args = [`ytsearch6:${q}`, '--dump-json', '--no-warnings', '--no-playlist',
    '--extractor-args', 'youtube:player_client=android,web'];
  const proc = spawn('yt-dlp', args);
  let stdout = '', stderr = '';
  proc.stdout.on('data', d => { stdout += d; });
  proc.stderr.on('data', d => { stderr += d; });

  let responded = false;
  proc.on('error', (e) => {
    if (responded) return;
    responded = true;
    res.status(500).json({ error: 'yt-dlp не установлен на сервере (нужен Docker-деплой)' });
  });

  proc.on('close', () => {
    if (responded) return;
    responded = true;
    if (!stdout.trim()) {
      console.error('yt-dlp search error:', stderr);
      return res.status(502).json({ error: 'Ничего не нашлось или ошибка поиска на YouTube' });
    }
    const results = stdout.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean).map(v => ({
      title: v.title || '',
      uploader: v.uploader || v.channel || '',
      duration: v.duration || 0,
      thumbnail: v.thumbnail || (Array.isArray(v.thumbnails) && v.thumbnails.length ? v.thumbnails[v.thumbnails.length - 1].url : ''),
      url: v.webpage_url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : '')
    })).filter(v => v.url);
    res.json({ results });
  });
});

/* ==========================================================================
   Скачивание аудио. Основной источник — Яндекс.Музыка (та же библиотека, что
   и для метаданных/текста, см. scripts/ym_lookup.py): YouTube с 2025 года
   всё активнее блокирует скачивание с серверных/датацентровых IP (403,
   DRM-заглушки, недоступные форматы — независимо от того, каким "клиентом"
   представляется yt-dlp), а Яндекс пока так агрессивно не ограничивает.
   YouTube остаётся запасным вариантом — на случай, если трека нет на
   Яндекс.Музыке, либо когда пользователь сам выбрал конкретное видео
   (ссылка) через «Искать варианты».
   ========================================================================== */
// Запускает scripts/ym_lookup.py в режиме download: скачивает mp3 по пути outPath.
function runYandexDownload(query, outPath) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'scripts', 'ym_lookup.py');
    const proc = spawn('python3', [scriptPath, 'download', query, outPath]);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', (e) => resolve({ error: 'python3/ym_lookup.py не найден: ' + e.message }));
    proc.on('close', () => {
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      try { resolve(JSON.parse(lastLine)); }
      catch (e) { resolve({ error: stderr.trim() || 'Не удалось разобрать ответ Яндекс.Музыки' }); }
    });
  });
}

// Запускает yt-dlp с заданными аргументами и ждёт завершения процесса.
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', code => resolve({ code, stderr }));
  });
}

app.get('/api/fetch-audio', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Пустой запрос' });

  const isUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(q);

  // Текстовый запрос ("исполнитель — название") — сначала пробуем Яндекс.Музыку.
  // Прямую ссылку на конкретное YouTube-видео (пользователь явно выбрал версию
  // через «Искать варианты») через Яндекс не ищем — качаем её с YouTube напрямую.
  if (!isUrl) {
    const ymPath = path.join(os.tmpdir(), `ym-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
    const ymResult = await runYandexDownload(q, ymPath);
    if (ymResult && ymResult.ok) {
      res.set('Content-Type', 'audio/mpeg');
      const stream = fs.createReadStream(ymPath);
      stream.pipe(res);
      stream.on('close', () => fsp.unlink(ymPath).catch(() => {}));
      return;
    }
    console.warn('Яндекс.Музыка (аудио) не сработала, пробуем YouTube:', ymResult && ymResult.error);
    fsp.unlink(ymPath).catch(() => {});
  }

  // Берём топ-5 результатов поиска и скачиваем первый, что короче 10 минут —
  // так реже попадаются концертные записи/сборники вместо самого трека.
  // Файл ограничен 20 МБ (с запасом под лимит Whisper в 25 МБ на распознавание).
  const target = isUrl ? q : `ytsearch5:${q}`;
  const base = path.join(os.tmpdir(), `yt-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const baseArgs = [
    target,
    '--no-playlist',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--max-filesize', '20m',
    '--no-warnings',
    '-o', `${base}.%(ext)s`
  ];
  if (!isUrl) {
    baseArgs.push('--match-filter', 'duration < 600', '--max-downloads', '1');
  }

  // YouTube в последнее время часто отвечает "HTTP Error 403: Forbidden" на
  // запросы с серверных/датацентровых IP, если yt-dlp представляется обычным
  // веб-плеером. Разные "клиенты" (android/ios/tv) получают отдельные, не
  // всегда так же ограниченные потоки — пробуем по очереди, пока один не
  // сработает, вместо того чтобы сразу сдаваться после первой ошибки.
  const clientAttempts = ['android,web', 'ios,web', 'tv,web', null];
  let result = null;
  for (const client of clientAttempts) {
    const args = client ? [...baseArgs, '--extractor-args', `youtube:player_client=${client}`] : baseArgs;
    try {
      result = await runYtDlp(args);
    } catch (e) {
      console.error('yt-dlp не найден:', e.message);
      return res.status(500).json({ error: 'yt-dlp не установлен на сервере (нужен Docker-деплой, см. README)' });
    }
    if (result.code === 0) break;
    console.error(`yt-dlp error (client=${client || 'default'}):`, result.stderr);
  }

  if (!result || result.code !== 0) {
    return res.status(502).json({ error: 'Видео не найдено или не удалось скачать' });
  }

  try {
    const dir = path.dirname(base);
    const prefix = path.basename(base);
    const files = await fsp.readdir(dir);
    const outName = files.find(f => f.startsWith(prefix));
    if (!outName) {
      return res.status(500).json({ error: 'Файл не найден после скачивания' });
    }
    const outFile = path.join(dir, outName);
    const ext = path.extname(outName).slice(1) || 'm4a';
    const mime = ext === 'webm' ? 'audio/webm' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
    res.set('Content-Type', mime);
    const stream = fs.createReadStream(outFile);
    stream.pipe(res);
    stream.on('close', () => fsp.unlink(outFile).catch(() => {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
    console.error(e);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
