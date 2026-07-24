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
const archiver = require('archiver');

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
  CREATE TABLE IF NOT EXISTS saved_games (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt INTEGER,
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

/* ---- API: сохранённые игры (для оффлайн-скачивания) ----
   "Сохранить игру" фиксирует текущую раскладку треков по числам в раундах как
   отдельный именованный снимок в базе — независимо от того, что случится с
   общим банком треков потом. Снимок хранит копию метаданных нужных треков
   (название/исполнитель/текст/тайминги), поэтому текст и синхронизация не
   пострадают, даже если исходный трек потом отредактируют или удалят из банка.
   Сами аудиофайлы в снимке НЕ дублируются в S3 (остаётся только ссылка-ключ) —
   если трек удалят из банка позже, его аудио пропадёт из архива при скачивании
   (сознательный компромисс, см. обсуждение ТЗ). */
app.post('/api/saved-games', (req, res) => {
  try {
    const { name, rounds } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название игры' });
    if (!Array.isArray(rounds)) return res.status(400).json({ error: 'Нет данных раундов' });

    // Раунды без единого расставленного трека в снимок не берём — офлайн-игре
    // от них всё равно никакой пользы, только пустая вкладка.
    const nonEmptyRounds = rounds.filter(r => r.map && Object.values(r.map).some(Boolean));
    if (!nonEmptyRounds.length) {
      return res.status(400).json({ error: 'Нечего сохранять — сначала расставьте треки хотя бы в одном раунде («Разыграть раунд»)' });
    }

    const trackIds = new Set();
    nonEmptyRounds.forEach(r => Object.values(r.map || {}).forEach(id => { if (id) trackIds.add(id); }));

    const tracksSnapshot = {};
    trackIds.forEach(id => {
      const row = db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
      if (row) {
        tracksSnapshot[id] = {
          id: row.id, title: row.title, artist: row.artist, album: row.album, hook: row.hook,
          lyrics: row.lyrics, lines: JSON.parse(row.lines || '[]'), syncPct: row.syncPct,
          audioKey: row.audioKey, audioType: row.audioType, photoKey: row.photoKey,
        };
      }
    });

    const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const data = {
      rounds: nonEmptyRounds.map(r => ({ category: r.category || '', size: +r.size || 0, map: r.map || {} })),
      tracks: tracksSnapshot,
    };
    const createdAt = Date.now();
    db.prepare('INSERT INTO saved_games (id, name, createdAt, data) VALUES (?, ?, ?, ?)')
      .run(id, name.trim(), createdAt, JSON.stringify(data));
    res.json({ id, name: name.trim(), createdAt });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/saved-games', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, name, createdAt, data FROM saved_games ORDER BY createdAt DESC').all();
    res.json(rows.map(r => {
      const data = JSON.parse(r.data);
      const roundsCount = (data.rounds || []).filter(rr => Object.keys(rr.map || {}).length).length;
      const trackCount = Object.keys(data.tracks || {}).length;
      return { id: r.id, name: r.name, createdAt: r.createdAt, roundsCount, trackCount };
    }));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/saved-games/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM saved_games WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Собирает ZIP с оффлайн-версией конкретной сохранённой игры: HTML-плеер без
// сети (сетка чисел, розыгрыш, караоке, бланки — без редактора банка) + аудио
// и обложки рядом файлами. Стримит архив сразу в ответ — без временных файлов
// на диске и без буферизации целых аудиофайлов в памяти (каждый идёт из S3
// прямо в архив как поток).
const OFFLINE_TEMPLATE_PATH = path.join(__dirname, 'public', 'offline-template.html');
app.get('/api/saved-games/:id/download', async (req, res) => {
  const t0 = Date.now();
  const log = (...args) => console.log(`[download ${req.params.id} +${Date.now() - t0}ms]`, ...args);
  try {
    log('старт');
    const row = db.prepare('SELECT * FROM saved_games WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Игра не найдена' });
    const data = JSON.parse(row.data);
    log('запись из БД получена, треков:', Object.keys(data.tracks || {}).length);

    let template;
    try { template = fs.readFileSync(OFFLINE_TEMPLATE_PATH, 'utf8'); }
    catch (e) { return res.status(500).json({ error: 'Оффлайн-шаблон не найден на сервере' }); }
    log('шаблон прочитан, размер:', template.length);

    const offlineTracks = {};
    for (const [tid, t] of Object.entries(data.tracks || {})) {
      const audioExt = t.audioKey ? (path.extname(t.audioKey) || '.mp3') : null;
      const photoExt = t.photoKey ? (path.extname(t.photoKey) || '.jpg') : null;
      offlineTracks[tid] = {
        id: t.id, title: t.title, artist: t.artist, album: t.album, hook: t.hook,
        lyrics: t.lyrics, lines: t.lines, syncPct: t.syncPct,
        audioFile: audioExt ? `audio/${tid}${audioExt}` : null,
        photoFile: photoExt ? `photos/${tid}${photoExt}` : null,
      };
    }
    const offlineData = { name: row.name, savedAt: row.createdAt, rounds: data.rounds, tracks: offlineTracks };
    const html = template.replace(
      '/*__GAME_DATA__*/null',
      JSON.stringify(offlineData).replace(/</g, '\\u003c')
    );
    log('HTML собран, размер:', html.length);

    const safeName = (row.name || 'game').replace(/[^a-zA-Zа-яА-Я0-9 _-]/g, '').trim() || 'game';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', w => log('архив warning:', w.message));
    archive.on('error', err => { log('архив error:', err.message); try { res.end(); } catch {} });
    archive.on('entry', entry => log('архив entry добавлен:', entry.name));
    archive.on('end', () => log('архив end (все данные переданы в поток)'));
    res.on('close', () => log('res closed, headersSent=', res.headersSent, 'writableEnded=', res.writableEnded));
    archive.pipe(res);

    archive.append(html, { name: 'игра.html' });
    log('игра.html добавлена в очередь архива');

    if (s3Enabled) {
      for (const [tid, t] of Object.entries(data.tracks || {})) {
        if (t.audioKey) {
          try {
            log(`аудио ${tid}: запрос S3 начат, key=${t.audioKey}`);
            const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: t.audioKey }));
            log(`аудио ${tid}: ответ S3 получен`);
            const ext = path.extname(t.audioKey) || '.mp3';
            archive.append(obj.Body, { name: `audio/${tid}${ext}` });
            log(`аудио ${tid}: добавлено в архив`);
          } catch (e) { log(`аудио ${tid}: ОШИБКА S3:`, e.message); }
        }
        if (t.photoKey) {
          try {
            log(`фото ${tid}: запрос S3 начат, key=${t.photoKey}`);
            const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: t.photoKey }));
            log(`фото ${tid}: ответ S3 получен`);
            const ext = path.extname(t.photoKey) || '.jpg';
            archive.append(obj.Body, { name: `photos/${tid}${ext}` });
            log(`фото ${tid}: добавлено в архив`);
          } catch (e) { log(`фото ${tid}: ОШИБКА S3:`, e.message); }
        }
      }
    } else {
      log('s3Enabled=false — файлы не добавляются, только игра.html');
    }

    log('вызываю archive.finalize()');
    await archive.finalize();
    log('archive.finalize() промис разрешён');
  } catch (e) {
    log('ИСКЛЮЧЕНИЕ:', e.message);
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else { try { res.end(); } catch {} }
  }
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

