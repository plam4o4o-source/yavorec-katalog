'use strict';
/* ВСИЧКИ ДОКУМЕНТИ, КОИТО ПРОГРАМАТА ИЗДАВА — регистър на разпечатките.
 * =====================================================================
 * Другите файлове проверяват ПОТОЦИ (e2e-workflows.test.js) или отделни кръгове
 * поправки (docs-v2454, docs-v2455). Тук въпросът е друг и е само един:
 *
 *     всеки документ, който излиза от принтера, носи ли реквизитите, без които
 *     не е документ?
 *
 * Защото точно това е, което библиотекарят подава на проверяващия, и точно това
 * никой не забелязва, че липсва, докато не му потрябва. Разпечатката се чете
 * КАТО ТЕКСТ (#ppSheet, истинският преглед преди печат) след като пътят до нея е
 * изминат през истинския екран — както го изминава човек.
 *
 * Последният тест е ПАЗАЧ ЗА ПЪЛНОТА: претърсва src/views/*.js за всяка функция,
 * която вика setPrintPage(), и пада, ако някоя не е изброена тук. Без него
 * файлът остарява тихо — нов документ се добавя, никой не сеща да го допише, и
 * регистърът лъже, че всичко е покрито.
 *
 * Обхватът е по Наредба № 3 от 18.11.2014 г.: КДБФ (чл. 13), актът за
 * отчисляване (чл. 35 – 39), актът за дарение (чл. 6, ал. 5), протоколът за
 * придобиване (чл. 3, ал. 2), инвентарната книга (чл. 16, Приложение № 4),
 * протоколът от инвентаризация (чл. 40), дневникът, читателският картон
 * (чл. 47, ал. 2), плюс МЗС, краезнанието, етикетите и готовите справки.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('./helpers/e2e-app');

const VIEWS_DIR = path.join(__dirname, '..', 'src', 'views');

let h;                 // харнесът — едно приложение и една база за целия файл
const T = E.today();
const Y = T.slice(0, 4);
const ids = {};        // каквото един тест създава и следващият ползва

test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);
/* Всеки тест приключва с това: тиха грешка в екранния слой (необработено
   отхвърляне, изключение в рендера) значи, че разпечатката може да е излязла
   наполовина, без нищо на екрана да го каже. */
function noRendererErrors() {
  const errs = h.errors.splice(0);
  assert.equal(errs.length, 0, 'грешки в екранния слой:\n'
    + errs.map(e => (e && (e.stack || e.message)) || String(e)).join('\n---\n'));
}
/* Текстът на листа в прегледа преди печат — точно каквото ще се отпечата. */
function sheet(what) {
  const p = h.printed();
  assert.ok(p && p.trim().length > 0, 'разпечатката „' + what + '“ е празна');
  return p;
}
const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };

/* ==================================================================
   0. Данните, от които се раждат документите
   ================================================================== */
