// Тест на handlers/isbn-lookup.js — девети домейн, извадено от main.js
// (Фаза 4, стъпка 10). `net.fetch` (Electron API) се подменя с фалшива
// реализация, за да се тества без реална мрежова връзка — покрива Google
// Books/Open Library success/fail комбинации и SRU MARC parsing.
const test = require('node:test');
const assert = require('node:assert/strict');
const registerIsbnLookupHandlers = require('../handlers/isbn-lookup');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    has: (channel) => handlers.has(channel)
  };
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textResponse(body, ok = true, status = 200) {
  return { ok, status, text: async () => body, json: async () => JSON.parse(body) };
}

function setup(fetchImpl, sruEndpoint) {
  const db = { prepare: () => ({ get: () => ({ sru_endpoint: sruEndpoint || '' }) }) };
  const ipcMain = fakeIpcMain();
  const net = { fetch: fetchImpl };
  registerIsbnLookupHandlers(ipcMain, { net, getDb: () => db });
  return { ipcMain };
}

test('registerIsbnLookupHandlers registers isbn:lookup and sru:lookup', () => {
  const { ipcMain } = setup(async () => jsonResponse({}));
  assert.ok(ipcMain.has('isbn:lookup'));
  assert.ok(ipcMain.has('sru:lookup'));
});

test('isbn:lookup rejects an invalid ISBN before making any network request', async () => {
  let called = false;
  const { ipcMain } = setup(async () => { called = true; return jsonResponse({}); });
  const result = await ipcMain.invoke('isbn:lookup', '123');
  assert.equal(result.ok, false);
  assert.match(result.error, /Невалиден ISBN/);
  assert.equal(called, false);
});

test('isbn:lookup merges Google Books and Open Library, preferring Google Books field-by-field then falling back', async () => {
  const { ipcMain } = setup(async (url) => {
    if (url.includes('googleapis.com')) {
      return jsonResponse({ items: [{ volumeInfo: { title: 'Заглавие от Google', authors: ['Автор Г'], language: 'bg' } }] });
    }
    if (url.includes('openlibrary.org')) {
      return jsonResponse({
        'ISBN:9789540000000': { title: 'Заглавие от OL', publish_places: [{ name: 'София' }], number_of_pages: 200 }
      });
    }
    throw new Error('unexpected url ' + url);
  });
  const result = await ipcMain.invoke('isbn:lookup', '978-954-0000-00-0');
  assert.equal(result.ok, true);
  assert.equal(result.data.isbn, '9789540000000');
  assert.equal(result.data.title, 'Заглавие от Google', 'Google Books wins when both have a value');
  assert.equal(result.data.city, 'София', 'falls back to Open Library when Google Books lacks a field');
  assert.equal(result.data.pages, '200');
  assert.equal(result.data.language, 'български');
  assert.equal(result.data.sources, 'Google Books и Open Library');
});

test('isbn:lookup reports "not found" (not a connection error) when both services respond but neither has the book', async () => {
  const { ipcMain } = setup(async () => jsonResponse({}));
  const result = await ipcMain.invoke('isbn:lookup', '9780000000002');
  assert.equal(result.ok, false);
  assert.match(result.error, /Няма намерено заглавие/);
});

test('isbn:lookup reports a connection error (distinct message) when both services throw', async () => {
  const { ipcMain } = setup(async () => { throw new Error('network down'); });
  const result = await ipcMain.invoke('isbn:lookup', '9780000000002');
  assert.equal(result.ok, false);
  assert.match(result.error, /Няма връзка с Google Books и Open Library/);
});

test('isbn:lookup still returns data when only one of the two services has the book', async () => {
  const { ipcMain } = setup(async (url) => {
    if (url.includes('googleapis.com')) return jsonResponse({ items: [] });
    return jsonResponse({ 'ISBN:9780000000002': { title: 'Само в Open Library' } });
  });
  const result = await ipcMain.invoke('isbn:lookup', '9780000000002');
  assert.equal(result.ok, true);
  assert.equal(result.data.title, 'Само в Open Library');
  assert.equal(result.data.sources, 'Open Library');
});

