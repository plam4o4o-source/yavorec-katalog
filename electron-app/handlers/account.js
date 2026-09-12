// Читателска сметка (Koha: accountlines) — извадени от main.js в отделен
// модул (Фаза 4, стъпка 18). amount > 0 = начислено (дължи се), amount < 0 =
// платено. Балансът е SUM(amount). Не е касов модул — само дневник на
// движенията + квитанция за печат.
const { LOST_CHARGE_TYPE } = require('../db/enum-triggers');

/* Балансът се закръгля до стотинки, преди да излезе оттук. Сумите се пазят
   като REAL и 1.10+1.10+1.10−3.30 дава 4.44e-16, а не 0 — платената докрай
   сметка светваше в червено с „0.00 лв. (дължи)". Закръглянето е тук, а не в
   изгледа, защото балансът тръгва оттук към всички екрани (сметка, „Заемане и
   връщане", квитанции) и трябва да е един и същ навсякъде.
   v2.4.56: изнесено извън registerAccountHandlers(), за да го ползват и двете
   помощни функции по-долу, които се викат ПО РЕФЕРЕНЦИЯ от handlers/loans.js
   (извън обхвата на регистрацията) — иначе там щеше да се появи второ, „почти
   същото“ закръгляне, а разликата от 1e-16 вече веднъж боядиса платена сметка в
   червено. */
const toCents = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* НАЧИСЛЕНИЕТО ЗА ИЗГУБЕН ДОКУМЕНТ СЕ ПИШЕ ОТ ТУК, А НЕ ОТ ЗАЕМАНИЯТА (v2.4.56).
   =====================================================================
   handlers/loans.js приключва заемането като „изгубен/невърнат“ и трябва да
   начисли обезщетението в читателската сметка. Съблазнително беше да напише
   INSERT-а на място — един ред SQL. Точно така обаче в програмата вече се бяха
   появили два различни начина да се впише движение по сметката, всеки със свое
   закръгляне и своя представа за знака, и точно това правило (плюс = дължи се,
   минус = платено) е единственото, което държи баланса верен. Сметката има ЕДНО
   място, което пише в нея — този файл, — затова заеманията викат функция оттук.
   Извиква се ВЪТРЕ в транзакцията на loans:markLost (подава се db, не getDb),
   за да няма състояние, при което документът е отбелязан за изгубен, а парите не
   са начислени на никого. Одитната следа се пише от викащия, който единствен
   знае за кой документ става дума. */
function chargeLost(db, { reader_id, amount, date, note }) {
  const amt = toCents(Math.abs(Number(amount) || 0));
  if (!amt) throw new Error('Размерът на обезщетението трябва да е положителен (поне 0.01 €).');
  const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(reader_id, date, 'начисление', LOST_CHARGE_TYPE, amt, note || null);
  return { id: info.lastInsertRowid, amount: amt };
}

/* ПОКРИТО ЛИ Е ЕДНО КОНКРЕТНО НАЧИСЛЕНИЕ (v2.4.56).
   =====================================================================
   Въпросът идва от акта по чл. 30, т. 5: отчислява се документ, невърнат от
   читател, и в акта (или поне в следата към него) трябва да личи дали
   обезщетението по него е СЪБРАНО, или само начислено. Дотук на този въпрос
   нямаше как да се отговори: плащанията в account_lines не носят вид и не сочат
   към начисление — „платих 5 лв.“ и нищо повече.
   Затова се прилага същото правило, по което се води всяка сметка и по което
   handlers/stats.js вече разнася плащанията: НАЙ-СТАРОТО ЗАДЪЛЖЕНИЕ СЕ ПОКРИВА
   ПЪРВО. Начислението е покрито дотолкова, доколкото платеното от читателя
   стига, след като са покрити всички по-стари негови задължения. Подредбата е
   буквално същата като в stats.js (дата, после начисленията преди плащанията в
   рамките на един ден, после id) — ако двете се разминат, справката „Събрани
   обезщетения“ и актът ще твърдят различни неща за едни и същи пари.
   Връща { charged, covered, outstanding }; за несъществуващ ред — null, за да
   може викащият да каже „начислението е изтрито“, вместо да покаже нула. */
function chargeCoverage(db, lineId) {
  const line = db.prepare('SELECT id, reader_id, amount FROM account_lines WHERE id = ?').get(lineId);
  if (!line) return null;
  const lines = db.prepare(`
    SELECT id, kind, amount FROM account_lines WHERE reader_id = ?
    ORDER BY date, (CASE kind WHEN 'начисление' THEN 0 ELSE 1 END), id
  `).all(line.reader_id);
  const queue = [];
  for (const l of lines) {
    if (l.kind === 'начисление') { queue.push({ id: l.id, left: Number(l.amount) || 0 }); continue; }
    let money = Math.abs(Number(l.amount) || 0);
    while (money > 0.0001 && queue.length) {
      const head = queue[0];
      const used = Math.min(money, head.left);
      head.left -= used;
      money -= used;
      if (head.left <= 0.0001) queue.shift();
    }
    // Надплатеното (аванс) не се приписва на нищо — както в handlers/stats.js.
  }
  const charged = toCents(Math.abs(Number(line.amount) || 0));
  const rest = queue.find(q => q.id === line.id);
  const outstanding = toCents(rest ? rest.left : 0);
  return { charged, covered: toCents(charged - outstanding), outstanding };
}