test('0. подготовка: партиди, фонд, читател, заемания, инвентаризация, МЗС, краезнание', async () => {
  const st = ok(await h.api.settings.get(), 'настройки');
  ok(await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека при НЧ „Изпитание – 1922“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова'
  })), 'запис на настройките');
  /* Кешът на екрана се презарежда, както прави самият екран „Настройки“ след
     запис: shead() рисува заглавната част на ВСЕКИ документ от него. */
  await h.window.loadSettingsCache();

  // Партида с фактура (чл. 14) + три документа по нея.
  ids.acq = ok(await h.api.acquisitions.create({
    no: 1, date: Y + '-03-14', how: 'закупуване', from_source: 'Книжарница „Хеликон“ ЕООД',
    doc_type: 'фактура', doc_no: '0000012345', doc_date: Y + '-03-12', total_count: 3, sum: '75.50'
  }), 'партида с фактура');
  const mk = async (inv, title, price, extra) => {
    const d = ok(await h.api.books.create(Object.assign({
      inv_number: inv, title, author: 'Авторов, А.', register_date: Y + '-03-14', price,
      acquisition_id: ids.acq, department: 'Заемна', status: 'наличен', year: 2020,
      publisher: 'Изд. Проба', city: 'София', udk: '886.7-31', author_mark: 'А 22'
    }, extra || {})), 'документ инв. № ' + inv);
    return d && d.id != null ? d.id : d;
  };
  ids.b1 = await mk(1000, 'Под игото', 30);
  ids.b2 = await mk(1001, 'Немили-недраги', 25.5);
  ids.b3 = await mk(1002, 'Чичовци', 20);
  ids.b4 = await mk(1003, 'Записки по българските въстания', 12, { acquisition_id: null });

  // Дарение (чл. 6, ал. 5) и придобиване без първичен документ (чл. 3, ал. 2).
  const committee = { committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Елена Георгиева' };
  ids.acqDon = ok(await h.api.acquisitions.create(Object.assign({
    no: 2, date: Y + '-04-02', how: 'дарение', from_source: 'Стефан Дарителов',
    donor_address: 'гр. Габрово, ул. „Априловска“ 12', doc_type: 'договор за дарение',
    doc_no: '3', doc_date: Y + '-04-01', total_count: 1, sum: '12'
  }, committee)), 'партида-дарение');
  ids.acqNoDoc = ok(await h.api.acquisitions.create(Object.assign({
    no: 3, date: Y + '-05-06', how: 'дарение', from_source: 'анонимен дарител',
    doc_type: 'без документ', total_count: 1
  }, committee)), 'партида без документ');

  // Читател + две заемания: едно просрочено (за писмата), едно текущо (за разписката).
  ids.reader = ok(await h.api.readers.create({
    name: 'Иван Читателов', card_no: '0042', category: 'възрастен', address: 'с. Яворец, ул. „Първа“ 5',
    phone: '0888123456', birth_date: '1980-05-05', gdpr_consent: 1, registered_at: Y + '-01-15', status: 'активен'
  }), 'читател');
  ok(await h.api.loans.checkout({ reader_id: ids.reader, book_id: ids.b3, date_out: Y + '-01-20', date_due: Y + '-02-03' }), 'просрочено заемане');
  ok(await h.api.loans.checkout({ reader_id: ids.reader, book_id: ids.b4, date_out: T }), 'текущо заемане');
  ok(await h.api.account.charge({ reader_id: ids.reader, type: 'годишна такса', amount: 5, note: 'за ' + Y + ' г.' }), 'начисление');

  // Инвентаризация по чл. 40: започване → сканиране → приключване.
  const sess = ok(await h.api.inventorySessions.start(Object.assign({
    date: T, no: 1, order_no: '7', scope: 'целият фонд', department: ''
  }, committee)), 'инвентаризация');
  ids.sess = sess && sess.id != null ? sess.id : sess;
  await h.api.inventorySessions.scan({ sessionId: ids.sess, code: '1000' });
  await h.api.inventorySessions.scan({ sessionId: ids.sess, code: '1001' });
  ok(await h.api.inventorySessions.close({ sessionId: ids.sess, mode: 'representative' }), 'приключване на инвентаризацията');

  // МЗС в двете посоки — изходящата е НАША бланка, входящата е чужд документ.
  ok(await h.api.mzs.create({ no: 1, date: Y + '-02-10', direction: 'изходящо', partner: 'РБ „Априлов – Палаузов“ Габрово',
    author: 'Вазов, Иван', title: 'Пълни съчинения, т. 3', requester: 'Иван Читателов', status: 'заявено', due_date: Y + '-03-10' }), 'МЗС изходяща');
  ok(await h.api.mzs.create({ no: 2, date: Y + '-02-12', direction: 'входящо', partner: 'НЧ „Съгласие“ Севлиево',
    title: 'Под игото', status: 'изпратено', due_date: Y + '-03-12' }), 'МЗС входяща');

  // Краезнание и дневник.
  ok(await h.api.analytics.create({ title: 'Яворец през Възраждането', author: 'Краеведов, К.', source_kind: 'друго',
    source_text: 'сп. „Родознание“, кн. 4', year: Y, pages: '12–19', is_local: 1, keywords: 'Яворец; история' }), 'аналитично описание');
  ok(await h.api.chronicle.create({ year: Y, date: Y + '-05-24', title: 'Празник на читалището',
    body: 'Тържествен концерт.', category: 'читалище' }), 'летопис');
  ok(await h.api.persons.create({ name: 'Петко Учителов', birth_date: '1890-03-01',
    activity: 'учител, основател на читалището', bio: 'Роден в Яворец.' }), 'персоналия');
  ok(await h.api.dnevnik.saveDay({ date: T, a_hours: 480, a_age_o28: 3, a_sex_women: 2, a_sex_men: 1,
    a_edu_sec: 3, b_hours: 480, b_type_books: 5 }), 'ден в дневника');

  // Акт за отчисляване по чл. 30, т. 6.
  ids.act = ok(await h.api.deaccessionActs.create({
    act: Object.assign({ no: 1, date: Y + '-06-20', order_no: '12', reason_code: 6,
      reason_text: 'констатирани като липсващи при инвентаризация',
      disposal: 'предадени за вторични суровини', attach: 'протокол от инвентаризация' }, committee),
    bookIds: [ids.b1]
  }), 'акт за отчисляване');
  noRendererErrors();
});

