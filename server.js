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

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // лимит Whisper API — 25 МБ
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
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
});

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

// Поиск трека: возвращает варианты с названием, исполнителем, альбомом и обложкой
app.get('/api/search-track', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Пустой запрос' });

    const token = await getSpotifyToken();
    const r = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=8`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!r.ok) {
      const errText = await r.text();
      console.error('Spotify search error:', errText);
      return res.status(r.status).json({ error: 'Ошибка поиска в Spotify' });
    }

    const data = await r.json();
    const tracks = (data.tracks?.items || []).map(t => ({
      title: t.name,
      artist: (t.artists || []).map(a => a.name).join(', '),
      album: t.album?.name || '',
      cover: t.album?.images?.[0]?.url || '',
      spotifyUrl: t.external_urls?.spotify || ''
    }));

    res.json({ tracks });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// Прокси для обложки: скачиваем на сервере, чтобы не упираться в CORS в браузере
app.get('/api/cover-proxy', async (req, res) => {
  try {
    const url = req.query.url || '';
    if (!/^https:\/\/i\.scdn\.co\//.test(url)) {
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

// Текст песни: бесплатный источник без ключа. Если не нашёл — фронт просто
// оставит поле пустым, пользователь впишет текст вручную.
app.get('/api/lyrics', async (req, res) => {
  try {
    const artist = (req.query.artist || '').trim();
    const title = (req.query.title || '').trim();
    if (!artist || !title) return res.status(400).json({ error: 'Нужны artist и title' });

    const r = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
    );
    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data.lyrics) {
      return res.status(404).json({ error: 'Текст не найден' });
    }

    res.json({ lyrics: data.lyrics.trim() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ==========================================================================
   Скачивание аудио с YouTube (как spotDL: ищет трек по названию/исполнителю
   и скачивает лучший аудио-поток). Требует установленный yt-dlp в PATH —
   см. Dockerfile. Без транскодирования (не нужен ffmpeg): отдаём файл в
   исходном контейнере (обычно m4a или webm), браузер его прекрасно
   воспроизводит и Whisper прекрасно распознаёт.
   ========================================================================== */
app.get('/api/fetch-audio', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Пустой запрос' });

  const isUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(q);
  const target = isUrl ? q : `ytsearch1:${q}`;
  const base = path.join(os.tmpdir(), `yt-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const args = [
    target,
    '--no-playlist',
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    '--max-filesize', '30m',
    '--no-warnings',
    '-o', `${base}.%(ext)s`
  ];

  const proc = spawn('yt-dlp', args);
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });

  let responded = false;
  proc.on('error', (e) => {
    if (responded) return;
    responded = true;
    console.error('yt-dlp не найден:', e.message);
    res.status(500).json({ error: 'yt-dlp не установлен на сервере (нужен Docker-деплой, см. README)' });
  });

  proc.on('close', async (code) => {
    if (responded) return;
    if (code !== 0) {
      responded = true;
      console.error('yt-dlp error:', stderr);
      return res.status(502).json({ error: 'Видео не найдено или не удалось скачать' });
    }
    try {
      const dir = path.dirname(base);
      const prefix = path.basename(base);
      const files = await fsp.readdir(dir);
      const outName = files.find(f => f.startsWith(prefix));
      if (!outName) {
        responded = true;
        return res.status(500).json({ error: 'Файл не найден после скачивания' });
      }
      const outFile = path.join(dir, outName);
      const ext = path.extname(outName).slice(1) || 'm4a';
      const mime = ext === 'webm' ? 'audio/webm' : ext === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
      responded = true;
      res.set('Content-Type', mime);
      const stream = fs.createReadStream(outFile);
      stream.pipe(res);
      stream.on('close', () => fsp.unlink(outFile).catch(() => {}));
    } catch (e) {
      if (!responded) { responded = true; res.status(500).json({ error: e.message }); }
      console.error(e);
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
