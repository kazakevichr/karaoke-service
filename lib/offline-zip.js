/* ==========================================================================
   Сборка ZIP с оффлайн-версией сохранённой игры.

   Раньше жила прямо в маршруте /api/saved-games/:id/download и падала на
   больших играх двумя способами сразу.

   1. Воркеры обгоняли архиватор. `archive.append(stream)` — это НЕ запись, а
      постановка в очередь; архиватор разбирает её строго по одному файлу.
      Воркер же, дождавшись от S3 только заголовков ответа (~150 мс), сразу
      брал следующую задачу. Для игры на 90 треков это ~180 одновременно
      открытых потоков S3, лежащих нетронутыми в очереди. У пула соединений
      AWS SDK потолок в 50 сокетов, поэтому новые запросы вставали в очередь
      и ждали, пока архиватор дочитает предыдущие. В логах это видно как
      растущие разрывы между «запрос S3 начат» и «ответ S3 получен»: сначала
      6 секунд, потом 27 — и дальше хуже. Простаивающие соединения при этом
      успевали отвалиться по таймауту, а оборванный поток в очереди вешал
      finalize() уже навсегда.

      Лечится тем, что слот в очереди берётся ДО обращения к S3: соединение
      не открывается, пока архиватору некуда принять файл. Параллелизм от
      этого ничего не теряет — архиватор всё равно пишет последовательно, —
      зато сокеты живут ровно столько, сколько реально нужно.

   2. Сборка шла внутри HTTP-запроса. Пока архив собирался (а это минуты),
      клиенту не уходило ни байта, и обратный прокси рвал «молчащее»
      соединение. Пользователь при этом навсегда оставался с надписью
      «Готовим архив…»: браузер ждал ответа, которого уже никто не пришлёт.

      Теперь сборка живёт своей жизнью в фоне, а клиент спрашивает статус
      короткими запросами. Заодно прогресс стал честным на медленном этапе:
      раньше проценты показывались только при скачивании готового файла, то
      есть на последних секундах, а всё ожидание выглядело зависанием.
   ========================================================================== */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const archiver = require('archiver');

// Сколько файлов разрешено держать в очереди архиватора одновременно.
// Смысл числа: пока архиватор дописывает один файл, следующие один-два уже
// качаются из S3 — ровно столько опережения, сколько может переварить
// последовательная запись. Больше не ускорит (архиватор всё равно один), но
// вернёт ту самую пачку простаивающих сокетов, из-за которой всё и висло.
const MAX_QUEUED_ENTRIES = 3;

// Потолок ожидания ответа S3 по одному файлу. Без него зависший запрос
// молча держит слот в очереди вечно, и сборка не заканчивается никогда —
// именно так это и выглядело со стороны: «Готовим архив…» без ошибки.
const S3_REQUEST_TIMEOUT_MS = 60_000;

/* Реестр текущих сборок: id игры → состояние. Живёт в памяти, и это
   сознательно. Перезапуск сервера сбрасывает незаконченные сборки, но
   готовые архивы лежат на диске в ZIP_CACHE_DIR и переживают рестарт, а
   недособранный архив всё равно пришлось бы начинать заново. */
const jobs = new Map();

