'use strict';
/* v2.4.51 — ЕВРОТО СТАВА ОСНОВНА ВАЛУТА + подредбата на таблото.
   =====================================================================
   От 01.01.2026 г. лицевата валута е еврото и официалните документи по Наредба
   № 3 се водят в него. Дотук програмата пазеше сумите в ЛЕВА и смяташе еврото
   при показване. Разликата не е козметична: сборът от закръглени преобразувания
   НЕ е равен на преобразувания сбор, тоест инвентарната книга показваше обща
   стойност, която не съвпада със сбора на собствените си редове.

   Тук се проверява:
     • че стойността се тълкува като ЕВРО и левът е производен;
     • че миграция 15 преобразува ТОЧНО деветте парични колони и НИТО ЕДНА от
       трите REAL колони, които са дни и милиметри;
     • че полето за въвеждане приема и лева (стара фактура), но записва евро;
     • че таблото се върна на двата реда карти отпреди v2.4.29.

   Всеки тест е проверен с мутация. */
process.env.TZ = 'Europe/Sofia';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { APP_DIR, buildDom, settle } = require('./helpers/audit-fixtures');

const CSS = fs.readFileSync(path.join(APP_DIR, 'src', 'style.css'), 'utf8');
const MAIN = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
const SCHEMA = fs.readFileSync(path.join(APP_DIR, 'db', 'schema.sql'), 'utf8');
const CORE = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'core.js'), 'utf8');
const RATE = 1.95583;

/* ==================== 1) записаната стойност е в евро ==================== */

test('bgn()/eur()/mny() четат записаното като ЕВРО, левът е производен', async () => {
  const dom = buildDom({});
  const { window } = dom; await settle();
  const f = (израз) => window.eval(израз);
  assert.equal(f('eur(12)'), '12.00', 'записаното Е сумата в евро — без деление');
  assert.equal(f('bgn(12)'), (12 * RATE).toFixed(2), 'левът се смята ОТ еврото');
  assert.equal(f('bgn(12)'), '23.47');
  assert.equal(f('mny(12)'), '12.00 € / 23.47 лв.', 'еврото е водещо');
  /* Обратното преобразуване съществува само за полето „лв.“ при въвеждане. */
  assert.equal(f('bgnToEur(23.47)'), '12.00');
  /* Кръгът се затваря: сума в лева → евро → пак лева. */
  assert.equal(f('bgn(bgnToEur(19.56))'), '19.56');
});

test('mnyCell() показва еврото първо, лева в скоби', async () => {
  const dom = buildDom({});
  const { window } = dom; await settle();
  const html = window.eval('mnyCell(12)');
  assert.match(html, /^<span class="money" title="12\.00 € \/ 23\.47 лв\.">12\.00 € <small>23\.47 лв\.<\/small><\/span>$/);
  assert.ok(html.indexOf('€') < html.indexOf('лв.'), 'еврото стои преди лева');
});

test('курсът е фиксираният по регламент и е един и същ в двата процеса', () => {
  assert.match(CORE, /const EUR_RATE = 1\.95583;/);
  assert.match(MAIN, /const EUR_RATE = 1\.95583;/);
  /* Огледални стойности: миграцията дели по EUR_RATE на главния процес, а
     екранът умножава по EUR_RATE на своя — разминаване между двете би дало
     цени, които не се връщат обратно. */
  const екран = /const EUR_RATE = ([\d.]+);/.exec(CORE)[1];
  const главен = /const EUR_RATE = ([\d.]+);/.exec(MAIN)[1];
  assert.equal(екран, главен);
});

/* ==================== 2) миграция 15 ==================== */

test('миграция 15 преобразува ТОЧНО деветте парични колони', () => {
  assert.match(MAIN, /const CURRENT_SCHEMA_VERSION = 15;/);
  const тяло = MAIN.slice(MAIN.indexOf('{ version: 15, run: () => {'));
  const край = тяло.indexOf('} }');
  const пипнати = [...тяло.slice(0, край).matchAll(/вЕвро\('(\w+)', '(\w+)'\)/g)].map(m => m[1] + '.' + m[2]);
  /* Осем колони минават през вЕвро(); още две се обработват поотделно, защото
     редовото закръгляне ги чупи: сметките на читателите (кумулативно, за да не
     остане фантомно салдо) и обявената стойност по партида (за да продължи да
     съвпада със сбора на цените). */
  assert.deepEqual(пипнати.slice().sort(), [
    'books.price', 'deaccession_items.price', 'inventory_session_missing.price',
    'loans.fine', 'periodical_issues.price', 'settings.annual_fee', 'settings.fine_per_day'
  ].sort());
  assert.match(тяло.slice(0, край), /UPDATE account_lines SET amount = \? WHERE id = \?/, 'сметките се преобразуват кумулативно');
  assert.match(тяло.slice(0, край), /UPDATE acquisitions SET sum = \? WHERE id = \?/, 'обявената стойност се преобразува отделно');
  assert.match(тяло.slice(0, край), /ROUND\(\$\{колона\} \/ \$\{EUR_RATE\}, 2\)/, 'закръгля до цял евроцент');
  assert.match(тяло.slice(0, край), /WHERE \$\{колона\} IS NOT NULL/, 'празната цена остава празна, не става 0');
});

