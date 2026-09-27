// Контролирани номенклатури (Koha: authorised_values) — извадени от main.js
// в отделен модул (Фаза 4, стъпка 12 от разбиването на монолита на модули
// по домейн). Един източник на истина за списъчните стойности (отдел,
// език, постоянно място). Изцяло самостоятелен: getDb()/run/logAudit.
module.exports = function registerAvHandlers(ipcMain, deps) {
  const { getDb, run, logAudit } = deps;

  const AV_CATEGORIES = {
    department: 'Отдел / местонахождение',
    language: 'Език',
    location: 'Постоянно място (рафт, витрина, шкаф)'
  };
  function avOptions() {
    const db = getDb();
    const out = {};
    for (const c of Object.keys(AV_CATEGORIES)) {
      out[c] = db.prepare('SELECT value, opac_label FROM authorised_values WHERE category = ? ORDER BY sort, value').all(c);
    }
    return out;
  }
  ipcMain.handle('av:categories', () => run(() => AV_CATEGORIES));
  ipcMain.handle('av:options', () => run(() => avOptions()));
  // Замества целия списък на една категория наведнъж — редакторът в Настройки подава
  // пълния нов ред на стойностите (ред по ред), затова частични UPDATE-и не са нужни.
  ipcMain.handle('av:save', (e, { category, values }) =>
    run(() => {
      if (!(category in AV_CATEGORIES)) throw new Error('Непозната номенклатура.');
      const list = (values || [])
        .map(v => ({ value: String(v.value || '').trim(), opac_label: String(v.opac_label || '').trim() || null }))
        .filter(v => v.value);
      const seen = new Set();
      for (const v of list) {
        if (seen.has(v.value)) throw new Error('Стойността „' + v.value + '“ се повтаря в списъка.');
        seen.add(v.value);
      }
      const db = getDb();
      const labelsOf = () => JSON.stringify(db.prepare(
        'SELECT value, opac_label FROM authorised_values WHERE category = ? ORDER BY value').all(category));
      const before = labelsOf();
      db.transaction(() => {
        db.prepare('DELETE FROM authorised_values WHERE category = ?').run(category);
        const ins = db.prepare('INSERT INTO authorised_values (category, value, opac_label, sort) VALUES (?, ?, ?, ?)');
        list.forEach((v, i) => ins.run(category, v.value, v.opac_label, i));
      }).immediate();
      /* ПУБЛИЧНИЯТ НАДПИС СТИГА ДО ОНЛАЙН КАТАЛОГА (v2.4.69, кръг 44, К2).
         (а) Отделът и езикът излизат в katalog.json през публичния си надпис
             (opac_label). Дотук записът в Настройки не пускаше нов katalog.json —
             тестер № 5: надпис „Възрастни“ за „за възрастни“, файлът не се
             промени, на сайта остана вътрешното име.
         (б) Смисълът на публичния надпис е вътрешният жаргон да НЕ се вижда
             навън; докато файлът не се пренапише, се вижда.
         (в) Насрочва се отложеният запис само за двете номенклатури, които
             стигат до каталога (отдел и език), и само ако списъкът наистина се
             е променил (редакторът записва и без промяна). Зависимостта е
             незадължителна (подава я main.js). */
      if ((category === 'department' || category === 'language') && labelsOf() !== before
        && typeof deps.scheduleCatalogWrite === 'function') deps.scheduleCatalogWrite();
      logAudit('Номенклатури', AV_CATEGORIES[category] + ': ' + list.length + (list.length === 1 ? ' стойност' : ' стойности'));
      return list.length;
    })
  );
};
