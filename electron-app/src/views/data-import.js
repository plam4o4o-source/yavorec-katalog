// Внасяне на данни от други системи (CSV/TXT/XLSX) — включва и
// document.addEventListener('dragover'/'drop', ...) за влачене на файл
// върху прозореца; регистрира се безопасно веднага (обработва се едва
// при реално събитие, много след пълното зареждане на всички файлове).

let IMPORT_INFO = null;
async function importChoose() {
  const res = await window.api.importData.choose();
  if (!res.ok) return res.error === 'Отказано от потребителя.' ? null : toast(res.error, 'err');
  IMPORT_INFO = res.data;
  importMapModal();
}
window.importChoose = importChoose;

/* Провлачване на файл върху прозореца — същият път, като през диалога. */
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  /* Electron 32 премахна File.path, а програмата е на Electron 43 — пътят на
     провлачения файл вече НЕ се вижда от самия прозорец. Взима се през моста
     (importData.pathOf → webUtils.getPathForFile в preload.js, v2.2.1).
     До v2.2.0 тук стоеше тих `return`: библиотекарят влачеше файла, не се
     случваше нищо и нямаше как да разбере защо. */
  const p = (window.api.importData.pathOf && window.api.importData.pathOf(f)) || f.path || '';
  if (!p) {
    return toast('Пътят до провлачения файл не можа да бъде разчетен. '
      + 'Ползвайте бутона „Избери файл за въвеждане…“.', 'err');
  }
  if (!/\.(csv|txt|tsv|xlsx)$/i.test(p)) {
    return toast('Приемат се файлове CSV, TXT, TSV и XLSX.', 'err');
  }
  const res = await window.api.importData.load(p);
  if (!res.ok) return toast(res.error, 'err');
  IMPORT_INFO = res.data;
  importMapModal();
});

function importMapModal() {
  const d = IMPORT_INFO;
  const fieldOpts = Object.entries(d.fields).map(([v, t]) => ({ v, t }));
  modal('Въвеждане на данни — съответствие на колоните', `
    <div class="note" style="margin-top:0">
      Файл: <b style="font-family:var(--mono)">${esc(d.path.split(/[\\/]/).pop())}</b> ·
      кодиране <b>${esc(d.encoding)}</b>${d.delimiter ? ` · разделител <b>${esc(d.delimiter === '\t' ? 'табулация' : d.delimiter)}</b>` : ''} ·
      редове с данни: <b>${d.total}</b><br>
      Съответствието е разпознато по заглавията на колоните. <b>Проверете го</b> и поправете
      каквото е нужно — колоните, оставени на „— не се въвежда —“, се пренебрегват.
    </div>

    <div class="wrap" style="max-height:230px">
      <table class="ledger"><thead><tr>
        ${d.headers.map((h, i) => `<th>${esc(h || 'колона ' + (i + 1))}</th>`).join('')}
      </tr></thead><tbody>
        ${d.preview.map(r => `<tr>${d.headers.map((_, i) =>
          `<td>${esc(String(r[i] ?? '').slice(0, 40))}</td>`).join('')}</tr>`).join('')}
      </tbody></table>
    </div>
    <div class="hint" style="margin:4px 0 12px">Първите ${d.preview.length} реда от файла.</div>

    <form id="mapF" onsubmit="return false">
      <div class="grid g3">
        ${d.headers.map((h, i) => fld(h || 'колона ' + (i + 1), 'col' + i, {
          type: 'select', val: d.mapping[i] || '', opts: fieldOpts, emptyLabel: '— не се въвежда —'
        })).join('')}
      </div>
    </form>

    <fieldset><legend>Настройки на въвеждането</legend>
      <form id="impOptF" onsubmit="return false">
        <label class="chk"><input type="checkbox" name="skipDuplicates" checked>
          <span>Пропускай вече съществуващите (по инвентарен номер, а при липса — по ISBN)</span></label>
        <div class="grid g3" style="margin-top:8px">
          ${fld('Отдел по подразбиране', 'defaultDepartment', { type: 'select', opts: OTDELI,
            val: 'за възрастни', allowEmpty: false })}
          ${fld('Език по подразбиране', 'defaultLanguage', { type: 'select', opts: EZICI, val: 'български' })}
          ${fld('Вид документ по подразбиране', 'defaultCategory', { val: 'книга' })}
        </div>
        <div class="hint">Ползват се само за редовете, в които съответната колона липсва или е празна.</div>
      </form>
    </fieldset>`,
    `<button class="btn" onclick="closeModal()">Отказ</button>
     <button class="btn pri" onclick="importRun()">Въведи ${d.total} реда</button>`);
}