// Вырезает содержимое каждого <div data-lyrics-container="true">...</div>,
// ПРАВИЛЬНО считая вложенные <div> (внутри лежат ещё вложенные div'ы —
// например, вокруг ссылок на исполнителей в строке или переносов), а не
// наивным нежадным regex'ом до первого попавшегося </div>: он обрывался на
// самом первом вложенном закрывающем тэге и вместо текста песни возвращал
// обрывок вроде "11 ContributorsTranslationsRomanization" — служебный
// заголовок страницы, а не сам текст. Отсюда и жалобы на "неполный текст".
function extractGeniusContainers(html) {
  const containers = [];
  const openRe = /<div[^>]*\sdata-lyrics-container="true"[^>]*>/g;
  let openMatch;
  while ((openMatch = openRe.exec(html))) {
    const start = openMatch.index + openMatch[0].length;
    const tagRe = /<div\b[^>]*>|<\/div>/g;
    tagRe.lastIndex = start;
    let depth = 1, end = html.length, tagMatch;
    while ((tagMatch = tagRe.exec(html))) {
      if (tagMatch[0].startsWith('</')) depth--; else depth++;
      if (depth === 0) { end = tagMatch.index; break; }
    }
    containers.push(html.slice(start, end));
    openRe.lastIndex = end;
  }
  return containers;
}

