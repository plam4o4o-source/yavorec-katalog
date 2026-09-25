'use strict';
/* ============================================================================
   v2.4.67 — ПОЛЕТАТА ЗА ПАРИ ПРИЕМАТ БЪЛГАРСКАТА ДЕСЕТИЧНА ЗАПЕТАЯ.
   ============================================================================
   Намерено при проверка за грешки: всички полета за пари (цена на документ,
   сума на партида, начисление и плащане, обезщетения, годишна такса) бяха
   <input type="number">. Измерено в истински Chromium — същият двигател като в
   Electron — с език на прозореца bg-BG:
       написано или поставено „12,50“ → value „1250“,  validity.badInput = false
   Запетаята просто не се приема и сумата става СТО ПЪТИ по-голяма, без сигнал.

   Тези тестове вървят в jsdom, който НЕ прави същото филтриране — там числово
   поле с „12,50“ става празно, тоест сумата става 0. Затова тестовете тук
   разграничават: със старото поле цената излиза 0, с новото — 12,50. Самото
   „1250“ се вижда само в истински Chromium и е описано в CHANGELOG.
   ========================================================================== */
process.env.TZ = 'Europe/Sofia';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/e2e-app');

let h;
test.before(async () => { h = await E.bootApp(); });
test.after(() => { if (h) h.stop(); });

const q = (sql, ...a) => h.db.prepare(sql).get(...a);

async function newBookForm() {
  await h.go('books');
  await h.clickButton('+ Нова книга', '#view');
  await h.waitFor(() => h.$('#bookF'), 'формата за книга');
}
async function save() {
  const n = h.toasts.length;
  await h.clickButton('Запиши', '#modal footer');
  return h.toastsSince(n);
}

test('полето за пари е текстово — не <input type="number">, което изяжда запетаята', async () => {
  await newBookForm();
  const eurEl = h.$('#bookF [name=price]');
  const bgnEl = h.$('#bookF [data-bgn-for=price]');
  assert.equal(eurEl.getAttribute('type'), 'text', 'полето в евро трябва да е текстово');
  assert.equal(bgnEl.getAttribute('type'), 'text', 'полето в лева трябва да е текстово');
  assert.equal(eurEl.getAttribute('inputmode'), 'decimal', 'цифровата клавиатура се пази с inputmode');
  assert.ok(eurEl.hasAttribute('data-money'), 'полето носи data-money — по него formData го нормализира');
  h.window.closeModal();
});

test('цена „12,50“ се записва като 12,50 €, не като 0 и не като 1250', async () => {
  await newBookForm();
  h.type('#bookF [name=title]', 'Тютюн');
  h.type('#bookF [name=category_id]', q("SELECT id FROM categories WHERE name = 'книга'").id);
  h.type('#bookF [name=price]', '12,50');
  const ts = await save();
  assert.ok(ts.some(t => t.type === 'ok'), JSON.stringify(ts));
  const b = q("SELECT price FROM books WHERE title = 'Тютюн'");
  assert.ok(b, 'книгата не е в базата');
  assert.equal(b.price, 12.5, 'цена с десетична запетая трябва да е 12,50 €, а е ' + b.price);
});

test('„1 234,50“ с интервал за хилядите също се разчита', async () => {
  await newBookForm();
  h.type('#bookF [name=title]', 'Скъпа енциклопедия');
  h.type('#bookF [name=category_id]', q("SELECT id FROM categories WHERE name = 'книга'").id);
  h.type('#bookF [name=price]', '1 234,50');
  await save();
  assert.equal(q("SELECT price FROM books WHERE title = 'Скъпа енциклопедия'").price, 1234.5);
});

test('полето в лева приема запетая и попълва еврото вярно', async () => {
  await newBookForm();
  /* 24,45 лв. / 1,95583 = 12,50 € */
  h.type('#bookF [data-bgn-for=price]', '24,45');
  assert.equal(h.$('#bookF [name=price]').value, '12.50',
    'огледалото в евро трябва да разчете „24,45“ лв., а не да го сметне като 0');
  h.window.closeModal();
});