test('sru:lookup uses the configured endpoint and falls back to the LOC default when empty', async () => {
  let requestedUrl = '';
  const { ipcMain } = setup(async (url) => { requestedUrl = url; return textResponse('<numberOfRecords>0</numberOfRecords>'); }, '');
  await ipcMain.invoke('sru:lookup', '9780000000002');
  /* v2.4.14, след повторния одит: стойността по подразбиране ОСТАВА http.
     Порт 210 е регистрираният порт за Z39.50 и шлюзът на Библиотеката на
     Конгреса там говори обикновен HTTP — мълчаливата смяна на https щеше да
     счупи търсенето по ISBN на всяка инсталация, а съобщението за грешка казва
     само „няма връзка със сървъра“. Защитата е в ПРОВЕРКАТА на адреса
     (виж теста по-долу), не в схемата по подразбиране. */
  assert.ok(requestedUrl.startsWith('http://lx2.loc.gov:210/lcdb'), requestedUrl);
});

test('sru:lookup uses a custom configured endpoint when set', async () => {
  let requestedUrl = '';
  const { ipcMain } = setup(async (url) => { requestedUrl = url; return textResponse('<numberOfRecords>0</numberOfRecords>'); }, 'http://custom.example/sru');
  await ipcMain.invoke('sru:lookup', '9780000000002');
  assert.ok(requestedUrl.startsWith('http://custom.example/sru'));
});

test('sru:lookup reports "no record" when numberOfRecords is 0', async () => {
  const { ipcMain } = setup(async () => textResponse('<numberOfRecords>0</numberOfRecords>'));
  const result = await ipcMain.invoke('sru:lookup', '9780000000002');
  assert.equal(result.ok, false);
  assert.match(result.error, /Няма намерен MARC запис/);
});

test('sru:lookup parses a real MARCXML record correctly (title/author/publisher/year/isbn)', async () => {
  const marcXml = `<numberOfRecords>1</numberOfRecords><record>
    <leader>00000cam a2200000 a 4500</leader>
    <datafield tag="020"><subfield code="a">9789540000000 (мека подвързия)</subfield></datafield>
    <datafield tag="100"><subfield code="a">Иванов, Петър.</subfield></datafield>
    <datafield tag="245"><subfield code="a">Заглавие на книгата</subfield><subfield code="b">подзаглавие /</subfield></datafield>
    <datafield tag="264"><subfield code="a">София :</subfield><subfield code="b">Издателство,</subfield><subfield code="c">2020.</subfield></datafield>
    <datafield tag="300"><subfield code="a">250 с. ;</subfield></datafield>
    <datafield tag="041"><subfield code="a">bul</subfield></datafield>
  </record>`;
  const { ipcMain } = setup(async () => textResponse(marcXml));
  const result = await ipcMain.invoke('sru:lookup', '9780000000002');
  assert.equal(result.ok, true);
  assert.equal(result.data.title, 'Заглавие на книгата');
  assert.equal(result.data.subtitle, 'подзаглавие');
  assert.equal(result.data.author, 'Иванов, Петър');
  assert.equal(result.data.publisher, 'Издателство');
  assert.equal(result.data.city, 'София');
  assert.equal(result.data.year, '2020');
  assert.equal(result.data.pages, '250');
  assert.equal(result.data.language, 'български');
  assert.equal(result.data.isbn, '9789540000000');
  assert.equal(result.data.source, 'SRU (MARC)');
});

test('sru:lookup reports a connection error when the SRU server throws', async () => {
  const { ipcMain } = setup(async () => { throw new Error('timeout'); });
  const result = await ipcMain.invoke('sru:lookup', '9780000000002');
  assert.equal(result.ok, false);
  assert.match(result.error, /Няма връзка със SRU сървъра/);
});

test('sru:lookup rejects an invalid ISBN before making any network request', async () => {
  let called = false;
  const { ipcMain } = setup(async () => { called = true; return textResponse(''); });
  const result = await ipcMain.invoke('sru:lookup', 'not-an-isbn');
  assert.equal(result.ok, false);
  assert.equal(called, false);
});
