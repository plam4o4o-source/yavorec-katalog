/* ---------------- Категории (управляват се в „Настройки“) ---------------- */
function categoriesCardHtml(cats) {
  return `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Категории (видове документи)</h3>
    <div class="note" style="margin-top:0">Категориите се избират при вписване на всеки документ във фонда
    и излизат в справките и в онлайн каталога.</div>
    <div class="toolbar"><button class="btn pri" onclick="categoryForm()">+ Нова категория</button></div>
    ${cats && cats.length ? `<div class="wrap"><table class="ledger">
      <thead><tr><th>Име</th><th style="width:150px"></th></tr></thead><tbody>
      ${cats.map(c => `<tr><td>${esc(c.name)}</td>
        <td><button class="btn sm" onclick="categoryForm(${c.id}, '${jsq(c.name)}')">Редакция</button>
            <button class="btn sm dgr" onclick="deleteCategory(${c.id})">Изтрий</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="hint">Няма категории.</div>'}
  </div>`;
}
function categoryForm(id, name) {
  modal(id ? 'Редакция на категория' : 'Нова категория',
    `<form id="catF" onsubmit="return false">${fld('Име', 'name', { val: name || '', req: 1 })}</form>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="saveCategory(${id || 'null'})">Запиши</button>`);
}
window.categoryForm = categoryForm;
async function saveCategory(id) {
  const d = formData('#catF');
  if (!d.name.trim()) return toast('Името е задължително.', 'err');
  // Затваря се само при успех (v2.2.0) — напр. при дублирано име прозорецът
  // остава отворен с въведеното, за да се поправи.
  const ok = id ? await call(window.api.categories.update({ id, name: d.name }), 'Категорията е обновена.')
    : await call(window.api.categories.create(d.name), 'Категорията е добавена.');
  if (ok === null) return;
  closeModal(); renderSetup();
}
window.saveCategory = saveCategory;
async function deleteCategory(id) {
  /* Питането казва и какво ще се случи с книгите. Изтриването на категория
     изчиства вида на документа на всяка книга от нея (ON DELETE SET NULL) —
     необратимо действие, за което дотук пишеше само „Да изтрия ли тази
     категория?“. */
  const n = await call(window.api.categories.usage(id));
  if (n === null) return;
  const warn = n
    ? '\n\nВНИМАНИЕ: ' + n + (n === 1 ? ' документ ще остане' : ' документа ще останат')
      + ' без попълнен вид. Това не може да бъде върнато автоматично — видът трябва да се въведе наново.'
    : '';
  if (!confirm('Да изтрия ли тази категория?' + warn)) return;
  await call(window.api.categories.delete(id), 'Категорията е изтрита.');
  renderSetup();
}
window.deleteCategory = deleteCategory;