/* ==================================================================
   1. Регистрите по Наредба № 3
   ================================================================== */
test('1. КДБФ — трите части, с първичния документ и начина на разпореждане', async () => {
  await h.go('kdbf');
  await h.clickButton('Печат / PDF', '#view');
  const p = sheet('КДБФ');
  for (const part of ['Част № 1', 'Част № 2', 'Част № 3']) assert.ok(p.includes(part), 'липсва ' + part);
  assert.ok(p.includes('фактура'), 'Част № 1 не назовава вида на първичния документ');
  assert.ok(p.includes('0000012345'), 'Част № 1 не носи номера на фактурата');
  assert.ok(p.includes('предадени за вторични суровини'), 'Част № 3 не носи начина на разпореждане (чл. 36)');
  assert.ok(p.includes('Изпитание – 1922'), 'заглавната част не носи името на библиотеката');
  noRendererErrors();
});

test('2. Инвентарна книга (Приложение № 4 към чл. 16, ал. 1)', async () => {
  await h.go('invbook');
  await h.clickButton('Печат на инвентарната книга / PDF', '#view');
  await h.clickButton('Цялата книга', '#modal');
  const p = sheet('инвентарна книга');
  assert.match(p, /ИНВЕНТАРНА/, 'не е озаглавена');
  assert.ok(p.includes('Приложение № 4'), 'не се позовава на Приложение № 4');
  for (const inv of ['1000', '1003']) assert.ok(p.includes(inv), 'липсва инв. № ' + inv);
  assert.ok(p.includes('Записки по българските'), 'липсва заглавие');
  assert.ok(p.includes('Авторов'), 'липсва автор');
  noRendererErrors();
});

test('3. Дневник на библиотеката — раздел А и раздел Б', async () => {
  await h.go('dnevnik');
  await h.clickButton('Печат / PDF', '#view');
  const a = sheet('дневник А');
  assert.ok(a.includes('РЕГИСТРИРАНЕ НА ЧИТАТЕЛИТЕ'), 'раздел А не е озаглавен');
  assert.ok(a.includes('8:00'), 'часовете (480 мин.) не излизат като 8:00');
  noRendererErrors();

  await h.clickButton('Раздел Б', '#view');
  await h.clickButton('Печат / PDF', '#view');
  const b = sheet('дневник Б');
  assert.ok(b.includes('ЗАЕТИТЕ КНИГИ'), 'раздел Б не е озаглавен');
  noRendererErrors();
});

/* ==================================================================
   2. Придобиване (чл. 3, чл. 6) и отчисляване (чл. 35 – 39)
   ================================================================== */
test('4. Акт за дарение — дарителят и адресът му (чл. 6, ал. 5)', async () => {
  await h.go('acq');
  await openAcq(ids.acqDon, 'Акт за дарение / PDF');
  await h.clickButton('Акт за дарение / PDF', '#modal');
  const p = sheet('акт за дарение');
  assert.match(p, /дарение/i, 'не е озаглавен като акт за дарение');
  assert.ok(p.includes('Стефан Дарителов'), 'не назовава дарителя');
  assert.ok(p.includes('Априловска'), 'липсва адресът на дарителя — задължителен по чл. 6, ал. 5');
  assert.ok(p.includes('Мария Иванова'), 'липсва комисията');
  noRendererErrors();
});

test('5. Протокол за придобиване без първичен документ (чл. 3, ал. 2)', async () => {
  await h.go('acq');
  await openAcq(ids.acqNoDoc, 'Протокол за придобиване / PDF');
  await h.clickButton('Протокол за придобиване / PDF', '#modal');
  const p = sheet('протокол за придобиване');
  assert.match(p, /ПРОТОКОЛ/, 'не е озаглавен');
  assert.ok(p.includes('чл. 3'), 'не се позовава на чл. 3, ал. 2');
  assert.ok(p.includes('анонимен дарител'), 'не назовава източника');
  assert.ok(p.includes('Петър Петров'), 'липсва комисията');
  noRendererErrors();
});