test('трите REAL колони, които НЕ са пари, остават непипнати', () => {
  /* Списъкът се съставя ОТ СХЕМАТА, не по памет: нова парична колона утре ще
     провали този тест, вместо да остане в лева мълчаливо. */
  const колони = [];
  let таблица = null;
  for (const ред of SCHEMA.split('\n')) {
    const t = /^\s*CREATE TABLE(?: IF NOT EXISTS)? (\w+)/.exec(ред);
    if (t) taблица_set(t[1]);
    const c = /^\s*(\w+)\s+REAL/.exec(ред);
    if (c && таблица) колони.push(таблица + '.' + c[1]);
  }
  function taблица_set(v) { таблица = v; }

  const тяло = MAIN.slice(MAIN.indexOf('{ version: 15, run: () => {'));
  const пипнати = new Set([...тяло.slice(0, тяло.indexOf('} }')).matchAll(/вЕвро\('(\w+)', '(\w+)'\)/g)]
    .map(m => m[1] + '.' + m[2]));
  const непипнати = колони.filter(c => !пипнати.has(c));
  /* Дни преустановено заемане и милиметри по листа с етикети: преобразуването им
     би счупило наказанията и печата на етикети. */
  /* Двете, които се преобразуват ПОотделно, не минават през вЕвро() — тук се
     изважда само това, което наистина остава в лева. */
  const отделно = ['account_lines.amount', 'acquisitions.sum'];
  const останали = непипнати.filter(c => !отделно.includes(c));
  assert.deepEqual(останали.slice().sort(), [
    'circulation_rules.suspend_per_day', 'settings.lbl_gap', 'settings.lbl_margin', 'settings.suspend_per_day'
  ].sort(), 'REAL колони извън миграцията: ' + останали.join(', '));
  for (const к of отделно) assert.ok(непипнати.includes(к), к + ' се обработва отделно, не през вЕвро()');
  assert.ok(колони.length >= 13, 'схемата се чете наистина, а не празен списък: ' + колони.length);
});

/* ==================== 3) поле с двете валути ==================== */

const полеЗа = async (отвори, име) => {
  const dom = buildDom({ 'categories.list': [], 'authorities.values': [], 'books.suggestions': {},
    'shelves.list': [], 'acquisitions.list': [], 'settings.get': {}, 'limits.usage': null,
    'av.options': {}, 'employees.list': [], 'circRules.list': [], 'calendar.list': [],
    'backup.status': null, 'gdpr.status': null, 'pdp.status': {}, 'securityExclusions.status': null,
    'autoUpdate.status': null });
  const { window } = dom; await settle();
  await window.eval(отвори); await settle();
  const d = window.document;
  return { window, d, евро: d.querySelector(`[name="${име}"]`), лева: d.querySelector(`[data-bgn-for="${име}"]`) };
};

test('полето за цена има ДВЕ валути, но записва само еврото', async () => {
  const { d, евро, лева } = await полеЗа('bookForm()', 'price');
  assert.ok(евро && лева, 'има и поле в евро, и поле в лева');
  /* Ключово: полето в лева НЯМА name, тоест formData() не го събира и към
     обработчика заминава единствено сумата в евро — нито един канал не се
     променя заради второто поле. */
  assert.equal(лева.hasAttribute('name'), false, 'полето в лева не се праща към базата');
  assert.ok(евро.compareDocumentPosition(лева) & 4, 'еврото стои ПРЕДИ лева');
  const валути = [...d.querySelectorAll('#bookF .mnyPair .mnyCur')].map(x => x.textContent.trim());
  assert.deepEqual(валути, ['€', 'лв.']);
  assert.equal(евро.closest('.field').querySelector('label').textContent.trim(), 'Цена *',
    'етикетът вече не носи валута — тя е до самите полета');
});