// Разбор HTML-страницы Genius (структура одинаковая что при заходе через
// официальный API, что при обычной ссылке из веб-поиска) — самый надёжный
// источник текста из всех, что у нас есть, потому что верстка Genius строго
// размечает именно блок с текстом (data-lyrics-container), а не угадывает
// эвристикой, как для произвольных сайтов.
function parseGeniusHtml(html) {
  const blocks = extractGeniusContainers(html);
  if (!blocks.length) return null;
  let lines = blocks
    .join('\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n') // границы служебных виджетов (заголовок, аннотация) — тоже разделитель
    .replace(/<a[^>]*>|<\/a>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .split('\n').map(s => s.trim()).filter(Boolean);
  // Перед самим текстом в том же контейнере иногда лежит служебная шапка
  // страницы («12 ContributorsTranslationsRomanization<Название> Lyrics») и/или
  // абзац-аннотация об истории песни (может занимать несколько строк). Самый
  // надёжный ориентир, где эта шапка заканчивается — пометка секции вида
  // [Verse 1]/[Chorus]/[Intro] (Genius почти всегда начинает ею сам текст).
  // Бракеты убираем уже ПОСЛЕ того, как нашли по ним точку отсчёта.
  const sectionIdx = lines.findIndex(l => /^\[[^\]]+\]$/.test(l));
  if (sectionIdx > 0) {
    lines = lines.slice(sectionIdx);
  } else {
    // Явной пометки секции нет — режем эвристикой служебные строки в начале
    // (не больше 4, чтобы не задеть сам текст): шапка почти всегда содержит
    // «Contributors» или заканчивается английским «Lyrics», а аннотация
    // обычно заметно длиннее одной строки куплета.
    let stripped = 0;
    while (lines.length && stripped < 4 &&
           (/\blyrics\b/i.test(lines[0]) || /\bcontributors?\b/i.test(lines[0]) || lines[0].length > 160)) {
      lines = lines.slice(1);
      stripped++;
    }
  }
  const text = lines.map(l => l.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean).join('\n');
  // Если вышло подозрительно коротко (пара строк служебного текста, а не
  // куплет) — считаем, что разбор не удался, а не отдаём огрызок.
  if (!text || lines.length < 4) return null;
  return text;
}
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Загружает конкретную страницу genius.com и парсит её тем же способом —
// используется, когда ссылку на Genius находит обычный веб-поиск (без API/токена).
async function tryGeniusPage(url) {
  try {
    const pageR = await fetch(url, { headers: { 'User-Agent': WEB_UA } });
    if (!pageR.ok) return null;
    return parseGeniusHtml(await pageR.text());
  } catch (e) {
    console.warn('Не удалось разобрать страницу Genius:', e.message);
    return null;
  }
}

// Genius: официальный API отдаёт только ссылку на страницу песни (сам текст
// через API не отдают специально), поэтому текст достаём из HTML страницы —
// тот же приём, что используют почти все подобные интеграции с Genius.
// Нужен бесплатный токен (GENIUS_ACCESS_TOKEN) — получить на genius.com/api-clients.
// Если токен не задан, этот источник просто пропускается (см. также
// tryGeniusPage — она находит и парсит страницы Genius и без токена, через
// обычный веб-поиск).
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
    return await tryGeniusPage(hit.url);
  } catch (e) {
    console.warn('Genius не сработал:', e.message);
    return null;
  }
}

// Веб-поиск текста (как если бы человек сам погуглил "исполнитель название
// текст песни" и открыл первый подходящий сайт) — работает без токенов и
// без входа в чей-либо аккаунт. Используем HTML-версию DuckDuckGo (не требует
// JS, не банит так агрессивно, как обычный Google), берём первую ссылку не из
// чёрного списка (YouTube/соцсети/Яндекс.Музыка и т.д.) и вытаскиваем текст
// эвристикой: ищем самый длинный подряд идущий блок «строчек как в песне»
// (короткие, без мусора вроде cookie-баннеров и меню сайта).
// genius.com сюда специально НЕ входит — для него есть отдельный, гораздо более
// точный разбор по вёрстке (parseGeniusHtml/tryGeniusPage), а не эвристика ниже.
const LYRICS_SEARCH_BLOCKLIST = [
  'youtube.com', 'youtu.be', 'music.yandex', 'yandex.ru/video', 'spotify.com',
  'vk.com', 'wikipedia.org', 'apple.com/ru/music',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'ok.ru', 'tiktok.com'
];
const LYRICS_JUNK_LINE = /(cookie|реклам|войти\b|регистрац|подписат|правообладател|copyright|©|все права защищены|поделиться|коммент|javascript|подпис[а-я]*ся|скачать|mp3|плеер|найдено|результат[ыа]? поиска)/i;

