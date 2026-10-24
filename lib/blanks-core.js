/* ==========================================================================
   Вёрстка бланков участников — одна на сервер и на игру без интернета.

   На сервере её вызывает lib/blanks-pdf.js (PDF по сохранённой игре), в
   браузере — страница /offline: там та же вёрстка рисуется браузерной
   сборкой pdfkit. Поэтому бланки без интернета выглядят точно так же, как
   онлайн, а для той же игры и того же числа участников получаются те же
   самые листы. Сюда передаётся уже созданный документ pdfkit с
   зарегистрированными шрифтами 'regular' и 'bold' и библиотека QR-кодов.

   Как это устроено по смыслу игры:
     - в игре три блока (раунда), в каждом свой набор треков;
     - каждый участник получает по одному бланку на каждый блок, то есть за
       игру у него на руках оказывается три листа;
     - все бланки одного блока собраны из треков ровно этого блока, но у
       каждого участника треки стоят в своём случайном порядке — иначе
       выигрывали бы все одновременно.

   Порядок страниц — по блокам: сначала все бланки первого блока, потом
   второго, потом третьего (удобно раздавать пачкой перед каждым блоком).
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MBBlanks = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const COLS = 5;
  const ROWS = 5;
  const CELLS = COLS * ROWS;          // 25 клеток на бланке, всегда
  const MAX_PLAYERS = 300;

  const PAGE_MARGIN = 34;             // ~12 мм
  const CELL_PAD = 5;
  const CELL_FONT_SIZES = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5];
  const DOC_OPTIONS = { size: 'A4', margin: PAGE_MARGIN, autoFirstPage: false };

  const mulberry32 = seed => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Фишер–Йейтс на детерминированном ГПСЧ. Детерминированность важна: повторное
  // скачивание того же PDF по той же ссылке даёт те же бланки, а значит
  // перепечатать потерянный лист можно, не пересобирая весь комплект.
  function shuffle(arr, rnd) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* Собирает раскладки бланков для одного блока: players штук по 25 клеток.
     Если треков в блоке больше 25 — каждому участнику достаются свои случайные
     25 из общего пула (это и есть основная лотерейная механика). Если меньше —
     лишние клетки останутся пустыми. */
  function buildCardsForRound(poolIds, players, rnd) {
    const cards = [];
    const seen = new Set();
    for (let i = 0; i < players; i++) {
      let card = null;
      // До 60 попыток подобрать раскладку, которой ещё ни у кого нет. Полного
      // совпадения бланков при большом пуле практически не бывает, но при
      // маленьком (скажем, ровно 25 треков и 100 участников) повторы неизбежны
      // математически — тогда после попыток просто берём что вышло.
      for (let attempt = 0; attempt < 60; attempt++) {
        const candidate = shuffle(poolIds, rnd).slice(0, CELLS);
        const sig = candidate.join('|');
        if (!seen.has(sig)) { seen.add(sig); card = candidate; break; }
        card = candidate;
      }
      cards.push(card);
    }
    return cards;
  }

  /* QR-код строим сами, а не берём картинкой у внешнего сервиса: без
     интернета его взять неоткуда, а онлайн так не приходится отправлять
     ссылку постороннему сайту. Слишком длинная ссылка в QR не влезет —
     тогда бланки просто печатаются без него. */
  function qrMatrix(qrcode, text) {
    if (!qrcode || !text) return null;
    try {
      if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) {
        qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
      }
      const q = qrcode(0, 'M');
      q.addData(text);
      q.make();
      const n = q.getModuleCount();
      const rows = [];
      for (let r = 0; r < n; r++) {
        const row = [];
        for (let c = 0; c < n; c++) row.push(q.isDark(r, c));
        rows.push(row);
      }
      return rows;
    } catch (e) {
      return null;
    }
  }
  // Соседние тёмные модули одной строки рисуем одним прямоугольником, с
  // крошечным нахлёстом — иначе при печати между ними просвечивают волоски.
  function drawQr(doc, m, x, y, size) {
    const n = m.length;
    const s = size / n;
    doc.save();
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!m[r][c]) { c++; continue; }
        let e = c;
        while (e < n && m[r][e]) e++;
        doc.rect(x + c * s, y + r * s, (e - c) * s + 0.1, s + 0.1);
        c = e;
      }
    }
    doc.fillColor('#000').fill();
    doc.restore();
  }

  function cellText(t) {
    if (!t) return '';
    const artist = (t.artist || '').trim();
    const title = (t.title || '').trim() || 'Без названия';
    return artist ? `${artist}\n${title}` : title;
  }

  /* Подбирает самый крупный кегль, при котором текст ещё влезает в клетку.
     Названия песен по длине отличаются в разы («Ты» против «Пачка сигарет на
     двоих в холодном ноябре»), фиксированный размер либо мельчит все клетки,
     либо обрезает длинные. */
  function fitFontSize(doc, text, w, h) {
    for (const size of CELL_FONT_SIZES) {
      doc.fontSize(size);
      if (doc.heightOfString(text, { width: w, align: 'center' }) <= h) return size;
    }
    return CELL_FONT_SIZES[CELL_FONT_SIZES.length - 1];
  }

  function drawCard(doc, opts) {
    const { cardIds, tracks, roundNo, design, qr } = opts;
    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const left = PAGE_MARGIN;
    const right = pageW - PAGE_MARGIN;
    const innerW = right - left;

    let y = PAGE_MARGIN;

    // ---- Шапка ----
    // Кегль заголовка подбираем: пользователь может вписать своё длинное
    // название вместо «МУЗЫКАЛЬНОЕ ЛОТО», и при фиксированных 30pt оно
    // переносилось бы на вторую строку, съедая высоту у сетки.
    const titleText = design.title || 'МУЗЫКАЛЬНОЕ ЛОТО';
    doc.font('bold').fillColor('#000');
    let titleSize = 30;
    while (titleSize > 16 && doc.fontSize(titleSize).widthOfString(titleText) > innerW) titleSize -= 1;
    doc.fontSize(titleSize).text(titleText, left, y, { width: innerW, align: 'center' });
    y = doc.y + 4;

    doc.font('bold').fontSize(13).fillColor('#444');
    doc.text(`РАУНД ${roundNo}`, left, y, { width: innerW, align: 'center' });
    y = doc.y + 12;

    /* ---- Подвал считаем ДО сетки и от низа листа ----
       Иначе получается то, что было в первой версии: высоту подвала прикидывали
       «по 22pt на строку», длинная подпись раунда переносилась на две строки, и
       нижняя строка уезжала за край страницы. Меряем реальную высоту каждой
       строки при её реальной ширине, а сетке отдаём ровно остаток. */
    const qrSize = qr ? 108 : 0;
    const footerTextW = qr ? innerW - qrSize - 14 : innerW;

    const footerLines = [];
    if (design.roundLabel) footerLines.push({ text: design.roundLabel, font: 'bold', size: 15 });
    if (design.nomination) footerLines.push({ text: `Номинация: ${design.nomination}`, font: 'regular', size: 13 });
    if (design.tagline) footerLines.push({ text: design.tagline, font: 'bold', size: 15 });

    let footerTextH = 0;
    footerLines.forEach(l => {
      doc.font(l.font).fontSize(l.size);
      l.h = doc.heightOfString(l.text, { width: footerTextW });
      footerTextH += l.h + 4;
    });

    const footerBlockH = Math.max(footerTextH, qrSize);
    const gridBottom = pageH - PAGE_MARGIN - footerBlockH - (footerBlockH ? 12 : 0);

    // ---- Сетка 5×5 ----
    const cellW = innerW / COLS;
    const cellH = Math.max(40, (gridBottom - y) / ROWS);

    doc.lineWidth(1.6).strokeColor('#000');
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = left + c * cellW;
        const cy = y + r * cellH;
        const idx = r * COLS + c;
        const id = cardIds[idx];
        const t = id ? tracks[id] : null;

        doc.rect(x, cy, cellW, cellH).stroke();

        const text = cellText(t);
        const tw = cellW - CELL_PAD * 2;
        const th = cellH - CELL_PAD * 2;
        if (!text) {
          doc.font('regular').fontSize(11).fillColor('#bbb');
          doc.text('—', x + CELL_PAD, cy + cellH / 2 - 7, { width: tw, align: 'center' });
          continue;
        }
        doc.font('bold').fillColor('#000');
        const size = fitFontSize(doc, text, tw, th);
        doc.fontSize(size);
        const hh = doc.heightOfString(text, { width: tw, align: 'center' });
        doc.text(text, x + CELL_PAD, cy + (cellH - hh) / 2, { width: tw, align: 'center', lineGap: 0 });
      }
    }
    // ---- Подписи: пишем от низа листа, ровно в отмеренном месте ----
    let fy = pageH - PAGE_MARGIN - footerTextH;
    doc.fillColor('#000');
    footerLines.forEach(l => {
      doc.font(l.font).fontSize(l.size).text(l.text, left, fy, { width: footerTextW });
      fy += l.h + 4;
    });

    // ---- QR в правом нижнем углу ----
    if (qr) drawQr(doc, qr, right - qrSize, pageH - PAGE_MARGIN - qrSize, qrSize);
  }

  /* Рисует все бланки игры в переданный документ и закрывает его.
     game: { id, name, rounds, tracks } — rounds с раскладкой map, tracks —
     словарь id → { title, artist }. */
  function render(doc, game, players, designOverrides, qrcode) {
    const rounds = game.rounds || [];
    const tracks = game.tracks || {};
    const count = Math.max(1, Math.min(MAX_PLAYERS, parseInt(players, 10) || 1));

    const design = Object.assign({
      title: 'МУЗЫКАЛЬНОЕ ЛОТО',
      nomination: '',
      tagline: 'Давайте общаться!',
      qrUrl: '',
    }, designOverrides || {});
    // Один QR на весь документ: ссылка у всех бланков одна.
    const qr = qrMatrix(qrcode, design.qrUrl);

    // Сид от id игры: комплект бланков для одной и той же игры воспроизводим
    // при повторном скачивании — и онлайн, и без интернета.
    let seed = 0;
    for (const ch of String(game.id)) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
    const rnd = mulberry32(seed);

    doc.info.Title = `Бланки — ${game.name || ''}`;

    let pages = 0;
    rounds.forEach((r, ri) => {
      const poolIds = [...new Set(Object.values(r.map || {}).filter(Boolean))];
      if (!poolIds.length) return;   // пустой блок пропускаем целиком

      const cards = buildCardsForRound(poolIds, count, rnd);
      const roundLabel = `${ri + 1} раунд: Собери комбинацию по вертикали или горизонтали`;

      cards.forEach(cardIds => {
        doc.addPage();
        pages++;
        drawCard(doc, {
          cardIds, tracks, roundNo: ri + 1,
          design: Object.assign({}, design, { roundLabel }),
          qr,
        });
      });
    });

    // Ни одного непустого блока — отдать пустой PDF нельзя, pdfkit упадёт на
    // документе без страниц. Печатаем страницу-заглушку вместо загадочной ошибки.
    if (!pages) {
      doc.addPage().font('bold').fontSize(16)
        .text('В этой игре нет ни одного расставленного трека — бланки собрать не из чего.',
          PAGE_MARGIN, 200, { width: doc.page.width - PAGE_MARGIN * 2, align: 'center' });
    }

    doc.end();
  }

  return { render, DOC_OPTIONS, MAX_PLAYERS, CELLS };
}));