test('6. Акт за отчисляване — списъкът по чл. 35, ал. 2, комисията и разпореждането', async () => {
  await h.go('acts');
  await h.clickButton('Отвори', '#view');
  await h.clickButton('Печат на акта / PDF', '#modal');
  const p = sheet('акт за отчисляване');
  assert.match(p, /АКТ/, 'не е озаглавен като АКТ');
  assert.ok(p.includes('1000'), 'липсва инв. № на отчисления документ');
  assert.ok(p.includes('Под игото'), 'липсва заглавието му');
  assert.ok(p.includes('Мария Иванова'), 'липсва комисията (чл. 35, ал. 1)');
  assert.ok(p.includes('т. 6'), 'липсва причината по чл. 30, т. 6');
  assert.ok(p.includes('вторични суровини'), 'липсва начинът на разпореждане (чл. 36)');
  assert.ok(p.includes('Председател'), 'липсва редът за утвърждаване от ръководителя');
  assert.ok(!p.includes('1001'), 'в акта е попаднал документ, който не е в него');
  noRendererErrors();
});

test('7. Анулиран акт — разпечатва се с „АНУЛИРАН“ и основанието (чл. 39)', async () => {
  ok(await h.api.deaccessionActs.revoke(ids.act, { reason: 'сгрешен инвентарен номер', by: 'Мария Иванова' }), 'анулиране');
  await h.go('acts');
  await h.clickButton('Отвори', '#view');
  await h.clickButton('Печат на акта / PDF', '#modal');
  const p = sheet('анулиран акт');
  assert.ok(p.includes('АНУЛИРАН'), 'разпечатката не казва, че актът е анулиран');
  assert.ok(p.includes('сгрешен инвентарен номер'), 'липсва основанието за анулиране');
  assert.ok(p.includes('1000'), 'снимката по чл. 35, ал. 2 трябва да остане и в анулирания акт');
  noRendererErrors();
});

test('8. Протокол от инвентаризация (чл. 40)', async () => {
  await h.go('invent');
  await h.clickButton('Протокол', '#view');
  const p = sheet('протокол от инвентаризация');
  assert.match(p, /ПРОТОКОЛ/, 'не е озаглавен');
  assert.match(p, /инвентаризация/i, 'не казва, че е от инвентаризация');
  assert.ok(p.includes('№ 1'), 'липсва номерът на протокола');
  assert.ok(p.includes('Мария Иванова'), 'липсва комисията/библиотекарят');
  noRendererErrors();
});

/* ==================================================================
   3. Обслужване на читателя
   ================================================================== */
test('9. Разписка за заемане', async () => {
  await h.go('circ');
  await h.window.printLoanSlip({
    title: 'Записки по българските въстания', inv_number: '1003',
    date_due: Y + '-12-31', reader_name: 'Иван Читателов', reader_card: '0042'
  });
  await h.settle();
  const p = sheet('разписка');
  assert.match(p, /РАЗПИСКА/, 'не е озаглавена');
  assert.ok(p.includes('Иван Читателов'), 'липсва читателят');
  assert.ok(p.includes('0042'), 'липсва номерът на картата');
  assert.ok(p.includes('1003'), 'липсва инв. №');
  assert.ok(p.includes('Записки'), 'липсва заглавието');
  noRendererErrors();
});

test('10. Квитанция от читателската сметка — сумата в евро и в левове', async () => {
  await h.go('readers');
  await h.clickButton('Сметка', '#view');
  await h.clickButton('Квитанция', '#modal');
  const p = sheet('квитанция');
  assert.match(p, /КВИТАНЦИЯ/, 'не е озаглавена');
  assert.ok(p.includes('Иван Читателов'), 'липсва читателят');
  assert.ok(p.includes('годишна такса'), 'липсва видът на начислението');
  assert.ok(p.includes('5.00 €'), 'липсва сумата в евро');
  assert.ok(p.includes('лв.'), 'липсва двойното обозначение в левове');
  noRendererErrors();
});

