'use strict';
/* СЦЕНАРИЙ (кръг 37, v2.4.61): КРАЕЗНАНИЕ — ЛЕТОПИС, АНАЛИТИЧНО ОПИСАНИЕ,
 * ПЕРСОНАЛИИ, ВРЪЗКИ, СНИМКИ — както го минава краеведът/библиотекарката,
 * през истинския екран (jsdom) и истинските обработчици върху прясна база.
 *
 * Обхват: chronicle (година от дата, запис без дата, разминаване година/дата,
 * невалидна дата, „формулни“ знаци в текста, редакция/изтриване с връзки),
 * analytics (източник периодика / книга от фонда / свободен текст, механизмът
 * „Книга от фонда“ ↔ links:search, отчислена книга-източник и анулиран акт,
 * изтрито периодично издание, проверки на година/брой/страници, is_local и
 * „само краеведски“, ключови думи), persons (картон, дати, връзки), links
 * (всички двойки видове, отказ към отчислен документ, сираци, обратни връзки),
 * localPhoto (файл, липсващ файл, грешен тип, голям файл), разпечатки
 * (указател на статиите, летопис за година, персоналии), пълен износ CSV,
 * търсене на кирилица/латиница/кавички/апострофи и LIKE-знаците % и _.
 *
 * Правило на файла: твърдение, което пада, НЕ спира сценария — записва се в
 * `findings` (виж soft()) с маркер „НАХОДКА n“ и се твърди в самия край.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const E = require('./helpers/e2e-app');

let h;
const T = E.today();
const Y = T.slice(0, 4);
const ids = {};
const findings = [];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-kraeznanie-'));

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* няма значение */ } });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const all = (sql, ...a) => h.db.prepare(sql).all(...a);
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const lastAudit = (action) => q('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC', action);
const linkCount = () => q('SELECT COUNT(*) AS n FROM links').n;
/* Меко твърдение: провалът се записва като находка и сценарият продължава. */
async function soft(label, fn) {
  try { await fn(); }
  catch (e) { findings.push({ label, msg: (e && e.message) || String(e) }); }
}
function noRendererErrors() {
  const errs = h.errors.splice(0);
  assert.equal(errs.length, 0, 'грешки в екранния слой:\n'
    + errs.map(e => (e && (e.stack || e.message)) || String(e)).join('\n---\n'));
}
async function saveModal(label) {
  const n = h.toasts.length;
  await h.clickButton(label || 'Запиши', '#modal footer');
  return h.toastsSince(n);
}
const ACT = (o) => Object.assign({
  no: 1, date: T, reason_code: 3, reason_text: 'физически изхабени',
  disposal: 'предадени за вторични суровини', committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
}, o);
/* Разчита ZIP-а от пълния износ (същият минимален четец като в ekran-v2456). */
function readZip(buf) {
  const out = new Map();
  let off = 0;
  while (off + 4 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body));
    off = start + compSize;
  }
  return out;
}

/* ==================================================================
   0. Настройки, фонд-опора: две книги и едно периодично издание
   ================================================================== */
test('0. подготовка: настройки, две книги във фонда, едно периодично издание', async () => {
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека „Изпитание“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова',
    committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
  })), 'запис на настройките');
  await h.window.loadSettingsCache();
  ids.b1 = ok(await h.api.books.create({ title: 'Яворец през вековете', author: 'Петров, Георги', year: '1985', inv_number: 1, register_date: T, price: 5, udk: '908(497.2)' }), 'книга 1');
  ids.b2 = ok(await h.api.books.create({ title: 'Под игото', author: 'Вазов, Иван', year: '1894', inv_number: 2, register_date: T, price: 10 }), 'книга 2');
  ids.b3 = ok(await h.api.books.create({ title: "O'Neil и 100% истина_за_селото", author: 'Smith, John', year: '2001', inv_number: 3, register_date: T, price: 1 }), 'книга 3 (латиница, апостроф, %, _)');
  ids.per = ok(await h.api.periodicals.create({ title: 'Родна реч', freq: 'месечно', publisher: '', issn: '' }), 'периодично издание');
  ids.per2 = ok(await h.api.periodicals.create({ title: 'Габровски вести', freq: 'седмично', publisher: '', issn: '' }), 'периодично издание 2');
  noRendererErrors();
});

/* ==================================================================
   1. Летопис — формата „+ Нов запис“
   ================================================================== */
test('1. Летопис: празен раздел, подразбирания на формата, първи запис през екрана', async () => {
  await h.go('chronicle');
  assert.match(h.viewText(), /Летописът е празен/);
  await h.clickButton('+ Нов запис', '#view');
  await h.waitFor(() => h.$('#chrF'), 'формата за летопис');
  assert.equal(h.$('#chrF [name=year]').value, Y, 'годината се предлага = текущата');
  assert.equal(h.$('#chrF [name=category]').value, 'читалище');
  assert.equal(h.$('#chrF [name=year]').hasAttribute('required'), true);
  const cats = Array.from(h.$('#chrF [name=category]').options).map(o => o.value);
  assert.deepEqual(cats, ['читалище', 'библиотека', 'самодейност', 'дарение', 'строителство', 'юбилей', 'друго']);

  // Празно заглавие → отказ на самата форма.
  let ts = await saveModal();
  assert.ok(ts.some(t => t.type === 'err' && /Заглавието на събитието е задължително/.test(t.msg)), JSON.stringify(ts));
  assert.equal(h.modalOpen(), true);

  // Основаването на читалището: 24.05.1922 — годината се оставя както е предложена (2026).
  h.type('#chrF [name=title]', 'Основаване на читалището');
  h.type('#chrF [name=date]', '1922-05-24');
  h.type('#chrF [name=body]', 'На събрание в училището 32 души основават читалище „Изпитание“.\nПръв председател — учителят Петров.');
  h.type('#chrF [name=participants]', 'Георги Петров, Иван Стоянов');
  h.type('#chrF [name=sources]', 'Протокол № 1/1922, спомени на Ст. Иванов');
  ts = await saveModal();
  assert.ok(ts.some(t => t.msg === 'Записът е добавен.' && t.type === 'ok'), JSON.stringify(ts));
  const c = q("SELECT * FROM chronicle WHERE title = 'Основаване на читалището'");
  assert.ok(c, 'записът е в базата');
  ids.c1 = c.id;
  assert.equal(c.date, '1922-05-24');
  await soft('НАХОДКА 1: годината в записа не следва въведената точна дата — формата пази предложената текуща година', async () => {
    assert.equal(c.year, '1922', 'записът с дата 24.05.1922 попада в година ' + c.year + ', а не в 1922');
  });
  // След „Запиши“ се отваря картонът на новия запис.
  await h.settle();
  assert.equal(h.modalOpen(), true, 'картонът на новия запис се отваря');
  assert.match(h.modal(), /Основаване на читалището/);
  assert.match(h.modal(), /24\.05\.1922/);
  assert.match(h.modal(), /Участници: Георги Петров, Иван Стоянов/);
  assert.match(h.modal(), /Източници: Протокол № 1\/1922/);
  assert.match(h.modal(), /Няма свързани материали/);
  assert.match(lastAudit('Летопис').detail, /нов запис: .*Основаване на читалището/);
  h.window.closeModal();
  await h.settle();
  // Поправка на годината на ръка — редакцията сработва.
  ok(await h.api.chronicle.update(Object.assign({}, c, { year: '1922' })), 'поправка на годината');
  assert.equal(q('SELECT year FROM chronicle WHERE id = ?', ids.c1).year, '1922');
  noRendererErrors();
});

