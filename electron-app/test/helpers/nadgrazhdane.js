'use strict';
/* Общото на nadgrazhdane-*.test.js — виж описанието в nadgrazhdane-v1200.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { startMainApp } = require('./main-app');
const { localToday } = require('./local-day');

const FIX = path.join(__dirname, '..', 'fixtures');
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + JSON.stringify(r && r.error)); return r.data; };

/* Текущата версия на схемата — от main.js, не преписана тук. Един файл = една
   стара база: main.js се зарежда веднъж на процес, тоест програмата тръгва
   веднъж на тестов файл. */
const CURRENT = Number((fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8').match(/const CURRENT_SCHEMA_VERSION = (\d+);/) || [])[1]);

function upgradeTest(ver, schema) {
  test('база от ' + ver + ' (схема ' + schema + ') се отваря от текущата програма — данните, еврото, регистрите, гишето', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nadgr-'));
    const old = path.join(tmp, 'old.db');
    fs.writeFileSync(old, zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'stara-baza-' + ver + '.db.gz'))));
    const pre = new Database(old, { readonly: true });
    assert.equal(pre.pragma('user_version', { simple: true }), schema, 'фикстурата е от схема ' + schema);
    const valueLev = pre.prepare("SELECT ROUND(SUM(price), 2) v FROM books WHERE status != 'отчислен'").get().v;
    pre.close();
    const app = startMainApp({ seedDb: (p) => fs.copyFileSync(old, p) });
    try {
      await app.ready();
      const db = new Database(path.join(app.userData, 'library.db'), { readonly: true });
      const q = (s) => db.prepare(s).get();
      try {
        assert.equal(db.pragma('user_version', { simple: true }), CURRENT, 'схемата е вдигната до текущата');
        assert.equal(q('PRAGMA integrity_check').integrity_check, 'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.deepEqual([q('SELECT COUNT(*) n FROM books').n, q('SELECT COUNT(*) n FROM readers').n, q('SELECT COUNT(*) n FROM loans').n,
          q('SELECT COUNT(*) n FROM loans WHERE date_in IS NULL').n, q('SELECT COUNT(*) n FROM deaccession_acts').n,
          q("SELECT COUNT(*) n FROM books WHERE status = 'отчислен'").n], [40, 12, 10, 6, 1, 2],
          'книги, читатели, заемания, отворени, актове, отчислени — както в старата база');
        assert.equal(q('SELECT lib_name FROM settings WHERE id = 1').lib_name, 'Библиотека „Старо“', 'настройките са запазени');
        const valueEur = q("SELECT ROUND(SUM(price), 2) v FROM books WHERE status != 'отчислен'").v;
        assert.ok(Math.abs(valueEur - valueLev / 1.95583) < 0.05, 'цените са превалутирани: ' + valueLev + ' лв. → ' + valueEur + ' €');
      } finally { db.close(); }

      // Регистрите и гишето — през истинските обработчици.
      const kdbf = ok(await app.invoke('kdbf:report', '2026'), 'КДБФ');
      assert.ok(kdbf.part1.some(a => /Книжарница/.test(a.from_source || '')), 'старата партида е в Част № 1');
      assert.equal(kdbf.part3.length, 1, 'старият акт е в Част № 3');
      const over = ok(await app.invoke('loans:overdue'), 'просрочени');
      assert.equal(over.length, 6, 'шестте стари просрочени заемания');
      assert.ok(over.every(l => /^Стар Читател/.test(l.reader_name || '')), 'с имената на старите читатели');
      const free = ok(await app.invoke('books:list', ''), 'книги');
      const rows = Array.isArray(free) ? free : (free.rows || []);
      const avail = rows.find(b => b.status === 'наличен' && !b.on_loan && !(b.loaned > 0));
      assert.ok(avail, 'има свободна стара книга');
      const readers = ok(await app.invoke('readers:list', ''), 'читатели');
      const rid = (Array.isArray(readers) ? readers : readers.rows).find(r => r.card_no === '711').id;
      const T = localToday();
      const loan = ok(await app.invoke('loans:checkout', { reader_id: rid, book_id: avail.id, date_out: T }), 'заемане след надграждането');
      ok(await app.invoke('loans:return', { id: loan && loan.id != null ? loan.id : loan, date_in: T }), 'връщане след надграждането');
    } finally {
      app.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
module.exports = { upgradeTest };
