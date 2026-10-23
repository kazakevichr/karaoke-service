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
const crypto = require('crypto');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const {
  S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand,
  PutObjectAclCommand, GetBucketCorsCommand, PutBucketCorsCommand, ListObjectsV2Command,
  HeadObjectCommand, CopyObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { buildTrackListText } = require('./lib/tracklist');
const { streamBlanksPdf, MAX_PLAYERS } = require('./lib/blanks-pdf');

const app = express();
// Сервис стоит за обратным прокси Coolify: без этого req.ip — адрес прокси
// (ограничение попыток входа считало бы всех одним человеком), а req.secure
// всегда false.
app.set('trust proxy', true);
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
// Сюда раньше складывались собранные ZIP-архивы игр. Архивы больше не
// выдаются (вместо них — игра без интернета прямо в браузере ведущего), а
// папку подчищает «Закрыть доступ к файлам» на странице /admin.
const LEGACY_ZIP_CACHE_DIR = path.join(path.dirname(DB_PATH), 'zip-cache');
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
  -- Раунды ведущих. У администратора они по-прежнему в settings (id = 1),
  -- у каждого ведущего — своя строка здесь, owner = 'host:<id>'.
  CREATE TABLE IF NOT EXISTS owner_settings (
    owner TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE,
    passHash TEXT NOT NULL,
    accessUntil INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    deviceId TEXT,
    deviceBoundAt INTEGER,
    lastSeenAt INTEGER,
    createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    hostId TEXT,
    deviceId TEXT,
    createdAt INTEGER,
    expiresAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
// Сохранённые игры теперь у каждого свои: старые записи остаются за
// администратором.
if (!db.prepare('PRAGMA table_info(saved_games)').all().some(c => c.name === 'owner')) {
  db.exec("ALTER TABLE saved_games ADD COLUMN owner TEXT NOT NULL DEFAULT 'admin'");
}
const getState = key => {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  return row ? row.value : null;
};
const setState = (key, value) => db.prepare(
  'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(key, String(value));

/* ==========================================================================
   Вход и доступ.

   Роли две. Администратор входит общим паролем ADMIN_PASSWORD, как и раньше:
   ему банк треков, ведущие и хранилище. Ведущий входит своим логином и
   паролем, которые выдаёт администратор на странице /admin, и работает до
   даты, которую тот поставил. Ведущий собирает свои игры из общего банка и
   играет в них онлайн или без интернета; сам банк ему не виден.

   Логин ведущего привязывается к первому браузеру, в котором в него вошли
   (код браузера — случайная строка в его localStorage). Отдать логин
   коллеге бесполезно: на чужом компьютере вход не пройдёт, пока
   администратор не отвяжет старый.

   Сессии лежат в базе, а не в памяти процесса: иначе каждый перезапуск
   сервера выкидывал бы всех ведущих из кабинета.
   ========================================================================== */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_COOKIE = 'bank_session';
const DAY_MS = 24 * 3600 * 1000;
const SESSION_TTL_MS = 30 * DAY_MS;

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}
function checkPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
// Без похожих друг на друга символов (l/1, o/0): пароль ведущему обычно
// пересылают в мессенджере или диктуют по телефону.
function generatePassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(8), b => abc[b % abc.length]).join('');
}

/* Срок доступа — «до такого-то числа включительно» по Москве. Храним момент
   конца этого дня, а показываем дату. Часовой пояс зашит: и ведущие, и
   мероприятия здесь, а сервер живёт в UTC. */
const MSK_OFFSET_MS = 3 * 3600 * 1000;
function endOfDayMsk(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const t = Date.parse(`${dateStr}T23:59:59.999+03:00`);
  return Number.isFinite(t) ? t : null;
}
function fmtDateMsk(ms) {
  const d = new Date(ms + MSK_OFFSET_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
}
const hostActive = (h, now = Date.now()) => !!(h && h.enabled && h.accessUntil && h.accessUntil > now);
function accessEndedText(h) {
  if (!h.enabled) return 'Доступ отключён организатором.';
  if (!h.accessUntil) return 'Доступ ещё не открыт — напишите организатору.';
  return `Доступ закончился ${fmtDateMsk(h.accessUntil)}. Чтобы продлить, напишите организатору.`;
}
const DEVICE_MISMATCH_TEXT = 'Этот логин уже работает на другом компьютере или в другом браузере. Попросите организатора отвязать старый.';

function startSession(req, res, role, hostId, deviceId) {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, role, hostId, deviceId, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, role, hostId || null, deviceId || null, now, now + SESSION_TTL_MS);
  db.prepare('DELETE FROM sessions WHERE expiresAt < ?').run(now);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS, secure: req.secure });
}

