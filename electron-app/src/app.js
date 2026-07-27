'use strict';

/* ---------------- Помощни функции ---------------- */
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => new Date().toISOString().slice(0, 10);
const bg = (d) => d ? d.split('-').reverse().join('.') : '';

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = 0; setTimeout(() => el.remove(), 300); }, type === 'err' ? 5000 : 2800);
}

function modal(title, body, footer) {
  $('#modal').innerHTML =
    `<header><h2>${esc(title)}</h2><button class="x" onclick="closeModal()">&times;</button></header>
     <div class="body">${body}</div>
     ${footer ? `<footer>${footer}</footer>` : ''}`;
  $('#veil').classList.add('on');
  setTimeout(() => { const i = $('#modal input,#modal select,#modal textarea'); if (i) i.focus(); }, 40);
}
function closeModal() { $('#veil').classList.remove('on'); $('#modal').innerHTML = ''; }
window.closeModal = closeModal;

function formData(sel) {
  const out = {};
  $(sel).querySelectorAll('input,select,textarea').forEach(el => {
    if (!el.name) return;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return out;
}

async function call(promise, okMsg) {
  const res = await promise;
  if (!res.ok) { toast(res.error || 'Възникна грешка.', 'err'); return null; }
  if (okMsg) toast(okMsg, 'ok');
  return res.data;
}

/* ---------------- Навигация ---------------- */
const NAV = [
  { g: 'Общ преглед', items: [['dash', 'Табло']] },
  { g: 'Фонд', items: [['books', 'Книги'], ['categories', 'Категории']] },
  { g: 'Читатели', items: [['readers', 'Читатели']] },
  { g: 'Движение', items: [['circ', 'Заемане и връщане']] }
];
const TITLES = {
  dash: ['Табло', 'обобщение на състоянието'],
  books: ['Библиотечен фонд', 'каталог, добавяне, редакция, търсене'],
  categories: ['Категории', 'видове документи'],
  readers: ['Читатели', 'регистър на читателите'],
  circ: ['Заемане и връщане', 'движение на библиотечния фонд']
};
let VIEW = 'dash';

function go(v) { location.hash = v; }
window.go = go;
window.addEventListener('hashchange', route);

function drawNav() {
  $('#nav').innerHTML = NAV.map(g =>
    `<div class="nav-grp">${esc(g.g)}</div>` +
    g.items.map(([k, t]) => `<a href="#${k}" class="${VIEW === k ? 'on' : ''}">${esc(t)}</a>`).join('')
  ).join('');
}

async function route() {
  const h = (location.hash || '#dash').slice(1);
  VIEW = TITLES[h] ? h : 'dash';
  const t = TITLES[VIEW];
  $('#vTitle').textContent = t[0];
  $('#vSub').textContent = t[1];
  drawNav();
  const renderers = { dash: renderDash, books: renderBooks, categories: renderCategories, readers: renderReaders, circ: renderCirc };
  await renderers[VIEW]();
}

/* ---------------- Табло ---------------- */
async function renderDash() {
  const s = await call(window.api.dashboard.stats());
  if (!s) return;
  $('#view').innerHTML = `
    <div class="cards">
      <div class="card"><div class="num">${s.books}</div><div class="lbl">Книги във фонда</div></div>
      <div class="card"><div class="num">${s.readers}</div><div class="lbl">Читатели</div></div>
      <div class="card"><div class="num">${s.loansOpen}</div><div class="lbl">Заети в момента</div></div>
      <div class="card"><div class="num">${s.overdue}</div><div class="lbl">Просрочени</div></div>
    </div>
    <div class="hint">Използвайте менюто вляво, за да управлявате фонда, читателите и заемането на книги.</div>
  `;
}

/* ---------------- Категории ---------------- */
async function renderCategories() {
  const cats = await call(window.api.categories.list());
  if (!cats) return;
  $('#view').innerHTML = `
    <div class="toolbar">
      <button class="btn pri" onclick="categoryForm()">+ Нова категория</button>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Име</th><th style="width:140px"></th></tr></thead>
      <tbody>
        ${cats.length ? cats.map(c => `
          <tr>
            <td>${esc(c.name)}</td>
            <td>
              <button class="btn sm" onclick="categoryForm(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}')">Редакция</button>
              <button class="btn sm dgr" onclick="deleteCategory(${c.id})">Изтрий</button>
            </td>
          </tr>`).join('') : `<tr><td colspan="2" class="empty">Няма категории.</td></tr>`}
      </tbody>
    </table></div>
  `;
}
function categoryForm(id, name) {
  modal(id ? 'Редакция на категория' : 'Нова категория', `
    <form id="catF" onsubmit="return false">
      <div class="field"><label>Име</label><input name="name" value="${esc(name || '')}" required></div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveCategory(${id || 'null'})">Запиши</button>`);
}
window.categoryForm = categoryForm;
async function saveCategory(id) {
  const d = formData('#catF');
  if (!d.name.trim()) return toast('Името е задължително.', 'err');
  if (id) await call(window.api.categories.update({ id, name: d.name }), 'Категорията е обновена.');
  else await call(window.api.categories.create(d.name), 'Категорията е добавена.');
  closeModal(); renderCategories();
}
window.saveCategory = saveCategory;
async function deleteCategory(id) {
  if (!confirm('Да изтрия ли тази категория?')) return;
  await call(window.api.categories.delete(id), 'Категорията е изтрита.');
  renderCategories();
}
window.deleteCategory = deleteCategory;

/* ---------------- Книги ---------------- */
let BOOKS_QUERY = '';
async function renderBooks() {
  const [books, cats] = await Promise.all([
    call(window.api.books.list(BOOKS_QUERY)),
    call(window.api.categories.list())
  ]);
  if (!books) return;
  window._CATS = cats || [];
  $('#view').innerHTML = `
    <div class="toolbar">
      <input type="search" id="bSearch" placeholder="Търсене по заглавие, автор, ISBN или инв. №…" value="${esc(BOOKS_QUERY)}">
      <button class="btn pri" onclick="bookForm()">+ Нова книга</button>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Инв. №</th><th>Заглавие</th><th>Автор</th><th>Категория</th><th>Година</th><th>Наличност</th><th style="width:160px"></th></tr></thead>
      <tbody>
        ${books.length ? books.map(b => `
          <tr>
            <td class="num">${b.inv_number ?? ''}</td>
            <td>${esc(b.title)}</td>
            <td>${esc(b.author || '')}</td>
            <td>${esc(b.category_name || '')}</td>
            <td class="num">${esc(b.year || '')}</td>
            <td><span class="badge ${b.available > 0 ? 'ok' : 'warn'}">${b.available}/${b.quantity}</span></td>
            <td>
              <button class="btn sm" onclick="bookForm(${b.id})">Редакция</button>
              <button class="btn sm dgr" onclick="deleteBook(${b.id})">Изтрий</button>
            </td>
          </tr>`).join('') : `<tr><td colspan="7" class="empty">Няма намерени книги.</td></tr>`}
      </tbody>
    </table></div>
  `;
  $('#bSearch').addEventListener('input', debounce(e => { BOOKS_QUERY = e.target.value; renderBooks(); }, 300));
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function bookForm(id) {
  const b = id ? await call(window.api.books.get(id)) : null;
  const catOpts = (window._CATS || []).map(c =>
    `<option value="${c.id}" ${b && b.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  modal(id ? 'Редакция на книга' : 'Нова книга', `
    <form id="bookF" onsubmit="return false">
      <div class="grid g2">
        <div class="field"><label>Инвентарен номер</label><input name="inv_number" type="number" value="${b ? (b.inv_number ?? '') : ''}"></div>
        <div class="field"><label>Категория</label><select name="category_id"><option value="">— без категория —</option>${catOpts}</select></div>
      </div>
      <div class="field"><label>Заглавие *</label><input name="title" required value="${esc(b ? b.title : '')}"></div>
      <div class="grid g2">
        <div class="field"><label>Автор</label><input name="author" value="${esc(b ? b.author || '' : '')}"></div>
        <div class="field"><label>Година</label><input name="year" value="${esc(b ? b.year || '' : '')}"></div>
      </div>
      <div class="grid g2">
        <div class="field"><label>ISBN</label><input name="isbn" value="${esc(b ? b.isbn || '' : '')}"></div>
        <div class="field"><label>Цена (лв.)</label><input name="price" type="number" step="0.01" value="${b ? b.price ?? 0 : 0}"></div>
      </div>
      <div class="field"><label>Налични бройки</label><input name="quantity" type="number" min="0" value="${b ? b.quantity ?? 1 : 1}"></div>
      <div class="field"><label>Описание</label><textarea name="description" rows="3">${esc(b ? b.description || '' : '')}</textarea></div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveBook(${id || 'null'})">Запиши</button>`);
}
window.bookForm = bookForm;
async function saveBook(id) {
  const d = formData('#bookF');
  if (!d.title.trim()) return toast('Заглавието е задължително.', 'err');
  const payload = {
    id,
    inv_number: d.inv_number ? parseInt(d.inv_number, 10) : null,
    title: d.title,
    author: d.author,
    category_id: d.category_id ? parseInt(d.category_id, 10) : null,
    year: d.year,
    isbn: d.isbn,
    price: d.price ? parseFloat(d.price) : 0,
    quantity: d.quantity ? parseInt(d.quantity, 10) : 0,
    description: d.description
  };
  if (id) await call(window.api.books.update(payload), 'Книгата е обновена.');
  else await call(window.api.books.create(payload), 'Книгата е добавена.');
  closeModal(); renderBooks();
}
window.saveBook = saveBook;
async function deleteBook(id) {
  if (!confirm('Да изтрия ли тази книга?')) return;
  const res = await window.api.books.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  toast('Книгата е изтрита.', 'ok');
  renderBooks();
}
window.deleteBook = deleteBook;

/* ---------------- Читатели ---------------- */
let READERS_QUERY = '';
async function renderReaders() {
  const readers = await call(window.api.readers.list(READERS_QUERY));
  if (!readers) return;
  $('#view').innerHTML = `
    <div class="toolbar">
      <input type="search" id="rSearch" placeholder="Търсене по име, телефон или № карта…" value="${esc(READERS_QUERY)}">
      <button class="btn pri" onclick="readerForm()">+ Нов читател</button>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Име</th><th>Телефон</th><th>Карта №</th><th>Адрес</th><th style="width:160px"></th></tr></thead>
      <tbody>
        ${readers.length ? readers.map(r => `
          <tr>
            <td>${esc(r.name)}</td>
            <td class="num">${esc(r.phone || '')}</td>
            <td class="num">${esc(r.card_no || '')}</td>
            <td>${esc(r.address || '')}</td>
            <td>
              <button class="btn sm" onclick="readerForm(${r.id})">Редакция</button>
              <button class="btn sm dgr" onclick="deleteReader(${r.id})">Изтрий</button>
            </td>
          </tr>`).join('') : `<tr><td colspan="5" class="empty">Няма намерени читатели.</td></tr>`}
      </tbody>
    </table></div>
  `;
  $('#rSearch').addEventListener('input', debounce(e => { READERS_QUERY = e.target.value; renderReaders(); }, 300));
}
async function readerForm(id) {
  const r = id ? await call(window.api.readers.get(id)) : null;
  modal(id ? 'Редакция на читател' : 'Нов читател', `
    <form id="readerF" onsubmit="return false">
      <div class="field"><label>Име *</label><input name="name" required value="${esc(r ? r.name : '')}"></div>
      <div class="grid g2">
        <div class="field"><label>Телефон</label><input name="phone" value="${esc(r ? r.phone || '' : '')}"></div>
        <div class="field"><label>Имейл</label><input name="email" type="email" value="${esc(r ? r.email || '' : '')}"></div>
      </div>
      <div class="grid g2">
        <div class="field"><label>Читателска карта №</label><input name="card_no" value="${esc(r ? r.card_no || '' : '')}"></div>
        <div class="field"><label>Адрес</label><input name="address" value="${esc(r ? r.address || '' : '')}"></div>
      </div>
      <div class="field"><label>Забележка</label><textarea name="note" rows="2">${esc(r ? r.note || '' : '')}</textarea></div>
    </form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveReader(${id || 'null'})">Запиши</button>`);
}
window.readerForm = readerForm;
async function saveReader(id) {
  const d = formData('#readerF');
  if (!d.name.trim()) return toast('Името е задължително.', 'err');
  const payload = { id, name: d.name, phone: d.phone, email: d.email, card_no: d.card_no, address: d.address, note: d.note };
  if (id) await call(window.api.readers.update(payload), 'Читателят е обновен.');
  else await call(window.api.readers.create(payload), 'Читателят е добавен.');
  closeModal(); renderReaders();
}
window.saveReader = saveReader;
async function deleteReader(id) {
  if (!confirm('Да изтрия ли този читател?')) return;
  const res = await window.api.readers.delete(id);
  if (!res.ok) return toast(res.error, 'err');
  toast('Читателят е изтрит.', 'ok');
  renderReaders();
}
window.deleteReader = deleteReader;

/* ---------------- Заемане и връщане ---------------- */
async function renderCirc() {
  const [open, books, readers] = await Promise.all([
    call(window.api.loans.list({ onlyOpen: true })),
    call(window.api.books.list('')),
    call(window.api.readers.list(''))
  ]);
  if (!open) return;
  window._BOOKS = books || []; window._READERS = readers || [];
  const bookOpts = window._BOOKS.filter(b => b.available > 0)
    .map(b => `<option value="${b.id}">${esc(b.title)} (${b.available} налични)</option>`).join('');
  const readerOpts = window._READERS.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  $('#view').innerHTML = `
    <div class="wrap" style="margin-bottom:20px">
      <table class="ledger"><thead><tr><th colspan="6">Ново заемане</th></tr></thead>
      <tbody><tr><td colspan="6" style="padding:14px">
        <form id="circF" onsubmit="return false" class="grid g3">
          <div class="field"><label>Читател</label><select name="reader_id">${readerOpts || '<option value="">— няма читатели —</option>'}</select></div>
          <div class="field"><label>Книга</label><select name="book_id">${bookOpts || '<option value="">— няма налични книги —</option>'}</select></div>
          <div class="field"><label>Срок за връщане</label><input name="date_due" type="date"></div>
        </form>
      </td></tr>
      <tr><td colspan="6" style="text-align:right;padding:0 14px 14px">
        <button class="btn pri" onclick="checkoutBook()">Заеми книгата</button>
      </td></tr></tbody></table>
    </div>
    <div class="wrap"><table class="ledger">
      <thead><tr><th>Читател</th><th>Книга</th><th>Дата на заемане</th><th>Срок</th><th style="width:120px"></th></tr></thead>
      <tbody>
        ${open.length ? open.map(l => `
          <tr>
            <td>${esc(l.reader_name)}</td>
            <td>${esc(l.title)}</td>
            <td class="num">${bg(l.date_out)}</td>
            <td class="num ${l.date_due && l.date_due < today() ? 'warn' : ''}">${bg(l.date_due) || '—'}</td>
            <td><button class="btn sm" onclick="returnBook(${l.id})">Приеми връщане</button></td>
          </tr>`).join('') : `<tr><td colspan="5" class="empty">Няма заети в момента книги.</td></tr>`}
      </tbody>
    </table></div>
  `;
}
async function checkoutBook() {
  const d = formData('#circF');
  if (!d.reader_id || !d.book_id) return toast('Изберете читател и книга.', 'err');
  const res = await window.api.loans.checkout({
    reader_id: parseInt(d.reader_id, 10),
    book_id: parseInt(d.book_id, 10),
    date_out: today(),
    date_due: d.date_due || null
  });
  if (!res.ok) return toast(res.error, 'err');
  toast('Книгата е заета.', 'ok');
  renderCirc();
}
window.checkoutBook = checkoutBook;
async function returnBook(id) {
  const res = await window.api.loans.return({ id, date_in: today() });
  if (!res.ok) return toast(res.error, 'err');
  toast('Книгата е върната.', 'ok');
  renderCirc();
}
window.returnBook = returnBook;

/* ---------------- Старт ---------------- */
route();