function extractLyricsHeuristic(html, requireCyrillic) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');

  const rawLines = text.split('\n').map(s => s.trim());
  let best = [], current = [];
  const scoreOf = (arr) => arr.length >= 8 ? arr.length : 0;

  for (const line of rawLines) {
    const looksLikeLyricLine = line.length > 0 && line.length <= 60
      && !/^(https?:|www\.)/i.test(line) && !LYRICS_JUNK_LINE.test(line);
    if (looksLikeLyricLine) {
      current.push(line);
    } else {
      if (scoreOf(current) > scoreOf(best)) best = current;
      current = [];
    }
  }
  if (scoreOf(current) > scoreOf(best)) best = current;
  if (best.length < 8) return null;

  if (requireCyrillic) {
    const withCyrillic = best.filter(l => /[а-яё]/i.test(l)).length;
    if (withCyrillic / best.length < 0.5) return null;
  }
  return best.join('\n');
}

async function trySearchWeb(artist, title) {
  try {
    const q = encodeURIComponent(`${artist} ${title} текст песни`);
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' };
    const searchR = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, { headers });
    if (!searchR.ok) return null;
    const searchHtml = await searchR.text();

    const rawLinks = [...searchHtml.matchAll(/class="result__a"[^>]*href="([^"]+)"/g)].map(m => m[1]);
    const urls = rawLinks.map(u => {
      const m = u.match(/uddg=([^&]+)/);
      try { return m ? decodeURIComponent(m[1]) : decodeURIComponent(u); } catch { return u; }
    }).filter(u => u.startsWith('http'));

    const requireCyrillic = /[а-яё]/i.test(artist + title);
    for (const candidate of urls) {
      if (LYRICS_SEARCH_BLOCKLIST.some(b => candidate.includes(b))) continue;
      try {
        // Genius — самая чистая вёрстка из всех, разбираем её отдельным точным
        // парсером вместо общей эвристики «похоже на текст песни».
        if (candidate.includes('genius.com')) {
          const lyrics = await tryGeniusPage(candidate);
          if (lyrics) return { lyrics, sourceUrl: candidate };
          continue;
        }
        const pageR = await fetch(candidate, { headers });
        if (!pageR.ok) continue;
        const pageHtml = await pageR.text();
        const lyrics = extractLyricsHeuristic(pageHtml, requireCyrillic);
        if (lyrics) return { lyrics, sourceUrl: candidate };
      } catch { /* пробуем следующую ссылку */ }
    }
    return null;
  } catch (e) {
    console.warn('Веб-поиск текста не сработал:', e.message);
    return null;
  }
}

