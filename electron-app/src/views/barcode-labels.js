/* ---------------- Баркод етикети ---------------- */
async function renderLabels() {
  /* „|| {}“ не е излишно: call() връща null при отказ от базата (заета от другото
     работно място), а редът с настройките може и да липсва. Без него разделът е
     ЕДИНСТВЕНИЯТ, който гърми с TypeError и оставя заглавието на „Баркод етикети“
     върху съдържанието на предишния раздел. Полетата и без това си имат
     подразбирания (s.lbl_cols ?? 3 и т.н.). */
  const s = SETTINGS_CACHE || await loadSettingsCache() || {};
  /* ЧЕТИРИТЕ ЧИСЛА НА ГОТОВИЯ ЛИСТ (v2.4.69, кръг 44, Е2). Дотук формата имаше
     „Поле на листа“ (едно за четирите страни) и „Разстояние между етикетите“ (едно
     за двете посоки) — а готовите листове не са симетрични: Avery L7160 е горе
     15,1, ляво 7,2, хоризонтално 2,5, вертикално 0, и нито едно общо число не ги
     събира (mreja.py: първият ред 8 мм по-високо, последният 7 мм по-ниско). Сега
     полетата са четири, както ги пише на опаковката на листа; колоните от
     миграция 18 вече пазят досегашните стойности, така че нищо не мърда.
     Подразбирането за стара база без тях — от lbl_margin/lbl_gap. */
  const dflt = (v, d) => (v === '' || v == null ? d : v);
  const mt = dflt(s.lbl_mt, dflt(s.lbl_margin, 8)), ml = dflt(s.lbl_ml, dflt(s.lbl_margin, 8));
  const gx = dflt(s.lbl_gx, dflt(s.lbl_gap, 3)), gy = dflt(s.lbl_gy, dflt(s.lbl_gap, 3));
  $('#view').innerHTML = `
    <div class="note">Етикетите се печатат във формат <b>Code 39</b> — разчита се от всеки USB баркод четец без настройка.
    Съвместимо е с обикновен принтер (A4 лист, брой колони по избор) и с ролкови лейбъл принтери
    (Zebra, Brother QL, Dymo и др.). Размерите на трите вида етикети се задават поотделно по-долу.</div>

    <div class="card"><h3 style="margin-top:0">Формат на печат за етикети</h3>
      <form id="lblFmtF" onsubmit="return false">
        <fieldset><legend>Хартия</legend>
          <div class="grid g4">
            ${fld('Формат', 'lbl_mode', { type: 'select', allowEmpty: false, val: s.lbl_mode, opts: [{ v: 'sheet', t: 'A4 лист (в колони)' }, { v: 'roll', t: 'Ролков лейбъл принтер' }] })}
            ${fld('Колони на листа', 'lbl_cols', { val: s.lbl_cols ?? 3, type: 'number', hint: 'за етикетите за фонда' })}
          </div>
          <div class="grid g4">
            ${decField('Поле отгоре (мм)', 'lbl_mt', { val: mt, min: 0, hint: 'до горния ръб на първия ред етикети' })}
            ${decField('Поле отляво (мм)', 'lbl_ml', { val: ml, min: 0, hint: 'до левия ръб на първата колона' })}
            ${decField('Разстояние хоризонтално (мм)', 'lbl_gx', { val: gx, min: 0, hint: 'между две колони' })}
            ${decField('Разстояние вертикално (мм)', 'lbl_gy', { val: gy, min: 0, hint: 'между два реда; 0 при листове без междина' })}
          </div>
          <div class="hint">Числата са за A4 лист — вземат се от опаковката на готовите листове (напр. Avery L7160:
          горе 15,1, ляво 7,2, хоризонтално 2,5, вертикално 0). Ролковият печат запълва целия етикет и не ги ползва.
          ${labelFmtSummary()}</div>
          <label class="chk"><input type="checkbox" name="lbl_border" ${(s.lbl_border == null || +s.lbl_border) ? 'checked' : ''}>
            Пунктирана рамка около всеки етикет (помага при рязане; изключете я при готови листове с етикети)</label>
        </fieldset>
        <fieldset><legend>Размери на трите вида етикети (мм)</legend>
          <div class="grid g3">
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Етикет за фонда</b></div>
              <div class="grid g2">
                ${decField('Ширина', 'lbl_w', { val: s.lbl_w ?? 40, min: 1 })}
                ${decField('Височина', 'lbl_h', { val: s.lbl_h ?? 30, min: 1 })}
              </div>
            </div>
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Етикет за сигнатура</b></div>
              <div class="grid g2">
                ${decField('Ширина', 'sig_w', { val: s.sig_w ?? 25, min: 1 })}
                ${decField('Височина', 'sig_h', { val: s.sig_h ?? 35, min: 1 })}
              </div>
            </div>
            <div>
              <div class="hint" style="margin-bottom:4px"><b>Читателска карта</b></div>
              <div class="grid g2">
                ${decField('Ширина', 'card_w', { val: s.card_w ?? 90, min: 1 })}
                ${decField('Височина', 'card_h', { val: s.card_h ?? 60, min: 1 })}
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
        <div class="grid g3">
          ${fld('От инвентарен №', 'lblFrom', {})}
          ${fld('До инвентарен №', 'lblTo', {})}
          ${startField('lblStart', 'fund')}
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
      <div class="note" style="margin-top:0">Ако полето „Сигнатура“ на книгата е попълнено, етикетът печата само
      него; иначе — УДК на първия ред и авторски знак под него. Без баркод, име на библиотеката или инвентарен номер.
      Дълга УДК се пренася на смислени части и шрифтът се смалява, докато се събере в етикета.</div>
      <div class="grid g3">
        ${fld('От инвентарен №', 'sigFrom', {})}
        ${fld('До инвентарен №', 'sigTo', {})}
        ${startField('sigStart', 'sig')}
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
/* „ЗАПОЧНИ ОТ ПОЗИЦИЯ N“ (v2.4.69, кръг 44, Е2). Полуизползван лист с готови
   етикети досега се хвърляше: печатът винаги започваше от горния ляв ъгъл. Полето
   е при самия печат, не в настройките — то е за ЕДИН лист и не бива да остане за
   следващия път. Позициите се броят по редове, отляво надясно. */
function startField(name, kind) {
  const L = labelSheetLayout(kind);
  if (L.roll) return '';
  return fld('Започни от позиция на листа', name, { type: 'number', val: '1',
    hint: '1 = горе вляво; до ' + L.perSheet + ' (' + L.cols + ' × ' + L.rows + ' на лист) — за допечатване на започнат лист' });
}
/* Позицията от полето — или null и съобщение, ако е извън листа. */
function labelStartPos(name, kind) {
  const el = $('[name=' + name + ']');
  const raw = el ? String(el.value || '').trim() : '';
  if (!raw) return 1;
  const L = labelSheetLayout(kind);
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > L.perSheet) {
    toast('„Започни от позиция“ трябва да е цяло число от 1 до ' + L.perSheet + ' — толкова '
      + (kind === 'sig' ? 'сигнатурни етикета' : 'етикета') + ' има на един лист при сегашния формат ('
      + L.cols + ' колони × ' + L.rows + ' реда). Нищо не е отпечатано.', 'err');
    return null;
  }
  return n;
}
window.labelStartPos = labelStartPos;
/* Колко етикета от всеки вид влизат на лист при записания формат — за да се види
   веднага, преди печат, дали числата отговарят на листа (Е2). */
function labelFmtSummary() {
  const f = labelSheetLayout('fund'), g = labelSheetLayout('sig'), c = labelSheetLayout('card');
  if (f.roll) return '';
  return '<br>При записания формат на лист A4 излизат: етикети за фонда <b>' + f.cols + ' × ' + f.rows
    + '</b>, сигнатурни <b>' + g.cols + ' × ' + g.rows + '</b>, читателски карти <b>' + c.cols + ' × ' + c.rows + '</b>'
    + ' (сигнатурните етикети и картите се нареждат в толкова колони, колкото се събират).';
}
/* Милиметрите са decField, не <input type="number"> (v2.4.69, Е2): „15,1“ от
   опаковката на листа в числово поле на Chromium с български език става 151 — а
   обработчикът го подрязва до 40 мм без дума. Затова: запетаята се приема
   (fieldValue → „15.1“), нечисловото се спира тук с името на полето, а ако
   обработчикът все пак подреже стойност до допустимата граница, казва коя. */
async function saveLabelFormat() {
  const bad = badDecimalField('#lblFmtF');
  if (bad) return toast('„' + bad.label + '“: „' + bad.value + '“ не е число в милиметри (напр. 15,1). Форматът не е записан.', 'err');
  const d = formData('#lblFmtF');
  const res = await call(window.api.settings.updateLabelFormat(d), 'Форматът за печат на етикети е записан.');
  if (res && Array.isArray(res.clamped) && res.clamped.length) {
    toast('Някои стойности бяха извън допустимото и са записани с най-близката граница: '
      + res.clamped.map(c => c.label + ' ' + c.given + ' → ' + c.saved + ' мм').join('; ') + '.', 'warn');
  }
  await loadSettingsCache();
  renderLabels(); // прегледите се преначертават с новите размери
}
window.saveLabelFormat = saveLabelFormat;
