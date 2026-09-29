'use strict';
/* Кръг 45 (v2.4.71) — ОСНОВИТЕ: миграция 19.
   ==========================================================================
   Заварена база от v2.4.70 (схема 18) — БЕЗ таблицата reader_registrations и
   БЕЗ колоната periodicals.language — се отваря от истинския main.js в отделен
   процес (main.js се зарежда веднъж на процес). Проверява се:
   * Д3: историята на записванията се попълва от датата на записване, от
     последната пререгистрация И от предишните пререгистрации, за които
     свидетелства начислената „годишна такса“ — тоест читателят, пререгистриран
     на 10.02.2025 и после на 12.02.2026, остава преброен и за 2025 г.;
   * Д2: заварените издания и годишните им комплекти получават „български“, а
     одитната следа го казва с броя;
   * И1/М1/И6: колоните на проверката и снимката на ръководителя се добавят и
     към заварена база. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');

function openOld(extraAfter) {
  const script = `
    const fs = require('fs'), path = require('path'), Database = require('better-sqlite3');
    const { startMainApp } = require(${JSON.stringify(path.join(__dirname, 'helpers', 'main-app'))});
    const app = startMainApp({ seedDb(p) {
      const db = new Database(p);
      db.exec(fs.readFileSync(path.join(${JSON.stringify(APP_DIR)}, 'db', 'schema.sql'), 'utf8'));
      /* Връщаме базата към вида на схема 18: без новата таблица и колона. */
      db.exec('DROP TABLE reader_registrations');
      db.exec('ALTER TABLE periodicals DROP COLUMN language');
      for (const c of ['last_book_id', 'added_late', 'mzs_away', 'director']) db.exec('ALTER TABLE inventory_sessions DROP COLUMN ' + c);
      db.exec('ALTER TABLE acquisitions DROP COLUMN director');
      db.exec('ALTER TABLE deaccession_acts DROP COLUMN director');
      const addR = db.prepare("INSERT INTO readers (name, status, gdpr_consent, registered_at, re_registered_at) VALUES (?, 'активен', 1, ?, ?)");
      const a = addR.run('Стар Читател', '2024-03-05', '2026-02-12').lastInsertRowid;
      addR.run('Нов Читател', '2026-04-01', null);
      /* Пререгистрация БЕЗ начислена такса (безплатна категория): единствената
         следа е колоната re_registered_at — така миграцията се проверява поотделно
         по колоната и по таксата (при „Стар Читател“ двете сочат един и същи ден
         и всяка от тях сама би дала реда за 2026 г.). */
      addR.run('Трети Читател', '2023-09-15', '2025-06-03');
      const fee = db.prepare("INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, 'начисление', 'годишна такса', 5, null)");
      fee.run(a, '2025-02-10'); fee.run(a, '2026-02-12');
      db.prepare("INSERT INTO periodicals (title, freq) VALUES ('Труд', 'ежедневник')").run();
      db.prepare("INSERT INTO books (inv_number, title, volume, series, status, register_date) VALUES ('1', 'Труд, 2025', 'годишен комплект', 'Труд', 'наличен', '2026-01-10')").run();
      db.pragma('user_version = 18');
      db.close();
    } });
    app.ready().then(() => {
      const db = new Database(path.join(app.userData, 'library.db'), { readonly: true });
      const out = {
        v: db.pragma('user_version', { simple: true }),
        regs: db.prepare("SELECT r.name, g.date, g.kind FROM reader_registrations g JOIN readers r ON r.id = g.reader_id ORDER BY r.name, g.date").all(),
        perLang: db.prepare('SELECT language FROM periodicals').all().map(x => x.language),
        volLang: db.prepare("SELECT language FROM books WHERE volume = 'годишен комплект'").all().map(x => x.language),
        audit: db.prepare("SELECT detail FROM audit_log WHERE detail LIKE '%v2.4.71%'").all().map(x => x.detail),
        cols: Object.fromEntries(['inventory_sessions', 'acquisitions', 'deaccession_acts'].map(t =>
          [t, db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name)]))
      };
      db.close(); app.stop();
      process.stdout.write('\\n' + JSON.stringify(out) + '\\n');
      process.exit(0);
    }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: APP_DIR, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'заварената база не се отвори: ' + r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('миграция 19 — историята на записванията и езикът на периодиката', () => {
  const out = openOld();
  assert.ok(out.v >= 19, 'миграция 19 е минала (user_version ' + out.v + ')');
  assert.deepEqual(out.regs.map(x => x.name + ' ' + x.date + ' ' + x.kind), [
    'Нов Читател 2026-04-01 записване',
    'Стар Читател 2024-03-05 записване',
    /* 2025: единствената следа е таксата — re_registered_at вече е 2026. */
    'Стар Читател 2025-02-10 пререгистрация',
    /* 2026: и колоната, и таксата сочат същия ден — един ред, не два. */
    'Стар Читател 2026-02-12 пререгистрация',
    'Трети Читател 2023-09-15 записване',
    /* Само от колоната — без такса няма друг източник. */
    'Трети Читател 2025-06-03 пререгистрация'
  ]);
  assert.deepEqual(out.perLang, ['български']);
  assert.deepEqual(out.volLang, ['български'], 'завареният годишен комплект получава езика на изданието');
  assert.equal(out.audit.length, 1, 'попълването на езика се казва в одитната следа');
  assert.match(out.audit[0], /1 издания и на 1 годишни комплекта/);
  /* И1, М1, И6: новите колони на проверката и снимката на ръководителя идват и в
     заварена база — schema.sql не добавя колони към съществуваща таблица. */
  for (const c of ['last_book_id', 'added_late', 'mzs_away', 'director']) assert.ok(out.cols.inventory_sessions.includes(c), 'inventory_sessions.' + c);
  assert.ok(out.cols.acquisitions.includes('director'), 'acquisitions.director');
  assert.ok(out.cols.deaccession_acts.includes('director'), 'deaccession_acts.director');
});