function jobView(job) {
  if (!job) return { state: 'idle' };
  return {
    state: job.state,          // building | ready | error
    done: job.done,
    total: job.total,
    bytes: job.bytes,
    failed: job.failed.length,
    error: job.error || null,
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: превышено ожидание ${Math.round(ms / 1000)} с`)), ms);
    }),
  ]);
}

/* Готовит HTML оффлайн-плеера: шаблон + данные игры одной строкой внутри. */
function buildOfflineHtml(template, row, data) {
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
  return template.replace(
    '/*__GAME_DATA__*/null',
    JSON.stringify(offlineData).replace(/</g, '\\u003c')
  );
}

/* Собственно сборка. Пишет во временный файл и переименовывает в кэш только
   после успешного финала — иначе оборванная сборка осталась бы на диске под
   видом готового архива и отдавалась бы битой при следующем скачивании. */
async function runBuild(job, ctx) {
  const { row, cachePath, templatePath, s3, s3Bucket, GetObjectCommand, log } = ctx;
  const data = JSON.parse(row.data);

  const template = await fsp.readFile(templatePath, 'utf8');
  const html = buildOfflineHtml(template, row, data);
  log('HTML собран, размер:', html.length);

  const tmpPath = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  const archive = archiver('zip', { zlib: { level: 6 } });
  const out = fs.createWriteStream(tmpPath);

  const archiveDone = new Promise((resolve, reject) => {
    archive.on('error', reject);
    out.on('error', reject);
    out.on('close', resolve);
  });
  archive.on('warning', w => log('архив warning:', w.message));
  archive.pipe(out);

  // ---- Ограничитель очереди ----
  // Слот занимается перед обращением к S3 и освобождается, когда архиватор
  // сообщил, что файл дописан ('entry'). Всё лечение пункта 1 — здесь.
  let queued = 0;
  const waiters = [];
  const release = () => {
    queued--;
    const next = waiters.shift();
    if (next) next();
  };
  archive.on('entry', entry => {
    job.done++;
    job.bytes = out.bytesWritten;
    log('архив entry добавлен:', entry.name, `(${job.done}/${job.total})`);
    release();
  });
  const acquire = async () => {
    while (queued >= MAX_QUEUED_ENTRIES) await new Promise(r => waiters.push(r));
    queued++;
  };

  await acquire();
  archive.append(html, { name: 'игра.html' });

  const jobsList = [];
  for (const [tid, t] of Object.entries(data.tracks || {})) {
    if (t.audioKey) jobsList.push({ tid, key: t.audioKey, kind: 'аудио', folder: 'audio', defExt: '.mp3' });
    if (t.photoKey) jobsList.push({ tid, key: t.photoKey, kind: 'фото', folder: 'photos', defExt: '.jpg' });
  }
  job.total = jobsList.length + 1; // +1 — сама игра.html

  if (!s3) {
    log('S3 не настроен — в архив попадёт только игра.html');
  } else {
    let idx = 0;
    async function worker() {
      while (idx < jobsList.length) {
        const j = jobsList[idx++];
        // Слот берём ДО запроса: соединение с S3 не открывается, пока
        // архиватору некуда принять файл.
        await acquire();
        try {
          log(`${j.kind} ${j.tid}: запрос S3 начат, key=${j.key}`);
          const obj = await withTimeout(
            s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: j.key })),
            S3_REQUEST_TIMEOUT_MS, `${j.kind} ${j.tid}`
          );
          log(`${j.kind} ${j.tid}: ответ S3 получен`);
          const ext = path.extname(j.key) || j.defExt;
          // store:true — mp3 и jpg уже сжаты форматом, повторный deflate
          // впустую греет CPU и ничего не выигрывает в размере.
          archive.append(obj.Body, { name: `${j.folder}/${j.tid}${ext}`, store: true });
        } catch (e) {
          // Файл не приехал — 'entry' по нему не будет, значит слот надо
          // вернуть руками, иначе очередь потихоньку встанет намертво.
          release();
          job.failed.push({ key: j.key, error: e.message });
          job.total--;
          log(`${j.kind} ${j.tid}: ОШИБКА S3: ${e.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_QUEUED_ENTRIES, jobsList.length) || 1 }, worker));
  }

  log('вызываю archive.finalize()');
  await archive.finalize();
  await archiveDone;

  await fsp.rename(tmpPath, cachePath);
  job.bytes = fs.statSync(cachePath).size;
  log('архив собран:', cachePath, job.bytes, 'байт, не скачалось файлов:', job.failed.length);
}

/* Идемпотентная точка входа: возвращает состояние сборки, запуская её, если
   архива ещё нет и никто его сейчас не собирает. Клиент дёргает её же и для
   старта, и для опроса прогресса — так не бывает состояния «поллим сборку,
   которой никто не запустил» после перезапуска сервера. */
function ensureBuild(ctx, opts) {
  const { id, cachePath } = ctx;

  if (fs.existsSync(cachePath)) {
    const existing = jobs.get(id);
    if (existing && existing.state === 'ready') return jobView(existing);
    return { state: 'ready', done: 1, total: 1, bytes: fs.statSync(cachePath).size, failed: 0, error: null };
  }

  const running = jobs.get(id);
  if (running && running.state === 'building') return jobView(running);
  // Упавшую сборку сама по себе не перезапускаем: клиент опрашивает этот же
  // маршрут в цикле, и «перезапускать при ошибке» означало бы бесконечно
  // молотить заново по любой временной неполадке S3. Повтор — только по явной
  // просьбе, то есть когда пользователь снова нажал «Скачать игру».
  if (running && running.state === 'error' && !(opts && opts.retry)) return jobView(running);

  const job = { state: 'building', done: 0, total: 0, bytes: 0, failed: [], error: null, startedAt: Date.now() };
  jobs.set(id, job);

  runBuild(job, ctx).then(() => {
    job.state = 'ready';
  }).catch(e => {
    job.state = 'error';
    job.error = e.message;
    ctx.log('ИСКЛЮЧЕНИЕ при сборке:', e.message);
    console.error(e);
  });

  return jobView(job);
}

function forgetJob(id) { jobs.delete(id); }

module.exports = { ensureBuild, forgetJob, MAX_QUEUED_ENTRIES };
