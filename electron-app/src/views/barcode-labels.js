/* ---------------- Баркод етикети ---------------- */
async function renderLabels() {
  const s = SETTINGS_CACHE || await loadSettingsCache();
  $('#view').innerHTML = `
    <div class="note">Етикетите се печатат във формат <b>Code 39</b> — разчита се от всеки USB баркод четец без настройка.
    Съвместимо е с обикновен принтер (A4 лист, брой колони по избор) и с ролкови лейбъл принтери
    (Zebra, Brother QL, Dymo и др.). Размерите на трите вида етикети се задават поотделно по-долу.</div>

    <div class="card"><h3 style="margin-top:0">Формат на печат за етикети</h3>
      <form id="lblFmtF" onsubmit="return false">
        <fieldset><legend>Хартия</legend>
          <div class="grid g4">
            ${fld('Формат', 'lbl_mode', { type: 'select', allowEmpty: false, val: s.lbl_mode, opts: [{ v: 'sheet', t: 'A4 лист (в колони)' }, { v: 'roll', t: 'Ролков лейбъл принтер' }] })}
            ${fld('Колони на листа', 'lbl_cols', { val: s.lbl_cols ?? 3, type: 'number', hint: 'само за A4 лист' })}
            ${fld('Разстояние между етикетите (мм)', 'lbl_gap', { val: s.lbl_gap ?? 3, type: 'number', hint: 'само за A4 лист' })}
            ${fld('Поле на листа (мм)', 'lbl_margin', { val: s.lbl_margin ?? 8, type: 'number' })}
          </div>
          <label class="chk"><input type="checkbox" name="lbl_border" ${(s.lbl_border == null || +s.lbl_border) ? 'checked' : ''}>
            Пунктирана рамка около всеки етикет (помага при рязане; изключете я при готови листове с етикети)</label>
        </fieldset>
        <fieldset><legend>Размери на трите вида етикети (мм)</legend>
          <div class="grid g3">
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Етикет за фонда</b></div>
              <div class="grid g2">
                ${fld('Ширина', 'lbl_w', { val: s.lbl_w ?? 40, type: 'number' })}
                ${fld('Височина', 'lbl_h', { val: s.lbl_h ?? 30, type: 'number' })}
              </div>
            </div>
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Етикет за сигнатура</b></div>
              <div class="grid g2">
                ${fld('Ширина', 'sig_w', { val: s.sig_w ?? 25, type: 'number' })}
                ${fld('Височина', 'sig_h', { val: s.sig_h ?? 35, type: 'number' })}
              </div>
            </div>
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Читателска карта</b></div>
              <div class="grid g2">
                ${fld('Ширина', 'card_w', { val: s.card_w ?? 90, type: 'number' })}
                ${fld('Височина', 'card_h', { val: s.card_h ?? 60, type: 'number' })}
              </div>
            </div>
          </div>
          <div class="hint">Стандартният размер на читателска карта е 90 × 60 мм. Размерите важат и за двата
          формата: при A4 лист определят големината на всяко квадратче, при ролков принтер — размера на страницата.</div>
        </fieldset>
      </form>
      <button class="btn pri" onclick="saveLabelFormat()">Запиши формата</button>
    </div>

    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Баркод етикети за фонда</h3>
        <p class="hint" style="margin-top:0">Всеки етикет съдържа името на библиотеката, населеното място,
        баркод (Code&nbsp;39) и инвентарния номер под баркода.</p>
        <div class="grid g2">
          ${fld('От инвентарен №', 'lblFrom', {})}
          ${fld('До инвентарен №', 'lblTo', {})}
        </div>
        <div class="toolbar"><button class="btn pri" onclick="printLabelsRange()">Печат на диапазон</button>
        <button class="btn" onclick="printLabelsAll()">Всички</button></div>
        <div style="margin-top:10px;width:170px;border:1px solid var(--rule2);background:#fff;padding:8px 6px;text-align:center">
          ${lblCard({ barcode: '1', inv_number: 1, call_number: 'В-15/ВАЗ' })}
        </div>
        <div class="hint" style="margin-top:6px">Пример за оформлението.</div>
      </div>
      <div class="card"><h3 style="margin-top:0">Читателски карти</h3>
        <p class="hint" style="margin-top:0">Карта с логото и името на библиотеката, името на читателя,
        категорията, датата на регистрация и баркод на номера на картата.
        Размер ${esc(String(s.card_w ?? 90))} × ${esc(String(s.card_h ?? 60))} мм.</p>
        <div class="toolbar"><button class="btn pri" onclick="printCardsAll()">Печат на карти за всички</button></div>
        <div class="cardPreview" style="--cw:${esc(String(s.card_w ?? 90))}mm;--ch:${esc(String(s.card_h ?? 60))}mm">
          ${readerCardHtml({ name: 'Иванова, Мария Петрова', card_no: '000123', category: 'възрастен',
            registered_at: today(), id: 1 })}
        </div>
        <div class="hint" style="margin-top:6px">Пример за оформлението — показан е в истинския размер.
        ${s.logo ? '' : 'Логото се задава в „Настройки“ → „Лого на организацията“.'}</div>
      </div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Етикети за сигнатура за гръбчето на книгата</h3>
      <div class="note" style="margin-top:0">Само УДК на първия ред и авторски знак под него — без баркод, име на
      библиотеката или инвентарен номер.</div>
      <div class="grid g2">
        ${fld('От инвентарен №', 'sigFrom', {})}
        ${fld('До инвентарен №', 'sigTo', {})}
      </div>
      <div class="toolbar"><button class="btn pri" onclick="printSignatureLabelsRange()">Печат на диапазон</button>
      <button class="btn" onclick="printSignatureLabelsAll()">Всички</button></div>
      <div style="margin-top:10px;width:170px;border:1px solid var(--rule2);background:#fff;padding:8px 6px;text-align:center">
        ${sigLblCard({ udk: '821.163.2-31', author_mark: 'В-15', inv_number: 1, barcode: '1' })}
      </div>
      <div class="hint" style="margin-top:6px">Пример за оформлението.</div>
    </div>

    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Проверка на четеца</h3>
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        <div style="width:200px;border:1px solid var(--rule2);background:#fff;padding:9px;text-align:center">
          ${code39svg('TEST-123', 170, 48)}<div style="font-size:11px;margin-top:3px">TEST-123</div>
        </div>
        <div style="flex:1;min-width:240px">
          <input id="testScan" placeholder="Сканирайте пробния баркод тук…" autocomplete="off">
          <div id="testOut" class="hint" style="margin-top:7px">Ако се появи TEST-123, четецът е настроен правилно.</div>
        </div>
      </div>
    </div>`;
  const t = $('#testScan');
  t.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return; e.preventDefault();
    $('#testOut').innerHTML = t.value.trim().toUpperCase() === 'TEST-123'
      ? '<b style="color:var(--green)">Отлично — четецът работи и добавя Enter накрая.</b>'
      : 'Прочетено: <b>' + esc(t.value) + '</b> — различава се от очакваното TEST-123.';
  });
}
async function saveLabelFormat() {
  const d = formData('#lblFmtF');
  await call(window.api.settings.updateLabelFormat(d), 'Форматът за печат на етикети е записан.');
  await loadSettingsCache();
  renderLabels(); // прегледите се преначертават с новите размери
}
window.saveLabelFormat = saveLabelFormat;
