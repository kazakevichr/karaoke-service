/* ==========================================================================
   Общие мелкие утилиты для страниц сервиса (/, /setup, /bank, /admin) — каждая
   страница подключает этот файл первым тегом <script>. Специфичная для
   конкретной страницы логика (плеер, редактор трека, расстановка по числам
   и т.д.) живёт в собственном инлайн-скрипте каждой страницы, не здесь —
   страницы независимы друг от друга, общий рантайм между ними не течёт
   (это не SPA, а три отдельных документа).
   ========================================================================== */
const $ = id => document.getElementById(id);
const fmt = s => isFinite(s) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '0:00';
const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffleArr = arr => [...arr].sort(() => Math.random() - .5);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* Код этого браузера — случайная строка, которая живёт в его localStorage.
   К нему сервер привязывает логин ведущего при первом входе: в другом
   браузере или на другом компьютере тот же логин уже не пустят. */
function mbDeviceId() {
  let id = null;
  try { id = localStorage.getItem('mb_device_id'); } catch (e) {}
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : uid() + uid());
    try { localStorage.setItem('mb_device_id', id); } catch (e) {}
  }
  return id;
}
async function apiMe() {
  const r = await fetch('/api/me');
  return r.ok ? r.json() : { role: null };
}
/* Сессия кончилась или у ведущего вышел срок — уводим на страницу входа,
   она объяснит, в чём дело. */
function redirectOnAuthError(r) {
  if (r.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname);
  else if (r.status === 403) location.href = '/login?expired=1';
  else return false;
  return true;
}

async function apiGetTracks() {
  const r = await fetch('/api/tracks');
  if (!r.ok) {
    redirectOnAuthError(r);
    throw new Error('Не удалось загрузить банк треков с сервера');
  }
  return r.json();
}
async function apiGetSettings() {
  const r = await fetch('/api/settings');
  if (!r.ok) { redirectOnAuthError(r); return null; }
  return r.json();
}
// Fire-and-forget, как и раньше — не блокируем интерфейс на каждое действие.
// При одновременной работе нескольких администраторов с разных
// устройств/страниц возможна гонка (кто сохранил последним — тот и победил),
// это сознательное упрощение, не полноценная синхронизация в реальном времени.
function apiSaveSettings(settings) {
  fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
    .catch(e => console.error('Не удалось сохранить настройки на сервере:', e));
}
// Новая категория банка. Категории общие для всех и лежат у администратора,
// поэтому отдельным запросом, а не вместе с раундами (у ведущего они свои).
function apiAddCategory(name) {
  fetch('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    .catch(e => console.error('Не удалось сохранить категорию на сервере:', e));
}
function freshRound() { return { category: '', size: 30, map: {}, played: {}, history: [], blanks: null }; }
function trackById(bank, id) { return bank.find(t => t.id === id); }
function tracksInCategory(bank, cat) {
  if (!cat) return [];
  return bank.filter(t => (t.categories || []).includes(cat));
}
function roundsContaining(rounds, trackId) {
  const res = [];
  rounds.forEach((r, ri) => { Object.keys(r.map || {}).forEach(n => { if (r.map[n] === trackId) res.push(`Раунд ${ri + 1} №${n}`); }); });
  return res;
}
