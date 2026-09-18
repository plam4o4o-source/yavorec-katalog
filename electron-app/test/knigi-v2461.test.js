'use strict';
/* Одитен кръг v2.4.61 — ВПИСВАНЕ НА ДОКУМЕНТИ И ЗАВЕЖДАНЕ НА ПАРТИДИ.
 * =====================================================================
 * Сценарият на кръга (test/scenario-knigi.test.js) минава пътя на библиотекарката
 * от „+ Нова книга“ до подписания КДБФ и остави осемнайсет находки. Всичките са
 * от два вида:
 *
 *   • СТОЙНОСТ, КОЯТО НЕ Е СТОЙНОСТ, ВЛИЗА В ОФИЦИАЛЕН РЕГИСТЪР — цена −5 €,
 *     цена „abc“ (която става NULL и изпада от всеки сбор), „12,50“, отрязано до
 *     12, инвентарен № 0, −4 и „12.7“ (отрязан до 12 без дума), партида с дата
 *     „abc“ (която не излиза в нито една година на Част № 1), партида с −3
 *     документа. Всяко от тях се открива месеци по-късно, при проверка, и нищо
 *     в програмата не може да каже откъде се е взело.
 *
 *   • ЕДНО И СЪЩО ПРАВИЛО, ПРИЛОЖЕНО НА ЕДНОТО МЯСТО И ПРОПУСНАТО НА ДРУГОТО —
 *     датата и адресът на дарителя се проверяваха при ПОПРАВКА на партида, но не
 *     при завеждането ѝ; инвентарният номер се пазеше при вписване, но не при
 *     редакция; „изгубен“ го имаше в менюто, но не и в позволените стойности;
 *     отчисленият документ беше защитен на екрана, но не и в канала.
 *
 * Тук стои по един тест на находка, кръстен на дефекта, а не на кода.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  APP_DIR, freshDb, fakeIpcMain, runDep, cleanupTmpDirs, buildDom, settle, printed
} = require('./helpers/audit-fixtures');
const { BOOK_SELECT, normalizeScanCode } = require('./helpers/prod-values');

test.after(cleanupTmpDirs);

const TODAY = '2026-08-04';
const YEAR = '2026';

/* Истинските обработчици върху прясна база — без Electron, без прозорец. */
function setup() {
  const { db } = freshDb('inv-knigi-v2461-');
  const audit = [];
  const deps = {
    getDb: () => db, run: runDep,
    logAudit: (action, detail, diff) => audit.push({ action, detail, diff }),
    today: () => TODAY, yearOf: (d) => (d || TODAY).slice(0, 4),
    BOOK_SELECT, normalizeScanCode,
    ftsQuery: (q) => q, cnSortKey: () => '', diffFields: () => [],
    scheduleCatalogWrite: () => {}, flushCatalogWrite: () => ({ written: true })
  };
  const ipcMain = fakeIpcMain();
  for (const m of ['books', 'acquisitions', 'deaccession-acts', 'fund-check', 'suggestions']) {
    require(path.join(APP_DIR, 'handlers', m))(ipcMain, deps);
  }
  return { db, ipcMain, audit };
}
const ok = (res, what) => { assert.equal(res.ok, true, what + ': ' + (res.error || '')); return res.data; };
const NEW = (o) => Object.assign({ title: 'Книга', register_date: TODAY }, o);
const ACQ = (o) => Object.assign({ no: 1, date: TODAY, how: 'закупуване', from_source: 'Книжарница', total_count: 1 }, o);

/* ==================================================================
   1. ЦЕНАТА НА ДОКУМЕНТА
   ================================================================== */