test('текст, който не е сума, се отказва поименно — не става тихо 0', async () => {
  await newBookForm();
  h.type('#bookF [name=title]', 'Книга без цена');
  h.type('#bookF [name=category_id]', q("SELECT id FROM categories WHERE name = 'книга'").id);
  h.type('#bookF [name=price]', 'дванайсет');
  const ts = await save();
  assert.ok(ts.some(t => t.type === 'err' && /не е число/.test(t.msg)),
    'цената трябва да бъде отказана с обяснение: ' + JSON.stringify(ts));
  assert.equal(q("SELECT COUNT(*) AS n FROM books WHERE title = 'Книга без цена'").n, 0,
    'документът не бива да е вписан с цена, която не е сума');
  h.window.closeModal();
});

test('formData нормализира САМО полетата за пари — другите текстови полета не се пипат', async () => {
  await newBookForm();
  h.type('#bookF [name=title]', 'Том 1,5');       // запетая в заглавие — не е сума
  h.type('#bookF [name=price]', '3,20');
  const d = h.window.formData('#bookF');
  assert.equal(d.price, '3.20', 'полето за пари отива към обработчика с точка');
  assert.equal(d.title, 'Том 1,5', 'заглавието не бива да се пипа');
  /* Интервалът за хилядите се маха ТУК, а не се оставя на обработчика: цената на
     книга (parseBookPrice) го прощава, но настройките четат с parseFloat, за
     който „1 234,50“ е 1. */
  h.type('#bookF [name=price]', '1 234,50');
  assert.equal(h.window.formData('#bookF').price, '1234.50');
  h.window.closeModal();
});

test('обезщетението на ден в Настройки „0,10“ се записва като 0,10 € — обработчикът там НЕ прощава запетаята', async () => {
  /* Настройките четат числата с parseFloat: „0,10“ без нормализиране дава 0 —
     тоест забавата спира да се начислява изобщо. Тук се минава през истинския
     екран и истинското „Запиши настройките“. */
  await h.go('setup');
  await h.waitFor(() => h.$('#setup-obsluzhvane [name=fine_per_day]'), 'полето за забава в „Обслужване“');
  h.type('[name=lib_name]', 'Библиотека „Изпитание“');   // без него Настройки не се записват
  h.type('#setup-obsluzhvane [name=fine_per_day]', '0,10');
  const n = h.toasts.length;
  await h.window.saveSetup();   // същото, което прави бутонът „Запиши настройките“
  await h.settle();
  assert.ok(h.toastsSince(n).some(t => t.type === 'ok'), JSON.stringify(h.toastsSince(n)));
  assert.equal(q('SELECT fine_per_day FROM settings WHERE id = 1').fine_per_day, 0.1,
    'обезщетението на ден трябва да е 0,10 €');
});

/* ============================================================================
   Търсенето в одитната следа — кирилица без значение на регистъра.
   ============================================================================
   Намерено при същата проверка за грешки: `detail LIKE ?`, а LIKE на SQLite
   сгъва регистъра само за латиница. Проверява се през ИСТИНСКИЯ обработчик на
   истинска база (h.api минава през main.js). */
test('търсенето в одитната следа намира „под игото“, „иван петров“ и „заемане“ и с малки букви', async () => {
  const ins = h.db.prepare('INSERT INTO audit_log (user, action, detail) VALUES (?, ?, ?)');
  ins.run('Мария Георгиева', 'Заемане', 'инв. № 9101 — Под игото; читател Иван Петров (карта 9777)');
  ins.run('Мария', 'Редакция', 'отстъпка 50% за деца — проба 9102');
  const found = async (q) => {
    const r = await h.api.audit.list(q);
    assert.ok(r && r.ok, 'audit:list: ' + (r && r.error));
    return r.data.filter(x => /910[12]/.test(x.detail || '')).length;
  };
  for (const q of ['Под игото', 'под игото', 'ПОД ИГОТО', 'иван петров', 'заемане']) {
    assert.equal(await found(q), 1, '„' + q + '“ трябва да намери записа');
  }
  /* „%“ и „_“ са буквални знаци, не заместващи: „_“ дотук съвпадаше с ВСЕКИ ред. */
  assert.equal(await found('50%'), 1, '„50%“ трябва да търси буквално');
  assert.equal(await found('_'), 0, '„_“ не бива да съвпада с всеки ред');
});

