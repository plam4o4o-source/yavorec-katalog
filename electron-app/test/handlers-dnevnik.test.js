// Тест на handlers/dnevnik.js — трийсети домейн, извадено от main.js
// (Фаза 4, стъпка 30). Покрива dnevnik:getMonth/saveDay/suggest/exportCsv.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const registerDnevnikHandlers = require('../handlers/dnevnik');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-dnevnik-test-'));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  db.exec(schemaSql);

  const auditLog = [];
  const savedDialogs = { saveDialog: null };
  const ipcMain = fakeIpcMain();
  const deps = {
    getDb: () => db,
    run: (fn) => {
      try { return { ok: true, data: fn() }; }
      catch (err) { return { ok: false, error: err.message }; }
    },
    logAudit: (action, detail) => auditLog.push({ action, detail }),
    dialog: {
      showSaveDialog: async () => savedDialogs.saveDialog || { canceled: false, filePath: path.join(dir, 'out.csv') }
    },
    getMainWindow: () => ({}),
    fs
  };
  const returned = registerDnevnikHandlers(ipcMain, deps);
  return { db, ipcMain, auditLog, dir, savedDialogs, returned };
}

test('registerDnevnikHandlers registers dnevnik:getMonth/saveDay/suggest/exportCsv and returns dnevnikSumRow', () => {
  const { ipcMain, returned } = setup();
  assert.ok(ipcMain.has('dnevnik:getMonth'));
  assert.ok(ipcMain.has('dnevnik:saveDay'));
  assert.ok(ipcMain.has('dnevnik:suggest'));
  assert.ok(ipcMain.has('dnevnik:exportCsv'));
  assert.equal(typeof returned.dnevnikSumRow, 'function');
});

test('dnevnik:saveDay inserts a day and logs the audit entry', async () => {
  const { db, ipcMain, auditLog } = setup();
  const result = await ipcMain.invoke('dnevnik:saveDay', { date: '2026-03-05', a_hours: 6, b_hours: 6 });
  assert.equal(result.ok, true);
  const row = db.prepare('SELECT * FROM dnevnik_days WHERE date = ?').get('2026-03-05');
  assert.equal(row.a_hours, 6);
  assert.ok(auditLog.some(a => a.action === 'Дневник' && /2026-03-05/.test(a.detail)));
});

test('dnevnik:saveDay upserts on conflict (re-saving the same date updates it)', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('dnevnik:saveDay', { date: '2026-03-05', a_hours: 6 });
  await ipcMain.invoke('dnevnik:saveDay', { date: '2026-03-05', a_hours: 9 });
  const result = await ipcMain.invoke('dnevnik:getMonth', { year: 2026, month: 3 });
  const day5 = result.data.days.find(d => d.day === 5);
  assert.equal(day5.a_hours, 9);
});

test('dnevnik:getMonth returns all days of the month with computed totals', async () => {
  const { ipcMain } = setup();
  await ipcMain.invoke('dnevnik:saveDay', { date: '2026-02-01', a_hours: 4, a_age_u14: 2, a_age_15_18: 1 });
  const result = await ipcMain.invoke('dnevnik:getMonth', { year: 2026, month: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.data.daysInMonth, 28); // 2026 is not a leap year
  assert.equal(result.data.days.length, 28);
  const day1 = result.data.days.find(d => d.day === 1);
  assert.equal(day1.a_total_age, 3);
  assert.equal(result.data.monthTotal.a_hours, 4);
  assert.equal(result.data.ytdTotal.a_hours, 4);
});

test('dnevnik:suggest derives Section B counts from loan/book fields and Section A from reader categories', async () => {
  const { db, ipcMain } = setup();
  db.prepare(`INSERT INTO events (date, kind, reader_id, reader_category, book_category, book_language, book_udk)
    VALUES ('2026-04-10', 'заемане', 1, 'ученик', 'книга', 'български', '82')`).run();
  db.prepare(`INSERT INTO events (date, kind, reader_id, reader_category)
    VALUES ('2026-04-10', 'читалня', 1, 'ученик')`).run();

  const result = await ipcMain.invoke('dnevnik:suggest', { date: '2026-04-10' });
  assert.equal(result.ok, true);
  assert.equal(result.data.eventsCount, 2);
  assert.equal(result.data.suggestions.b_type_books, 1);
  assert.equal(result.data.suggestions.b_lang_bg, 1);
  assert.equal(result.data.suggestions.b_cat_82, 1);
  assert.equal(result.data.suggestions.a_age_15_18, 1); // counted once, deduped by reader
  assert.equal(result.data.suggestions.a_visit_reading, 1);
});

test('dnevnik:suggest falls back to UDK-less/unmapped defaults for unknown category/language', async () => {
  const { db, ipcMain } = setup();
  db.prepare(`INSERT INTO events (date, kind, reader_category, book_category, book_language)
    VALUES ('2026-04-11', 'заемане', 'друго', 'непознат вид', 'испански')`).run();
  const result = await ipcMain.invoke('dnevnik:suggest', { date: '2026-04-11' });
  assert.equal(result.data.suggestions.b_type_books, 1); // unmapped category defaults to books
  assert.equal(result.data.suggestions.b_lang_other, 1);
  assert.equal(result.data.suggestions.a_age_o28, 1); // unmapped reader category defaults to o28
});

test('dnevnik:exportCsv writes a semicolon-separated CSV with a BOM and all field columns', async () => {
  const { db, ipcMain, dir } = setup();
  db.prepare("INSERT INTO dnevnik_days (date, a_hours) VALUES ('2026-05-01', 3)").run();
  const outPath = path.join(dir, 'export.csv');
  const result = await ipcMain.invoke('dnevnik:exportCsv', { year: 2026, month: 5 });
  assert.equal(result.ok, true);
  const content = fs.readFileSync(result.data, 'utf8');
  // Header row is joined raw (unescaped); only per-day data rows go through esc().
  assert.ok(content.startsWith('﻿Дата;a_hours;'));
  assert.ok(content.includes('"2026-05-01"'));
});

test('dnevnik:exportCsv reports a friendly error when the user cancels the save dialog', async () => {
  const { ipcMain, savedDialogs } = setup();
  savedDialogs.saveDialog = { canceled: true, filePath: null };
  const result = await ipcMain.invoke('dnevnik:exportCsv', { year: 2026, month: 5 });
  assert.equal(result.ok, false);
  assert.match(result.error, /Отказано/);
});
