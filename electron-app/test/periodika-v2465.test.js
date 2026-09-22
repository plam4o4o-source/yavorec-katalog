'use strict';
/* ПОПРАВКИ ОТ КРЪГ 42 (v2.4.65) — ПЕРИОДИКА И КРАЕЗНАНИЕ.
 * ===========================================================================
 * По един тест на находка. Всеки твърди онова, което библиотекарката ВИЖДА —
 * текста на екрана, реда в базата, числото на разпечатката, — а не вътрешната
 * форма на данните, и всеки пада, ако поправката бъде върната назад:
 *
 *   А11  кардекс над 3 000 броя: търсенето на вписан брой отговаряше
 *        „Показани 0 от 4000 броя“ (таванът RENDER_MAX_ROWS в core.js);
 *   А12  „Труд“, „ТРУД“ и „труд“ получаваха три отделни картона (COLLATE
 *        NOCASE сгъва само латиница), а сборът за годината става цена на
 *        годишния комплект в инвентарната книга по чл. 16;
 *   Б12  печатният абонаментен списък броеше ОТЧИСЛЕН комплект за „инвентиран“,
 *        а съседният екран показваше 0 — това е листът за счетоводството;
 *   Б13  заместващ комплект след отчисляване нямаше път от екрана, макар
 *        обработчикът нарочно да го допуска (v2.4.61, находка 16);
 *   Б14  надписът и бутонът под него броят по две различни бройки;
 *   Б19  указателят показва „Колектив.“ и „бр. 21“, а търсенето по тях даваше 0;
 *   Б20  персоналиите излизаха в двоична, не в българска азбучна подредба, и
 *        трети картон със същото име влизаше без дума;
 *   В5   отказът при дублиран брой пращаше към поле „Забележка“, каквото нямаше.
 *
 * Всичко минава през ИСТИНСКИЯ харнес (bootApp → истинският main.js + истинските
 * екрани в jsdom), както сценариите на областта.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/e2e-app');

let h;
const T = E.today();
const Y = T.slice(0, 4);
const Y1 = String(Number(Y) - 1);
const Y2 = String(Number(Y) - 2);
const ids = {};

const ok = (r, what) => { assert.ok(r && r.ok, what + ': ' + (r && r.error)); return r.data; };
const q = (sql, ...a) => h.db.prepare(sql).get(...a);
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const ACT = (no) => ({
  no, date: T, reason_code: 3, reason_text: 'физически изхабени',
  disposal: 'предадени за вторични суровини',
  committee1: 'Мария Иванова', committee2: 'Петър Петров', committee3: 'Ана Счетоводителка'
});

test.before(async () => {
  h = await E.bootApp();
  await h.waitFor(() => h.view() === 'setup', 'първото пускане отваря Настройки');
  await h.settle();
  const st = (await h.api.settings.get()).data;
  await h.api.settings.update(Object.assign({}, st, {
    org: 'НЧ „Изпитание – 1922“', lib_name: 'Библиотека „Изпитание“', place: 'с. Яворец',
    director: 'Димитър Председателов', director_role: 'Председател', librarian: 'Мария Иванова'
  }));
  await h.window.loadSettingsCache();
});
test.after(() => { if (h) h.stop(); });

async function openKardex(title) {
  await h.go('periodika');
  const tr = Array.from(h.document.querySelectorAll('#view table.ledger tbody tr'))
    .find(x => x.firstElementChild.textContent.trim() === title);
  assert.ok(tr, 'няма ред „' + title + '“ в списъка на периодиката');
  await h.clickButton('Отвори', tr);
  await h.waitFor(() => h.$('#issueF'), 'кардексът на ' + title);
  await h.settle();
}
const volumeRow = (year) => Array.from(h.document.querySelectorAll('#modal fieldset table.ledger tbody tr'))
  .find(x => x.firstElementChild.textContent.trim() === String(year));
async function closeKardex() {
  await h.clickButton('Затвори', '#modal footer');
  await h.settle();
}

/* ================================================================ А12 ==== */
test('А12: „Труд“, „ТРУД“ и „труд“ са ЕДИН картон — проверката за дубликат знае кирилица', async () => {
  ids.trud = ok(await h.api.periodicals.create({ title: 'Труд', freq: 'ежедневно' }), 'първият картон');

  for (const variant of ['ТРУД', 'труд', 'ТрУд', ' Труд ']) {
    const r = await h.api.periodicals.create({ title: variant, freq: 'ежедневно' });
    assert.equal(r.ok, false, '„' + variant + '“ трябва да се откаже като дубликат на „Труд“');
    assert.match(r.error, /вече е заведено в картотеката/,
      'отказът казва кой е заварените запис: ' + r.error);
  }
  // Контрола: латиницата продължава да се отказва (тя работеше и дотук).
  ok(await h.api.periodicals.create({ title: 'Trud' }), 'латиница — друго заглавие');
  assert.equal((await h.api.periodicals.create({ title: 'TRUD' })).ok, false, 'контрола: латиницата се отказва');

  // Вътрешните интервали се свиват — коментарът в обработчика го обещава дословно.
  ok(await h.api.periodicals.create({ title: 'Селски  глас' }), 'два интервала');
  const squeezed = await h.api.periodicals.create({ title: 'Селски глас' });
  assert.equal(squeezed.ok, false, '„Селски глас“ и „Селски  глас“ са едно заглавие');

  // И преименуването не може да направи двойник по кирилица.
  const other = ok(await h.api.periodicals.create({ title: 'Врачанско слово' }), 'друго издание');
  const renamed = await h.api.periodicals.update({ id: other, title: 'ТРУД' });
  assert.equal(renamed.ok, false, 'преименуване в дубликат: ' + JSON.stringify(renamed));

  // Това, което се брани: ЕДИН кардекс, тоест ЕДИН сбор за годината — а той
  // става предложената цена на годишния комплект в инвентарната книга (чл. 16).
  const trudCards = h.db.prepare('SELECT title FROM periodicals').all()
    .filter(x => String(x.title).trim().toLowerCase() === 'труд');
  assert.equal(trudCards.length, 1, 'в картотеката има точно един картон „Труд“, а не три');
});