/* ============================================================================
   Заличаването по чл. 17 повиква следващия в опашката.
   ============================================================================
   Находка при същата проверка — в поправката от v2.4.65: заличаването отказваше
   ЗАДЕЛЕНАТА резервация на читателя, но не викаше activateHoldOnReturn(), тоест
   следващият чакащ оставаше „чака“ завинаги (документът не е зает — никое
   връщане няма да го повика). Минава през ИСТИНСКИЯ main.js: там gdpr се
   регистрира ПРЕДИ holds и функцията се подава мързеливо — директно подаване би
   гръмнало при стартиране, а този тест би го показал. */
test('заличаването на читател със заделена книга повиква следващия в опашката', async () => {
  const cat = q("SELECT id FROM categories WHERE name = 'книга'").id;
  const b = h.db.prepare("INSERT INTO books (inv_number, title, category_id, status) VALUES (9301, 'Железният светилник', ?, 'наличен')")
    .run(cat).lastInsertRowid;
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(b);
  const addR = (name, card) => h.db.prepare(
    "INSERT INTO readers (name, card_no, status, gdpr_consent) VALUES (?, ?, 'активен', 1)").run(name, card).lastInsertRowid;
  const a = addR('Заличаван Читател', '9301');
  const next = addR('Следващ Чакащ', '9302');
  h.db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'заделена', '2026-09-01 10:00:00')").run(b, a);
  h.db.prepare("INSERT INTO holds (book_id, reader_id, status, placed_at) VALUES (?, ?, 'чака', '2026-09-02 10:00:00')").run(b, next);

  const r = await h.api.gdpr.forgetReader({ id: a });
  assert.ok(r && r.ok, 'заличаване: ' + (r && r.error));

  assert.equal(q('SELECT status FROM holds WHERE reader_id = ?', next).status, 'заделена',
    'следващият в опашката трябва да бъде повикан — книгата е свободна и никое връщане няма да го направи');
  const trail = q("SELECT detail FROM audit_log WHERE action = 'Заличаване по искане на читател' ORDER BY id DESC");
  assert.match(trail.detail, /повикан е следващият в опашката/, 'следата трябва да казва, че е повикан:\n' + trail.detail);
});

/* ============================================================================
   КДБФ: броячът „не участват в наличността“ брои и неразпознаваемите дати.
   ============================================================================
   Находка при същата проверка: броячът гледаше само register_date IS NULL, а
   наличността (fundByDate) изключва ВСЕКИ ред, за който „+register_date <= край“
   не е истина. Документ с дата „НЕВАЛИДНА-99-99“ изпадаше от наличността на
   подписаното Приложение № 2, а броячът казваше 0 — бележката под КДБФ мълчеше. */
test('КДБФ брои като изпаднали от наличността и документите с неразпознаваема дата', async () => {
  const cat = q("SELECT id FROM categories WHERE name = 'книга'").id;
  const ins = h.db.prepare(`INSERT INTO books (inv_number, title, category_id, status, price, register_date)
      VALUES (?, ?, ?, 'наличен', ?, ?)`);
  const add = (inv, date) => { const id = ins.run(inv, 'КДБФ-проба ' + inv, cat, 1, date).lastInsertRowid;
    h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 1)').run(id); };
  const before = (await h.api.kdbf.report('2026')).data.undated.missing_from_stock;
  add(9401, 'НЕВАЛИДНА-99-99');   // изпада: като текст „Н“ > „2“
  add(9402, '3.05.2019');         // изпада: „3“ > „2“
  add(9403, null);                // изпада: NULL
  add(9404, '1.05.2019');         // ОСТАВА в наличността: „1“ < „2“ — и броячът не бива да го брои
  const after = (await h.api.kdbf.report('2026')).data.undated.missing_from_stock;
  assert.equal(after - before, 3, 'трите документа, които наистина изпадат от наличността, трябва да бъдат обявени');
});