test('11. Читателски картон — декларацията над подписа (чл. 47, ал. 2 и ОРЗД)', async () => {
  await h.go('readers');
  await h.clickButton('Картон', '#view');
  const p = sheet('читателски картон');
  assert.ok(p.includes('Иван Читателов'), 'липсва името');
  assert.ok(p.includes('0042'), 'липсва номерът на картата');
  assert.ok(p.includes('ДЕКЛАРАЦИЯ'), 'липсва декларацията на читателя');
  assert.ok(p.includes('2016/679'), 'декларацията не се позовава на Регламент (ЕС) 2016/679');
  assert.match(p, /Подпис/, 'липсва мястото за подпис — хартията с подписа е доказателството');
  noRendererErrors();
});

test('12. Читателска карта — за един читател и за всички', async () => {
  await h.go('readers');
  await h.clickButton('Читателска карта', '#view');
  const one = sheet('читателска карта');
  assert.ok(one.includes('Иван Читателов') && one.includes('0042'), 'картата не носи име и номер');
  noRendererErrors();

  await h.go('labels');
  await h.window.printCardsAll();
  await h.settle();
  const all = sheet('карти за всички');
  assert.ok(all.includes('Иван Читателов'), 'в листа с карти липсва читателят');
  noRendererErrors();
});

test('13. Напомнителни писма — вписват се в регистъра чак при ПОТВЪРДЕН печат', async () => {
  await h.go('over');
  await h.clickButton('Печат на напомняния / PDF', '#view');
  const p = sheet('напомнителни писма');
  assert.ok(p.includes('Иван Читателов'), 'липсва адресатът');
  assert.ok(p.includes('Първа'), 'липсва адресът за изпращане');
  assert.ok(p.includes('Чичовци'), 'липсва просроченото заглавие');
  assert.ok(p.includes('1002'), 'липсва инв. № на просроченото');
  /* Отвореният преглед НЕ е изпратено напомняне: „Отказ“ е равноправен изход и
     дотук вписването ставаше при отварянето — следващото напомняне тръгваше от
     грешна степен, без библиотекарят да е изпратил нищо (v2.2.0). */
  assert.equal(q("SELECT COUNT(*) AS n FROM notice_log WHERE channel = 'печат'").n, 0,
    'само отварянето на прегледа вписа напомняне');
  await h.clickButton('Печат…', '#printPreview');
  await h.sleep(400);   // ppPrint() освобождава DOM-а на прегледа отложено
  const row = q("SELECT COUNT(*) AS n, MAX(loans_count) AS lc FROM notice_log WHERE channel = 'печат'");
  assert.equal(row.n, 1, 'потвърденият печат не вписа точно едно напомняне');
  assert.equal(row.lc, 1, 'вписаното напомняне не носи броя просрочени заемания');
  noRendererErrors();
});

/* ==================================================================
   4. МЗС, краезнание, етикети, справки
   ================================================================== */
test('14. МЗС — изходящата е наша бланка, входящата е извлечение от регистъра', async () => {
  await h.go('mzs');
  const rows = h.window._MZS_ROWS || [];
  const out = rows.find(r => r.direction === 'изходящо');
  const inc = rows.find(r => r.direction === 'входящо');
  assert.ok(out && inc, 'двете заявки не са в списъка');

  h.window.printMzsDoc(out.id);
  await h.settle();
  const po = sheet('МЗС изходяща');
  assert.ok(po.includes('ЗАЯВКА ЗА МЕЖДУБИБЛИОТЕЧНО ЗАЕМАНЕ'), 'не е озаглавена');
  assert.ok(po.includes('Априлов'), 'липсва партньорът');
  assert.ok(po.includes('Пълни съчинения'), 'липсва търсеният документ');
  assert.ok(po.includes('Иван Читателов'), 'липсва заявителят');
  noRendererErrors();

  h.window.printMzsDoc(inc.id);
  await h.settle();
  const pi = sheet('МЗС входяща');
  assert.ok(pi.includes('ВХОДЯЩА ЗАЯВКА'), 'входящата не е озаглавена като входяща');
  assert.ok(pi.includes('извлечение от регистъра'),
    'входящата заявка е ЧУЖД документ — не бива да се печата като наша бланка');
  assert.ok(pi.includes('Съгласие'), 'липсва партньорът');
  noRendererErrors();
});