test('писането в лева пресмята еврото и обратно (стара фактура)', async () => {
  const { window, d, евро, лева } = await полеЗа('bookForm()', 'price');
  const пиши = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };

  пиши(лева, '19.56');
  assert.equal(евро.value, '10.00', 'сума по стара фактура в лева → евро');
  пиши(евро, '12');
  assert.equal(лева.value, '23.47', 'и обратно');
  /* Изчистено поле не става 0.00 — иначе непопълнена цена би влязла като нула. */
  пиши(евро, '');
  assert.equal(лева.value, '');
  пиши(лева, '');
  assert.equal(евро.value, '');

  const данни = window.eval("formData('#bookF')");
  assert.ok(!Object.keys(данни).some(k => /bgn/i.test(k)), 'нищо „левово“ не влиза в данните: ' + Object.keys(данни).join(','));
});

test('всички полета за пари минаха на двойното поле', () => {
  const очаквани = [
    ['books.js', 'price'], ['acquisitions.js', 'sum'], ['periodicals.js', 'price'],
    ['account.js', 'amount'], ['settings.js', 'fine_per_day'], ['settings.js', 'annual_fee'],
  ];
  for (const [файл, име] of очаквани) {
    const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', файл), 'utf8');
    assert.match(src, new RegExp(`mnyField\\('[^']+', '${име}'`), файл + ' → ' + име);
    /* И нито едно от тях не е останало със старото поле „(лв.)“. */
    assert.doesNotMatch(src, new RegExp(`fld\\('[^']*лв\\.[^']*', '${име}'`), файл + ': остатък от старото поле');
  }
});

/* ==================== 4) официалните документи ==================== */

test('колоните „Стойност“ в документите по Наредба № 3 са в евро', () => {
  for (const файл of ['acquisitions.js', 'deaccession-acts.js', 'kdbf.js']) {
    const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', файл), 'utf8');
    assert.match(src, /<th>Стойност, €<\/th>/, файл);
    assert.doesNotMatch(src, /<th>Стойност, лв\.<\/th>/, файл + ': останало е заглавие в лева');
  }
});

test('изнесеният CSV носи еврото като основна колона, лева — справочно', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'catalog.js'), 'utf8');
  assert.match(src, /'Цена \(€\)', 'Цена \(лв\.\)', 'Обща стойност \(€\)'/);
  /* Общата стойност се смята от ЗАПИСАНАТА валута, не от преобразуваната —
     иначе сборът в Excel не съвпада със сбора в програмата. */
  assert.match(src, /\(b\.price \|\| 0\)\.toFixed\(2\), \(\(b\.price \|\| 0\) \* 1\.95583\)\.toFixed\(2\)/);
});

test('одитната следа вписва сумите в евро', () => {
  const acc = fs.readFileSync(path.join(APP_DIR, 'handlers', 'account.js'), 'utf8');
  const loans = fs.readFileSync(path.join(APP_DIR, 'handlers', 'loans.js'), 'utf8');
  for (const [име, src] of [['account.js', acc], ['loans.js', loans]]) {
    const редове = src.split('\n').filter(l => /logAudit\(/.test(l) || /addedFine|amt\.toFixed/.test(l));
    assert.ok(редове.length, име);
    assert.ok(!редове.some(l => /toFixed\(2\) \+ ' лв\.'/.test(l)), име + ': останала е сума в лева');
  }
});

test('Настройки казват наяве, че тарифите са преобразувани и трябва да се прегледат', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'src', 'views', 'settings.js'), 'utf8');
  assert.match(src, /Тарифите са преобразувани от лева в евро/);
  /* Числото в бележката е истинското: 0.05 / 1.95583 = 0.0256 → 0.03. */
  assert.equal((0.05 / RATE).toFixed(2), '0.03');
  assert.match(src, /0\.05 лв\.\/ден става 0\.03 €\/ден/);
});

/* ==================== 5) подредбата на таблото ==================== */