/* ============================================================================
   Протокол от инвентаризация: стар запис с няколко бройки, една от тях заета.
   ============================================================================
   Находка при същата проверка. Възпроизведено: запис с 3 бройки, 1 заета, 2 не
   са намерени — протоколът гласеше „заети 3 · липсващи 0“, тоест двете
   ненамерени изчезваха от документа по чл. 40. След поправката „Проект за акт
   от липсите“ не бива да отчисли бройката, която читателят още държи. */
test('частично зает стар запис: протоколът брои заетите по бройки, а актът не отчислява бройката у читателя', async () => {
  const T = E.today();
  const id = h.db.prepare(`INSERT INTO books (inv_number, title, author, price, register_date, status, status_date,
      category_id) VALUES (9501, 'Хайдушки песни', 'Автор', 4, ?, 'наличен', ?, ?)`)
    .run(T, T, q("SELECT id FROM categories WHERE name = 'книга'").id).lastInsertRowid;
  h.db.prepare('INSERT INTO inventory (book_id, quantity) VALUES (?, 3)').run(id);
  if ((q('SELECT next_inv_number AS n FROM settings WHERE id = 1').n || 1) <= 9501) {
    h.db.prepare('UPDATE settings SET next_inv_number = 9502 WHERE id = 1').run();
  }
  const rdr = h.db.prepare("INSERT INTO readers (name, card_no, status, gdpr_consent) VALUES ('Държи бройка', '9501', 'активен', 1)")
    .run().lastInsertRowid;
  h.db.prepare("INSERT INTO loans (reader_id, book_id, date_out, date_due) VALUES (?, ?, ?, ?)").run(rdr, id, T, T);

  const s = await h.api.inventorySessions.start({ date: T, scope: 'пълна', department: null,
    committee1: 'Иванова', committee2: 'Петров', committee3: 'Стоянова', order_no: null });
  assert.equal(s.ok, true, s.error);
  const sid = s.data.id || s.data;
  const others = h.db.prepare(`SELECT b.inv_number FROM books b WHERE (b.status != 'отчислен' OR b.status IS NULL)
    AND b.id <> ? AND b.inv_number IS NOT NULL AND b.id NOT IN (SELECT book_id FROM loans WHERE date_in IS NULL)`).all(id);
  for (const o of others) await h.api.inventorySessions.scan({ sessionId: sid, code: String(o.inv_number) });
  const closed = await h.api.inventorySessions.close({ sessionId: sid, mode: 'full' });
  assert.equal(closed.ok, true, closed.error);

  const sess = (await h.api.inventorySessions.get(sid)).data;
  const miss = sess.missing.filter(m => m.book_id === id);
  assert.equal(miss.length, 1);
  assert.equal(Number(miss[0].quantity), 2, 'липсват 2 от 3-те бройки — третата е у читател');
  assert.equal(q('SELECT status FROM books WHERE id = ?', id).status, 'наличен',
    'записът не става „липсващ“ целият — една бройка е заета');

  h.hooks.confirmAnswer = true;
  await h.window.draftFromMissing(sid); await h.settle();
  const draft = q('SELECT MAX(id) AS id FROM deaccession_drafts').id;
  const rows = h.db.prepare(`SELECT b.id, b.inv_number FROM deaccession_draft_items d JOIN books b ON b.id = d.book_id
      WHERE d.draft_id = ? AND b.title = 'Хайдушки песни'`).all(draft);
  assert.equal(rows.length, 2, 'в проекта влизат точно двете липсващи бройки: ' + JSON.stringify(rows));
  assert.ok(!rows.some(r => r.id === id),
    'оригиналният запис носи заемането — бройката у читателя не бива да влиза в акта за отчисляване');
  assert.equal(q('SELECT COUNT(*) AS n FROM loans WHERE book_id = ? AND date_in IS NULL', id).n, 1,
    'заемането остава на оригиналния запис');
});