function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s || s.expiresAt < Date.now()) return null;
  if (s.role === 'admin') return { role: 'admin', owner: 'admin', name: 'Администратор' };
  const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(s.hostId);
  if (!host) return null;
  return { role: 'host', owner: 'host:' + host.id, name: host.name, host, active: hostActive(host) };
}

// Когда ведущий заходил последний раз — видно на странице /admin. Пишем не
// на каждый запрос, а не чаще раза в пять минут.
function touchHost(host) {
  const now = Date.now();
  if (!host.lastSeenAt || now - host.lastSeenAt > 5 * 60 * 1000) {
    db.prepare('UPDATE hosts SET lastSeenAt = ? WHERE id = ?').run(now, host.id);
  }
}

function requireAdmin(req, res, next) {
  const u = currentUser(req);
  if (u && u.role === 'admin') { req.user = u; return next(); }
  res.status(401).json({ error: 'Нужен вход администратора', code: 'login_required' });
}
// Игра и настройка раунда: администратор или ведущий с действующим сроком.
function requirePlayer(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Нужно войти', code: 'login_required' });
  if (u.role === 'host') {
    if (!u.active) return res.status(403).json({ error: accessEndedText(u.host), code: 'access_expired' });
    touchHost(u.host);
  }
  req.user = u;
  next();
}

// Подбор пароля: не больше 10 неудачных попыток с одного адреса за 15 минут.
const loginFails = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function loginBlocked(ip) {
  const f = loginFails.get(ip);
  if (!f || Date.now() - f.since > LOGIN_WINDOW_MS) { loginFails.delete(ip); return false; }
  return f.n >= 10;
}
function noteLoginFail(ip) {
  const f = loginFails.get(ip);
  if (!f || Date.now() - f.since > LOGIN_WINDOW_MS) loginFails.set(ip, { n: 1, since: Date.now() });
  else f.n++;
}

/* Вход. Без логина или с логином admin — пароль администратора (так
   по-прежнему входит форма на странице банка), иначе — ведущий. */
app.post('/api/login', (req, res) => {
  if (loginBlocked(req.ip)) return res.status(429).json({ error: 'Слишком много неудачных попыток. Подождите 15 минут.' });
  const b = req.body || {};
  const login = String(b.login || '').trim().toLowerCase();
  const password = String(b.password || '');

  if (!login || login === 'admin') {
    if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD не задан на сервере — вход администратора не настроен' });
    if (!safeEqual(password, ADMIN_PASSWORD)) { noteLoginFail(req.ip); return res.status(401).json({ error: 'Неверный пароль' }); }
    startSession(req, res, 'admin');
    return res.json({ ok: true, role: 'admin' });
  }

  const host = db.prepare('SELECT * FROM hosts WHERE login = ?').get(login);
  if (!host || !checkPassword(password, host.passHash)) {
    noteLoginFail(req.ip);
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  if (!hostActive(host)) return res.status(403).json({ error: accessEndedText(host), code: 'access_expired' });
  const deviceId = String(b.deviceId || '').slice(0, 64);
  if (!deviceId) return res.status(400).json({ error: 'Браузер не передал код компьютера — обновите страницу и попробуйте ещё раз' });
  if (host.deviceId && host.deviceId !== deviceId) {
    return res.status(403).json({ error: DEVICE_MISMATCH_TEXT, code: 'device_mismatch' });
  }
  if (!host.deviceId) db.prepare('UPDATE hosts SET deviceId = ?, deviceBoundAt = ? WHERE id = ?').run(deviceId, Date.now(), host.id);
  startSession(req, res, 'host', host.id, deviceId);
  touchHost(host);
  res.json({ ok: true, role: 'host' });
});
app.post('/api/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});
app.get('/api/auth-check', requireAdmin, (req, res) => res.json({ ok: true }));
app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.json({ role: null });
  if (u.role === 'admin') return res.json({ role: 'admin', name: u.name });
  res.json({
    role: 'host', name: u.host.name, active: u.active,
    accessUntil: u.host.accessUntil, accessUntilText: u.host.accessUntil ? fmtDateMsk(u.host.accessUntil) : '',
  });
});

/* ==========================================================================
   Лицензия для игры без интернета.

   Сохранённая в браузере игра запускается без сервера, поэтому решать,
   можно ли играть, приходится самой странице /offline. Решает она по
   лицензии: сервер выдаёт её, пока у ведущего есть доступ, и подписывает
   своим ключом. В лицензии — до какого момента разрешено играть без связи:
   три дня от выдачи, но не дольше срока доступа. Пока интернет есть,
   страница обновляет лицензию сама, так что ведущий трёхдневного предела
   обычно и не замечает. Подпись не даёт просто переписать дату в
   хранилище браузера: проверяется открытым ключом, который страница
   получает вместе с собой (/license-key.js).

   Закрытый ключ лежит рядом с базой, на постоянном томе, и создаётся при
   первом запуске. Если он потеряется, старые лицензии перестанут
   проходить проверку — страница просто запросит новые, как только
   появится интернет.
   ========================================================================== */