test('2. Летопис през API: година от датата, без дата и без година, невалидна дата, свободен текст за година', async () => {
  // (а) Само дата → годината се извежда от нея.
  ids.c2 = ok(await h.api.chronicle.create({ title: 'Откриване на библиотеката', date: '1925-11-01', category: 'библиотека', body: 'Първите 120 тома — дарение от учителството.' }), 'без година');
  assert.equal(q('SELECT year FROM chronicle WHERE id = ?', ids.c2).year, '1925');
  // (б) Нито година, нито дата → отказ (year NOT NULL). Съобщението трябва да е човешко.
  const r = await h.api.chronicle.create({ title: 'Без нищо' });
  assert.equal(r.ok, false, 'запис без година и без дата не се приема');
  assert.match(r.error, /Задължително поле липсва|Годината/);
  // (в) Невалидна дата „24.05.1926“ (български формат вместо ISO): нищо не я спира.
  const r2 = await h.api.chronicle.create({ title: 'Невалидна дата', date: '24.05.1926' });
  await soft('НАХОДКА 2: chronicle:create приема дата „24.05.1926“ и извежда година „24.0“', async () => {
    assert.equal(r2.ok, false, 'приета е дата в неправилен формат; годината стана „' + (r2.ok ? q('SELECT year FROM chronicle WHERE id = ?', r2.data).year : '') + '“');
  });
  if (r2.ok) ok(await h.api.chronicle.delete(r2.data), 'чистене');
  // (г) Дата 30.02 — превъртане/невалидна.
  const r3 = await h.api.chronicle.create({ title: 'Тридесети февруари', date: '1930-02-30' });
  await soft('НАХОДКА 2а: chronicle:create приема несъществуваща дата 1930-02-30', async () => {
    assert.equal(r3.ok, false, 'приета е дата 30.02.1930');
  });
  if (r3.ok) ok(await h.api.chronicle.delete(r3.data), 'чистене');
  // (д) Дата от друга година спрямо изрично подадената година — разминаването минава тихо.
  const r4 = await h.api.chronicle.create({ title: 'Разминаване', year: '1950', date: '1951-03-03' });
  await soft('НАХОДКА 1а: chronicle:create приема година 1950 с дата от 1951 г. без предупреждение', async () => {
    assert.equal(r4.ok, false, 'година 1950 + дата 03.03.1951 е приета');
  });
  if (r4.ok) ok(await h.api.chronicle.delete(r4.data), 'чистене');
  // (е) Годината е свободен текст („ок. 1900“) — допустимо по замисъл; „abc“ също минава.
  ids.c3 = ok(await h.api.chronicle.create({ title: 'Първа сбирка на самодейците', year: 'ок. 1930', category: 'самодейност' }), 'ок. 1930');
  const rAbc = await h.api.chronicle.create({ title: 'Година abc', year: 'abc' });
  await soft('НАХОДКА 3: годината „abc“ се приема като година на летописен запис', async () => {
    assert.equal(rAbc.ok, false, 'year=abc е прието');
  });
  if (rAbc.ok) ok(await h.api.chronicle.delete(rAbc.data), 'чистене');
  // (ж) Текст с „формулни“ и HTML знаци — трябва да се пази дословно и да се показва екраниран.
  ids.c4 = ok(await h.api.chronicle.create({
    title: '=SUM(A1:A9) <b>юбилей</b>', year: '1972', date: '1972-05-24', category: 'юбилей',
    body: '+50 години; -1 &amp; "кавички" \'апостроф\' <script>alert(1)</script>', participants: '@всички; O\'Neil'
  }), 'формулни знаци');
  const c4 = q('SELECT * FROM chronicle WHERE id = ?', ids.c4);
  assert.equal(c4.title, '=SUM(A1:A9) <b>юбилей</b>', 'заглавието се пази дословно');
  assert.equal(c4.year, '1972');
  // Още записи за същата година и за текущата — за подредба и броячи.
  ids.c5 = ok(await h.api.chronicle.create({ title: 'Ремонт на салона', year: '1972', date: '1972-01-15', category: 'строителство' }), '1972 януари');
  ids.c6 = ok(await h.api.chronicle.create({ title: 'Дарение на 200 тома', year: '1972', category: 'дарение', body: 'Без точна дата.' }), '1972 без дата');
  ids.c7 = ok(await h.api.chronicle.create({ title: 'Нова читалня', year: Y, date: T, category: 'библиотека' }), 'тази година');
  const years = ok(await h.api.chronicle.years(), 'years');
  const y1972 = years.find(y => y.year === '1972');
  assert.equal(y1972.n, 3, 'три записа за 1972 г.');
  await soft('НАХОДКА 24: годините на екрана и във филтъра се подреждат ТЕКСТОВО (ORDER BY year DESC): „ок. 1930“ излиза преди ' + Y + ', „900“ би излязла след „1999“', async () => {
    assert.equal(years[0].year, Y, 'първата година в менюто е „' + years[0].year + '“');
  });
  const list = ok(await h.api.chronicle.list({ year: '1972' }), 'list 1972');
  assert.deepEqual(list.map(x => x.id), [ids.c4, ids.c5, ids.c6], 'в списъка: с дата (низходящо), после без дата');
  noRendererErrors();
});

test('3. Летопис на екрана: списък, екраниране, търсене с кирилица/латиница/кавички и %/_', async () => {
  await h.go('chronicle');
  const vt = h.viewText();
  assert.match(vt, /=SUM\(A1:A9\) <b>юбилей<\/b>/, 'HTML в заглавието се показва като текст');
  assert.equal(h.$('#chrItems script'), null, 'скриптът в описанието не става елемент');
  assert.match(vt, /1972/);
  assert.match(vt, /Показани са 7 от 7 записа в летописа/);
  // Годините се показват веднъж като заглавие.
  assert.equal(h.document.querySelectorAll('#chrItems .chrYearHead').length, 5, 'пет заглавия на години: ' + Y + ', 1972, 1925, 1922, ок. 1930');
  // Филтър по година през менюто.
  h.type('#view select', '1972');
  await h.settle();
  assert.match(h.viewText(), /Показани са 3 от 3 записа/);
  assert.equal(h.$('#view select').value, '1972');
  h.type('#view select', '');
  await h.settle();

  // Търсене — през API, за да не чакаме 300 ms дебаунс на всяко.
  const find = async (qq) => ok(await h.api.chronicle.list({ q: qq }), 'търсене ' + qq);
  assert.equal((await find('библиотеката')).length, 1, 'кирилица, точен регистър');
  await soft('НАХОДКА 4: търсенето в летописа е чувствително към регистъра на кирилицата („основаване“ не намира „Основаване“)', async () => {
    assert.equal((await find('основаване')).length, 1, 'малки букви не намират „Основаване на читалището“');
  });
  assert.equal((await find("O'Neil")).length, 1, 'апострофът в търсенето минава през параметър');
  assert.equal((await find('"кавички"')).length, 1, 'двойните кавички се търсят дословно');
  assert.equal((await find('<script>')).length, 1, 'HTML знаци — дословно');
  await soft('НАХОДКА 5: знакът % в търсенето не се екранира за LIKE — „100%“ намира всички записи', async () => {
    const r = await find('%');
    assert.equal(r.length, 0, '„%“ върна ' + r.length + ' записа вместо 0 (няма запис със знак %)');
  });
  await soft('НАХОДКА 5а: знакът _ в търсенето е LIKE-заместител („Н_ва“ намира „Нова читалня“)', async () => {
    const r = await find('Н_ва');
    assert.equal(r.length, 0, '„Н_ва“ върна ' + r.length + ' записа');
  });
  // Търсене през полето на екрана — дебаунс 300 ms, само #chrList се преначертава.
  h.type('#view input[type=search]', 'Ремонт');
  await h.sleep(350); await h.settle();
  assert.match(h.viewText(), /Показани са 1 от 1 записа/);
  assert.equal(h.$('#view input[type=search]').value, 'Ремонт', 'полето не се пресъздава');
  h.type('#view input[type=search]', '');
  await h.sleep(350); await h.settle();
  // Писане в търсачката и веднага смяна на раздела (преди да минат 300 ms).
  h.type('#view input[type=search]', 'Ремонт');
  await h.go('persons');
  assert.match(h.viewText(), /Персоналии\./);
  await h.sleep(400); await h.settle();
  await soft('НАХОДКА 23: отложеното търсене (300 ms) в летописа презаписва вече отворения друг раздел (refreshChronicle → renderChronicle без проверка на VIEW)', async () => {
    assert.doesNotMatch(h.viewText(), /Летопис\. Хронология/, 'разделът „Персоналии“ е заменен от летописа, VIEW=' + h.view());
  });
  h.window.eval("CHR_Q = ''");
  await h.go('chronicle');
  noRendererErrors();
});

/* ==================================================================
   4. Персоналии
   ================================================================== */
test('4. Персоналии: формата, дати, търсене, картон', async () => {
  await h.go('persons');
  assert.match(h.viewText(), /Няма вписани персоналии/);
  await h.clickButton('+ Нова персоналия', '#view');
  await h.waitFor(() => h.$('#prsF'), 'формата за персоналия');
  let ts = await saveModal();
  assert.ok(ts.some(t => t.type === 'err' && /Името е задължително/.test(t.msg)), JSON.stringify(ts));
  h.type('#prsF [name=name]', 'Петров, Георги Иванов');
  h.type('#prsF [name=alt_names]', 'Даскал Георги');
  h.type('#prsF [name=birth_date]', '1890-03-12');
  h.type('#prsF [name=birth_place]', 'с. Яворец');
  h.type('#prsF [name=death_date]', '1961-07-01');
  h.type('#prsF [name=activity]', 'учител, читалищен деец');
  h.type('#prsF [name=bio]', 'Пръв председател на читалището.\nУчител в селото 40 години.');
  h.type('#prsF [name=sources]', 'Летопис на училището; спомени');
  ts = await saveModal();
  assert.ok(ts.some(t => t.msg === 'Персоналията е добавена.'), JSON.stringify(ts));
  const p = q("SELECT * FROM persons WHERE name = 'Петров, Георги Иванов'");
  assert.ok(p); ids.p1 = p.id;
  await h.settle();
  assert.equal(h.modalOpen(), true, 'картонът се отваря след запис');
  assert.match(h.modal(), /12\.03\.1890 – 01\.07\.1961 · с\. Яворец/);
  assert.match(h.modal(), /Известен още като: Даскал Георги/);
  assert.match(h.modal(), /Няма свързани материали/);
  h.window.closeModal(); await h.settle();
  assert.match(lastAudit('Персоналии').detail, /нова персоналия: Петров, Георги Иванов/);

  // Смърт преди раждане — приема се без дума.
  const bad = await h.api.persons.create({ name: 'Обърнати дати', birth_date: '1950-01-01', death_date: '1940-01-01' });
  await soft('НАХОДКА 6: персоналия с дата на смъртта ПРЕДИ датата на раждане се приема', async () => {
    assert.equal(bad.ok, false, 'приета е смърт 1940 при раждане 1950');
  });
  if (bad.ok) ok(await h.api.persons.delete(bad.data), 'чистене');
  const badDate = await h.api.persons.create({ name: 'Невалидна дата', birth_date: '12.03.1890' });
  await soft('НАХОДКА 6а: persons:create приема дата на раждане „12.03.1890“ (не ISO) — форматът на датите не се проверява никъде в краезнанието', async () => {
    assert.equal(badDate.ok, false);
  });
  if (badDate.ok) ok(await h.api.persons.delete(badDate.data), 'чистене');

  ids.p2 = ok(await h.api.persons.create({ name: "O'Neil, Джон", activity: 'краевед', bio: '100% местен; ул. „Първа“ 5' }), 'втора персоналия');
  ids.p3 = ok(await h.api.persons.create({ name: 'Стоянов, Иван', activity: 'секретар на читалището', birth_date: '1900-01-01' }), 'трета');
  const list = ok(await h.api.persons.list(''), 'списък');
  assert.deepEqual(list.map(x => x.name), ["O'Neil, Джон", 'Петров, Георги Иванов', 'Стоянов, Иван'], 'по азбучен ред (латиницата преди кирилицата)');
  assert.equal((ok(await h.api.persons.list("O'Neil"), 'апостроф')).length, 1);
  await soft('НАХОДКА 4а: търсенето в персоналиите е чувствително към регистъра на кирилицата', async () => {
    assert.equal((ok(await h.api.persons.list('петров'), 'малки букви')).length, 1);
  });
  await soft('НАХОДКА 5б: „%“ в търсенето на персоналии връща всички', async () => {
    assert.equal((ok(await h.api.persons.list('%'), '%')).length, 1, 'само O\'Neil има „%“ в биографията');
  });
  await h.go('persons');
  assert.match(h.viewText(), /Показани са 3 от 3 персоналии/);
  assert.match(h.viewText(), /р\. 01\.01\.1900/);
  assert.match(h.viewText(), /няма свързани материали/);
  noRendererErrors();
});