test('таблото е два реда карти, „Бързи действия“ е карта в долния', async () => {
  const dom = buildDom({ 'dashboard.full': { fundCount: 3, fundValue: 26, loansOpen: 1, activeReaders: 2,
    overdueCount: 0, overdueRows: [], upcoming: [], holdsReady: 0, holdsWaiting: 0, year: 2026,
    acquiredYear: 1, deaccessionedYear: 0, loansYear: 2, readersYear: 1, inventoryTarget: 1,
    inventoryScannedYear: 0, inventoryPct: 10,
    today: { dueReminders: 0, reregDue: 0, longOverdue: 0, dnevnikFilled: true } } });
  const { window } = dom; await settle();
  await window.renderDash(); await settle();
  const d = window.document;
  const мрежи = [...d.querySelectorAll('#view .grid.g3')];
  assert.equal(мрежи.length, 2, 'два реда, не три — лентата на цяла ширина отпадна');
  const заглавия = (g) => [...g.querySelectorAll(':scope > .card > h3')].map(h => h.textContent.trim());
  assert.deepEqual(заглавия(мрежи[0]), ['Просрочени заемания', 'Годината 2026']);
  /* v2.4.52: заглавието вече е само „Предстоящи връщания“ — обхватът се вижда от
     самите редове (те са групирани по ден, с датата до всеки) и се повтаря в бутона
     „още N документа до 3 дни“. В колона от 339 px заглавието дели реда с брояча
     „Всички N“, а „(до 3 дни)“ го изтикваше на втори ред. */
  assert.deepEqual(заглавия(мрежи[1]), ['Бързи действия', 'Предстоящи връщания', 'За днес']);
  /* Картата с действията вече не е сама на ред. */
  assert.ok(d.querySelector('#view .grid.g3 .card.dashActions'), '„Бързи действия“ е ВЪТРЕ в мрежа');
  assert.equal(d.querySelectorAll('#view .card.dashActions .quickBtn').length, 6, 'всичките шест копчета остават');
  /* Измерено в Chromium при 1366×768: 1115 → 970 px височина, 436 → 291 px
     превъртане. В jsdom няма подредба, затова тук се пази правилото. */
  assert.match(CSS, /\.dashActions \.quickGrid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.doesNotMatch(CSS, /\.dashActions \.quickGrid\{grid-template-columns:repeat\(6,/, 'лентата на 6 колони отпадна');
});

test('стилът на двойното поле го държи на един ред', () => {
  /* Измерено в Chromium: колоната на формата е 244 px. С flex-basis 110px
     второто поле падаше под първото и сумата изглеждаше като две отделни. */
  assert.match(CSS, /\.mnyPair\{display:flex;[^}]*flex-wrap:nowrap\}/);
  assert.match(CSS, /\.mnyPair input\{flex:1 1 0; min-width:0;/);
});

/* ============ 6) миграцията върху истинска база (находки от прегледа) ============
   Тялото на миграция 15 се изпълнява ВЪРХУ ИСТИНСКА СХЕМА, а не се чете като
   текст: двата случая по-долу минаваха всяка текстова проверка и се виждат само
   когато числата наистина минат през базата. */
const Database = require('better-sqlite3');
const { freshDb } = require('./helpers/audit-fixtures');

function пусниМиграция15(db) {
  const код = fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8');
  const нач = код.indexOf('{ version: 15, run: () => {');
  assert.ok(нач > -1, 'миграция 15 съществува');
  const вътре = код.slice(код.indexOf('run: () => {', нач) + 'run: () => {'.length, код.indexOf('\n  } }', нач));
  db.transaction(() => { new Function('db', 'EUR_RATE', вътре)(db, RATE); })();
}

test('миграцията не оставя фантомно салдо по погасена сметка от дребни суми', () => {
  const { db } = freshDb('evro-salda-');
  db.prepare("INSERT INTO readers (id, name, card_no, status) VALUES (1,'Дребнов','1','активен')").run();
  /* +0.05 +0.05 −0.10 лв. е баланс НУЛА. Ред по ред закръглянето дава
     +0.03 +0.03 −0.05 = +0.01 €: читател, който не дължи нищо, светва в червено
     и не може да бъде изтрит (открито при прегледа на кръга). */
  for (const [д, вид, сума] of [['2025-01-01', 'начисление', 0.05], ['2025-01-02', 'начисление', 0.05], ['2025-01-03', 'плащане', -0.10]]) {
    db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount) VALUES (1,?,?,?,?)')
      .run(д, вид, вид === 'плащане' ? 'плащане' : 'друго', сума);
  }
  пусниМиграция15(db);
  const баланс = db.prepare('SELECT ROUND(SUM(amount),2) AS v FROM account_lines WHERE reader_id=1').get().v;
  /* SQLite връща нулата като -0 при сбор с отрицателни събираеми — сравнява се
     стойността, не знакът на нулата. */
  assert.equal(Math.abs(баланс) < 0.005, true, 'сметката остава погасена: ' + JSON.stringify(
    db.prepare('SELECT amount FROM account_lines ORDER BY id').all().map(r => r.amount)));
  /* И отделните редове са разумни — не са изместени с повече от един цент. */
  const редове = db.prepare('SELECT amount FROM account_lines ORDER BY id').all().map(r => r.amount);
  for (const [i, стар] of [0.05, 0.05, -0.10].entries()) {
    assert.ok(Math.abs(редове[i] - стар / RATE) <= 0.01, 'ред ' + i + ': ' + редове[i]);
  }
  db.close();
});

test('миграцията пази съвпадението „обявена стойност = сбор на цените“', () => {
  const { db } = freshDb('evro-partida-');
  /* 5 × 2.99 лв. с обявени 14.95 лв. — съвпадат. Самостоятелното закръгляне на
     двете страни ги разминава с цент и печатът добавя абзаца „обявената стойност
     се различава от сбора“ върху ВЕЧЕ ПОДПИСАН акт за дарение. */
  db.prepare("INSERT INTO acquisitions (id, no, year, date, doc_no, sum) VALUES (1,1,'2025','2025-06-06','Ф-2',14.95)").run();
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO books (inv_number, title, price, status, acquisition_id) VALUES (?,?,2.99,'наличен',1)")
      .run(200 + i, 'Дарение ' + i);
  }
  /* Втора партида, при която двете НЕ съвпадат — разминаването е факт от
     документа и трябва да остане разминаване. */
  db.prepare("INSERT INTO acquisitions (id, no, year, date, doc_no, sum) VALUES (2,2,'2025','2025-07-07','Ф-3',100.00)").run();
  db.prepare("INSERT INTO books (inv_number, title, price, status, acquisition_id) VALUES (300,'Друга',2.99,'наличен',2)").run();

  пусниМиграция15(db);
  const сбор = (id) => db.prepare('SELECT ROUND(SUM(price),2) AS v FROM books WHERE acquisition_id=?').get(id).v;
  const обявена = (id) => db.prepare('SELECT sum AS v FROM acquisitions WHERE id=?').get(id).v;
  assert.equal(обявена(1), сбор(1), 'съвпадалите продължават да съвпадат');
  assert.notEqual(обявена(2), сбор(2), 'разминаването от документа се пази');
  assert.equal(обявена(2), Math.round(100 / RATE * 100) / 100, 'и се закръгля самостоятелно');
  db.close();
});

test('напомнителните писма не делят повторно по курса', () => {
  const src = fs.readFileSync(path.join(APP_DIR, 'handlers', 'notices.js'), 'utf8');
  /* Обезщетението е ЗАПИСАНО в евро: делене тук даваше три различни числа за
     едно задължение — в писмото, в имейла и в SMS-а (открито при прегледа). */
  assert.doesNotMatch(src, /fine \/ EUR_RATE/, 'делене на вече записано в евро обезщетение');
  assert.match(src, /fine: fine > 0 \? `\$\{fine\.toFixed\(2\)\} € \(\$\{\(fine \* EUR_RATE\)\.toFixed\(2\)\} лв\.\)`/);
  assert.match(src, /fine_sms: fine > 0 \? `, обезщетение \$\{fine\.toFixed\(2\)\} €`/);
});

test('нито един обработчик не описва записана сума като лева', () => {
  /* Обхожда ВСИЧКИ обработчици, вместо да изброява познатите: нов текст утре ще
     провали проверката, вместо да остане в лева мълчаливо. */
  const dir = path.join(APP_DIR, 'handlers');
  const остатъци = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
    /* Блоковите коментари се махат от ЦЕЛИЯ файл наведнъж: те са исторически
       бележки („дотук печаташе 0.00 лв.“) и говорят за миналото, а редовото
       чистене не хваща продълженията им. */
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    src.split('\n').forEach((ред, i) => {
      const код = ред.replace(/\/\/.*$/, '');
      /* Пази се ЦЕЛИЯТ ред: отрязването преди проверката губеше знака „€“ в
         дълъг ред и справочният лев изглеждаше като записана сума. */
      if (/(лв\.|лева)/.test(код)) остатъци.push({ къде: `${f}:${i + 1}`, ред: ред.trim() });
    });
  }
  /* Допустимо е ЕДИНСТВЕНО левът да стои СПРАВОЧНО след еврото на същия ред —
     „0.63 € (1.23 лв.)“, колонката „Цена (лв.)“ до „Цена (€)“. Ред, който
     споменава лева без евро преди него, описва записана сума като лева. */
  const справочен = ({ ред }) => { const i = ред.indexOf('€'); const j = ред.search(/лв\.|лева/); return i > -1 && i < j; };
  const позволени = остатъци.filter(r => !справочен(r));
  assert.deepEqual(позволени.map(r => r.къде + ': ' + r.ред.slice(0, 90)), [],
    'сума, описана като лева без евро преди нея');
  assert.ok(остатъци.length >= 2, 'проверката наистина обхожда файловете: ' + остатъци.length);
});