const OFFLINE_GRACE_MS = 3 * DAY_MS;
const LICENSE_KEY_PATH = path.join(path.dirname(DB_PATH), 'license-key.pem');
function loadLicenseKey() {
  try {
    return crypto.createPrivateKey(fs.readFileSync(LICENSE_KEY_PATH));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(LICENSE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    return privateKey;
  }
}
const licenseKey = loadLicenseKey();
const licensePublicJwk = crypto.createPublicKey(licenseKey).export({ format: 'jwk' });
// Формат подписи ieee-p1363 — тот, что понимает WebCrypto в браузере
// (по умолчанию Node подписывает в DER, и браузер такую подпись отверг бы).
function signLicense(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(body), { key: licenseKey, dsaEncoding: 'ieee-p1363' });
  return `${body}.${sig.toString('base64url')}`;
}

app.get('/api/license', requirePlayer, (req, res) => {
  const u = req.user;
  const now = Date.now();
  const deviceId = String(req.get('x-device-id') || '').slice(0, 64);
  if (u.role === 'host' && u.host.deviceId && u.host.deviceId !== deviceId) {
    return res.status(403).json({ error: DEVICE_MISMATCH_TEXT, code: 'device_mismatch' });
  }
  const accessUntil = u.role === 'host' ? u.host.accessUntil : null;
  const payload = {
    v: 1, sub: u.owner, name: u.name, device: deviceId, iat: now,
    accessUntil, offlineUntil: accessUntil ? Math.min(now + OFFLINE_GRACE_MS, accessUntil) : now + OFFLINE_GRACE_MS,
  };
  res.json({ token: signLicense(payload), payload });
});
app.get('/license-key.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.send(`window.MB_LICENSE_KEY = ${JSON.stringify(licensePublicJwk)};\n`);
});

/* ==========================================================================
   Ведущие — управление на странице /admin.
   ========================================================================== */
function hostView(h, gamesCount) {
  return {
    id: h.id, name: h.name, login: h.login, enabled: !!h.enabled, active: hostActive(h),
    accessUntil: h.accessUntil, accessUntilText: h.accessUntil ? fmtDateMsk(h.accessUntil) : '',
    deviceBound: !!h.deviceId, deviceBoundAt: h.deviceBoundAt, lastSeenAt: h.lastSeenAt,
    createdAt: h.createdAt, gamesCount: gamesCount || 0,
  };
}
const normLogin = s => String(s || '').trim().toLowerCase();
const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;

app.get('/api/hosts', requireAdmin, (req, res) => {
  const counts = {};
  db.prepare("SELECT owner, COUNT(*) n FROM saved_games WHERE owner LIKE 'host:%' GROUP BY owner").all()
    .forEach(r => { counts[r.owner] = r.n; });
  const rows = db.prepare('SELECT * FROM hosts ORDER BY createdAt DESC').all();
  res.json(rows.map(h => hostView(h, counts['host:' + h.id])));
});

app.post('/api/hosts', requireAdmin, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const login = normLogin(b.login);
  const accessUntil = endOfDayMsk(b.accessUntil);
  if (!name) return res.status(400).json({ error: 'Укажите имя ведущего' });
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'Логин — от 3 до 32 латинских букв, цифр, точек, дефисов' });
  if (login === 'admin') return res.status(400).json({ error: 'Логин admin занят администратором' });
  if (!accessUntil) return res.status(400).json({ error: 'Укажите, до какого числа открыт доступ' });
  if (db.prepare('SELECT 1 FROM hosts WHERE login = ?').get(login)) return res.status(400).json({ error: 'Такой логин уже есть' });
  const id = 'h' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const password = generatePassword();
  db.prepare(`INSERT INTO hosts (id, name, login, passHash, accessUntil, enabled, createdAt)
              VALUES (?, ?, ?, ?, ?, 1, ?)`).run(id, name, login, hashPassword(password), accessUntil, Date.now());
  res.json({ host: hostView(db.prepare('SELECT * FROM hosts WHERE id = ?').get(id)), password });
});

