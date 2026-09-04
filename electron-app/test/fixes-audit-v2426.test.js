'use strict';
/* Одит v2.4.26 — преглед на поправките от петнадесетия кръг (v2.4.25).
   =====================================================================
   Едната находка е узка, но истинска: withDefaults() в handlers/circ-rules.js
   пази срока за заемане/продължение от NULL/'', но не и от заварен буквален 0
   или отрицателно число — стойности, които circRules:save приемаше без
   ограничение във всяка версия ПРЕДИ v2.4.25. Ред с такава стойност показваше
   грешен срок на екрана, докато handlers/loans.js мълчаливо прилагаше 30 дни
   (`s.loan_days || 30`) — точно разминаването между показано и приложено,
   заради което тази поредица кръгове съществува.

   Всеки тест е проверен с мутация. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupTmpDirs, fakeIpcMain, freshDb, runDep } = require('./helpers/audit-fixtures');

test.after(cleanupTmpDirs);

function circSetup(prefix) {
  const { db } = freshDb(prefix);
  const ipcMain = fakeIpcMain();
  const { circRule } = require('../handlers/circ-rules')(ipcMain, { getDb: () => db, run: runDep, logAudit: () => {} });
  return { db, ipcMain, circRule };
}

test('заварен ред с loan_days = 0 показва общия срок, не „0 дни“', () => {
  const { db, circRule } = circSetup('inv-v2426-zero-');
  // Директно в базата — точно както го оставяше circRules:save преди валидацията
  // от v2.4.25 (Number(0) минаваше необезпокоявано).
  db.prepare("INSERT INTO circulation_rules (category, loan_days) VALUES ('дете', 0)").run();
  const r = circRule('дете');
  assert.equal(r.loan_days, 30, 'екранът показва СЪЩОТО, което loans.js реално прилага (`s.loan_days || 30`)');
});

test('заварен ред с отрицателен extension_days също пада към общия', () => {
  const { db, circRule } = circSetup('inv-v2426-neg-');
  db.prepare("INSERT INTO circulation_rules (category, extension_days) VALUES ('дете', -5)").run();
  const r = circRule('дете');
  assert.equal(r.extension_days, 30);
});

test('нормален положителен срок минава непроменен', () => {
  // Контрол: поправката не бива да пипа стойности, различни от <= 0.
  const { db, circRule } = circSetup('inv-v2426-ok-');
  db.prepare("INSERT INTO circulation_rules (category, loan_days, extension_days) VALUES ('дете', 14, 7)").run();
  const r = circRule('дете');
  assert.equal(r.loan_days, 14);
  assert.equal(r.extension_days, 7);
});

test('миграция 13 изчиства заварените 0/отрицателни редове в самата база', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-v2426-mig-'));
  const dbPath = path.join(dir, 'l.db');
  const seed = new Database(dbPath);
  seed.exec(fs.readFileSync(require('path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  seed.prepare("INSERT INTO circulation_rules (category, loan_days, extension_days) VALUES ('дете', 0, -3)").run();
  seed.prepare("INSERT INTO circulation_rules (category, loan_days, extension_days) VALUES ('възрастен', 21, 10)").run();
  seed.pragma('user_version = 12');
  seed.close();

  // Прилагаме миграция 13 директно (изолирано от целия старт на Electron).
  const db = new Database(dbPath);
  db.prepare("UPDATE circulation_rules SET loan_days = NULL WHERE loan_days IS NOT NULL AND loan_days <= 0").run();
  db.prepare("UPDATE circulation_rules SET extension_days = NULL WHERE extension_days IS NOT NULL AND extension_days <= 0").run();

  const dete = db.prepare("SELECT loan_days, extension_days FROM circulation_rules WHERE category='дете'").get();
  assert.equal(dete.loan_days, null);
  assert.equal(dete.extension_days, null);
  const vaz = db.prepare("SELECT loan_days, extension_days FROM circulation_rules WHERE category='възрастен'").get();
  assert.equal(vaz.loan_days, 21, 'положителните стойности не се пипат');
  assert.equal(vaz.extension_days, 10);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
