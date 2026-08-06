/* ==========================================================================
   Текстовая выгрузка состава сохранённой игры.

   Зачем: перед печатью бланков и перед самой игрой надо глазами (или руками
   ИИ) проверить, что ни один трек не попал в игру дважды. Правило музлото:
   за игру трек звучит ровно один раз, даже если блоков три и категории у них
   разные. Раньше проверять это было негде — раскладка жила только внутри
   сетки чисел на экране, разложенная по трём вкладкам раундов, и сравнить их
   между собой можно было лишь переключаясь туда-сюда.

   Файл отдаётся как plain text: он одновременно и читаемый глазами
   (выровненные колонки), и пригодный для «вставь это в чат и найди дубли».
   ========================================================================== */

/* Приводим название/исполнителя к виду, в котором «Кино — Группа крови» и
   «кино - группа крови (remastered)» считаются одним и тем же треком.
   Нужно потому, что дубль в игре бывает двух сортов:
     1) один и тот же трек банка расставлен в двух блоках — ловится по id;
     2) одна и та же песня заведена в банк дважды разными записями — по id
        не ловится вообще, только по нормализованному «исполнитель|название».
   Второй случай на практике встречается чаще первого. */
function normKey(t) {
  const norm = s => String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')   // (remastered), [official video] и т.п.
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim();
  return `${norm(t.artist)}|${norm(t.title)}`;
}

function label(t) {
  return {
    title: ((t && t.title) || '').trim() || 'Без названия',
    artist: ((t && t.artist) || '').trim() || '—',
  };
}

// Дополняем строку пробелами до нужной ширины, слишком длинное — режем с
// многоточием, иначе колонки разъезжаются и таблица перестаёт читаться.
function pad(s, width) {
  const str = String(s);
  if (str.length >= width) return str.slice(0, Math.max(1, width - 2)) + '… ';
  return str + ' '.repeat(width - str.length);
}

/* Разбирает сохранённую игру в плоский список позиций «блок → номер → трек».
   Используется и текстовой выгрузкой, и генератором бланков. */
function gameEntries(data) {
  const rounds = data.rounds || [];
  const tracks = data.tracks || {};
  const entries = [];
  rounds.forEach((r, ri) => {
    const map = r.map || {};
    Object.keys(map)
      .map(Number)
      .filter(n => map[n])
      .sort((a, b) => a - b)
      .forEach(num => {
        const id = map[num];
        const t = tracks[id] || {};
        const { title, artist } = label(t);
        entries.push({
          block: ri + 1, num, id, title, artist,
          key: normKey(t), category: r.category || '',
        });
      });
  });
  return entries;
}

/* game — строка из saved_games (id, name, createdAt, data).
   Возвращает готовое содержимое .txt-файла одной строкой. */
function buildTrackListText(game) {
  const data = typeof game.data === 'string' ? JSON.parse(game.data) : game.data;
  const rounds = data.rounds || [];
  const entries = gameEntries(data);

  const W_BLOCK = 6, W_NUM = 6, W_TITLE = 46, W_ARTIST = 34;
  const sep = '-'.repeat(W_BLOCK + W_NUM + W_TITLE + W_ARTIST);

  const uniqueKeys = new Set(entries.map(e => e.key));

  const out = [];
  out.push(`МУЗЫКАЛЬНОЕ ЛОТО — «${game.name}»`);
  out.push(`Сохранено: ${new Date(game.createdAt).toLocaleString('ru-RU')}`);
  out.push(`Блоков: ${rounds.length} · позиций в игре: ${entries.length} · уникальных треков: ${uniqueKeys.size}`);
  out.push('');
  out.push(pad('Блок', W_BLOCK) + pad('№', W_NUM) + pad('Название', W_TITLE) + 'Исполнитель');
  out.push(sep);

  let prevBlock = null;
  entries.forEach(e => {
    // Подпись блока на стыке — чтобы список читался глазами, но при этом
    // остался одной сплошной таблицей, пригодной для вставки в ИИ.
    if (e.block !== prevBlock) {
      if (prevBlock !== null) out.push(sep);
      const cnt = entries.filter(x => x.block === e.block).length;
      out.push(`БЛОК ${e.block}${e.category ? ' · ' + e.category : ''} · треков: ${cnt}`);
      prevBlock = e.block;
    }
    out.push(pad(e.block, W_BLOCK) + pad('№' + e.num, W_NUM) + pad(e.title, W_TITLE) + e.artist);
  });

  // ---------- Проверка на повторы ----------
  out.push('');
  out.push('='.repeat(sep.length));
  out.push('ПРОВЕРКА НА ДУБЛИКАТЫ (за игру трек должен звучать один раз)');
  out.push('='.repeat(sep.length));

  const byKey = new Map();
  entries.forEach(e => {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  });
  const dups = [...byKey.values()].filter(list => list.length > 1);

  if (!dups.length) {
    out.push('Повторов не найдено — каждый трек встречается в игре ровно один раз.');
  } else {
    out.push(`Найдено повторяющихся треков: ${dups.length}`);
    out.push('');
    dups.forEach(list => {
      const e = list[0];
      const where = list.map(x => `Блок ${x.block} №${x.num}`).join(', ');
      // Разные id при одинаковом названии — значит песня заведена в банк
      // дважды; сказать об этом стоит прямо, чинить надо в банке треков,
      // а не в раскладке блоков.
      const sameId = new Set(list.map(x => x.id)).size === 1;
      out.push(`- ${e.artist} — ${e.title}`);
      out.push(`      ${where}${sameId ? '' : '   (внимание: в банке заведён несколькими записями)'}`);
    });
  }
  out.push('');

  // CRLF — чтобы файл ровно открывался и в Блокноте Windows тоже.
  return out.join('\r\n');
}

module.exports = { buildTrackListText, gameEntries, normKey };
