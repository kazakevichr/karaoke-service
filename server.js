require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const cors = require('cors');
const path = require('path');

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

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