/* ================================================================ В5 ===== */
test('В5: „Забележка“ на броя има къде да се въведе и излиза на картона', async () => {
  ids.edin = ok(await h.api.periodicals.create({ title: 'Единичен', freq: 'месечно' }), 'издание');
  await openKardex('Единичен');

  const fields = Array.from(h.document.querySelectorAll('#issueF [name]')).map(x => x.name);
  assert.ok(fields.includes('note'),
    'формата за нов брой трябва да има поле „Забележка“ — отказът при дублиран брой праща точно там; '
    + 'полета: ' + fields.join(', '));

  h.type('#issueF [name=issue_no]', '7');
  h.type('#issueF [name=date]', Y + '-07-01');
  h.type('#issueF [name=note]', 'получени два екземпляра');
  await h.clickButton('Добави брой', '#modal');
  await h.settle();

  const row = q('SELECT issue_no, note FROM periodical_issues WHERE periodical_id = ?', ids.edin);
  assert.equal(row.note, 'получени два екземпляра', 'забележката стига до базата, а не се губи във формата');

  // И се вижда там, където досега колоната стоеше празна — на печатния картон.
  await h.clickButton('Печат / PDF на картона', '#modal footer');
  await h.settle();
  const printed = flat(h.printed());
  assert.match(printed, /Забележка/, 'картонът има колона „Забележка“');
  assert.match(printed, /получени два екземпляра/, 'и тя вече може да бъде попълнена');

  // Съветът в отказа при дубликат вече е изпълним.
  const dup = await h.api.periodicalIssues.add({ periodical_id: ids.edin, issue_no: '7', date: Y + '-07-01' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /забележката/, 'отказът продължава да праща към забележката — и тя вече съществува');
  await closeKardex();
});

/* ================================================================ А11 ==== */
test('А11: кардекс с 3 400 броя — търсенето намира най-стария вписан брой', async () => {
  ids.desetiletie = ok(await h.api.periodicals.create({ title: 'Десетилетие', freq: 'ежедневно' }), 'издание');
  const ins = h.db.prepare('INSERT INTO periodical_issues (periodical_id, issue_no, date, price) VALUES (?,?,?,?)');
  h.db.transaction(() => {
    const d0 = new Date('2015-01-01T00:00:00Z');
    for (let i = 0; i < 3400; i++) {
      ins.run(ids.desetiletie, String(i + 1), new Date(d0.getTime() + i * 864e5).toISOString().slice(0, 10), 0.5);
    }
  })();

  await openKardex('Десетилетие');
  h.type('#perIssueYear', 'всички');
  await h.settle();
  /* Без търсене таванът от 3 000 реда важи — и това е нарочно: той е въведен в
     v2.4.64 срещу измерени 1 115 ms подредба и +1 025 МБ памет при 15 000 реда.
     Честният надпис на мястото на „Покажи още“ идва от renderCapHtml (core.js). */
  h.$('#perIssueSearch').value = '';
  h.window.filterIssueRows();
  await h.settle();

  h.type('#perIssueSearch', '01.01.2015');   // датата на най-стария вписан брой
  await h.settle();
  const rows = Array.from(h.document.querySelectorAll('#perIssuesBody tr'));
  const visible = rows.filter(x => x.style.display !== 'none');
  assert.equal(visible.length, 1,
    'търсенето на вписан брой отвъд 3 000-ия ред трябва да го намери, а не да отговори „0 намерени“');
  assert.equal(rows.length, 1, 'рисуват се САМО съвпаденията, а не 3 000 реда, от които едно се вижда');
  assert.equal(flat(visible[0].children[1].textContent), '01.01.2015', 'намереният ред е точно този брой');
  assert.match(flat(h.text('#perIssueCount')), /Показани 1 от 1 брой — всички години/,
    'надписът брои намереното: ' + flat(h.text('#perIssueCount')));

  // Търсене по номер на брой — същият път, само че отвъд тавана.
  h.type('#perIssueSearch', '3400');
  await h.settle();
  assert.equal(h.document.querySelectorAll('#perIssuesBody tr').length, 1, 'намира и по № на брой');
  await closeKardex();
});

/* ================================================================ Б14 ==== */
test('Б14: надписът и бутонът под него броят в ЕДИН И СЪЩ обхват', async () => {
  ids.dnevnik = ok(await h.api.periodicals.create({ title: 'Дневникът', freq: 'ежедневно' }), 'издание');
  const ins = h.db.prepare('INSERT INTO periodical_issues (periodical_id, issue_no, date, price) VALUES (?,?,?,?)');
  h.db.transaction(() => {
    const d0 = new Date(Y1 + '-01-01T00:00:00Z');
    for (let i = 0; i < 365; i++) ins.run(ids.dnevnik, 'г' + (i + 1), new Date(d0.getTime() + i * 864e5).toISOString().slice(0, 10), 0.8);
    for (let i = 1; i <= 40; i++) ins.run(ids.dnevnik, 'п' + i, Y2 + '-02-' + String(i % 28 + 1).padStart(2, '0'), 0.8);
  })();

  await openKardex('Дневникът');
  h.type('#perIssueYear', Y1);
  await h.settle();
  const label1 = flat(h.text('#perIssueCount'));
  const bar1 = flat(h.text('#perIssuesMore'));
  assert.match(label1, new RegExp('Показани 300 от 365 броя — ' + Y1 + ' г\\.'),
    'знаменателят е броят за ИЗБРАНАТА година, не целият кардекс: ' + label1);
  assert.match(bar1, /Покажи още \(65 от общо 365\)/, 'бутонът брои по същата бройка: ' + bar1);
  assert.match(label1, /целият кардекс: 405 броя/,
    'целият кардекс се назовава отделно, за да не изглежда, че броевете са изчезнали');

  await h.clickButton('Покажи още', '#modal');
  await h.settle();
  const label2 = flat(h.text('#perIssueCount'));
  assert.match(label2, new RegExp('Показани 365 от 365 броя — ' + Y1 + ' г\\.'),
    'след последната порция надписът не бива да твърди, че липсват броеве: ' + label2);
  assert.equal(h.document.querySelector('#perIssuesMore button'), null, 'няма какво повече да се показва');
  await closeKardex();
});

/* ================================================================ Б12 ==== */
test('Б12: отчисленият годишен комплект НЕ се брои за инвентиран на абонаментния списък', async () => {
  ids.selski = ok(await h.api.periodicals.create({ title: 'Селски вестник', freq: 'месечно' }), 'издание');
  for (let i = 1; i <= 2; i++) {
    ok(await h.api.periodicalIssues.add({ periodical_id: ids.selski, issue_no: String(i), date: Y + '-0' + i + '-10', price: 3 }), 'брой');
  }
  const reg = ok(await h.api.periodicalVolumes.register({ periodical_id: ids.selski, year: Y }), 'инвентиране');
  const no = ok(await h.api.deaccessionActs.nextNo(Y), 'следващ № на акт');
  ok(await h.api.deaccessionActs.create({ act: ACT(no), bookIds: [reg.book_id] }), 'акт по чл. 35');

  // Екранът вече го знае от v2.4.61 (находка 15) — хартията трябва да казва същото.
  const onScreen = ok(await h.api.periodicals.list(), 'списък').find(x => x.id === ids.selski);
  assert.equal(onScreen.volume_count, 0, 'контрола: екранът не брои отчисления комплект');

  await h.go('periodika');
  h.type('#perPrintYear', Y);
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  const p = flat(h.printed());
  const summary = /(\d+) от (\d+) инвентиран\S*\s\S*/.exec(p);
  assert.ok(summary, 'обобщаващият ред липсва в разпечатката');
  assert.equal(summary[1], '0',
    'подписва се число, което твърди какво има във фонда: ' + summary[0]);
  assert.match(p, /Селски вестник[^]{0,160}ОТЧИСЛЕН/,
    'редът на изданието пак казва кой инв. № е бил и какво е станало с него');
  assert.match(p, /не влизат нито в КДБФ/,
    'предупредителната бележка трябва да проговори точно за такова заглавие');
});

/* ---------------------------------------------------------------- Б12 (втори случай) */
test('Б12: отчисленият годишен комплект САМ вдига предупредителната бележка — без чужда помощ в разпечатката',
  async () => {
    /* Горният случай гледа разпечатка, в която има и ДРУГИ заглавия с получени
       броеве и без нито един инвентиран комплект — а те вдигат бележката сами,
       каквото и да пише в условието ѝ. Тук листът е нарочно самотен: за
       избраната година ЕДИНСТВЕНОТО заглавие с получени броеве е онова, чийто
       комплект е бил вписан и после отчислен с акт по чл. 35. Ако условието на
       бележката пита „има ли изобщо вписан комплект“ вместо „има ли ЖИВ
       комплект“, листът излиза без нито дума — точно за заглавието, заради
       което бележката съществува. */
    const YX = String(Number(Y) - 5);          // най-старата година в падащия списък
    /* За YX броеве има само „Десетилетие“ (от А11). Годишният му комплект се
       вписва и ОСТАВА във фонда — тоест той няма как да вдигне бележката и
       остава единствено отчисленият комплект по-долу. */
    const desetCount = q('SELECT COUNT(*) AS n FROM periodical_issues WHERE periodical_id = ? AND date LIKE ?',
      ids.desetiletie, YX + '%').n;
    assert.ok(desetCount > 0, 'подготовка: „Десетилетие“ има броеве за ' + YX + ' г.');
    ok(await h.api.periodicalVolumes.register({ periodical_id: ids.desetiletie, year: YX }), 'жив годишен комплект');

    const id = ok(await h.api.periodicals.create({ title: 'Самотен вестник', freq: 'месечно' }), 'издание');
    for (let i = 1; i <= 2; i++) {
      ok(await h.api.periodicalIssues.add({
        periodical_id: id, issue_no: String(i), date: YX + '-0' + i + '-08', price: 2
      }), 'брой');
    }
    const reg = ok(await h.api.periodicalVolumes.register({ periodical_id: id, year: YX }), 'инвентиране');
    const no = ok(await h.api.deaccessionActs.nextNo(Y), 'следващ № на акт');
    ok(await h.api.deaccessionActs.create({ act: ACT(no), bookIds: [reg.book_id] }), 'акт по чл. 35');

    await h.go('periodika');
    h.type('#perPrintYear', YX);
    assert.equal(h.$('#perPrintYear').value, YX, 'годината на разпечатката наистина се избира');
    await h.clickButton('Печат / PDF', '#view');
    await h.settle();
    const p = flat(h.printed());

    /* ПОДГОТОВКА, ЗАРАДИ КОЯТО ТЕСТЪТ ЗНАЧИ НЕЩО: на този лист получени броеве
       имат само ДВЕ заглавия — „Десетилетие“ (с жив комплект) и „Самотен
       вестник“ (с отчислен). Сборът го доказва, без да се повтаря условието на
       самата бележка: няма трето заглавие, което да я вдигне вместо него. */
    const total = new RegExp('ОБЩО за ' + YX + ' г\\. (\\d+) ').exec(p);
    assert.ok(total, 'обобщаващият ред липсва в разпечатката: ' + p.slice(0, 400));
    assert.equal(Number(total[1]), desetCount + 2,
      'за ' + YX + ' г. броеве има само по тези две заглавия — иначе бележката би дошла от трето');
    const summary = /(\d+) от (\d+) инвентиран\S*\s\S*/.exec(p);
    assert.ok(summary && summary[1] === '1',
      'жив комплект има точно един — отчисленият не се брои: ' + (summary ? summary[0] : '—'));
    assert.match(p, /Самотен вестник[^]{0,160}ОТЧИСЛЕН/,
      'редът пази кой инв. № е бил и какво е станало с него');
    assert.ok(!/Десетилетие[^]{0,160}ОТЧИСЛЕН/.test(p),
      'а комплектът на „Десетилетие“ си стои във фонда: ' + p.slice(0, 400));

    /* Редът, заради който е всичко. */
    assert.match(p, /Заглавията с получени броеве и без инвентиран годишен комплект/,
      'бележката трябва да я има и когато единственото основание за нея е ОТЧИСЛЕНИЯТ комплект: ' + p.slice(0, 600));
    assert.match(p, /Отчисленият комплект е бил вписан, но вече е изваден от фонда/,
      'и да обясни точно неговия случай');
  });

/* ================================================================ Б13 ==== */
test('Б13: заместващ комплект след отчисляване се вписва от самия екран', async () => {
  ids.chit = ok(await h.api.periodicals.create({ title: 'Читалищен лист', freq: 'месечно' }), 'издание');
  for (let i = 1; i <= 3; i++) {
    ok(await h.api.periodicalIssues.add({ periodical_id: ids.chit, issue_no: String(i), date: Y + '-0' + i + '-12', price: 2 }), 'брой');
  }
  const reg = ok(await h.api.periodicalVolumes.register({ periodical_id: ids.chit, year: Y }), 'инвентиране');
  const no = ok(await h.api.deaccessionActs.nextNo(Y), 'следващ №');
  ok(await h.api.deaccessionActs.create({ act: ACT(no), bookIds: [reg.book_id] }), 'акт');

  await openKardex('Читалищен лист');
  const row = volumeRow(Y);
  assert.match(flat(h.text(row)), /отчислен/, 'редът пази историята');
  const btns = Array.from(row.querySelectorAll('button')).map(b => flat(b.textContent));
  assert.deepEqual(btns, ['Инвентирай годишния комплект'],
    'отчислената година трябва да предлага вписване на заместващ том; бутони: ' + JSON.stringify(btns));
  assert.match(flat(h.text(row)), /заместващ том — предишният е отчислен/,
    'до бутона се казва, че това е заместващ, а не повторно вписване на същия документ');

  // Пътят на библиотекарката: бутонът → формата → „Впиши в инвентарната книга“.
  await h.clickButton('Инвентирай годишния комплект', row);
  await h.waitFor(() => h.$('#volF'), 'формата за инвентиране');
  await h.settle();
  assert.match(flat(h.modal2()), /Вписвате заместващ том/,
    'формата казва какво точно се вписва и какво става с отчисления');
  h.type('#volF [name=price]', '4.00');
  await h.clickButton('Впиши в инвентарната книга', '#modal2 footer');
  await h.settle();

  const vols = h.db.prepare(`SELECT b.inv_number, b.status FROM periodical_volumes v
    JOIN books b ON b.id = v.book_id WHERE v.periodical_id = ? AND v.year = ?`).all(ids.chit, Y);
  assert.equal(vols.length, 1, 'кардексът сочи към СЕГАШНИЯ документ');
  assert.equal(vols[0].status, 'наличен', 'заместващият комплект е във фонда');
  assert.notEqual(vols[0].inv_number, reg.inv_number, 'със свой, нов инвентарен номер');
  assert.equal(q('SELECT status FROM books WHERE id = ?', reg.book_id).status, 'отчислен',
    'отчисленият документ остава в акта по чл. 35 и в КДБФ Част № 3');

  await openKardex('Читалищен лист');
  const after = flat(h.text(volumeRow(Y)));
  assert.match(after, new RegExp('инв\\. № ' + vols[0].inv_number), 'кардексът показва новия номер: ' + after);
  assert.doesNotMatch(after, /отчислен/, 'годината вече е с жив комплект');
  assert.equal(volumeRow(Y).querySelector('button'), null, 'жив комплект не се инвентира втори път');
  await closeKardex();
});

/* ================================================================ Б19 ==== */
test('Б19: указателят на статиите се намира по това, което сам показва', async () => {
  const bid = ok(await h.api.books.create({
    inv_number: 900, register_date: T, title: 'Сборник Яворец',
    author: 'Колектив', price: 10, status: 'наличен'
  }), 'книга-носител');
  ids.vrach = ok(await h.api.periodicals.create({ title: 'Врачанско ехо', freq: 'седмично' }), 'вестник');
  ok(await h.api.analytics.create({
    title: 'Читалището на 100 години', source_kind: 'периодика', periodical_id: ids.vrach,
    issue: '21', issue_date: Y1 + '-05-27', year: Y1, pages: '3', is_local: 1
  }), 'статия от вестник');
  ok(await h.api.analytics.create({
    title: 'Носиите на Яворец', source_kind: 'книга', book_id: bid,
    year: '2010', pages: '45 – 61', is_local: 1, udk: '391'
  }), 'статия от сборник');

  await h.go('analytics');
  const shown = Array.from(h.document.querySelectorAll('#anlBody tr')).map(tr => flat(tr.children[1].textContent));
  assert.ok(shown.some(s => /Колектив/.test(s)), 'колона „Източник“ показва автора на носителя: ' + JSON.stringify(shown));

  const byAuthor = ok(await h.api.analytics.list({ q: 'Колектив' }), 'търсене по автора на носителя');
  assert.equal(byAuthor.length, 1, 'полето обещава търсене по автор — авторът на книгата-носител също е автор');
  assert.equal(flat(byAuthor[0].title), 'Носиите на Яворец');

  const byIssue = ok(await h.api.analytics.list({ q: 'бр. 21' }), 'търсене по броя');
  assert.equal(byIssue.length, 1, '„бр. 21“ е начинът, по който човек пита за конкретен вестник');
  assert.equal(flat(byIssue[0].title), 'Читалището на 100 години');
  assert.equal(ok(await h.api.analytics.list({ q: 'бр 21' }), 'без точка').length, 1, 'и без точката');

  /* Представката се иска с разделител: „брат“ е дума, а не питане за брой „ат“. */
  ok(await h.api.analytics.create({ title: 'Братята Иванови', source_kind: 'друго', source_text: 'спомени', year: '1990' }), 'трета статия');
  const brat = ok(await h.api.analytics.list({ q: 'брат' }), 'дума, започваща с „бр“');
  assert.equal(brat.length, 1, '„брат“ си остава търсене по текста, не по номер на брой');
  assert.equal(flat(brat[0].title), 'Братята Иванови');
});

/* ================================================================ Б20 ==== */
test('Б20: персоналиите излизат по българската азбука и дубликатът не минава мълчешком', async () => {
  const names = ['Янков, Георги', 'Щерев, Петър', 'Ъглев, Иван', 'Иванов, Петър',
    'Йорданов, Асен', 'Вълчев, Стефан', 'Ѝлчев, Марин', 'Ангелов, Тодор'];
  for (const n of names) ok(await h.api.persons.create({ name: n }), 'персоналия ' + n);

  const listed = ok(await h.api.persons.list(''), 'указател').map(x => x.name);
  assert.deepEqual(listed, names.slice().sort((a, b) => a.localeCompare(b, 'bg')),
    'двоичната подредба на SQLite слага „Ѝлчев“ пред „Ангелов“: ' + JSON.stringify(listed));
  assert.ok(listed.indexOf('Ангелов, Тодор') < listed.indexOf('Ѝлчев, Марин'),
    '„Ѝлчев“ не бива да изпреварва „Ангелов“');
  assert.equal(listed[listed.length - 1], 'Янков, Георги', 'Я е последната буква на азбуката');

  // Разпечатката „ПЕРСОНАЛИИ“ излиза в същия ред — тя е указателят на хартия.
  await h.go('persons');
  await h.clickButton('Печат / PDF', '#view');
  await h.settle();
  const paper = flat(h.printed());
  assert.ok(paper.indexOf('Ангелов, Тодор') < paper.indexOf('Ѝлчев, Марин')
    && paper.indexOf('Ѝлчев, Марин') < paper.indexOf('Янков, Георги'),
    'разпечатката е азбучен указател, а не двоичен ред');

  /* Втори картон със същото име: питане с думи ПРЕДИ записа (екранът) и следа в
     дневника (обработчикът). Отказ няма — съименниците в едно село са правило. */
  const before = q('SELECT COUNT(*) AS n FROM persons').n;
  h.hooks.confirmAnswer = false;
  const n0 = h.hooks.confirms.length;
  await h.go('persons');
  await h.clickButton('+ Нова персоналия', '#view');
  await h.waitFor(() => h.$('#prsF'), 'формата');
  h.type('#prsF [name=name]', 'Вълчев, Стефан');
  await h.clickButton('Запиши', '#modal footer');
  await h.settle();
  const asked = h.hooks.confirms.slice(n0).join('\n');
  assert.match(asked, /вече е вписан/, 'екранът пита, преди да заведе втори картон: ' + asked);
  assert.match(asked, /нито една справка за него не излиза пълна/,
    'питането казва каква е ЦЕНАТА на двата картона, не само че името съвпада');
  assert.equal(q('SELECT COUNT(*) AS n FROM persons').n, before, 'при „Отказ“ вторият картон не влиза');

  // При „Да“ (съименник) записът минава, но остава следа с номера на заварените картони.
  h.hooks.confirmAnswer = true;
  await h.clickButton('Запиши', '#modal footer');
  await h.settle();
  assert.equal(q('SELECT COUNT(*) AS n FROM persons').n, before + 1, 'съименникът се вписва — отказ няма');
  const trace = q(`SELECT detail FROM audit_log WHERE action = 'Персоналии'
    AND detail LIKE '%Вълчев%' ORDER BY id DESC`);
  assert.match(trace.detail, /ВНИМАНИЕ: със същото име вече има картон/,
    'дневникът пази, че имената съвпадат: ' + trace.detail);
});
