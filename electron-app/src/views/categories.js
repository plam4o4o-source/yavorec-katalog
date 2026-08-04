/* ---------------- Категории (управляват се в „Настройки“) ---------------- */
function categoriesCardHtml(cats) {
  return `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Категории (видове документи)</h3>
    <div class="note" style="margin-top:0">Категориите се избират при вписване на всеки документ във фонда
    и излизат в справките и в онлайн каталога.</div>
    <div class="toolbar"><button class="btn pri" onclick="categoryForm()">+ Нова категория</button></div>
    ${cats && cats.length ? `<div class="wrap"><table class="ledger">
      <thead><tr><th>Име</th><th style="width:150px"></th></tr></thead><tbody>
      ${cats.map(c => `<tr><td>${esc(c.name)}</td>
        <td><button class="btn sm" onclick="categoryForm(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}')">Редакция</button>
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
  if (id) await call(window.api.categories.update({ id, name: d.name }), 'Категорията е обновена.');
  else await call(window.api.categories.create(d.name), 'Категорията е добавена.');
  closeModal(); renderSetup();
}
window.saveCategory = saveCategory;
async function deleteCategory(id) {
  if (!confirm('Да изтрия ли тази категория?')) return;
  await call(window.api.categories.delete(id), 'Категорията е изтрита.');
  renderSetup();
}
window.deleteCategory = deleteCategory;