/* ==================================================================
   5. Аналитично описание — периодика, книга от фонда, свободен текст
   ================================================================== */
test('5. Аналитично описание: формата — статия от периодично издание', async () => {
  await h.go('analytics');
  assert.match(h.viewText(), /Няма описани статии/);
  await h.clickButton('+ Ново описание', '#view');
  await h.waitFor(() => h.$('#anlF'), 'формата');
  assert.equal(h.$('#anlF [name=source_kind]').value, 'периодика');
  assert.equal(h.$('#anlF [name=is_local]').checked, true, 'краеведски по подразбиране');
  assert.equal(h.$('#anlF [name=year]').value, Y);
  const perOpts = Array.from(h.$('#anlF [name=periodical_id]').options).map(o => o.text);
  assert.ok(perOpts.includes('Родна реч') && perOpts.includes('Габровски вести'), perOpts.join('|'));
  let ts = await saveModal();
  assert.ok(ts.some(t => /Заглавие на статията е задължително поле/.test(t.msg)), JSON.stringify(ts));

  h.type('#anlF [name=title]', 'Яворец празнува 100 години читалище');
  h.type('#anlF [name=author]', 'Иванова, Мария');
  h.type('#anlF [name=subtitle]', 'репортаж');
  h.type('#anlF [name=year]', '2022');
  h.type('#anlF [name=pages]', '3 – 4');
  h.type('#anlF [name=udk]', '908(497.2)');
  h.type('#anlF [name=periodical_id]', String(ids.per2));
  h.type('#anlF [name=issue]', '21');
  h.type('#anlF [name=issue_date]', '2022-05-27');
  h.type('#anlF [name=keywords]', 'читалище, юбилей, Яворец');
  h.type('#anlF [name=annotation]', 'Тържество по случай 100 г. от основаването.');
  ts = await saveModal();
  assert.ok(ts.some(t => t.msg === 'Описанието е добавено.'), JSON.stringify(ts));
  const a = q("SELECT * FROM analytics WHERE title = 'Яворец празнува 100 години читалище'");
  assert.ok(a); ids.a1 = a.id;
  assert.equal(a.periodical_id, ids.per2);
  assert.equal(a.book_id, null);
  assert.equal(a.is_local, 1);
  assert.equal(a.udk, '908(497.2)');
  await h.settle();
  assert.match(h.viewText(), /Яворец празнува 100 години читалище : репортаж/);
  assert.match(h.viewText(), /Габровски вести, бр\. 21 от 27\.05\.2022/, 'източникът се сглобява от изданието');
  assert.match(h.viewText(), /1 Описани статии/);
  assert.match(h.viewText(), /1 Краеведски/);
  assert.match(lastAudit('Аналитично описание').detail, /нова статия: Яворец празнува/);
  noRendererErrors();
});

test('6. Аналитично описание: „Книга от фонда“ — етикетът от links:search става book_id; редакцията не къса връзката', async () => {
  await h.go('analytics');
  await h.clickButton('+ Ново описание', '#view');
  await h.waitFor(() => h.$('#anlF'), 'формата');
  h.type('#anlF [name=title]', 'Читалищното дело в Яворец между двете войни');
  h.type('#anlF [name=author]', 'Петров, Георги');
  h.type('#anlF [name=source_kind]', 'книга');
  h.type('#anlF [name=year]', '1985');
  h.type('#anlF [name=pages]', '45 – 61');
  h.type('#anlF [name=is_local]', true);
  // Пише се „инв. № 1“ → търсенето праща инвентарния номер → datalist с етикета.
  h.type('#anlF [name=book_pick]', 'инв. № 1');
  await h.settle();
  const opts = Array.from(h.document.querySelectorAll('#dl_anlBooks option')).map(o => o.value);
  assert.ok(opts.includes('инв. № 1 · Петров, Георги. Яворец през вековете'), 'списъкът предлага точния етикет: ' + JSON.stringify(opts));
  await soft('НАХОДКА 25: търсенето по „инв. № 1“ връща и книги, чието заглавие съдържа „1“ (LIKE %1% по заглавие/автор наред с точния инв. №)', async () => {
    assert.equal(opts.length, 1, JSON.stringify(opts));
  });
  assert.equal(h.$('#anlF [name=book_id]').value, '', 'докато не е избран точният етикет, book_id е празен');
  // Избор от списъка (браузърът слага целия етикет в полето).
  h.type('#anlF [name=book_pick]', 'инв. № 1 · Петров, Георги. Яворец през вековете');
  await h.settle();
  assert.equal(h.$('#anlF [name=book_id]').value, String(ids.b1), 'book_id се попълва от етикета');
  // Търсене по заглавие с различен регистър — „яворец“ вместо „Яворец“.
  h.type('#anlF [name=book_pick]', 'яворец');
  await h.settle();
  await soft('НАХОДКА 4б: links:search за книга е чувствително към регистъра на кирилицата („яворец“ не намира „Яворец през вековете“)', async () => {
    const o2 = Array.from(h.document.querySelectorAll('#dl_anlBooks option')).map(o => o.value);
    assert.equal(o2.length, 1, 'datalist: ' + JSON.stringify(o2));
  });
  h.type('#anlF [name=book_pick]', 'ИНВ. №  1 · петров, георги. яворец през вековете');
  await h.settle();
  assert.equal(h.$('#anlF [name=book_id]').value, String(ids.b1), 'сравнението е нечувствително към регистър и интервали');
  let ts = await saveModal();
  assert.ok(ts.some(t => t.msg === 'Описанието е добавено.'), JSON.stringify(ts));
  const a = q("SELECT * FROM analytics WHERE title LIKE 'Читалищното дело%'");
  ids.a2 = a.id;
  assert.equal(a.book_id, ids.b1);
  assert.equal(a.source_kind, 'книга');
  await h.settle();
  assert.match(h.viewText(), /Петров, Георги\. Яворец през вековете \(инв\. № 1\)/, 'източникът е книгата от фонда');

  // Редакция: полето „Книга от фонда“ е попълнено с етикета; „докосване“ не къса book_id.
  await h.window.analyticForm(ids.a2);
  await h.waitFor(() => h.$('#anlF'), 'формата за редакция');
  await h.settle();
  assert.equal(h.$('#anlF [name=book_pick]').value, 'инв. № 1 · Петров, Георги. Яворец през вековете');
  assert.equal(h.$('#anlF [name=book_id]').value, String(ids.b1));
  h.type('#anlF [name=book_pick]', h.$('#anlF [name=book_pick]').value + ' ');
  await h.settle();
  assert.equal(h.$('#anlF [name=book_id]').value, String(ids.b1), 'излишен интервал не изпразва book_id');
  h.type('#anlF [name=annotation]', 'Глава за периода 1919 – 1939 г.');
  ts = await saveModal();
  assert.ok(ts.some(t => t.msg === 'Описанието е обновено.'), JSON.stringify(ts));
  assert.equal(q('SELECT book_id FROM analytics WHERE id = ?', ids.a2).book_id, ids.b1, 'връзката към книгата оцелява редакцията');
  assert.equal(q('SELECT annotation FROM analytics WHERE id = ?', ids.a2).annotation, 'Глава за периода 1919 – 1939 г.');

  // Изтриване на текста от полето → book_id се изпразва, а source_kind остава „книга“ — описание без източник.
  await h.window.analyticForm(ids.a2);
  await h.waitFor(() => h.$('#anlF'), 'формата');
  await h.settle();
  h.type('#anlF [name=book_pick]', '');
  await h.settle();
  assert.equal(h.$('#anlF [name=book_id]').value, '');
  ts = await saveModal();
  await soft('НАХОДКА 7: описание с вид „книга“, но без избрана книга и без свободен текст, се записва и показва източник „—“', async () => {
    assert.ok(ts.some(t => t.type === 'err'), 'записът мина без отказ: ' + JSON.stringify(ts));
  });
  if (h.modalOpen()) h.window.closeModal();
  // Връщаме книгата през API (както ще я върне и краеведът).
  const cur = ok(await h.api.analytics.get(ids.a2), 'get');
  ok(await h.api.analytics.update(Object.assign({}, cur, { book_id: ids.b1 })), 'връщане на книгата');
  noRendererErrors();
});