app.patch('/api/hosts/:id', requireAdmin, (req, res) => {
  const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(req.params.id);
  if (!host) return res.status(404).json({ error: 'Ведущий не найден' });
  const b = req.body || {};
  let password = null;
  // Отвязка, новый пароль и отключение выкидывают ведущего из уже открытых
  // сессий: иначе старый компьютер продолжал бы работать до конца сессии.
  let dropSessions = false;
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: 'Имя не может быть пустым' });
    db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(name, host.id);
  }
  if (b.accessUntil !== undefined) {
    const t = endOfDayMsk(b.accessUntil);
    if (!t) return res.status(400).json({ error: 'Неверная дата' });
    db.prepare('UPDATE hosts SET accessUntil = ? WHERE id = ?').run(t, host.id);
  }
  if (b.enabled !== undefined) {
    db.prepare('UPDATE hosts SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, host.id);
    if (!b.enabled) dropSessions = true;
  }
  if (b.resetDevice) {
    db.prepare('UPDATE hosts SET deviceId = NULL, deviceBoundAt = NULL WHERE id = ?').run(host.id);
    dropSessions = true;
  }
  if (b.resetPassword) {
    password = generatePassword();
    db.prepare('UPDATE hosts SET passHash = ? WHERE id = ?').run(hashPassword(password), host.id);
    dropSessions = true;
  }
  if (dropSessions) db.prepare('DELETE FROM sessions WHERE hostId = ?').run(host.id);
  res.json({ host: hostView(db.prepare('SELECT * FROM hosts WHERE id = ?').get(host.id)), password });
});

app.delete('/api/hosts/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const owner = 'host:' + id;
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE hostId = ?').run(id);
    db.prepare('DELETE FROM owner_settings WHERE owner = ?').run(owner);
    db.prepare('DELETE FROM saved_games WHERE owner = ?').run(owner);
    db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

/* ==========================================================================
   Хранилище (S3).

   Раньше каждый файл лежал в открытом доступе по постоянной ссылке, а список
   треков со ссылками отдавался всем подряд: скачать весь банк мог кто
   угодно. Теперь ссылки временные (подписанные, живут 12 часов — с запасом
   на вечер игры) и выдаются только вошедшим. Сами файлы закрываются одной
   кнопкой на странице /admin — см. runStorageLock ниже.

   Подписанные ссылки сервер проверяет на старте: если хранилище их вдруг не
   примет, музыка перестала бы играть совсем, поэтому в таком случае
   временно отдаём прямые ссылки и пишем об этом в лог.
   ========================================================================== */
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

const SIGNED_URL_TTL_S = 12 * 3600;
let s3UrlMode = 'signed'; // 'public' — запасной режим, пока хранилище не принимает подписанные ссылки
// Одну и ту же подписанную ссылку отдаём полсрока: так браузер может взять
// файл из своего кэша, а не качать заново на каждой перезагрузке страницы.
const signedUrlCache = new Map();
async function s3Url(key) {
  if (!key) return null;
  if (!s3Enabled || s3UrlMode !== 'signed') return s3PublicUrl(key);
  const now = Date.now();
  const hit = signedUrlCache.get(key);
  if (hit && hit.exp - now > SIGNED_URL_TTL_S * 1000 / 2) return hit.url;
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { expiresIn: SIGNED_URL_TTL_S });
  signedUrlCache.set(key, { url, exp: now + SIGNED_URL_TTL_S * 1000 });
  return url;
}
async function checkSignedUrls() {
  if (!s3Enabled) return;
  const row = db.prepare('SELECT audioKey FROM tracks WHERE audioKey IS NOT NULL LIMIT 1').get();
  if (!row) return;
  try {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: row.audioKey }), { expiresIn: 60 });
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (s3UrlMode !== 'signed') console.log('[s3] подписанные ссылки снова работают');
    s3UrlMode = 'signed';
  } catch (e) {
    s3UrlMode = 'public';
    console.warn(`[s3] хранилище не приняло подписанную ссылку (${e.message}) — отдаю прямые ссылки, проверю снова через 5 минут`);
    setTimeout(checkSignedUrls, 5 * 60 * 1000);
  }
}
checkSignedUrls();

const storageLocked = () => getState('storageLocked') === '1';
async function s3Upload(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET, Key: key, Body: buffer,
    ContentType: contentType || 'application/octet-stream',
    ACL: storageLocked() ? 'private' : 'public-read',
  }));
}
async function s3Delete(key) {
  if (!key) return;
  try { await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })); }
  catch (e) { console.warn('Не удалось удалить объект из S3:', key, e.message); }
}

// Откуда страницы сервиса ходят в хранилище за файлами. Нужно для правила
// CORS: без него браузер не даст странице скачать аудио себе для игры без
// интернета (просто проиграть файл он даёт и так).
function appOrigins(req) {
  const list = (process.env.APP_ORIGINS || 'https://muzbingo.dobro-inc.com,https://muzbingo.dobro-inc.ru')
    .split(',').map(s => s.trim()).filter(Boolean);
  const own = req.get('origin') || `${req.protocol}://${req.get('host')}`;
  if (own && !list.includes(own)) list.push(own);
  return list;
}