test('15. Краезнание — аналитично описание, летопис, персоналии', async () => {
  await h.go('analytics');
  await h.clickButton('Печат / PDF', '#view');
  const a = sheet('аналитично описание');
  assert.ok(a.includes('Яворец през Възраждането'), 'липсва статията');
  assert.ok(a.includes('Краеведов'), 'липсва авторът');
  assert.ok(a.includes('Родознание'), 'липсва източникът');
  noRendererErrors();

  await h.go('chronicle');
  await h.clickButton('Печат / PDF', '#view');
  const c = sheet('летопис');
  assert.ok(c.includes('Празник на читалището'), 'липсва събитието');
  assert.ok(c.includes('Тържествен концерт'), 'липсва описанието');
  noRendererErrors();

  await h.go('persons');
  await h.clickButton('Печат / PDF', '#view');
  const pr = sheet('персоналии');
  assert.ok(pr.includes('Петко Учителов'), 'липсва името');
  assert.ok(pr.includes('основател на читалището'), 'липсва дейността');
  noRendererErrors();
});

test('16. Етикети — фонд (всички и по диапазон) и сигнатурни; отчисленият не получава етикет', async () => {
  /* Актът от тест 6 е анулиран в тест 7, тоест инв. № 1000 се е ВЪРНАЛ във фонда
     и пак му се полага етикет. За проверката трябва документ, който наистина е
     извън фонда сега — затова тук се съставя втори акт, за инв. № 1002. */
  ok(await h.api.deaccessionActs.create({
    act: {
      no: 2, date: Y + '-07-01', reason_code: 4, reason_text: 'физически изхабени',
      disposal: 'унищожени', committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Елена Георгиева'
    },
    bookIds: [ids.b3]
  }), 'акт № 2 за инв. № 1002');

  await h.go('labels');
  await h.window.printLabelsAll();
  await h.settle();
  const all = sheet('етикети за фонда');
  assert.ok(all.includes('1000') && all.includes('1001') && all.includes('1003'), 'липсват инвентарни номера');
  /* Отчисленият документ излиза от фонда навсякъде, включително от етикетите
     (v2.4.58) — залепен етикет на книга, която вече не е на рафта, е грешка,
     която после никой не свързва с отчисляването. И обратното: инв. № 1000 е
     отчислен и АНУЛИРАН, значи пак е във фонда и пак получава етикет. */
  assert.ok(!all.includes('1002'), 'отчисленият инв. № 1002 получи етикет');
  noRendererErrors();

  h.$('[name=lblFrom]').value = '1001';
  h.$('[name=lblTo]').value = '1002';
  await h.window.printLabelsRange();
  await h.settle();
  const range = sheet('етикети по диапазон');
  assert.ok(range.includes('1001'), 'диапазонът не съдържа началото си');
  assert.ok(!range.includes('1002'), 'отчисленият 1002 влезе в диапазона');
  assert.ok(!range.includes('1003'), 'в диапазона е попаднал номер извън него');
  noRendererErrors();

  await h.window.printSignatureLabelsAll();
  await h.settle();
  const sig = sheet('сигнатурни етикети');
  assert.ok(sig.includes('А 22'), 'липсва авторският знак');
  assert.ok(sig.includes('886.7'), 'липсва УДК');
  noRendererErrors();

  h.$('[name=sigFrom]').value = '1001';
  h.$('[name=sigTo]').value = '1002';
  await h.window.printSignatureLabelsRange();
  await h.settle();
  const sigRange = sheet('сигнатурни етикети по диапазон');
  assert.ok(!sigRange.includes('1003'), 'в сигнатурния диапазон е попаднал номер извън него');
  noRendererErrors();
});

test('17. Готовите справки — всяка от каталога има форма за печат, не празна бланка', async () => {
  const catalog = ok(await h.api.reports.list(), 'каталогът на справките');
  assert.ok(catalog.length >= 6, 'каталогът е по-малък от очакваното: ' + catalog.length);
  await h.go('reports');
  for (const def of catalog) {
    const sel = h.$('#repSel');
    sel.value = def.id;
    h.fire(sel, 'change');
    await h.waitFor(() => h.window._REPORT && h.window._REPORT.id === def.id, 'справката ' + def.id);
    const before = h.toasts.length;
    await h.clickButton('Печат / PDF', '#view');
    /* Празен подписан формуляр е по-опасен от липсваща разпечатка: справка без
       готова форма ТРЯБВА да откаже с обяснение, а не да отпечата бланка. */
    const refused = h.toastsSince(before).find(t => /няма готова форма/.test(String(t.msg || '')));
    assert.ok(!refused, 'справката „' + def.id + '“ няма форма за печат');
    const p = sheet('справка ' + def.id);
    assert.ok(p.includes(def.title.split(' — ')[0].slice(0, 20)),
      'разпечатката на „' + def.id + '“ не носи заглавието си');
    assert.ok(p.includes(Y), 'разпечатката на „' + def.id + '“ не носи годината');
    noRendererErrors();
  }
});