test('7. Аналитично описание: свободен текст, проверки на година/брой/страници/дата, is_local и „само краеведски“, ключови думи', async () => {
  ids.a3 = ok(await h.api.analytics.create({
    title: 'Кооперацията в Яворец', author: 'Стоянов, Иван', source_kind: 'друго',
    source_text: '100 вести, бр. 145 от 12.07.2019', year: '2019', pages: '7', is_local: 0, keywords: 'кооперация'
  }), 'свободен текст');
  const r = ok(await h.api.analytics.list({}), 'list');
  const a3 = r.find(x => x.id === ids.a3);
  assert.equal(a3.is_local, 0);
  assert.equal(a3.periodical_title, null);
  // Година „abc“, страници „-5“, брой от 3000 г., дата на броя в неправилен формат — всичко минава.
  const bad = await h.api.analytics.create({ title: 'Лоши числа', source_kind: 'периодика', periodical_id: ids.per, year: 'abc', pages: '-5', issue: '', issue_date: '27.05.2022' });
  await soft('НАХОДКА 8: analytics:create приема година „abc“, страници „-5“ и дата на броя „27.05.2022“', async () => {
    assert.equal(bad.ok, false, 'приети са year=abc, pages=-5, issue_date=27.05.2022');
  });
  if (bad.ok) {
    const yrs = ok(await h.api.analytics.years(), 'years');
    assert.ok(yrs.some(y => y.year === 'abc'), 'годината „abc“ се появява във филтъра по години');
    ok(await h.api.analytics.delete(bad.data), 'чистене');
  }
  // Описание от периодика без избрано издание — източник „—“.
  const noPer = await h.api.analytics.create({ title: 'Без издание', source_kind: 'периодика', periodical_id: '', year: '2020' });
  await soft('НАХОДКА 7а: вид „периодика“ без избрано издание и без свободен текст се записва (източник „—“ в указателя)', async () => {
    assert.equal(noPer.ok, false);
  });
  if (noPer.ok) ok(await h.api.analytics.delete(noPer.data), 'чистене');
  // Филтри.
  assert.equal(ok(await h.api.analytics.list({ onlyLocal: true }), 'local').length, 2);
  assert.equal(ok(await h.api.analytics.list({ year: '2019' }), '2019').length, 1);
  assert.equal(ok(await h.api.analytics.list({ q: 'кооперация' }), 'ключова дума').length, 1);
  assert.equal(ok(await h.api.analytics.list({ q: '100 вести' }), 'свободен източник').length, 1);
  assert.equal(ok(await h.api.analytics.list({ q: 'Габровски' }), 'по заглавие на изданието').length, 1);
  assert.equal(ok(await h.api.analytics.list({ q: 'вековете' }), 'по заглавие на книгата-източник').length, 1);
  await soft('НАХОДКА 4в: търсенето в аналитичните описания е чувствително към регистъра на кирилицата', async () => {
    /* ПОПРАВЕНО ЧИСЛО (v2.4.61): очакваните описания са ТРИ, не две — „Яворец“
       стои в заглавията и на трите („Яворец празнува 100 години читалище“,
       „Читалищното дело в Яворец между двете войни“, „Кооперацията в Яворец“).
       Двойката тук беше пропусната сметка на самия сценарий: докато търсенето
       беше чувствително към регистъра, малките букви връщаха 0 и разликата
       между 2 и 3 не личеше. */
    assert.equal(ok(await h.api.analytics.list({ q: 'яворец' }), 'малки').length, 3);
  });
  await soft('НАХОДКА 5в: „%“ в търсенето на статии връща всички', async () => {
    assert.equal(ok(await h.api.analytics.list({ q: '%' }), '%').length, 0);
  });
  // Екранът: отметката „само краеведски“ и броячите.
  await h.go('analytics');
  assert.match(h.viewText(), /3 Описани статии/);
  assert.match(h.viewText(), /2 Краеведски/);
  h.type('#view input[type=checkbox]', true);
  await h.settle();
  assert.match(h.viewText(), /2 Описани статии/);
  assert.doesNotMatch(h.viewText(), /Кооперацията/);
  h.type('#view input[type=checkbox]', false);
  await h.settle();
  assert.match(h.viewText(), /100 вести, бр\. 145 от 12\.07\.2019/);
  // Търсене през полето — дебаунс; полето остава.
  h.type('#anlQ', 'Кооперац');
  await h.sleep(350); await h.settle();
  assert.match(h.viewText(), /1 Описани статии/);
  assert.equal(h.$('#anlQ').value, 'Кооперац');
  h.type('#anlQ', '');
  await h.sleep(350); await h.settle();
  noRendererErrors();
});

/* ==================================================================
   8. Връзки — всички двойки, отказ към отчислен документ, обратни връзки
   ================================================================== */