module.exports = function registerAccountHandlers(ipcMain, deps) {
  const { getDb, run, logAudit, today } = deps;

  ipcMain.handle('account:get', (e, readerId) =>
    run(() => {
      const lines = getDb().prepare('SELECT * FROM account_lines WHERE reader_id = ? ORDER BY date DESC, id DESC').all(readerId);
      const balance = toCents(lines.reduce((s, l) => s + Number(l.amount || 0), 0));
      return { lines, balance };
    })
  );
  ipcMain.handle('account:charge', (e, { reader_id, type, amount, note, date }) =>
    run(() => {
      const db = getDb();
      /* Math.abs НЕ е излишно: знакът е носителят на смисъла в този дневник
         (плюс = дължи се, минус = платено). Начисление с подадена отрицателна
         сума би влязло като плащане и би намалило дълга — затова сумата се
         привежда към положителна, а нула/нечислово/безкрайност се отказват. */
      const raw = Math.abs(Number(amount) || 0);
      if (!Number.isFinite(raw)) throw new Error('Сумата трябва да е положителна.');
      /* Проверява се ЗАКРЪГЛЕНАТА сума — същото число, което ще влезе в базата.
         Дотогава проверката гледаше суровата, а записът — закръглената, затова
         0.004 лв. минаваше и се записваше ред от 0.00 лв. */
      const amt = toCents(raw);
      if (!amt) throw new Error('Сумата трябва да е положителна (поне 0.01 €).');
      const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reader_id, date || today(), 'начисление', type || 'друго', amt, note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Начисление', (r ? r.name : reader_id) + ' — ' + (type || 'друго') + ' ' + amt.toFixed(2) + ' €');
      return info.lastInsertRowid;
    })
  );
  ipcMain.handle('account:pay', (e, { reader_id, amount, note, date }) =>
    run(() => {
      const db = getDb();
      const raw = Math.abs(Number(amount) || 0); // виж account:charge за знака
      if (!Number.isFinite(raw)) throw new Error('Сумата трябва да е положителна.');
      /* Одит v2.4.24: проверката гледаше СУРОВАТА сума, а записът — закръглената
         (същата разлика, поправена при account:charge по-горе, но само там). 0.004
         лв. минаваше, влизаше ред от 0.00 лв. и веднага се отпечатваше квитанция
         „Платена сума: 0.00 лв.“ за подпис от читателя. */
      const amt = toCents(raw);
      if (!amt) throw new Error('Сумата трябва да е положителна (поне 0.01 €).');
      const info = db.prepare('INSERT INTO account_lines (reader_id, date, kind, type, amount, note) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reader_id, date || today(), 'плащане', 'плащане', -amt, note || null);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(reader_id);
      logAudit('Плащане', (r ? r.name : reader_id) + ' — ' + amt.toFixed(2) + ' €');
      return info.lastInsertRowid;
    })
  );
  /* Изтриването на ред от сметката е ЕДИНСТВЕНИЯТ път, по който касов запис
     изчезва — и дотук единственият в този модул, който не оставяше следа, докато
     начислението и плащането оставят. Одит v2.4.24: сгрешен клик по „✕“ в картона
     махаше плащане от МИНАЛА, вече подадена година и справката „Приходи от такси и
     обезщетения“ започваше да показва друго число, без нищо, по което разликата да
     се възстанови (точно рискът, заради който handlers/readers.js спира изтриването
     на читател с движения по сметката). Липсващият ред пък се връщаше с ok:true и
     прозорецът обявяваше „Изтрито.“ за нищо. */
  ipcMain.handle('account:deleteLine', (e, id) =>
    run(() => {
      const db = getDb();
      const l = db.prepare('SELECT reader_id, date, kind, type, amount, note FROM account_lines WHERE id = ?').get(id);
      if (!l) throw new Error('Записът вече не съществува — вероятно е изтрит от друго работно място.');
      db.prepare('DELETE FROM account_lines WHERE id = ?').run(id);
      const r = db.prepare('SELECT name FROM readers WHERE id = ?').get(l.reader_id);
      logAudit('Изтрит ред от сметката', (r ? r.name : 'читател № ' + l.reader_id)
        + ' — ' + l.date + ', ' + (l.type || l.kind) + ' ' + Math.abs(Number(l.amount) || 0).toFixed(2) + ' €'
        + (l.note ? ' (' + l.note + ')' : ''));
    })
  );
};

/* Закачени за самата експортирана функция, а не подадени през deps: main.js
   регистрира handlers/account.js по-рано от handlers/loans.js и НЕ пази
   върнатото, тоест няма къде да ги прекара. `require('./account')` от заеманията
   не регистрира нищо повторно — модулът вече е в кеша на Node и се взима
   готов. */
module.exports.LOST_CHARGE_TYPE = LOST_CHARGE_TYPE;
module.exports.chargeLost = chargeLost;
module.exports.chargeCoverage = chargeCoverage;