// Текст песни: порядок источников зависит от языка. lyrics.ovh — англоязычная
// база с нечётким сопоставлением по названию: для русских треков она нередко
// подсовывала текст совсем другой песни с похожим названием, поэтому для
// кириллицы её пропускаем и идём сразу в Яндекс.Музыку — тот же лицензированный
// источник текста, что показывает сам сервис (через scripts/ym_lookup.py,
// официальный supplement-API трека, а не догадки по HTML). Дальше в любом
// случае — веб-поиск (включая точный разбор Genius-страниц, если найдутся) и,
// напоследок, Genius по официальному API (если когда-нибудь будет токен).
// Если ни один источник не нашёл — фронт оставит поле пустым, текст впишется вручную.
app.get('/api/lyrics', async (req, res) => {
  const artist = (req.query.artist || '').trim();
  const title = (req.query.title || '').trim();
  if (!artist || !title) return res.status(400).json({ error: 'Нужны artist и title' });

  const isCyrillic = /[а-яё]/i.test(artist + title);

  async function tryYandexLyrics() {
    try {
      const result = await runYandexScript('lyrics', `${artist} ${title}`.trim());
      if (!result.error && result.lyrics && result.lyrics.trim()) return result.lyrics.trim();
    } catch (e) {
      console.warn('Яндекс.Музыка (текст) недоступна:', e.message);
    }
    return null;
  }

  if (isCyrillic) {
    const yandexLyrics = await tryYandexLyrics();
    if (yandexLyrics) return res.json({ lyrics: yandexLyrics, source: 'yandex' });
  }

  try {
    const r = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
    );
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.lyrics) return res.json({ lyrics: data.lyrics.trim(), source: 'lyrics.ovh' });
  } catch (e) {
    console.warn('lyrics.ovh недоступен:', e.message);
  }

  if (!isCyrillic) {
    const yandexLyrics = await tryYandexLyrics();
    if (yandexLyrics) return res.json({ lyrics: yandexLyrics, source: 'yandex' });
  }

  try {
    const webResult = await trySearchWeb(artist, title);
    if (webResult && webResult.lyrics) {
      let host = webResult.sourceUrl;
      try { host = new URL(webResult.sourceUrl).hostname; } catch {}
      return res.json({ lyrics: webResult.lyrics.trim(), source: `web:${host}` });
    }
  } catch (e) {
    console.warn('Веб-поиск (текст) недоступен:', e.message);
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

// То же самое, но никогда не реджектит (ошибку спавна превращает в code=-1) —
// удобно для параллельного запуска нескольких попыток разом (см. ниже).
function spawnYtDlpTracked(args) {
  const proc = spawn('yt-dlp', args);
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  const promise = new Promise(resolve => {
    proc.on('error', (e) => resolve({ code: -1, stderr, spawnError: e.message }));
    proc.on('close', code => resolve({ code, stderr }));
  });
  return { proc, promise };
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

  const buildArgs = (attemptBase, client) => {
    const args = [
      target,
      '--no-playlist',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--max-filesize', '20m',
      '--no-warnings',
      '-o', `${attemptBase}.%(ext)s`
    ];
    if (!isUrl) args.push('--match-filter', 'duration < 600', '--max-downloads', '1');
    if (client) args.push('--extractor-args', `youtube:player_client=${client}`);
    return args;
  };

  // YouTube в последнее время часто отвечает "HTTP Error 403: Forbidden" на
  // запросы с серверных/датацентровых IP, если yt-dlp представляется обычным
  // веб-плеером. Разные "клиенты" (android/ios/tv) получают отдельные, не
  // всегда так же ограниченные потоки. Раньше пробовали по очереди — что в
  // худшем случае означало 3-4 полных таймаута подряд. Теперь запускаем все
  // варианты ОДНОВРЕМЕННО (каждый — в свой временный файл) и берём первый,
  // что реально скачался; проигравших сразу убиваем и подчищаем их файлы.
  const clientAttempts = ['android,web', 'ios,web', 'tv,web', null];
  const attempts = clientAttempts.map((client, i) => {
    const attemptBase = `${base}-${i}`;
    const { proc, promise } = spawnYtDlpTracked(buildArgs(attemptBase, client));
    return { client, base: attemptBase, proc, promise };
  });

  let winner = null;
  await new Promise(resolveAll => {
    let settled = 0;
    attempts.forEach(a => {
      a.promise.then(r => {
        settled++;
        if (r.code === 0 && !winner) {
          winner = a;
          attempts.forEach(o => { if (o !== a) { try { o.proc.kill(); } catch {} } });
          resolveAll();
        } else {
          if (r.spawnError) console.error('yt-dlp не найден:', r.spawnError);
          else if (r.code !== 0) console.error(`yt-dlp error (client=${a.client || 'default'}):`, r.stderr);
          if (settled === attempts.length && !winner) resolveAll();
        }
      });
    });
  });

  // Подчищаем файлы всех проигравших попыток (если что-то успели записать до kill).
  attempts.forEach(a => {
    if (a === winner) return;
    const dir = path.dirname(a.base), prefix = path.basename(a.base);
    fsp.readdir(dir).then(files => {
      files.filter(f => f.startsWith(prefix)).forEach(f => fsp.unlink(path.join(dir, f)).catch(() => {}));
    }).catch(() => {});
  });

  if (!winner) {
    return res.status(502).json({ error: 'Видео не найдено или не удалось скачать' });
  }

  try {
    const dir = path.dirname(winner.base);
    const prefix = path.basename(winner.base);
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