test('8. Връзки през картона на персоналията (екран) и през API за всички двойки видове', async () => {
  await h.go('persons');
  await h.window.personView(ids.p1);
  await h.waitFor(() => h.$('#lnkKind'), 'панелът „Свързани материали“');
  await h.settle();
  // „Свържи“ без избор → отказ.
  let n = h.toasts.length;
  await h.clickButton('Свържи', '#modal');
  assert.ok(h.toastsSince(n).some(t => /Изберете запис от списъка/.test(t.msg)));
  // Търсене на документ от фонда по инв. №, както подсказва полето („заглавие, автор, инв. №…“).
  h.type('#lnkKind', 'книга');
  h.type('#lnkQ', '1');
  await h.settle();
  /* ПРОМЕНЕНО ПОВЕДЕНИЕ (v2.4.61, НАХОДКА 26/F11): прагът „поне 2 знака“ важи
     вече само за ТЕКСТ. Едноцифреният инвентарен номер е истинско питане — в
     новооткрита библиотека първите номера са едноцифрени — и дотук той беше
     единственото, което полето „заглавие, автор, инв. №…“ не можеше да търси.
     Затова тук се очаква намерената книга, а не подсказката за два знака. */
  assert.equal(h.$('#lnkPick').options[0].text, 'инв. № 1 · Петров, Георги. Яворец през вековете',
    'едноцифрен инвентарен номер вече се търси');
  h.type('#lnkQ', 'я');
  await h.settle();
  assert.equal(h.$('#lnkPick').options[0].text, '— въведете поне 2 знака —', 'един ТЕКСТОВ знак не търси');
  h.type('#lnkQ', 'инв. № 2');
  await h.settle();
  await soft('НАХОДКА 26: в панела „Свързани материали“ търсене „инв. № 2“ (както подсказва полето) не намира нищо — само формата на статията маха представката', async () => {
    assert.equal(h.$('#lnkPick').options[0].text, 'инв. № 2 · Вазов, Иван. Под игото', 'намерени: ' + h.$('#lnkPick').options[0].text);
  });
  h.type('#lnkQ', 'Яворец');
  await h.settle();
  const found = Array.from(h.$('#lnkPick').options).map(o => o.text);
  assert.ok(found.includes('инв. № 1 · Петров, Георги. Яворец през вековете'), found.join('|'));
  h.$('#lnkPick').value = String(ids.b1);
  n = h.toasts.length;
  await h.clickButton('Свържи', '#modal');
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Връзката е добавена.'), JSON.stringify(h.toastsSince(n)));
  assert.match(h.text('#linkList'), /книга инв\. № 1 · Петров, Георги\. Яворец през вековете/);
  // Втори път същата → отказ.
  n = h.toasts.length;
  await h.clickButton('Свържи', '#modal');
  assert.ok(h.toastsSince(n).some(t => /Тази връзка вече съществува/.test(t.msg)));
  // Статия.
  h.type('#lnkKind', 'статия');
  h.type('#lnkQ', 'Читалищното');
  await h.settle();
  assert.equal(h.$('#lnkPick').options[0].text, 'Петров, Георги. Читалищното дело в Яворец между двете войни (1985)');
  h.$('#lnkPick').value = String(ids.a2);
  await h.clickButton('Свържи', '#modal');
  // Запис в летописа.
  h.type('#lnkKind', 'летопис');
  h.type('#lnkQ', 'Основаване');
  await h.settle();
  assert.equal(h.$('#lnkPick').options[0].text, '1922 — Основаване на читалището');
  h.$('#lnkPick').value = String(ids.c1);
  await h.clickButton('Свържи', '#modal');
  // Периодично издание.
  h.type('#lnkKind', 'периодика');
  h.type('#lnkQ', 'Родна');
  await h.settle();
  h.$('#lnkPick').value = String(ids.per);
  await h.clickButton('Свържи', '#modal');
  // Друга персоналия.
  h.type('#lnkKind', 'персона');
  h.type('#lnkQ', 'Стоянов');
  await h.settle();
  h.$('#lnkPick').value = String(ids.p3);
  await h.clickButton('Свържи', '#modal');
  const lt = h.text('#linkList');
  assert.match(lt, /книга .*летопис .*периодика .*персона .*статия/, 'списъкът е подреден по вид: ' + lt);
  assert.match(lt, /персона Стоянов, Иван/);
  assert.match(lt, /периодика Родна реч/);
  // „Махни“ на реда „периодика“ — без потвърждение, връзката пада веднага.
  const rowPer = Array.from(h.document.querySelectorAll('#linkList tr')).find(tr => /периодика/.test(tr.textContent));
  const nConf = h.hooks.confirms.length;
  n = h.toasts.length;
  await h.click(rowPer.querySelector('button'));
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Връзката е премахната.'), JSON.stringify(h.toastsSince(n)));
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE from_kind='персона' AND from_id=? AND to_kind='периодика'", ids.p1).n, 0);
  assert.doesNotMatch(h.text('#linkList'), /Родна реч/, 'списъкът се опреснява');
  await soft('НАХОДКА 29: „Махни“ на връзка се изпълнява без потвърждение и без одитна следа (един клик по грешния ред)', async () => {
    assert.ok(h.hooks.confirms.length > nConf, 'няма потвърждение');
  });
  ok(await h.api.links.add({ fromKind: 'персона', fromId: ids.p1, toKind: 'периодика', toId: ids.per }), 'връщане на връзката');
  // Самата персоналия не може да сочи към себе си.
  const self = await h.api.links.add({ fromKind: 'персона', fromId: ids.p1, toKind: 'персона', toId: ids.p1 });
  assert.equal(self.ok, false); assert.match(self.error, /не може да сочи към себе си/);
  // „Затвори“ опреснява брояча в списъка.
  await h.clickButton('Затвори', '#modal footer');
  await h.settle();
  assert.match(h.viewText(), /Петров, Георги Иванов .*5 свързани материала/);
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE from_kind='персона' AND from_id=?", ids.p1).n, 5);
  await soft('НАХОДКА 9: добавянето на връзка не оставя следа в одитния дневник', async () => {
    const au = all("SELECT * FROM audit_log WHERE action LIKE '%връзк%' OR detail LIKE '%връзк%'");
    assert.ok(au.length > 0, 'няма нито един ред в audit_log за 5 нови връзки');
  });

  // Летопис → всички видове (API).
  for (const [toKind, toId] of [['книга', ids.b2], ['статия', ids.a1], ['персона', ids.p1], ['периодика', ids.per2], ['летопис', ids.c2]]) {
    ok(await h.api.links.add({ fromKind: 'летопис', fromId: ids.c1, toKind, toId, note: 'към ' + toKind }), 'летопис → ' + toKind);
  }
  const selfC = await h.api.links.add({ fromKind: 'летопис', fromId: ids.c1, toKind: 'летопис', toId: ids.c1 });
  assert.equal(selfC.ok, false);
  // Непозната посока: книга → персона, статия → летопис.
  for (const fk of ['книга', 'статия', 'периодика', 'x']) {
    const r = await h.api.links.add({ fromKind: fk, fromId: 1, toKind: 'персона', toId: ids.p1 });
    assert.equal(r.ok, false, fk); assert.match(r.error, /Непозната връзка/);
  }
  const lst = ok(await h.api.links.list({ fromKind: 'летопис', fromId: ids.c1 }), 'list');
  assert.equal(lst.length, 5);
  assert.deepEqual(lst.map(l => l.to_kind), ['книга', 'летопис', 'периодика', 'персона', 'статия']);
  assert.equal(lst.find(l => l.to_kind === 'книга').label, 'инв. № 2 · Вазов, Иван. Под игото');
  assert.equal(lst.find(l => l.to_kind === 'статия').label, 'Иванова, Мария. Яворец празнува 100 години читалище (2022)');
  assert.equal(lst.find(l => l.to_kind === 'летопис').label, '1925 — Откриване на библиотеката');
  assert.equal(lst.find(l => l.to_kind === 'книга').note, 'към книга');
  // Обратни връзки: към персоналията сочи летописът; към книгата инв. № 1 — персоналията.
  const bl = ok(await h.api.links.backlinks({ toKind: 'персона', toId: ids.p1 }), 'backlinks');
  assert.equal(bl.length, 1);
  assert.equal(bl[0].label, '1922 — Основаване на читалището');
  assert.equal(bl[0].to_label, 'Петров, Георги Иванов');
  const bl2 = ok(await h.api.links.backlinks({ toKind: 'книга', toId: ids.b1 }), 'backlinks книга');
  assert.equal(bl2.length, 1); assert.equal(bl2[0].label, 'Петров, Георги Иванов');
  // Летописът показва брояча и картонът — връзките.
  await h.go('chronicle');
  assert.match(h.viewText(), /Основаване на читалището .*5 свързани материала/);
  await h.window.chronicleView(ids.c1);
  await h.waitFor(() => h.$('#linkList'), 'картон');
  await h.settle();
  assert.match(h.text('#linkList'), /инв\. № 2 · Вазов, Иван\. Под игото/);
  assert.match(h.text('#linkList'), /1925 — Откриване на библиотеката/);
  h.window.closeModal(); await h.settle();
  noRendererErrors();
});

test('9. Връзки: сираци — към несъществуващ запис, търсене с %/_ и с етикет при липсващ инв. №', async () => {
  const before = linkCount();
  const ghost = await h.api.links.add({ fromKind: 'персона', fromId: ids.p2, toKind: 'книга', toId: 999999 });
  await soft('НАХОДКА 10: links:add приема връзка към несъществуващ запис (книга id 999999) — ражда се сирак „(изтрит запис)“', async () => {
    assert.equal(ghost.ok, false, 'връзката е приета');
  });
  if (ghost.ok) {
    const l = ok(await h.api.links.list({ fromKind: 'персона', fromId: ids.p2 }), 'list');
    assert.equal(l[0].label, '(изтрит запис)');
    ok(await h.api.links.delete(l[0].id), 'чистене');
  }
  const ghost2 = await h.api.links.add({ fromKind: 'персона', fromId: 777777, toKind: 'книга', toId: ids.b1 });
  await soft('НАХОДКА 10а: links:add приема връзка ОТ несъществуваща персоналия (id 777777)', async () => {
    assert.equal(ghost2.ok, false);
  });
  if (ghost2.ok) h.db.prepare("DELETE FROM links WHERE from_id = 777777").run();
  assert.equal(linkCount(), before);
  // Търсене.
  const s = async (kind, qq) => ok(await h.api.links.search({ kind, q: qq }), 'search ' + kind + ' ' + qq);
  assert.equal((await s('книга', "O'Neil")).length, 1, 'апостроф');
  assert.equal((await s('книга', 'истина_за')).length, 1, 'подчертавка в самото заглавие');
  await soft('НАХОДКА 5г: links:search — „%“ намира всички книги, „_“ е заместител', async () => {
    assert.equal((await s('книга', '%')).length, 1, 'само една книга съдържа „%“');
    assert.equal((await s('книга', 'Под_игото')).length, 0);
  });
  assert.equal((await s('персона', "O'Ne")).length, 1);
  assert.equal((await s('персона', 'Даскал')).length, 1, 'по друго изписване');
  assert.equal((await s('летопис', 'учителят')).length, 1, 'по описанието');
  assert.equal((await s('периодика', 'вести')).length, 1);
  const bad = await h.api.links.search({ kind: 'читател', q: 'x' });
  assert.equal(bad.ok, false); assert.match(bad.error, /Непознат вид запис/);
  // Книга БЕЗ инвентарен номер (служебна): links:search и links:list дават различен етикет.
  const rNo = await h.api.books.create({ title: 'Без номер', author: 'Аноним', register_date: T, price: 0, inv_number: '' });
  if (rNo.ok) {
    const b = q('SELECT inv_number FROM books WHERE id = ?', rNo.data);
    if (b.inv_number == null) {
      const lab = (await s('книга', 'Без номер'))[0].label;
      ok(await h.api.links.add({ fromKind: 'персона', fromId: ids.p2, toKind: 'книга', toId: rNo.data }), 'връзка');
      const l = ok(await h.api.links.list({ fromKind: 'персона', fromId: ids.p2 }), 'list');
      await soft('НАХОДКА 11: етикетът на книга без инв. № е различен в links:search и в links:list („инв. № — ·“ срещу без представка)', async () => {
        assert.equal(l[0].label, lab);
      });
      ok(await h.api.links.delete(l[0].id), 'чистене');
    }
    await h.api.books.delete(rNo.data); await h.api.books.delete(rNo.data);
  }
  noRendererErrors();
});

