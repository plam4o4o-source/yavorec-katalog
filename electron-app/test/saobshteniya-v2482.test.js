'use strict';
/* v2.4.82 — „Съобщения до читателя“ в картона на читателя (src/views/readers.js).
   Целият renderer в jsdom (test/helpers/audit-fixtures.js → buildDom), с api,
   който отговаря по канали. Каналите и SQL-ът са проверени отделно
   (test/handlers-online-access.test.js); тук — какво вижда библиотекарят:
     • без активиран онлайн достъп разделът го няма изобщо и не се пита нищо;
     • читател без онлайн достъп (съгласие + ПИН) — обяснение вместо формата;
     • с достъп — заглавие, текст, „Изпрати“ и бележката за доставката;
     • списъкът: „Изпратено“ / „Прочетено на <дата>“ / „Оттеглено“ и „Оттегли“
       само за неоттеглените. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDom, settle } = require('./helpers/audit-fixtures');

const READER = { id: 7, name: 'Иван Иванов', card_no: 'R-0042', category: 'възрастен', status: 'активен',
  registered_at: '2026-01-10', gdpr_consent: 1, online_consent: 1, online_consent_date: '2026-01-10',
  online_pin_hash: 'scrypt$16384$8$1$AAAA$BBBB', online_pin_set_at: '2026-01-10' };
const ACTIVE = { activated: true, lib: 'yavorec', name: 'Библиотека', exp: '2099-12-31', bridgeUrl: 'https://x.org',
  hasUploadKey: true, lastSync: null, lastError: null, consentingReaders: 1, pending: false };
const MESSAGES = [
  { id: 3, reader_id: 7, title: 'Запазена книга', body: 'Книгата пристигна,\nвземете я до петък.', created_at: '2026-10-09T09:15:00.000Z', read_at: null, withdrawn_at: null },
  { id: 2, reader_id: 7, title: null, body: 'Прочетено <b>вече</b>.', created_at: '2026-10-05T09:15:00.000Z', read_at: '2026-10-06T08:00:00.000Z', withdrawn_at: null },
  { id: 1, reader_id: 7, title: 'Старо', body: 'Оттеглено.', created_at: '2026-10-01T09:15:00.000Z', read_at: null, withdrawn_at: '2026-10-02T09:00:00.000Z' }
];
/* Аргументите идват от прозореца на jsdom (друг Object.prototype) — сравняват се като данни. */
const plain = (v) => JSON.parse(JSON.stringify(v));
function open(overrides) {
  const dom = buildDom(Object.assign({
    'readers.get': READER, 'pdp.status': { configured: false }, 'online.status': ACTIVE, 'online.messages': MESSAGES
  }, overrides));
  return dom;
}

test('без активиран онлайн достъп разделът „Съобщения до читателя“ го няма и списъкът не се иска', async () => {
  const dom = open({ 'online.status': { activated: false } });
  const { window } = dom; await settle();
  await window.readerForm(7); await settle();
  assert.equal(window.document.getElementById('onlineMsgFs'), null);
  assert.equal(dom.calls['online.messages'], undefined);
  const modal = /** @type {any} */ (window.document.getElementById('readerF')).closest('.modal');
  assert.ok(modal, 'картонът е отворен');
  assert.doesNotMatch(modal.textContent, /Съобщения до читателя/);
});

