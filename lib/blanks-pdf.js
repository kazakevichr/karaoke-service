/* ==========================================================================
   PDF с бланками участников по СОХРАНЁННОЙ игре — серверная обёртка.

   Сама вёрстка живёт в lib/blanks-core.js: её же рисует браузер на странице
   игры без интернета, поэтому бланки онлайн и офлайн одинаковые. Здесь
   только документ pdfkit, шрифты и поток ответа.

   Раскладка в снимке игры уже зафиксирована, значит бланки гарантированно
   совпадают с тем, что реально прозвучит.
   ========================================================================== */

const PDFDocument = require('pdfkit');
const qrcode = require('qrcode-generator');
const { render, DOC_OPTIONS, MAX_PLAYERS, CELLS } = require('./blanks-core');

// Кириллица: встроенные шрифты pdfkit (Helvetica и компания) её не содержат
// вообще — без подключения TTF русский текст в PDF превращается в пустые
// прямоугольники. DejaVu берём npm-пакетом, а не файлом в репозитории, чтобы
// в git не лежало полтора мегабайта бинарников. Те же файлы сервер отдаёт
// странице /offline (см. /fonts/* в server.js).
const FONT_REG = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const FONT_BOLD = require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

/* Пишет готовый PDF в переданный поток (res).
   game — строка из saved_games, players — сколько участников. */
async function streamBlanksPdf(stream, game, players, design) {
  const data = typeof game.data === 'string' ? JSON.parse(game.data) : game.data;
  const doc = new PDFDocument(DOC_OPTIONS);
  doc.registerFont('regular', FONT_REG);
  doc.registerFont('bold', FONT_BOLD);
  doc.pipe(stream);
  render(doc, { id: game.id, name: game.name, rounds: data.rounds, tracks: data.tracks }, players, design, qrcode);
}

module.exports = { streamBlanksPdf, MAX_PLAYERS, CELLS, FONT_REG, FONT_BOLD };