test('10. Отчислена книга-източник: белег в указателя, отказ на нова връзка/описание, анулиран акт я връща', async () => {
  // Книгата инв. № 1 (източник на статия a2, свързана с персоналия p1) се отчислява с акт.
  ids.act = ok(await h.api.deaccessionActs.create({ act: ACT({ no: 1 }), bookIds: [ids.b1] }), 'акт № 1');
  assert.equal(q('SELECT status FROM books WHERE id = ?', ids.b1).status, 'отчислен');
  const act = q('SELECT no, year FROM deaccession_acts WHERE id = ?', ids.act);
  const mark = ` (отчислен с акт № ${act.no}/${act.year})`;
  // Съществуващото описание остава, източникът носи белега.
  const a2 = ok(await h.api.analytics.get(ids.a2), 'get');
  assert.equal(a2.book_title, 'Яворец през вековете' + mark);
  assert.equal(a2.book_status, 'отчислен');
  await h.go('analytics');
  assert.match(h.viewText(), /Петров, Георги\. Яворец през вековете \(отчислен с акт № 1\/\d{4}\) \(инв\. № 1\)/);
  // Съществуващата връзка персоналия → книга остава, но с белега; обратната посока също го казва.
  const l = ok(await h.api.links.list({ fromKind: 'персона', fromId: ids.p1 }), 'list');
  assert.equal(l.find(x => x.to_kind === 'книга').label, 'инв. № 1 · Петров, Георги. Яворец през вековете' + mark);
  const bl = ok(await h.api.links.backlinks({ toKind: 'книга', toId: ids.b1 }), 'bl');
  assert.equal(bl[0].to_label, 'инв. № 1 · Петров, Георги. Яворец през вековете' + mark);
  // Нова връзка към отчислената → отказ с указание какво да се направи.
  const nl = await h.api.links.add({ fromKind: 'летопис', fromId: ids.c2, toKind: 'книга', toId: ids.b1 });
  assert.equal(nl.ok, false); assert.match(nl.error, /отчислен с акт № 1\/\d{4} и вече не е част от фонда/);
  // Ново описание към нея → отказ; пренасочване на друго описание → отказ.
  const na = await h.api.analytics.create({ title: 'Нова статия от отчислена книга', source_kind: 'книга', book_id: ids.b1, year: '1985' });
  assert.equal(na.ok, false); assert.match(na.error, /Книгата източник е отчислен с акт № 1/);
  const a3 = ok(await h.api.analytics.get(ids.a3), 'get a3');
  const re = await h.api.analytics.update(Object.assign({}, a3, { source_kind: 'книга', book_id: ids.b1 }));
  assert.equal(re.ok, false); assert.match(re.error, /не може да бъде пренасочено/);
  // Търсенето я НАМИРА, с белега — и в списъка на връзките, и в „Книга от фонда“.
  const sr = ok(await h.api.links.search({ kind: 'книга', q: '1' }), 'search');
  assert.equal(sr.find(x => x.id === ids.b1).label, 'инв. № 1 · Петров, Георги. Яворец през вековете' + mark);
  // Редакция на описанието a2: полето „Книга от фонда“ носи белега и докосването не къса book_id.
  await h.window.analyticForm(ids.a2);
  await h.waitFor(() => h.$('#anlF'), 'формата');
  await h.settle();
  assert.equal(h.$('#anlF [name=book_pick]').value, 'инв. № 1 · Петров, Георги. Яворец през вековете' + mark);
  h.type('#anlF [name=book_pick]', h.$('#anlF [name=book_pick]').value + ' ');
  await h.settle();
  assert.equal(h.$('#anlF [name=book_id]').value, String(ids.b1), 'етикетът с белега се разпознава');
  h.type('#anlF [name=note]', 'поправен правопис');
  let ts = await saveModal();
  await soft('НАХОДКА 28: редакция (само на бележката) на описание, чиято книга-източник е отчислена, се ОТКАЗВА от екрана като „пренасочване“ — cur.book_id (число) !== d.book_id (низ от скритото поле)', async () => {
    assert.ok(ts.some(t => t.msg === 'Описанието е обновено.'), 'редакция на описание към отчислен източник е отказана: ' + JSON.stringify(ts));
  });
  if (h.modalOpen()) h.window.closeModal();
  // Същата редакция през API с числов book_id минава — тоест правилото е вярно, сравнението не е.
  const a2cur = ok(await h.api.analytics.get(ids.a2), 'get');
  ok(await h.api.analytics.update(Object.assign({}, a2cur, { note: 'поправен правопис' })), 'редакция през API с числов book_id');
  const a2str = await h.api.analytics.update(Object.assign({}, a2cur, { note: 'поправен правопис 2', book_id: String(ids.b1) }));
  await soft('НАХОДКА 28а: analytics:update със същия book_id, но като низ („1“ вместо 1), се третира като пренасочване към отчислена книга', async () => {
    assert.equal(a2str.ok, true, a2str.error);
  });
  assert.equal(q('SELECT book_id FROM analytics WHERE id = ?', ids.a2).book_id, ids.b1);
  // Изтриване на отчислената книга → отказ (чл. 39).
  const del = await h.api.books.delete(ids.b1);
  assert.equal(del.ok, false); assert.match(del.error, /отчислен с акт и не се изтрива/);

  // Печат на указателя: белегът излиза на хартия.
  await h.go('analytics');
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  let p = h.printed();
  assert.match(p, /АНАЛИТИЧНО ОПИСАНИЕ/);
  assert.match(p, /Пълен списък — всички 3 аналитични описания/);
  assert.match(p, /Яворец през вековете \(отчислен с акт № 1\/\d{4}\) \(инв\. № 1\), стр\. 45 – 61/);
  h.window.ppClose();

  // Анулиране на акта → книгата е пак във фонда, белегът изчезва, връзките и описанията се приемат.
  ok(await h.api.deaccessionActs.revoke(ids.act, { reason: 'сгрешен инвентарен номер' }), 'анулиране');
  assert.equal(q('SELECT status FROM books WHERE id = ?', ids.b1).status, 'наличен');
  assert.equal(ok(await h.api.analytics.get(ids.a2), 'get').book_title, 'Яворец през вековете');
  assert.equal(ok(await h.api.links.list({ fromKind: 'персона', fromId: ids.p1 }), 'l').find(x => x.to_kind === 'книга').label, 'инв. № 1 · Петров, Георги. Яворец през вековете');
  ok(await h.api.links.add({ fromKind: 'летопис', fromId: ids.c2, toKind: 'книга', toId: ids.b1 }), 'връзка след анулиране');
  ids.a4 = ok(await h.api.analytics.create({ title: 'Училището в Яворец', author: 'Петров, Георги', source_kind: 'книга', book_id: ids.b1, year: '1985', pages: '62 – 70', is_local: 1 }), 'описание след анулиране');
  noRendererErrors();
});

test('11. Изтриване с връзки: статия, периодично издание, персоналия, летопис — връзките си отиват без сираци', async () => {
  // Статия a1: към нея сочи летописът c1. Изтриване през екрана с потвърждение.
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE to_kind='статия' AND to_id=?", ids.a1).n, 1);
  await h.go('analytics');
  h.hooks.confirmAnswer = false;
  await h.window.analyticDelete(ids.a1);
  await h.settle();
  assert.ok(q('SELECT id FROM analytics WHERE id = ?', ids.a1), 'отказът на потвърждението не трие');
  h.hooks.confirmAnswer = true;
  const n = h.toasts.length;
  await h.window.analyticDelete(ids.a1);
  await h.settle();
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Описанието е изтрито.'));
  assert.equal(q('SELECT id FROM analytics WHERE id = ?', ids.a1), undefined);
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE to_kind='статия' AND to_id=?", ids.a1).n, 0, 'връзката към изтритата статия е махната');
  assert.match(lastAudit('Аналитично описание').detail, /изтрита статия: Яворец празнува/);
  // Периодично издание „Габровски вести“: вече без описания (a1 е изтрита), но с връзка от летописа.
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE to_kind='периодика' AND to_id=?", ids.per2).n, 1);
  ok(await h.api.periodicals.delete(ids.per2), 'изтриване на изданието');
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE to_kind='периодика' AND to_id=?", ids.per2).n, 0);
  // „Родна реч“ има описание (a3 не — то е „друго“; правим едно) → отказ.
  const aTmp = ok(await h.api.analytics.create({ title: 'Временна', source_kind: 'периодика', periodical_id: ids.per, year: '2000' }), 'временна');
  const rp = await h.api.periodicals.delete(ids.per);
  assert.equal(rp.ok, false); assert.match(rp.error, /1 аналитично описание/);
  ok(await h.api.analytics.delete(aTmp), 'чистене');
  // Персоналия p3 — към нея сочи p1; тя самата няма връзки навън.
  ok(await h.api.links.add({ fromKind: 'персона', fromId: ids.p3, toKind: 'летопис', toId: ids.c3 }), 'p3 → летопис');
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE (to_kind='персона' AND to_id=?) OR (from_kind='персона' AND from_id=?)", ids.p3, ids.p3).n, 2);
  await h.go('persons');
  await h.window.personView(ids.p3);
  await h.waitFor(() => h.$('#linkList'), 'картон');
  await h.settle();
  await h.clickButton('Изтрий', '#modal footer');
  await h.settle();
  assert.match(h.hooks.confirms[h.hooks.confirms.length - 1], /Изтриване на персоналията и всичките ѝ връзки/);
  assert.equal(q('SELECT id FROM persons WHERE id = ?', ids.p3), undefined);
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE (to_kind='персона' AND to_id=?) OR (from_kind='персона' AND from_id=?)", ids.p3, ids.p3).n, 0, 'и двете посоки са изчистени');
  assert.equal(h.modalOpen(), false);
  assert.match(h.viewText(), /Петров, Георги Иванов .*4 свързани материала/);
  // Летопис c2: към него сочи c1, той сочи към книга b1.
  ok(await h.api.chronicle.delete(ids.c2), 'изтриване на записа');
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE (to_kind='летопис' AND to_id=?) OR (from_kind='летопис' AND from_id=?)", ids.c2, ids.c2).n, 0);
  assert.match(lastAudit('Летопис').detail, /изтрит запис: Откриване на библиотеката/);
  // Книга b2 (Под игото) — сочена от c1; без описания и без заемания → изтрива се на второ натискане.
  let r = await h.api.books.delete(ids.b2);
  assert.equal(r.ok, false); assert.match(r.error, /ВПИСАН в инвентарната книга/);
  ok(await h.api.books.delete(ids.b2), 'второ натискане');
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE to_kind='книга' AND to_id=?", ids.b2).n, 0);
  // Сираци: всяка връзка сочи към съществуващ запис.
  const orphans = all(`SELECT l.* FROM links l WHERE
    (l.to_kind='книга' AND NOT EXISTS (SELECT 1 FROM books WHERE id=l.to_id)) OR
    (l.to_kind='статия' AND NOT EXISTS (SELECT 1 FROM analytics WHERE id=l.to_id)) OR
    (l.to_kind='летопис' AND NOT EXISTS (SELECT 1 FROM chronicle WHERE id=l.to_id)) OR
    (l.to_kind='персона' AND NOT EXISTS (SELECT 1 FROM persons WHERE id=l.to_id)) OR
    (l.to_kind='периодика' AND NOT EXISTS (SELECT 1 FROM periodicals WHERE id=l.to_id)) OR
    (l.from_kind='персона' AND NOT EXISTS (SELECT 1 FROM persons WHERE id=l.from_id)) OR
    (l.from_kind='летопис' AND NOT EXISTS (SELECT 1 FROM chronicle WHERE id=l.from_id))`);
  assert.deepEqual(orphans, [], 'сираци: ' + JSON.stringify(orphans));
  // Редакция на запис, който другото работно място междувременно е изтрило.
  const cTmp = ok(await h.api.chronicle.create({ title: 'Временен запис', year: '1999' }), 'временен');
  const c5 = q('SELECT * FROM chronicle WHERE id = ?', cTmp);
  h.db.prepare('DELETE FROM chronicle WHERE id = ?').run(cTmp);
  const up = await h.api.chronicle.update(Object.assign({}, c5, { title: 'Временен (поправено)' }));
  assert.equal(up.ok, false); assert.match(up.error, /изтрит от друго работно място/);
  const up2 = await h.api.persons.update({ id: 424242, name: 'Никой' });
  assert.equal(up2.ok, false); assert.match(up2.error, /изтрит от друго работно място/);
  const up3 = await h.api.analytics.update({ id: 424242, title: 'Никоя' });
  assert.equal(up3.ok, false); assert.match(up3.error, /изтрито от друго работно място/);
  // Изтриване на вече изтрит запис — минава „успешно“ с одит „изтрит запис: <id>“.
  const dd = await h.api.chronicle.delete(cTmp);
  await soft('НАХОДКА 12: chronicle:delete на несъществуващ запис връща успех и вписва в одита „изтрит запис: <id>“', async () => {
    assert.equal(dd.ok, false);
  });
  noRendererErrors();
});