async function importRun() {
  const d = IMPORT_INFO;
  const mapping = {};
  const seen = {};
  for (let i = 0; i < d.headers.length; i++) {
    const v = $(`#mapF [name=col${i}]`).value;
    if (!v) continue;
    // Едно поле не може да идва от две колони — иначе втората тихо презаписва първата.
    if (seen[v]) return toast(`Полето „${d.fields[v]}“ е посочено два пъти — изберете само една колона за него.`, 'err');
    seen[v] = true;
    mapping[i] = v;
  }
  if (!seen.title) return toast('Посочете коя колона съдържа заглавието — без него записът е безсмислен.', 'err');
  const options = formData('#impOptF');
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Въвеждане…'; }
  const res = await window.api.importData.run({ mapping, options });
  if (btn) { btn.disabled = false; btn.textContent = 'Въведи'; }
  if (!res.ok) return toast(res.error, 'err');
  const r = res.data;
  markSaved();
  modal('Въвеждането приключи', `
    <div class="kpis">
      ${kpi('✅', r.added, 'Въведени документа', 'добавени във фонда', 'ok')}
      ${kpi('⏭️', r.skipped, 'Пропуснати', 'дубликати или редове с грешка')}
    </div>
    ${r.usedInv.length ? `<div class="note" style="margin-top:14px">
      <b>${r.usedInv.length === 1 ? '1 запис получи' : r.usedInv.length + ' записа получиха'} нов инвентарен номер</b>, защото в
      файла нямаше номер или той вече беше зает. Инвентарният номер трябва да е
      уникален — това е изискване на инвентарната книга.
      <div class="hint" style="margin-top:6px">${r.usedInv.slice(0, 12).map(u =>
        `ред ${u.line} → № ${u.inv}`).join(' · ')}${r.usedInv.length > 12 ? ' …' : ''}</div>
    </div>` : ''}
    ${(r.deaccessionedToNote || r.statusToNote) ? `<div class="note" style="margin-top:12px">
      <b>Състояния, които не са пренесени като състояние</b>
      ${r.deaccessionedToNote ? `<div style="margin-top:6px">${r.deaccessionedToNote}
        ${r.deaccessionedToNote === 1 ? 'ред беше отбелязан' : 'реда бяха отбелязани'} „отчислен“ във файла.
        Документ напуска фонда само с <b>акт за отчисляване</b> (чл. 35, ал. 2) — той е и единственото нещо,
        по което КДБФ и годишният отчет броят отписаното. Затова
        ${r.deaccessionedToNote === 1 ? 'този ред е въведен' : 'тези редове са въведени'} като „наличен“,
        а текстът е записан в забележката. Ако документите наистина са отчислени, съставете акт от
        „Отчисляване“; ако не са — няма какво да се прави.</div>` : ''}
      ${r.statusToNote ? `<div style="margin-top:6px">${r.statusToNote}
        ${r.statusToNote === 1 ? 'ред носеше непознато състояние' : 'реда носеха непознато състояние'} —
        въведени са като „наличен“, а оригиналният текст е добавен към забележката.</div>` : ''}
    </div>` : ''}
    ${r.errors.length ? `<div class="note" style="border-left-color:var(--red);margin-top:12px">
      <b style="color:var(--red)">Редове с грешка: ${r.errors.length}</b>
      <div class="hint" style="margin-top:6px">${r.errors.slice(0, 15).map(x =>
        `ред ${x.line}: ${esc(x.error)}`).join('<br>')}${r.errors.length > 15 ? '<br>…' : ''}</div>
    </div>` : ''}
    <div class="hint" style="margin-top:12px">Прегледайте въведеното в „Книги“. Ако нещо не е наред,
    възстановете резервното копие отпреди въвеждането — то се прави автоматично при първото
    стартиране за деня.</div>`,
    `<button class="btn pri" onclick="closeModal();go('books')">Към книгите</button>`);
}
window.importRun = importRun;