async function runWithLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/* «Закрыть доступ к файлам» на странице /admin. Три шага:
   1) правило CORS, чтобы страницы сервиса могли скачивать файлы для игры
      без интернета;
   2) все аудио и обложки банка становятся закрытыми — открываются только
      по временной ссылке от сервера;
   3) удаляются старые ZIP-архивы игр — и в хранилище, и на диске сервера.
   Файлов сотни, поэтому идёт фоном, а страница спрашивает прогресс. */
let lockJob = null;
async function runStorageLock(origins) {
  const bucket = process.env.S3_BUCKET;
  const job = lockJob = { state: 'running', step: 'cors', done: 0, total: 0, missing: 0, failed: 0, zipsDeleted: 0, cors: null, error: null };
  try {
    try {
      let rules = [];
      try { rules = (await s3.send(new GetBucketCorsCommand({ Bucket: bucket }))).CORSRules || []; }
      catch (e) { if (!/NoSuchCORS/i.test(e.name || '')) throw e; }
      const ours = {
        ID: 'muzbingo', AllowedOrigins: origins, AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'],
        ExposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'], MaxAgeSeconds: 3600,
      };
      await s3.send(new PutBucketCorsCommand({
        Bucket: bucket, CORSConfiguration: { CORSRules: [...rules.filter(r => r.ID !== 'muzbingo'), ours] },
      }));
      job.cors = 'ok';
    } catch (e) {
      job.cors = e.message || String(e);
      console.warn('[storage-lock] CORS не настроен:', e);
    }

    job.step = 'acl';
    const keys = new Set();
    db.prepare('SELECT audioKey, photoKey FROM tracks').all().forEach(r => {
      if (r.audioKey) keys.add(r.audioKey);
      if (r.photoKey) keys.add(r.photoKey);
    });
    db.prepare('SELECT data FROM saved_games').all().forEach(r => {
      Object.values(JSON.parse(r.data).tracks || {}).forEach(t => {
        if (t.audioKey) keys.add(t.audioKey);
        if (t.photoKey) keys.add(t.photoKey);
      });
    });
    job.total = keys.size;
    const isMissing = e => e.name === 'NoSuchKey' || e.name === 'NotFound' || (e.$metadata && e.$metadata.httpStatusCode === 404);
    // Не каждое S3-совместимое хранилище умеет менять права у готового
    // файла. Тогда файл копируется сам в себя уже закрытым — результат тот
    // же, только тип файла надо передать заново, иначе он потеряется.
    // Есть ли файл на самом деле, решает HeadObject: на незнакомую команду
    // некоторые хранилища тоже отвечают 404.
    async function makePrivate(key) {
      try {
        await s3.send(new PutObjectAclCommand({ Bucket: bucket, Key: key, ACL: 'private' }));
        return;
      } catch (e) { /* пробуем копией ниже */ }
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      await s3.send(new CopyObjectCommand({
        Bucket: bucket, Key: key, CopySource: `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
        ACL: 'private', MetadataDirective: 'REPLACE', ContentType: head.ContentType,
      }));
    }
    await runWithLimit([...keys], 6, async key => {
      try { await makePrivate(key); }
      catch (e) {
        if (isMissing(e)) job.missing++;
        else { job.failed++; console.warn('[storage-lock] не закрылся', key, e.message); }
      }
      job.done++;
    });
    if (!job.failed) {
      setState('storageLocked', '1');
      setState('storageLockedAt', Date.now());
    }

    job.step = 'zips';
    let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'offline-games/', ContinuationToken: token }));
      for (const o of r.Contents || []) { await s3Delete(o.Key); job.zipsDeleted++; }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    await fsp.rm(LEGACY_ZIP_CACHE_DIR, { recursive: true, force: true });
    job.state = 'done';
  } catch (e) {
    console.error('[storage-lock]', e);
    job.state = 'error';
    job.error = e.message || String(e);
  }
}

// Проба одного файла банка: открыт ли он без ссылки от сервера и отдаёт ли
// хранилище заголовки CORS для страниц сервиса.
async function probeStorage(origin) {
  const row = db.prepare('SELECT audioKey FROM tracks WHERE audioKey IS NOT NULL LIMIT 1').get();
  if (!s3Enabled || !row) return {};
  const out = {};
  try { out.publicReadable = (await fetch(s3PublicUrl(row.audioKey), { headers: { Range: 'bytes=0-0' } })).ok; }
  catch (e) { out.publicReadable = null; }
  if (s3UrlMode === 'signed') {
    try {
      const r = await fetch(await s3Url(row.audioKey), { headers: { Range: 'bytes=0-0', Origin: origin } });
      out.signedOk = r.ok;
      out.corsOk = !!r.headers.get('access-control-allow-origin');
    } catch (e) { out.signedOk = false; }
  }
  return out;
}

app.get('/api/storage', requireAdmin, async (req, res) => {
  try {
    const probe = await probeStorage(appOrigins(req)[0]);
    res.json({
      enabled: s3Enabled, urlMode: s3UrlMode, locked: storageLocked(),
      lockedAt: +getState('storageLockedAt') || null, job: lockJob, ...probe,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
app.post('/api/storage/lock', requireAdmin, (req, res) => {
  if (!s3Enabled) return res.status(400).json({ error: 'Хранилище не настроено' });
  if (s3UrlMode !== 'signed') {
    return res.status(400).json({ error: 'Хранилище сейчас не принимает временные ссылки — если закрыть файлы, музыка перестанет играть. Закрывать нельзя, смотрите лог сервера.' });
  }
  if (!(lockJob && lockJob.state === 'running')) runStorageLock(appOrigins(req));
  res.json({ ok: true, job: lockJob });
});

async function rowToTrack(row, withMedia = true) {
  return {
    id: row.id, title: row.title, artist: row.artist, album: row.album,
    hook: row.hook, lyrics: row.lyrics,
    lines: JSON.parse(row.lines || '[]'),
    syncPct: row.syncPct,
    categories: JSON.parse(row.categories || '[]'),
    audioUrl: withMedia ? await s3Url(row.audioKey) : null,
    photoUrl: withMedia ? await s3Url(row.photoKey) : null,
    createdAt: row.createdAt,
  };
}

/* ---- API: настройки (категории, раунды) ----
   У администратора — общий документ в settings, как раньше. У ведущего —
   свой, в owner_settings. Категории у всех одни — те, что заведены в банке
   треков; ведущий их не меняет. */
function freshRound() { return { category: '', size: 30, map: {}, played: {}, history: [], blanks: null }; }
function adminSettings() {
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  return row ? JSON.parse(row.data) : null;
}
function bankCategories() {
  const s = adminSettings();
  return s && Array.isArray(s.categories) && s.categories.length ? s.categories : ['Общая'];
}
function loadOwnerSettings(user) {
  if (user.role === 'admin') return adminSettings();
  const row = db.prepare('SELECT data FROM owner_settings WHERE owner = ?').get(user.owner);
  const s = row ? JSON.parse(row.data) : { activeRound: 0, rounds: [freshRound(), freshRound(), freshRound()] };
  s.categories = bankCategories();
  return s;
}

/* ---- API: общий банк треков ----
   Ведущему ссылки на аудио и обложки выдаём только для треков из его
   текущих раундов: играть ему нужны только они, а весь банк целиком ему
   ни к чему. */
app.get('/api/tracks', requirePlayer, async (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM tracks ORDER BY createdAt DESC').all();
    let withMedia = null;
    if (req.user.role === 'host') {
      withMedia = new Set();
      (loadOwnerSettings(req.user).rounds || []).forEach(r => Object.values(r.map || {}).forEach(id => { if (id) withMedia.add(id); }));
    }
    res.json(await Promise.all(rows.map(r => rowToTrack(r, !withMedia || withMedia.has(r.id)))));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.put('/api/tracks/:id', requireAdmin, async (req, res) => {
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
    res.json(await rowToTrack(db.prepare('SELECT * FROM tracks WHERE id = ?').get(id)));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/tracks/:id/audio', requireAdmin, (req, res) => {
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
      res.json({ url: await s3Url(key) });
    } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
  });
});

app.post('/api/tracks/:id/photo', requireAdmin, (req, res) => {
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
      res.json({ url: await s3Url(key) });
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
app.get('/api/tracks/:id/audio-file', requireAdmin, async (req, res) => {
  try {
    if (!s3Enabled) return res.status(500).json({ error: 'S3 не настроен на сервере' });
    const row = db.prepare('SELECT audioKey, audioType FROM tracks WHERE id = ?').get(req.params.id);
    if (!row || !row.audioKey) return res.status(404).json({ error: 'Аудио не найдено' });
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: row.audioKey }));
    res.set('Content-Type', row.audioType || 'audio/mpeg');
    obj.Body.pipe(res);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/tracks/:id', requireAdmin, async (req, res) => {
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

app.get('/api/settings', requirePlayer, (req, res) => {
  res.json(loadOwnerSettings(req.user));
});
app.put('/api/settings', requirePlayer, (req, res) => {
  try {
    if (req.user.role === 'admin') {
      db.prepare(`
        INSERT INTO settings (id, data) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data
      `).run(JSON.stringify(req.body || {}));
    } else {
      const { categories, ...own } = req.body || {};
      db.prepare(`
        INSERT INTO owner_settings (owner, data) VALUES (?, ?)
        ON CONFLICT(owner) DO UPDATE SET data = excluded.data
      `).run(req.user.owner, JSON.stringify(own));
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

/* ---- API: сохранённые игры ----
   "Сохранить игру" фиксирует текущую раскладку треков по числам в раундах как
   отдельный именованный снимок в базе — независимо от того, что случится с
   общим банком треков потом. Снимок хранит копию метаданных нужных треков
   (название/исполнитель/текст/тайминги), поэтому текст и синхронизация не
   пострадают, даже если исходный трек потом отредактируют или удалят из банка.
   Сами аудиофайлы в снимке НЕ дублируются в S3 (остаётся только ссылка-ключ) —
   если трек удалят из банка позже, его аудио пропадёт и из игры.

   У каждого свои сохранённые игры: ведущий видит только собственные. */
const ownGame = (req, id) => db.prepare('SELECT * FROM saved_games WHERE id = ? AND owner = ?').get(id, req.user.owner);

app.post('/api/saved-games', requirePlayer, (req, res) => {
  try {
    const { name, rounds } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название игры' });
    if (!Array.isArray(rounds)) return res.status(400).json({ error: 'Нет данных раундов' });

    // Раунды без единого расставленного трека в снимок не берём — игре
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
    db.prepare('INSERT INTO saved_games (id, name, createdAt, data, owner) VALUES (?, ?, ?, ?, ?)')
      .run(id, name.trim(), createdAt, JSON.stringify(data), req.user.owner);
    res.json({ id, name: name.trim(), createdAt });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/saved-games', requirePlayer, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, name, createdAt, data FROM saved_games WHERE owner = ? ORDER BY createdAt DESC').all(req.user.owner);
    res.json(rows.map(r => {
      const data = JSON.parse(r.data);
      const nonEmpty = (data.rounds || []).filter(rr => Object.keys(rr.map || {}).length);
      const roundsCount = nonEmpty.length;
      const trackCount = Object.keys(data.tracks || {}).length;
      // Сколько треков расставлено в каждом блоке. Нужно генератору бланков:
      // клеток на бланке всегда 25, и если в блоке треков меньше, часть клеток
      // останется пустой — про это стоит предупредить ДО печати тиража.
      const roundSizes = nonEmpty.map(rr => new Set(Object.values(rr.map || {}).filter(Boolean)).size);
      return { id: r.id, name: r.name, createdAt: r.createdAt, roundsCount, trackCount, roundSizes };
    }));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/saved-games/:id', requirePlayer, (req, res) => {
  try {
    db.prepare('DELETE FROM saved_games WHERE id = ? AND owner = ?').run(req.params.id, req.user.owner);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

/* Игра для работы без интернета: снимок раскладки плюс временные ссылки на
   аудио и обложки. Страница игры скачивает всё это себе в браузер
   (offline-store.js), дальше сервер не нужен. */
app.get('/api/saved-games/:id/offline', requirePlayer, async (req, res) => {
  try {
    const row = ownGame(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Игра не найдена' });
    const data = JSON.parse(row.data);
    const tracks = {};
    for (const [id, t] of Object.entries(data.tracks || {})) {
      tracks[id] = {
        id, title: t.title, artist: t.artist, album: t.album, hook: t.hook, lines: t.lines || [],
        audioKey: t.audioKey || null, photoKey: t.photoKey || null, audioType: t.audioType || null,
        audioUrl: await s3Url(t.audioKey), photoUrl: await s3Url(t.photoKey),
      };
    }
    res.json({ id: row.id, name: row.name, savedAt: row.createdAt, rounds: data.rounds, tracks });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

/* Запасной путь для того же скачивания — файл через сам сервер. Нужен, пока
   у хранилища не настроено правило CORS: без него браузер не отдаёт
   странице байты файла напрямую из хранилища. Путь медленный, поэтому
   только запасной. Отдаём лишь файлы, которые есть в этой игре. */
app.get('/api/saved-games/:id/media', requirePlayer, async (req, res) => {
  try {
    const row = ownGame(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Игра не найдена' });
    const key = String(req.query.key || '');
    const inGame = Object.values(JSON.parse(row.data).tracks || {}).some(t => t.audioKey === key || t.photoKey === key);
    if (!key || !inGame || !s3Enabled) return res.status(404).json({ error: 'Файл не найден' });
    const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    res.set('Content-Type', obj.ContentType || 'application/octet-stream');
    if (obj.ContentLength) res.set('Content-Length', String(obj.ContentLength));
    obj.Body.pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Имя файла для скачивания. Кириллицу в Content-Disposition кладём через
// filename* (RFC 5987) — простой filename="" её не переживает. Но filename=""
// всё равно обязателен как запасной вариант, и подставлять туда русское имя,
// побитое в «_________ 90-_», незачем: транслитерируем, чтобы даже в запасном
// варианте читалось «Vecherinka 90-h — blanki».
const TRANSLIT = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
  н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',
  ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};
function translit(s) {
  return [...s].map(ch => {
    const low = ch.toLowerCase();
    if (!(low in TRANSLIT)) return ch;
    const t = TRANSLIT[low];
    return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
  }).join('');
}
function contentDisposition(name, ext) {
  const safe = (name || 'game').replace(/[^a-zA-Zа-яА-ЯёЁ0-9 _-]/g, ' ').replace(/\s+/g, ' ').trim() || 'game';
  const ascii = translit(safe).replace(/[^\x20-\x7E]/g, '_') || 'game';
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(safe)}.${ext}`;
}

/* Текстовый состав сохранённой игры: блок, номер, название, исполнитель +
   секция с проверкой на повторы. Нужен, чтобы перед печатью бланков глазами
   или через ИИ убедиться, что один и тот же трек не попал в два блока —
   правило музлото: за игру трек звучит ровно один раз. Логика сборки текста
   лежит в lib/tracklist.js. */
app.get('/api/saved-games/:id/tracklist', requirePlayer, (req, res) => {
  try {
    const row = ownGame(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Игра не найдена' });
    const text = buildTrackListText(row);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    // inline вместо attachment — если открыть ссылку в новой вкладке, список
    // сразу видно в браузере; кнопка «скачать» на клиенте всё равно сохраняет
    // файл через Blob, так что оба сценария закрыты.
    if (req.query.download === '1') res.setHeader('Content-Disposition', contentDisposition(`${row.name} — треки`, 'txt'));
    // BOM — иначе Блокнот Windows открывает UTF-8 без него кракозябрами.
    res.send('﻿' + text);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

/* PDF с бланками участников по сохранённой игре. Всё, что нужно указать, —
   количество участников: раскладка блоков уже зафиксирована в снимке игры,
   поэтому бланки собираются сами и гарантированно совпадают с тем, что
   реально прозвучит. На каждого участника — по бланку на каждый блок
   (обычно три листа за игру). Страницы идут по блокам: сначала весь первый
   блок, потом второй, потом третий. Отрисовка — в lib/blanks-pdf.js. */
app.get('/api/saved-games/:id/blanks.pdf', requirePlayer, async (req, res) => {
  try {
    const row = ownGame(req, req.params.id);
    if (!row) return res.status(404).json({ error: 'Игра не найдена' });

    const players = Math.max(1, Math.min(MAX_PLAYERS, parseInt(req.query.players, 10) || 1));
    const design = {
      title: (req.query.title || '').trim() || 'МУЗЫКАЛЬНОЕ ЛОТО',
      nomination: (req.query.nomination || '').trim(),
      tagline: (req.query.tagline || '').trim(),
      qrUrl: (req.query.qrUrl || '').trim(),
    };

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(`${row.name} — бланки ${players} уч`, 'pdf'));
    await streamBlanksPdf(res, row, players, design);
  } catch (e) {
    console.error('[blanks.pdf]', e);
    // Заголовки могли уже уйти вместе с началом PDF — тогда честно рвём
    // соединение, иначе браузер сохранит битый файл, считая его целым.
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.destroy();
  }
});

app.post('/api/transcribe', requireAdmin, (req, res) => {
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
app.get('/api/search-track', requireAdmin, async (req, res) => {
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
app.get('/api/cover-proxy', requireAdmin, async (req, res) => {
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
app.get('/api/lyrics', requireAdmin, async (req, res) => {
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
app.get('/api/search-youtube', requireAdmin, async (req, res) => {
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

app.get('/api/fetch-audio', requireAdmin, async (req, res) => {
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

/* ==========================================================================
   Страницы. Игра и настройка раунда — только после входа (администратор
   или ведущий с действующим сроком), банк треков и ведущие — только
   администратору. Страница /offline открывается без сервера вообще: её
   отдаёт браузеру сервис-воркер (public/sw.js), а пускать ли в игру, она
   решает сама по лицензии.
   ========================================================================== */
const sendPage = (res, file) => res.sendFile(path.join(__dirname, 'public', file));
function playerPage(file) {
  return (req, res) => {
    const u = currentUser(req);
    if (!u) return res.redirect('/login?next=' + encodeURIComponent(req.path));
    if (u.role === 'host' && !u.active) return res.redirect('/login?expired=1');
    sendPage(res, file);
  };
}
app.get('/', playerPage('game.html'));
app.get('/setup', playerPage('setup.html'));
app.get('/bank', (req, res) => sendPage(res, 'bank.html'));
app.get('/admin', (req, res) => {
  const u = currentUser(req);
  if (!u || u.role !== 'admin') return res.redirect('/login?next=/admin');
  sendPage(res, 'admin.html');
});
app.get('/login', (req, res) => sendPage(res, 'login.html'));
app.get('/offline', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  sendPage(res, 'offline.html');
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