test('читател с онлайн достъп: формата, бележката за доставката и списъкът със състоянията', async () => {
  const dom = open();
  const { window } = dom; await settle();
  await window.readerForm(7); await settle();
  const fs = window.document.getElementById('onlineMsgFs');
  assert.ok(fs, 'разделът е в картона');
  assert.equal(fs.querySelector('legend').textContent, 'Съобщения до читателя');
  assert.deepEqual(plain(dom.calls['online.messages']), [{ readerId: 7 }]);
  assert.ok(fs.querySelector('#onlineMsgText'), 'поле за текста');
  assert.equal(fs.querySelector('#onlineMsgText').getAttribute('maxlength'), '2000');
  assert.equal(fs.querySelector('#onlineMsgTitle').getAttribute('maxlength'), '120');
  const text = fs.textContent.replace(/\s+/g, ' ');
  assert.match(text, /до около минута, докато InvLib е отворен и има интернет/);
  assert.match(text, /само от този читател/);
  const buttons = [...fs.querySelectorAll('button')].map(b => b.textContent.trim());
  assert.deepEqual(buttons, ['Изпрати', 'Оттегли', 'Оттегли'], '„Оттегли“ само за неоттеглените');
  const rows = [...fs.querySelectorAll('tbody tr')].map(tr => tr.children[2].textContent.trim());
  assert.equal(rows[0], 'Изпратено');
  assert.match(rows[1], /^Прочетено на \d{2}\.\d{2}\.2026/);
  assert.equal(rows[2], 'Оттеглено');
  assert.ok(fs.innerHTML.includes('Прочетено &lt;b&gt;вече&lt;/b&gt;.'), 'текстът се показва като текст, не като HTML');
  assert.match(text, /Запазена книга/);
  // Блокът е извън формата на картона — не влиза в „Запиши“.
  assert.equal(fs.closest('#readerF'), null);
});

test('читател без онлайн достъп: кратко обяснение вместо формата; изпратените по-рано остават в списъка', async () => {
  const dom = open({ 'readers.get': Object.assign({}, READER, { online_pin_hash: null, online_pin_set_at: null }),
    'online.messages': MESSAGES.slice(0, 1) });
  const { window } = dom; await settle();
  await window.readerForm(7); await settle();
  const fs = window.document.getElementById('onlineMsgFs');
  assert.ok(fs);
  assert.equal(fs.querySelector('#onlineMsgText'), null, 'без форма');
  assert.match(fs.textContent, /още няма онлайн достъп/);
  assert.deepEqual([...fs.querySelectorAll('button')].map(b => b.textContent.trim()), ['Оттегли']);
});

test('„Изпрати“ праща заглавието и текста; празен текст не вика канала; „Оттегли“ пита и праща номера', async () => {
  const sent = { id: 4, reader_id: 7, title: 'Здравейте', body: 'Текст', created_at: '2026-10-10T09:00:00.000Z', read_at: null, withdrawn_at: null };
  const dom = open({ 'online.sendMessage': sent, 'online.withdrawMessage': { id: 3, withdrawn_at: '2026-10-10T09:05:00.000Z' } });
  const { window } = dom; await settle();
  const toasts = [];
  await window.readerForm(7); await settle();
  window.toast = (m, k) => toasts.push([m, k]);
  const d = window.document;
  window.onlineSendMessage(7); await settle();
  assert.equal(dom.calls['online.sendMessage'], undefined, 'празен текст — без повикване');
  assert.match(toasts.pop()[0], /Напишете текста/);
  /** @type {any} */ (d.getElementById('onlineMsgTitle')).value = '  Здравейте ';
  /** @type {any} */ (d.getElementById('onlineMsgText')).value = ' Текст ';
  d.querySelector('#onlineMsgFs button').click(); await settle();
  assert.deepEqual(plain(dom.calls['online.sendMessage']), [{ readerId: 7, title: 'Здравейте', text: 'Текст' }]);
  assert.equal(toasts.pop()[1], 'ok');
  assert.equal(dom.calls['online.messages'].length, 2, 'списъкът се презарежда');
  let asked = '';
  window.confirm = (m) => { asked = m; return false; };
  window.onlineWithdrawMessage(7, 3); await settle();
  assert.match(asked, /Да се оттегли ли съобщението/);
  assert.equal(dom.calls['online.withdrawMessage'], undefined, 'отказ от въпроса — нищо');
  window.confirm = () => true;
  window.onlineWithdrawMessage(7, 3); await settle();
  assert.deepEqual(plain(dom.calls['online.withdrawMessage']), [{ id: 3 }]);
});