/* ==================================================================
   12. Снимки към персоналия и летопис
   ================================================================== */
test('12. Снимки: файл, отказ, липсващ файл, грешен тип, над 1 MB, несъществуващ запис, махане', async () => {
  const png = path.join(TMP, 'portret.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  await h.go('persons');
  await h.window.personView(ids.p1);
  await h.waitFor(() => h.$('#linkList'), 'картон');
  await h.settle();
  assert.match(h.modal(), /няма снимка/);
  // Отказ в диалога — без червено известие.
  h.dialogs.openPaths = null;
  let n = h.toasts.length;
  await h.clickButton('Снимка…', '#modal');
  assert.equal(h.toastsSince(n).length, 0, 'отказаният диалог не вдига известие');
  // Истински файл.
  h.dialogs.openPaths = [png];
  n = h.toasts.length;
  await h.clickButton('Снимка…', '#modal');
  await h.settle();
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Снимката е добавена.'), JSON.stringify(h.toastsSince(n)));
  const photo = q('SELECT photo FROM persons WHERE id = ?', ids.p1).photo;
  assert.match(photo, /^data:image\/png;base64,iVBOR/);
  await h.waitFor(() => h.$('#modal img'), 'картонът се отваря пак със снимката');
  assert.match(h.modal(), /Смени…/);
  assert.match(h.modal(), /Махни/);
  await soft('НАХОДКА 13: добавянето/махането на снимка не оставя следа в одитния дневник', async () => {
    assert.ok(all("SELECT * FROM audit_log WHERE detail LIKE '%снимк%' OR action LIKE '%снимк%'").length > 0);
  });
  // Липсващ файл.
  h.dialogs.openPaths = [path.join(TMP, 'nyama.png')];
  n = h.toasts.length;
  await h.clickButton('Смени…', '#modal');
  await h.settle();
  const missing = h.toastsSince(n).find(t => t.type === 'err');
  assert.ok(missing, 'липсващият файл дава грешка');
  await soft('НАХОДКА 14: липсващ файл за снимка показва суровата системна грешка (ENOENT: no such file…) вместо българско съобщение', async () => {
    assert.doesNotMatch(missing.msg, /ENOENT|no such file/);
  });
  assert.match(q('SELECT photo FROM persons WHERE id = ?', ids.p1).photo, /^data:image\/png/, 'старата снимка остава');
  // Грешен тип.
  const txt = path.join(TMP, 'snimka.txt'); fs.writeFileSync(txt, 'не е снимка');
  const r1 = await h.api.localPhoto.choose({ table: 'persons', id: ids.p1 }); // диалогът още връща nyama.png
  assert.equal(r1.ok, false);
  h.dialogs.openPaths = [txt];
  const r2 = await h.api.localPhoto.choose({ table: 'persons', id: ids.p1 });
  assert.equal(r2.ok, false); assert.match(r2.error, /Изберете PNG, JPG, GIF или WEBP/);
  const svg = path.join(TMP, 'snimka.svg'); fs.writeFileSync(svg, '<svg/>');
  h.dialogs.openPaths = [svg];
  const r2s = await h.api.localPhoto.choose({ table: 'persons', id: ids.p1 });
  assert.equal(r2s.ok, false, 'SVG се отказва');
  // Над 1 MB.
  const big = path.join(TMP, 'golyama.jpg'); fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
  h.dialogs.openPaths = [big];
  const r3 = await h.api.localPhoto.choose({ table: 'chronicle', id: ids.c1 });
  assert.equal(r3.ok, false); assert.match(r3.error, /максимумът е 1024 KB/);
  await soft('НАХОДКА 27: файл от 1 048 577 байта се отказва със съобщение „Файлът е 1024 KB, а максимумът е 1024 KB“ (закръгляне) — изглежда като противоречие', async () => {
    assert.doesNotMatch(r3.error, /е 1024 KB, а максимумът е 1024 KB/);
  });
  // Непозната таблица.
  h.dialogs.openPaths = [png];
  const r4 = await h.api.localPhoto.choose({ table: 'readers', id: 1 });
  assert.equal(r4.ok, false); assert.match(r4.error, /Непозната таблица/);
  // Несъществуващ запис — снимката „се добавя“ в нищото.
  const r5 = await h.api.localPhoto.choose({ table: 'chronicle', id: 999999 });
  await soft('НАХОДКА 15: localPhoto:choose към несъществуващ запис (id 999999) връща успех „Снимката е добавена“', async () => {
    assert.equal(r5.ok, false);
  });
  // Летопис: снимка към записа c1, после махане през картона.
  const r6 = ok(await h.api.localPhoto.choose({ table: 'chronicle', id: ids.c1 }), 'снимка към летописа');
  assert.match(r6, /^data:image\/png/);
  await h.go('chronicle');
  assert.ok(h.$('#chrItems img.chrThumb'), 'миниатюрата е в списъка');
  await h.window.chronicleView(ids.c1);
  await h.waitFor(() => h.$('#modal img'), 'картон със снимка');
  await h.settle();
  n = h.toasts.length;
  await h.clickButton('Махни', '#modal');
  await h.settle();
  assert.ok(h.toastsSince(n).some(t => t.msg === 'Снимката е премахната.'));
  assert.equal(q('SELECT photo FROM chronicle WHERE id = ?', ids.c1).photo, null);
  await h.waitFor(() => h.modalOpen() && /няма снимка/.test(h.modal()), 'картонът се отваря пак без снимка');
  h.window.closeModal(); await h.settle();
  noRendererErrors();
});

/* ==================================================================
   13. Разпечатки: летопис за година, персоналии, указател на статиите
   ================================================================== */
test('13. Разпечатка на летописа: пълен и за една година — обхват, ред, подписи, номерация, източници', async () => {
  await h.go('chronicle');
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  let p = h.printed();
  const total = q('SELECT COUNT(*) AS n FROM chronicle').n;
  assert.match(p, /ЛЕТОПИС/);
  assert.match(p, /Библиотека „Изпитание“|НЧ „Изпитание – 1922“/, 'бланката на библиотеката');
  assert.match(p, new RegExp('Пълен летопис — всички ' + total + ' вписани записа'));
  assert.match(p, /Летописец: …/);
  assert.match(p, /Председател: …/);
  // Годините вървят възходящо: 1922 преди 1972 преди текущата; „ок. 1930“ между 1925 и 1972.
  const i1922 = p.indexOf('Основаване на читалището'), i1930 = p.indexOf('Първа сбирка'), i1972 = p.indexOf('Дарение на 200 тома'), iY = p.indexOf('Нова читалня');
  assert.ok(i1922 > -1 && i1930 > i1922 && i1972 > i1930 && iY > i1972, 'ред на годините: ' + [i1922, i1930, i1972, iY]);
  assert.match(p, /ок\. 1930 г\./);
  // Вътре в 1972 г.: 15.01 (ремонт) трябва да е ПРЕДИ 24.05 (юбилей).
  await soft('НАХОДКА 16: в разпечатания летопис записите вътре в една година са в ОБРАТЕН хронологичен ред (24.05.1972 преди 15.01.1972)', async () => {
    assert.ok(p.indexOf('Ремонт на салона') < p.indexOf('=SUM(A1:A9)'), 'ремонтът от януари е след юбилея от май');
  });
  await soft('НАХОДКА 17: разпечатаният летопис няма пореден номер на записите (летописната книга се води с номерирани записи)', async () => {
    assert.match(p, /№\s*1\b/);
  });
  await soft('НАХОДКА 18: „Източници“ на записа не излизат в разпечатката на летописа (има ги на екрана)', async () => {
    assert.match(p, /Протокол № 1\/1922/);
  });
  await soft('НАХОДКА 19: разпечатката не дава сбор „записи за годината“ (годишен итог)', async () => {
    assert.match(p, /1972 г\.[^]*?3 записа|записа за 1972/);
  });
  assert.match(p, /=SUM\(A1:A9\) <b>юбилей<\/b>/, 'формулните/HTML знаци се печатат дословно');
  assert.match(p, /Участници: @всички; O'Neil/);
  h.window.ppClose();
  // Само 1972 г.
  h.type('#view select', '1972');
  await h.settle();
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  p = h.printed();
  assert.match(p, /ЛЕТОПИС — 1972 г\./);
  assert.match(p, /Обхват на разпечатката: само 1972 г\. — 3 записа\. Това НЕ е пълният летопис\./);
  assert.doesNotMatch(p, /Основаване на читалището/);
  assert.match(p, /Дарение на 200 тома · дарение/);
  h.window.ppClose();
  h.type('#view select', '');
  await h.settle();
  assert.equal(h.hooks.prints, 0, 'самият печат чака потвърждение от прегледа');
  noRendererErrors();
});

test('14. Разпечатка на персоналиите и указател на статиите: библиографска структура', async () => {
  await h.go('persons');
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  let p = h.printed();
  assert.match(p, /ПЕРСОНАЛИИ/);
  assert.match(p, /Пълен списък — всички 2 вписани персоналии/);
  assert.match(p, /Петров, Георги Иванов · 12\.03\.1890 – 01\.07\.1961/);
  assert.match(p, /Източници: Летопис на училището; спомени/);
  assert.match(p, /O'Neil, Джон[^]*Източници: непосочени/);
  assert.match(p, /Съставил: …/);
  await soft('НАХОДКА 20: картонът на персоналията на хартия не съдържа свързаните материали (книги, статии, летопис) — „Свързани материали“ ги има само на екрана', async () => {
    assert.match(p, /Яворец през вековете|Свързани материали/);
  });
  h.window.ppClose();
  // Търсене → обхватът се обявява.
  h.window.eval("PRS_Q = 'Петров'");
  await h.window.printPersons();
  await h.settle();
  p = h.printed();
  assert.match(p, /Обхват: само записите, съдържащи „Петров“ — 1 от целия раздел\. Това НЕ е пълният списък\./);
  h.window.ppClose();
  h.window.eval("PRS_Q = ''");

  // Указател на статиите.
  ids.a5 = ok(await h.api.analytics.create({
    title: 'Народните носии от Яворец', author: 'Иванова, Мария', source_kind: 'периодика', periodical_id: ids.per,
    year: '1999', issue: '4', issue_date: '1999-04-01', pages: '12 – 14', udk: '391(497.2)', keywords: 'носии, етнография', is_local: 1
  }), 'статия от Родна реч');
  await h.go('analytics');
  h.type('#view input[type=checkbox]', true);
  await h.settle();
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  p = h.printed();
  assert.match(p, /АНАЛИТИЧНО ОПИСАНИЕ \(краеведски\)/);
  assert.match(p, /Обхват: всички години, само краеведските описания — 3 описания\. Това НЕ е пълният списък\./);
  assert.match(p, /Народните носии от Яворец \(1999\) — краеведски Иванова, Мария Родна реч, бр\. 4 от 01\.04\.1999, стр\. 12 – 14/, 'автор, заглавие, източник, година, брой, страници');
  assert.doesNotMatch(p, /Кооперацията в Яворец/, 'некраеведското описание не е в указателя');
  await soft('НАХОДКА 21: УДК не излиза в разпечатания указател на статиите (елемент на аналитичното описание)', async () => {
    assert.match(p, /391\(497\.2\)/);
  });
  await soft('НАХОДКА 21а: ключовите думи и анотацията не излизат в разпечатания указател', async () => {
    assert.match(p, /носии, етнография/);
  });
  h.window.ppClose();
  h.type('#view input[type=checkbox]', false);
  await h.settle();
  // Екранът: няма колона УДК в таблицата.
  await soft('НАХОДКА 21б: в таблицата на екрана няма УДК и брой на изданието се вижда само в колоната „Източник“', async () => {
    assert.match(h.text('#view thead'), /УДК/);
  });
  noRendererErrors();
});

/* ==================================================================
   15. Пълен износ (CSV в ZIP): формулните знаци и снимките
   ================================================================== */
test('15. Пълен износ: letopis.csv, personalii.csv, analitichno-opisanie.csv, vrazki.csv', async () => {
  const zipPath = path.join(TMP, 'iznos.zip');
  h.dialogs.savePath = zipPath;
  ok(await h.api.exportAll.run(), 'износ');
  const z = readZip(fs.readFileSync(zipPath));
  for (const f of ['letopis.csv', 'personalii.csv', 'analitichno-opisanie.csv', 'vrazki.csv', 'PROCHETI-ME.txt']) assert.ok(z.has(f), 'липсва ' + f + ': ' + [...z.keys()].join(','));
  const letopis = z.get('letopis.csv').toString('utf8');
  assert.match(letopis, /"'=SUM\(A1:A9\) <b>юбилей<\/b>"/, 'клетка, започваща с „=“, получава защитен апостроф');
  assert.match(letopis, /"'\+50 години; -1 &amp; ""кавички"" 'апостроф' <script>alert\(1\)<\/script>"/, 'кавичките се удвояват, „+“ се пази');
  assert.match(letopis, /"'@всички; O'Neil"/);
  const pers = z.get('personalii.csv').toString('utf8');
  assert.doesNotMatch(pers, /base64,iVBOR/, 'снимката не влиза в CSV');
  assert.match(pers, /Петров, Георги Иванов/);
  const vr = z.get('vrazki.csv').toString('utf8');
  assert.match(vr, /"персона";"\d+";"книга";/);
  const readme = z.get('PROCHETI-ME.txt').toString('utf8');
  await soft('НАХОДКА 22: в PROCHETI-ME.txt таблицата links (краеведските връзки) е описана като „Полезни връзки“', async () => {
    assert.doesNotMatch(readme, /vrazki\.csv[^\n]*Полезни връзки/);
  });
  h.dialogs.savePath = null;
  noRendererErrors();
});

/* ==================================================================
   16. Летописът след всичко — броячи, редакция през картона, „Затвори“ опреснява
   ================================================================== */
test('16. Летопис: редакция през картона, изтриване на запис с връзки през екрана', async () => {
  await h.go('chronicle');
  await h.window.chronicleView(ids.c1);
  await h.waitFor(() => h.$('#linkList'), 'картон');
  await h.settle();
  await h.clickButton('Редакция', '#modal footer');
  await h.waitFor(() => h.$('#chrF'), 'формата за редакция');
  assert.equal(h.$('#chrF [name=year]').value, '1922');
  assert.equal(h.$('#chrF [name=date]').value, '1922-05-24');
  h.type('#chrF [name=year]', '');
  h.type('#chrF [name=date]', '');
  let ts = await saveModal();
  assert.ok(ts.some(t => /Годината е задължителна/.test(t.msg)), JSON.stringify(ts));
  assert.equal(h.modalOpen(), true, 'формата остава отворена с текста');
  h.type('#chrF [name=date]', '1922-05-24');
  ts = await saveModal();
  assert.ok(ts.some(t => t.msg === 'Записът е обновен.'), JSON.stringify(ts));
  assert.equal(q('SELECT year FROM chronicle WHERE id = ?', ids.c1).year, '1922', 'при празна година се извежда от датата');
  assert.match(lastAudit('Летопис').detail, /редакция: Основаване на читалището/);
  // Изтриване през картона — с потвърждение; връзките от/към записа си отиват.
  const before = q("SELECT COUNT(*) AS n FROM links WHERE (from_kind='летопис' AND from_id=?) OR (to_kind='летопис' AND to_id=?)", ids.c1, ids.c1).n;
  assert.equal(before, 2, 'записът има връзки: летопис → персона и персона → летопис');
  await h.window.chronicleView(ids.c1);
  await h.waitFor(() => h.$('#linkList'), 'картон');
  await h.settle();
  h.hooks.confirmAnswer = true;
  await h.clickButton('Изтрий', '#modal footer');
  await h.settle();
  assert.equal(q('SELECT id FROM chronicle WHERE id = ?', ids.c1), undefined);
  assert.equal(q("SELECT COUNT(*) AS n FROM links WHERE (from_kind='летопис' AND from_id=?) OR (to_kind='летопис' AND to_id=?)", ids.c1, ids.c1).n, 0);
  assert.doesNotMatch(h.viewText(), /Основаване на читалището/);
  await h.go('persons');
  assert.match(h.viewText(), /Петров, Георги Иванов .*3 свързани материала/, 'броячът на персоналията пада с 1 (връзката към летописа)');
  noRendererErrors();
});

/* ==================================================================
   Край: находките
   ================================================================== */
test('Z. находки от сценария', () => {
  console.log('\n=== НАХОДКИ (' + findings.length + ') ===');
  findings.forEach((f, i) => console.log((i + 1) + '. ' + f.label + '\n   ' + f.msg.split('\n')[0]));
  assert.equal(findings.length, 0, findings.length + ' находки — виж списъка по-горе');
});