test('отрицателна цена не влиза във фонда — тя намалява стойността му в КДБФ', () => {
  /* Полето носи min="0", но в тази програма браузърът никога не проверява
     формата (onsubmit="return false"), тоест min е украса. −5 € се записваха и
     от този миг стойността на фонда във всеки подписван документ беше с 5 €
     по-малка. */
  const { ipcMain, db } = setup();
  const r = ipcMain.invoke('books:create', NEW({ inv_number: 1, price: '-5' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Цената „-5“ е отрицателна/);
  assert.match(r.error, /впишете 0/, 'съобщението казва какво да се направи вместо това');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM books').get().n, 0);
  // И при редакция — пътят е същият (bookPayload), но проверката трябва да важи и там.
  const id = ok(ipcMain.invoke('books:create', NEW({ inv_number: 1, price: '10' })), 'редовна книга');
  const b = ok(ipcMain.invoke('books:get', id), 'get');
  assert.equal(ipcMain.invoke('books:update', Object.assign({}, b, { price: '-1' })).ok, false);
  assert.equal(db.prepare('SELECT price FROM books WHERE id = ?').get(id).price, 10);
});

test('нечислова цена се отказва, а „12,50“ се чете като 12.50 — вместо NULL и отрязани стотинки', () => {
  /* parseFloat('abc') = NaN, а better-sqlite3 подава NaN като NULL: документът
     влизаше във фонда с празна цена и изпадаше от всеки SUM без никаква следа.
     parseFloat('12,50') = 12 — а запетаята е десетичният знак на всяка българска
     клавиатура и на всяка стара фактура. */
  const { ipcMain, db } = setup();
  const bad = ipcMain.invoke('books:create', NEW({ inv_number: 1, price: 'abc' }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Цената „abc“ не е число/);
  assert.match(bad.error, /изпада от всеки сбор/, 'обяснено е защо не е „по-добре от нищо“');

  const id = ok(ipcMain.invoke('books:create', NEW({ inv_number: 1, price: '12,50' })), 'запетая');
  assert.equal(db.prepare('SELECT price FROM books WHERE id = ?').get(id).price, 12.5);
  // Празно поле си остава 0 (както досега), а сумата се закръгля до стотинки.
  const id2 = ok(ipcMain.invoke('books:create', NEW({ inv_number: 2, price: '' })), 'празно');
  assert.equal(db.prepare('SELECT price FROM books WHERE id = ?').get(id2).price, 0);
  const id3 = ok(ipcMain.invoke('books:create', NEW({ inv_number: 3, price: 7.125 })), 'закръгляне');
  assert.equal(db.prepare('SELECT price FROM books WHERE id = ?').get(id3).price, 7.13);
});

/* ==================================================================
   2. ИНВЕНТАРНИЯТ НОМЕР
   ================================================================== */

test('инв. № 0, отрицателен и дробен номер се отказват — поредицата по чл. 16, ал. 2 започва от 1', () => {
  /* Дробният е най-коварен: parseInt('12.7') = 12 и документът се вписваше под
     ЧУЖД номер, без нито дума. */
  const { ipcMain, db } = setup();
  for (const [inv, what] of [[0, 'нула'], [-4, 'отрицателен'], ['12.7', 'дробен'], ['  ', 'само интервали']]) {
    const r = ipcMain.invoke('books:create', NEW({ inv_number: inv, title: 'Проба ' + what }));
    if (what === 'само интервали') {   // празно поле остава NULL, както досега
      assert.equal(r.ok, true, 'празният номер е допустим (стар внесен ред): ' + r.error);
      assert.equal(db.prepare('SELECT inv_number FROM books WHERE id = ?').get(r.data).inv_number, null);
      continue;
    }
    assert.equal(r.ok, false, 'инв. № ' + inv + ' (' + what + ') трябва да се откаже');
    assert.match(r.error, /Инвентарният номер трябва да е цяло положително число/);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM books WHERE title LIKE 'Проба %' AND inv_number IS NOT NULL").get().n, 0);
});

test('смяната на инвентарния номер при редакция мести брояча и оставя следа за дупката', () => {
  /* Дотук books:update просто записваше новия номер: броячът оставаше назад и
     всяко следващо „+ Нова книга“ предлагаше вече зает номер, падаше с „Инв. № N
     вече е зает… Затворете и отворете формата отново“ — а отварянето отново
     даваше същия зает номер. Задънена улица. А прескочените номера не оставяха
     нищо в дневника, макар проверката по чл. 17, ал. 2 да иска отговор за всеки. */
  const { ipcMain, db, audit } = setup();
  const id = ok(ipcMain.invoke('books:create', NEW({ inv_number: 1, title: 'Тютюн' })), 'вписване');
  assert.equal(db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number, 2);

  const b = ok(ipcMain.invoke('books:get', id), 'get');
  const res = ok(ipcMain.invoke('books:update', Object.assign({}, b, { inv_number: '20' })), 'нов номер');
  assert.equal(db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number, 21,
    'броячът минава СЛЕД новия номер — иначе следващото вписване пада върху него');
  assert.ok(res && res.invGap, 'отговорът носи предупреждението към прозореца');
  assert.equal(res.invGap.skipped, 18);
  assert.match(res.invGap.message, /чл\. 17, ал\. 2/);
  const trail = audit.find(a => a.action === 'Прескочени инвентарни номера');
  assert.ok(trail, 'следата е задължителна — прозорецът се затваря, дневникът остава');
  assert.match(trail.detail, /от инв\. № 1 на инв\. № 20/);
  assert.match(trail.detail, /от 2 до 19/);
  // След смяната предложеният номер е свободен — веригата не се задръства.
  const next = db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number;
  assert.equal(ipcMain.invoke('books:create', NEW({ inv_number: next, title: 'Следващата' })).ok, true);
});

test('обикновената редакция НЕ мести брояча и не пише за дупки — иначе следата се превръща в шум', () => {
  const { ipcMain, db, audit } = setup();
  db.prepare('UPDATE settings SET next_inv_number = 3 WHERE id = 1').run();
  const id = ok(ipcMain.invoke('books:create', NEW({ inv_number: 100, title: 'Стар номер' })), 'вписване');
  const after = db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number;
  const n = audit.filter(a => a.action === 'Прескочени инвентарни номера').length;
  const b = ok(ipcMain.invoke('books:get', id), 'get');
  ok(ipcMain.invoke('books:update', Object.assign({}, b, { title: 'Стар номер (поправено заглавие)' })), 'редакция');
  assert.equal(db.prepare('SELECT next_inv_number FROM settings WHERE id = 1').get().next_inv_number, after);
  assert.equal(audit.filter(a => a.action === 'Прескочени инвентарни номера').length, n);
});

test('зает номер при редакция назовава документа, който го държи', () => {
  /* Дотук оставаше само UNIQUE индексът и общият превод на SQLite грешката —
     „Този инвентарен номер вече е зает от друг документ.“ — без да каже кой е
     другият. А точно това трябва на човека, който сверява два картона. */
  const { ipcMain } = setup();
  ok(ipcMain.invoke('books:create', NEW({ inv_number: 10, title: 'Под игото' })), 'първата');
  const id = ok(ipcMain.invoke('books:create', NEW({ inv_number: 11, title: 'Тютюн' })), 'втората');
  const b = ok(ipcMain.invoke('books:get', id), 'get');
  const r = ipcMain.invoke('books:update', Object.assign({}, b, { inv_number: '10' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /Инв\. № 10 вече е зает от „Под игото“/);
  assert.match(r.error, /чл\. 16, ал\. 2/);
  // Записът на СОБСТВЕНИЯ номер не се брои за зает — иначе никоя редакция не минава.
  assert.equal(ipcMain.invoke('books:update', Object.assign({}, b, { title: 'Тютюн, 2. изд.' })).ok, true);
});

/* ==================================================================
   3. СЪСТОЯНИЕ И ОТЧИСЛЯВАНЕ
   ================================================================== */

test('нов документ не може да се роди със състояние „отчислен“', () => {
  /* Вносът на файл отдавна отказва такъв ред; най-прекият път го приемаше.
     Ред със status='отчислен' без акт се брои в КДБФ и не се брои на таблото —
     един фонд с две числа. */
  const { ipcMain } = setup();
  const r = ipcMain.invoke('books:create', NEW({ inv_number: 1, status: 'отчислен' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /не може да бъде вписан направо със състояние „отчислен“/);
  assert.match(r.error, /чл\. 30 – 35/);
});

test('отчислен с акт документ не се връща във фонда от картона — само с анулиране на акта', () => {
  const { ipcMain, db } = setup();
  const id = ok(ipcMain.invoke('books:create', NEW({ inv_number: 1, price: 10 })), 'книга');
  ok(ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: TODAY, reason_code: 4, reason_text: 'Физически изхабени', disposal: 'вторични суровини' },
    bookIds: [id]
  }), 'акт');
  const b = ok(ipcMain.invoke('books:get', id), 'get');
  assert.equal(b.status, 'отчислен');
  const r = ipcMain.invoke('books:update', Object.assign({}, b, { status: 'наличен' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /отчислен с акт/);
  assert.match(r.error, /Анулирай акта/);
  assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(id).status, 'отчислен');
  // Записът на картона БЕЗ промяна на състоянието продължава да минава (бележка,
  // сигнатура, забележка по документа се поправят и след отчисляване).
  assert.equal(ipcMain.invoke('books:update', Object.assign({}, b, { description: 'корица откъсната' })).ok, true);
});

test('груповата редакция приема „изгубен“ — менюто го предлага, а отказът говореше за отчисляване', () => {
  /* Списъкът с позволени стойности беше останал отпреди „изгубен“ да влезе в
     enum-а и в менюто. Отказът при това лъжеше: „Отчисляването на документи
     минава само през акт за отчисляване“ — правило, което няма нищо общо. */
  const { ipcMain, db } = setup();
  const id = ok(ipcMain.invoke('books:create', NEW({ inv_number: 1 })), 'книга');
  ok(ipcMain.invoke('books:bulkUpdate', { ids: [id], field: 'status', value: 'изгубен' }), 'изгубен');
  assert.equal(db.prepare('SELECT status FROM books WHERE id = ?').get(id).status, 'изгубен');
  // „Отчислен“ обаче си остава невъзможен от групова редакция (чл. 30 – 39).
  const r = ipcMain.invoke('books:bulkUpdate', { ids: [id], field: 'status', value: 'отчислен' });
  assert.equal(r.ok, false);
  assert.match(r.error, /само през акт за отчисляване/);
});

/* ==================================================================
   4. ДАТА НА ВПИСВАНЕ В БЪДЕЩЕТО
   ================================================================== */

test('дата на вписване след днешния ден се приема, но вече предупреждава', () => {
  /* Не се отказва — предварително вписване има законен случай. Отказва се
     мълчанието: до настъпването на датата документът се брои на таблото и НЕ се
     брои в КДБФ и в годишния отчет, а най-честата ѝ причина е сгрешена година. */
  const { ipcMain } = setup();
  const r = ipcMain.invoke('books:create', NEW({ inv_number: 1, register_date: '2027-01-15' }));
  assert.equal(r.ok, true);
  assert.ok(r.dateWarning, 'отговорът носи предупреждението');
  assert.match(r.dateWarning, /СЛЕД днешния ден/);
  assert.match(r.dateWarning, /годишния отчет/);
  const today = ipcMain.invoke('books:create', NEW({ inv_number: 2, register_date: TODAY }));
  assert.equal(today.dateWarning, null, 'днешната дата не вдига тревога');
});

/* ==================================================================
   5. ПАРТИДАТА (КДБФ Част № 1)
   ================================================================== */

test('партида с нечетима или празна дата не се завежда — иначе я няма в нито една година на регистъра', () => {
  /* yearOf() е slice(0,4): date 'abc' даваше year 'abc' и партидата изчезваше от
     Част № 1 за всяка година, оставайки в базата. */
  const { ipcMain, db } = setup();
  for (const d of ['abc', '', null, '2026-02-30', '2026-13-01']) {
    const r = ipcMain.invoke('acquisitions:create', ACQ({ no: 1, date: d }));
    assert.equal(r.ok, false, 'дата „' + d + '“ трябва да се откаже');
    assert.match(r.error, /липсва или не е валидна дата|чл\. 14, ал\. 2/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acquisitions').get().n, 0);
  assert.equal(ipcMain.invoke('acquisitions:create', ACQ({ no: 1, date: '2026-02-28' })).ok, true);
});

test('дарение без адрес на дарителя не се завежда (чл. 6, ал. 5) — освен когато документ изобщо няма', () => {
  /* Проверката съществуваше САМО при поправка на партида — тоест на пътя, който
     се минава почти никога. Актът за дарение излизаше с „Адрес: …………………“.
     Изключението е партидата по чл. 3, ал. 2: там дарител в правния смисъл няма
     (намерени при подреждане) и заместващият документ е протокол на комисия, не
     акт за дарение. */
  const { ipcMain } = setup();
  const r = ipcMain.invoke('acquisitions:create', ACQ({ how: 'дарение', doc_type: 'акт (разписка)', from_source: 'Иван Дарителов' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /чл\. 6, ал\. 5/);
  assert.match(r.error, /без документ — протокол на комисия/, 'съобщението сочи и законния изход за неизвестен дарител');

  ok(ipcMain.invoke('acquisitions:create', ACQ({
    no: 1, how: 'дарение', doc_type: 'без документ — протокол на комисия', from_source: 'намерени при подреждане'
  })), 'без първичен документ — минава без адрес');
  ok(ipcMain.invoke('acquisitions:create', ACQ({
    no: 2, how: 'дарение', doc_type: 'акт (разписка)', from_source: 'Иван Дарителов', donor_address: 'с. Яворец'
  })), 'с адрес');
});

test('отрицателен общ брой и отрицателна обявена стойност на партида се отказват', () => {
  /* И двете влизат право в реда ОБЩО на Част № 1 и го намаляват. */
  const { ipcMain, db } = setup();
  const r1 = ipcMain.invoke('acquisitions:create', ACQ({ total_count: -3 }));
  assert.equal(r1.ok, false);
  assert.match(r1.error, /Общият брой документи „-3“ не е цяло число/);
  const r2 = ipcMain.invoke('acquisitions:create', ACQ({ sum: '-10' }));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Обявената стойност „-10“ не е сума/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM acquisitions').get().n, 0);
  // Празната стойност си остава NULL („документът не обявява стойност“), а
  // запетаята се приема като десетичен знак.
  const id = ok(ipcMain.invoke('acquisitions:create', ACQ({ no: 1, sum: '' })), 'без стойност');
  assert.equal(db.prepare('SELECT sum FROM acquisitions WHERE id = ?').get(id).sum, null);
  const id2 = ok(ipcMain.invoke('acquisitions:create', ACQ({ no: 2, sum: '25,50' })), 'със запетая');
  assert.equal(db.prepare('SELECT sum FROM acquisitions WHERE id = ?').get(id2).sum, 25.5);
});

test('поправката не може да изнесе партидата в друга година — номерът ѝ е пореден за нейната', () => {
  const { ipcMain, db } = setup();
  const id = ok(ipcMain.invoke('acquisitions:create', ACQ({ no: 7, date: '2025-12-30' })), 'стара партида');
  const prev = db.prepare('SELECT * FROM acquisitions WHERE id = ?').get(id);
  const moved = ipcMain.invoke('acquisitions:update', { id, acq: Object.assign({}, prev, { date: '2026-01-03' }) });
  assert.equal(moved.ok, false);
  assert.match(moved.error, /Партида № 7\/2025 не може да получи дата от 2026 г\./);
  assert.match(moved.error, /изтрийте я .* и я заведете наново/);
  assert.equal(db.prepare('SELECT date FROM acquisitions WHERE id = ?').get(id).date, '2025-12-30');
  // Поправка ВЪТРЕ в годината (сгрешен ден) остава възможна — тя е обичайната.
  ok(ipcMain.invoke('acquisitions:update', { id, acq: Object.assign({}, prev, { date: '2025-12-29' }) }), 'в същата година');
  assert.equal(db.prepare('SELECT year FROM acquisitions WHERE id = ?').get(id).year, '2025');
});

/* ==================================================================
   6. СЪГЛАСУВАНЕ НА ФОНДА
   ================================================================== */

test('съгласуването разпознава документ с дата на отчисляване, но със състояние във фонда', () => {
  /* Дотук причините бяха три и когато разликата идваше само от този случай,
     находката излизаше като „бележка“ с обяснение „документи, вписани след
     31.12“ — невярно изречение, което праща библиотекаря да търси дати. */
  const { ipcMain, db } = setup();
  const id = ok(ipcMain.invoke('books:create', NEW({ inv_number: 1, price: 10 })), 'книга');
  ok(ipcMain.invoke('deaccessionActs:create', {
    act: { no: 1, date: TODAY, reason_code: 4, reason_text: 'Физически изхабени' }, bookIds: [id]
  }), 'акт');
  // Така изглежда ред, останал от по-стара версия или от внос: актът е на място,
  // но състоянието е върнато на „наличен“.
  db.prepare("UPDATE books SET status = 'наличен' WHERE id = ?").run(id);

  const r = ok(ipcMain.invoke('fund:check', YEAR), 'проверка');
  const keys = r.findings.find(f => f.key === 'keys');
  assert.ok(keys, 'двата ключа за фонд се разминават');
  assert.equal(keys.level, 'важно', 'разминаване с известна причина не е бележка');
  assert.match(keys.why, /1 с дата на отчисляване, но със състояние във фонда/);
  assert.match(keys.todo, /анулирайте акта/);
});

/* ==================================================================
   7. ЕКРАНЪТ И РАЗПЕЧАТКИТЕ
   ================================================================== */

const ACQ_ROW = (o) => Object.assign({
  id: 1, no: 3, year: YEAR, date: YEAR + '-05-06', how: 'дарение', from_source: 'неизвестен дарител',
  doc_type: 'без документ — протокол на комисия', doc_no: null, doc_date: null,
  total_count: 1, registered_count: 1, registered_value: 5, inv_from: 1, inv_to: 1, sum: null,
  committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка',
  items: [{ id: 1, inv_number: 1, title: 'Намерена при подреждане', author: '', year: '', price: 5, fund_qty: 1 }]
}, o);
const REPORT = (o) => Object.assign({
  year: YEAR, part1: [ACQ_ROW()], part1Sum: { n: 1, v: 5 }, part3: [],
  stockEnd: { n: 1, v: 12.34 }, acquiredYear: { n: 1, v: 12.34 }, deaccYear: { n: 0, v: 0 },
  crossIn: { n: 0 }, crossOut: { n: 0 }, undated: {}, byKind: []
}, o);

async function kdbfDom(report) {
  const dom = buildDom({
    'kdbf.report': report, 'acquisitions.get': ACQ_ROW(),
    'settings.get': { org: 'НЧ „Изпитание“', director_role: 'Председател' }
  });
  await settle();
  await dom.window.loadSettingsCache();
  await dom.window.renderKdbf();
  await settle();
  return dom;
}
const viewText = (dom) => dom.window.document.querySelector('#view').textContent.replace(/\s+/g, ' ');

test('партида без първичен документ се печата без висящо „№ /“ в КДБФ Част № 1', async () => {
  /* „без документ — протокол на комисия № /“ се чете като документ с непопълнени
     реквизити — точно обратното на истината: документ няма и затова е съставен
     протокол по чл. 3, ал. 2. */
  const dom = await kdbfDom(REPORT());
  assert.match(viewText(dom), /без документ — протокол на комисия/);
  assert.doesNotMatch(viewText(dom), /протокол на комисия №/, 'на екрана няма знак „№“ без номер');
  dom.window.printKdbfDoc();
  await settle();
  const p = printed(dom.window);
  assert.doesNotMatch(p, /протокол на комисия № \//);
  // Партидата, която ИМА документ, продължава да се чете както досега.
  const dom2 = await kdbfDom(REPORT({
    part1: [ACQ_ROW({ doc_type: 'фактура', doc_no: '0000012345', doc_date: YEAR + '-03-12' })]
  }));
  dom2.window.printKdbfDoc();
  await settle();
  assert.match(printed(dom2.window), new RegExp('фактура № 0000012345 / 12\\.03\\.' + YEAR));
});

test('КДБФ Част № 3 на екрана не брои анулираните актове — както отдавна прави разпечатката', async () => {
  /* Измерено при един анулиран акт от три: екранът показваше „ОБЩО 8 / 28.30 €“,
     а подписаният лист — „7 / 15.80 €“. Актът остава в документацията по чл. 39,
     но отчисляване по него не е имало. */
  const act = (o) => Object.assign({ id: 1, no: 1, year: YEAR, date: YEAR + '-03-01', reason_code: 4,
    reason_text: 'Физически изхабени', item_count: 4, item_value: 12.50, revoked_at: null }, o);
  const dom = await kdbfDom(REPORT({
    part3: [act(), act({ id: 2, no: 2, item_count: 3, item_value: 3.30 }),
      act({ id: 3, no: 3, item_count: 1, item_value: 12.50, revoked_at: YEAR + '-04-01 10:00:00', revoke_reason: 'книгата се намери' })]
  }));
  dom.window.eval("KDBF_TAB = 'p3'");   // `let` в модулния обхват — вижда се само през eval в същия глобален обхват
  await dom.window.renderKdbf();
  await settle();
  const t = viewText(dom);
  assert.match(t, /ОБЩО за 2026 г\. 7 15\.80/, 'сборът брои само действащите актове: ' + t);
  assert.match(t, /АНУЛИРАН на 01\.04\.2026 г\. — книгата се намери/, 'анулираният акт остава видим, с основанието');
  assert.ok(dom.window.document.querySelector('#view tr.revokedRow'), 'и зачертан, както в разпечатката');
});

test('Приложение № 2 на първата година не печата „-0.00 €“', async () => {
  /* Началното салдо се извежда (31.12 − постъпили + отчислени). При първа година
     трите числа са едно и също, а 12.34 − 12.34 в плаваща запетая дава −1.4e-15,
     което mny() форматира като „-0.00 €“ — отрицателна стойност на фонда в
     подписван документ. */
  const dom = await kdbfDom(REPORT());
  dom.window.eval("KDBF_TAB = 'p2'");
  await dom.window.renderKdbf();
  await settle();
  assert.doesNotMatch(viewText(dom), /-0\.00/, 'екранът: ' + viewText(dom));
  dom.window.printKdbfDoc();
  await settle();
  assert.doesNotMatch(printed(dom.window), /-0\.00/);
});

test('актът за дарение подписва с длъжността от Настройки и с двувалутно заглавие на колоната', async () => {
  /* „УТВЪРДИЛ: …“ без длъжност беше останало само в този акт — единственият,
     чийто екземпляр отива при външен човек (дарителя). А колоната „Стойност, €“
     стоеше над клетки „5.00 € / 9.78 лв.“. */
  const dom = buildDom({
    'acquisitions.get': ACQ_ROW({ how: 'дарение', doc_type: 'акт (разписка)', doc_no: 'Д-1', doc_date: YEAR + '-05-06',
      donor_address: 'с. Яворец, ул. Първа 1', sum: 5 }),
    'settings.get': { org: 'НЧ „Изпитание“', director_role: 'Председател' }
  });
  await settle();
  await dom.window.loadSettingsCache();
  await dom.window.printDonationDoc(1);
  await settle();
  const p = printed(dom.window);
  assert.match(p, /УТВЪРДИЛ, Председател: …/);
  assert.match(p, /Стойност, € \/ лв\./, 'заглавието на колоната казва и двете валути');
  assert.doesNotMatch(p, /УТВЪРДИЛ: …/);
});

test('формата за партида без първичен документ не праща номер и дата на документ', async () => {
  /* Полето „Дата на документа“ се предпопълваше с днешната дата БЕЗУСЛОВНО — и
     после регистърът твърдеше, че липсващият документ е от днес. */
  const dom = buildDom({
    'acquisitions.list': [], 'acquisitions.nextNo': 1,
    'settings.get': { org: 'НЧ „Изпитание“', committee1: 'Мария Иванова' },
    'acquisitions.create': 1
  });
  await settle();
  await dom.window.acqForm();
  await settle();
  const doc = dom.window.document;
  doc.querySelector('#acqF [name=how]').value = 'дарение';
  doc.querySelector('#acqF [name=from_source]').value = 'намерени при подреждане';
  doc.querySelector('#acqF [name=total_count]').value = '2';
  doc.querySelector('#acqF [name=donor_address]').value = 'неизвестен';
  const sel = doc.querySelector('#acqF [name=doc_type]');
  sel.value = 'без документ — протокол на комисия';
  dom.window.acqDocTypeChanged(sel);
  assert.equal(doc.querySelector('#acqF [name=doc_date]').value, '', 'датата се изчиства при избора на вида');
  assert.equal(doc.querySelector('#acqF [name=doc_no]').readOnly, true, 'и полетата се заключват');
  await dom.window.saveAcq(null);
  await settle();
  const sent = (dom.calls['acquisitions.create'] || [])[0];
  assert.ok(sent, 'формата изпрати партидата');
  assert.equal(sent.doc_date, '', 'дата на документ не се изпраща');
  assert.equal(sent.doc_no, '', 'нито номер');
});
