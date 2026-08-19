// Тест на handlers/print.js (v1.72.0) — „Запази PDF…“ от прегледа преди
// печат. Системният диалог на Windows не визуализира Electron съдържание,
// затова печатният документ се записва директно като PDF (printToPDF) и се
// отваря в PDF четеца. Handler-ът няма база данни — фалшифицират се
// прозорецът (webContents.printToPDF), диалогът за запис и shell.openPath,
// а записът на файла е истински (temp папка).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registerPrintHandlers = require('../handlers/print');


/* Хигиена на временните папки. node --test не чисти нищо след себе си, а всяка
   фикстура тук създава каталог в /tmp. Одитът завари 80 431 каталога / 23 GB;
   при пълен диск поредицата започва да пада лавинообразно на съвсем несвързани
   места (# pass 302 / # fail 345) и прати диагностиката по грешна следа.
   mkTmpDir() запомня папката, test.after() я трие. */
const tmpDirs = [];
function mkTmpDir(prefixPath) {
  const d = fs.mkdtempSync(prefixPath);
  tmpDirs.push(d);
  return d;
}
test.after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* нищо не зависи от това */ }
  }
});

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function setup(opts) {
  opts = opts || {};
  const dir = mkTmpDir(path.join(os.tmpdir(), 'inv-print-test-'));
  const calls = { printToPDF: [], openPath: [], saveDialog: [], audit: [] };
  const win = {
    webContents: {
      printToPDF: async (o) => { calls.printToPDF.push(o); return Buffer.from('%PDF-1.7 проба'); }
    }
  };
  const ipcMain = fakeIpcMain();
  registerPrintHandlers(ipcMain, {
    getMainWindow: () => (opts.noWindow ? null : win),
    dialog: {
      showSaveDialog: async (w, o) => {
        calls.saveDialog.push(o);
        if (opts.cancel) return { canceled: true };
        return { canceled: false, filePath: path.join(dir, 'дoc.pdf') };
      }
    },
    fs, path,
    app: { getPath: () => dir },
    shell: { openPath: (p) => { calls.openPath.push(p); } },
    logAudit: (a, d) => calls.audit.push([a, d])
  });
  return { ipcMain, calls, dir };
}

test('print:savePdf записва PDF файла и го отваря', async () => {
  const { ipcMain, calls, dir } = setup();
  const res = await ipcMain.invoke('print:savePdf', { fileName: 'Инвентарна книга — 13.08.2026' });
  assert.equal(res.ok, true);
  const saved = res.data.path;
  assert.ok(fs.existsSync(saved), 'PDF файлът трябва да е записан на диска');
  assert.equal(fs.readFileSync(saved, 'utf8'), '%PDF-1.7 проба');
  assert.equal(calls.openPath.length, 1, 'PDF-ът трябва да се отвори веднага след записа');
  assert.equal(calls.openPath[0], saved);
  // Диалогът предлага името на документа като име на файла (в Documents).
  assert.match(calls.saveDialog[0].defaultPath, /Инвентарна книга — 13\.08\.2026\.pdf$/);
  assert.equal(calls.audit.length, 1, 'записът се вписва в одитната следа');
  assert.ok(dir); // temp папката съществува
});

test('print:savePdf минава през печатния рендер: printBackground + preferCSSPageSize', async () => {
  const { ipcMain, calls } = setup();
  await ipcMain.invoke('print:savePdf', { fileName: 'Етикети' });
  assert.equal(calls.printToPDF.length, 1);
  // printBackground — иначе Windows реже фоновете (читателската карта става
  // гол текст); preferCSSPageSize — размерът/полетата идват от @page
  // (setPrintPage), еднакво за A4, пейзаж и ролкови етикети.
  assert.equal(calls.printToPDF[0].printBackground, true);
  assert.equal(calls.printToPDF[0].preferCSSPageSize, true);
});

test('print:savePdf при отказ от диалога връща познатата грешка и НЕ вика printToPDF', async () => {
  const { ipcMain, calls } = setup({ cancel: true });
  const res = await ipcMain.invoke('print:savePdf', { fileName: 'Документ' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Отказано от потребителя.');
  assert.equal(calls.printToPDF.length, 0, 'без избран файл не се рендира PDF');
  assert.equal(calls.openPath.length, 0);
});

test('print:savePdf без активен прозорец връща грешка, не хвърля', async () => {
  const { ipcMain } = setup({ noWindow: true });
  const res = await ipcMain.invoke('print:savePdf', { fileName: 'Документ' });
  assert.equal(res.ok, false);
  assert.match(res.error, /прозорец/);
});

test('print:savePdf без подадено име пада се към „Документ“', async () => {
  const { ipcMain, calls } = setup();
  await ipcMain.invoke('print:savePdf');
  assert.match(calls.saveDialog[0].defaultPath, /Документ\.pdf$/);
});