/* ==================================================================
   5. ПАЗАЧ ЗА ПЪЛНОТА
   ================================================================== */
test('18. всяка печатна функция в src/views/ е покрита от този файл', () => {
  /* Регистърът лъже в мига, в който някой добави нов документ и не го допише
     тук. Затова списъкът не се поддържа на ръка: изходният код се претърсва за
     всяка функция, която вика setPrintPage() — тя е входът към прегледа преди
     печат, тоест към хартията. Нова такава функция пада този тест, докато не
     бъде или покрита, или изрично обяснена по-долу. */
  const covered = new Set([
    'printKdbfDoc',                 // 1
    'printInvBookDoc',              // 2
    'printDnevnikDoc',              // 3
    'printDonationDoc',             // 4
    'printAcqNoDocDoc',             // 5
    'printActDoc',                  // 6, 7
    'printInventProtocol',          // 8
    'printLoanSlip',                // 9
    'printReceiptLine',             // 10
    'printReaderCard',              // 11
    'printCardOne', 'printCardsAll',// 12
    'printOverdueNotices',          // 13
    'printMzsDoc',                  // 14
    'printAnalytics', 'printChronicle', 'printPersons', // 15
    'printLabelsAll', 'printLabelsRange',
    'printSignatureLabelsAll', 'printSignatureLabelsRange', // 16
    'printReportDoc'                // 17
  ]);
  /* printLabelSheet е общият двигател за всички етикети и карти — стига се до него
     само през шестте обвивки по-горе, затова се проверява през тях, не поотделно. */
  const viaOthers = new Set(['printLabelSheet']);

  /* Признакът е повикване на doPrint() или printLabelSheet() — те са входът към
     прегледа преди печат, тоест към хартията. Обхватът е конвенцията на проекта:
     всеки документ се издава от функция на име printXxx. Така вътрешната
     инфраструктура на core.js (doPrint, ppPrint, ppConfirmed…) остава настрана,
     без да се поддържа списък с изключения, който сам би отслабил пазача. */
  const found = [];
  for (const file of fs.readdirSync(VIEWS_DIR).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');
    const re = /(?:^|\n)(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g;
    const starts = [];
    let m;
    while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
    starts.forEach((f, i) => {
      if (!/^print/.test(f.name)) return;
      const body = src.slice(f.at, i + 1 < starts.length ? starts[i + 1].at : src.length);
      if (/\b(doPrint|printLabelSheet)\s*\(/.test(body)) found.push({ name: f.name, file });
    });
  }
  assert.ok(found.length >= 20, 'претърсването намери подозрително малко печатни функции: ' + found.length);
  const missing = found.filter(f => !covered.has(f.name) && !viaOthers.has(f.name));
  assert.deepEqual(missing.map(f => f.file + ':' + f.name), [],
    'нов документ без проверка в този файл — допишете го или обяснете защо се проверява другаде');
  // И обратната посока: изброен тук, но вече премахнат от кода.
  const names = new Set(found.map(f => f.name));
  const stale = [...covered].filter(n => !names.has(n));
  assert.deepEqual(stale, [], 'изброени тук функции, които вече не съществуват в src/views/');
});

/* Партидата се отваря ПОИМЕННО, по същия път като бутона „Отвори“ на реда
   (onclick="openAcq(id)"). Не по надписа на бутон в прозореца: и партидата с
   договор за дарение, и тази без първичен документ са с начин „дарение“, тоест
   и двете носят „Акт за дарение / PDF“ — търсене по надпис хваща която завърне
   подредбата на списъка. */
async function openAcq(id, expectButton) {
  h.window.openAcq(id);
  await h.waitFor(() => h.modalOpen() && /Партида/.test(h.modal()), 'прозореца на партидата');
  await h.settle();
  const has = Array.from(h.$('#modal').querySelectorAll('button')).some(x => x.textContent.includes(expectButton));
  assert.ok(has, 'партида № ' + id + ' няма бутон „' + expectButton + '“');
}
